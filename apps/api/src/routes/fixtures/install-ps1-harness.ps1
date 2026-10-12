# Exercises the verification functions of the rendered install.ps1 (written to
# $Dir/install-lib.ps1 with its trailing `Main` call removed) against fixture
# releases in $Dir/good, $Dir/tampered, $Dir/forged and $Dir/short-sig, and its
# Ed25519 verifier against the vectors in $Dir/vectors.json. Run by
# client.test.ts when pwsh is on PATH (GitHub's Ubuntu runners have it, and CI
# fails if it does not), and on Windows also under Windows PowerShell 5.1.
# Nothing here uses OpenSSL: PATH is emptied first, so the verifier can only be
# the script's own. ASCII only: Windows PowerShell reads a script without a BOM
# in the ANSI code page.
param([string]$Dir)
$ErrorActionPreference = "Stop"
$env:PATH = "/nonexistent"

# 1. The full rendered script parses.
$tokens = $null; $errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Dir "install-lib.ps1"), [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -ne 0) { $errors | ForEach-Object { Write-Host "PARSE ERROR: $_" }; exit 1 }
Write-Host "PASS parse"

. (Join-Path $Dir "install-lib.ps1")

$script:failed = $false
function Fail { param([string]$Msg) Write-Host "FAIL $Msg"; $script:failed = $true }

function Expect-Throw {
    param([string]$Name, [scriptblock]$Block, [string]$Like)
    try { & $Block; Fail "$Name (no throw)" }
    catch {
        if ("$_" -like "*$Like*") { Write-Host "PASS $Name" }
        else { Fail "$Name : $_" }
    }
}

function Check {
    param([string]$Release)
    $d = Join-Path $Dir $Release
    $script:WorkDir = $null
    Test-Signature -SumsPath (Join-Path $d "SHA256SUMS") -SigPath (Join-Path $d "SHA256SUMS.sig")
    Test-Checksum -Asset "tnp-windows-x64.exe" -BinaryPath (Join-Path $d "tnp-windows-x64.exe") -SumsPath (Join-Path $d "SHA256SUMS")
}

# 2. The verifier itself: every vector (RFC 8032 section 7.1 and random ones made by
#    node:crypto) must give exactly the expected answer.
$watch = [Diagnostics.Stopwatch]::StartNew()
$vectors = Get-Content -Raw -LiteralPath (Join-Path $Dir "vectors.json") | ConvertFrom-Json
foreach ($v in $vectors) {
    $got = Test-Ed25519Signature (ConvertFrom-Hex $v.key) (ConvertFrom-Hex $v.msg) (ConvertFrom-Hex $v.sig)
    if ($got -isnot [bool]) { Fail "vector $($v.name): returned $($got.GetType()), not a bool" }
    elseif ($got -ne $v.valid) { Fail "vector $($v.name): expected $($v.valid), got $got" }
    else { Write-Host "PASS vector $($v.name)" }
}
Write-Host "INFO $($vectors.Count) vectors in $($watch.ElapsedMilliseconds) ms"
if (Test-Ed25519SelfCheck) { Write-Host "PASS self-check" } else { Fail "self-check" }

# 3. Good release verifies (signature, then checksum).
try { Check "good"; Write-Host "PASS good" } catch { Fail "good: $_" }

# 4. Tampered binary, forged signature, truncated signature.
Expect-Throw "tampered" { Check "tampered" } "Checksum mismatch"
Expect-Throw "forged" { Check "forged" } "NOT a valid signature"
Expect-Throw "short-sig" { Check "short-sig" } "not a 64-byte Ed25519 signature"

# 5. A verifier that fails its self-test refuses rather than trusting it.
$savedB = $script:EdB
$script:EdB = @([System.Numerics.BigInteger]::Zero, [System.Numerics.BigInteger]::One, [System.Numerics.BigInteger]::One, [System.Numerics.BigInteger]::Zero)
Expect-Throw "broken-verifier" { Check "good" } "failed its self-test"
$script:EdB = $savedB

# 6. Version validation.
$env:TNP_VERSION = "0.3.0`nevil"
Expect-Throw "version-newline" { Get-ReleaseVersion } "Refusing version"
$env:TNP_VERSION = "0.3.0`n"
Expect-Throw "version-trailing-newline" { Get-ReleaseVersion } "Refusing version"
$env:TNP_VERSION = "v0.3.0"
Expect-Throw "version-v" { Get-ReleaseVersion } "Refusing version"
$env:TNP_VERSION = "0.3.1"
if ((Get-ReleaseVersion) -eq "0.3.1") { Write-Host "PASS version-override" } else { Fail "version-override" }
$env:TNP_VERSION = $null

if ($script:failed) { exit 1 } else { Write-Host "ALL PASS" }
