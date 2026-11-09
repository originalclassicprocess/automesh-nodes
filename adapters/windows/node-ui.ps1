$taskDeployment = (& (Join-Path $script:taskProgramRoot 'node.exe') (Join-Path $script:taskProgramRoot 'node.cjs') '--deployment-defaults') | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$taskDeployment.appOrigin -or !$taskDeployment.signalingUrl) { throw 'Deployment defaults unavailable' }
$taskForm = New-Object Windows.Forms.Form
$taskForm.Text = 'Automesh Node — домашняя нода'
$taskForm.ClientSize = New-Object Drawing.Size(780, 740)
$taskForm.MinimumSize = New-Object Drawing.Size(720, 620)
$taskForm.StartPosition = 'CenterScreen'
$taskForm.Font = New-Object Drawing.Font('Segoe UI', 10)
$taskForm.AutoScaleMode = 'Dpi'
$taskTabs = New-Object Windows.Forms.TabControl
$taskTabs.Dock = 'Fill'; $taskForm.Controls.Add($taskTabs)
$taskFooter = New-Object Windows.Forms.FlowLayoutPanel
$taskFooter.Dock = 'Bottom'; $taskFooter.Height = 62
$taskFooter.Padding = New-Object Windows.Forms.Padding(10)
$taskForm.Controls.Add($taskFooter)
function Task-Tab([string]$Name) {
    $taskPage = New-Object Windows.Forms.TabPage
    $taskPage.Text = $Name
    $taskPanel = New-Object Windows.Forms.FlowLayoutPanel
    $taskPanel.Dock = 'Fill'; $taskPanel.AutoScroll = $true
    $taskPanel.FlowDirection = 'TopDown'; $taskPanel.WrapContents = $false
    $taskPanel.Padding = New-Object Windows.Forms.Padding(16)
    $taskPage.Controls.Add($taskPanel); [void]$taskTabs.TabPages.Add($taskPage)
    return $taskPanel
}
function Task-Text($Parent, [string]$Text) {
    $taskLabel = New-Object Windows.Forms.Label
    $taskLabel.Text = $Text; $taskLabel.AutoSize = $true
    $taskLabel.MaximumSize = New-Object Drawing.Size(690, 0)
    $taskLabel.Margin = New-Object Windows.Forms.Padding(0, 8, 0, 8)
    $Parent.Controls.Add($taskLabel); return $taskLabel
}
function Task-Input($Parent, [string]$Text = '', [bool]$ReadOnly = $false) {
    $taskInput = New-Object Windows.Forms.TextBox
    $taskInput.Text = $Text; $taskInput.ReadOnly = $ReadOnly
    $taskInput.Width = 680; $taskInput.Tag = 'wide'; $Parent.Controls.Add($taskInput)
    return $taskInput
}
function Task-Check($Parent, [string]$Text, [bool]$Checked) {
    $taskCheck = New-Object Windows.Forms.CheckBox
    $taskCheck.Text = $Text; $taskCheck.Checked = $Checked
    $taskCheck.AutoSize = $true; $Parent.Controls.Add($taskCheck); return $taskCheck
}
function Task-Action($Parent, [string]$Text, [scriptblock]$Action) {
    $taskButton = New-Object Windows.Forms.Button
    $taskButton.Text = $Text; $taskButton.AutoSize = $true
    $taskButton.Padding = New-Object Windows.Forms.Padding(8, 3, 8, 3)
    $taskButton.Add_Click($Action); $Parent.Controls.Add($taskButton); return $taskButton
}
function Task-Number($Parent, [int]$Minimum, [int]$Maximum, [int]$Value) {
    $taskNumber = New-Object Windows.Forms.NumericUpDown
    $taskNumber.Minimum = $Minimum; $taskNumber.Maximum = $Maximum; $taskNumber.Value = $Value
    $taskNumber.Width = 160; $Parent.Controls.Add($taskNumber); return $taskNumber
}
function Task-Advanced($Parent) {
    $taskExtra = New-Object Windows.Forms.FlowLayoutPanel
    $taskExtra.AutoSize = $true; $taskExtra.FlowDirection = 'TopDown'; $taskExtra.WrapContents = $false
    $taskExtra.Visible = $false
    $taskToggle = New-Object Windows.Forms.CheckBox
    $taskToggle.Text = 'Профессиональные параметры'; $taskToggle.AutoSize = $true
    $taskToggle.Add_CheckedChanged({ $taskExtra.Visible = $taskToggle.Checked }.GetNewClosure())
    $Parent.Controls.Add($taskToggle); $Parent.Controls.Add($taskExtra); return $taskExtra
}
$taskDashboard = Task-Tab 'Обзор'
$taskOutgoing = Task-Tab 'Доставка'
$taskIncoming = Task-Tab 'Подключить устройства'
$taskLan = Task-Tab 'Сеть и доступ'
$taskStatus = Task-Text $taskDashboard 'Нажмите «Запустить». Домашние сети определятся автоматически.'
$taskStatus.Font = New-Object Drawing.Font('Segoe UI', 14, [Drawing.FontStyle]::Bold)
$taskLocalEndpoint = Task-Input $taskDashboard 'https://localhost:3003/' $true
Task-Text $taskDashboard 'На этом компьютере используйте localhost — этот адрес не меняется при смене Wi-Fi. Телефону нужен адрес из раздела «Подключить устройства».' | Out-Null
Task-Action $taskDashboard 'Подключить приложение на этом ПК' { if (Task-TrustLocal) { Task-ShowQr 'pair-local' } } | Out-Null
Task-Action $taskDashboard 'Подключить телефон или другой компьютер' { Task-ShowSetup } | Out-Null
$taskOutSummary = Task-Text $taskDashboard 'Исходящие: ещё не проверены.'
$taskInSummary = Task-Text $taskDashboard 'Входящие: ящики в LAN. Интернет-приём пока недоступен.'
$taskLanSummary = Task-Text $taskDashboard 'LAN-сигналинг: ещё не проверен.'
$taskLanHealth = Task-Text $taskDashboard 'Доступ с телефонов: выполните «Проверить LAN» во вкладке LAN-сигналинг.'
$taskMembers = Task-Text $taskDashboard 'Привязанные адреса: ещё не проверены.'
$taskAuto = Task-Check $taskDashboard 'Запускать в фоне после входа в Windows' $true
Task-Text $taskDashboard 'ПК должен быть включён и не спать. До входа в Windows автозапуск не работает. Закрытие окна скрывает ноду в трей.' | Out-Null

$taskCourier = Task-Check $taskOutgoing 'Отправлять зашифрованные сообщения в интернет' $true
Task-Text $taskOutgoing 'LAN-доставка работает при включённом LAN-сигналинге даже без интернета. Галочка выше добавляет интернет-маршрут. Получатель должен разблокировать приложение и подключиться к тому же LAN- или интернет-серверу. Порты роутера открывать не нужно.' | Out-Null
Task-Text $taskOutgoing 'Интернет-сервер подключения (тот же сервер у получателей)' | Out-Null
$taskRelay = Task-Input $taskOutgoing $taskDeployment.signalingUrl
$taskCourierAddress = Task-Input $taskOutgoing '' $true
Task-Text $taskOutgoing 'Адрес выше принадлежит пересыльщику, а не профилю автора. Статус «на ноде» означает сохранение, не прочтение получателем.' | Out-Null
$taskOutAdvanced = Task-Advanced $taskOutgoing
Task-Text $taskOutAdvanced 'Общий объём всех очередей, МБ (работает)' | Out-Null
$taskLimit = Task-Number $taskOutAdvanced 1 512 64
Task-Text $taskOutAdvanced 'Максимум конвертов в каждой очереди (работает; общий объём ограничен отдельно)' | Out-Null
$taskMessageLimit = Task-Number $taskOutAdvanced 1 5000 1000
Task-Text $taskOutAdvanced 'Дополнительно фиксированы квоты одного отправителя: до 100 ожидающих конвертов и 4 МБ. С квитанциями каждая очередь содержит не более двойного лимита записей.' | Out-Null
Task-Text $taskOutAdvanced 'Срок конверта — до 7 дней, задаётся подписанным сообщением клиента. Изменить срок на ноде нельзя.' | Out-Null
Task-Text $taskOutAdvanced 'Размер файла согласуется с клиентом; до 16 незавершённых загрузок на ноде. Их полный дисковый бюджет резервируется заранее из общего лимита, включая части и служебные данные. Частично загруженный файл ещё не считается сохранённым для доставки.' | Out-Null
Task-Text $taskOutAdvanced 'Транспорт: прямой WSS. Прокси, Tor, I2P и собственный DNS пока недоступны. Установленный системный VPN управляется вне Automesh; нода не обещает запрет обхода VPN.' | Out-Null

Task-Text $taskIncoming 'Входящие ящики в домашней сети — работают. Отдельный интернет-приёмник — следующий этап, сейчас не включён.' | Out-Null
Task-Text $taskIncoming 'У каждого привязанного профиля свой ящик и список разрешённых отправителей. Подключайте профили из приложения; управление требует подписи профиля и одноразового кода.' | Out-Null
$taskEndpoint = Task-Input $taskIncoming '' $true
Task-Action $taskIncoming 'QR привязки профиля…' { Task-ShowQr 'pair' } | Out-Null
$taskCode = Task-Input $taskIncoming '' $true
Task-Action $taskIncoming 'Создать новый одноразовый код' {
    try { $taskInvitation = Task-Control '/pair-code' 'POST'; $taskCode.Text = $taskInvitation.pairCode }
    catch { $taskStatus.Text = 'Сначала запустите ноду.' }
} | Out-Null
Task-Text $taskIncoming 'QR привязки содержит секретный код на 10 минут. Показывайте только своим устройствам; каждая успешная привязка погашает код.' | Out-Null
$taskInboxMembers = Task-Text $taskIncoming 'Статистика ящиков появится после запуска.'
Task-Text $taskIncoming 'Привязанные профили — выберите адрес, чтобы освободить место.' | Out-Null
$taskMemberList = New-Object Windows.Forms.ComboBox
$taskMemberList.DropDownStyle = 'DropDownList'; $taskMemberList.Width = 680; $taskMemberList.Tag = 'wide'
$taskIncoming.Controls.Add($taskMemberList)
$taskRemoveMember = Task-Action $taskIncoming 'Отключить выбранный профиль…' {
    if ($taskMemberList.SelectedIndex -lt 0 -or !$script:taskMemberAddresses) { return }
    $taskSelectedAddress = $script:taskMemberAddresses[$taskMemberList.SelectedIndex]
    if ([Windows.Forms.MessageBox]::Show(('Отключить профиль ' + $taskSelectedAddress + "?`n`nДоступ к ноде будет отозван. Входящие, исходящие и файлы этого профиля в очередях ноды будут удалены, доставка остановится. Аккаунт и чаты на устройствах останутся. Уже доставленные копии удалить нельзя.`n`nПосле этого можно привязать другой профиль."), 'Отключить профиль', 'YesNo', 'Warning') -ne 'Yes') { return }
    try {
        Task-Control '/members/remove' 'POST' @{ address = $taskSelectedAddress; confirm = 'remove-node-data' } | Out-Null
        $taskStatus.Text = 'Профиль отключён. Место освобождено; для новой привязки создайте одноразовый код.'
        $taskMemberList.Items.Clear(); $script:taskMemberAddresses = @(); $taskRemoveMember.Enabled = $false
    } catch { $taskStatus.Text = 'Не удалось завершить отключение. Обновите статус и повторите; при перезапуске нода завершит начатую очистку.' }
}
$taskRemoveMember.Enabled = $false
function Task-UpdateMembers($Current) {
    $taskSelected = if ($taskMemberList.SelectedIndex -ge 0 -and $script:taskMemberAddresses) { $script:taskMemberAddresses[$taskMemberList.SelectedIndex] } else { '' }
    $taskAddresses = @($Current.members | ForEach-Object { $_.address })
    if (($taskAddresses -join ',') -ne ($script:taskMemberAddresses -join ',')) {
        $taskMemberList.Items.Clear(); $script:taskMemberAddresses = $taskAddresses
        foreach ($taskAddress in $taskAddresses) { [void]$taskMemberList.Items.Add($taskAddress) }
        $taskMemberList.SelectedIndex = [Array]::IndexOf($taskAddresses, $taskSelected)
    }
    $taskRemoveMember.Enabled = [bool]$Current.memberManagement -and $taskAddresses.Count -gt 0
}
$taskInAdvanced = Task-Advanced $taskIncoming
Task-Text $taskInAdvanced 'Лимит привязок: 8 адресов. Разрешённых отправителей: до 50 на профиль. Эти ограничения пока фиксированы.' | Out-Null
Task-Text $taskInAdvanced 'Ящики используют общий лимит диска из вкладки Исходящие. Содержимое писем уже зашифровано получателю; адреса и служебные метаданные очереди не скрыты шифрованием диска ноды.' | Out-Null
Task-Text $taskInAdvanced 'Интернет-приём, отдельный адрес приёмника, ротация адреса и перенаправление между профилями пока не реализованы.' | Out-Null

Task-Text $taskLan 'HTTPS-адрес приложения, которому разрешён доступ к ноде' | Out-Null
$taskAppOrigin = Task-Input $taskLan $taskDeployment.appOrigin
$taskNetworkAuto = Task-Check $taskLan 'Автоматически использовать домашние сети Windows (Частные)' $true
Task-Text $taskLan 'Wi-Fi и Ethernet работают одновременно с одной очередью. Публичные и неопределённые сети не включаются. Ручной выбор ниже нужен только для особой настройки.' | Out-Null
$taskNetwork = New-Object Windows.Forms.ComboBox
$taskNetwork.DropDownStyle = 'DropDownList'; $taskNetwork.Width = 680; $taskNetwork.Tag = 'wide'
$taskLan.Controls.Add($taskNetwork)
Task-Text $taskLan 'Предпочитаемый адрес для QR. В автоматическом режиме остальные Частные сети тоже работают; если адрес исчезнет, выберем другой.' | Out-Null
function Task-RefreshNetworks {
    $taskPrevious = if ($taskNetwork.SelectedIndex -ge 0) { $script:taskAddresses[$taskNetwork.SelectedIndex].IPAddress } elseif ($script:taskConfig) { $script:taskConfig.lanAddress } else { '' }
    $taskProfiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)
    $script:taskAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { !$_.SkipAsSource -and ($_.IPAddress -match '^10\.' -or $_.IPAddress -match '^192\.168\.' -or $_.IPAddress -match '^172\.(1[6-9]|2[0-9]|3[01])\.') } | Sort-Object @{ Expression = { $taskProfile = $taskProfiles | Where-Object InterfaceIndex -eq $_.InterfaceIndex | Select-Object -First 1; if ($taskProfile.NetworkCategory -eq 'Private') { 0 } else { 1 } } }, InterfaceIndex, IPAddress)
    $taskNetwork.Items.Clear()
    foreach ($taskAddress in $script:taskAddresses) {
        $taskProfile = $taskProfiles | Where-Object InterfaceIndex -eq $taskAddress.InterfaceIndex | Select-Object -First 1
        $taskCategory = if ($taskProfile.NetworkCategory -eq 'Private') { 'Частная' } else { 'не Частная — проверьте сеть/VPN' }
        [void]$taskNetwork.Items.Add(($taskAddress.IPAddress + ' — ' + $taskAddress.InterfaceAlias + ' · ' + $taskCategory))
    }
    for ($taskIndex = 0; $taskIndex -lt $script:taskAddresses.Count; $taskIndex++) { if ($script:taskAddresses[$taskIndex].IPAddress -eq $taskPrevious) { $taskNetwork.SelectedIndex = $taskIndex } }
    if ($taskNetwork.SelectedIndex -lt 0 -and $taskNetwork.Items.Count -gt 0) { $taskNetwork.SelectedIndex = 0 }
}
Task-RefreshNetworks
Task-Action $taskLan 'Обновить список сетей' { Task-RefreshNetworks; if ($script:taskDesiredRunning) { Task-BeginNetworkUpdate } } | Out-Null
Task-Text $taskLan 'В автоматическом режиме адреса и сертификат обновляются сами. Доверие к сертификату устанавливается один раз на устройстве. После смены IP телефонам может понадобиться новый адрес или QR; привязка профиля и очередь сохраняются.' | Out-Null
Task-Action $taskLan 'Проверить LAN' { Task-CheckLan } | Out-Null
$taskLanCheck = Task-Text $taskLan 'Проверка не открывает порты и не меняет доверие сертификатам. Доступ с самого телефона проверяется отдельно.'
Task-Action $taskLan 'Как подключить телефон…' {
    [Windows.Forms.MessageBox]::Show("1. ПК и телефон — одна обычная Wi-Fi, не гостевая; сеть ПК — Частная.`n2. Выберите актуальный Wi-Fi IP → Сохранить и запустить.`n3. Разрешить LAN в брандмауэре (запрос Windows). Не открывайте порты роутера.`n4. Экспорт публичного сертификата → передать .cer на телефон.`n5. iPhone: установить профиль; Основные → Об этом устройстве → Доверие сертификатам → включить доверие своему CA. Android: установить CA через настройки безопасности; названия пунктов зависят от устройства.`n6. Safari/браузер: https://<IP>:<порт>/node/info — JSON без ошибки сертификата.`n7. Automesh: Связь → Серверы → QR сигналинга. Разрешить локальную сеть, если браузер спрашивает. Для очереди — отдельный QR привязки.`n8. Если не доступно: VPN с запретом LAN, изоляция Wi-Fi/гостевая сеть и сторонний firewall могут мешать.`nНе устанавливайте чужой CA; после смены IP повторите пункты 3–7. Для стабильного адреса настройте DHCP reservation на своём роутере.", 'Подключение LAN', 'OK', 'Information') | Out-Null
} | Out-Null
$taskSignal = Task-Check $taskLan 'Включить LAN-сигналинг для устройств домашней сети' $true
$taskSignalAddress = Task-Input $taskLan '' $true
Task-Action $taskLan 'Показать QR сигналинга…' { Task-ShowQr 'signal' } | Out-Null
Task-Text $taskLan 'QR содержит только адрес сигналинга — не привязывает профиль и не выдаёт доступ к очередям. На телефоне всё равно требуется доверенный сертификат.' | Out-Null
function Task-AllowLan {
    if ($script:taskConfig) {
        try {
            if ($script:taskFirewallProcess -and !$script:taskFirewallProcess.HasExited) { return }
            if ($script:taskFirewallProcess) { $script:taskFirewallProcess.Dispose(); $script:taskFirewallProcess = $null }
            $taskFirewallArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $script:taskProgramRoot 'firewall.ps1') + '"'), '-NodeExe', ('"' + (Join-Path $script:taskProgramRoot 'node.exe') + '"'), '-Port', $script:taskConfig.port)
            if ($script:taskConfig.networkMode -eq 'automatic') { $taskFirewallArgs += '-Automatic' }
            else { $taskFirewallArgs += @('-LanAddress', $script:taskConfig.lanAddress) }
            $script:taskFirewallProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $taskFirewallArgs -Verb RunAs -WindowStyle Hidden -PassThru
            $taskLanCheck.Text = 'Обновляется правило Windows LAN. Подтвердите запрос Windows и закройте сообщение результата: затем проверка повторится автоматически.'
            $taskLanHealth.Text = $taskLanCheck.Text
        }
        catch { $taskStatus.Text = 'Разрешение LAN отменено. Существующие правила не изменены.' }
    }
}
Task-Action $taskLan 'Разрешить LAN в брандмауэре…' { Task-AllowLan } | Out-Null
function Task-TrustLocal {
    $taskCaState = Task-InspectCa $script:taskConfig
    if (!$taskCaState.valid) { $taskStatus.Text = 'Сертификат своей ноды не прошёл проверку. Повторите подготовку; доверие не установлено.'; return $false }
    $taskCaFile = Task-CaFile
    if (!(Test-Path -LiteralPath $taskCaFile)) { $taskStatus.Text = 'Сначала запустите ноду.'; return $false }
    $taskCa = New-Object Security.Cryptography.X509Certificates.X509Certificate2($taskCaFile)
    try { if (Test-Path -LiteralPath ('Cert:\CurrentUser\Root\' + $taskCa.Thumbprint)) { return $true } } finally { $taskCa.Dispose() }
    if ((Test-Path -LiteralPath $taskCaFile) -and [Windows.Forms.MessageBox]::Show('Добавить сертификат своей ноды в доверенные для текущего пользователя Windows? Он нужен для HTTPS к localhost и домашним адресам. Ключ центра остаётся в защищённом хранилище этого пользователя Windows, чтобы обновлять адреса. Устанавливайте только сертификат собственной ноды.', 'Доверие', 'YesNo', 'Warning') -eq 'Yes') {
        try { Import-Certificate -FilePath $taskCaFile -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null; $taskStatus.Text = 'Сертификат добавлен. На телефоне установите доверие отдельно.'; return $true }
        catch { $taskStatus.Text = 'Не удалось добавить сертификат.' }
    }
    return $false
}
Task-Action $taskLan 'Доверять сертификату на этом ПК…' { [void](Task-TrustLocal) } | Out-Null
function Task-ExportCa {
    $taskCaFile = Task-CaFile
    if (Test-Path -LiteralPath $taskCaFile) {
        $taskDialog = New-Object Windows.Forms.SaveFileDialog
        $taskDialog.FileName = 'Automesh-Node-CA.cer'; $taskDialog.Filter = 'Сертификат (*.cer)|*.cer'
        $taskSaved = $false
        if ($taskDialog.ShowDialog() -eq 'OK') { Copy-Item -LiteralPath $taskCaFile -Destination $taskDialog.FileName -Force; $taskSaved = $true }
        $taskDialog.Dispose(); return $taskSaved
    }
    return $false
}
Task-Action $taskLan 'Экспорт публичного сертификата…' { Task-ExportCa } | Out-Null
$taskLanAdvanced = Task-Advanced $taskLan
$taskSecurity = Task-Text $taskLanAdvanced 'Ключ пересыльщика, токен управления и пароль TLS защищаются DPAPI текущего пользователя Windows. Сид не нужен. Нода обслуживает несколько профилей; ключи расшифрования чатов остаются в клиентах.'
Task-Text $taskLanAdvanced 'Порт HTTPS API и WSS сигналинга (работает)' | Out-Null
$taskPublicPort = Task-Number $taskLanAdvanced 1024 65535 3003
Task-Text $taskLanAdvanced 'Локальный порт управления (работает; доступ только 127.0.0.1)' | Out-Null
$taskControlPort = Task-Number $taskLanAdvanced 1024 65535 3004
Task-Text $taskLanAdvanced 'При смене порта обновите разрешение брандмауэра. Доверие к центру сертификатов сохраняется при смене IP. При первом обновлении старой ноды понадобится установить новый сертификат один раз.' | Out-Null
Task-Text $taskLanAdvanced 'Ограничение: 128 соединений на слушатель. HTTP: запрос 10 с, заголовки 5 с. Публичный интернет-слушатель и ручной список разрешённых сайтов пока не настраиваются.' | Out-Null
function Task-SaveAndStart {
    try {
        if ($script:taskNetworkProcess) { return }
        if (!$taskNetworkAuto.Checked -and $taskNetwork.SelectedIndex -lt 0) { throw 'Choose LAN' }
        if ($taskPublicPort.Value -eq $taskControlPort.Value) { throw 'Ports must differ' }
        $taskAllowedApp = $taskAppOrigin.Text.Trim(); $taskAppUri = [Uri]$taskAllowedApp
        if (!$taskAppUri.IsAbsoluteUri -or $taskAppUri.Scheme -ne 'https' -or $taskAppUri.UserInfo -or $taskAppUri.GetLeftPart([UriPartial]::Authority) -cne $taskAllowedApp) { throw 'Invalid application origin' }
        $taskSelected = if ($taskNetwork.SelectedIndex -ge 0) { $script:taskAddresses[$taskNetwork.SelectedIndex].IPAddress } else { '' }
        $taskCourierUrl = ''
        if ($taskCourier.Checked) {
            $taskCourierUrl = $taskRelay.Text.Trim(); $taskUri = [Uri]$taskCourierUrl
            if (!$taskUri.IsAbsoluteUri -or $taskUri.Scheme -ne 'wss' -or $taskUri.AbsolutePath -ne '/signal' -or $taskUri.Query -or $taskUri.Fragment -or $taskUri.UserInfo) { throw 'Invalid relay' }
        }
        $taskSecret = if ($script:taskConfig) { $script:taskConfig.adminToken } else { Task-RandomHex 32 }
        # Preserve file quotas and adapter options not edited on this page.
        $taskNext = @{}; if ($script:taskConfig) { foreach ($taskKey in $script:taskConfig.Keys) { $taskNext[$taskKey] = $script:taskConfig[$taskKey] } }
        $taskNext.version = 1; $taskNext.lanAddress = $taskSelected
        $taskNext.setupMode = if ($script:taskSetupMode) { $script:taskSetupMode } else { 'pc' }
        $taskNext.networkMode = if ($taskNetworkAuto.Checked) { 'automatic' } else { 'manual' }
        $taskNext.port = [int]$taskPublicPort.Value; $taskNext.controlPort = [int]$taskControlPort.Value
        $taskNext.dataDirectory = Join-Path $script:taskBase 'data'
        if (!$taskNext.pfxFile) { $taskNext.pfxFile = Join-Path $script:taskBase 'not-created.pfx'; $taskNext.pfxPassword = Task-RandomHex 32 }
        $taskNext.adminToken = $taskSecret; $taskNext.maxBytes = [long]$taskLimit.Value * 1024 * 1024; $taskNext.maxMessages = [int]$taskMessageLimit.Value
        $taskNext.signalingEnabled = $taskSignal.Checked; $taskNext.courierRelay = $taskCourierUrl
        $taskNext.allowedOrigins = @($taskAllowedApp, 'http://localhost:5173', 'http://127.0.0.1:5173')
        # Stop with OLD credentials/port before committing a changed control port.
        Task-Stop
        # Commit only after the old backend has finished its startup and queue
        # writes. Otherwise a control-port edit during startup can leave a live
        # process listening on a different endpoint from the shutdown request.
        $script:taskPendingConfig = $taskNext
        $script:taskPendingAutostart = $taskAuto.Checked
        $script:taskRestartPending = $true
        $script:taskNetworkPrepared = $false
        $taskLanHealth.Text = 'Домашние адреса обновятся автоматически. Для первого подключения телефона разрешите LAN и установите доверие к сертификату.'
        $taskLanCheck.Text = 'Настройки изменены: предыдущая проверка LAN больше не актуальна.'
        $script:taskDesiredRunning = $true
    } catch { $taskStatus.Text = 'Не удалось сохранить/запустить. Проверьте сеть, разные порты, сертификат и защищённое хранилище Windows.'; $taskTabs.SelectedIndex = 0 }
}
function Task-FirewallStatus {
    try {
        if ($script:taskConfig.networkMode -ne 'automatic') {
            $taskInterface = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $script:taskConfig.lanAddress -ErrorAction Stop
            if ((Get-NetConnectionProfile -InterfaceIndex $taskInterface.InterfaceIndex).NetworkCategory -ne 'Private') { return 'Сеть Windows не Частная. Для домашней Wi-Fi выберите Частная в настройках Windows; публичную сеть не открываем.' }
        }
        $taskRule = Get-NetFirewallRule -Name ('AutomeshNodeLAN-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -ErrorAction Stop
        $taskAddressFilter = $taskRule | Get-NetFirewallAddressFilter
        $taskPortFilter = $taskRule | Get-NetFirewallPortFilter
        $taskAppFilter = $taskRule | Get-NetFirewallApplicationFilter
        $taskInterfaceFilter = $taskRule | Get-NetFirewallInterfaceFilter
        $taskWantedAddress = if ($script:taskConfig.networkMode -eq 'automatic') { 'Any' } else { $script:taskConfig.lanAddress }
        $taskWantedInterface = if ($script:taskConfig.networkMode -eq 'automatic') { 'Any' } else { $taskInterface.InterfaceAlias }
        if ($taskRule.Enabled -eq 'True' -and $taskRule.Direction -eq 'Inbound' -and $taskRule.Action -eq 'Allow' -and $taskRule.Profile.ToString() -eq 'Private' -and
            @($taskAddressFilter.LocalAddress).Count -eq 1 -and $taskAddressFilter.LocalAddress -contains $taskWantedAddress -and @($taskAddressFilter.RemoteAddress).Count -eq 1 -and $taskAddressFilter.RemoteAddress -contains 'LocalSubnet' -and
            $taskPortFilter.Protocol -eq 'TCP' -and @($taskPortFilter.LocalPort).Count -eq 1 -and $taskPortFilter.LocalPort -contains ([string]$script:taskConfig.port) -and
            @($taskInterfaceFilter.InterfaceAlias).Count -eq 1 -and $taskInterfaceFilter.InterfaceAlias -contains $taskWantedInterface -and
            $taskAppFilter.Program -eq (Join-Path $script:taskProgramRoot 'node.exe')) { return 'Правило Windows LAN соответствует IP и порту. Доступ с телефона всё равно нужно проверить.' }
        return 'Правило LAN устарело/выключено: нажмите «Разрешить LAN в брандмауэре…», затем повторите проверку.'
    } catch { return 'Правило LAN не подтверждено: нажмите «Разрешить LAN в брандмауэре…» и повторите проверку.' }
}
function Task-CheckLan {
    if (!$script:taskConfig) { $taskLanCheck.Text = 'Сначала выберите сеть и сохраните настройки.'; return }
    if ($script:taskConfig.lanAddress -and !(Task-AddressIsLocal $script:taskConfig.lanAddress)) {
        $taskLanCheck.Text = 'Сохранённый IP ' + $script:taskConfig.lanAddress + ' изменился. Обновите сети, выберите текущий Wi-Fi/Ethernet, сохраните и обновите сертификат/правило LAN.'
        $taskLanHealth.Text = $taskLanCheck.Text; return
    }
    if ($script:taskCheckProcess -and !$script:taskCheckProcess.HasExited) { return }
    $script:taskFirewallSummary = 'Подробные проверки доступа выполняются в фоне помощником подключения.'
    Task-InvalidateSetup
    $taskLanCheck.Text = 'Проверяем локальный HTTPS, LAN HTTPS/TLS и WSS… ' + $script:taskFirewallSummary
    $taskStartInfo = New-Object Diagnostics.ProcessStartInfo
    $taskStartInfo.FileName = Join-Path $script:taskProgramRoot 'node.exe'
    $taskStartInfo.Arguments = '"' + (Join-Path $script:taskProgramRoot 'node.cjs') + '" --check-lan "' + $script:taskConfigFile + '"'
    $taskStartInfo.UseShellExecute = $false; $taskStartInfo.CreateNoWindow = $true
    $taskStartInfo.RedirectStandardOutput = $true; $taskStartInfo.RedirectStandardError = $true
    try { $script:taskCheckProcess = [Diagnostics.Process]::Start($taskStartInfo); $script:taskCheckStarted = Get-Date }
    catch { $taskLanCheck.Text = 'Не удалось запустить проверку. Переустановите актуальную ноду поверх существующей.' }
}
function Task-ReadLanCheck {
    if (!$script:taskCheckProcess) { return }
    if (!$script:taskCheckProcess.HasExited) {
        if (((Get-Date) - $script:taskCheckStarted).TotalSeconds -lt 15) { return }
        $script:taskCheckProcess.Kill(); $taskLanCheck.Text = 'Проверка превысила время ожидания. Проверьте запуск ноды и защиту Windows.'
    } else {
        try {
            $taskResult = $script:taskCheckProcess.StandardOutput.ReadToEnd() | ConvertFrom-Json
            if ($taskResult.error) { $taskLanCheck.Text = 'Не удалось проверить защищённые настройки/сертификат. Проверьте IP и ту же учётную запись Windows.' }
            else {
                $taskLanCheck.Text = 'HTTPS на ПК: ' + $(if ($taskResult.loopback) { 'OK' } else { 'нет' }) + ' · HTTPS/TLS по LAN-IP: ' + $(if ($taskResult.lanHttps) { 'OK' } else { 'нет — запуск/IP/сертификат' }) + ' · WSS: ' + $(if ($taskResult.signaling -is [string] -and $taskResult.signaling -eq 'disabled') { 'выключен в настройках' } elseif ($taskResult.signaling -is [bool] -and $taskResult.signaling) { 'OK' } else { 'нет' }) + '. ' + $script:taskFirewallSummary
            }
        } catch { $taskLanCheck.Text = 'Проверка не завершилась. Проверьте запуск, IP и защищённое хранилище Windows.' }
    }
    $taskLanHealth.Text = $taskLanCheck.Text; $script:taskCheckProcess.Dispose(); $script:taskCheckProcess = $null
}
function Task-ReadFirewallUpdate {
    if (!$script:taskFirewallProcess -or !$script:taskFirewallProcess.HasExited) { return }
    $script:taskFirewallProcess.WaitForExit()
    $taskExitCode = $script:taskFirewallProcess.ExitCode
    $script:taskFirewallProcess.Dispose(); $script:taskFirewallProcess = $null
    if ($taskExitCode -eq 0) {
        # Previous check was made BEFORE the rule changed. Never leave that
        # warning as the apparent result of a successful firewall update.
        Task-CheckLan
    } else {
        $taskLanCheck.Text = 'Windows не подтвердил обновление правила LAN. Проверьте Частную сеть, права администратора и повторите проверку.'
        $taskLanHealth.Text = $taskLanCheck.Text
    }
}
function Task-ShowQr([string]$Kind) {
    try {
        $taskCurrent = Task-Control '/status'
        if ($Kind -like 'pair*' -and (!$taskCurrent.pairCode -or $taskCurrent.pairExpires -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())) { Task-Control '/pair-code' 'POST' | Out-Null; $taskCurrent = Task-Control '/status' }
        $taskRequest = [Net.HttpWebRequest]::Create(('http://127.0.0.1:' + $script:taskConfig.controlPort + '/qr/' + $Kind))
        $taskRequest.Proxy = $null; $taskRequest.Timeout = 3000
        $taskRequest.Headers['Authorization'] = 'Bearer ' + $script:taskConfig.adminToken
        $taskResponse = $taskRequest.GetResponse(); $taskBytes = New-Object IO.MemoryStream
        try { $taskResponse.GetResponseStream().CopyTo($taskBytes); $taskBytes.Position = 0; $taskOriginal = [Drawing.Image]::FromStream($taskBytes); $taskImage = New-Object Drawing.Bitmap($taskOriginal); $taskOriginal.Dispose() }
        finally { $taskBytes.Dispose(); $taskResponse.Close() }
        $taskQrForm = New-Object Windows.Forms.Form
        $taskQrForm.Text = if ($Kind -eq 'pair-local') { 'Этот ПК: localhost' } elseif ($Kind -eq 'pair') { 'Телефон: привязка к домашней ноде' } else { 'LAN-сигналинг: адрес без секретов' }
        $taskQrForm.ClientSize = New-Object Drawing.Size(370, 395); $taskQrForm.StartPosition = 'CenterParent'
        $taskPicture = New-Object Windows.Forms.PictureBox
        $taskPicture.Image = $taskImage; $taskPicture.SizeMode = 'Zoom'; $taskPicture.Dock = 'Fill'; $taskQrForm.Controls.Add($taskPicture)
        $taskQrNote = New-Object Windows.Forms.Label
        $taskQrNote.Dock = 'Bottom'; $taskQrNote.Height = 48
        $taskQrNote.Text = if ($Kind -like 'pair*') { 'Добавьте эту ноду в приложении через QR. Код одноразовый; HTTPS требует доверия к сертификату своей ноды.' } else { 'Сканируйте в приложении: Связь → Серверы подключения → Сканировать QR сервера.' }
        $taskQrForm.Controls.Add($taskQrNote)
        $taskCopyQr = New-Object Windows.Forms.Button
        $taskCopyQr.Text = 'Копировать подключение'; $taskCopyQr.Dock = 'Bottom'; $taskCopyQr.Height = 36
        $taskQrValue = if ($Kind -like 'pair*') {
            $taskHost = if ($Kind -eq 'pair-local') { 'localhost' } else { $script:taskConfig.lanAddress }
            @{ protocol = 'automesh-node-pair-v1'; url = ('https://' + $taskHost + ':' + $script:taskConfig.port + '/'); nodeId = $taskCurrent.nodeId; code = $taskCurrent.pairCode; expiresAt = $taskCurrent.pairExpires } | ConvertTo-Json -Compress
        } else { 'wss://' + $script:taskConfig.lanAddress + ':' + $script:taskConfig.port + '/signal' }
        $taskCopyQr.Add_Click({ [Windows.Forms.Clipboard]::SetText($taskQrValue); $taskCopyQr.Text = 'Скопировано' }.GetNewClosure())
        $taskQrForm.Controls.Add($taskCopyQr)
        $taskExpiryTimer = New-Object Windows.Forms.Timer
        $taskExpiryTimer.Interval = 1000
        $taskExpiryTimer.Add_Tick({ if ($Kind -like 'pair*' -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $taskCurrent.pairExpires) { $taskQrForm.Close() } }.GetNewClosure())
        try { $taskExpiryTimer.Start(); [void]$taskQrForm.ShowDialog($taskForm) }
        finally { $taskExpiryTimer.Stop(); $taskExpiryTimer.Dispose(); $taskQrForm.Dispose(); $taskImage.Dispose() }
    } catch { $taskStatus.Text = 'QR недоступен. Запустите ноду; для привязки создайте новый код, для сигналинга включите LAN.'; $taskTabs.SelectedIndex = 0 }
}
$taskStartButton = Task-Action $taskFooter 'Запустить' { if ($script:taskConfig) { Task-Start } else { Task-SaveAndStart } }
$taskStopButton = Task-Action $taskFooter 'Остановить' { Task-Stop }
Task-Action $taskLan 'Сохранить параметры и перезапустить' { Task-SaveAndStart } | Out-Null
$taskTray = New-Object Windows.Forms.NotifyIcon
$taskTray.Icon = [Drawing.SystemIcons]::Application; $taskTray.Text = 'Automesh Node'; $taskTray.Visible = $true
$taskMenu = New-Object Windows.Forms.ContextMenuStrip
[void]$taskMenu.Items.Add('Настройки', $null, { $taskForm.Show(); $taskForm.WindowState = 'Normal'; $taskForm.Activate() })
[void]$taskMenu.Items.Add('Запустить', $null, { Task-Start })
[void]$taskMenu.Items.Add('Остановить', $null, { Task-Stop })
[void]$taskMenu.Items.Add('Остановить и выйти', $null, { $script:taskCloseWhenStopped = $true; Task-Stop; $taskForm.Show() })
$taskTray.ContextMenuStrip = $taskMenu
$taskTray.Add_DoubleClick({ $taskForm.Show(); $taskForm.WindowState = 'Normal'; $taskForm.Activate() })
$taskForm.Add_FormClosing({ param($sender, $eventArgs) if (!$script:taskExiting) { $eventArgs.Cancel = $true; $taskForm.Hide() } })
$taskForm.Add_Shown({ if ($Background -and $script:taskConfig) { $taskForm.Hide() } })
$taskForm.Add_Resize({
    foreach ($taskPage in $taskTabs.TabPages) {
        $taskPanel = $taskPage.Controls[0]
        foreach ($taskControl in $taskPanel.Controls) { if ($taskControl.Tag -eq 'wide') { $taskControl.Width = [Math]::Max(300, $taskPanel.ClientSize.Width - 56) } }
    }
})
$taskTimer = New-Object Windows.Forms.Timer
$taskTimer.Interval = 1000
function Task-Start {
    if (!$script:taskConfig) { Task-SaveAndStart; return }
    $script:taskDesiredRunning = $true
    $script:taskNetworkWarning = ''
    $script:taskSetupError = ''; $script:taskStopping = $false
    $script:taskSetupPrompt = $true; $script:taskSetupDismissed = $false; $script:taskSetupManual = $false
    Task-InvalidateSetup
    $script:taskStartError = ''; $script:taskRetryCount = 0
    $script:taskNetworkPrepared = $false; $script:taskRestartPending = $true
    $taskStatus.Text = 'Подготавливаем домашние сети и защищённое подключение…'
}
function Task-BeginNetworkUpdate {
    if ($script:taskNetworkProcess -or !$script:taskConfig) { return }
    $script:taskNetworkCheckedAt = Get-Date
    $taskInfo = New-Object Diagnostics.ProcessStartInfo
    $taskInfo.FileName = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $taskInfo.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $script:taskProgramRoot 'launcher.ps1') + '" -PrepareNetwork -WorkerConfig "' + $script:taskConfigFile + '"'
    if ($script:taskReplaceCertificate) { $taskInfo.Arguments += ' -ResetCertificate' }
    $taskInfo.UseShellExecute = $false; $taskInfo.CreateNoWindow = $true
    $taskInfo.RedirectStandardOutput = $true; $taskInfo.RedirectStandardError = $true
    $script:taskNetworkProcess = [Diagnostics.Process]::Start($taskInfo)
    $script:taskNetworkStartedAt = Get-Date
}
function Task-ReadNetworkUpdate {
    if (!$script:taskNetworkProcess -or !$script:taskNetworkProcess.HasExited) { return }
    $script:taskNetworkProcess.WaitForExit()
    $taskCode = $script:taskNetworkProcess.ExitCode
    $taskPreparation = $null
    try { $taskPreparation = $script:taskNetworkProcess.StandardOutput.ReadToEnd() | ConvertFrom-Json } catch { }
    $script:taskNetworkProcess.Dispose(); $script:taskNetworkProcess = $null
    if ($taskCode -ne 0) {
        $script:taskSetupError = if ($taskPreparation.error) { $taskPreparation.error } else { 'preparation_failed' }
        $script:taskNetworkWarning = 'Не удалось подготовить сеть или сертификат. Проверьте выбранную сеть и хранилище Windows. Данные не удалены.'
        $taskStatus.Text = $script:taskNetworkWarning
        if (!$script:taskProcess -or $script:taskProcess.HasExited) { $script:taskDesiredRunning = $false }
        return
    }
    $script:taskReplaceCertificate = $false
    $taskNext = Task-ReadConfig
    $taskChanged = $script:taskConfig.pfxFile -ne $taskNext.pfxFile -or $script:taskConfig.lanAddress -ne $taskNext.lanAddress -or ($script:taskConfig.lanAddresses -join ',') -ne ($taskNext.lanAddresses -join ',')
    if ($taskChanged) {
        $taskWanted = $script:taskDesiredRunning
        $taskSetupWanted = $script:taskSetupPrompt
        Task-Stop
        $script:taskDesiredRunning = $taskWanted; $script:taskRestartPending = $taskWanted
        $script:taskSetupPrompt = $taskSetupWanted
    }
    $script:taskConfig = $taskNext; $script:taskNetworkPrepared = $true; $script:taskNetworkWarning = ''
    $taskLocalEndpoint.Text = 'https://localhost:' + $taskNext.port + '/'
}
function Task-ServiceTick {
    if ($script:taskShowEvent -and $script:taskShowEvent.WaitOne(0)) { $taskForm.Show(); $taskForm.WindowState = 'Normal'; $taskForm.Activate() }
    if ($script:taskNetworkProcess -and !$script:taskNetworkProcess.HasExited -and $script:taskNetworkStartedAt -and ((Get-Date) - $script:taskNetworkStartedAt).TotalSeconds -gt 90) {
        # Only stop the disposable preparation worker. The backend/queue writer
        # is never killed; configuration commits remain atomic.
        $script:taskNetworkProcess.Kill()
    }
    Task-ReadNetworkUpdate
    if ($script:taskShutdownTarget -and (($script:taskProcess -and !$script:taskProcess.HasExited) -or $script:taskAdoptedRunning)) {
        if ($script:taskShutdownPending -and $script:taskShutdownPending.IsCompleted) {
            try { $taskResponse = $script:taskShutdownPending.GetAwaiter().GetResult(); $taskResponse.Close() }
            catch { }
            finally { $script:taskShutdownRequest = $null; $script:taskShutdownPending = $null; $script:taskShutdownNext = (Get-Date).AddSeconds(3) }
        } elseif ($script:taskShutdownPending -and ((Get-Date) - $script:taskShutdownAt).TotalSeconds -gt 3) {
            $script:taskShutdownRequest.Abort(); $script:taskShutdownRequest = $null; $script:taskShutdownPending = $null; $script:taskShutdownNext = (Get-Date).AddSeconds(3)
        }
        if (!$script:taskShutdownPending -and (Get-Date) -ge $script:taskShutdownNext) {
            $taskRequest = [Net.HttpWebRequest]::Create(('http://127.0.0.1:' + $script:taskShutdownTarget.port + '/shutdown'))
            $taskRequest.Proxy = $null; $taskRequest.Method = 'POST'; $taskRequest.ContentLength = 0
            $taskRequest.Headers['Authorization'] = 'Bearer ' + $script:taskShutdownTarget.token
            $script:taskShutdownRequest = $taskRequest; $script:taskShutdownAt = Get-Date
            $script:taskShutdownPending = $taskRequest.GetResponseAsync()
        }
    }
    if ($script:taskStopControl) {
        if (!$script:taskStopRequest) {
            $taskRequest = [Net.HttpWebRequest]::Create(('http://127.0.0.1:' + $script:taskStopControl.port + '/status'))
            $taskRequest.Proxy = $null; $taskRequest.Headers['Authorization'] = 'Bearer ' + $script:taskStopControl.token
            $script:taskStopRequest = $taskRequest; $script:taskStopRequestAt = Get-Date; $script:taskStopPending = $taskRequest.GetResponseAsync()
        } elseif ($script:taskStopPending.IsCompleted) {
            try { $taskStopResponse = $script:taskStopPending.GetAwaiter().GetResult(); $taskStopResponse.Close() }
            catch { $script:taskAdoptedRunning = $false; $script:taskStopControl = $null }
            finally { $script:taskStopRequest = $null; $script:taskStopPending = $null }
        } elseif (((Get-Date) - $script:taskStopRequestAt).TotalSeconds -gt 3) {
            $script:taskStopRequest.Abort(); $script:taskStopRequest = $null; $script:taskStopPending = $null
        }
    }
    $taskAlive = ($script:taskProcess -and !$script:taskProcess.HasExited) -or $script:taskAdoptedRunning
    if (!$taskAlive -and $script:taskShutdownTarget) {
        if ($script:taskShutdownRequest) { $script:taskShutdownRequest.Abort() }
        $script:taskShutdownTarget = $null; $script:taskShutdownRequest = $null; $script:taskShutdownPending = $null
    }
    if (!$taskAlive -and !$script:taskNetworkProcess -and $script:taskPendingConfig) {
        try {
            Task-WriteConfig $script:taskPendingConfig
            Task-Autostart $script:taskPendingAutostart
            $script:taskPendingConfig = $null
        } catch {
            $script:taskDesiredRunning = $false; $script:taskPendingConfig = $null
            $script:taskNetworkWarning = 'Не удалось сохранить защищённые параметры. Очередь не удалена.'; $taskStatus.Text = $script:taskNetworkWarning
        }
    }
    $taskStartButton.Enabled = !$script:taskDesiredRunning -and !$script:taskNetworkProcess -and !$taskAlive
    $taskStopButton.Enabled = $script:taskDesiredRunning -or $taskAlive
    if ($script:taskCloseWhenStopped -and !$taskAlive -and !$script:taskNetworkProcess) {
        $script:taskExiting = $true; $taskForm.Close(); return
    }
    if (!$script:taskDesiredRunning) {
        if (!$taskAlive -and !$script:taskNetworkProcess -and !$script:taskNetworkWarning) { $taskStatus.Text = 'Нода остановлена. Очередь сохранена. Нажмите «Запустить».' }
        return
    }
    if ($script:taskRestartPending) {
        if ($taskAlive) { return }
        if (!$script:taskNetworkPrepared) { Task-BeginNetworkUpdate; return }
        $script:taskRestartPending = $false; $script:taskStopping = $false
        try { Task-StartBackend; $script:taskBackendStartedAt = Get-Date }
        catch { $script:taskDesiredRunning = $false; $script:taskSetupError = 'installed_package_invalid'; $script:taskNetworkWarning = 'Не удалось проверить файлы установленной ноды. Установите новый пакет поверх; очередь сохранится.'; $taskStatus.Text = $script:taskNetworkWarning }
        return
    }
    if (!$taskAlive -and $script:taskProcess -and !$script:taskStopping) {
        $taskReason = Task-StartError
        if ($taskReason -in @('EADDRINUSE', 'EACCES') -and $script:taskRetryCount -lt 3 -and $script:taskSetupPhase -ne 'steps') {
            if (((Get-Date) - $script:taskBackendStartedAt).TotalSeconds -ge (10 * (1 + $script:taskRetryCount))) {
                $script:taskRetryCount++; $script:taskNetworkPrepared = $false; $script:taskRestartPending = $true
            }
        } else { $script:taskDesiredRunning = $false; $script:taskSetupError = $taskReason; $script:taskNetworkWarning = 'Нода не запустилась (' + $taskReason + '). Очередь сохранена; проверьте параметры и повторите запуск.'; $taskStatus.Text = $script:taskNetworkWarning }
    }
    if ($taskAlive -and !$script:taskNetworkProcess -and ((Get-Date) - $script:taskNetworkCheckedAt).TotalSeconds -ge 30) { Task-BeginNetworkUpdate }
}
function Task-PollStatus {
    if (!$script:taskConfig) { return $null }
    if (!$script:taskStatusRequest) {
        $taskRequest = [Net.HttpWebRequest]::Create(('http://127.0.0.1:' + $script:taskConfig.controlPort + '/status'))
        $taskRequest.Proxy = $null; $taskRequest.Timeout = 1500
        $taskRequest.Headers['Authorization'] = 'Bearer ' + $script:taskConfig.adminToken
        $script:taskStatusRequest = $taskRequest; $script:taskStatusStartedAt = Get-Date
        $script:taskStatusPending = $taskRequest.GetResponseAsync()
        return $null
    }
    if (!$script:taskStatusPending.IsCompleted) {
        if (((Get-Date) - $script:taskStatusStartedAt).TotalSeconds -lt 3) { return $null }
        $script:taskStatusRequest.Abort()
        $script:taskStatusRequest = $null; $script:taskStatusPending = $null
        throw 'status_timeout'
    }
    try {
        $taskResponse = $script:taskStatusPending.GetAwaiter().GetResult()
        try {
            $taskReader = New-Object IO.StreamReader($taskResponse.GetResponseStream())
            try { return ($taskReader.ReadToEnd() | ConvertFrom-Json) } finally { $taskReader.Dispose() }
        } finally { $taskResponse.Close() }
    } finally { $script:taskStatusRequest = $null; $script:taskStatusPending = $null }
}
function Task-CourierStatus([string]$Status) {
    switch ($Status) {
        'disabled' { return 'выключены' }
        'connecting' { return 'подключение…' }
        'connected' { return 'подключены' }
        'retrying' { return 'повтор подключения…' }
        'relay_outdated' { return 'сервер подключения требует обновления' }
        default { return 'состояние неизвестно' }
    }
}
function Task-OfflineStatus {
    $taskOutSummary.Text = 'Исходящие: нет связи с нодой; состояние очереди неизвестно.'
    $taskInSummary.Text = 'Входящие LAN: нет связи с нодой. Интернет-приём пока недоступен.'
    $taskLanSummary.Text = 'LAN-сигналинг: состояние неизвестно.'
    $taskLanHealth.Text = 'Доступ с телефонов: нет актуальных данных, процесс ноды недоступен. После запуска повторите «Проверить LAN».'
    $taskMembers.Text = 'Привязанные адреса: нет актуальных данных.'
    $taskInboxMembers.Text = 'Статистика ящиков недоступна до запуска.'
    $taskMemberList.Items.Clear(); $script:taskMemberAddresses = @(); $taskRemoveMember.Enabled = $false
    $taskCode.Text = ''; $taskSignalAddress.Text = ''; $taskEndpoint.Text = ''
}
$taskTimer.Add_Tick({
    Task-ReadLanCheck
    Task-ReadFirewallUpdate
    try {
        Task-ServiceTick
        $taskCurrent = Task-PollStatus
        if (!$taskCurrent) { return }
        Task-RecordRuntime $taskCurrent
        if ($script:taskRestartPending -or !$script:taskDesiredRunning) { return }
        $taskStatus.Text = 'Работает · конвертов: ' + $taskCurrent.messages + ' · занято: ' + [Math]::Ceiling($taskCurrent.bytes / 1024) + ' КБ из ' + [Math]::Floor($taskCurrent.maxBytes / 1024 / 1024) + ' МБ'
        $taskOutSummary.Text = 'Исходящие · LAN: ' + (Task-CourierStatus $taskCurrent.courier.routes.lan) + ' · Интернет: ' + (Task-CourierStatus $taskCurrent.courier.routes.internet) + ' · конвертов: ' + $taskCurrent.courier.messages + ' · файлов: ' + $taskCurrent.courier.attachments.files + ' · резерв файлов: ' + [Math]::Ceiling($taskCurrent.courier.attachments.bytes / 1024 / 1024) + ' МБ'
        $taskCourierAddress.Text = $taskCurrent.courier.address
        $taskInSummary.Text = 'Входящие LAN: ' + ($taskCurrent.members | Measure-Object -Property messages -Sum).Sum + ' конвертов. Интернет-приём пока недоступен.'
        $taskLanSummary.Text = 'LAN-сигналинг: ' + $(if ($taskCurrent.signaling.enabled) { 'включён' } else { 'выключен' }) + ' · подключено: ' + $taskCurrent.signaling.clients
        $taskMembers.Text = 'Привязанные адреса: ' + @($taskCurrent.members).Count + ' из ' + $taskCurrent.memberLimit
        Task-UpdateMembers $taskCurrent
        $taskInboxMembers.Text = (@($taskCurrent.members | ForEach-Object { $_.address + ' · входящих: ' + $_.messages + ' · исходящих: ' + $_.outgoing + ' · файлов: ' + $_.files + ' · КБ: ' + [Math]::Ceiling($_.bytes / 1024) }) -join [Environment]::NewLine)
        $taskLanAddresses = if ($null -ne $script:taskConfig.lanAddresses) { @($script:taskConfig.lanAddresses) } else { @($script:taskConfig.lanAddress) }
        $taskEndpoint.Text = ($taskLanAddresses | ForEach-Object { 'https://' + $_ + ':' + $script:taskConfig.port + '/' }) -join '  ·  '
        $taskSignalAddress.Text = ($taskLanAddresses | ForEach-Object { 'wss://' + $_ + ':' + $script:taskConfig.port + '/signal' }) -join '  ·  '
        $taskLocalEndpoint.Text = 'https://localhost:' + $script:taskConfig.port + '/'
        if (!$taskLanAddresses.Count) { $taskLanHealth.Text = 'Работает на этом ПК. Для доступа с телефона подключитесь к домашней сети Windows с профилем «Частная».' }
        $taskCode.Text = if ($taskCurrent.pairCode -and $taskCurrent.pairExpires -gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { $taskCurrent.pairCode } else { 'Нужен новый код для следующего профиля.' }
    } catch {
        Task-OfflineStatus
        if ($script:taskDesiredRunning) {
            $taskStatus.Text = if ($script:taskNetworkProcess) { 'Обновляем домашние адреса и сертификат…' } else { 'Запускаем ноду или восстанавливаем связь… ' + (Task-StartError) }
        }
    } finally { try { Task-SetupTick } catch { if ($script:taskSetupSummary) { $script:taskSetupSummary.Text = 'Проверка готовности не завершилась. Откройте помощник и повторите проверку.' } } }
})
Task-BuildSetup
# A new installation starts at the usage choice; permissions are never requested
# just because the UI was constructed. Existing ready installations stay quiet.
try {
    if (Test-Path -LiteralPath $script:taskConfigFile) {
        $script:taskConfig = Task-ReadConfig
        if ($script:taskConfig.setupMode -in @('pc','both')) { $script:taskSetupMode = $script:taskConfig.setupMode }
        $taskNetworkAuto.Checked = $script:taskConfig.networkMode -ne 'manual'
        # Legacy installations migrate to automatic Private-network binding.
        if (!$script:taskConfig.networkMode) { $script:taskConfig.networkMode = 'automatic'; Task-WriteConfig $script:taskConfig }
        if ($script:taskConfig.allowedOrigins.Count) { $taskAppOrigin.Text = $script:taskConfig.allowedOrigins[0] }
        Task-RefreshNetworks
        $taskLimit.Value = [Math]::Max(1, [Math]::Min(512, $script:taskConfig.maxBytes / 1024 / 1024))
        if ($script:taskConfig.maxMessages) { $taskMessageLimit.Value = $script:taskConfig.maxMessages }
        $taskPublicPort.Value = $script:taskConfig.port; $taskControlPort.Value = $script:taskConfig.controlPort
        $taskSignal.Checked = $script:taskConfig.signalingEnabled -ne $false
        $taskAuto.Checked = [bool](Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AutomeshNode' -ErrorAction SilentlyContinue)
        $taskCourier.Checked = [bool]$script:taskConfig.courierRelay
        if ($taskCourier.Checked) { $taskRelay.Text = $script:taskConfig.courierRelay }
        # Opening the launcher starts a configured node independently of the
        # separate preference to launch it automatically at Windows sign-in.
        $script:taskSetupPort.Value = $taskPublicPort.Value; $script:taskSetupControlPort.Value = $taskControlPort.Value
        if ($Background) { Task-Start }
    }
    $taskTimer.Start(); [Windows.Forms.Application]::Run($taskForm)
} catch { [Windows.Forms.MessageBox]::Show('Не удалось открыть защищённые настройки. Используйте ту же учётную запись Windows. Данные и очереди не удалены.', 'Automesh Node', 'OK', 'Error') | Out-Null }
finally {
    if ($script:taskSetupProcess) { if (!$script:taskSetupProcess.HasExited) { $script:taskSetupProcess.Kill() }; $script:taskSetupProcess.Dispose() }
    if ($script:taskStatusRequest) { $script:taskStatusRequest.Abort() }
    if ($script:taskStopRequest) { $script:taskStopRequest.Abort() }
    if ($script:taskShutdownRequest) { $script:taskShutdownRequest.Abort() }
    if ($script:taskNetworkProcess) { $script:taskNetworkProcess.Dispose() }
    # Do not terminate the elevated firewall helper if the settings window closes.
    if ($script:taskFirewallProcess) { $script:taskFirewallProcess.Dispose() }
    if ($script:taskCheckProcess) { if (!$script:taskCheckProcess.HasExited) { $script:taskCheckProcess.Kill() }; $script:taskCheckProcess.Dispose() }
    $taskTimer.Stop(); $taskTimer.Dispose(); $taskTray.Visible = $false; $taskTray.Dispose(); $taskForm.Dispose()
}
