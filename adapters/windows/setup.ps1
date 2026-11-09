# Windows-only setup observations. No trust, firewall or network changes here.
# GUI permissions are requested only by an explicit action in Task-SetupAction.
function Task-ConfigStamp($Config) {
    $taskValue = @($Config.pfxFile, $Config.caThumbprint, $Config.port, $Config.controlPort, ($Config.lanAddresses -join ','), ($Config.allowedOrigins -join ',')) -join '|'
    $taskHash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskValue)))).Replace('-', '') } finally { $taskHash.Dispose() }
}
function Task-InspectCa($Config) {
    $taskCertificate = $null
    try {
        if ($Config.caThumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'invalid_ca' }
        $taskCertificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($Config.caFile)
        $taskConstraints = $taskCertificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.30' }
        $taskBasic = $taskCertificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' }
        $taskUsage = $taskCertificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' }
        $taskExpectedConstraints = '303FA03D300B82096C6F63616C686F7374300A87087F000000FF000000300A87080A000000FF000000300A8708AC100000FFF00000300A8708C0A80000FFFF0000'
        if ($taskCertificate.Thumbprint -ne $Config.caThumbprint -or $taskCertificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or $taskCertificate.NotAfter.ToUniversalTime() -lt [DateTime]::UtcNow.AddDays(15) -or
            !$taskBasic.CertificateAuthority -or !$taskBasic.HasPathLengthConstraint -or $taskBasic.PathLengthConstraint -ne 0 -or
            !$taskConstraints.Critical -or ([BitConverter]::ToString($taskConstraints.RawData)).Replace('-', '') -cne $taskExpectedConstraints -or
            @($taskUsage.EnhancedKeyUsages).Count -ne 1 -or $taskUsage.EnhancedKeyUsages[0].Value -ne '1.3.6.1.5.5.7.3.1') { throw 'invalid_ca' }
        $taskSigner = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $Config.caThumbprint) -ErrorAction Stop
        return @{ valid = [bool]$taskSigner.HasPrivateKey; trusted = (Test-Path -LiteralPath ('Cert:\CurrentUser\Root\' + $Config.caThumbprint)); fingerprint = $taskCertificate.Thumbprint }
    } catch { return @{ valid = $false; trusted = $false; fingerprint = '' } }
    finally { if ($taskCertificate) { $taskCertificate.Dispose() } }
}
function Task-InspectFirewall($Config, [string]$ProgramRoot) {
    try {
        $taskRule = Get-NetFirewallRule -Name ('AutomeshNodeLAN-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -ErrorAction Stop
        $taskAddress = $taskRule | Get-NetFirewallAddressFilter
        $taskPort = $taskRule | Get-NetFirewallPortFilter
        $taskApp = $taskRule | Get-NetFirewallApplicationFilter
        $taskInterface = $taskRule | Get-NetFirewallInterfaceFilter
        $taskWantedAddress = 'Any'; $taskWantedInterface = 'Any'
        if ($Config.networkMode -ne 'automatic') {
            $taskAdapter = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $Config.lanAddress -ErrorAction Stop
            if ((Get-NetConnectionProfile -InterfaceIndex $taskAdapter.InterfaceIndex).NetworkCategory -ne 'Private') { return 'missing' }
            $taskWantedAddress = $Config.lanAddress; $taskWantedInterface = $taskAdapter.InterfaceAlias
        }
        if ($taskRule.Enabled -eq 'True' -and $taskRule.Direction -eq 'Inbound' -and $taskRule.Action -eq 'Allow' -and $taskRule.Profile.ToString() -eq 'Private' -and
            @($taskAddress.LocalAddress).Count -eq 1 -and $taskAddress.LocalAddress -contains $taskWantedAddress -and @($taskAddress.RemoteAddress).Count -eq 1 -and $taskAddress.RemoteAddress -contains 'LocalSubnet' -and
            $taskPort.Protocol -eq 'TCP' -and @($taskPort.LocalPort).Count -eq 1 -and $taskPort.LocalPort -contains ([string]$Config.port) -and
            @($taskInterface.InterfaceAlias).Count -eq 1 -and $taskInterface.InterfaceAlias -contains $taskWantedInterface -and
            $taskApp.Program -eq (Join-Path $ProgramRoot 'node.exe')) { return 'ready' }
        return 'missing'
    } catch { return 'unknown' }
}
function Task-ReadinessFacts {
    $taskCa = Task-InspectCa $script:taskConfig
    $taskPrivate = @(Task-NetworkAddresses | ForEach-Object IPAddress)
    $taskBindings = if ($null -ne $script:taskConfig.lanAddresses) { @($script:taskConfig.lanAddresses) } else { @($script:taskConfig.lanAddress) }
    $taskHasPrivate = @($taskBindings | Where-Object { $taskPrivate -contains $_ }).Count -gt 0
    $taskResult = @{ stamp = (Task-ConfigStamp $script:taskConfig); certificate = ($taskCa.valid -and $script:taskConfig.pfxFile -and (Test-Path -LiteralPath $script:taskConfig.pfxFile)); trusted = $taskCa.trusted; fingerprint = $taskCa.fingerprint;
        privateNetwork = $taskHasPrivate; firewall = (Task-InspectFirewall $script:taskConfig $script:taskProgramRoot); localHttps = $false; lanHttps = $false }
    # Read-only checks trust the exact node CA, never bypass TLS validation.
    $taskInfo = New-Object Diagnostics.ProcessStartInfo
    $taskInfo.FileName = Join-Path $script:taskProgramRoot 'node.exe'
    $taskInfo.Arguments = '"' + (Join-Path $script:taskProgramRoot 'node.cjs') + '" --check-lan "' + $script:taskConfigFile + '"'
    $taskInfo.UseShellExecute = $false; $taskInfo.CreateNoWindow = $true; $taskInfo.RedirectStandardOutput = $true; $taskInfo.RedirectStandardError = $true
    $taskCheck = [Diagnostics.Process]::Start($taskInfo)
    try {
        if (!$taskCheck.WaitForExit(20000)) { $taskCheck.Kill(); throw 'check_timeout' }
        if ($taskCheck.ExitCode -eq 0) {
            $taskCheckValue = $taskCheck.StandardOutput.ReadToEnd() | ConvertFrom-Json
            $taskResult.localHttps = $taskCheckValue.loopback -eq $true
            $taskResult.lanHttps = $taskCheckValue.lanHttps -eq $true
        }
    } finally { $taskCheck.Dispose() }
    return $taskResult
}
# A welcome flow owns the whole client area until PC setup is complete.
function Task-SetupPlan($Facts, [string]$Mode, [bool]$Configured, [bool]$Running, [bool]$Preparing, [bool]$Wanted = $true, [bool]$Failed = $false) {
    $taskHave = $null -ne $Facts
    $taskSteps = New-Object Collections.Generic.List[object]
    # Routine address/certificate observations must not take the welcome flow
    # away from an already validated phone QR.
    $taskPrepare = if ($taskHave -and $Facts.certificate) { 'done' } elseif ($Preparing) { 'checking' } elseif ($Failed -or $Facts.checkError) { 'error' } elseif ($Configured -and !$taskHave) { 'checking' } else { 'error' }
    $taskSteps.Add(@{ id='prepare'; name='Подготовка'; state=$taskPrepare; text='Готовим настройки и защищённое подключение.'; action='start' })
    $taskSteps.Add(@{ id='runtime'; name='Запуск'; state=$(if ($Running -and $Facts.localHttps) { 'done' } elseif ($taskPrepare -ne 'done') { 'blocked' } elseif ($Wanted -and !$Failed) { 'checking' } else { 'error' }); text='Запускаем ноду на этом ПК.'; action='start' })
    $taskSteps.Add(@{ id='trust'; name='Защита ПК'; state=$(if ($Facts.trusted -and $Facts.certificate) { 'done' } elseif ($taskPrepare -ne 'done') { 'blocked' } else { 'action' }); text='Разрешите сертификат своей ноды для приложения на этом ПК.'; action='trust' })
    if (!(Task-AppOriginReady)) {
        $taskSteps.Add(@{ id='app-origin'; name='Сайт Automesh'; state='action'; text=('В настройках остался другой сайт. Разрешите подключение из '+$script:taskSetupAppOrigin+'. Остальные разрешённые сайты сохранятся.'); action='app-origin' })
    }
    $taskSteps.Add(@{ id='pc-pair'; name='Automesh на ПК'; state=$(if ($script:taskSetupPcPaired -or $script:taskSetupMemberCount -gt 0) { 'done' } else { 'action' }); text='Скопируем приглашение и откроем Automesh. В приложении: Связь и ноды → Мои ноды → Подключить ноду. Вставьте приглашение.'; action='pc-pair' })
    if ($Mode -ne 'pc') {
        $taskSteps.Add(@{ id='network'; name='Домашняя сеть'; state=$(if (!$taskHave) { 'blocked' } elseif ($Facts.privateNetwork) { 'done' } else { 'action' }); text='Подключите ПК и телефон к одной домашней сети. В Windows у неё должен быть профиль «Частная».'; action='network' })
        $taskSteps.Add(@{ id='firewall'; name='Доступ телефона'; state=$(if ($Facts.firewall -eq 'ready' -and $Facts.privateNetwork) { 'done' } elseif (!$Facts.privateNetwork) { 'blocked' } else { 'action' }); text='Разрешите телефону подключаться к ноде. Windows запросит подтверждение.'; action='firewall' })
        $taskSteps.Add(@{ id='lan'; name='Проверка связи'; state=$(if ($Facts.lanHttps -and $Facts.privateNetwork -and $Facts.firewall -eq 'ready') { 'done' } elseif (!$taskHave -or !$Facts.privateNetwork -or $Facts.firewall -ne 'ready') { 'blocked' } elseif ($Preparing) { 'checking' } else { 'error' }); text='Проверяем домашний адрес ноды.'; action='check' })
        $taskSteps.Add(@{ id='phone-certificate'; name='Защита телефона'; state=$(if ($script:taskSetupPhoneCertificate) { 'done' } else { 'action' }); text='Сохраните публичный сертификат, передайте его на телефон и установите доверие.'; action='phone-certificate' })
        $taskSteps.Add(@{ id='phone-pair'; name='QR телефона'; state=$(if ($script:taskSetupPhonePaired) { 'done' } else { 'action' }); text='В Automesh на телефоне откройте подключение ноды и отсканируйте QR.'; action='phone-pair' })
    }
    return $taskSteps.ToArray()
}
function Task-BuildSetup {
    $script:taskSetupAppOrigin=$taskDeployment.appOrigin
    $script:taskSetupMode = 'pc'; $script:taskSetupPhase = 'boot'; $script:taskSetupBootAt = Get-Date
    $taskSetupOverview = New-Object Windows.Forms.FlowLayoutPanel
    $taskSetupOverview.AutoSize=$true; $taskSetupOverview.FlowDirection='TopDown'; $taskSetupOverview.WrapContents=$false
    $taskDashboard.Controls.Add($taskSetupOverview); $taskDashboard.Controls.SetChildIndex($taskSetupOverview, 1)
    $script:taskSetupSummary = Task-Text $taskSetupOverview 'Проверяем готовность…'
    $script:taskSetupIndicators = New-Object Windows.Forms.FlowLayoutPanel
    $script:taskSetupIndicators.AutoSize=$true; $script:taskSetupIndicators.Width=680; $taskSetupOverview.Controls.Add($script:taskSetupIndicators)
    Task-Action $taskSetupOverview 'Подключить телефон / помощник запуска' { Task-ShowSetup } | Out-Null
    $script:taskSetupOverlay = New-Object Windows.Forms.Panel
    $script:taskSetupOverlay.Dock='Fill'; $script:taskSetupOverlay.BackColor=[Drawing.Color]::White
    $taskForm.Controls.Add($script:taskSetupOverlay)
    $script:taskSetupContent = New-Object Windows.Forms.FlowLayoutPanel
    $script:taskSetupContent.Dock='Fill'; $script:taskSetupContent.Padding=New-Object Windows.Forms.Padding(28)
    $script:taskSetupContent.FlowDirection='TopDown'; $script:taskSetupContent.WrapContents=$false; $script:taskSetupContent.AutoScroll=$true
    $script:taskSetupOverlay.Controls.Add($script:taskSetupContent)
    $script:taskSetupHeading = Task-Text $script:taskSetupContent 'Добро пожаловать в Automesh Node'
    $script:taskSetupHeading.Font=New-Object Drawing.Font('Segoe UI',20,[Drawing.FontStyle]::Bold)
    $script:taskSetupIntro = Task-Text $script:taskSetupContent 'Проверяем ноду на этом ПК…'
    $script:taskSetupWelcome = New-Object Windows.Forms.FlowLayoutPanel
    $script:taskSetupWelcome.AutoSize=$true; $script:taskSetupWelcome.Width=670
    $script:taskSetupContent.Controls.Add($script:taskSetupWelcome)
    $script:taskSetupPcButton = Task-Action $script:taskSetupWelcome 'ПК' { Task-ChooseSetup 'pc' }
    $script:taskSetupBothButton = Task-Action $script:taskSetupWelcome 'ПК + телефон' { Task-ChooseSetup 'both' }
    foreach ($taskButton in @($script:taskSetupPcButton,$script:taskSetupBothButton)) {
        $taskButton.AutoSize=$false; $taskButton.Size=New-Object Drawing.Size(300,115)
        $taskButton.Font=New-Object Drawing.Font('Segoe UI',18,[Drawing.FontStyle]::Bold)
        $taskButton.Margin=New-Object Windows.Forms.Padding(0,16,16,16)
        $taskButton.FlatStyle='Flat'; $taskButton.FlatAppearance.BorderColor=[Drawing.Color]::LightSteelBlue
        $taskButton.BackColor=[Drawing.Color]::AliceBlue
    }
    $script:taskSetupSkipPhone = Task-Action $script:taskSetupContent 'Без телефона — открыть ноду' { Task-FinishSetup }
    $script:taskSetupProgress = Task-Text $script:taskSetupContent ''
    $script:taskSetupMap = New-Object Windows.Forms.FlowLayoutPanel
    $script:taskSetupMap.AutoSize=$true; $script:taskSetupMap.Width=670; $script:taskSetupContent.Controls.Add($script:taskSetupMap)
    $script:taskSetupTitle = Task-Text $script:taskSetupContent ''
    $script:taskSetupTitle.Font=New-Object Drawing.Font('Segoe UI',18,[Drawing.FontStyle]::Bold)
    $script:taskSetupBody = Task-Text $script:taskSetupContent ''
    $script:taskSetupBody.MaximumSize=New-Object Drawing.Size(650,0)
    $script:taskSetupPorts = New-Object Windows.Forms.FlowLayoutPanel
    $script:taskSetupPorts.AutoSize=$true; $script:taskSetupContent.Controls.Add($script:taskSetupPorts)
    Task-Text $script:taskSetupPorts 'Порты ноды / управления:' | Out-Null
    $script:taskSetupPort = Task-Number $script:taskSetupPorts 1024 65535 3003
    $script:taskSetupControlPort = Task-Number $script:taskSetupPorts 1024 65535 3004
    $script:taskSetupPicture = New-Object Windows.Forms.PictureBox
    $script:taskSetupPicture.Size=New-Object Drawing.Size(270,270); $script:taskSetupPicture.SizeMode='Zoom'
    $script:taskSetupContent.Controls.Add($script:taskSetupPicture)
    $script:taskSetupQrTime = Task-Text $script:taskSetupContent ''
    $script:taskSetupAction = Task-Action $script:taskSetupContent 'Продолжить' { Task-SetupAction }
    $script:taskSetupAction.Font=New-Object Drawing.Font('Segoe UI',12,[Drawing.FontStyle]::Bold)
    $script:taskSetupHint = Task-Text $script:taskSetupContent ''
    $script:taskSetupHint.MaximumSize=New-Object Drawing.Size(650,0); $script:taskSetupHint.ForeColor=[Drawing.Color]::DimGray
    $script:taskSetupContent.Add_SizeChanged({
        $taskWidth=[Math]::Max(280,$script:taskSetupContent.ClientSize.Width-72)
        $script:taskSetupMap.Width=$taskWidth; $script:taskSetupWelcome.Width=$taskWidth
        foreach ($taskLabel in @($script:taskSetupHeading,$script:taskSetupIntro,$script:taskSetupBody,$script:taskSetupHint)) { $taskLabel.MaximumSize=New-Object Drawing.Size($taskWidth,0) }
    })
    Task-RenderSetup
}
function Task-SetupRunning { return [bool]($script:taskSetupLastRuntime -and ((Get-Date)-$script:taskSetupLastRuntime).TotalSeconds -lt 8) }
function Task-RecordRuntime($Current) {
    if ($script:taskSetupPicture.Image -and $Current.pairCode -and $Current.pairCode -cne $script:taskSetupQrCode) {
        # A backend restart or an explicit new invitation invalidates the old QR.
        $script:taskSetupPicture.Image.Dispose(); $script:taskSetupPicture.Image=$null; $script:taskSetupViewKey=''
    }
    $script:taskSetupLastRuntime=Get-Date; $script:taskSetupMemberCount=@($Current.members).Count
    if (!$script:taskProcess -and !$script:taskStopping) {
        if (!$script:taskAdoptedRunning) { $script:taskNetworkCheckedAt=Get-Date; $script:taskNetworkPrepared=$true }
        $script:taskAdoptedRunning=$true; $script:taskDesiredRunning=$true
    }
}
function Task-AppOriginReady { return [bool](!$script:taskSetupAppOrigin -or !$script:taskConfig -or $script:taskConfig.allowedOrigins -contains $script:taskSetupAppOrigin) }
function Task-PcReady { return [bool]((Task-SetupRunning) -and !$script:taskStopping -and !$script:taskRestartPending -and (Task-AppOriginReady) -and $script:taskSetupFacts.certificate -and $script:taskSetupFacts.localHttps -and $script:taskSetupFacts.trusted) }
function Task-SetSetupVisible([bool]$Visible) {
    $script:taskSetupOverlay.Visible=$Visible; $taskTabs.Visible=!$Visible; $taskFooter.Visible=!$Visible
    if ($Visible) { $script:taskSetupOverlay.BringToFront() } else { $taskTabs.BringToFront(); $taskFooter.BringToFront() }
}
function Task-InvalidateSetup { $script:taskSetupFacts=$null; $script:taskSetupCheckedAt=[DateTime]::MinValue; $script:taskSetupViewKey='' }
function Task-ShowSetup {
    $script:taskSetupPhase=if (Task-PcReady) { 'phone-choice' } else { 'welcome' }
    $script:taskSetupDismissed=$false; Task-RenderSetup
}
function Task-ChooseSetup([string]$Mode) {
    $script:taskSetupMode=$Mode; $script:taskSetupPhase='steps'; $script:taskSetupDismissed=$false
    $script:taskSetupPhoneCertificate=$false; $script:taskSetupPhonePaired=$false; $script:taskSetupCertificateExported=$false
    $script:taskSetupViewKey=''
    if (!(Task-PcReady)) { if ($script:taskConfig) { Task-Start } else { Task-SaveAndStart } }
    Task-RenderSetup
}
function Task-FinishSetup {
    if (!(Task-PcReady) -or $script:taskNetworkProcess -or $script:taskPendingConfig) { return }
    if ($script:taskSetupPhase -eq 'steps' -and !$script:taskSetupPcPaired -and !($script:taskSetupMemberCount -gt 0)) { return }
    $taskNext=@{}; foreach ($taskKey in $script:taskConfig.Keys) { $taskNext[$taskKey]=$script:taskConfig[$taskKey] }
    $taskNext.setupMode=$script:taskSetupMode; $taskNext.setupCompleted=1
    Task-WriteConfig $taskNext
    $script:taskSetupPhase='overview'; $script:taskSetupPrompt=$false; $script:taskSetupDismissed=$true
    Task-RenderSetup
}
function Task-SetupPairImage([string]$Kind = 'pair') {
    $taskCurrent=Task-Control '/status'
    if (!$taskCurrent.pairCode -or $taskCurrent.pairExpires -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { Task-Control '/pair-code' 'POST' | Out-Null; $taskCurrent=Task-Control '/status' }
    $taskRequest=[Net.HttpWebRequest]::Create(('http://127.0.0.1:'+$script:taskConfig.controlPort+'/qr/'+$Kind))
    $taskRequest.Proxy=$null; $taskRequest.Timeout=3000; $taskRequest.Headers['Authorization']='Bearer '+$script:taskConfig.adminToken
    $taskResponse=$taskRequest.GetResponse(); $taskBytes=New-Object IO.MemoryStream
    try {
        $taskResponse.GetResponseStream().CopyTo($taskBytes); $taskBytes.Position=0; $taskOriginal=[Drawing.Image]::FromStream($taskBytes)
        $taskImage=New-Object Drawing.Bitmap($taskOriginal); $taskOriginal.Dispose()
        if ($script:taskSetupPicture.Image) { $script:taskSetupPicture.Image.Dispose() }
        $script:taskSetupPicture.Image=$taskImage; $script:taskSetupQrExpires=$taskCurrent.pairExpires
        $script:taskSetupQrCode=$taskCurrent.pairCode
        $script:taskSetupQrStamp=Task-ConfigStamp $script:taskConfig
    } finally { $taskBytes.Dispose(); $taskResponse.Close() }
}
function Task-SetupAction {
    try {
        $taskStep=$script:taskSetupActive
        if (!$taskStep) { Task-FinishSetup; return }
        switch ($taskStep.action) {
            'app-origin' {
                $taskOrigin=[Uri]$script:taskSetupAppOrigin
                if (!$taskOrigin.IsAbsoluteUri -or $taskOrigin.Scheme -ne 'https' -or $taskOrigin.GetLeftPart([UriPartial]::Authority) -cne $script:taskSetupAppOrigin) { throw 'invalid_app_origin' }
                $taskNext=@{}; foreach ($taskKey in $script:taskConfig.Keys) { $taskNext[$taskKey]=$script:taskConfig[$taskKey] }
                $taskNext.allowedOrigins=@($script:taskSetupAppOrigin)+@($taskNext.allowedOrigins | Where-Object { $_ -ne $script:taskSetupAppOrigin })
                Task-Stop
                $script:taskPendingConfig=$taskNext; $script:taskPendingAutostart=$taskAuto.Checked
                $script:taskDesiredRunning=$true; $script:taskNetworkPrepared=$false; $script:taskRestartPending=$true
                $taskAppOrigin.Text=$script:taskSetupAppOrigin; Task-InvalidateSetup
            }
            'start' {
                if ($script:taskSetupError -eq 'readiness_failed') { Task-InvalidateSetup; return }
                if ($script:taskSetupError -eq 'manual_address_unavailable') { $taskNetworkAuto.Checked=$true; Task-SaveAndStart; return }
                if ($script:taskSetupError -in @('local_ca_unavailable','local_ca_mismatch','invalid_ca_reference','certificate_key_unavailable') -or ($script:taskSetupFacts -and !$script:taskSetupFacts.checkError -and !$script:taskSetupFacts.certificate)) {
                    if ([Windows.Forms.MessageBox]::Show('Создать новый сертификат своей ноды? Очередь и привязки сохранятся. После этого потребуется заново разрешить сертификат на ПК и телефоне.', 'Восстановить подключение', 'YesNo', 'Warning') -ne 'Yes') { return }
                    $script:taskReplaceCertificate=$true
                }
                if ($script:taskSetupPorts.Visible) { $taskPublicPort.Value=$script:taskSetupPort.Value; $taskControlPort.Value=$script:taskSetupControlPort.Value; Task-SaveAndStart }
                elseif ($script:taskConfig) { Task-Start } else { Task-SaveAndStart }
            }
            'trust' { if (Task-TrustLocal) { $script:taskSetupFacts.trusted=$true } }
            'network' { Start-Process 'ms-settings:network-status'; Task-InvalidateSetup }
            'firewall' { Task-AllowLan; Task-InvalidateSetup }
            'check' { Task-InvalidateSetup }
            'pc-pair' {
                $taskCurrent=Task-Control '/status'
                if (@($taskCurrent.members).Count -gt 0) { $script:taskSetupPcPaired=$true; $script:taskSetupMemberCount=@($taskCurrent.members).Count }
                else {
                    if (!$script:taskSetupPcInviteCopied -or $script:taskSetupPcInviteExpires -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) {
                        if (!$taskCurrent.pairCode -or $taskCurrent.pairExpires -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { Task-Control '/pair-code' 'POST' | Out-Null; $taskCurrent=Task-Control '/status' }
                        $taskInvite=@{ protocol='automesh-node-pair-v1'; url=('https://localhost:'+$script:taskConfig.port+'/'); nodeId=$taskCurrent.nodeId; code=$taskCurrent.pairCode; expiresAt=$taskCurrent.pairExpires } | ConvertTo-Json -Compress
                        [Windows.Forms.Clipboard]::SetText($taskInvite)
                        $taskOrigin=[Uri]$taskAppOrigin.Text.Trim()
                        if (!$taskOrigin.IsAbsoluteUri -or $taskOrigin.Scheme -ne 'https' -or $taskOrigin.UserInfo) { throw 'invalid_app_origin' }
                        Start-Process $taskOrigin.AbsoluteUri
                        $script:taskSetupPcInviteCopied=$true; $script:taskSetupPcInviteExpires=$taskCurrent.pairExpires
                    } else { $script:taskSetupHint.Text='Пока нет привязки. Вставьте скопированное приглашение в Automesh и подключите ноду.'; return }
                }
            }
            'phone-certificate' {
                if (!$script:taskSetupCertificateExported) { $script:taskSetupCertificateExported=[bool](Task-ExportCa) }
                else { $script:taskSetupPhoneCertificate=$true }
            }
            'phone-pair' {
                if (!$script:taskSetupPicture.Image -or $script:taskSetupQrExpires -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { Task-SetupPairImage }
                else { $script:taskSetupPhonePaired=$true }
            }
        }
        $script:taskSetupViewKey=''; Task-RenderSetup
    } catch { $script:taskSetupHint.Text='Действие не завершено. Повторите эту кнопку; очередь сохранена.' }
}
function Task-RenderSetup {
    if (!$script:taskSetupOverlay) { return }
    $taskRunning=Task-SetupRunning
    $taskBusy=[bool]($script:taskNetworkProcess -or $script:taskPendingConfig)
    $taskPlan=@(Task-SetupPlan $script:taskSetupFacts $script:taskSetupMode ([bool]$script:taskConfig) $taskRunning $taskBusy ([bool]$script:taskDesiredRunning) ([bool]$script:taskNetworkWarning))
    $taskRemaining=@($taskPlan | Where-Object state -ne 'done')
    $taskStates=($taskPlan | ForEach-Object { $_.id+':'+$_.state }) -join ','
    $taskKey=@($script:taskSetupPhase,$script:taskSetupMode,$taskStates,$script:taskSetupError,$script:taskSetupCertificateExported,$script:taskSetupPcInviteCopied,[bool]$script:taskSetupPicture.Image,[bool]$script:taskSetupProcess,[bool]$script:taskFirewallProcess) -join '|'
    if ($taskKey -eq $script:taskSetupViewKey) { return }; $script:taskSetupViewKey=$taskKey
    $script:taskSetupSummary.Text=if (Task-PcReady) { 'Нода на ПК готова.' } else { 'Завершите запуск через приветственное окно.' }
    foreach ($taskParent in @($script:taskSetupMap,$script:taskSetupIndicators)) {
        foreach ($taskControl in @($taskParent.Controls)) { $taskParent.Controls.Remove($taskControl); $taskControl.Dispose() }
        foreach ($taskStep in $taskPlan) {
            $taskChip=New-Object Windows.Forms.Label; $taskChip.AutoSize=$true; $taskChip.Padding=New-Object Windows.Forms.Padding(8); $taskChip.Margin=New-Object Windows.Forms.Padding(2)
            $taskChip.Text=[char]0x25CF+' '+$taskStep.name
            $taskChip.ForeColor=switch ($taskStep.state) { 'done' { [Drawing.Color]::SeaGreen } 'error' { [Drawing.Color]::Firebrick } 'checking' { [Drawing.Color]::DarkGoldenrod } 'action' { [Drawing.Color]::DarkGoldenrod } default { [Drawing.Color]::Gray } }
            $taskChip.BackColor=if ($taskStep.state -eq 'done') { [Drawing.Color]::Honeydew } else { [Drawing.Color]::WhiteSmoke }; $taskParent.Controls.Add($taskChip)
        }
    }
    $taskPhase=$script:taskSetupPhase
    Task-SetSetupVisible ($taskPhase -ne 'overview')
    $taskChoosing=$taskPhase -in @('welcome','phone-choice')
    $script:taskSetupWelcome.Visible=$taskChoosing
    $script:taskSetupPcButton.Visible=$taskPhase -eq 'welcome'
    $script:taskSetupSkipPhone.Visible=$taskPhase -eq 'phone-choice' -or ($taskPhase -eq 'steps' -and $script:taskSetupMode -eq 'both' -and (Task-PcReady) -and ($script:taskSetupPcPaired -or $script:taskSetupMemberCount -gt 0))
    $script:taskSetupSkipPhone.Text=if ($taskPhase -eq 'steps') { 'Телефон подключу позже' } else { 'Без телефона — открыть ноду' }
    $script:taskSetupSkipPhone.Enabled=(Task-PcReady) -and !$script:taskNetworkProcess -and !$script:taskPendingConfig
    $script:taskSetupBothButton.Text=if ($taskPhase -eq 'phone-choice') { 'Подключить телефон' } else { 'ПК + телефон' }
    $taskShowingSteps=$taskPhase -eq 'steps'
    foreach ($taskControl in @($script:taskSetupProgress,$script:taskSetupMap,$script:taskSetupTitle,$script:taskSetupBody,$script:taskSetupAction,$script:taskSetupHint)) { $taskControl.Visible=$taskShowingSteps }
    $script:taskSetupPorts.Visible=$false; $script:taskSetupPicture.Visible=$false; $script:taskSetupQrTime.Visible=$false
    $script:taskSetupHeading.Text=if ($taskChoosing) { 'Добро пожаловать в Automesh Node' } elseif ($taskPhase -eq 'boot') { 'Проверяем ноду' } else { 'Подключение Automesh Node' }
    $script:taskSetupIntro.Text=switch ($taskPhase) { 'welcome' { 'Где будете пользоваться нодой?' } 'phone-choice' { 'Нода на ПК уже работает. Подключить телефон?' } 'boot' { 'Это займёт несколько секунд.' } default { '' } }
    if (!$taskShowingSteps) { return }
    $script:taskSetupProgress.Text='Готово: '+($taskPlan.Count-$taskRemaining.Count)+' из '+$taskPlan.Count
    $script:taskSetupActive=$taskRemaining | Select-Object -First 1
    $script:taskSetupAction.Enabled=!$script:taskNetworkProcess -and !$script:taskFirewallProcess -and !$script:taskSetupProcess -and !$script:taskPendingConfig
    $script:taskSetupHint.Text=''
    if (!$script:taskSetupActive) {
        $script:taskSetupTitle.Text='Готово'; $script:taskSetupBody.Text='Нода работает. Можно открыть обзор.'; $script:taskSetupAction.Text='Открыть ноду'; return
    }
    $taskStep=$script:taskSetupActive
    $script:taskSetupTitle.Text=$taskStep.name; $script:taskSetupBody.Text=$taskStep.text
    $script:taskSetupAction.Text=switch ($taskStep.action) { 'trust' { 'Разрешить сертификат' } 'network' { 'Выбрать домашнюю сеть' } 'firewall' { 'Разрешить доступ телефона' } 'start' { 'Повторить запуск' } 'pc-pair' { if ($script:taskSetupPcInviteCopied) { 'Проверить подключение Automesh' } else { 'Скопировать приглашение и открыть Automesh' } } 'phone-certificate' { if ($script:taskSetupCertificateExported) { 'Сертификат установлен — далее' } else { 'Сохранить сертификат' } } 'phone-pair' { if ($script:taskSetupPicture.Image) { 'Подключение на телефоне проверено — готово' } else { 'Показать QR' } } default { 'Проверить снова' } }
    if ($taskStep.action -eq 'app-origin') { $script:taskSetupAction.Text='Разрешить этот сайт' }
    if ($taskStep.state -in @('checking','blocked')) { $script:taskSetupAction.Enabled=$false; $script:taskSetupAction.Text='Выполняем…' }
    if ($taskStep.id -eq 'prepare' -and $taskStep.state -eq 'error') {
        $script:taskSetupBody.Text=switch ($script:taskSetupError) { 'local_ca_unavailable' { 'Ключ сертификата недоступен. Восстановим сертификат, сохранив очередь.' } 'local_ca_mismatch' { 'Сертификат не совпадает с сохранённым. Восстановим подключение, сохранив очередь.' } 'manual_address_unavailable' { 'Выбранный адрес изменился. Вернём автоматический выбор домашней сети.' } 'readiness_failed' { 'Проверка подключения не завершилась. Повторим проверку.' } default { if ($script:taskNetworkWarning) { $script:taskNetworkWarning } else { 'Не удалось подготовить подключение. Повторите запуск.' } } }
        if ($script:taskSetupError -eq 'manual_address_unavailable') { $script:taskSetupAction.Text='Использовать текущую сеть' }
    }
    if ($taskStep.id -eq 'runtime' -and $taskStep.state -eq 'error') {
        $script:taskSetupBody.Text=switch ($script:taskSetupError) {
            'EADDRINUSE' { 'Один из портов занят. Выберите другие порты и продолжите.' }
            'invalid_node_primary_address' { 'Основной адрес ноды не совпадает с домашней сетью. Повторный запуск восстановит его автоматически.' }
            'invalid_node_config_or_lan_changed' { 'Параметры ноды не прошли проверку. Повторный запуск заново подготовит домашние адреса.' }
            'installed_package_invalid' { 'Файлы установленной ноды не прошли проверку. Установите новый пакет поверх; очередь сохранится.' }
            { $_ -in @('EACCES','EPERM') } { 'Windows запретила доступ. Проверьте разрешения и уведомления защиты Windows, затем повторите запуск.' }
            { $_ -in @('node_secret_protection_unavailable','node_secret_protection_failed') } { 'Не удалось открыть защищённые ключи. Запустите ноду из того же профиля Windows, где она была настроена.' }
            { $_ -in @('corrupt_node_state','corrupt_mailbox','mailbox_disk_limit') } { 'Не удалось прочитать сохранённую очередь. Данные не удалены; требуется диагностика.' }
            default { 'Нода не ответила. Повторите запуск; очередь сохранена.' }
        }
        if ($script:taskSetupError) { $script:taskSetupHint.Text='Код: '+$script:taskSetupError }
        if ($script:taskSetupError -eq 'EADDRINUSE') { $script:taskSetupPorts.Visible=$true; $script:taskSetupAction.Text='Применить и запустить' }
    }
    if ($taskStep.id -eq 'phone-certificate') { $script:taskSetupHint.Text='На iPhone после установки включите доверие: Настройки → Основные → Об этом устройстве → Доверие сертификатам. Телефон должен быть в домашней сети.' }
    if ($taskStep.id -eq 'phone-pair') {
        $script:taskSetupPicture.Visible=[bool]$script:taskSetupPicture.Image
        $script:taskSetupQrTime.Visible=[bool]$script:taskSetupPicture.Image
        $script:taskSetupHint.Text='Подтвердите готовность только после успешного подключения в Automesh на телефоне. Если браузер попросит доступ к локальной сети — разрешите его.'
    }
}
function Task-SetupTick {
    if (!$script:taskSetupOverlay) { return }
    if ($script:taskSetupProcess -and !$script:taskSetupProcess.HasExited -and ((Get-Date)-$script:taskSetupStartedAt).TotalSeconds -gt 45) { $script:taskSetupProcess.Kill() }
    if ($script:taskSetupProcess -and $script:taskSetupProcess.HasExited) {
        $taskAccepted=$false
        try {
            if ($script:taskSetupProcess.ExitCode -ne 0) { throw 'readiness_failed' }
            $taskFacts=$script:taskSetupProcess.StandardOutput.ReadToEnd() | ConvertFrom-Json
            if ($taskFacts.stamp -eq (Task-ConfigStamp $script:taskConfig)) { $script:taskSetupFacts=$taskFacts; $taskAccepted=$true; if ($script:taskSetupError -eq 'readiness_failed') { $script:taskSetupError='' } }
        } catch { $script:taskSetupFacts=@{ stamp=(Task-ConfigStamp $script:taskConfig); checkError=$true }; $script:taskSetupError='readiness_failed'; $taskAccepted=$true }
        finally { $script:taskSetupProcess.Dispose(); $script:taskSetupProcess=$null; $script:taskSetupCheckedAt=if ($taskAccepted) { Get-Date } else { [DateTime]::MinValue } }
    }
    if ($script:taskSetupFacts -and $script:taskSetupFacts.stamp -ne (Task-ConfigStamp $script:taskConfig)) { Task-InvalidateSetup }
    # Read-only observations do not depend on the backend having started.
    $taskInterval=if ($script:taskSetupFacts.certificate -and $script:taskSetupFacts.localHttps) { 60 } else { 15 }
    if ($script:taskConfig -and !$script:taskSetupProcess -and !$script:taskNetworkProcess -and !$script:taskPendingConfig -and !$script:taskFirewallProcess -and
        (!$script:taskSetupCheckedAt -or ((Get-Date)-$script:taskSetupCheckedAt).TotalSeconds -gt $taskInterval)) {
        $taskInfo=New-Object Diagnostics.ProcessStartInfo
        $taskInfo.FileName=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $taskInfo.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $script:taskProgramRoot 'launcher.ps1')+'" -CheckReadiness -WorkerConfig "'+$script:taskConfigFile+'"'
        $taskInfo.UseShellExecute=$false; $taskInfo.CreateNoWindow=$true; $taskInfo.RedirectStandardOutput=$true; $taskInfo.RedirectStandardError=$true
        $script:taskSetupProcess=[Diagnostics.Process]::Start($taskInfo); $script:taskSetupStartedAt=Get-Date
    }
    if ($script:taskSetupPhase -eq 'boot' -and (!$script:taskConfig -or $script:taskSetupFacts -or ((Get-Date)-$script:taskSetupBootAt).TotalSeconds -gt 46)) {
        $script:taskSetupPhase=if (Task-PcReady) { if ($script:taskConfig.setupCompleted -eq 1) { 'overview' } else { 'phone-choice' } } else { 'welcome' }
        if ($Background -and $script:taskSetupPhase -ne 'overview') { $taskForm.Show(); $taskForm.WindowState='Normal' }
    }
    if ($script:taskSetupPhase -eq 'steps' -and !$script:taskNetworkProcess -and !$script:taskPendingConfig -and $script:taskSetupFacts.certificate -and $script:taskDesiredRunning -and !(Task-SetupRunning) -and $script:taskBackendStartedAt -and ((Get-Date)-$script:taskBackendStartedAt).TotalSeconds -gt 40) {
        $script:taskNetworkWarning='Нода не ответила после запуска. Проверьте порты и повторите запуск.'; $script:taskSetupError=if ($script:taskStartError) { $script:taskStartError } else { 'startup_timeout' }; $script:taskDesiredRunning=$false
    }
    if ($script:taskSetupPicture.Image) {
        $taskSeconds=[Math]::Max(0,[Math]::Ceiling(($script:taskSetupQrExpires-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())/1000))
        if (!$taskSeconds -or $script:taskSetupQrStamp -ne (Task-ConfigStamp $script:taskConfig)) {
            $script:taskSetupPicture.Image.Dispose(); $script:taskSetupPicture.Image=$null; $script:taskSetupViewKey=''
        } else { $script:taskSetupQrTime.Text='QR действителен ещё '+[TimeSpan]::FromSeconds($taskSeconds).ToString('mm\:ss') }
    }
    Task-RenderSetup
}
