# TNP Resolver Installer for Windows
# Usage: irm https://get.tnp.network/install.ps1 | iex
$ErrorActionPreference = "Stop"

$Version = "0.1.0"
$InstallDir = "$env:ProgramFiles\tnp"
$TnpBin = "$InstallDir\tnp.exe"

Write-Host ""
Write-Host "  TNP -- The Network Protocol"
Write-Host "  Resolver v$Version"
Write-Host ""

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "  This installer requires administrator privileges."
    Write-Host "  Please run PowerShell as Administrator and try again."
    exit 1
}

# Detect arch
$Arch = if ([Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
} else {
    Write-Host "Error: 32-bit Windows is not supported"
    exit 1
}

$Platform = "win32-$Arch"
$DownloadUrl = "https://get.tnp.network/releases/$Version/tnp-$Platform.exe"

Write-Host "  Platform: $Platform"
Write-Host "  Downloading from: $DownloadUrl"
Write-Host ""

# Create install dir
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Download
$TmpFile = [System.IO.Path]::GetTempFileName()
Invoke-WebRequest -Uri $DownloadUrl -OutFile $TmpFile -UseBasicParsing
Move-Item -Force $TmpFile $TnpBin
Write-Host "  Installed: $TnpBin"

# Add to PATH if not already there
$currentPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
if ($currentPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$currentPath;$InstallDir", "Machine")
    Write-Host "  Added to system PATH"
}

# Install as service
& $TnpBin install

Write-Host ""
Write-Host "  Done! TNP domains now resolve on this device."
Write-Host ""
Write-Host "  Try it:  nslookup example.ox 127.0.0.1"
Write-Host "  Status:  tnp status"
Write-Host "  Remove:  tnp uninstall (run as Administrator)"
Write-Host ""
Write-Host "  Register a domain: https://tnp.network/register"
Write-Host ""
