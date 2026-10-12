# TNP Installer for Windows -- https://tnp.network
# Usage: irm https://get.tnp.network/ps | iex
#
# Downloads the TNP client v__TNP_VERSION__ from the fixed GitHub release URL,
# verifies it, installs it under %LOCALAPPDATA%, and optionally installs the
# local TNP service.
#
# Verification, before anything downloaded is run or moved:
#   1. SHA256SUMS.sig must be a valid Ed25519 signature over SHA256SUMS by the
#      release key embedded below. Windows PowerShell has no Ed25519, so this
#      script carries its own verifier (RFC 8032, below, using only .NET's
#      BigInteger and SHA-512). It must pass an RFC 8032 test vector before its
#      answer is believed, and there is no unsigned path: a signature that
#      cannot be checked is a failed install.
#   2. The binary's SHA-256 (Get-FileHash) must equal its line in SHA256SUMS.
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

# Set by Initialize-Ed25519 on first use.
$script:EdB = $null

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

# ── Ed25519 (RFC 8032) ───────────────────────────────────────────────────────
#
# Verification only, over public data: no secret is involved, so constant time
# does not matter and plain BigInteger arithmetic is enough. Points are in
# extended coordinates [X, Y, Z, T] (x = X/Z, y = Y/Z, xy = T/Z) and use the
# complete addition formula of RFC 8032 §5.1.4 for both adding and doubling.
# Functions return arrays behind a leading comma so PowerShell does not unroll
# them.

function ConvertFrom-Hex {
    param([string]$Hex)
    $out = New-Object byte[] ($Hex.Length / 2)
    for ($i = 0; $i -lt $out.Length; $i++) { $out[$i] = [Convert]::ToByte($Hex.Substring($i * 2, 2), 16) }
    return , $out
}

function ConvertFrom-LittleEndian {
    param([byte[]]$Bytes)
    # One extra zero byte keeps BigInteger from reading the top bit as a sign.
    $buffer = New-Object byte[] ($Bytes.Length + 1)
    [Array]::Copy($Bytes, $buffer, $Bytes.Length)
    return New-Object System.Numerics.BigInteger -ArgumentList (, $buffer)
}

function ConvertTo-LittleEndian32 {
    param([System.Numerics.BigInteger]$Value)
    $raw = $Value.ToByteArray()
    $out = New-Object byte[] 32
    [Array]::Copy($raw, $out, [Math]::Min($raw.Length, 32))
    return , $out
}

function Add-EdPoint {
    param($P1, $P2)
    $p = $script:EdP
    $a = (($P1[1] - $P1[0] + $p) * ($P2[1] - $P2[0] + $p)) % $p
    $b = (($P1[1] + $P1[0]) * ($P2[1] + $P2[0])) % $p
    $c = ((($P1[3] * $script:EdD2) % $p) * $P2[3]) % $p
    $d = (($P1[2] * 2) * $P2[2]) % $p
    $e = ($b - $a + $p) % $p
    $f = ($d - $c + $p) % $p
    $g = ($d + $c) % $p
    $h = ($b + $a) % $p
    return , @((($e * $f) % $p), (($g * $h) % $p), (($f * $g) % $p), (($e * $h) % $p))
}

function Invoke-EdScalarMult {
    param([byte[]]$Scalar, $Point)
    $zero = [System.Numerics.BigInteger]::Zero
    $one = [System.Numerics.BigInteger]::One
    $q = @($zero, $one, $one, $zero)
    for ($i = 255; $i -ge 0; $i--) {
        $q = Add-EdPoint $q $q
        if ((($Scalar[$i -shr 3] -shr ($i -band 7)) -band 1) -eq 1) { $q = Add-EdPoint $q $Point }
    }
    return , $q
}

# RFC 8032 §5.1.3. $null for anything that is not a valid point encoding.
function ConvertFrom-EdPoint {
    param([byte[]]$Bytes)
    if ($Bytes.Length -ne 32) { return $null }
    $p = $script:EdP
    $signBit = ($Bytes[31] -shr 7) -band 1
    $yBytes = [byte[]]$Bytes.Clone()
    $yBytes[31] = $yBytes[31] -band 0x7f
    $y = ConvertFrom-LittleEndian $yBytes
    if ($y -ge $p) { return $null }
    $y2 = ($y * $y) % $p
    $u = ($y2 - 1 + $p) % $p
    $v = ($script:EdD * $y2 + 1) % $p
    $v3 = ((($v * $v) % $p) * $v) % $p
    $v7 = ((($v3 * $v3) % $p) * $v) % $p
    $x = ((($u * $v3) % $p) * [System.Numerics.BigInteger]::ModPow((($u * $v7) % $p), $script:EdPm5d8, $p)) % $p
    $vx2 = ($v * (($x * $x) % $p)) % $p
    if ($vx2 -ne $u) {
        if ($vx2 -ne (($p - $u) % $p)) { return $null }
        $x = ($x * $script:EdSqrtM1) % $p
    }
    if ($x.IsZero -and $signBit -eq 1) { return $null }
    $xOdd = if ($x.IsEven) { 0 } else { 1 }
    if ($xOdd -ne $signBit) { $x = $p - $x }
    return , @($x, $y, [System.Numerics.BigInteger]::One, (($x * $y) % $p))
}

# The curve constants, derived from their definitions rather than typed in.
function Initialize-Ed25519 {
    if ($script:EdB) { return }
    $two = New-Object System.Numerics.BigInteger 2
    $p = [System.Numerics.BigInteger]::Pow($two, 255) - 19
    $script:EdP = $p
    $script:EdL = [System.Numerics.BigInteger]::Pow($two, 252) + [System.Numerics.BigInteger]::Parse("27742317777372353535851937790883648493")
    # d = -121665/121666 mod p
    $inverse = [System.Numerics.BigInteger]::ModPow((New-Object System.Numerics.BigInteger 121666), $p - 2, $p)
    $script:EdD = (($p - 121665) * $inverse) % $p
    $script:EdD2 = ($script:EdD * 2) % $p
    $script:EdPm5d8 = [System.Numerics.BigInteger]::Divide($p - 5, 8)
    $script:EdSqrtM1 = [System.Numerics.BigInteger]::ModPow($two, [System.Numerics.BigInteger]::Divide($p - 1, 4), $p)
    # The base point: y = 4/5, x even.
    $base = ConvertFrom-EdPoint (ConvertFrom-Hex "5866666666666666666666666666666666666666666666666666666666666666")
    if ($null -eq $base) { throw "Ed25519 base point did not decode" }
    $script:EdB = $base
}

# True only for a valid signature by $PublicKey over $Message: RFC 8032
# §5.1.7, cofactorless equation [S]B = R + [k]A, with S < L and A and R both
# valid point encodings.
function Test-Ed25519Signature {
    param([byte[]]$PublicKey, [byte[]]$Message, [byte[]]$Signature)
    # Strict mode makes a $null slipping into the arithmetic an error, where
    # PowerShell would otherwise read it as 0 and could make both sides equal.
    Set-StrictMode -Version 3.0
    Initialize-Ed25519
    if ($PublicKey.Length -ne 32 -or $Signature.Length -ne 64) { return $false }
    $rBytes = New-Object byte[] 32
    $sBytes = New-Object byte[] 32
    [Array]::Copy($Signature, 0, $rBytes, 0, 32)
    [Array]::Copy($Signature, 32, $sBytes, 0, 32)
    if ((ConvertFrom-LittleEndian $sBytes) -ge $script:EdL) { return $false }
    $a = ConvertFrom-EdPoint $PublicKey
    if ($null -eq $a) { return $false }
    $r = ConvertFrom-EdPoint $rBytes
    if ($null -eq $r) { return $false }

    $sha = [Security.Cryptography.SHA512]::Create()
    try {
        [void]$sha.TransformBlock($rBytes, 0, 32, $null, 0)
        [void]$sha.TransformBlock($PublicKey, 0, 32, $null, 0)
        [void]$sha.TransformFinalBlock($Message, 0, $Message.Length)
        $digest = $sha.Hash
    }
    finally { $sha.Dispose() }
    $k = ConvertTo-LittleEndian32 ((ConvertFrom-LittleEndian $digest) % $script:EdL)

    $left = Invoke-EdScalarMult $sBytes $script:EdB
    $right = Add-EdPoint $r (Invoke-EdScalarMult $k $a)
    if ($left.Count -ne 4 -or $right.Count -ne 4) { throw "Ed25519 arithmetic failed" }
    $p = $script:EdP
    $sameX = (($left[0] * $right[2]) % $p) -eq (($right[0] * $left[2]) % $p)
    $sameY = (($left[1] * $right[2]) % $p) -eq (($right[1] * $left[2]) % $p)
    return [bool]($sameX -and $sameY)
}

# RFC 8032 §7.1 TEST 2 must verify, and the same signature over another
# message must not, before this verifier's answer about a release is believed.
function Test-Ed25519SelfCheck {
    $key = ConvertFrom-Hex "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"
    $sig = ConvertFrom-Hex "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
    $good = Test-Ed25519Signature $key ([byte[]]@(0x72)) $sig
    $bad = Test-Ed25519Signature $key ([byte[]]@(0x73)) $sig
    return ($good -eq $true) -and ($bad -eq $false)
}

# The raw 32-byte key inside the pinned SubjectPublicKeyInfo PEM.
function Get-ReleaseKeyBytes {
    $body = ($ReleaseKeyPem -replace '-----(BEGIN|END) PUBLIC KEY-----', '') -replace '\s', ''
    $der = [Convert]::FromBase64String($body)
    $prefix = ConvertFrom-Hex "302a300506032b6570032100"
    $ok = $der.Length -eq 44
    for ($i = 0; $ok -and $i -lt $prefix.Length; $i++) { $ok = $der[$i] -eq $prefix[$i] }
    if (-not $ok) { Exit-Fatal "The embedded release key is not an Ed25519 key. Not installing." }
    $key = New-Object byte[] 32
    [Array]::Copy($der, 12, $key, 0, 32)
    return , $key
}

function Test-Signature {
    param([string]$SumsPath, [string]$SigPath)

    $sumsSize = (Get-Item -LiteralPath $SumsPath).Length
    if ($sumsSize -gt 65536) { Exit-Fatal "SHA256SUMS is $sumsSize bytes, more than a release carries. Not installing." }
    $sums = [IO.File]::ReadAllBytes($SumsPath)
    $sig = [IO.File]::ReadAllBytes($SigPath)
    if ($sig.Length -ne 64) { Exit-Fatal "SHA256SUMS.sig is $($sig.Length) bytes, not a 64-byte Ed25519 signature. Not installing." }

    $selfCheck = $false
    try { $selfCheck = Test-Ed25519SelfCheck } catch { $selfCheck = $false }
    if ($selfCheck -ne $true) {
        Exit-Fatal "The built-in Ed25519 verifier failed its self-test in this PowerShell, so the release signature cannot be checked. Not installing."
    }

    $key = Get-ReleaseKeyBytes
    $valid = $false
    try { $valid = Test-Ed25519Signature $key $sums $sig } catch { $valid = $false }
    if ($valid -ne $true) {
        Exit-Fatal "SHA256SUMS.sig is NOT a valid signature by the TNP release key. Not installing."
    }
    Write-Ok "Signature on SHA256SUMS verified with the pinned TNP release key."
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

    Test-Signature -SumsPath $sumsPath -SigPath $sigPath
    Test-Checksum -Asset $asset -BinaryPath $binaryPath -SumsPath $sumsPath

    Install-Binary -TmpFile $binaryPath
    Remove-Item -LiteralPath $script:WorkDir -Recurse -Force -ErrorAction SilentlyContinue

    Invoke-DnsSetup
    Test-Installation
    Show-Success
}

Main
