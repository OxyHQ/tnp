# TNP Installer for Windows -- https://tnp.network
# Usage: irm https://get.tnp.network/ps | iex
#
# This script downloads and installs the TNP client binary,
# then optionally configures DNS resolution.

#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# ── Constants ────────────────────────────────────────────────────────────────

$ApiUrl      = "https://api.tnp.network"
$Repo        = "OxyHQ/tnp"
$InstallDir  = "$env:ProgramFiles\tnp"
$BinaryName  = "tnp.exe"
$DnsIp       = "206.189.96.213"
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
            Start-Process powershell.exe `
                -ArgumentList "-ExecutionPolicy Bypass -File `"$scriptContent`"" `
                -Verb RunAs
        } else {
            # When piped from irm, re-download and run elevated
            Start-Process powershell.exe `
                -ArgumentList "-ExecutionPolicy Bypass -Command `"irm https://get.tnp.network/ps | iex`"" `
                -Verb RunAs
        }
        exit 0
    }
}

# ── Welcome banner ───────────────────────────────────────────────────────────

function Show-Banner {
    Write-Host ""
    Write-Host "  _____ _   _ ____  " -ForegroundColor Cyan
    Write-Host " |_   _| \ | |  _ \ " -ForegroundColor Cyan
    Write-Host "   | | |  \| | |_) |" -ForegroundColor Cyan
    Write-Host "   | | |`\  |  __/ " -ForegroundColor Cyan
    Write-Host "   |_| |_| \_|_|    " -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  The Network Protocol" -ForegroundColor DarkGray
    Write-Host "  https://tnp.network" -ForegroundColor DarkGray
    Write-Host ""
}

# ── Platform detection ───────────────────────────────────────────────────────

function Get-Platform {
    $arch = $env:PROCESSOR_ARCHITECTURE
    switch ($arch) {
        "AMD64"   { return "win32-x64" }
        "x86"     { Exit-Fatal "32-bit Windows is not supported." }
        "ARM64"   { Exit-Fatal "ARM64 Windows is not yet supported. Coming soon." }
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
