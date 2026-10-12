# Run the real, rendered install.ps1 against the real signed GitHub release,
# under Windows PowerShell 5.1 (powershell.exe): the PowerShell every Windows
# 10/11 machine has, and the one `irm https://get.tnp.network/ps | iex` usually
# runs in. Run by .github/workflows/client-platforms.yml; this driver (pwsh)
# renders the script and fetches the release, and installer-windows-ps51.ps1
# does the checks inside powershell.exe.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$Log = if ($env:E2E_LOG_DIR) { $env:E2E_LOG_DIR } else { Join-Path ([IO.Path]::GetTempPath()) 'e2e-logs' }
New-Item -ItemType Directory -Force -Path $Log | Out-Null
$work = Join-Path ([IO.Path]::GetTempPath()) ("tnp-installer-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

$rendered = Join-Path $work 'install.ps1'
bun "$PSScriptRoot\render-installer.ts" install.ps1 $rendered
if ($LASTEXITCODE -ne 0) { throw 'could not render install.ps1' }
$version = [regex]::Match((Get-Content -Raw $rendered), '\$DefaultVersion = "([0-9.]+)"').Groups[1].Value
if (-not $version) { throw 'no version in the rendered install.ps1' }

# The signed checksum list of the release the installer installs, fetched
# here so the verifier can also be checked on its own.
$release = Join-Path $work 'release'
New-Item -ItemType Directory -Path $release | Out-Null
foreach ($file in @('SHA256SUMS', 'SHA256SUMS.sig')) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/OxyHQ/tnp/releases/download/v$version/$file" -OutFile (Join-Path $release $file)
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PSScriptRoot\installer-windows-ps51.ps1" `
    -Rendered $rendered -Release $release -Work $work -Version $version 2>&1 | Tee-Object -FilePath (Join-Path $Log 'installer-windows.log')
if ($LASTEXITCODE -ne 0) { throw "install.ps1 checks under Windows PowerShell 5.1 failed (exit $LASTEXITCODE)" }
