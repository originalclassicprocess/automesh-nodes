param([Parameter(Mandatory=$true)][string]$NodeExe, [string]$LanAddress, [switch]$Automatic, [Parameter(Mandatory=$true)][int]$Port)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
    $taskExpected = Join-Path $env:LOCALAPPDATA 'Programs\AutomeshNode\node.exe'
    if ([IO.Path]::GetFullPath($NodeExe) -ne [IO.Path]::GetFullPath($taskExpected) -or !(Test-Path -LiteralPath $taskExpected) -or $Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid node executable/port' }
    $taskScope = @{}
    if ($Automatic) {
        # Private profile + LocalSubnet + exact executable/port survive DHCP.
        # Never open Public/Domain profiles or router/Internet access.
        $taskScope.LocalAddress = 'Any'
    } else {
        $taskInterface = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $LanAddress -ErrorAction Stop
        if ((Get-NetConnectionProfile -InterfaceIndex $taskInterface.InterfaceIndex).NetworkCategory -ne 'Private') { throw 'Use a trusted Private network' }
        $taskScope.LocalAddress = $LanAddress; $taskScope.InterfaceAlias = $taskInterface.InterfaceAlias
    }
    $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $taskRuleName = 'AutomeshNodeLAN-' + $taskSid
    $taskExisting = Get-NetFirewallRule -Name $taskRuleName -ErrorAction SilentlyContinue
    if ($taskExisting) {
        Set-NetFirewallRule -Name $taskRuleName -Enabled True -Direction Inbound -Action Allow -Profile Private -InterfaceAlias $(if ($Automatic) { 'Any' } else { $taskInterface.InterfaceAlias }) -Protocol TCP -LocalAddress $taskScope.LocalAddress -LocalPort $Port -RemoteAddress LocalSubnet -Program $taskExpected | Out-Null
    } else {
        New-NetFirewallRule -Name $taskRuleName -DisplayName 'Automesh Node LAN' -Direction Inbound -Action Allow -Profile Private -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Program $taskExpected @taskScope | Out-Null
    }
    [System.Windows.Forms.MessageBox]::Show('Доступ разрешён только в Частных сетях Windows, из локальной подсети, для этой ноды и порта. В автоматическом режиме смена IP не требует повторной настройки.', 'Automesh Node', 'OK', 'Information') | Out-Null
} catch {
    [System.Windows.Forms.MessageBox]::Show('LAN access could not be enabled. Use a trusted network with the Private profile. No Public-network access is added.', 'Automesh Node', 'OK', 'Error') | Out-Null
    exit 1
}
