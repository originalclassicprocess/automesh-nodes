param([switch]$Pipe)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

# Same-user DPAPI: no application password, machine-wide scope, or plaintext file.
function Protect-TaskSecret([byte[]]$Bytes, [string]$Purpose) {
    if ($Purpose -notin @('automesh-node-config-v1', 'automesh-node-courier-v1')) { throw 'Invalid secret purpose' }
    $taskEntropy = [Text.Encoding]::UTF8.GetBytes($Purpose)
    return [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($Bytes, $taskEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser))
}
function Unprotect-TaskSecret([string]$Ciphertext, [string]$Purpose) {
    if ($Purpose -notin @('automesh-node-config-v1', 'automesh-node-courier-v1') -or $Ciphertext.Length -gt 32768) { throw 'Invalid protected secret' }
    $taskEntropy = [Text.Encoding]::UTF8.GetBytes($Purpose)
    return ,([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($Ciphertext), $taskEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser))
}
function Set-TaskPrivateDirectory([string]$Path) {
    $taskItem = Get-Item -LiteralPath $Path
    if (!$taskItem.PSIsContainer -or ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe data directory' }
    $taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $taskAcl = New-Object Security.AccessControl.DirectorySecurity
    # Modify only the DACL. Reassigning owner or writing audit/SACL sections
    # through Set-Acl can require SeSecurityPrivilege on subsequent launches.
    # The existing owner is preserved; normal user WRITE_DAC rights suffice.
    $taskAcl.SetAccessRuleProtection($true, $false)
    foreach ($taskPrincipal in @($taskUser, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $taskRule = New-Object Security.AccessControl.FileSystemAccessRule($taskPrincipal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $taskAcl.AddAccessRule($taskRule)
    }
    [IO.Directory]::SetAccessControl($Path, $taskAcl)
}
if ($Pipe) {
    $taskSecretBytes = $null
    try {
        $taskInput = [Console]::In.ReadToEnd()
        if ($taskInput.Length -gt 32768) { throw 'Input limit' }
        $taskRequest = $taskInput | ConvertFrom-Json
        if ($taskRequest.operation -eq 'protect') {
            $taskSecretBytes = [Convert]::FromBase64String($taskRequest.data)
            [Console]::Out.Write((Protect-TaskSecret $taskSecretBytes $taskRequest.purpose))
        } elseif ($taskRequest.operation -eq 'unprotect') {
            $taskSecretBytes = Unprotect-TaskSecret $taskRequest.data $taskRequest.purpose
            [Console]::Out.Write([Convert]::ToBase64String($taskSecretBytes))
        } else { throw 'Invalid operation' }
    } catch { [Console]::Error.Write('node_secret_protection_failed'); exit 1 }
    finally { if ($taskSecretBytes) { [Array]::Clear($taskSecretBytes, 0, $taskSecretBytes.Length) } }
}
