# Remote execution environments

The Router, Worker model calls and task state remain on the always-online host. An environment daemon runs commands and transfers files on an owner-selected machine. Each task is bound to one registered device. The existing Worker retains its conversation, mandate, reports, verification and human controls; its execution tools use the selected machine.

The shipped CLI and HTTP client support asynchronous command start/status/cancel, durable operation IDs, reconnect, offline cancellation, file bytes and SHA-256 receipts. The host integration uses the existing Store KV and Worker tools. No provider/model credential is sent to the endpoint. Environment authentication tokens stay in the host credential resolver and daemon transport; command output and model-facing file reads redact the configured token.

## Endpoint setup

Use Node 24.9 or later, PowerShell 7 on Windows, or Bash on Linux. Keep three distinct locations:

- `workspaces`: task files the worker operates on; each ticket receives a hashed subdirectory.
- `control/state`: daemon SQLite, process lock and bounded command output.
- `control/token`: a randomly generated transport token, readable by the daemon service account.

For a local Windows checkout, generate the token directly into its file:

```powershell
New-Item -ItemType Directory -Force E:/SuperAgentEnvironment/control | Out-Null
node -e "require('node:fs').writeFileSync('E:/SuperAgentEnvironment/control/token',require('node:crypto').randomBytes(32).toString('hex'),{mode:0o600})"
node scripts/superagent-environment.mjs --root E:/SuperAgentEnvironment/workspaces --state E:/SuperAgentEnvironment/control/state --token-file E:/SuperAgentEnvironment/control/token --port 3091
```

The startup JSON contains the listening URL, daemon identity, wire protocol and runtime version. It contains no token. With a built package the launcher loads `lib/environment-daemon.js`; from a checkout it uses Node's native TypeScript loader.

The default listener is HTTP loopback. For an actual remote machine, put the loopback listener behind an authenticated private-network/TLS endpoint and register its HTTPS URL on the host. A deliberate private-network HTTP deployment requires both daemon `--allow-insecure-network --host <address>` and host registration `allowInsecureHttp: true`. Embedded URL credentials, queries and fragments are rejected.

Run the daemon under a dedicated execution account with access to the selected workspaces and required services. Keep personal browser profiles, SSH directories and unrelated project directories under their respective OS accounts. Grant the daemon service only the workspace/control directories and service operations this environment needs. On Windows, use a Task Scheduler task under that account with “run whether the user is logged on or not”; on Linux, use a systemd unit with `User=superagent-env`, `WorkingDirectory` set to the installed bundle, `Restart=on-failure`, and `UMask=0077`. Manage the service-account password and task registration in the OS administration workflow. The daemon's child environment contains basic runtime/path variables plus operator-configured execution variables, with ambient application tokens omitted.

Keep the CLI running as an external service. The main Superagent profile can restart independently of the endpoint, and an endpoint outage leaves a durable wait on the host.

## Host registration and task binding

The host's owner API registers a device with:

```json
{
  "id": "personal",
  "label": "Personal computer",
  "url": "https://environment.example.net",
  "credentialRef": "personal-environment-token"
}
```

`credentialRef` is resolved by the host's existing credential service. The registry stores this reference and device metadata; it stores no token value. Worker-visible device listings omit the reference.

Host integration constructs `RemoteEnvironments({store, credential, onState, mayExecute})`. `bind(ticketId, deviceId)` selects the task device, `binding(ticketId)` reports it, and `tools(ticketId)` returns only tools for that binding. The host disables local shell/file execution for a remote-bound task. `mayExecute` rechecks that the current mandate still permits executable work, including an authorized wait for the selected device.

Tools are:

| Tool | Operation |
| --- | --- |
| `orchestrator_environment` | Inspect the bound device and remote working directory |
| `orchestrator_environment_start` | Start a command with a stable `request_id` |
| `orchestrator_environment_status` | Query that command's saved status and bounded output |
| `orchestrator_environment_cancel` | Persist cancellation intent, including while offline |
| `orchestrator_environment_read` | Read a task-local UTF-8 file with paging and digest validation |
| `orchestrator_environment_write` | Write task-local UTF-8 bytes, with explicit overwrite |

Command `cwd` and file `path` are relative to the task's remote directory. The returned directory is a remote path. Tasks can create further directories with their shell commands. Cross-task paths, drive/UNC paths, traversal, alternate data stream syntax and symbolic-link/junction escapes are rejected by file/cwd routes. File transfer opens ordinary files with no-follow checks, bounds bytes and validates SHA-256. Existing different file contents require explicit overwrite; retrying identical bytes reuses the existing file.

If a file-write response is lost after the endpoint saved the bytes, retry the same path and content. The daemon compares the existing file's SHA-256 and returns its metadata with `reused: true`. This works with the default `overwrite: false` and preserves the original artifact name. A retry carrying different bytes receives an explicit conflict and leaves the saved file in place.

An owner can bind another device after the task has no active or unresolved operations. Existing command intents retain their original device and payload digest. The registry also records daemon identity; if the endpoint suddenly presents another identity, outstanding work becomes `unknown` for owner inspection.

## Command lifecycle and reconnect

The host derives a command ID from device, task and request ID and durably saves the normalized payload hash before transmission. The daemon durably saves the same ID/hash before spawning a process. A repeated ID with matching payload returns its existing record. A changed payload under the same ID returns a conflict.

```text
host saves intent -> query original ID -> daemon accepts once -> running -> terminal result
                         |
                    device offline
                         |
                waiting_environment -> reconnect -> query original ID
```

An HTTP timeout does not end a running command and does not create a new command ID. On reconnect, the host queries the original record first. A record missing from the same known daemon can be submitted under the original ID; a changed daemon identity requires inspection. A process receives its configured execution deadline independently of HTTP request timeouts.

The host calls `tick()` periodically. Its transitions distinguish `waiting_environment`, `ready`, and `unknown`, and carry `commandState`. The Runtime can hold the existing authorized task during an outage, release it after reconnect, and inject a command-completion event from `commandResult(ticketId, commandId)` when execution ends. New model turns keep using the original task context. `commands(ticketId)` exposes safe command metadata and actual result/output evidence for task verification; `hasUnsettled(ticketId)` prevents final completion while execution remains queued, running or unresolved.

Cancellation is saved on the host before contacting the endpoint. If an offline queued command was never accepted, reconnect resolves the cancellation before dispatch. If it is running, the daemon requests process-tree termination and records the result. Manual task stop calls `cancelTicket(ticketId)`. Unconfirmed termination remains `unknown`, with its workspace and logs preserved.

## Crash and unknown outcomes

The daemon state directory has a single-instance lock and a persistent identity. At startup it marks previously accepted/running records `unknown`. It preserves the command ID, payload hash, process ID, output paths and workspace. It never repeats those operations automatically. A changed workspace root against the same state database is rejected.

While a task has an unresolved unknown operation, the client holds new command IDs and file writes for that task. It rechecks this condition immediately before transmitting executable requests, including after credential resolution. Retrying the original request ID returns its preserved unknown record, including while the host holds execution. Status, file reads, cancellation and owner resolution remain available for inspection. An owner-confirmed outcome clears this hold; the original daemon fact remains in the history. Task/device rebinding uses the effective state after that confirmation.

An owner resolves an unknown result after inspecting actual evidence:

```ts
remote.resolveUnknown(ticketId, commandId, {
  outcome: 'completed',
  evidence: 'The destination contains the expected object once; its recorded digest matches.',
  expectedUpdatedAt: inspectedCommand.updatedAt,
})
```

This host-only operation records the owner conclusion and its evidence. It retains the daemon's original unknown state, adds `ownerResolution` and resolution history, and supplies `effectiveState` for verification. A stale `expectedUpdatedAt` is refused. Identical confirmations are idempotent. A confirmed operation leaves the unsettled set and permits subsequent completion/rebinding. Querying or retrying the old command ID returns the observed outcome; it performs no new execution. The owner API should expose this action explicitly, together with raw daemon state and recorded evidence.

## Artifacts and binary files

Worker reports use a task-relative reference such as:

```text
remote://personal/results/report.pdf
```

The host parses it with `parseRemoteArtifactReference`, checks the task binding, and calls `downloadArtifact(ticketId, deviceId, remotePath, localDestination)`. The response includes actual bytes and their SHA-256; the host verifies both size and digest before writing the local snapshot. It then registers that local file using the existing task ArtifactRegistry and Outbox. `importFile` provides the reverse host-to-device byte transfer. The default per-file limit is 50 MiB; operator configuration can select a lower bound.

## State, version checks and backup

Check the runtime and database without starting another listener:

```powershell
node scripts/superagent-environment.mjs --root E:/SuperAgentEnvironment/workspaces --state E:/SuperAgentEnvironment/control/state --token-file E:/SuperAgentEnvironment/control/token --check
```

The check validates Node version, state schema, workspace association and SQLite `quick_check`. Output includes wire protocol, schema, daemon runtime version and persistent device identity. The host refuses incompatible protocol/schema values and preserves the associated task for operator review.

Create a consistent SQLite snapshot:

```powershell
node scripts/superagent-environment.mjs --root E:/SuperAgentEnvironment/workspaces --state E:/SuperAgentEnvironment/control/state --token-file E:/SuperAgentEnvironment/control/token --check --backup E:/SuperAgentEnvironment/backups/environment-20261107.sqlite
```

The backup uses SQLite `VACUUM INTO` and requires a fresh destination. Keep the token, state backup, workspace files and required output logs under the environment's backup policy. Restore a matching state/workspace snapshot while the daemon is stopped, then run `--check` before restarting. Any in-progress records in a restored snapshot receive the same unknown-outcome treatment at startup. Preserve the host's main SQLite database separately so command intents, owner resolutions and device bindings also survive host recovery.

## Test entry points

`tests/remote-environments.spec.ts` executes real local HTTP and independent daemon processes. It covers lost start responses, same-ID conflict protection, host-state reconstruction, offline cancellation, reconnect, actual command cancellation, binary transfer, SHA checks, path/junction rejection, token redaction, daemon crash and manual unknown resolution. Additional tests cover device identity changes, corrupted file responses, model tools and self-check/backup.

Tests use temporary workspaces and credentials, loopback listeners and bounded commands. Existing user profiles and devices are unaffected.
