import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type FeishuCliMode = 'never' | 'warn' | 'ready' | 'flaky' | 'events' | 'late'

/** Writes a Node or PowerShell test CLI that runs as one process on the current platform. */
export function writeFeishuCli(directory: string, mode: FeishuCliMode): string {
  if (process.platform === 'win32') {
    const launcher = join(directory, 'lark-bot.ps1')
    const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`
    const script = `$ErrorActionPreference = 'Stop'
$directory = ${psQuote(directory)}
$mode = ${psQuote(mode)}
if ($args.Count -lt 1 -or $args[0] -ne 'event') { [Console]::Out.WriteLine('{"ok":true,"data":{}}'); exit 0 }
$runs = Join-Path $directory 'runs'
$count = 1
if (Test-Path $runs) { $count = [int][IO.File]::ReadAllText($runs) + 1 }
[IO.File]::WriteAllText($runs, [string]$count)
[IO.File]::WriteAllText((Join-Path $directory 'pid'), [string]$PID)
function Wait-Forever { while ($true) { Start-Sleep -Seconds 1 } }
switch ($mode) {
  'never' { Wait-Forever }
  'warn' { [Console]::Error.WriteLine('[event] ready'); [Console]::Error.WriteLine('WARN the connection was reset'); Wait-Forever }
  'ready' { [Console]::Error.WriteLine('[event] ready'); Wait-Forever }
  'flaky' { [Console]::Error.WriteLine('[event] ready'); if ($count -eq 1) { exit 1 }; Wait-Forever }
  'events' { [Console]::Error.WriteLine('[event] ready'); [Console]::Out.Write([IO.File]::ReadAllText((Join-Path $directory 'events'))); [IO.File]::WriteAllText((Join-Path $directory 'printed'), ''); Wait-Forever }
  'late' { [Console]::Error.WriteLine('[event] ready'); Start-Sleep -Milliseconds 1000; [Console]::Out.Write([IO.File]::ReadAllText((Join-Path $directory 'events'))); [IO.File]::WriteAllText((Join-Path $directory 'printed'), ''); Wait-Forever }
}
`
    writeFileSync(launcher, script)
    return launcher
  }
  const script = join(directory, 'lark-bot.js')
  const source = `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const directory = ${JSON.stringify(directory)}
const mode = ${JSON.stringify(mode)}
if (process.argv[2] !== 'event') { process.stdout.write('{"ok":true,"data":{}}\\n'); process.exit(0) }
const runs = join(directory, 'runs')
const count = Number(existsSync(runs) ? readFileSync(runs, 'utf8') : 0) + 1
writeFileSync(runs, String(count))
writeFileSync(join(directory, 'pid'), String(process.pid))
const wait = () => setTimeout(() => {}, 60_000)
const ready = () => process.stderr.write('[event] ready\\n')
switch (mode) {
  case 'never': wait(); break
  case 'warn': ready(); process.stderr.write('WARN the connection was reset\\n'); wait(); break
  case 'ready': ready(); wait(); break
  case 'flaky': ready(); if (count > 1) wait(); else process.exit(1); break
  case 'events': ready(); process.stdout.write(readFileSync(join(directory, 'events'), 'utf8')); writeFileSync(join(directory, 'printed'), ''); wait(); break
  case 'late': ready(); setTimeout(() => { process.stdout.write(readFileSync(join(directory, 'events'), 'utf8')); writeFileSync(join(directory, 'printed'), '') }, 1000); wait(); break
}
`
  writeFileSync(script, source)
  const launcher = join(directory, 'lark-bot')
  writeFileSync(launcher, `#!/usr/bin/env node\n${source}`)
  chmodSync(launcher, 0o755)
  return launcher
}
