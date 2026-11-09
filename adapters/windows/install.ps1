param([string]$ValidatePayloadOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Test-TaskPayload([string]$Path) {
    $taskAllowed = @('node.exe','node.cjs','launch.vbs','launcher.ps1','node-ui.ps1','setup.ps1','secret-store.ps1','firewall.ps1','uninstall.vbs','uninstall.ps1','LICENSE-Node.txt','LICENSE-ws.txt','LICENSE-qrcode.txt','LICENSE-pngjs.txt','LICENSE-dijkstrajs.txt','LICENSE-Automesh.txt','THIRD-PARTY-NOTICES.txt','node-build.json')
    $taskZip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        if ($taskZip.Entries.Count -ne $taskAllowed.Count) { throw 'Incomplete installer' }
        $taskSeen = @{}; [long]$taskTotal = 0
        foreach ($taskEntry in $taskZip.Entries) {
            if ($taskEntry.FullName -cnotin $taskAllowed -or $taskSeen.ContainsKey($taskEntry.FullName)) { throw 'Unexpected or duplicate installer entry' }
            $taskSeen[$taskEntry.FullName] = $true
            if ($taskEntry.Length -le 0 -or $taskEntry.Length -gt 100MB) { throw 'Installer entry limit' }
            $taskTotal += $taskEntry.Length
            if ($taskTotal -gt 160MB) { throw 'Installer size limit' }
        }
        $taskBuild = $taskZip.GetEntry('node-build.json')
        if ($taskBuild.Length -gt 32768) { throw 'Installer manifest limit' }
        $taskReader = New-Object IO.StreamReader($taskBuild.Open(), [Text.Encoding]::UTF8)
        try { $taskManifest = $taskReader.ReadToEnd() | ConvertFrom-Json } finally { $taskReader.Dispose() }
        if (@($taskManifest.files.PSObject.Properties).Count -ne ($taskAllowed.Count - 1)) { throw 'Incomplete installer manifest' }
        foreach ($taskName in $taskAllowed) {
            if ($taskName -eq 'node-build.json') { continue }
            $taskEntry = $taskZip.GetEntry($taskName); $taskExpected = $taskManifest.files.$taskName
            if ($taskExpected.bytes -ne $taskEntry.Length -or $taskExpected.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid installer manifest' }
            $taskStream = $taskEntry.Open(); $taskHash = [Security.Cryptography.SHA256]::Create()
            try { $taskDigest = ([BitConverter]::ToString($taskHash.ComputeHash($taskStream))).Replace('-', '').ToLowerInvariant() }
            finally { $taskStream.Dispose(); $taskHash.Dispose() }
            if ($taskDigest -cne $taskExpected.sha256) { throw 'Installer checksum mismatch' }
        }
    } finally { $taskZip.Dispose() }
}
# Test mode validates bytes only: it does not install, launch, or change the user's node.
if ($ValidatePayloadOnly) { Test-TaskPayload $ValidatePayloadOnly; exit 0 }
Add-Type -AssemblyName System.Windows.Forms
$taskInstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\AutomeshNode'
if ([System.Windows.Forms.MessageBox]::Show('Install Automesh Node for this Windows user? The node stores encrypted message envelopes. Optional outgoing internet delivery must be enabled in the node and client settings. No seed phrase is required.', 'Automesh Node', 'OKCancel', 'Information') -ne 'OK') { exit 0 }
try {
    Test-TaskPayload (Join-Path $PSScriptRoot 'payload.zip')
    foreach ($taskParent in @($env:LOCALAPPDATA, (Join-Path $env:LOCALAPPDATA 'Programs'), $taskInstallRoot)) {
        if ((Test-Path -LiteralPath $taskParent) -and ((Get-Item -LiteralPath $taskParent).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected installation path' }
    }
    if (Test-Path -LiteralPath (Join-Path $taskInstallRoot 'node.exe')) {
        [System.Windows.Forms.MessageBox]::Show('Close Automesh Node using its tray menu before updating. Stored data will be preserved.', 'Automesh Node', 'OK', 'Information') | Out-Null
        $taskRunning = Get-Process node -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq (Join-Path $taskInstallRoot 'node.exe') } catch { $false } }
        if ($taskRunning) { throw 'Node is still running' }
    }
    New-Item -ItemType Directory -Path $taskInstallRoot -Force | Out-Null
    if ((Get-Item -LiteralPath $taskInstallRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected installation directory' }
    $taskArchive = [IO.Compression.ZipFile]::OpenRead((Join-Path $PSScriptRoot 'payload.zip'))
    try {
        $taskAllowed = @('node.exe','node.cjs','launch.vbs','launcher.ps1','node-ui.ps1','setup.ps1','secret-store.ps1','firewall.ps1','uninstall.vbs','uninstall.ps1','LICENSE-Node.txt','LICENSE-ws.txt','LICENSE-qrcode.txt','LICENSE-pngjs.txt','LICENSE-dijkstrajs.txt','LICENSE-Automesh.txt','THIRD-PARTY-NOTICES.txt','node-build.json')
        foreach ($taskEntry in $taskArchive.Entries) { if ($taskEntry.FullName -notin $taskAllowed) { throw 'Unexpected installer entry' } }
        # Validate ALL existing targets before writing any program file.
        foreach ($taskEntry in $taskArchive.Entries) {
            $taskTarget = Join-Path $taskInstallRoot $taskEntry.FullName
            if (Test-Path -LiteralPath $taskTarget) {
                $taskItem = Get-Item -LiteralPath $taskTarget
                if ($taskItem.PSIsContainer -or ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected installed file' }
            }
        }
        foreach ($taskEntry in $taskArchive.Entries) { [IO.Compression.ZipFileExtensions]::ExtractToFile($taskEntry, (Join-Path $taskInstallRoot $taskEntry.FullName), $true) }
    } finally { $taskArchive.Dispose() }
    $taskShell = New-Object -ComObject WScript.Shell
    $taskShortcut = $taskShell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Automesh Node.lnk'))
    $taskShortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $taskShortcut.Arguments = '"' + (Join-Path $taskInstallRoot 'launch.vbs') + '"'
    $taskShortcut.WorkingDirectory = $taskInstallRoot
    $taskShortcut.Save()
    $taskUninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AutomeshNode'
    New-Item -Path $taskUninstall -Force | Out-Null
    Set-ItemProperty -Path $taskUninstall -Name 'DisplayName' -Value 'Automesh Node (preview)'
    Set-ItemProperty -Path $taskUninstall -Name 'InstallLocation' -Value $taskInstallRoot
    Set-ItemProperty -Path $taskUninstall -Name 'UninstallString' -Value ('"' + (Join-Path $env:WINDIR 'System32\wscript.exe') + '" "' + (Join-Path $taskInstallRoot 'uninstall.vbs') + '"')
    Set-ItemProperty -Path $taskUninstall -Name 'NoModify' -Value 1
    Set-ItemProperty -Path $taskUninstall -Name 'NoRepair' -Value 1
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $taskInstallRoot 'launch.vbs') + '"') -WindowStyle Hidden
} catch {
    [System.Windows.Forms.MessageBox]::Show('Installation could not complete. Close the existing node and check permissions and disk space. Existing account and queue data are not deleted.', 'Automesh Node', 'OK', 'Error') | Out-Null
    exit 1
}
