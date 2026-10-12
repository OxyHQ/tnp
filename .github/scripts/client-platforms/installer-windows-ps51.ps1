# Checks of the rendered install.ps1 inside Windows PowerShell 5.1. Started by
# installer-windows.ps1 (see there); ASCII only, because Windows PowerShell
# reads a script file without a BOM in the ANSI code page.
#
#  1. Its Ed25519 verifier gives the RFC 8032 answers, and refuses near misses.
#  2. It verifies the real release's SHA256SUMS.sig with the pinned key, and
#     refuses a changed SHA256SUMS and a truncated signature.
#  3. The whole script, run as a user would, downloads the real release,
#     verifies it and installs a binary that runs; with the downloaded
#     SHA256SUMS or binary altered in transit it refuses and installs nothing.
param(
    [Parameter(Mandatory = $true)][string]$Rendered,
    [Parameter(Mandatory = $true)][string]$Release,
    [Parameter(Mandatory = $true)][string]$Work,
    [Parameter(Mandatory = $true)][string]$Version
)
$ErrorActionPreference = 'Stop'

$script:failed = $false
function Fail([string]$Msg) { Write-Host "FAIL $Msg"; $script:failed = $true }
function Pass([string]$Msg) { Write-Host "PASS $Msg" }

Write-Host "PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)), CLR $($PSVersionTable.CLRVersion)"
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
    Write-Host 'FAIL this must run in Windows PowerShell 5.1 (powershell.exe), not pwsh'
    exit 1
}

# The installer's functions without its trailing `Main` call.
$text = [IO.File]::ReadAllText($Rendered)
if (-not $text.EndsWith("`nMain`n")) { Write-Host 'FAIL the rendered install.ps1 does not end with Main'; exit 1 }
$lib = Join-Path $Work 'install-lib.ps1'
[IO.File]::WriteAllText($lib, $text.Substring(0, $text.Length - "Main`n".Length))
$tokens = $null; $errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($Rendered, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -ne 0) { $errors | ForEach-Object { Write-Host "FAIL parse: $_" }; exit 1 }
Pass 'install.ps1 parses in Windows PowerShell 5.1'
. $lib

# -- 1. RFC 8032 section 7.1 vectors, and near misses -------------------------

function Invert-Bit([string]$Hex, [int]$Bit) {
    $bytes = ConvertFrom-Hex $Hex
    $bytes[$Bit -shr 3] = $bytes[$Bit -shr 3] -bxor (1 -shl ($Bit -band 7))
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

$vectors = @(
    @{ name = 'TEST 1'; key = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'; msg = ''
       sig = 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b' },
    @{ name = 'TEST 2'; key = '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'; msg = '72'
       sig = '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00' },
    @{ name = 'TEST 3'; key = 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025'; msg = 'af82'
       sig = '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a' },
    @{ name = 'TEST SHA(abc)'; key = 'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf'
       msg = 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f'
       sig = 'dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704' }
)

$watch = [Diagnostics.Stopwatch]::StartNew()
foreach ($v in $vectors) {
    $cases = @(
        @{ label = ''; key = $v.key; msg = $v.msg; sig = $v.sig; valid = $true },
        @{ label = ' / R bit flipped'; key = $v.key; msg = $v.msg; sig = (Invert-Bit $v.sig 5); valid = $false },
        @{ label = ' / S bit flipped'; key = $v.key; msg = $v.msg; sig = (Invert-Bit $v.sig 300); valid = $false },
        @{ label = ' / key bit flipped'; key = (Invert-Bit $v.key 17); msg = $v.msg; sig = $v.sig; valid = $false },
        @{ label = ' / message changed'; key = $v.key; msg = $(if ($v.msg -eq '') { '00' } else { Invert-Bit $v.msg 0 }); sig = $v.sig; valid = $false }
    )
    foreach ($c in $cases) {
        $got = Test-Ed25519Signature (ConvertFrom-Hex $c.key) (ConvertFrom-Hex $c.msg) (ConvertFrom-Hex $c.sig)
        if ($got -isnot [bool]) { Fail "$($v.name)$($c.label): returned $($got.GetType()), not a bool" }
        elseif ($got -ne $c.valid) { Fail "$($v.name)$($c.label): expected $($c.valid), got $got" }
        else { Pass "$($v.name)$($c.label) -> $got" }
    }
}
Write-Host "INFO $($vectors.Count * 5) verifications in $($watch.ElapsedMilliseconds) ms"
if (Test-Ed25519SelfCheck) { Pass 'self-check' } else { Fail 'self-check' }

# -- 2. The real release's signature ------------------------------------------

$sums = Join-Path $Release 'SHA256SUMS'
$sig = Join-Path $Release 'SHA256SUMS.sig'
Get-Content $sums | Write-Host
$script:WorkDir = $null
try { Test-Signature -SumsPath $sums -SigPath $sig; Pass "real v$Version SHA256SUMS.sig verifies with the pinned key" }
catch { Fail "real v$Version SHA256SUMS.sig: $_" }

$changed = Join-Path $Work 'SHA256SUMS.changed'
$bytes = [IO.File]::ReadAllBytes($sums)
$bytes[0] = if ($bytes[0] -eq 0x30) { 0x31 } else { 0x30 }
[IO.File]::WriteAllBytes($changed, $bytes)
try { Test-Signature -SumsPath $changed -SigPath $sig; Fail 'a changed SHA256SUMS was accepted' }
catch { if ("$_" -like '*NOT a valid signature*') { Pass 'a changed SHA256SUMS is refused' } else { Fail "changed SHA256SUMS: $_" } }

$short = Join-Path $Work 'SHA256SUMS.sig.short'
$sigBytes = [IO.File]::ReadAllBytes($sig)
[IO.File]::WriteAllBytes($short, [byte[]]$sigBytes[0..62])
try { Test-Signature -SumsPath $sums -SigPath $short; Fail 'a truncated signature was accepted' }
catch { if ("$_" -like '*not a 64-byte Ed25519 signature*') { Pass 'a truncated signature is refused' } else { Fail "truncated signature: $_" } }

# -- 3. The whole installer, as a user runs it --------------------------------

# Functions shadow cmdlets, and a script finds them in its caller's scope: the
# menu answer is "2" (skip the service), and downloads can be altered. The
# switch is global: inside install.ps1, $script: is install.ps1's own scope.
function Read-Host { param($Prompt) return '2' }
$global:TnpTestTamper = $null
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    Microsoft.PowerShell.Utility\Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
    if ($global:TnpTestTamper -and $Uri.EndsWith("/$($global:TnpTestTamper)")) {
        $stream = [IO.File]::Open($OutFile, 'Append')
        try { $stream.WriteByte(0x0a) } finally { $stream.Dispose() }
        Write-Host "(test) appended a byte to $($global:TnpTestTamper) after download"
    }
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
function Invoke-Installer([string]$InstallDir, [string]$Tamper) {
    $global:TnpTestTamper = $Tamper
    $env:TNP_INSTALL_DIR = $InstallDir
    try { & $Rendered; return $null }
    catch { return "$_" }
    finally {
        $env:TNP_INSTALL_DIR = $null
        [Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
    }
}

$good = Join-Path $Work 'install-good'
$err = Invoke-Installer $good $null
$exe = Join-Path $good 'tnp.exe'
if ($err) { Fail "install.ps1 failed against the real v$Version release: $err" }
elseif (-not (Test-Path -LiteralPath $exe)) { Fail "install.ps1 reported success but $exe is missing" }
else {
    $reported = (& $exe version | Out-String).Trim()
    if ($reported -eq "tnp v$Version") { Pass "install.ps1 installed the verified v$Version binary, which reports '$reported'" }
    else { Fail "the installed binary reports '$reported', expected 'tnp v$Version'" }
}

$cases = @(
    @{ file = 'SHA256SUMS'; expect = '*NOT a valid signature*' },
    @{ file = 'tnp-windows-x64.exe'; expect = '*Checksum mismatch*' }
)
foreach ($case in $cases) {
    $dir = Join-Path $Work "install-tampered-$($case.file)"
    $err = Invoke-Installer $dir $case.file
    if (-not $err) { Fail "install.ps1 accepted a release whose $($case.file) was altered" }
    elseif ($err -notlike $case.expect) { Fail "altered $($case.file): unexpected error $err" }
    elseif (Test-Path -LiteralPath (Join-Path $dir 'tnp.exe')) { Fail "altered $($case.file): a binary was installed anyway" }
    else { Pass "install.ps1 refuses a release whose $($case.file) was altered, and installs nothing" }
}

if ($script:failed) { exit 1 }
Write-Host 'install.ps1 under Windows PowerShell 5.1: ALL PASS'
exit 0
