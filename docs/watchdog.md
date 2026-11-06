# External Watchdog

The Watchdog is an independent process for checking a running dsh-superagent profile. Infrastructure health and semantic task review are reported separately. The bundled model assessor uses the profile's configured DSH provider in an isolated, tool-free context; an external assessor command remains available. With neither model path selected, the report includes `semanticStatus: unreviewed`, even when infrastructure is healthy. A model failure produces `unknown` and preserves running workers.

The snapshot contains component health, setup state, executor capacity, each live or recently ended ticket's report and lifecycle state, the last five assignment report summaries, input counts, repeated blocked/failed reports, and elapsed-time review candidates. It omits source message bodies, environment values, and credentials. Live tickets appear first, ordered by creation time and ID so progress updates preserve pagination order. Recently ended tickets follow. Snapshots contain at most 100 tickets and include a cursor; each check stores the next cursor so later checks continue through remaining pages and then wrap around. Infrastructure health and executor totals are included on every page. An elapsed-time candidate prompts review; the assessor uses task reports and execution evidence to distinguish progress, a human wait, a stall, or a divergence.

## Read-only check

Run one check from the checkout:

```sh
node scripts/dsh-superagent-watchdog.mjs --once
```

The default target is `http://127.0.0.1:3082`. Override it with `--url` or `DSH_SUPERAGENT_URL`; only HTTP loopback origins are accepted. `--profile` or `DSH_SUPERAGENT_PROFILE` selects the profile. The process writes a small state file under `.artifacts/control/profiles/<profile>/watchdog.json` and prints JSON for a changed task assessment, a failure or recovery, or a recovery action that needs attention. Task fingerprints are tracked per page, while infrastructure failures are tracked globally. Paging through unchanged tasks stays quiet; an initial healthy page records its baseline silently.

For continuous checks, omit `--once`; the default interval is five minutes. `SIGINT` and `SIGTERM` cancel the loop. Network requests and assessor processes have a five-second timeout by default; use `--timeout-ms` to adjust it. Use `--candidate-after-ms` to set the minimum elapsed time used to select review candidates (default: 30 minutes); the value is sent with each snapshot request.

## Model assessor

Use the bundled path without writing a wrapper:

```sh
node scripts/dsh-superagent-watchdog.mjs --once --model-assessor --timeout-ms 65000
```

This asks the local `/watchdog/assess` route to create a semantic review using the configured evaluation/worker/default model selected by the host. The external control process remains independent. The model receives a new read-only context with no tools, original goal and scope, up to five later human corrections, report state, and up to twelve actual tool/artifact/background evidence entries per ticket. Ordinary snapshot requests omit these additional message bodies. Both paths redact common credential forms. Model-visible input, bounded output, selected model, usage, task revisions and snapshot hash are saved in the existing SQLite KV store. `GET /watchdog/reviews` returns summaries; `GET /watchdog/reviews/:id` provides the corresponding record for inspection.

Semantic review pages contain at most twenty tasks. The model must cite provided evidence IDs for stalled/diverged findings. A healthy working-task finding requires actual execution evidence; repeated self-reports alone produce `unknown`. Human waits, explicit stops, completed work, and running background jobs remain protected. An elapsed-time candidate only selects a task for review.

Results use `healthy` (evidence supports progress), `waiting` (a legitimate wait), `stalled` (repeated ineffective action), `diverged` (actions conflict with the current goal), or `unknown` (insufficient evidence or an evaluation failure). The report also includes `infrastructureStatus`, `semanticStatus`, `reviewId`, and `snapshotHash`. Unknown model results never trigger a host restart.

### Observe first, then bounded advice

The semantic service starts in `observe` mode. Reviews record findings while work continues. After inspecting real assessments, the owner can set `POST /watchdog/config` to `{"mode":"advise"}` and run the external process with both `--model-assessor` and `--advise`. Returning to `observe` takes effect before any further advice.

```sh
node scripts/dsh-superagent-watchdog.mjs --model-assessor --advise --timeout-ms 65000
```

Advice is an internal note to the original Worker, preserving its original mandate and human decisions. The host rechecks the task revision, current state, mode and existing intervention ledger in the same database transaction. A goal/report/input change makes old advice stale. Each task receives at most two successful notes in six hours, with a thirty-minute cooldown. Repeating a successful request returns its durable receipt. Paused, stopped, human-held, completed, externally waiting and recorded running-background tasks remain protected. The optional live execution check can also refuse advice while a tool is executing. Reviewer failures and refused/stale advice do not interrupt the task or remove manual controls.

With `advise` enabled, the bundled host also pauses a task's compute after a demonstrated ineffective sequence: two successful corrective notes for the same assignment and human-goal context, another thirty-minute cooldown, and a third independent `stalled`/`diverged` review citing at least one of two distinct new completed tool results observed after the second note. The host checks the current evidence version again immediately before the pause. Elapsed time, repeated status prose, an unchanged evidence set, or a reviewer failure leave the task running. A newly observed legitimate progress/wait review or a later human correction breaks this escalation sequence. Hosts without the atomic hold and live-evidence hooks retain the two-note limit.

The successful receipt records `action: "note"` or `action: "hold"` and, for a pause attempt, `newExecutionCount`. Review records preserve the evidence fingerprint and observed result IDs; receipts and the intervention ledger survive a database/process restart. A hold stops the current assignment while preserving its mandate, inputs and original goal. The owner inspects the recorded evidence, corrects the cause and uses the existing task resume control to start a new assignment. Supervision leaves that decision with the owner; the existing executor handles its bounded transient retries, and `--recover` below handles the specified infrastructure failures.

An explicitly requested advice operation uses `POST /watchdog/advice` with `reviewId`, `ticketId`, and `expectedRevision`. Reviews themselves never perform writes to a Worker. The external state file retains the last hundred review summaries alongside its existing recovery and nudge state.

### Custom external assessor

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

`status` and each finding use `healthy`, `waiting`, `stalled`, `diverged`, or `unknown`. Keep findings tied to snapshot evidence. The custom assessor may request a status nudge only for a worker whose latest report says `waiting`. The management endpoint checks this condition again before queuing the request. Nudges are disabled by default; enable them with `--nudge`. Choose one of `--model-assessor` and `--assessor-command` for a run.

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
- `POST /orchestrator/api/watchdog/assess`
- `GET /orchestrator/api/watchdog/reviews`
- `GET /orchestrator/api/watchdog/reviews/:id`
- `GET /orchestrator/api/watchdog/config`
- `POST /orchestrator/api/watchdog/config`
- `POST /orchestrator/api/watchdog/advice`

The second route only asks the Engine for a status report when its current worker is live and its latest report is `waiting`. It does not stop a worker or change prompts or policy.

## External scheduling

Schedule the process outside the profile it monitors so checks continue while that profile is down. Keep `--once` checks read-only first. Add `--assessor-command`, `--nudge`, and `--recover` only when their external services and operator policy are configured. Store the Watchdog state file with restrictive local permissions and avoid logging the assessor's full input.
