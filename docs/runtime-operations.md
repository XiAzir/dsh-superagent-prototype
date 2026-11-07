# Runtime provenance, preflight and upgrade recovery

The Runtime records its actual package version, state schema, build bytes, protocol versions, Node/platform and a configuration digest in the existing orchestrator database. This gives an operator a concrete pairing of code, configuration and task state before upgrading or restoring a profile.

The schema 13 marker is a downgrade barrier for enforced verification, remote execution metadata and task holds. Existing schema 12 records already use compatible JSON/SQLite storage. Opening them with this build advances the schema marker inside the Store's existing migration transaction and preserves their values. A schema 12 binary sees the newer marker and refuses to open it; rollback therefore uses its paired pre-upgrade state backup.

## Manifest lifecycle

The host calls:

```ts
const runId = randomUUID()
const identity = runtimeBuildIdentity() // Capture the build actually loaded at construction.
recordRuntimeManifest(store, { config: safeConfigurationSnapshot, phase: 'starting', runId, identity })
// Once the Runtime has reached ready:
recordRuntimeManifest(store, { config: safeConfigurationSnapshot, phase: 'ready', runId, identity })
// After saving configuration, use the same runId with the new snapshot.
```

`recordRuntimeManifest` reads the installed package's `package.json` through `packagePath`, fingerprints actual compiled JavaScript chunks or development source bytes, and records the current schema. The build identity also includes the packaged `prompts/`, `skills/`, `locale/` and root `cordis.patch.yml` bytes; editing, adding or removing these behavior resources changes the build ID. Files are hashed in deterministic package-relative order in both source and compiled layouts. Symlink resources are skipped. Profile directories, state, credential files and other files outside these package resource roots stay outside the build digest. A configuration change produces another revision. The same run/build/config identity updates its startup/ready phase in the same revision. A fresh run ID records a restart even if the code and configuration stay the same.

Keep the captured `identity` for that Runtime's later configuration updates. A candidate package written to disk can then be detected by preflight without being attributed to a process that still has the older code loaded. A fresh Runtime construction captures the newly loaded package/build.

Only the configuration hash and an allowlisted summary of counts, booleans and mode enums are stored. Source configuration bodies, tokens, private URLs, account lists and preparation commands stay out of the manifest. Changing an inline configuration value changes its digest without revealing that value; referenced credentials retain their credential service's own version/audit trail. The latest ready record is kept as `lastGood`; a new or failed candidate retains the previous ready version. History retains fifty recent revisions plus referenced previous/last-good entries.

`runtimeManifestState(store)` returns current, lastGood, previousGood and recent history. `lastGood` records a Runtime that reached ready. End-to-end task acceptance is checked by the canary workflow below. Existing task views, execution details and takeover controls remain available during investigation.

## Read-only preflight

Run from the selected checkout or installed bundle:

```powershell
node scripts/superagent-preflight.mjs --state-dir E:/SuperAgentData/superagent
```

The CLI opens `orchestrator.sqlite` with a read-only SQLite connection. It runs `quick_check`, reads the schema and manifest, compares them with the selected build, and counts open, active, held and unknown-remote work. It executes no Store migrations. `--database <file>` can select an exported database, and `--entry <runtime-entry.js>` can inspect a specific development/build entry. `--expected-config-hash <digest>` additionally compares a planned configuration snapshot.

The JSON result uses these exit codes:

| Exit | Meaning | Next action |
| --- | --- | --- |
| `0` | Database integrity, supported schema and last recorded ready build match | Continue with the normal manager/Watchdog health check and task canary |
| `2` | Attention required: missing initial state/manifest, pending compatible upgrade, changed build/configuration, or last recorded startup/failure | Inspect `issues`, back up the paired state and validate the candidate |
| `3` | Incompatible schema, integrity/open failure, invalid invocation or failed export | Preserve the current files and resolve the reported condition |

`upgrade_required` for a schema 12 database is expected before its first schema 13 startup. The preflight output remains at schema 12 until the Runtime is deliberately started. A changed build yields `runtime_build_changed`, and an unsupported future schema yields `state_schema_incompatible`.

These are persisted state/build observations. Actual process availability continues to come from the existing profile manager and external Watchdog.

## SQLite-only export

Create a consistent database snapshot from the read-only source connection:

```powershell
node scripts/superagent-preflight.mjs --state-dir E:/SuperAgentData/superagent --export-sqlite E:/SuperAgentBackups/20261107/orchestrator.sqlite
```

The export uses Node's SQLite backup API, validates the resulting database and reports its byte size and SHA-256. The destination must be fresh; existing files are preserved. The source can remain open while SQLite produces its consistent snapshot.

The result explicitly says `kind: sqlite-only`. It covers orchestrator tables, KV, task/event state, Outbox receipts and manifest history. It separately lists DSH Session persistence, artifact bytes, execution workspaces and credential/profile configuration. Keep those files and services under their corresponding backup policies before treating a backup as an entire recoverable installation.

## Complete offline backup recipe

For an upgrade/rollback bundle, first stop the profile using the existing [Windows lifecycle](windows.md) or [Linux lifecycle](linux.md). Record the current code revision/package, runtime manifest, profile and backup time. Copy these locations into a fresh backup directory while their writers are stopped:

1. The complete configured `stateDir`, including `orchestrator.sqlite` and any SQLite sidecars, artifacts, local workspaces, shims and persistent control data.
2. The DSH profile's Session persistence and profile configuration, including its package/lockfile/configuration patch.
3. Any execution directory configured outside `stateDir`; include uncommitted files, task worktrees and generated artifacts.
4. For remote-bound work, the endpoint daemon state, output logs and task workspaces, following [Remote environments](remote-environments.md). Preserve the host command-intent database and endpoint state as a pair.
5. Credential-service backup or recovery references through that service's own mechanism. Keep credentials under their existing access controls.

For example, after setting the actual paths for the selected installation:

```powershell
$backupBundle = 'E:/SuperAgentBackups/20261107-before-schema13'
New-Item -ItemType Directory -Path $backupBundle -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath $runtimeStateDir -Destination (Join-Path $backupBundle 'runtime-state') -Recurse
Copy-Item -LiteralPath $dshProfileData -Destination (Join-Path $backupBundle 'dsh-profile') -Recurse
Copy-Item -LiteralPath $externalExecutionRoot -Destination (Join-Path $backupBundle 'execution-root') -Recurse
```

Set these task-specific variables to inspected absolute paths. Use a fresh destination, keep the backup outside the running data tree, and include only the externally configured locations that the installation actually uses. Run preflight against the copied database and retain the matching old package/build with this bundle.

## Upgrade and canary

1. Run preflight with the candidate code and record its output. Inventory active/held tasks and save their current stages. For critical work, choose a safe interruption point before stopping the profile.
2. Create the complete offline backup above. Build the candidate in its independent worktree and complete its checks before changing the installed package reference.
3. Start the candidate under the existing dedicated OS account and unchanged state directory. Read its new manifest and health. Existing Sessions, task directories, mandates and inputs continue from their persisted records.
4. Create a new low-impact canary task: produce a short local report, verify its actual content and digest, and download it through the normal source. Inspect the completion/verification record and Outbox receipt.
5. Exercise status queries and a deliberate stop. For a remote environment, also test a brief endpoint outage and reconnect on a canary, preserving the same command ID. Keep older critical work paused or supervised until the candidate demonstrates the needed paths.
6. Keep the pre-upgrade bundle until the candidate has passed real work. Record the canary task IDs and observed outcome alongside the manifest/build ID.

Schema 14 protects durable request ownership, provisional inputs and transferred acceptance responsibility. Schemas 12 and 13 upgrade additively; original requests and task records remain available. Existing task compatibility and canary verification remain part of the deployment check. See [routing recovery](routing-recovery.md) for internal claims, bounded review and migrated artifacts/commands.

## Rollback and recovery

Stop the candidate profile and preserve a separate copy of its current state for investigation. Restore the old package together with its paired pre-upgrade Runtime state, DSH profile/Sessions, artifact bytes and execution directories. Validate that restored bundle with the matching preflight/build, then start it through the normal manager.

Inspect actions that occurred after the backup time in the actual destination systems before resuming. In particular, preserve remote command IDs, external message receipts and unknown-operation records; use their inspection/owner-resolution flows before issuing a replacement operation. This prevents a state rollback from duplicating already executed effects.

For a same-version process restart, keep the current database and its manifest/history. The Runtime's normal recovery resumes its persisted task flow; the external Watchdog handles availability and bounded recovery. A manifest/build mismatch remains visible until the selected candidate records its own startup/ready state.

## Verification

`tests/runtime-manifest.spec.ts` covers real package metadata, secret-free configuration fingerprints, startup/config/build history, last-good retention, imported source/chunk changes, packaged behavior resource changes in source/compiled layouts, deterministic relocation and private-profile exclusion, read-only schema inspection, active/held counts, schema 12 preservation and additive upgrade, future-version refusal, real SQLite backup and an independent preflight CLI process.

All implementation tests use temporary state. This development work leaves running profiles, OS accounts and private configuration unchanged.
