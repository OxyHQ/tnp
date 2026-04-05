import { Router } from "express";

const router = Router();

const VERSION = "0.2.0";
const REPO = "OxyHQ/tnp";
const BASE = `https://github.com/${REPO}/releases/download/v${VERSION}`;

// Installer scripts embedded as constants so the API container is self-contained
// and does not depend on files from packages/client/ at runtime.

const INSTALL_SH = `#!/bin/sh
# TNP Installer -- https://tnp.network
# Usage: curl -fsSL https://get.tnp.network | sh
#
# This script detects OS/arch, downloads the TNP client binary,
# installs it, and optionally configures DNS resolution.

set -e

# ── ANSI colors ──────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "\${NO_COLOR:-}" ]; then
  RED='\\033[0;31m'
  GREEN='\\033[0;32m'
  YELLOW='\\033[0;33m'
  BLUE='\\033[0;34m'
  CYAN='\\033[0;36m'
  BOLD='\\033[1m'
  DIM='\\033[2m'
  RESET='\\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  CYAN=''
  BOLD=''
  DIM=''
  RESET=''
fi

# ── Logging helpers ──────────────────────────────────────────────────────────

info()    { printf "\${BLUE}>>>\${RESET} %s\\n" "$*"; }
success() { printf "\${GREEN}>>>\${RESET} %s\\n" "$*"; }
warn()    { printf "\${YELLOW}>>>\${RESET} %s\\n" "$*"; }
error()   { printf "\${RED}>>>\${RESET} %s\\n" "$*" >&2; }
fatal()   { error "$*"; exit 1; }

# ── Constants ────────────────────────────────────────────────────────────────

API_URL="https://api.tnp.network"
REPO="OxyHQ/tnp"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="tnp"
DNS_IP="174.138.10.81"
DNS_HOST="dns.tnp.network"

# ── Welcome banner ───────────────────────────────────────────────────────────

banner() {
  printf "\\n"
  printf "\${CYAN}\${BOLD}"
  printf "  _____ _   _ ____  \\n"
  printf " |_   _| \\\\ | |  _ \\\\ \\n"
  printf "   | | |  \\\\| | |_) |\\n"
  printf "   | | | |\\\\  |  __/ \\n"
  printf "   |_| |_| \\\\_|_|    \\n"
  printf "\${RESET}\\n"
  printf "  \${DIM}The Network Protocol\${RESET}\\n"
  printf "  \${DIM}https://tnp.network\${RESET}\\n"
  printf "\\n"
}

# ── Platform detection ───────────────────────────────────────────────────────

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin)  PLATFORM_OS="darwin"  ;;
    Linux)   PLATFORM_OS="linux"   ;;
    *)       fatal "Unsupported operating system: $OS" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)   PLATFORM_ARCH="x64"   ;;
    arm64|aarch64)   PLATFORM_ARCH="arm64" ;;
    *)               fatal "Unsupported architecture: $ARCH" ;;
  esac

  PLATFORM="\${PLATFORM_OS}-\${PLATFORM_ARCH}"
  info "Detected platform: \${BOLD}\${PLATFORM}\${RESET}"
}

# ── HTTP client abstraction ──────────────────────────────────────────────────

# Detect available HTTP tool (curl preferred, wget fallback)
detect_http_client() {
  if command -v curl >/dev/null 2>&1; then
    HTTP_CLIENT="curl"
  elif command -v wget >/dev/null 2>&1; then
    HTTP_CLIENT="wget"
  else
    fatal "Neither curl nor wget found. Please install one and try again."
  fi
}

# Fetch a URL to stdout
http_get() {
  url="$1"
  case "$HTTP_CLIENT" in
    curl)  curl -fsSL "$url" ;;
    wget)  wget -qO- "$url" ;;
  esac
}

# Download a URL to a file, showing progress
http_download() {
  url="$1"
  dest="$2"
  case "$HTTP_CLIENT" in
    curl)
      if [ -t 1 ]; then
        curl -fSL --progress-bar -o "$dest" "$url"
      else
        curl -fsSL -o "$dest" "$url"
      fi
      ;;
    wget)
      if [ -t 1 ]; then
        wget --show-progress -q -O "$dest" "$url"
      else
        wget -q -O "$dest" "$url"
      fi
      ;;
  esac
}

# ── Resolve download URL ────────────────────────────────────────────────────

resolve_download_url() {
  info "Fetching latest release information..."

  DOWNLOAD_URL=""
  VERSION=""

  # Try the API first for the canonical download URL
  API_RESPONSE="$(http_get "\${API_URL}/client/latest" 2>/dev/null || true)"

  if [ -n "$API_RESPONSE" ]; then
    # Extract the URL for our platform using simple string matching.
    # The JSON looks like: "darwin-arm64": "https://...url..."
    DOWNLOAD_URL="$(printf '%s' "$API_RESPONSE" | \\
      sed -n "s/.*\\"\${PLATFORM}\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p" | \\
      head -1)"

    VERSION="$(printf '%s' "$API_RESPONSE" | \\
      sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | \\
      head -1)"
  fi

  # Fallback to GitHub releases URL pattern
  if [ -z "$DOWNLOAD_URL" ]; then
    warn "Could not reach TNP API, falling back to GitHub releases."
    DOWNLOAD_URL="https://github.com/\${REPO}/releases/latest/download/tnp-\${PLATFORM}"
    VERSION="latest"
  fi

  if [ -n "$VERSION" ]; then
    info "Version: \${BOLD}\${VERSION}\${RESET}"
  fi
}

# ── Download binary ──────────────────────────────────────────────────────────

download_binary() {
  TMPDIR="\${TMPDIR:-/tmp}"
  TMP_BINARY="\${TMPDIR}/tnp-$$"

  info "Downloading TNP client..."
  info "\${DIM}\${DOWNLOAD_URL}\${RESET}"

  http_download "$DOWNLOAD_URL" "$TMP_BINARY" || \\
    fatal "Download failed. Check your internet connection and try again."

  chmod +x "$TMP_BINARY"

  # Verify the binary runs
  if ! "$TMP_BINARY" version >/dev/null 2>&1; then
    rm -f "$TMP_BINARY"
    fatal "Downloaded binary appears corrupted. Please try again or report the issue."
  fi

  DOWNLOADED_VERSION="$("$TMP_BINARY" version 2>/dev/null || echo "unknown")"
  success "Downloaded: \${BOLD}\${DOWNLOADED_VERSION}\${RESET}"
}

# ── Install binary ───────────────────────────────────────────────────────────

install_binary() {
  TARGET="\${INSTALL_DIR}/\${BINARY_NAME}"

  info "Installing to \${BOLD}\${TARGET}\${RESET}..."

  # Check if we can write to the install directory
  if [ -w "$INSTALL_DIR" ]; then
    mv "$TMP_BINARY" "$TARGET"
    chmod +x "$TARGET"
  else
    info "Elevated permissions required to install to \${INSTALL_DIR}"
    if command -v sudo >/dev/null 2>&1; then
      sudo mv "$TMP_BINARY" "$TARGET"
      sudo chmod +x "$TARGET"
    elif command -v doas >/dev/null 2>&1; then
      doas mv "$TMP_BINARY" "$TARGET"
      doas chmod +x "$TARGET"
    else
      error "Cannot write to \${INSTALL_DIR} and neither sudo nor doas is available."
      error "Move the binary manually:"
      error "  mv \${TMP_BINARY} \${TARGET}"
      fatal "  chmod +x \${TARGET}"
    fi
  fi

  success "Installed to \${TARGET}"
}

# ── Sudo helper ──────────────────────────────────────────────────────────────

# Run a command with elevated privileges if available
run_elevated() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  elif command -v doas >/dev/null 2>&1; then
    doas "$@"
  else
    error "This operation requires root privileges."
    error "Run the following manually:"
    error "  $*"
    return 1
  fi
}

# ── DNS configuration ───────────────────────────────────────────────────────

configure_dns_system() {
  info "Configuring system DNS to use TNP resolver (\${DNS_IP})..."

  if [ "$PLATFORM_OS" = "darwin" ]; then
    # macOS: use networksetup to set DNS on the active network service
    ACTIVE_SERVICE="$(networksetup -listallnetworkservices | grep -v '^\\*' | head -1)"
    if [ -n "$ACTIVE_SERVICE" ]; then
      run_elevated networksetup -setdnsservers "$ACTIVE_SERVICE" "$DNS_IP" || {
        warn "Could not configure DNS automatically."
        warn "Open System Settings > Network > DNS and add \${DNS_IP}"
        return 1
      }
      success "DNS set to \${DNS_IP} on \${ACTIVE_SERVICE}"
    else
      warn "No active network service found."
      warn "Open System Settings > Network > DNS and add \${DNS_IP}"
      return 1
    fi

  elif [ "$PLATFORM_OS" = "linux" ]; then
    # Linux: try systemd-resolved, then NetworkManager, then /etc/resolv.conf
    if command -v resolvectl >/dev/null 2>&1; then
      # Find the default interface
      DEFAULT_IFACE="$(ip route show default 2>/dev/null | awk '{print $5; exit}')"
      if [ -z "$DEFAULT_IFACE" ]; then
        DEFAULT_IFACE="eth0"
      fi
      run_elevated resolvectl dns "$DEFAULT_IFACE" "$DNS_IP" || {
        warn "resolvectl failed. Falling back to /etc/resolv.conf"
      }
      success "DNS set to \${DNS_IP} on \${DEFAULT_IFACE} via systemd-resolved"

    elif command -v nmcli >/dev/null 2>&1; then
      ACTIVE_CONN="$(nmcli -t -f NAME connection show --active | head -1)"
      if [ -n "$ACTIVE_CONN" ]; then
        run_elevated nmcli connection modify "$ACTIVE_CONN" ipv4.dns "$DNS_IP" || {
          warn "NetworkManager DNS change failed."
          return 1
        }
        run_elevated nmcli connection up "$ACTIVE_CONN" >/dev/null 2>&1 || true
        success "DNS set to \${DNS_IP} on connection \${ACTIVE_CONN} via NetworkManager"
      else
        warn "No active NetworkManager connection found."
        return 1
      fi

    else
      warn "No known DNS manager found. Writing directly to /etc/resolv.conf"
      run_elevated sh -c "printf 'nameserver %s\\n' '\${DNS_IP}' > /etc/resolv.conf" || {
        warn "Could not write /etc/resolv.conf"
        return 1
      }
      success "DNS set to \${DNS_IP} in /etc/resolv.conf"
      warn "Note: this may be overwritten by DHCP on reboot."
    fi
  fi
}

# ── Interactive DNS setup ────────────────────────────────────────────────────

dns_setup() {
  printf "\\n"
  printf "\${BOLD}How would you like to resolve TNP domains?\${RESET}\\n"
  printf "\\n"
  printf "  \${GREEN}1)\${RESET} Install TNP service \${DIM}(recommended)\${RESET}\\n"
  printf "     Runs a local DNS proxy. Only TNP domains are affected.\\n"
  printf "     Standard DNS continues to work normally.\\n"
  printf "\\n"
  printf "  \${YELLOW}2)\${RESET} Change system DNS\\n"
  printf "     Point your DNS to the TNP resolver (\${DNS_IP}).\\n"
  printf "     All DNS queries go through TNP.\\n"
  printf "\\n"
  printf "  \${DIM}3)\${RESET} Skip -- I'll configure DNS myself\\n"
  printf "\\n"

  # Read user choice -- handle both interactive and non-interactive
  if [ -t 0 ]; then
    printf "\${BOLD}Choose [1/2/3]: \${RESET}"
    read -r CHOICE
  else
    # Non-interactive (piped): default to showing instructions
    info "Non-interactive mode detected. Skipping DNS configuration."
    CHOICE="3"
  fi

  case "$CHOICE" in
    1)
      info "Installing TNP as a system service..."
      run_elevated "\${INSTALL_DIR}/\${BINARY_NAME}" install || {
        error "Service installation failed."
        warn "You can retry manually: sudo tnp install"
        return 1
      }
      success "TNP service installed and running."
      ;;
    2)
      configure_dns_system
      ;;
    3|"")
      printf "\\n"
      info "Skipped DNS configuration."
      info "You can set it up later with one of these methods:"
      printf "\\n"
      printf "  \${GREEN}sudo tnp install\${RESET}         Install as a system service\\n"
      printf "  \${GREEN}tnp run\${RESET}                   Run the resolver manually\\n"
      printf "  \${GREEN}tnp connect\${RESET}               Full overlay client (DNS + SOCKS5)\\n"
      printf "\\n"
      printf "  Or point your DNS to: \${BOLD}\${DNS_IP}\${RESET} (\${DNS_HOST})\\n"
      ;;
    *)
      warn "Invalid choice. Skipping DNS configuration."
      ;;
  esac
}

# ── Verify installation ─────────────────────────────────────────────────────

verify_install() {
  printf "\\n"
  info "Verifying installation..."

  # Check the binary is on PATH
  if ! command -v tnp >/dev/null 2>&1; then
    warn "\${INSTALL_DIR} may not be in your PATH."
    warn "Add it with: export PATH=\\"\${INSTALL_DIR}:\\$PATH\\""
  fi

  # Print version
  INSTALLED_VERSION="$("\${INSTALL_DIR}/\${BINARY_NAME}" version 2>/dev/null || echo "")"
  if [ -n "$INSTALLED_VERSION" ]; then
    success "Installed: \${BOLD}\${INSTALLED_VERSION}\${RESET}"
  else
    warn "Could not verify installation."
  fi

  # Test domain resolution
  info "Testing domain resolution..."
  if "\${INSTALL_DIR}/\${BINARY_NAME}" test example.ox >/dev/null 2>&1; then
    success "Domain resolution is working."
  else
    warn "Domain resolution test completed (this is normal if no records exist yet)."
  fi
}

# ── Success message ──────────────────────────────────────────────────────────

print_success() {
  printf "\\n"
  printf "\${GREEN}\${BOLD}  Installation complete.\${RESET}\\n"
  printf "\\n"
  printf "  \${BOLD}Get started:\${RESET}\\n"
  printf "    Register domains  \${DIM}https://tnp.network\${RESET}\\n"
  printf "    Check status      \${GREEN}tnp status\${RESET}\\n"
  printf "    Test a domain     \${GREEN}tnp test example.ox\${RESET}\\n"
  printf "    Run manually      \${GREEN}tnp run\${RESET}\\n"
  printf "    Full overlay      \${GREEN}tnp connect\${RESET}\\n"
  printf "    All commands      \${GREEN}tnp help\${RESET}\\n"
  printf "\\n"
  printf "  \${DIM}Docs: https://tnp.network/install\${RESET}\\n"
  printf "\\n"
}

# ── Cleanup on failure ───────────────────────────────────────────────────────

cleanup() {
  if [ -n "\${TMP_BINARY:-}" ] && [ -f "$TMP_BINARY" ]; then
    rm -f "$TMP_BINARY"
  fi
}
trap cleanup EXIT

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  banner
  detect_http_client
  detect_platform
  resolve_download_url
  download_binary
  install_binary
  dns_setup
  verify_install
  print_success
}

main
`;

const INSTALL_PS1 = `# TNP Installer for Windows -- https://tnp.network
# Usage: irm https://get.tnp.network/ps | iex
#
# This script downloads and installs the TNP client binary,
# then optionally configures DNS resolution.

#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# ── Constants ────────────────────────────────────────────────────────────────

$ApiUrl      = "https://api.tnp.network"
$Repo        = "OxyHQ/tnp"
$InstallDir  = "$env:ProgramFiles\\tnp"
$BinaryName  = "tnp.exe"
$DnsIp       = "174.138.10.81"
$DnsHost     = "dns.tnp.network"

# ── Logging helpers ──────────────────────────────────────────────────────────

function Write-Info    { param([string]$Msg) Write-Host ">>> " -NoNewline -ForegroundColor Blue;    Write-Host $Msg }
function Write-Ok      { param([string]$Msg) Write-Host ">>> " -NoNewline -ForegroundColor Green;   Write-Host $Msg }
function Write-Warn    { param([string]$Msg) Write-Host ">>> " -NoNewline -ForegroundColor Yellow;  Write-Host $Msg }
function Write-Err     { param([string]$Msg) Write-Host ">>> " -NoNewline -ForegroundColor Red;     Write-Host $Msg }

function Exit-Fatal {
    param([string]$Msg)
    Write-Err $Msg
    exit 1
}

# ── Admin check ──────────────────────────────────────────────────────────────

function Assert-Admin {
    $current = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $current.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Warn "This installer needs Administrator privileges."
        Write-Info "Restarting as Administrator..."

        # Build the full command to re-run this script elevated
        $scriptContent = $MyInvocation.ScriptName
        if ($scriptContent) {
            Start-Process powershell.exe \`
                -ArgumentList "-ExecutionPolicy Bypass -File \`"$scriptContent\`"" \`
                -Verb RunAs
        } else {
            # When piped from irm, re-download and run elevated
            Start-Process powershell.exe \`
                -ArgumentList "-ExecutionPolicy Bypass -Command \`"irm https://get.tnp.network/ps | iex\`"" \`
                -Verb RunAs
        }
        exit 0
    }
}

# ── Welcome banner ───────────────────────────────────────────────────────────

function Show-Banner {
    Write-Host ""
    Write-Host "  _____ _   _ ____  " -ForegroundColor Cyan
    Write-Host " |_   _| \\ | |  _ \\ " -ForegroundColor Cyan
    Write-Host "   | | |  \\| | |_) |" -ForegroundColor Cyan
    Write-Host "   | | |\`\\  |  __/ " -ForegroundColor Cyan
    Write-Host "   |_| |_| \\_|_|    " -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  The Network Protocol" -ForegroundColor DarkGray
    Write-Host "  https://tnp.network" -ForegroundColor DarkGray
    Write-Host ""
}

# ── Platform detection ───────────────────────────────────────────────────────

function Get-Platform {
    $arch = $env:PROCESSOR_ARCHITECTURE
    switch ($arch) {
        "AMD64"   { return "windows-x64" }
        "x86"     { Exit-Fatal "32-bit Windows is not supported." }
        "ARM64"   { Write-Info "ARM64 detected -- using x64 binary (runs via emulation)"; return "windows-x64" }
        default   { Exit-Fatal "Unknown architecture: $arch" }
    }
}

# ── Resolve download URL ────────────────────────────────────────────────────

function Get-DownloadUrl {
    param([string]$Platform)

    Write-Info "Fetching latest release information..."

    $downloadUrl = $null
    $version = $null

    try {
        $response = Invoke-RestMethod -Uri "$ApiUrl/client/latest" -TimeoutSec 10
        $version = $response.version

        $platforms = $response.platforms
        if ($platforms.PSObject.Properties.Name -contains $Platform) {
            $downloadUrl = $platforms.$Platform
        }
    }
    catch {
        Write-Warn "Could not reach TNP API. Using GitHub releases fallback."
    }

    if (-not $downloadUrl) {
        $downloadUrl = "https://github.com/$Repo/releases/latest/download/tnp-$Platform.exe"
        if (-not $version) { $version = "latest" }
    }

    Write-Info "Version: $version"
    return @{ Url = $downloadUrl; Version = $version }
}

# ── Download binary ──────────────────────────────────────────────────────────

function Get-Binary {
    param([string]$Url)

    $tmpFile = Join-Path $env:TEMP "tnp-installer-$PID.exe"

    Write-Info "Downloading TNP client..."
    Write-Host "    $Url" -ForegroundColor DarkGray

    try {
        # Use TLS 1.2+ for GitHub/API downloads
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

        $progressPreference = $ProgressPreference
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -Uri $Url -OutFile $tmpFile -UseBasicParsing
        $ProgressPreference = $progressPreference
    }
    catch {
        if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force }
        Exit-Fatal "Download failed: $_"
    }

    # Verify the binary runs
    try {
        $versionOutput = & $tmpFile version 2>&1
        Write-Ok "Downloaded: $versionOutput"
    }
    catch {
        Remove-Item $tmpFile -Force
        Exit-Fatal "Downloaded binary appears corrupted. Please try again."
    }

    return $tmpFile
}

# ── Install binary ───────────────────────────────────────────────────────────

function Install-Binary {
    param([string]$TmpFile)

    $target = Join-Path $InstallDir $BinaryName

    Write-Info "Installing to $target..."

    # Create install directory if it does not exist
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    # Stop any running TNP process before overwriting
    Get-Process -Name "tnp" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    # Move binary
    Move-Item -Path $TmpFile -Destination $target -Force

    # Add to PATH if not already there
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    if ($machinePath -notlike "*$InstallDir*") {
        Write-Info "Adding $InstallDir to system PATH..."
        [Environment]::SetEnvironmentVariable(
            "Path",
            "$machinePath;$InstallDir",
            "Machine"
        )
        # Also update current session PATH
        $env:Path = "$env:Path;$InstallDir"
    }

    Write-Ok "Installed to $target"
}

# ── DNS configuration ───────────────────────────────────────────────────────

function Set-SystemDns {
    Write-Info "Configuring system DNS to $DnsIp..."

    try {
        $adapters = Get-NetAdapter | Where-Object { $_.Status -eq "Up" }
        foreach ($adapter in $adapters) {
            Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ServerAddresses @($DnsIp, "1.1.1.1")
        }
        Write-Ok "DNS set to $DnsIp on all active network adapters."
        Write-Warn "Cloudflare (1.1.1.1) added as fallback."
    }
    catch {
        Write-Err "Failed to configure DNS: $_"
        Write-Warn "You can set DNS manually in Network Settings to $DnsIp"
    }
}

# ── Interactive DNS setup ────────────────────────────────────────────────────

function Invoke-DnsSetup {
    Write-Host ""
    Write-Host "  How would you like to resolve TNP domains?" -ForegroundColor White
    Write-Host ""
    Write-Host "  1) " -NoNewline -ForegroundColor Green
    Write-Host "Install TNP service " -NoNewline
    Write-Host "(recommended)" -ForegroundColor DarkGray
    Write-Host "     Runs a local DNS proxy. Only TNP domains are affected."
    Write-Host "     Standard DNS continues to work normally."
    Write-Host ""
    Write-Host "  2) " -NoNewline -ForegroundColor Yellow
    Write-Host "Change system DNS"
    Write-Host "     Point your DNS to the TNP resolver ($DnsIp)."
    Write-Host "     All DNS queries go through TNP."
    Write-Host ""
    Write-Host "  3) " -NoNewline -ForegroundColor DarkGray
    Write-Host "Skip -- I'll configure DNS myself"
    Write-Host ""

    $choice = Read-Host "  Choose [1/2/3]"

    switch ($choice) {
        "1" {
            Write-Info "Installing TNP as a system service..."
            $tnpPath = Join-Path $InstallDir $BinaryName
            try {
                & $tnpPath install
                Write-Ok "TNP service installed and running."
            }
            catch {
                Write-Err "Service installation failed: $_"
                Write-Warn "You can retry manually: tnp install"
            }
        }
        "2" {
            Set-SystemDns
        }
        default {
            Write-Host ""
            Write-Info "Skipped DNS configuration."
            Write-Info "You can set it up later:"
            Write-Host ""
            Write-Host "  tnp install" -ForegroundColor Green -NoNewline
            Write-Host "              Install as a system service"
            Write-Host "  tnp run" -ForegroundColor Green -NoNewline
            Write-Host "                  Run the resolver manually"
            Write-Host "  tnp connect" -ForegroundColor Green -NoNewline
            Write-Host "              Full overlay client (DNS + SOCKS5)"
            Write-Host ""
            Write-Host "  Or point your DNS to: " -NoNewline
            Write-Host "$DnsIp" -ForegroundColor White -NoNewline
            Write-Host " ($DnsHost)"
        }
    }
}

# ── Verify installation ─────────────────────────────────────────────────────

function Test-Installation {
    Write-Host ""
    Write-Info "Verifying installation..."

    $tnpPath = Join-Path $InstallDir $BinaryName

    # Check version
    try {
        $version = & $tnpPath version 2>&1
        Write-Ok "Installed: $version"
    }
    catch {
        Write-Warn "Could not verify installation."
    }

    # Test domain resolution
    Write-Info "Testing domain resolution..."
    try {
        & $tnpPath test example.ox 2>&1 | Out-Null
        Write-Ok "Domain resolution is working."
    }
    catch {
        Write-Warn "Domain resolution test completed (normal if no records exist yet)."
    }
}

# ── Success message ──────────────────────────────────────────────────────────

function Show-Success {
    Write-Host ""
    Write-Host "  Installation complete." -ForegroundColor Green
    Write-Host ""
    Write-Host "  Get started:"
    Write-Host "    Register domains  " -NoNewline; Write-Host "https://tnp.network" -ForegroundColor DarkGray
    Write-Host "    Check status      " -NoNewline; Write-Host "tnp status" -ForegroundColor Green
    Write-Host "    Test a domain     " -NoNewline; Write-Host "tnp test example.ox" -ForegroundColor Green
    Write-Host "    Run manually      " -NoNewline; Write-Host "tnp run" -ForegroundColor Green
    Write-Host "    Full overlay      " -NoNewline; Write-Host "tnp connect" -ForegroundColor Green
    Write-Host "    All commands      " -NoNewline; Write-Host "tnp help" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Docs: https://tnp.network/install" -ForegroundColor DarkGray
    Write-Host ""

    # Note about PATH requiring new terminal
    Write-Warn "You may need to open a new terminal for the PATH change to take effect."
}

# ── Main ─────────────────────────────────────────────────────────────────────

function Main {
    Show-Banner
    Assert-Admin

    $platform = Get-Platform
    Write-Info "Detected platform: $platform"

    $release = Get-DownloadUrl -Platform $platform
    $tmpFile = Get-Binary -Url $release.Url
    Install-Binary -TmpFile $tmpFile
    Invoke-DnsSetup
    Test-Installation
    Show-Success
}

Main
`;

// GET /client/latest -- returns latest daemon version + download URLs per platform
router.get("/latest", (_req, res) => {
  res.json({
    version: VERSION,
    platforms: {
      "darwin-arm64": `${BASE}/tnp-darwin-arm64`,
      "darwin-x64": `${BASE}/tnp-darwin-x64`,
      "linux-x64": `${BASE}/tnp-linux-x64`,
      "linux-arm64": `${BASE}/tnp-linux-arm64`,
      "windows-x64": `${BASE}/tnp-windows-x64.exe`,
    },
    install: {
      unix: "curl -fsSL https://get.tnp.network | sh",
      windows: "irm https://get.tnp.network/ps | iex",
    },
  });
});

// GET /client/install.sh -- serves the Unix installer script
router.get("/install.sh", (_req, res) => {
  res.type("text/plain").send(INSTALL_SH);
});

// GET /client/install.ps1 -- serves the Windows installer script
router.get("/install.ps1", (_req, res) => {
  res.type("text/plain").send(INSTALL_PS1);
});

export default router;
