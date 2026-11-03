"""Windows service manager for scripts/dsh-superagent."""
import argparse
import json
import msvcrt
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = ROOT / '.artifacts'
CONTROL = ARTIFACTS / 'control' / 'profiles'
KEEP_LOGS = 20


def control(profile):
    directory = CONTROL / profile
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def process_list():
    """Read process identities from CIM; command lines remain intact for exact profile matching."""
    script = "$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress"
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=15, check=True)
    if not result.stdout.strip():
        return []
    value = json.loads(result.stdout)
    return value if isinstance(value, list) else [value]


def profile_service(row, profile):
    name = str(row.get('Name') or '').lower()
    command = str(row.get('CommandLine') or '')
    if name not in ('node.exe', 'dsh.exe') or 'dsh' not in command.lower():
        return False
    words = re.findall(r'"([^\"]*)"|([^\s]+)', command)
    argv = [quoted or plain for quoted, plain in words]
    matched = any(argv[i] == '--profile' and i + 1 < len(argv) and argv[i + 1] == profile
                  or argv[i] == '--profile=' + profile for i in range(len(argv)))
    return matched and 'plugin' not in argv


def identity_alive(identity, profile):
    if not isinstance(identity, dict) or not isinstance(identity.get('pid'), int):
        return False
    try:
        row = next((item for item in process_list() if int(item.get('ProcessId', -1)) == identity['pid']), None)
        return bool(row and str(row.get('CreationDate')) == identity.get('created') and profile_service(row, profile))
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


def processes(profile):
    found = []
    for row in process_list():
        if profile_service(row, profile):
            found.append({'pid': int(row['ProcessId']), 'created': str(row.get('CreationDate'))})
    stored = read_json(control(profile) / 'service.json')
    if stored and identity_alive(stored, profile) and all(row['pid'] != stored['pid'] for row in found):
        found.append({'pid': stored['pid'], 'created': stored['created']})
    return found


def state(url):
    request = urllib.request.Request(url.rstrip('/') + '/orchestrator/api/state', headers={'x-orchestrator-request': '1'})
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            value = json.load(response)
        health, setup = value.get('health') or {}, value.get('setup') or {}
        entries = {name: entry if isinstance(entry, dict) else {} for name, entry in health.items()}
        return {'health': {name: entry.get('state') for name, entry in entries.items()},
                'errors': {name: str(entry.get('detail', '')) for name, entry in entries.items() if entry.get('state') == 'error'},
                'setup': setup.get('problem'), 'feishu': setup.get('feishuProblem')}
    except (OSError, ValueError, AttributeError):
        return None


def runtime_up(current):
    return current is not None and current['health'].get('runtime') in ('ready', 'paused')


def part_errors(current):
    return {name: detail for name, detail in sorted(current['errors'].items()) if name != 'runtime'}


def outcome(pids, current):
    if len(pids) != 1 or not runtime_up(current):
        return 1
    if current['setup']:
        return 3
    return 2 if part_errors(current) else 0


def status(args):
    pids = processes(args.profile)
    current = state(args.url) if pids else None
    print(json.dumps({'pids': [row['pid'] for row in pids], 'cwd': str(ROOT), 'url': args.url,
                      'manually_stopped': (control(args.profile) / 'manually-stopped').exists(),
                      'health': current and current['health'], 'errors': current and current['errors'],
                      'setup': current and current['setup'], 'feishu': current and current['feishu']}, ensure_ascii=False, indent=2))
    return outcome(pids, current)


def ask_worker_to_stop(profile):
    directory = control(profile)
    service = read_json(directory / 'service.json')
    if not service or not identity_alive(service, profile):
        return []
    request = {'token': service.get('token'), 'pid': service['pid'], 'created': service['created']}
    (directory / 'stop-request.json').write_text(json.dumps(request), encoding='utf-8')
    return [service]


def stop(args, intentional=True):
    pids = processes(args.profile)
    if len(pids) > 1:
        raise RuntimeError('Multiple dsh-superagent processes found; refusing to choose one.')
    if intentional:
        (control(args.profile) / 'manually-stopped').write_text(time.strftime('%Y-%m-%dT%H:%M:%S%z') + '\n', encoding='utf-8')
    managed = ask_worker_to_stop(args.profile)
    if pids and not managed:
        raise RuntimeError('The running dsh-superagent process is not managed by this service wrapper; refusing an unverified shutdown.')
    deadline = time.monotonic() + args.stop_timeout
    while pids and identity_alive(managed[0], args.profile):
        if time.monotonic() >= deadline:
            raise RuntimeError('Graceful stop timed out; no forced kill was sent. Check status.')
        time.sleep(0.5)
    directory = control(args.profile)
    (directory / 'service.json').unlink(missing_ok=True)
    (directory / 'stop-request.json').unlink(missing_ok=True)
    print('dsh-superagent stopped. Automatic recovery is paused until start/restart.' if intentional else 'dsh-superagent stopped.')


def prune_logs(profile):
    pattern = re.compile(re.escape(f'dsh-superagent-{profile}-') + r'\d{8}-\d{6}-\d+\.log')
    logs = sorted((path for path in ARTIFACTS.iterdir() if pattern.fullmatch(path.name)), key=lambda path: path.stat().st_mtime)
    for path in logs[:-KEEP_LOGS]:
        path.unlink(missing_ok=True)


def dsh_entry(executable):
    """Resolve the official npm dsh shim to its JS entry so CTRL_BREAK can be adapted safely."""
    for parent in Path(executable).resolve().parents:
        candidate = parent / 'node_modules' / '@deepseek-ai' / 'dsh' / 'lib' / 'bin.js'
        if candidate.is_file():
            return candidate
    raise RuntimeError('Could not locate @deepseek-ai/dsh/lib/bin.js next to the dsh command shim.')


def worker(profile, log_path, token):
    """Hidden parent wrapper; it alone controls the dsh process group and validates stop requests."""
    dsh = shutil.which('dsh')
    if not dsh:
        raise RuntimeError('dsh must be on PATH.')
    node = shutil.which('node')
    if not node:
        raise RuntimeError('node must be on PATH.')
    entry = dsh_entry(dsh)
    bootstrap = Path(__file__).with_name('dsh-superagent-windows-bootstrap.mjs')
    with open(log_path, 'a', encoding='utf-8') as log:
        environment = os.environ.copy()
        environment['DSH_SUPERAGENT_CONTROL_TOKEN'] = token
        environment['DSH_SUPERAGENT_STOP_REQUEST'] = str(control(profile) / 'stop-request.json')
        child = subprocess.Popen([node, str(bootstrap), str(entry), '--profile', profile, '--no-open'], cwd=ROOT,
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                 creationflags=subprocess.CREATE_NEW_PROCESS_GROUP, env=environment)
        created = None
        managed_pid = None
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            rows = process_list()
            candidates = [item for item in rows if profile_service(item, profile)]
            # The bootstrap is the managed Node process itself; keep a parent fallback for npm shim layouts.
            row = next((item for item in candidates if int(item.get('ProcessId', -1)) == child.pid), None)
            if row is None:
                row = next((item for item in candidates if int(item.get('ParentProcessId', -1)) == child.pid), None)
            if row:
                created = str(row.get('CreationDate'))
                managed_pid = int(row['ProcessId'])
                break
            if child.poll() is not None:
                return child.returncode
            time.sleep(.1)
        if created is None:
            child.wait()
            return child.returncode
        identity = {'pid': managed_pid, 'created': created, 'token': token, 'worker_pid': os.getpid(),
                    'group_pid': child.pid}
        control(profile).joinpath('service.json').write_text(json.dumps(identity), encoding='utf-8')
        request_path = control(profile) / 'stop-request.json'
        while child.poll() is None:
            request = read_json(request_path)
            if request and request.get('token') == token and request.get('pid') == managed_pid and request.get('created') == created:
                # The Node bootstrap rechecks token + its own PID, then emits SIGTERM into DSH's shutdown hooks.
                log.write('Authenticated stop request handed to the DSH Windows bootstrap.\n'); log.flush()
                break
            time.sleep(.25)
        result = child.wait()
        current = read_json(control(profile) / 'service.json')
        if current and current.get('token') == token:
            (control(profile) / 'service.json').unlink(missing_ok=True)
        return result


def launch(args):
    directory = control(args.profile)
    pids = processes(args.profile)
    if len(pids) > 1:
        raise RuntimeError('Multiple dsh-superagent processes found; refusing to start another.')
    if not pids:
        if state(args.url) is not None:
            raise RuntimeError('An existing orchestrator answers at this URL; refusing duplicate startup.')
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime('%Y%m%d-%H%M%S')
        log = ARTIFACTS / f'dsh-superagent-{args.profile}-{stamp}-{os.getpid()}.log'
        log.touch()
        prune_logs(args.profile)
        token = secrets.token_urlsafe(32)
        python = sys.executable
        script = str(Path(__file__).resolve())
        def ps_literal(value):
            return "'" + value.replace("'", "''") + "'"
        def win_argument(value):
            # Start-Process joins ArgumentList into one command line; quote paths with spaces for the CRT parser.
            return subprocess.list2cmdline([value])
        arguments = [script, '--worker', args.profile, str(log), token]
        encoded_arguments = ', '.join(ps_literal(win_argument(value)) for value in arguments)
        command = f"Start-Process -FilePath {ps_literal(python)} -ArgumentList @({encoded_arguments}) -WindowStyle Hidden | Out-Null"
        subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command], check=True, capture_output=True, text=True)
        print('Log: ' + str(log), flush=True)
    else:
        print(f"dsh-superagent already running (PID {pids[0]['pid']}); no duplicate started.", flush=True)
    (directory / 'manually-stopped').unlink(missing_ok=True)
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        current = state(args.url)
        if processes(args.profile) and runtime_up(current):
            code = status(args)
            if current['setup']:
                print('dsh-superagent is waiting for setup: ' + str(current['setup'].get('detail', '')))
                print('Open the URL DSH printed in the log, then the dsh-superagent overview.')
            if current['feishu']:
                print('dsh-superagent runs without Feishu: ' + str(current['feishu'].get('detail', '')))
                print('Fix it on the Feishu card of the Source settings.')
            for name, detail in part_errors(current).items():
                print(f'{name} reports an error, which a restart does not fix: {detail}')
            return code
        time.sleep(1)
    status(args)
    raise RuntimeError('Startup health check timed out; inspect the log. Any running process was left intact.')


def main():
    parser = argparse.ArgumentParser(description='Manage a local dsh-superagent Windows service.')
    parser.add_argument('action', nargs='?', choices=['start', 'stop', 'restart', 'status'])
    parser.add_argument('--worker', nargs=3, metavar=('PROFILE', 'LOG', 'TOKEN'))
    parser.add_argument('--profile', default=os.environ.get('DSH_SUPERAGENT_PROFILE') or 'superagent')
    parser.add_argument('--url', default=os.environ.get('DSH_SUPERAGENT_URL') or 'http://127.0.0.1:3082')
    parser.add_argument('--timeout', type=float, default=60)
    parser.add_argument('--stop-timeout', type=float, default=300)
    parser.add_argument('--respect-stop', action='store_true')
    args = parser.parse_args()
    if args.worker:
        return worker(*args.worker)
    if not args.action:
        parser.error('an action is required')
    if args.timeout <= 0 or args.stop_timeout <= 0:
        parser.error('--timeout and --stop-timeout must be positive')
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*', args.profile):
        parser.error('--profile must be a DSH profile name')
    directory = control(args.profile)
    lock_path = directory / 'operation.lock'
    with lock_path.open('a+b') as lock:
        if lock.tell() == 0:
            lock.write(b'0'); lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise RuntimeError('Another dsh-superagent control operation is in progress.') from None
        try:
            if args.respect_stop and args.action in ('start', 'restart') and (directory / 'manually-stopped').exists():
                print('Intentional stop is active; automatic recovery skipped.')
                return 0
            if args.action == 'status':
                return status(args)
            if args.action in ('stop', 'restart'):
                stop(args, intentional=args.action == 'stop')
            if args.action in ('start', 'restart'):
                return launch(args)
            return 0
        finally:
            lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
