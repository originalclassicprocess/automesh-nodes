Option Explicit
Dim shell, files, root, arguments
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
arguments = ""
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "--background" Then arguments = " -Background"
End If
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & root & "\launcher.ps1""" & arguments, 0, False
