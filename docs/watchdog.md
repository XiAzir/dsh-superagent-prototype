# External Watchdog

The Watchdog is an independent process for checking a running dsh-superagent profile. It reads a bounded local snapshot and can send it to an assessor command that represents a separately hosted model session. Without that command, it reports infrastructure errors and legitimate human waits; it does not infer that an old activity timestamp means a task has stopped progressing.

The snapshot contains component health, setup state, executor capacity, each live or recently ended ticket's report and lifecycle state, the last five assignment report summaries, input counts, repeated blocked/failed reports, and elapsed-time review candidates. It omits source message bodies, environment values, and credentials. Live tickets appear first, ordered by creation time and ID so progress updates preserve pagination order. Recently ended tickets follow. Snapshots contain at most 100 tickets and include a cursor; each check stores the next cursor so later checks continue through remaining pages and then wrap around. Infrastructure health and executor totals are included on every page. An elapsed-time candidate prompts review; the assessor uses task reports and execution evidence to distinguish progress, a human wait, a stall, or a divergence.

## Read-only check

Run one check from the checkout:

```sh
node scripts/dsh-superagent-watchdog.mjs --once
```

The default target is `http://127.0.0.1:3082`. Override it with `--url` or `DSH_SUPERAGENT_URL`; only HTTP loopback origins are accepted. `--profile` or `DSH_SUPERAGENT_PROFILE` selects the profile. The process writes a small state file under `.artifacts/control/profiles/<profile>/watchdog.json` and prints JSON for a changed task assessment, a failure or recovery, or a recovery action that needs attention. Task fingerprints are tracked per page, while infrastructure failures are tracked globally. Paging through unchanged tasks stays quiet; an initial healthy page records its baseline silently.

For continuous checks, omit `--once`; the default interval is five minutes. `SIGINT` and `SIGTERM` cancel the loop. Network requests and assessor processes have a five-second timeout by default; use `--timeout-ms` to adjust it. Use `--candidate-after-ms` to set the minimum elapsed time used to select review candidates (default: 30 minutes); the value is sent with each snapshot request.

## Model assessor

Provide an argv array as JSON, without shell parsing:

```sh
node scripts/dsh-superagent-watchdog.mjs --once --assessor-command '["python","watchdog_assessor.py"]'
```

The command receives one JSON object on stdin and must return JSON on stdout:

```json
{
  "status": "healthy",
  "findings": [
    {
      "ticketId": "ticket-id",
      "status": "waiting",
      "evidence": ["The latest report asks the owner to choose between two options."],
      "recommendation": "Wait for the owner."
    }
  ],
  "nudgeTicketIds": []
}
```

`status` and each finding use `healthy`, `waiting`, `stalled`, or `diverged`. Keep findings tied to snapshot evidence. The assessor may request a status nudge only for a worker whose latest report says `waiting`. The management endpoint checks this condition again before queuing the request. Nudges are disabled by default; enable them with `--nudge`.

The assessor subprocess receives a reduced environment: basic process/runtime variables, `DSH_HOME`, and variables explicitly prefixed `DSH_SUPERAGENT_WATCHDOG_ASSESSOR_`. Put any wrapper-specific connection settings under that prefix. Other ambient variables are withheld from the assessor process.

## Explicit recovery

The default remains read-only. Add `--recover` to let the watchdog invoke the existing `scripts/dsh-superagent` manager with `restart --respect-stop` when the management endpoint is unreachable or component health reports an error:

```sh
node scripts/dsh-superagent-watchdog.mjs --once --recover
```

Recovery is limited to three attempts in a six-hour window, with exponential backoff starting at ten minutes and capped at two hours. An intentional stop marker suppresses recovery. Host recovery uses the manager's graceful stop and startup checks. Assessor subprocess timeouts separately terminate their own process tree and release inherited pipes after bounded cleanup. After the recovery limit is reached, an operator inspects the reported error and decides what to do.

The management routes are served only on the loopback web server and use the existing same-origin request check:

- `GET /orchestrator/api/watchdog/snapshot`
- `POST /orchestrator/api/watchdog/tickets/:id/request-status`

The second route only asks the Engine for a status report when its current worker is live and its latest report is `waiting`. It does not stop a worker or change prompts or policy.

## External scheduling

Schedule the process outside the profile it monitors so checks continue while that profile is down. Keep `--once` checks read-only first. Add `--assessor-command`, `--nudge`, and `--recover` only when their external services and operator policy are configured. Store the Watchdog state file with restrictive local permissions and avoid logging the assessor's full input.
