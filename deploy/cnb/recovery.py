#!/usr/bin/env python3
"""Project-scoped CNB recovery with verified startup and persisted diagnostics."""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import shlex
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = 'XiAzir/dsh-superagent'
API = 'https://api.cnb.cool/'
HEALTH = 'http://127.0.0.1:9012/superagent-runtime/health'
SN = re.compile(r'^cnb-[A-Za-z0-9-]+$')
RULE_HINT = 'Update the runtime.json import allow_branches for the configured branch, refresh the private rules snapshot, then run --retry-blocked.'


class RecoveryError(Exception):
    pass


def load_env(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise RecoveryError('Invalid recovery environment file')
        values = shlex.split(value, comments=True)
        if len(values) > 1:
            raise RecoveryError('Recovery environment value must be a single literal')
        result[key] = values[0] if values else ''
    if result.get('CNB_REPO', REPO) != REPO:
        raise RecoveryError('Recovery repository must be ' + REPO)
    return result


def import_rule_issue(path: Path, branch: str) -> dict | None:
    try:
        rules = json.loads(path.read_text())
    except (OSError, ValueError):
        return {'status': 'blocked_import_rules_missing', 'nextStep': 'Install a current rules-only runtime.json snapshot at ' + str(path)}
    repo_key = 'allow_slugs' if 'allow_slugs' in rules else 'allow_repos'
    for key, target in [(repo_key, REPO), ('allow_branches', branch), ('allow_events', 'vscode')]:
        patterns = rules.get(key)
        if not isinstance(patterns, list) or not patterns or not all(isinstance(x, str) for x in patterns):
            return {'status': 'blocked_import_rules_invalid', 'rule': key, 'nextStep': 'Refresh the rules-only runtime.json snapshot.'}
        if not any(fnmatch.fnmatchcase(target, pattern) for pattern in patterns):
            return {'status': 'blocked_import_branch' if key == 'allow_branches' else 'blocked_import_rules',
                    'rule': key, 'target': target, 'nextStep': RULE_HINT}
    return None


def receiver_summary(path: Path, now=None):
    now = time.time() if now is None else now
    try:
        state = json.loads(path.read_text())
        lease, heartbeat = state.get('lease') or {}, state.get('heartbeat') or {}
        active = isinstance(lease.get('expires_at'), (float, int)) and lease['expires_at'] > now
        recent = isinstance(heartbeat.get('at'), (float, int)) and 0 <= now - heartbeat['at'] <= 120
        paused = state.get('intentional_paused') is True or (active and recent and heartbeat.get('paused') is True)
        confirmed = active and recent and heartbeat.get('owner') == lease.get('owner') and heartbeat.get('healthy') is True and heartbeat.get('stage') in (None, 'running') and not paused
        return {'confirmed': confirmed, 'paused': paused, 'owner': lease.get('owner') if active else None}
    except (OSError, ValueError, AttributeError, TypeError):
        return {'confirmed': False, 'paused': False, 'receiverStateUnavailable': True}


class Client:
    def __init__(self, env: dict[str, str]):
        self.env = env

    def request(self, path: str, *, listing=False, body=None):
        token_path = Path(self.env.get('FALLBACK_LIST_TOKEN' if listing else 'FALLBACK_TOKEN',
                                     '/root/.cnb-superagent/watchdog-list-token' if listing else '/root/.cnb-superagent/watchdog-token'))
        token = token_path.read_text().strip()
        request = urllib.request.Request(API + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.cnb.api+json', 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            raise RecoveryError('CNB API HTTP ' + str(exc.code)) from None
        if not isinstance(result, dict) or result.get('errcode') not in (None, 0):
            raise RecoveryError('CNB API rejected request')
        return result

    def health(self):
        try:
            with urllib.request.urlopen(HEALTH, timeout=8) as response:
                value = json.load(response)
            if not isinstance(value, dict) or value.get('status') not in ('ok', 'waiting'):
                return None
            return {**value, **receiver_summary(Path(self.env.get('CNB_RECEIVER_STATE', '/var/lib/cnb-superagent/state.json')))}
        except (OSError, ValueError):
            return None

    def running(self, branch):
        found = []
        for page in range(1, 21):
            value = self.request('workspace/list?' + urllib.parse.urlencode({'slug': REPO, 'page_size': 100, 'page': page}), listing=True)
            rows = value.get('list', value.get('data'))
            if not isinstance(rows, list):
                raise RecoveryError('Invalid workspace list')
            # A live migrated workspace retains its original Linux creation branch.
            branches = {branch, 'linux'} if branch == 'codex/autonomy-plan-20261107' else {branch}
            found.extend(row for row in rows if row.get('slug') == REPO and row.get('branch') in branches and row.get('status') == 'running')
            if not value.get('hasMore'):
                return found
        raise RecoveryError('Workspace pagination limit reached')

    def build(self, sn):
        if not SN.fullmatch(sn):
            raise RecoveryError('Invalid saved build identifier')
        value = self.request(REPO + '/-/build/status/' + sn)
        for pipeline_id, pipeline in value.get('pipelinesStatus', {}).items():
            for stage in pipeline.get('stages', []):
                if stage.get('status') == 'error':
                    detail = self.request(REPO + '/-/build/logs/stage/' + '/'.join(urllib.parse.quote(x, safe='') for x in (sn, pipeline_id, stage['id'])))
                    error = str(detail.get('error', '')) + '\n' + '\n'.join(str(x) for x in detail.get('content', []))
                    if 'allow_branches' in error:
                        return {'status': 'blocked_import_branch', 'sn': sn, 'stage': stage['id'], 'nextStep': RULE_HINT}
                    return {'status': 'build_failed', 'sn': sn, 'stage': stage['id'], 'nextStep': 'Inspect this build stage in CNB and repair its reported initialization error.'}
        if value.get('status') in ('error', 'cancel', 'success'):
            return {'status': 'build_ended', 'sn': sn, 'buildStatus': value['status']}
        return {'status': 'starting', 'sn': sn}


def step(client, env, state, *, check=False, retry_blocked=False, now=None):
    now = time.time() if now is None else now
    health = client.health()
    if health is None:
        return {'status': 'receiver_unavailable', 'nextStep': 'Repair the archive receiver before workspace recovery.'}
    if health.get('receiverStateUnavailable'):
        return {'status': 'receiver_state_unavailable', 'nextStep': 'Restore read access to the receiver state before workspace recovery.'}
    if health.get('paused') is True:
        return {'status': 'healthy', 'paused': True}
    if health['status'] == 'ok':
        if health.get('confirmed') is not True:
            return {'status': 'bootstrapping' if not health.get('receiverStateUnavailable') else 'receiver_state_unavailable'}
        pending = state.get('pending')
        if pending:
            running = client.running(env.get('CNB_BRANCH', 'codex/autonomy-plan-20261107'))
            if not any(row.get('sn') == pending for row in running) or health.get('owner') not in (pending, pending + '-001'):
                return {'status': 'health_ok_workspace_unverified', 'sn': pending,
                        'nextStep': 'Wait for the accepted build to appear as a running workspace.'}
        if not check:
            state.clear()
        return {'status': 'healthy', 'paused': health.get('paused', False)}
    branch = env.get('CNB_BRANCH', 'codex/autonomy-plan-20261107')
    issue = import_rule_issue(Path(env.get('CNB_IMPORT_RULES_FILE', '/root/.cnb-superagent/runtime-import-rules.json')), branch)
    if issue:
        return {**issue, 'branch': branch}
    running = client.running(branch)
    if len(running) > 1:
        return {'status': 'multiple_workspaces', 'nextStep': 'Inspect duplicate workspaces before recovery.'}
    pending = state.get('pending')
    if pending:
        result = client.build(pending)
        if result['status'] == 'starting':
            if now - state.get('lastRequest', now) < 1800:
                return result
            result = {'status': 'startup_timeout', 'sn': pending,
                      'nextStep': 'The accepted build produced no verified healthy heartbeat within 30 minutes.'}
        if result['status'] == 'blocked_import_branch':
            if not check:
                state.update({'blocked': result, 'blockedAt': state.get('blockedAt', now)})
            if check or (not retry_blocked and now - state.get('blockedAt', now) < 21600):
                return result
        if check:
            return result
        state.pop('pending', None)
        state.pop('blockedAt', None)
        state.pop('blocked', None)
    if check:
        return {'status': 'unhealthy', 'branch': branch, 'running': [row['sn'] for row in running]}
    state['failures'] = state.get('failures', 0) + 1
    if not retry_blocked and state['failures'] < int(env.get('CNB_THRESH_RECYCLE', '2')):
        return {'status': 'failure_threshold', 'failures': state['failures']}
    cooldown = int(env.get('RECOVER_COOLDOWN', '1800'))
    if not retry_blocked and now - state.get('lastRequest', 0) < cooldown:
        return {'status': 'cooldown', 'retryAfterSeconds': int(cooldown - (now - state['lastRequest']))}
    if running:
        sn = running[0]['sn']
        if not SN.fullmatch(sn):
            raise RecoveryError('Invalid workspace identifier')
        value = client.request(REPO + '/-/build/stop/' + sn, body={})
        if value.get('success') is False or not (value.get('success') is True or value.get('sn') == sn):
            raise RecoveryError('CNB stop response rejected')
        state['lastRequest'] = now - cooldown + 60
        return {'status': 'stopping_unhealthy_workspace', 'sn': sn}
    value = client.request(REPO + '/-/workspace/start', body={'branch': branch})
    sn = value.get('sn')
    if not isinstance(sn, str) or not SN.fullmatch(sn):
        raise RecoveryError('CNB start response did not include a build identifier')
    state.update({'pending': sn, 'lastRequest': now})
    # Check the accepted build immediately; later cron ticks continue polling it.
    result = client.build(sn)
    if result['status'] == 'blocked_import_branch':
        state.update({'blocked': result, 'blockedAt': now})
    return result


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(state), encoding='utf-8')
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=Path('/etc/cnb-watchdog-superagent.env'))
    parser.add_argument('--check', action='store_true', help='Read status without API mutations or local writes')
    parser.add_argument('--retry-blocked', action='store_true', help='Retry after repairing a recorded import configuration failure')
    args = parser.parse_args()
    env, state_path, state = None, None, None
    try:
        env = load_env(args.env_file)
        state_path = Path(env.get('CNB_RECOVERY_STATE', '/root/.cnb-superagent/recovery-state.json'))
        try:
            state = json.loads(state_path.read_text())
        except FileNotFoundError:
            state = {}
        result = step(Client(env), env, state, check=args.check, retry_blocked=args.retry_blocked)
        if not args.check:
            save_state(state_path, state)
        output = json.dumps({'time': time.strftime('%Y-%m-%dT%H:%M:%S%z'), **result}, ensure_ascii=False)
        print(output)
        if not args.check:
            with Path(env.get('CNB_WATCHDOG_LOG', '/var/log/cnb-watchdog-superagent.log')).open('a', encoding='utf-8') as log:
                log.write(output + '\n')
        return 0 if result['status'] == 'healthy' else 1
    except (RecoveryError, OSError, ValueError) as exc:
        # Preserve an accepted build ID even if its first status request fails.
        if not args.check and state_path is not None and isinstance(state, dict):
            try:
                save_state(state_path, state)
            except OSError:
                pass
        output = json.dumps({'time': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'status': 'recovery_error', 'errorType': type(exc).__name__, 'message': str(exc) if isinstance(exc, RecoveryError) else 'Recovery state or network request failed.'})
        print(output)
        if not args.check and env:
            try:
                with Path(env.get('CNB_WATCHDOG_LOG', '/var/log/cnb-watchdog-superagent.log')).open('a', encoding='utf-8') as log:
                    log.write(output + '\n')
            except OSError:
                pass
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
