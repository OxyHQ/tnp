# Exercises the verification functions of the rendered install.ps1 (written to
# $Dir/install-lib.ps1 with its trailing `Main` call removed) against fixture
# releases in $Dir/good, $Dir/tampered and $Dir/forged. Run by client.test.ts
# when pwsh is on PATH (GitHub's Ubuntu runners have it).
param([string]$Dir)
$ErrorActionPreference = "Stop"

# 1. The full rendered script parses.
$tokens = $null; $errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Dir "install-lib.ps1"), [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -ne 0) { $errors | ForEach-Object { Write-Host "PARSE ERROR: $_" }; exit 1 }
Write-Host "PASS parse"

. (Join-Path $Dir "install-lib.ps1")

function Expect-Throw {
    param([string]$Name, [scriptblock]$Block, [string]$Like)
    try { & $Block; Write-Host "FAIL $Name (no throw)"; $script:failed = $true }
    catch {
        if ("$_" -like "*$Like*") { Write-Host "PASS $Name" }
        else { Write-Host "FAIL $Name : $_"; $script:failed = $true }
    }
}
$script:failed = $false

function Check {
    param([string]$Release)
    $d = Join-Path $Dir $Release
    $script:WorkDir = $null
    Test-Signature -WorkDir $d -SumsPath (Join-Path $d "SHA256SUMS") -SigPath (Join-Path $d "SHA256SUMS.sig")
    Test-Checksum -Asset "tnp-windows-x64.exe" -BinaryPath (Join-Path $d "tnp-windows-x64.exe") -SumsPath (Join-Path $d "SHA256SUMS")
}

# 2. Good release verifies (signature via the system OpenSSL 3, then checksum).
Check "good"
if (-not $script:SignatureVerified) { Write-Host "FAIL good: signature not verified"; $script:failed = $true } else { Write-Host "PASS good" }

# 3. Tampered binary, forged signature.
Expect-Throw "tampered" { Check "tampered" } "Checksum mismatch"
Expect-Throw "forged" { Check "forged" } "NOT a valid signature"

# 4. Version validation.
$env:TNP_VERSION = "0.3.0`nevil"
Expect-Throw "version-newline" { Get-ReleaseVersion } "Refusing version"
$env:TNP_VERSION = "v0.3.0"
Expect-Throw "version-v" { Get-ReleaseVersion } "Refusing version"
$env:TNP_VERSION = "0.3.1"
if ((Get-ReleaseVersion) -eq "0.3.1") { Write-Host "PASS version-override" } else { Write-Host "FAIL version-override"; $script:failed = $true }
$env:TNP_VERSION = $null

# 5. No OpenSSL: checksum only, or refuse when required.
$env:PATH = "/nonexistent"
$script:SignatureVerified = $false
Check "good"
if ($script:SignatureVerified) { Write-Host "FAIL no-openssl claimed a signature"; $script:failed = $true } else { Write-Host "PASS no-openssl checksum-only" }
Expect-Throw "no-openssl-tampered" { Check "tampered" } "Checksum mismatch"
$env:TNP_REQUIRE_SIGNATURE = "1"
Expect-Throw "no-openssl-required" { Check "good" } "TNP_REQUIRE_SIGNATURE=1"

if ($script:failed) { exit 1 } else { Write-Host "ALL PASS" }
