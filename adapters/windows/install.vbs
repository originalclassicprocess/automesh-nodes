Option Explicit
Dim shell, files, root, status
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
' Wait for expansion/installation before IExpress removes its temporary files.
status = shell.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & root & "\install.ps1""", 0, True)
If status <> 0 Then MsgBox "Automesh Node installation failed. No account data was changed.", 16, "Automesh Node"
