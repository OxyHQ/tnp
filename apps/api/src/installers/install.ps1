# TNP Installer for Windows -- https://tnp.network
# Usage: irm https://get.tnp.network/ps | iex
#
# Downloads the TNP client v__TNP_VERSION__ from the fixed GitHub release URL,
# verifies it, installs it under %LOCALAPPDATA%, and optionally installs the
# local TNP service.
#
# Verification, before anything downloaded is run or moved:
#   1. The binary's SHA-256 (Get-FileHash) must equal its line in SHA256SUMS.
#   2. SHA256SUMS.sig must be a valid Ed25519 signature over SHA256SUMS by the
#      release key embedded below. PowerShell has no Ed25519, so this is checked
#      only when OpenSSL 3 is available (for example the one Git for Windows
#      ships); otherwise the installer says plainly that only the checksum was
#      checked.
# Any mismatch stops the install. There is no fallback URL.
#
# Trust: this script itself comes from get.tnp.network over HTTPS, so whoever
# controls that host controls this script and the key in it. To check a
# release independently of it, see
# https://github.com/OxyHQ/tnp/blob/main/docs/architecture/security.md
#
# Environment:
#   $env:TNP_VERSION = "x.y.z"         install that release instead of v__TNP_VERSION__
#   $env:TNP_INSTALL_DIR = "C:\path"   install there instead of %LOCALAPPDATA%\Programs\tnp
#   $env:TNP_REQUIRE_SIGNATURE = "1"   fail instead of continuing when the
#                                      signature cannot be checked here

#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# ── Constants ────────────────────────────────────────────────────────────────

$Repo           = "__TNP_REPO__"
$DefaultVersion = "__TNP_VERSION__"
$InstallDir     = if ($env:TNP_INSTALL_DIR) { $env:TNP_INSTALL_DIR } else { "$env:LOCALAPPDATA\Programs\tnp" }
$BinaryName     = "tnp.exe"

# The release signing public key (Ed25519, SubjectPublicKeyInfo). The same key
# is pinned in the client for `tnp update`.
$ReleaseKeyPem = @'
__TNP_RELEASE_KEY_PEM__
'@

$script:SignatureVerified = $false

# ── Logging helpers ──────────────────────────────────────────────────────────

function Write-Info    { param([string]$Msg) Write-Host ">>> " -NoNewline -ForegroundColor Blue;    Write-Host $Msg }
function Write-Ok      { param([string]$Msg) Write-Host ">>> " -NoNewline -ForegroundColor Green;   Write-Host $Msg }
function Write-Warn    { param([string]$Msg) Write-Host ">>> " -NoNewline -ForegroundColor Yellow;  Write-Host $Msg }
function Write-Err     { param([string]$Msg) Write-Host ">>> " -NoNewline -ForegroundColor Red;     Write-Host $Msg }

function Exit-Fatal {
    param([string]$Msg)
    Write-Err $Msg
    if ($script:WorkDir -and (Test-Path -LiteralPath $script:WorkDir)) {
        Remove-Item -LiteralPath $script:WorkDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    # throw, not exit: under `irm | iex` an exit closes the window before the
    # reason can be read.
    throw "TNP install aborted: $Msg"
}

# ── Admin check ──────────────────────────────────────────────────────────────
#
# The base install (download + place the binary + user-PATH update) never
# needs Administrator: it lives entirely under %LOCALAPPDATA%, which the
# current user always owns. Only registering the SYSTEM-level scheduled task
# ("tnp install") needs it, so elevation is requested lazily, only for that,
# via Invoke-Elevated below.

function Test-IsAdmin {
    $current = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    return $current.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Run $Command elevated. Runs in-process if already Administrator; otherwise
# relaunches via UAC (-EncodedCommand sidesteps nested-quoting issues) and
# waits for it to finish. Returns $true/$false instead of throwing.
function Invoke-Elevated {
    param([string]$Command, [string]$Description)

    if (Test-IsAdmin) {
        Invoke-Expression $Command
        return $true
    }

    Write-Info "$Description requires Administrator privileges. Requesting elevation..."
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
    try {
        $proc = Start-Process powershell.exe `
            -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded) `
            -Verb RunAs -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            Write-Warn "Elevated command exited with code $($proc.ExitCode)."
            return $false
        }
        return $true
    }
    catch {
        Write-Err "Could not get Administrator elevation: $_"
        Write-Warn "Open PowerShell 'as Administrator' yourself and run:"
        Write-Host "    $Command" -ForegroundColor White
        return $false
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
        "AMD64"   { return "windows-x64" }
        "x86"     { Exit-Fatal "32-bit Windows is not supported." }
        "ARM64"   { Write-Info "ARM64 detected -- using x64 binary (runs via emulation)"; return "windows-x64" }
        default   { Exit-Fatal "Unknown architecture: $arch" }
    }
}

# ── Resolve the version ──────────────────────────────────────────────────────

# A version is interpolated into a URL, so only a strict x.y.z is accepted.
function Get-ReleaseVersion {
    $version = if ($env:TNP_VERSION) { $env:TNP_VERSION } else { $DefaultVersion }
    if (-not [regex]::IsMatch($version, '\A(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\z')) {
        Exit-Fatal "Refusing version '$version': expected x.y.z"
    }
    Write-Info "Version: $version"
    return $version
}

# ── Download ─────────────────────────────────────────────────────────────────

function New-WorkDir {
    # A fresh directory with an unpredictable name under the per-user temp dir.
    $path = Join-Path ([IO.Path]::GetTempPath()) ("tnp-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $path | Out-Null
    return $path
}

function Get-ReleaseFile {
    param([string]$Url, [string]$OutFile)
    try {
        $progressPreference = $ProgressPreference
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
        $ProgressPreference = $progressPreference
    }
    catch {
        Exit-Fatal "Download of $Url failed: $_. Not installing."
    }
}

# ── Verify ───────────────────────────────────────────────────────────────────

function Test-Checksum {
    param([string]$Asset, [string]$BinaryPath, [string]$SumsPath)

    $expected = @()
    foreach ($line in Get-Content -LiteralPath $SumsPath) {
        $m = [regex]::Match($line, '\A([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)\z')
        if ($m.Success -and $m.Groups[2].Value -ceq $Asset) { $expected += $m.Groups[1].Value }
    }
    if ($expected.Count -ne 1) {
        Exit-Fatal "SHA256SUMS has $($expected.Count) entries for $Asset, expected 1. Not installing."
    }

    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $BinaryPath).Hash.ToLowerInvariant()
    if ($actual -cne $expected[0]) {
        Write-Err "Expected SHA-256: $($expected[0])"
        Write-Err "Actual SHA-256:   $actual"
        Exit-Fatal "Checksum mismatch for $Asset. Not installing."
    }
    Write-Ok "SHA-256 of $Asset matches SHA256SUMS: $actual"
}

# OpenSSL 3 or later can verify Ed25519 with -rawin; LibreSSL and OpenSSL 1.x cannot.
function Find-OpenSsl {
    $candidates = @()
    $onPath = Get-Command openssl -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles "Git\usr\bin\openssl.exe" }
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $eap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $version = & $candidate version 2>$null
        $ErrorActionPreference = $eap
        if ("$version" -match '\AOpenSSL ([3-9]|[1-9][0-9]+)\.') { return $candidate }
    }
    return $null
}

function Test-Signature {
    param([string]$WorkDir, [string]$SumsPath, [string]$SigPath)

    $openssl = Find-OpenSsl
    if (-not $openssl) {
        if ($env:TNP_REQUIRE_SIGNATURE -eq "1") {
            Exit-Fatal "TNP_REQUIRE_SIGNATURE=1 but no OpenSSL 3 was found to check the Ed25519 signature."
        }
        Write-Warn "Could not check the release SIGNATURE: PowerShell has no Ed25519 and no OpenSSL 3 was found."
        Write-Warn "Only the SHA-256 checksum was checked, against SHA256SUMS downloaded from the"
        Write-Warn "same GitHub release as the binary. That catches corruption, not tampering."
        Write-Warn "Install Git for Windows (it ships OpenSSL 3) and re-run, or set TNP_REQUIRE_SIGNATURE=1."
        return
    }

    $pem = Join-Path $WorkDir "release-key.pem"
    [IO.File]::WriteAllText($pem, $ReleaseKeyPem.Trim() + "`n", (New-Object Text.ASCIIEncoding))
    $eap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $openssl pkeyutl -verify -pubin -inkey $pem -rawin -in $SumsPath -sigfile $SigPath 2>$null | Out-Null
    $code = $LASTEXITCODE
    $ErrorActionPreference = $eap
    if ($code -ne 0) {
        Exit-Fatal "SHA256SUMS.sig is NOT a valid signature by the TNP release key. Not installing."
    }
    $script:SignatureVerified = $true
    Write-Ok "Signature on SHA256SUMS verified with the pinned TNP release key ($openssl)."
}

# ── Install binary ───────────────────────────────────────────────────────────

function Install-Binary {
    param([string]$TmpFile)

    $target = Join-Path $InstallDir $BinaryName

    Write-Info "Installing to $target..."

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    # Stop any running TNP process before overwriting
    Get-Process -Name "tnp" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500

    if (Test-Path $target) {
        try {
            Remove-Item $target -Force
        }
        catch {
            # Still locked: rename it aside; `tnp update` and the next install clean it up.
            $oldTarget = "$target.old"
            Remove-Item $oldTarget -Force -ErrorAction SilentlyContinue
            Rename-Item $target $oldTarget -Force
            Write-Warn "Moved old binary to $oldTarget"
        }
    }

    Move-Item -LiteralPath $TmpFile -Destination $target -Force

    # Add to PATH if not already there (User scope -- no admin required)
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$InstallDir*") {
        Write-Info "Adding $InstallDir to your PATH..."
        $newUserPath = if ([string]::IsNullOrEmpty($userPath)) { $InstallDir } else { "$userPath;$InstallDir" }
        [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
        $env:Path = "$env:Path;$InstallDir"
    }

    Write-Ok "Installed to $target"
}

# ── Interactive setup ────────────────────────────────────────────────────────

function Invoke-DnsSetup {
    Write-Host ""
    Write-Host "  How would you like to resolve TNP domains?" -ForegroundColor White
    Write-Host ""
    Write-Host "  1) " -NoNewline -ForegroundColor Green
    Write-Host "Install TNP service " -NoNewline
    Write-Host "(recommended)" -ForegroundColor DarkGray
    Write-Host "     Runs a local DNS proxy for TNP-native names."
    Write-Host ""
    Write-Host "  2) " -NoNewline -ForegroundColor DarkGray
    Write-Host "Skip -- I'll set it up later"
    Write-Host ""

    $choice = Read-Host "  Choose [1/2]"

    switch ($choice) {
        "1" {
            $tnpPath = Join-Path $InstallDir $BinaryName
            if (Invoke-Elevated -Command "& '$tnpPath' install" -Description "Installing the TNP service") {
                Write-Ok "TNP service installed and running."
            } else {
                Write-Warn "You can retry later from an elevated PowerShell: tnp install"
            }
        }
        default {
            Write-Host ""
            Write-Info "Skipped service installation. Later, use one of:"
            Write-Host ""
            Write-Host "  tnp install" -ForegroundColor Green -NoNewline
            Write-Host "              Install as a system service"
            Write-Host "  tnp run" -ForegroundColor Green -NoNewline
            Write-Host "                  Run the resolver manually"
            Write-Host "  tnp connect" -ForegroundColor Green -NoNewline
            Write-Host "              Overlay client (DNS + SOCKS5 proxy)"
            Write-Host ""
        }
    }
}

# ── Verify installation ─────────────────────────────────────────────────────

function Test-Installation {
    Write-Host ""
    $tnpPath = Join-Path $InstallDir $BinaryName
    try {
        $version = & $tnpPath version 2>&1
        Write-Ok "Installed: $version"
    }
    catch {
        Write-Warn "Could not run the installed binary."
    }
}

# ── Success message ──────────────────────────────────────────────────────────

function Show-Success {
    Write-Host ""
    Write-Host "  Installation complete." -ForegroundColor Green
    if (-not $script:SignatureVerified) {
        Write-Host "  Signature not checked on this machine; checksum only (see above)." -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  Get started:"
    Write-Host "    Register domains  " -NoNewline; Write-Host "https://tnp.network" -ForegroundColor DarkGray
    Write-Host "    Check status      " -NoNewline; Write-Host "tnp status" -ForegroundColor Green
    Write-Host "    Test a domain     " -NoNewline; Write-Host "tnp test example.ox" -ForegroundColor Green
    Write-Host "    Update            " -NoNewline; Write-Host "tnp update" -ForegroundColor Green
    Write-Host "    All commands      " -NoNewline; Write-Host "tnp help" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Docs: https://tnp.network/install" -ForegroundColor DarkGray
    Write-Host ""
    Write-Warn "You may need to open a new terminal for the PATH change to take effect."
}

# ── Main ─────────────────────────────────────────────────────────────────────

function Main {
    Show-Banner

    # TLS 1.2 at least; added to whatever the system already allows.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $platform = Get-Platform
    Write-Info "Detected platform: $platform"
    $asset = "tnp-$platform.exe"

    $version = Get-ReleaseVersion
    $baseUrl = "https://github.com/$Repo/releases/download/v$version"

    $script:WorkDir = New-WorkDir
    $binaryPath = Join-Path $script:WorkDir $asset
    $sumsPath = Join-Path $script:WorkDir "SHA256SUMS"
    $sigPath = Join-Path $script:WorkDir "SHA256SUMS.sig"

    Write-Info "Downloading TNP client v$version from $baseUrl"
    Get-ReleaseFile -Url "$baseUrl/$asset" -OutFile $binaryPath
    Get-ReleaseFile -Url "$baseUrl/SHA256SUMS" -OutFile $sumsPath
    Get-ReleaseFile -Url "$baseUrl/SHA256SUMS.sig" -OutFile $sigPath

    Test-Signature -WorkDir $script:WorkDir -SumsPath $sumsPath -SigPath $sigPath
    Test-Checksum -Asset $asset -BinaryPath $binaryPath -SumsPath $sumsPath

    Install-Binary -TmpFile $binaryPath
    Remove-Item -LiteralPath $script:WorkDir -Recurse -Force -ErrorAction SilentlyContinue

    Invoke-DnsSetup
    Test-Installation
    Show-Success
}

Main
