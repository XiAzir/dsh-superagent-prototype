#!/usr/bin/env node
/** Build output is preferred; Node 24's native TypeScript loader supports checkout development. */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const built = new URL('../lib/environment-daemon.js', import.meta.url)
const source = new URL('../src/remote/daemon.ts', import.meta.url)
const implementation = await import(existsSync(fileURLToPath(built)) ? built.href : source.href)
implementation.runEnvironmentCli().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
