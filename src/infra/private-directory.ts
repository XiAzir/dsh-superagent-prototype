/** State-directory permissions: Unix mode bits and an inheritable owner-only Windows DACL. */
import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

/** Protect the configured state directory before SQLite, command shims or logs are created. */
export function protectStateDirectory(directory: string): void {
  const canonical = (path: string): string => {
    let absolute: string
    try { absolute = realpathSync(path) } catch { absolute = resolve(path) }
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  const target = canonical(directory)
  if (target === canonical(dirname(target)) || target === canonical(homedir()) || target === canonical(process.cwd())) {
    throw new Error('Choose a dedicated state subdirectory, not a filesystem root, home directory or current workspace')
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') { chmodSync(directory, 0o700); return }
  if (lstatSync(directory).isSymbolicLink()) throw new Error('The state directory must be a real directory, not a link')
  // The path travels as data in the environment, never as interpolated PowerShell source.
  const script = `$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$directory = [System.IO.DirectoryInfo]::new($env:DSH_PRIVATE_STATE_DIRECTORY)
$acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($directory, [System.Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($existing) }
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.FileSystemAclExtensions]::SetAccessControl($directory, $acl)
`
  execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, DSH_PRIVATE_STATE_DIRECTORY: directory }, windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
}
