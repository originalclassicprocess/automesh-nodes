$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$taskExpected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\AutomeshNode'))
if ([IO.Path]::GetFullPath($PSScriptRoot) -ne $taskExpected -or ((Get-Item -LiteralPath $PSScriptRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected installation directory' }
if ([Windows.Forms.MessageBox]::Show('Close Automesh Node from its tray menu, then continue to uninstall. Stored envelopes and configuration will be preserved in LocalAppData\AutomeshNode.', 'Automesh Node', 'OKCancel', 'Warning') -ne 'OK') { exit 0 }
$taskActive = Get-Process node -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq (Join-Path $taskExpected 'node.exe') } catch { $false } }
if ($taskActive) { [Windows.Forms.MessageBox]::Show('The node is still running. Close it from the tray menu first.', 'Automesh Node') | Out-Null; exit 1 }
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AutomeshNode' -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AutomeshNode' -ErrorAction SilentlyContinue
$taskShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Automesh Node.lnk'
if (Test-Path -LiteralPath $taskShortcut) { Remove-Item -LiteralPath $taskShortcut }
# Delete only known installed files, never recurse into a computed directory.
foreach ($taskFile in @('node.exe','node.cjs','launch.vbs','launcher.ps1','node-ui.ps1','setup.ps1','secret-store.ps1','firewall.ps1','uninstall.vbs','uninstall.ps1','LICENSE-Node.txt','LICENSE-ws.txt','LICENSE-qrcode.txt','LICENSE-pngjs.txt','LICENSE-dijkstrajs.txt','LICENSE-Automesh.txt','THIRD-PARTY-NOTICES.txt','node-build.json')) {
    $taskTarget = Join-Path $taskExpected $taskFile
    if (Test-Path -LiteralPath $taskTarget) { Remove-Item -LiteralPath $taskTarget }
}
if (!(Get-ChildItem -LiteralPath $taskExpected -Force)) { Remove-Item -LiteralPath $taskExpected }
[Windows.Forms.MessageBox]::Show('Automesh Node removed. Queue/configuration and its non-exportable CA renewal key in CurrentUser/My were preserved for reinstall. If enabled, its scoped firewall rule and trusted CA remain. When permanently retiring this node, remove its trust, CA key and firewall permission through Windows settings.', 'Automesh Node') | Out-Null
