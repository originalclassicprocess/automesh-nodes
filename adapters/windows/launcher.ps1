param([switch]$Background, [switch]$PrepareNetwork, [switch]$CheckReadiness, [switch]$ResetCertificate, [string]$WorkerConfig)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'secret-store.ps1')
$taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskWorker = $PrepareNetwork -or $CheckReadiness
$script:taskShowEvent = if (!$taskWorker) { New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::AutoReset, ('Local\AutomeshNodeShow-' + $taskSid)) } else { $null }
$taskMutex = New-Object Threading.Mutex($false, ('Local\AutomeshNodeLauncher-' + $taskSid))
$taskOwnMutex = $false
if (!$taskWorker) {
    try { $taskOwnMutex = $taskMutex.WaitOne(0, $false) }
    catch [Threading.AbandonedMutexException] { $taskOwnMutex = $true }
}
if (!$taskWorker -and !$taskOwnMutex) {
    [void]$script:taskShowEvent.Set(); $script:taskShowEvent.Dispose(); $taskMutex.Dispose()
    exit 0
}
$script:taskBase = Join-Path $env:LOCALAPPDATA 'AutomeshNode'
$script:taskConfigFile = Join-Path $script:taskBase 'config.json'
if ($WorkerConfig) {
    if (!$taskWorker -or ![IO.Path]::IsPathRooted($WorkerConfig)) { throw 'Worker configuration requires an absolute path and a worker operation' }
    $script:taskConfigFile = [IO.Path]::GetFullPath($WorkerConfig); $script:taskBase = [IO.Path]::GetDirectoryName($script:taskConfigFile)
}
$script:taskConfig = $null
$script:taskProcess = $null
$script:taskExiting = $false
$script:taskStopping = $false
$script:taskDesiredRunning = $false
$script:taskProgramRoot = $PSScriptRoot
try {
    if (!$CheckReadiness) {
        New-Item -ItemType Directory -Path $script:taskBase -Force | Out-Null
        Set-TaskPrivateDirectory $script:taskBase
    }
} catch {
    if (!$taskWorker) { [Windows.Forms.MessageBox]::Show('Не удалось подготовить защищённый каталог ноды. Проверьте права текущего пользователя Windows. Ключи и очередь не удалены.', 'Automesh Node — ошибка запуска', 'OK', 'Error') | Out-Null }
    if ($taskOwnMutex) { $taskMutex.ReleaseMutex() }; $taskMutex.Dispose()
    exit 1
}
function Task-RandomHex([int]$Bytes) {
    $taskBuffer = New-Object byte[] $Bytes
    $taskRng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $taskRng.GetBytes($taskBuffer) } finally { $taskRng.Dispose() }
    return ([BitConverter]::ToString($taskBuffer)).Replace('-', '').ToLowerInvariant()
}
function Task-WriteConfig($Value) {
    if ((Test-Path -LiteralPath $script:taskConfigFile) -and ((Get-Item -LiteralPath $script:taskConfigFile).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe configuration' }
    $taskSecrets = [Text.Encoding]::UTF8.GetBytes((@{ adminToken = $Value.adminToken; pfxPassword = $Value.pfxPassword } | ConvertTo-Json -Compress))
    try { $taskCipher = Protect-TaskSecret $taskSecrets 'automesh-node-config-v1' }
    finally { [Array]::Clear($taskSecrets, 0, $taskSecrets.Length) }
    $taskCheck = Unprotect-TaskSecret $taskCipher 'automesh-node-config-v1'
    [Array]::Clear($taskCheck, 0, $taskCheck.Length)
    $taskDisk = @{}
    foreach ($taskKey in $Value.Keys) { if ($taskKey -notin @('adminToken', 'pfxPassword', 'version')) { $taskDisk[$taskKey] = $Value[$taskKey] } }
    $taskDisk.version = 2
    $taskDisk.secrets = @{ version = 1; protection = 'windows-dpapi-current-user'; purpose = 'automesh-node-config-v1'; ciphertext = $taskCipher }
    # Exclusive creation of an unpredictable filename prevents following a
    # pre-existing config.json.new link during migration or subsequent saves.
    $taskTemporary = Join-Path ([IO.Path]::GetDirectoryName($script:taskConfigFile)) ('config-' + [Guid]::NewGuid().ToString('N') + '.new')
    $taskOutput = New-Object IO.FileStream($taskTemporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $taskEncoded = (New-Object Text.UTF8Encoding($false)).GetBytes(($taskDisk | ConvertTo-Json -Depth 5))
        $taskOutput.Write($taskEncoded, 0, $taskEncoded.Length); $taskOutput.Flush($true)
    } finally { $taskOutput.Dispose() }
    # Windows PowerShell 5.1 coerces $null to an empty string for this overload.
    # Pass an actual null string: otherwise every save after the first fails.
    if (Test-Path -LiteralPath $script:taskConfigFile) { [IO.File]::Replace($taskTemporary, $script:taskConfigFile, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($taskTemporary, $script:taskConfigFile) }
    $script:taskConfig = $Value
}
function Task-ReadConfig {
    if ((Get-Item -LiteralPath $script:taskConfigFile).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe configuration' }
    $taskRaw = Get-Content -LiteralPath $script:taskConfigFile -Raw | ConvertFrom-Json
    $taskValue = @{}
    foreach ($taskProperty in $taskRaw.PSObject.Properties) { if ($taskProperty.Name -notin @('secrets', 'version')) { $taskValue[$taskProperty.Name] = $taskProperty.Value } }
    if ($taskRaw.version -eq 2) {
        if ($taskValue.ContainsKey('adminToken') -or $taskValue.ContainsKey('pfxPassword') -or $taskRaw.secrets.protection -ne 'windows-dpapi-current-user' -or $taskRaw.secrets.purpose -ne 'automesh-node-config-v1' -or $taskRaw.secrets.version -ne 1) { throw 'Invalid protected configuration' }
        $taskBytes = Unprotect-TaskSecret $taskRaw.secrets.ciphertext 'automesh-node-config-v1'
        try { $taskPrivate = [Text.Encoding]::UTF8.GetString($taskBytes) | ConvertFrom-Json }
        finally { [Array]::Clear($taskBytes, 0, $taskBytes.Length) }
        $taskValue.adminToken = $taskPrivate.adminToken; $taskValue.pfxPassword = $taskPrivate.pfxPassword
    } elseif ($taskRaw.version -ne 1) { throw 'Unsupported configuration' }
    if ($taskValue.adminToken -notmatch '^[a-f0-9]{64}$' -or !$taskValue.pfxPassword) { throw 'Invalid node secrets' }
    $taskValue.version = 1
    if ($taskRaw.version -eq 1) { Task-WriteConfig $taskValue }
    return $taskValue
}
function Task-Control([string]$Path, [string]$Method = 'GET', $Body = $null) {
    if (!$script:taskConfig) { throw 'Not configured' }
    $taskRequest = [Net.HttpWebRequest]::Create(('http://127.0.0.1:' + $script:taskConfig.controlPort + $Path))
    $taskRequest.Proxy = $null
    $taskRequest.Method = $Method
    $taskRequest.Timeout = if ($Path -eq '/members/remove') { 15000 } else { 1500 }
    $taskRequest.Headers['Authorization'] = 'Bearer ' + $script:taskConfig.adminToken
    if ($Method -eq 'POST') {
        if ($null -eq $Body) { $taskRequest.ContentLength = 0 }
        else {
            $taskPayload = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress))
            $taskRequest.ContentType = 'application/json'; $taskRequest.ContentLength = $taskPayload.Length
            $taskStream = $taskRequest.GetRequestStream()
            try { $taskStream.Write($taskPayload, 0, $taskPayload.Length) } finally { $taskStream.Dispose() }
        }
    }
    $taskResponse = $taskRequest.GetResponse()
    try {
        $taskReader = New-Object IO.StreamReader($taskResponse.GetResponseStream())
        try { return ($taskReader.ReadToEnd() | ConvertFrom-Json) } finally { $taskReader.Dispose() }
    } finally { $taskResponse.Close() }
}
function Task-StartBackend {
    if (!$script:taskConfig) { $taskStatus.Text = 'Выберите сеть и сохраните настройки.'; return }
    $taskExisting = $false
    try { Task-Control '/status' | Out-Null; $taskExisting = $true } catch { }
    if ($taskExisting) {
        # The previous launcher may have crashed. Restart that authenticated
        # backend gracefully so renewed TLS/settings really take effect.
        $script:taskAdoptedRunning = $true; $taskWanted = $script:taskDesiredRunning; $taskSetupWanted = $script:taskSetupPrompt
        Task-Stop; $script:taskDesiredRunning = $taskWanted; $script:taskRestartPending = $taskWanted
        $script:taskSetupPrompt = $taskSetupWanted
        return
    }
    if ($script:taskProcess -and !$script:taskProcess.HasExited) { return }
    if ($script:taskProcess) { $script:taskProcess.Dispose(); $script:taskProcess = $null }
    # Detect interrupted program updates before executing the bundled backend.
    # This is integrity checking, NOT publisher authentication / Authenticode.
    $taskBuildPath = Join-Path $script:taskProgramRoot 'node-build.json'
    $taskBuildItem = Get-Item -LiteralPath $taskBuildPath
    if ($taskBuildItem.Length -gt 32768 -or ($taskBuildItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid installed manifest' }
    $taskBuild = Get-Content -LiteralPath $taskBuildPath -Raw | ConvertFrom-Json
    $taskRequired = @('node.exe','node.cjs','launch.vbs','launcher.ps1','node-ui.ps1','setup.ps1','secret-store.ps1','firewall.ps1','uninstall.vbs','uninstall.ps1','LICENSE-Node.txt','LICENSE-ws.txt','LICENSE-qrcode.txt','LICENSE-pngjs.txt','LICENSE-dijkstrajs.txt','LICENSE-Automesh.txt','THIRD-PARTY-NOTICES.txt')
    if (@($taskBuild.files.PSObject.Properties).Count -ne $taskRequired.Count) { throw 'Incomplete installed manifest' }
    foreach ($taskName in $taskRequired) {
        $taskProgram = Join-Path $script:taskProgramRoot $taskName; $taskItem = Get-Item -LiteralPath $taskProgram; $taskExpected = $taskBuild.files.$taskName
        if ($taskItem.PSIsContainer -or ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $taskItem.Length -ne $taskExpected.bytes -or $taskExpected.sha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $taskProgram -Algorithm SHA256).Hash.ToLowerInvariant() -cne $taskExpected.sha256) { throw 'Installed package verification failed' }
    }
    $taskStartInfo = New-Object Diagnostics.ProcessStartInfo
    $taskStartInfo.FileName = Join-Path $script:taskProgramRoot 'node.exe'
    $taskStartInfo.Arguments = '"' + (Join-Path $script:taskProgramRoot 'node.cjs') + '" "' + $script:taskConfigFile + '"'
    $taskStartInfo.WorkingDirectory = $script:taskProgramRoot
    $taskStartInfo.UseShellExecute = $false; $taskStartInfo.CreateNoWindow = $true; $taskStartInfo.RedirectStandardError = $true
    $script:taskProcess = [Diagnostics.Process]::Start($taskStartInfo)
    $script:taskStartError = ''
    $script:taskStopping = $false
    $taskStatus.Text = 'Запускаем узел…'
}
function Task-StartError {
    if (!$script:taskProcess -or !$script:taskProcess.HasExited) { return '' }
    if (!$script:taskStartError) {
        $taskErrorText = $script:taskProcess.StandardError.ReadToEnd()
        # Backend emits only sanitized reasons; never display raw stderr/logs.
        $taskMatch = [regex]::Match($taskErrorText, '\((invalid_node_config_or_lan_changed|invalid_node_primary_address|invalid_node_origins|EADDRINUSE|EACCES|EPERM|ENOENT|node_secret_protection_unavailable|node_secret_protection_failed|invalid_node_secret|mailbox_disk_limit|corrupt_node_state|corrupt_mailbox|startup_failed)\)')
        $script:taskStartError = if ($taskMatch.Success) { $taskMatch.Groups[1].Value } else { 'startup_failed' }
    }
    return $script:taskStartError
}
function Task-Stop {
    $script:taskDesiredRunning = $false
    $script:taskSetupPrompt = $false
    $script:taskStopping = $true
    $script:taskNetworkWarning = ''
    if (!$script:taskProcess -and $script:taskConfig) { $script:taskAdoptedRunning = $true }
    if ($script:taskConfig -and !$script:taskShutdownTarget) {
        $script:taskShutdownTarget = @{ port = $script:taskConfig.controlPort; token = $script:taskConfig.adminToken }
        $script:taskShutdownNext = Get-Date
    }
    if ($script:taskAdoptedRunning) {
        # An already running backend may have survived a launcher crash. Poll
        # its OLD control endpoint asynchronously before restarting or exiting.
        $script:taskStopControl = @{ port = $script:taskConfig.controlPort; token = $script:taskConfig.adminToken }
    }
    # Allow pending atomic writes to finish. Never kill a backend after an
    # arbitrary three seconds while it may still be committing its queue.
    $taskStatus.Text = 'Останавливаем ноду. Сохранённая очередь остаётся на диске…'
}
function Task-Certificates([string[]]$Addresses) {
    $taskCa = $null; $taskLeaf = $null
    try {
        if ($script:taskConfig.caThumbprint) {
            if ($script:taskConfig.caThumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'invalid_ca_reference' }
            try { $taskCa = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $script:taskConfig.caThumbprint) -ErrorAction Stop }
            catch { throw 'local_ca_unavailable' }
            if (!$taskCa.HasPrivateKey -or $taskCa.NotAfter -lt (Get-Date).AddDays(15)) { throw 'local_ca_unavailable' }
            if (!(Test-Path -LiteralPath (Task-CaFile))) { throw 'local_ca_mismatch' }
            $taskStoredCa = New-Object Security.Cryptography.X509Certificates.X509Certificate2((Task-CaFile))
            try { if ($taskStoredCa.Thumbprint -ne $taskCa.Thumbprint) { throw 'local_ca_mismatch' } } finally { $taskStoredCa.Dispose() }
        } else {
            # Keep the non-exportable signing key in this user's Windows key
            # store so DHCP changes do not replace the trusted root. Constrain
            # certificates to localhost and RFC1918/loopback IPs, server auth,
            # with no subordinate CA. Never install trust automatically.
            $taskConstraints = '303fa03d300b82096c6f63616c686f7374300a87087f000000ff000000300a87080a000000ff000000300a8708ac100000fff00000300a8708c0a80000ffff0000'
            $taskCa = New-SelfSignedCertificate -Type Custom -Subject ('CN=Automesh Node Local CA ' + (Task-RandomHex 6)) -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={critical}{text}ca=true&pathlength=0', '2.5.29.37={text}1.3.6.1.5.5.7.3.1', ('2.5.29.30={critical}{hex}' + $taskConstraints)) -NotAfter (Get-Date).AddYears(5)
        }
        $taskSan = '2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1'
        foreach ($taskAddress in $Addresses) { $taskSan += '&IPAddress=' + $taskAddress }
        $taskLeafExpires = (Get-Date).AddMonths(6)
        if ($taskLeafExpires -ge $taskCa.NotAfter) { $taskLeafExpires = $taskCa.NotAfter.AddDays(-1) }
        $taskLeaf = New-SelfSignedCertificate -Type Custom -Subject 'CN=Automesh Node' -Signer $taskCa -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -TextExtension @('2.5.29.19={critical}{text}ca=false', '2.5.29.37={text}1.3.6.1.5.5.7.3.1', $taskSan) -NotAfter $taskLeafExpires
        $taskPassword = Task-RandomHex 32
        # Never overwrite the working certificate before config has committed.
        $taskCertificateId = Task-RandomHex 8
        $taskPfx = Join-Path $script:taskBase ('node-' + $taskCertificateId + '.pfx')
        $taskCaFile = Join-Path $script:taskBase ('node-ca-' + $taskCertificateId + '.cer')
        Export-PfxCertificate -Cert $taskLeaf -FilePath $taskPfx -Password (ConvertTo-SecureString $taskPassword -AsPlainText -Force) | Out-Null
        Export-Certificate -Cert $taskCa -FilePath $taskCaFile | Out-Null
        return @{ File = $taskPfx; Password = $taskPassword; CaFile = $taskCaFile; CaThumbprint = $taskCa.Thumbprint; Expires = $taskLeaf.NotAfter.ToUniversalTime().ToString('o') }
    } finally {
        if ($taskLeaf) { Remove-Item -LiteralPath ('Cert:\CurrentUser\My\' + $taskLeaf.Thumbprint) -DeleteKey }
    }
}
function Task-PrivateAddress([string]$Address) {
    $taskIp = $null
    if (![Net.IPAddress]::TryParse($Address, [ref]$taskIp) -or $taskIp.AddressFamily -ne 'InterNetwork') { return $false }
    return $Address -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'
}
function Task-NetworkAddresses {
    # Only Windows networks explicitly marked Private. Public Wi-Fi and
    # unclassified adapters do not become listeners after an automatic scan.
    $taskPrivateIndexes = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object NetworkCategory -eq 'Private' | ForEach-Object InterfaceIndex)
    $taskUpIndexes = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up' | ForEach-Object ifIndex)
    return @(Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue | Where-Object {
        !$_.SkipAsSource -and $taskPrivateIndexes -contains $_.InterfaceIndex -and $taskUpIndexes -contains $_.InterfaceIndex -and (Task-PrivateAddress $_.IPAddress)
    } | Sort-Object InterfaceIndex, IPAddress | Select-Object -First 16)
}
function Task-SyncNetwork {
    $taskNext = @{}; foreach ($taskKey in $script:taskConfig.Keys) { $taskNext[$taskKey] = $script:taskConfig[$taskKey] }
    # A stable IP/leaf expiry does not prove the signer still exists. Do not
    # report preparation success for a broken local trust identity.
    if ($taskNext.caThumbprint -and !(Task-InspectCa $taskNext).valid) { throw 'local_ca_unavailable' }
    # Inner @() is unwrapped by if. Capture the entire pipeline so [0] on a
    # single adapter selects the full address, not the first character.
    $taskAddresses = @(if ($taskNext.networkMode -eq 'automatic') { Task-NetworkAddresses | ForEach-Object IPAddress | Select-Object -Unique }
        elseif (Task-AddressIsLocal $taskNext.lanAddress) { $taskNext.lanAddress } else { throw 'manual_address_unavailable' })
    $taskPrimary = if ($taskAddresses -contains $taskNext.lanAddress) { $taskNext.lanAddress } elseif ($taskAddresses.Count) { $taskAddresses[0] } else { '' }
    $taskOldAddresses = if ($null -ne $taskNext.lanAddresses) { @($taskNext.lanAddresses) } else { @($taskNext.lanAddress) }
    $taskChanged = ($taskOldAddresses -join ',') -ne ($taskAddresses -join ',')
    $taskRenew = !$taskNext.caThumbprint -or !(Test-Path -LiteralPath $taskNext.pfxFile) -or !$taskNext.certificateExpires -or ([DateTime]::Parse($taskNext.certificateExpires).ToUniversalTime() -lt [DateTime]::UtcNow.AddDays(14))
    if (!$taskChanged -and !$taskRenew) {
        # Repair only a truncated primary; keep the already correct TLS leaf.
        if ($taskNext.lanAddress -cne $taskPrimary) { $taskNext.lanAddress = $taskPrimary; Task-WriteConfig $taskNext }
        return
    }
    $taskCertificate = Task-Certificates $taskAddresses
    $taskNext.lanAddresses = @($taskAddresses)
    $taskNext.lanAddress = $taskPrimary
    $taskNext.pfxFile = $taskCertificate.File; $taskNext.pfxPassword = $taskCertificate.Password
    $taskNext.caFile = $taskCertificate.CaFile; $taskNext.caThumbprint = $taskCertificate.CaThumbprint; $taskNext.certificateExpires = $taskCertificate.Expires
    Task-WriteConfig $taskNext
}
function Task-AddressIsLocal([string]$Address) {
    foreach ($taskInterface in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($taskInterface.OperationalStatus -ne 'Up') { continue }
        foreach ($taskUnicast in $taskInterface.GetIPProperties().UnicastAddresses) {
            if ($taskUnicast.Address.ToString() -eq $Address) { return $true }
        }
    }
    return $false
}
function Task-CaFile {
    if ($script:taskConfig -and $script:taskConfig.caFile) { return $script:taskConfig.caFile }
    return (Join-Path $script:taskBase 'node-ca.cer')
}
function Task-Autostart([bool]$Enabled) {
    $taskRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if ($Enabled) {
        New-Item -Path $taskRunKey -Force | Out-Null
        Set-ItemProperty -Path $taskRunKey -Name 'AutomeshNode' -Value ('"' + (Join-Path $env:WINDIR 'System32\wscript.exe') + '" "' + (Join-Path $script:taskProgramRoot 'launch.vbs') + '" --background')
    } else { Remove-ItemProperty -Path $taskRunKey -Name 'AutomeshNode' -ErrorAction SilentlyContinue }
}
. (Join-Path $script:taskProgramRoot 'setup.ps1')
if ($CheckReadiness) {
    try { $script:taskConfig = Task-ReadConfig; Task-ReadinessFacts | ConvertTo-Json -Compress; exit 0 }
    catch { Write-Output '{"error":"readiness_failed"}'; exit 1 }
}
if ($PrepareNetwork) {
    try {
        $script:taskConfig = Task-ReadConfig
        # Recovery is explicit. Never overwrite working settings before new
        # certificate generation/export succeeds; retain queue and identity.
        if ($ResetCertificate) { $script:taskConfig.Remove('caThumbprint'); $script:taskConfig.Remove('certificateExpires') }
        Task-SyncNetwork; Write-Output '{"prepared":true}'; exit 0
    } catch {
        $taskSafe = @('local_ca_unavailable','local_ca_mismatch','invalid_ca_reference','manual_address_unavailable','Invalid protected configuration','Invalid node secrets','Unsupported configuration')
        $taskReason = if ($_.Exception.Message -cin $taskSafe) { $_.Exception.Message } else { 'preparation_failed' }
        @{ error=$taskReason } | ConvertTo-Json -Compress; exit 1
    }
}
try { . (Join-Path $PSScriptRoot 'node-ui.ps1') }
catch { [Windows.Forms.MessageBox]::Show('Не удалось открыть интерфейс ноды. Установите актуальную сборку поверх существующей, не удаляя данные. Ключи и очередь не удалены.', 'Automesh Node — ошибка запуска', 'OK', 'Error') | Out-Null }
finally { $script:taskShowEvent.Dispose(); if ($taskOwnMutex) { $taskMutex.ReleaseMutex() }; $taskMutex.Dispose() }
