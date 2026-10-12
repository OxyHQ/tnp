# End-to-end test of the compiled TNP client on a real Windows machine, as
# Administrator. Run by .github/workflows/client-platforms.yml on a throwaway
# runner:
#
#   $env:E2E_LOG_DIR = '<dir>'; ./e2e-windows.ps1 -Tnp <compiled tnp.exe>
#
# It registers a SYSTEM scheduled task, adds NRPT and Windows Firewall rules,
# toggles firewall profiles, and removes all of it again; do not run it on a
# machine you care about.
param([Parameter(Mandatory = $true)][string]$Tnp)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$Log = $env:E2E_LOG_DIR
if (-not $Log) { throw 'E2E_LOG_DIR must name a directory for logs' }
New-Item -ItemType Directory -Force -Path $Log | Out-Null
$Tnp = (Resolve-Path -LiteralPath $Tnp).Path

$Port = 18080
$Name = 'e2e.ox'
$Addr = '203.0.113.7'
$TaskName = 'TnpResolver'
$ProgramFiles = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion').ProgramFilesDir
$ProgramDir = Join-Path $ProgramFiles 'TNP'
$Installed = Join-Path $ProgramDir 'tnp.exe'
$ProgramData = [Environment]::GetFolderPath('CommonApplicationData')
$ConfigDir = Join-Path $ProgramData 'tnp'
$ConfigFile = Join-Path $ConfigDir 'config.json'
$KillSwitchRecord = Join-Path $ConfigDir 'killswitch.json'
$UserDataDir = Join-Path $env:LOCALAPPDATA 'tnp'
$SystemDataDir = Join-Path $env:SystemRoot 'System32\config\systemprofile\AppData\Local\tnp'
$FirewallRules = @('TNP-KillSwitch-DNS-UDP-v4', 'TNP-KillSwitch-DNS-TCP-v4', 'TNP-KillSwitch-DNS-UDP-v6', 'TNP-KillSwitch-DNS-TCP-v6')

# Well-known SIDs, so nothing depends on the display language.
$SidSystem = 'S-1-5-18'
$SidAdmins = 'S-1-5-32-544'
$SidUsers = 'S-1-5-32-545'
$SidTrustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'

$script:Api = $null
$script:Connect = $null
$script:ProfilesBefore = $null

function Fail([string]$Msg) { Write-Host "::error::$Msg"; throw $Msg }
function Pass([string]$Msg) { Write-Host "PASS $Msg" }
function Group([string]$Msg) { Write-Host "::group::$Msg" }
function EndGroup { Write-Host '::endgroup::' }

function Wait-Until([string]$What, [int]$Seconds, [scriptblock]$Condition) {
    for ($i = 0; $i -lt $Seconds; $i++) {
        try { if (& $Condition) { return } } catch { }
        Start-Sleep -Seconds 1
    }
    Fail "timed out waiting for $What"
}

# Run tnp to completion; output goes to the console and a log file.
function Invoke-Tnp([string]$LogName, [string[]]$Arguments, [int]$TimeoutSeconds = 180) {
    $out = Join-Path $Log "$LogName.log"
    $err = Join-Path $Log "$LogName.err.log"
    $p = Start-Process -FilePath $Tnp -ArgumentList $Arguments -NoNewWindow -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        Get-Content $out, $err -ErrorAction SilentlyContinue | Write-Host
        Fail "tnp $($Arguments -join ' ') did not finish within ${TimeoutSeconds}s"
    }
    Get-Content $out, $err -ErrorAction SilentlyContinue | Write-Host
    return $p.ExitCode
}

function Get-TnpOutput([string]$LogName) {
    return (Get-Content (Join-Path $Log "$LogName.log"), (Join-Path $Log "$LogName.err.log") -Raw -ErrorAction SilentlyContinue) -join "`n"
}

# Start `tnp connect` in the background and wait until it is ready.
function Start-Connect([string]$LogName, [string[]]$Flags) {
    $out = Join-Path $Log "$LogName.log"
    $err = Join-Path $Log "$LogName.err.log"
    $script:Connect = Start-Process -FilePath $Tnp -ArgumentList (@('connect') + $Flags) -NoNewWindow -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    for ($i = 0; $i -lt 60; $i++) {
        if ((Get-Content $out -Raw -ErrorAction SilentlyContinue) -match 'overlay client ready') { return }
        if ($script:Connect.HasExited) {
            Get-Content $out, $err -ErrorAction SilentlyContinue | Write-Host
            Fail "tnp connect $Flags exited (code $($script:Connect.ExitCode)) before it was ready"
        }
        Start-Sleep -Seconds 1
    }
    Get-Content $out, $err -ErrorAction SilentlyContinue | Write-Host
    Fail "tnp connect $Flags was not ready within 60s"
}

# Kill connect without letting it clean up: what a crash looks like.
function Stop-ConnectHard {
    Stop-Process -Id $script:Connect.Id -Force
    $script:Connect.WaitForExit(15000) | Out-Null
    $script:Connect = $null
}

function Get-AdapterDns {
    Get-DnsClientServerAddress | Sort-Object InterfaceIndex, AddressFamily | ForEach-Object {
        "$($_.InterfaceIndex)|$($_.InterfaceAlias)|$($_.AddressFamily)|$($_.ServerAddresses -join ',')"
    } | Out-String
}

function Get-NrptRules {
    @(Get-DnsClientNrptRule) | Sort-Object Name | ForEach-Object {
        "$($_.Namespace -join ',')|$($_.NameServers -join ',')|$($_.Comment)"
    } | Out-String
}

function Get-TnpFirewallRules { @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'TNP-*' }) }

# Plain DNS to a public resolver; true only if an A record came back.
function Test-PublicDns([switch]$Tcp) {
    try {
        $answer = Resolve-DnsName -Name example.com -Type A -Server 1.1.1.1 -DnsOnly -NoHostsFile -QuickTimeout -TcpOnly:$Tcp -ErrorAction Stop
        return [bool](@($answer | Where-Object { $_.Type -eq 'A' }).Count)
    } catch { return $false }
}

function Resolve-Via([string]$Server) {
    $answer = Resolve-DnsName -Name $Name -Type A -Server $Server -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop
    return @($answer | Where-Object { $_.Type -eq 'A' } | ForEach-Object { $_.IPAddress })
}

function ConvertTo-Sid($Identity) {
    try { return $Identity.Translate([Security.Principal.SecurityIdentifier]).Value } catch { return "$Identity" }
}

# Every allow rule on $Path whose trustee is not SYSTEM/Administrators (and,
# for the program directory, Users with read/execute), as text.
function Get-AclProblems([string]$Path, [switch]$ProgramDir) {
    $acl = Get-Acl -LiteralPath $Path
    $problems = @()
    $owner = ConvertTo-Sid ([Security.Principal.NTAccount]$acl.Owner)
    if ($owner -notin @($SidSystem, $SidAdmins, $SidTrustedInstaller)) { $problems += "$Path is owned by $($acl.Owner)" }
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne 'Allow') { continue }
        $sid = ConvertTo-Sid $rule.IdentityReference
        if ($sid -in @($SidSystem, $SidAdmins)) { continue }
        # Read/execute (icacls RX), with or without the generic bits an
        # inheritable entry can carry.
        $mask = ([int64][int]$rule.FileSystemRights) -band 0xFFFFFFFFL
        $readExecute = 0x001200A9L -bor 0x80000000L -bor 0x20000000L
        if ($ProgramDir -and $sid -eq $SidUsers -and ((($mask -band (-bnot $readExecute)) -band 0xFFFFFFFFL) -eq 0)) { continue }
        $problems += "$Path grants $($rule.IdentityReference) ($sid) $($rule.FileSystemRights)"
    }
    return $problems
}

function Set-ListenPort([int]$Value) {
    $config = Get-Content -Raw -LiteralPath $ConfigFile | ConvertFrom-Json
    $config.listenPort = $Value
    [IO.File]::WriteAllText($ConfigFile, ($config | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
}

function Save-Diagnostics {
    try {
        $out = @()
        $out += '== scheduled task'; $out += (schtasks /Query /TN $TaskName /V /FO LIST 2>&1 | Out-String)
        $out += '== NRPT'; $out += (Get-DnsClientNrptRule | Format-List | Out-String)
        $out += '== adapter DNS'; $out += (Get-DnsClientServerAddress | Format-Table -AutoSize | Out-String)
        $out += '== firewall profiles'; $out += (Get-NetFirewallProfile | Format-Table Name, Enabled | Out-String)
        $out += '== TNP firewall rules'; $out += (Get-TnpFirewallRules | Format-List | Out-String)
        $out += '== tnp processes'; $out += (Get-CimInstance Win32_Process -Filter "Name='tnp.exe'" | Format-List ProcessId, ExecutablePath, CommandLine | Out-String)
        foreach ($p in @($ConfigDir, $ProgramDir, $UserDataDir, $SystemDataDir)) {
            $out += "== $p"; $out += (icacls $p 2>&1 | Out-String); $out += (Get-ChildItem -Force -LiteralPath $p -ErrorAction SilentlyContinue | Out-String)
        }
        $out | Set-Content -LiteralPath (Join-Path $Log 'diagnostics.txt')
    } catch { Write-Host "could not save diagnostics: $_" }
}

try {
    # ── Before ───────────────────────────────────────────────────────────────
    Group 'Record the DNS and firewall state before install'
    [Environment]::OSVersion | Write-Host
    $adapterDnsBefore = Get-AdapterDns
    $nrptBefore = Get-NrptRules
    $script:ProfilesBefore = @(Get-NetFirewallProfile | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Enabled = [bool]$_.Enabled } })
    Write-Host "adapter DNS:`n$adapterDnsBefore"
    Write-Host "NRPT rules:`n$nrptBefore"
    $script:ProfilesBefore | Format-Table | Out-String | Write-Host
    if (Get-TnpFirewallRules) { Fail 'TNP firewall rules exist before install' }
    if (-not (Test-PublicDns)) { Fail 'plain DNS to 1.1.1.1 does not work on this runner even before TNP' }
    if (Test-Path -LiteralPath $ConfigDir) { Fail "$ConfigDir exists before install" }
    EndGroup

    Group 'Start the fake TNP API'
    $bun = (Get-Command bun).Source
    $script:Api = Start-Process -FilePath $bun -ArgumentList @("$PSScriptRoot\fake-api.ts", $Port, "$Log\api-requests.log") `
        -NoNewWindow -PassThru -RedirectStandardOutput "$Log\fake-api.log" -RedirectStandardError "$Log\fake-api.err.log"
    Wait-Until 'the fake API' 30 { (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/health").StatusCode -eq 200 }
    # The config tnp install reads; only the API is changed from the defaults.
    New-Item -ItemType Directory -Path $ConfigDir | Out-Null
    [IO.File]::WriteAllText($ConfigFile, "{`n  `"apiBaseUrl`": `"http://127.0.0.1:$Port`"`n}`n", (New-Object Text.UTF8Encoding $false))
    EndGroup

    # ── Install ──────────────────────────────────────────────────────────────
    Group 'tnp install'
    $code = Invoke-Tnp 'install' @('install')
    if ($code -ne 0) { Fail "tnp install exited $code" }
    EndGroup

    Group 'The SYSTEM task runs the admin-only copy'
    $task = Get-ScheduledTask -TaskName $TaskName
    $action = @($task.Actions)[0]
    if ($action.Execute -ne $Installed) { Fail "the task runs '$($action.Execute)', not '$Installed'" }
    if ($action.Arguments -ne 'run') { Fail "the task arguments are '$($action.Arguments)', not 'run'" }
    if ($task.Principal.UserId -notin @('SYSTEM', 'S-1-5-18', 'NT AUTHORITY\SYSTEM')) { Fail "the task runs as '$($task.Principal.UserId)', not SYSTEM" }
    if ((Get-FileHash $Installed).Hash -ne (Get-FileHash $Tnp).Hash) { Fail "$Installed is not a copy of the binary that ran install" }
    Wait-Until 'the task to be running' 30 { (Get-ScheduledTask -TaskName $TaskName).State -eq 'Running' }
    Wait-Until 'the resolver process' 30 {
        $script:proc = Get-CimInstance Win32_Process -Filter "Name='tnp.exe'" | Where-Object { $_.ExecutablePath -eq $Installed }
        [bool]$script:proc
    }
    $proc = $script:proc
    $owner = Invoke-CimMethod -InputObject @($proc)[0] -MethodName GetOwner
    if ($owner.User -ne 'SYSTEM') { Fail "the resolver runs as $($owner.Domain)\$($owner.User), not SYSTEM" }
    $problems = @(Get-AclProblems $ProgramDir -ProgramDir) + @(Get-AclProblems $Installed -ProgramDir)
    icacls $ProgramDir | Write-Host
    if ($problems.Count) { Fail ($problems -join '; ') }
    $code = Invoke-Tnp 'status-installed' @('status')
    if ($code -ne 0) { Fail "tnp status exited $code with the resolver installed" }
    Pass "task $TaskName runs $Installed as SYSTEM (pid $(@($proc)[0].ProcessId)); $ProgramDir is admin-writable only"
    EndGroup

    Group 'Only .ox is routed, by one NRPT rule; adapter DNS untouched'
    $tnpRules = @(Get-DnsClientNrptRule | Where-Object { $_.Comment -like '*TNP*' })
    $tnpRules | Format-List Name, Namespace, NameServers, Comment | Out-String | Write-Host
    if ($tnpRules.Count -ne 1) { Fail "expected exactly one TNP NRPT rule, found $($tnpRules.Count)" }
    if (($tnpRules[0].Namespace -join ',') -ne '.ox') { Fail "the NRPT rule covers '$($tnpRules[0].Namespace)', not '.ox'" }
    if (($tnpRules[0].NameServers -join ',') -ne '127.0.0.1') { Fail "the NRPT rule points at '$($tnpRules[0].NameServers)'" }
    if ($tnpRules[0].Comment -ne 'Managed by TNP') { Fail "unexpected NRPT comment '$($tnpRules[0].Comment)'" }
    $otherRules = @(Get-DnsClientNrptRule | Where-Object { $_.Comment -notlike '*TNP*' }) | Sort-Object Name | ForEach-Object {
        "$($_.Namespace -join ',')|$($_.NameServers -join ',')|$($_.Comment)"
    } | Out-String
    if ($otherRules -ne $nrptBefore) { Fail 'install changed NRPT rules that are not TNP''s' }
    if ((Get-AdapterDns) -ne $adapterDnsBefore) { Fail "install changed adapter DNS servers:`n$(Get-AdapterDns)" }
    Pass 'one NRPT rule .ox -> 127.0.0.1; other NRPT rules and every adapter''s DNS servers unchanged'
    EndGroup

    Group 'The system resolver answers .ox from TNP, and public names as before'
    Wait-Until 'the resolver to answer on 127.0.0.1:53' 30 { (Resolve-Via '127.0.0.1') -contains $Addr }
    Clear-DnsClientCache
    Wait-Until "the system resolver to answer $Name" 20 {
        $script:system = Resolve-DnsName -Name $Name -Type A -DnsOnly -ErrorAction Stop
        @($script:system | Where-Object { $_.Type -eq 'A' } | ForEach-Object { $_.IPAddress }) -contains $Addr
    }
    $script:system | Format-Table | Out-String | Write-Host
    if (-not ((Get-Content -Raw "$Log\api-requests.log") -match "/dns/resolve\?name=$([regex]::Escape($Name))")) { Fail "the fake API never saw a lookup of $Name" }
    $public = @(Resolve-DnsName -Name example.com -Type A -DnsOnly -ErrorAction Stop | Where-Object { $_.Type -eq 'A' })
    $public | Format-Table | Out-String | Write-Host
    if (-not $public.Count) { Fail 'example.com does not resolve through the system resolver' }
    if (@($public | ForEach-Object { $_.IPAddress }) -contains $Addr) { Fail 'example.com resolved to the TNP test answer' }
    if ((Get-Content -Raw "$Log\api-requests.log") -match 'name=example\.com') { Fail 'a public name was sent to the TNP API' }
    Pass "$Name -> $Addr via NRPT and the fake API; example.com via the adapter's resolvers"
    EndGroup

    Group 'Config is SYSTEM/Administrators only'
    icacls $ConfigDir | Write-Host
    icacls $ConfigFile | Write-Host
    $problems = @(Get-AclProblems $ConfigDir) + @(Get-AclProblems $ConfigFile)
    if ($problems.Count) { Fail ($problems -join '; ') }
    # The routing record and the SYSTEM resolver's TLD cache are never in the
    # installing user's profile (0.5.1 put both there; SYSTEM wrote the cache
    # and tnp acted on the record elevated).
    $record = Join-Path $ConfigDir 'dns-routing-install.json'
    if (-not (Test-Path -LiteralPath $record)) { Fail "no install routing record in $ConfigDir" }
    $problems = @(Get-AclProblems $record)
    if ($problems.Count) { Fail ($problems -join '; ') }
    Wait-Until "the SYSTEM resolver's TLD cache in its own profile" 30 { Test-Path -LiteralPath (Join-Path $SystemDataDir 'tlds.json') }
    foreach ($f in @('tlds.json', 'dns-routing-install.json')) {
        if (Test-Path -LiteralPath (Join-Path $UserDataDir $f)) { Fail "$f was written into the installing user's $UserDataDir" }
    }
    Pass "$ConfigDir and config.json: no access for Users, Everyone or Authenticated Users; routing record there, TLD cache in SYSTEM's profile, nothing in $UserDataDir"
    EndGroup

    # ── Kill switch ──────────────────────────────────────────────────────────
    # `tnp connect` runs its own resolver; the installed one holds port 53.
    Set-ListenPort 5354

    Group 'Kill switch refuses, leaving nothing, when a firewall profile is off'
    Set-NetFirewallProfile -Profile Public -Enabled False
    $code = Invoke-Tnp 'connect-refused' @('connect', '--killswitch') 120
    $output = Get-TnpOutput 'connect-refused'
    if ($code -eq 0) { Fail 'connect --killswitch ran with a firewall profile disabled' }
    if ($output -notmatch 'kill switch could not be applied') { Fail 'no refusal message' }
    if ($output -notmatch 'Windows Firewall profile is disabled') { Fail 'the refusal does not say a firewall profile is disabled' }
    if (Get-TnpFirewallRules) { Fail 'a refused kill switch left firewall rules' }
    if (Test-Path -LiteralPath $KillSwitchRecord) { Fail 'a refused kill switch left a record' }
    Set-NetFirewallProfile -All -Enabled True
    Pass 'refused with no firewall rules and no record'
    EndGroup

    Group 'Kill switch on: plain DNS to public resolvers blocked, loopback not'
    Start-Connect 'connect-1' @('--killswitch')
    Get-Content "$Log\connect-1.log" | Write-Host
    $rules = Get-TnpFirewallRules
    foreach ($ruleName in $FirewallRules) {
        $rule = @($rules | Where-Object { $_.DisplayName -eq $ruleName })
        if ($rule.Count -ne 1) { Fail "firewall rule ${ruleName}: found $($rule.Count)" }
        $r = $rule[0]
        if ($r.Direction -ne 'Outbound' -or $r.Action -ne 'Block' -or $r.Enabled -ne 'True') { Fail "$ruleName is $($r.Direction) $($r.Action) enabled=$($r.Enabled)" }
        $ports = $r | Get-NetFirewallPortFilter
        $addresses = @(($r | Get-NetFirewallAddressFilter).RemoteAddress)
        Write-Host "$ruleName $($ports.Protocol) port $($ports.RemotePort) -> $($addresses -join ', ')"
        if ($ports.RemotePort -ne '53') { Fail "$ruleName blocks port $($ports.RemotePort)" }
        if ($ruleName -like '*-v4') {
            if ($addresses -notcontains '0.0.0.0-126.255.255.255' -or $addresses -notcontains '128.0.0.0-255.255.255.255') { Fail "$ruleName does not cover all of IPv4 except 127/8" }
        } else {
            if (@($addresses | Where-Object { $_ -match ':' }).Count -lt 2) { Fail "$ruleName does not cover IPv6" }
        }
    }
    icacls $KillSwitchRecord | Write-Host
    $problems = @(Get-AclProblems $KillSwitchRecord)
    if ($problems.Count) { Fail ($problems -join '; ') }
    if (Test-PublicDns) { Fail 'plain UDP DNS to 1.1.1.1 still works with the kill switch on' }
    if (Test-PublicDns -Tcp) { Fail 'plain TCP DNS to 1.1.1.1 still works with the kill switch on' }
    nslookup -timeout=2 -retry=1 example.com 1.1.1.1 2>&1 | Out-String | Write-Host
    if ((Resolve-Via '127.0.0.1') -notcontains $Addr) { Fail 'loopback DNS (the installed resolver) is blocked' }
    $viaConnect = (nslookup -port=5354 $Name 127.0.0.1 2>&1 | Out-String)
    if ($viaConnect -notmatch [regex]::Escape($Addr)) { Write-Host $viaConnect; Fail 'loopback DNS (connect''s resolver on 5354) is blocked' }
    Pass 'four outbound block rules (UDP/TCP, IPv4/IPv6); DNS to 1.1.1.1 blocked; 127.0.0.1 answers'
    EndGroup

    Group 'Kill switch stays on when connect crashes (fail closed)'
    Stop-ConnectHard
    if (@(Get-TnpFirewallRules).Count -ne 4) { Fail 'the kill-switch rules vanished when connect crashed' }
    if (-not (Test-Path -LiteralPath $KillSwitchRecord)) { Fail 'the kill-switch record vanished when connect crashed' }
    if (Test-PublicDns) { Fail 'plain DNS to 1.1.1.1 works after a crash with the kill switch on' }
    Pass 'rules and record survive a crash; DNS to 1.1.1.1 still blocked'
    EndGroup

    Group 'The next connect removes the stale kill switch'
    Start-Connect 'connect-2' @()
    $output = Get-TnpOutput 'connect-2'
    Write-Host $output
    if ($output -notmatch 'found kill-switch rules from a previous session') { Fail 'connect did not notice the stale kill switch' }
    if ($output -notmatch 'kill switch off') { Fail 'connect did not remove the stale kill switch' }
    if (Get-TnpFirewallRules) { Fail 'stale kill-switch rules remain' }
    if (Test-Path -LiteralPath $KillSwitchRecord) { Fail 'the stale kill-switch record remains' }
    Wait-Until 'plain DNS to 1.1.1.1 to work again' 10 { Test-PublicDns }
    Stop-ConnectHard
    Pass 'stale rules and record removed; DNS to 1.1.1.1 works'
    EndGroup

    Group 'Kill switch on again, then a crash: uninstall must clear it'
    Start-Connect 'connect-3' @('--killswitch')
    Stop-ConnectHard
    if (@(Get-TnpFirewallRules).Count -ne 4) { Fail 'the kill-switch rules are not in place before uninstall' }
    if (Test-PublicDns) { Fail 'plain DNS to 1.1.1.1 works with the kill switch on' }
    Pass 'kill switch left on by a crash'
    EndGroup

    $resolverLog = Join-Path $SystemDataDir 'tnp-resolver.log'
    if (Test-Path -LiteralPath $resolverLog) { Copy-Item $resolverLog $Log }

    # ── Uninstall ────────────────────────────────────────────────────────────
    Group 'tnp uninstall --purge'
    $code = Invoke-Tnp 'uninstall' @('uninstall', '--purge')
    if ($code -ne 0) { Fail "tnp uninstall --purge exited $code" }
    EndGroup

    Group 'Nothing of TNP is left, and DNS is exactly as before'
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Fail "task $TaskName is still registered" }
    Wait-Until 'the resolver process to exit' 15 { -not (Get-CimInstance Win32_Process -Filter "Name='tnp.exe'" | Where-Object { $_.ExecutablePath -eq $Installed }) }
    if (Test-Path -LiteralPath $Installed) { Fail "$Installed is still there" }
    if (Test-Path -LiteralPath $ProgramDir) { Fail "$ProgramDir is still there" }
    if (@(Get-DnsClientNrptRule | Where-Object { $_.Comment -like '*TNP*' }).Count) { Fail 'TNP NRPT rules remain' }
    if ((Get-NrptRules) -ne $nrptBefore) { Fail "NRPT rules differ from before install:`n$(Get-NrptRules)" }
    if ((Get-AdapterDns) -ne $adapterDnsBefore) { Fail "adapter DNS differs from before install:`n$(Get-AdapterDns)" }
    if (Get-TnpFirewallRules) { Fail 'kill-switch firewall rules remain after uninstall' }
    Wait-Until 'plain DNS to 1.1.1.1 to work again' 10 { Test-PublicDns }
    if (Test-Path -LiteralPath $ConfigDir) { Fail "$ConfigDir is still there after --purge: $(Get-ChildItem -Force $ConfigDir)" }
    foreach ($dir in @($UserDataDir, $SystemDataDir)) {
        foreach ($f in @('identity.key', 'tlds.json', 'dns-routing-install.json', 'dns-routing-connect.json', 'tnp-resolver.log')) {
            if (Test-Path -LiteralPath (Join-Path $dir $f)) { Fail "$dir\$f is still there after --purge" }
        }
    }
    $code = Invoke-Tnp 'status-uninstalled' @('status')
    if ($code -eq 0) { Fail 'tnp status says the resolver runs after uninstall' }
    Pass 'task, binary, NRPT rule, firewall rules and files gone; NRPT and adapter DNS as before'
    EndGroup

    Write-Host 'Windows end-to-end: ALL PASS'
}
catch {
    Save-Diagnostics
    throw
}
finally {
    if ($script:Connect -and -not $script:Connect.HasExited) { Stop-Process -Id $script:Connect.Id -Force -ErrorAction SilentlyContinue }
    if ($script:Api -and -not $script:Api.HasExited) { Stop-Process -Id $script:Api.Id -Force -ErrorAction SilentlyContinue }
    if ($script:ProfilesBefore) {
        foreach ($p in $script:ProfilesBefore) {
            $state = if ($p.Enabled) { 'True' } else { 'False' }
            Set-NetFirewallProfile -Profile $p.Name -Enabled $state -ErrorAction SilentlyContinue
        }
    }
}
