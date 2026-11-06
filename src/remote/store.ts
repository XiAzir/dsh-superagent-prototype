/** Local durable daemon state. Accepted operations survive lost HTTP responses and are never replayed at boot. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ENVIRONMENT_SCHEMA, EnvironmentError, type CommandPayload, type RemoteCommand } from './protocol.ts'

export interface StoredCommand extends Omit<RemoteCommand, 'stdout' | 'stderr'> { payload: CommandPayload; pid?: number; stdoutPath: string; stderrPath: string }
/** Stores durable endpoint command states and receipts so reconnects recover the original operation identity. */
export class EnvironmentStore {
  readonly db: DatabaseSync
  readonly daemonId: string
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,ticket TEXT NOT NULL,value TEXT NOT NULL)')
    const schema = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema')?.value
    if (schema !== undefined && Number(schema) !== ENVIRONMENT_SCHEMA) { this.db.close(); throw new EnvironmentError('state_version', 'Environment state schema is incompatible', 409) }
    this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run('schema', String(ENVIRONMENT_SCHEMA))
    this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run('daemonId', randomUUID())
    this.daemonId = String(this.db.prepare('SELECT value FROM meta WHERE key=?').get('daemonId')!.value)
  }
  get(id: string): StoredCommand | undefined {
    const row = this.db.prepare('SELECT value FROM commands WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as StoredCommand : undefined
  }
  save(command: StoredCommand): void {
    this.db.prepare('INSERT INTO commands(id,ticket,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(command.commandId, command.ticketId, JSON.stringify(command))
  }
  all(): StoredCommand[] { return this.db.prepare('SELECT value FROM commands ORDER BY id').all().map(row => JSON.parse(String(row.value)) as StoredCommand) }
  recover(now = new Date().toISOString()): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const command of this.all()) if (command.state === 'accepted' || command.state === 'running') {
        this.save({ ...command, state: 'unknown', endedAt: now, reason: 'Daemon restarted before a durable terminal result; inspect the preserved workspace and output before deciding any next action.' })
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  backup(destination: string): void {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    this.db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`)
    chmodSync(destination, 0o600)
  }
  close(): void { this.db.close() }
}
