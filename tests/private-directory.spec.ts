import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { expect, it } from 'vitest'
import { protectStateDirectory } from '../src/infra/private-directory.ts'

it('refuses broad state locations before altering permissions', () => {
  for (const directory of [parse(process.cwd()).root, homedir(), process.cwd()]) {
    expect(() => protectStateDirectory(directory)).toThrow('dedicated state subdirectory')
  }
})

it('protects a state directory and its new files using the native permission model', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-private-'))
  const dir = join(root, 'state with spaces')
  try {
    protectStateDirectory(dir)
    protectStateDirectory(dir)
    if (process.platform === 'win32') {
      writeFileSync(join(dir, 'state.sqlite'), 'fixture')
      const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $dir=Get-Acl -LiteralPath $env:DSH_ACL_TEST_DIRECTORY; $file=Get-Acl -LiteralPath (Join-Path $env:DSH_ACL_TEST_DIRECTORY 'state.sqlite'); @{protected=$dir.AreAccessRulesProtected; dirSids=@($dir.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object {$_.IdentityReference.Value}); fileSids=@($file.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object {$_.IdentityReference.Value}); sid=$sid}|ConvertTo-Json -Compress`
      const acl = JSON.parse(execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, env: { ...process.env, DSH_ACL_TEST_DIRECTORY: dir } })) as { protected: boolean; dirSids: string[]; fileSids: string[]; sid: string }
      expect(acl.protected).toBe(true)
      expect(acl.dirSids).toEqual([acl.sid])
      expect(new Set(acl.fileSids)).toEqual(new Set([acl.sid]))
    } else expect(statSync(dir).mode & 0o777).toBe(0o700)
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 20000)
