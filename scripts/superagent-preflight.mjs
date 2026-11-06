#!/usr/bin/env node
/** Read-only main Runtime inspection and optional explicit SQLite-only export. */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const built = new URL('../lib/runtime-manifest.js', import.meta.url), source = new URL('../src/app/runtime-manifest.ts', import.meta.url)
try {
  const implementation = await import(existsSync(fileURLToPath(built)) ? built.href : source.href)
  await implementation.runPreflightCli()
} catch {
  process.stdout.write(JSON.stringify({ status: 'error', exitCode: 3, issues: ['preflight_arguments_or_export_failed'] }) + '\n')
  process.exitCode = 3
}
