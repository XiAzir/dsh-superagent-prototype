#!/usr/bin/env python3
"""CNB persistent runtime supervisor for dsh-superagent."""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

try:
    from deploy.cnb import web_tunnel
except ModuleNotFoundError:  # Running runtime.py as a standalone script.
    import web_tunnel

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DATA = Path('/workspace/.superagent-runtime/data')
CONTROL = Path('/workspace/.superagent-runtime/control')
ARCHIVE = HERE / 'archive.py'
PROFILE = 'superagent'
URL = 'http://127.0.0.1:13082'
HEARTBEAT_SECONDS = 30
SNAPSHOT_SECONDS = 300
LEASE_LOST_SECONDS = 90
READY_TIMEOUT = 180
BOOTSTRAP_TIMEOUT = 300
MAX_RESPONSE = 2 * 1024 * 1024
OPERATOR_STOP = CONTROL / 'operator-stop'


def child_environment(overrides: dict[str, str] | None = None) -> dict[str, str]:
    """Forward application settings while keeping supervisor tunnel/archive secrets private."""
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('SUPERAGENT_WEB_TUNNEL_') and key != 'SUPERAGENT_ARCHIVE_TOKEN'}
    if overrides:
        env.update(overrides)
    return env


class RuntimeErrorSafe(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def ensure_dirs() -> None:
    CONTROL.mkdir(parents=True, exist_ok=True, mode=0o700)
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != 'nt':
        os.chmod(CONTROL, 0o700)
        os.chmod(DATA, 0o700)


def write_json(path: Path, value: dict[str, Any], mode: int = 0o600) -> None:
    temp = path.with_name(f'.{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex}.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    if os.name != 'nt':
        os.chmod(temp, mode)
    temp.replace(path)


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def log(event: str, **metadata: Any) -> None:
    safe = {k: v for k, v in metadata.items() if k in {'state', 'reason', 'attempt', 'healthy', 'paused', 'code'}}
    safe['event'] = event
    safe['at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    line = json.dumps(safe, ensure_ascii=False, separators=(',', ':'))
    with (CONTROL / 'runtime.log').open('a', encoding='utf-8') as stream:
        stream.write(line[:2000] + '\n')
    if os.name != 'nt':
        os.chmod(CONTROL / 'runtime.log', 0o600)


def set_status(state: str, **metadata: Any) -> None:
    safe = {k: v for k, v in metadata.items() if k in {
        'pid', 'healthy', 'paused', 'intentional_stop', 'updated_at', 'last_backup', 'last_backup_attempt',
        'next_backup_attempt', 'last_heartbeat', 'reason',
    }}
    safe.update(state=state, updated_at=time.time())
    write_json(CONTROL / 'status.json', safe)


def config() -> dict[str, str]:
    ensure_dirs()
    env_url = os.environ.get('SUPERAGENT_ARCHIVE_URL', '').strip()
    env_token = os.environ.get('SUPERAGENT_ARCHIVE_TOKEN', '').strip()
    saved = read_json(CONTROL / 'credentials.json', {})
    url = env_url or (saved.get('url') if isinstance(saved, dict) else '')
    token = env_token or (saved.get('token') if isinstance(saved, dict) else '')
    if not url or not token:
        raise RuntimeErrorSafe('SUPERAGENT_ARCHIVE_URL and SUPERAGENT_ARCHIVE_TOKEN are required.')
    parsed = urllib.parse.urlsplit(url)
    loopback = parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1')
    if (parsed.scheme != 'https' and not loopback) or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeErrorSafe('Archive URL must use HTTPS, except for loopback tests.')
    if parsed.query or parsed.fragment:
        raise RuntimeErrorSafe('Archive URL cannot contain a query or fragment.')
    if '\n' in url or '\r' in url or '\n' in token or '\r' in token:
        raise RuntimeErrorSafe('Archive configuration contains invalid line breaks.')
    write_json(CONTROL / 'credentials.json', {'url': url.rstrip('/'), 'token': token})
    return {'url': url.rstrip('/'), 'token': token}


def owner() -> str:
    ensure_dirs()
    value = os.environ.get('CNB_BUILD_ID', '').strip()
    if value:
        if len(value) > 128 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', value):
            raise RuntimeErrorSafe('CNB_BUILD_ID has an invalid lease owner format.')
        write_json(CONTROL / 'owner.json', {'owner': value})
        return value
    saved = read_json(CONTROL / 'owner.json', {})
    value = saved.get('owner', '') if isinstance(saved, dict) else ''
    if not isinstance(value, str) or len(value) > 128 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', value):
        raise RuntimeErrorSafe('CNB_BUILD_ID is required on first start to identify the runtime lease owner.')
    if os.name != 'nt':
        os.chmod(CONTROL / 'owner.json', 0o600)
    return value


def request(base: str, token: str, path: str, method: str = 'GET', body: bytes | None = None,
            headers: dict[str, str] | None = None, timeout: float = 10, max_bytes: int = MAX_RESPONSE):
    request_headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}
    if headers:
        request_headers.update(headers)
    req = urllib.request.Request(base + path, data=body, headers=request_headers, method=method)
    try:
        with OPENER.open(req, timeout=timeout) as response:
            data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise RuntimeErrorSafe('Archive service response exceeded its limit.')
            return response.status, response.headers, data
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers, exc.read(max_bytes)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeErrorSafe(f'Archive service request failed ({type(exc).__name__}).') from None


def json_request(settings: dict[str, str], path: str, method: str, value: dict[str, Any], timeout: float = 10):
    status, _, data = request(settings['url'], settings['token'], path, method,
                              json.dumps(value, separators=(',', ':')).encode(),
                              {'Content-Type': 'application/json'}, timeout)
    try:
        result = json.loads(data or b'{}')
    except ValueError:
        result = {}
    return status, result


class Supervisor:
    def __init__(self, settings: dict[str, str], runtime_owner: str):
        self.settings, self.owner = settings, runtime_owner
        self.stop_event = threading.Event()
        self.heartbeat_stop = threading.Event()
        self.lease_lost = threading.Event()
        self.lease_acquired = threading.Event()
        self.last_heartbeat = 0.0
        self.last_backup = 0.0
        self.last_backup_attempt = 0.0
        self.next_backup_attempt = 0.0
        self.backup_failures = 0
        self.dsh_started = False
        self.dsh_starting = False
        self.service_control_lock = threading.Lock()
        self.intentional = False
        self.backup_path = CONTROL / 'snapshot.zip'
        self.web_tunnel_config: web_tunnel.TunnelConfig | None = None
        self.web_tunnel: web_tunnel.WebTunnel | None = None

    def heartbeat_loop(self) -> None:
        while not self.heartbeat_stop.is_set():
            try:
                if not self.lease_acquired.is_set():
                    code, result = json_request(self.settings, '/lease', 'POST', {'owner': self.owner})
                    if code == 409:
                        self._lose_lease(); log('lease_conflict', code=code); return
                    if code not in (200, 201):
                        raise RuntimeErrorSafe(f'Lease acquisition failed with HTTP {code}.')
                    self.last_heartbeat = time.time()
                    self.lease_acquired.set()
                    log('lease_acquired')
                else:
                    code, result = json_request(self.settings, '/heartbeat', 'POST', {
                        'owner': self.owner, 'healthy': self.is_healthy(), 'paused': self.is_paused(),
                        'stage': 'running' if self.dsh_started else 'bootstrapping',
                        'detail': ''.join(ch for ch in os.environ.get('CNB_REPO_SLUG', '') if ord(ch) >= 32)[:240],
                    })
                    if code == 409:
                        self._lose_lease(); log('lease_conflict', code=code); return
                    if code != 200:
                        raise RuntimeErrorSafe(f'Lease heartbeat failed with HTTP {code}.')
                    self.last_heartbeat = time.time()
                    state = 'paused' if self.is_paused() else ('running' if self.dsh_started else 'bootstrapping')
                    set_status(state, pid=os.getpid(), healthy=self.is_healthy(),
                               paused=self.is_paused(), last_heartbeat=self.last_heartbeat, **self.backup_status())
            except RuntimeErrorSafe as exc:
                log('heartbeat_error', reason=str(exc)[:160])
                if self.lease_acquired.is_set() and time.time() - self.last_heartbeat > LEASE_LOST_SECONDS:
                    self._lose_lease(); return
            self.heartbeat_stop.wait(HEARTBEAT_SECONDS)

    def is_healthy(self) -> bool:
        return self.is_paused() or bool(self.dsh_started and self._local_ready())

    def _lose_lease(self) -> None:
        self.lease_lost.set()
        if self.dsh_started and not self.dsh_starting:
            try:
                self.stop_dsh(fenced=True)
            except Exception as exc:
                log('fenced_dsh_stop_error', reason=type(exc).__name__)

    def is_paused(self) -> bool:
        marker = ROOT / '.artifacts' / 'control' / 'profiles' / PROFILE / 'manually-stopped'
        return marker.exists() or OPERATOR_STOP.exists()

    def _local_ready(self) -> bool:
        try:
            req = urllib.request.Request(URL + '/orchestrator/api/state', headers={'x-orchestrator-request': '1'})
            with urllib.request.urlopen(req, timeout=2) as response:
                value = json.loads(response.read(256 * 1024))
            runtime_health = value.get('health', {}).get('runtime', {})
            return runtime_health.get('state') in ('ready', 'paused')
        except (OSError, ValueError, AttributeError):
            return False

    def restore_firstboot(self) -> None:
        if any(DATA.iterdir()):
            log('restore_skipped', reason='data_present')
            return
        code, headers = self._download_backup()
        if code == 404:
            log('restore_skipped', reason='clean_firstboot')
            return
        if code != 200 or headers is None:
            raise RuntimeErrorSafe(f'Backup download failed with HTTP {code}.')
        self._archive_call('validate', self.backup_path)
        self._archive_call('restore', self.backup_path, DATA)
        self.backup_path.unlink(missing_ok=True)
        log('restore_complete')

    def _download_backup(self) -> tuple[int, Any]:
        """Stream one bounded archive to private disk and verify its response digest."""
        temporary = self.backup_path.with_suffix('.download.tmp')
        temporary.unlink(missing_ok=True)
        req = urllib.request.Request(self.settings['url'] + '/backup',
                                     headers={'Authorization': 'Bearer ' + self.settings['token'],
                                              'Accept': 'application/zip'})
        try:
            response_context = OPENER.open(req, timeout=30)
        except urllib.error.HTTPError as exc:
            exc.close()
            if exc.code == 404:
                return 404, None
            return exc.code, None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RuntimeErrorSafe(f'Archive service request failed ({type(exc).__name__}).') from None
        digest = hashlib.sha256()
        total = 0
        try:
            with response_context as response, temporary.open('wb') as output:
                length = response.headers.get('Content-Length')
                try:
                    declared = int(length)
                except (TypeError, ValueError):
                    raise RuntimeErrorSafe('Backup response omitted a valid Content-Length.')
                if declared <= 0 or declared > 512 * 1024 * 1024:
                    raise RuntimeErrorSafe('Backup response size exceeded its limit.')
                deadline = time.monotonic() + 120
                while True:
                    if time.monotonic() >= deadline:
                        raise RuntimeErrorSafe('Backup download exceeded its time limit.')
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > 512 * 1024 * 1024 or total > declared:
                        raise RuntimeErrorSafe('Backup response size exceeded its limit.')
                    digest.update(chunk)
                    output.write(chunk)
                if total != declared:
                    raise RuntimeErrorSafe('Backup response ended before its declared length.')
                expected = response.headers.get('X-Archive-SHA256') or response.headers.get('X-Superagent-SHA256')
                if not expected or digest.hexdigest().lower() != expected.lower():
                    raise RuntimeErrorSafe('Downloaded backup digest did not match its response header.')
                output.flush()
                os.fsync(output.fileno())
            if os.name != 'nt':
                os.chmod(temporary, 0o600)
            temporary.replace(self.backup_path)
            return 200, {}
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    def bootstrap(self) -> bool:
        profile = DATA / 'dsh-home' / 'profiles' / PROFILE
        fresh = not profile.exists()
        subprocess.run(['node', str(ROOT / 'scripts' / 'setup-linux.mjs'), '--home', str(DATA / 'dsh-home'),
                        '--state-dir', str(DATA / 'state'), '--port', '13082'], cwd=ROOT,
                       env=child_environment({'DSH_HOME': str(DATA / 'dsh-home')}), timeout=BOOTSTRAP_TIMEOUT,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
        lock = profile / 'package.json'
        if lock.exists() and (profile / 'pnpm-lock.yaml').exists():
            subprocess.run(['pnpm', '-C', str(profile), 'install', '--frozen-lockfile'], cwd=ROOT,
                           env=child_environment(), timeout=BOOTSTRAP_TIMEOUT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
        return fresh

    def start_dsh(self) -> None:
        if self.is_paused():
            self.intentional = True
            return
        env = child_environment({'DSH_HOME': str(DATA / 'dsh-home'), 'DSH_SUPERAGENT_URL': URL,
                                 'DSH_SUPERAGENT_HTTP_CLOSE': '1'})
        command = [sys.executable, str(ROOT / 'scripts' / 'dsh-superagent'), 'start', '--profile', PROFILE,
                   '--url', URL, '--timeout', str(READY_TIMEOUT)]
        self.dsh_started = True
        self.dsh_starting = True
        try:
            process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + READY_TIMEOUT + 10
            while process.poll() is None:
                if self.lease_lost.is_set():
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                    self.dsh_starting = False
                    self.stop_dsh(fenced=True)
                    raise RuntimeErrorSafe('Managed DSH startup stopped after archive lease fencing.')
                if time.monotonic() >= deadline:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                    self.dsh_starting = False
                    self.stop_dsh(fenced=True)
                    raise RuntimeErrorSafe('Managed DSH startup exceeded its time limit.')
                time.sleep(0.5)
            if process.returncode not in (0, 2, 3):
                self.dsh_starting = False
                self.stop_dsh(fenced=self.lease_lost.is_set())
                raise RuntimeErrorSafe(f'Managed DSH startup failed with status {process.returncode}.')
        finally:
            self.dsh_starting = False
        if self.lease_lost.is_set():
            self.stop_dsh(fenced=True)
            raise RuntimeErrorSafe('Managed DSH startup stopped after archive lease fencing.')
        self.start_web_tunnel()

    def start_web_tunnel(self) -> None:
        if (self.web_tunnel_config is None or self.lease_lost.is_set() or not self.dsh_started
                or self.is_paused()):
            return
        if self.web_tunnel is None:
            def post_session(runtime_owner: str, cookie: str) -> int:
                code, _result = json_request(self.settings, '/web-session', 'POST',
                                             {'owner': runtime_owner, 'cookie': cookie}, timeout=10)
                return code
            self.web_tunnel = web_tunnel.WebTunnel(
                self.web_tunnel_config, self.owner, ROOT, post_session, event_log=log,
                should_stop=lambda: self.lease_lost.is_set() or self.is_paused() or self.stop_event.is_set())
        self.web_tunnel.start()

    def stop_web_tunnel(self) -> None:
        tunnel = self.web_tunnel
        self.web_tunnel = None
        if tunnel is not None:
            tunnel.stop()

    def set_fresh_worker_limit(self) -> None:
        status, _, data = request(URL, '', '/orchestrator/api/settings', headers={'x-orchestrator-request': '1'}, timeout=5)
        if status != 200:
            raise RuntimeErrorSafe(f'Could not read fresh executor settings (HTTP {status}).')
        view = json.loads(data)
        block = view.get('blocks', {}).get('executor', {})
        value, revision = block.get('value'), block.get('revision')
        if not isinstance(value, dict) or not isinstance(revision, int):
            raise RuntimeErrorSafe('Executor settings response had an unexpected shape.')
        value['maxWorkers'] = 1
        payload = json.dumps({'value': value, 'revision': revision}).encode()
        status, _, _ = request(URL, '', '/orchestrator/api/settings/executor', 'PUT', payload,
                               {'Content-Type': 'application/json', 'x-orchestrator-request': '1'}, timeout=5)
        if status not in (200, 201):
            raise RuntimeErrorSafe(f'Could not set the initial executor worker limit (HTTP {status}).')

    def _archive_call(self, action: str, archive: Path, destination: Path | None = None) -> None:
        if action == 'create':
            args = [sys.executable, str(ARCHIVE), action, str(destination), str(archive)]
        elif action == 'restore':
            args = [sys.executable, str(ARCHIVE), action, str(archive), str(destination)]
        else:
            args = [sys.executable, str(ARCHIVE), action, str(archive)]
        subprocess.run(args, cwd=ROOT, env=child_environment(), timeout=180,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)

    def backup(self) -> None:
        if self.lease_lost.is_set() or not self.lease_acquired.is_set():
            raise RuntimeErrorSafe('Snapshot skipped because this runtime no longer owns the archive lease.')
        if self.is_paused():
            raise RuntimeErrorSafe('Snapshot skipped during intentional pause.')
        self.last_backup_attempt = time.time()
        set_status('running', pid=os.getpid(), healthy=self.is_healthy(), paused=False,
                   last_heartbeat=self.last_heartbeat, **self.backup_status())
        staging = CONTROL / 'snapshot-upload.zip'
        try:
            self._archive_call('create', staging, DATA)
            size = staging.stat().st_size
            if size <= 0 or size > 512 * 1024 * 1024:
                raise RuntimeErrorSafe('Snapshot archive exceeded its size limit.')
            if self.lease_lost.is_set() or self.is_paused():
                raise RuntimeErrorSafe('Snapshot skipped because this runtime no longer owns the archive lease.')
            digest = hashlib.sha256()
            with staging.open('rb') as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
            if self.lease_lost.is_set() or self.is_paused():
                raise RuntimeErrorSafe('Snapshot skipped because this runtime no longer owns the archive lease.')
            code = self._upload_backup_file(staging, digest.hexdigest())
            if code == 409:
                self.lease_lost.set()
                raise RuntimeErrorSafe('Snapshot upload was fenced by the archive lease.')
            if code != 200:
                raise RuntimeErrorSafe(f'Backup upload failed with HTTP {code}.')
        finally:
            staging.unlink(missing_ok=True)
        self.last_backup = time.time()
        self.backup_failures = 0
        self.next_backup_attempt = self.last_backup + SNAPSHOT_SECONDS
        paused = self.is_paused()
        set_status('paused' if paused else 'running', pid=os.getpid(), healthy=self.is_healthy(), paused=paused,
                   last_heartbeat=self.last_heartbeat, **self.backup_status())
        log('backup_complete')

    def backup_status(self) -> dict[str, float]:
        return {'last_backup': self.last_backup, 'last_backup_attempt': self.last_backup_attempt,
                'next_backup_attempt': self.next_backup_attempt}

    def note_backup_failure(self, error: BaseException) -> None:
        self.backup_failures += 1
        delay = min(300, 60 * (2 ** min(self.backup_failures - 1, 3)))
        self.next_backup_attempt = time.time() + delay
        log('backup_error', reason=type(error).__name__, attempt=self.backup_failures)
        set_status('running' if self.dsh_started else 'bootstrapping', pid=os.getpid(),
                   healthy=self.is_healthy(), paused=self.is_paused(), last_heartbeat=self.last_heartbeat,
                   **self.backup_status())

    def periodic_backup_if_due(self) -> bool:
        if self.is_paused() or self.lease_lost.is_set():
            return False
        now = time.time()
        due = self.next_backup_attempt or self.last_backup + SNAPSHOT_SECONDS
        if now < due:
            return False
        try:
            self.backup()
            return True
        except (RuntimeErrorSafe, subprocess.SubprocessError, OSError) as exc:
            if not self.lease_lost.is_set():
                self.note_backup_failure(exc)
            return False

    def initial_backup_best_effort(self) -> bool:
        try:
            self.backup()
            return True
        except (RuntimeErrorSafe, subprocess.SubprocessError, OSError) as exc:
            if not self.lease_lost.is_set() and not self.intentional:
                self.note_backup_failure(exc)
            return False

    def _upload_backup_file(self, path: Path, digest: str) -> int:
        """Upload a snapshot with a fixed length and bounded memory, without following redirects."""
        parsed = urllib.parse.urlsplit(self.settings['url'])
        connection_type = http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection
        connection = connection_type(parsed.hostname, parsed.port, timeout=60)
        route = (parsed.path.rstrip('/') + '/backup') or '/backup'
        size = path.stat().st_size
        try:
            connection.putrequest('PUT', route)
            connection.putheader('Authorization', 'Bearer ' + self.settings['token'])
            connection.putheader('Accept', 'application/json')
            connection.putheader('Content-Type', 'application/zip')
            connection.putheader('Content-Length', str(size))
            connection.putheader('X-Archive-SHA256', digest)
            connection.putheader('X-Superagent-Owner', self.owner)
            connection.endheaders()
            sent = 0
            deadline = time.monotonic() + 120
            with path.open('rb') as source:
                while chunk := source.read(1024 * 1024):
                    if time.monotonic() >= deadline:
                        raise RuntimeErrorSafe('Snapshot upload exceeded its time limit.')
                    if self.lease_lost.is_set():
                        raise RuntimeErrorSafe('Snapshot upload stopped after lease fencing.')
                    connection.send(chunk)
                    sent += len(chunk)
            if sent != size:
                raise RuntimeErrorSafe('Snapshot upload ended before its declared length.')
            response = connection.getresponse()
            response.read(1024 * 1024)
            return response.status
        except (OSError, http.client.HTTPException, TimeoutError) as exc:
            raise RuntimeErrorSafe(f'Backup upload failed ({type(exc).__name__}).') from None
        finally:
            connection.close()

    def stop_dsh(self, *, fenced: bool = False) -> None:
        self.stop_web_tunnel()
        if not self.dsh_started:
            return
        with self.service_control_lock:
            self._stop_dsh_locked(fenced=fenced)

    def _stop_dsh_locked(self, *, fenced: bool = False) -> None:
        if not self.dsh_started:
            return
        manual_marker = ROOT / '.artifacts' / 'control' / 'profiles' / PROFILE / 'manually-stopped'
        was_manual_stop = manual_marker.exists()
        env = child_environment({'DSH_HOME': str(DATA / 'dsh-home'), 'DSH_SUPERAGENT_URL': URL})
        stop_timeout = 20 if fenced else 60
        try:
            result = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'dsh-superagent'), 'stop', '--profile', PROFILE,
                                     '--url', URL, '--stop-timeout', str(stop_timeout)], cwd=ROOT, env=env,
                                    timeout=stop_timeout + 5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    check=False)
            if fenced and result.returncode != 0:
                self._force_kill_dsh_profile()
        except subprocess.TimeoutExpired:
            log('dsh_stop_timeout', reason='fenced' if fenced else 'graceful')
            if fenced:
                self._force_kill_dsh_profile()
        finally:
            self.dsh_started = False
            if not was_manual_stop:
                manual_marker.unlink(missing_ok=True)

    def _force_kill_dsh_profile(self) -> None:
        """After a fenced graceful-stop timeout, kill only PIDs the service manager identifies as this profile."""
        env = child_environment({'DSH_HOME': str(DATA / 'dsh-home'), 'DSH_SUPERAGENT_URL': URL})
        try:
            result = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'dsh-superagent'), 'status',
                                     '--profile', PROFILE, '--url', URL], cwd=ROOT, env=env,
                                    capture_output=True, text=True, timeout=5)
            pids = json.loads(result.stdout).get('pids', [])
        except (OSError, subprocess.SubprocessError, ValueError, AttributeError):
            log('fenced_force_kill_scan_failed')
            return
        for pid in pids if isinstance(pids, list) else []:
            if isinstance(pid, int) and self._verified_dsh_profile_pid(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                    log('fenced_dsh_killed')
                except (OSError, ProcessLookupError):
                    pass

    @staticmethod
    def _verified_dsh_profile_pid(pid: int) -> bool:
        try:
            argv = [arg for arg in Path(f'/proc/{pid}/cmdline').read_bytes().decode(errors='replace').split('\0') if arg]
        except OSError:
            return False
        if not argv:
            return False
        first = Path(argv[0]).name
        words = argv[1:]
        if first in ('node', 'nodejs'):
            entry = []
            for word in words:
                if word.startswith('-'):
                    break
                entry.append(word)
            if not entry or Path(' '.join(entry)).name not in ('dsh', 'dsh.js'):
                return False
        elif first not in ('dsh', 'dsh.js'):
            return False
        matched = False
        index = 0
        while index < len(words):
            word = words[index]
            if word == '--profile' and index + 1 < len(words) and words[index + 1] == PROFILE:
                matched = True
                index += 1
            elif word == '--profile=' + PROFILE:
                matched = True
            index += 1
        return matched and 'plugin' not in words

    def _wait_for_resume(self) -> bool:
        while self.is_paused() and not self.stop_event.is_set() and not self.lease_lost.is_set():
            self.intentional = True
            if self.dsh_started:
                self.stop_web_tunnel()
                self.stop_dsh()
            set_status('paused', pid=os.getpid(), healthy=True, paused=True, intentional_stop=True,
                       last_heartbeat=self.last_heartbeat, **self.backup_status())
            self.stop_event.wait(5)
        if self.stop_event.is_set() or self.lease_lost.is_set():
            return False
        self.intentional = False
        return True

    def run(self) -> int:
        heartbeat = threading.Thread(target=self.heartbeat_loop, name='cnb-heartbeat', daemon=True)
        heartbeat.start()
        try:
            try:
                self.web_tunnel_config = web_tunnel.load_config(control=CONTROL)
            except web_tunnel.TunnelConfigError as exc:
                raise RuntimeErrorSafe(str(exc)) from None
            if not self.lease_acquired.wait(15):
                raise RuntimeErrorSafe('Could not acquire the archive lease.')
            if not self._wait_for_resume():
                return 1 if self.lease_lost.is_set() else 0
            self.restore_firstboot()
            fresh = self.bootstrap()
            if not self._wait_for_resume():
                return 1 if self.lease_lost.is_set() else 0
            if self.lease_lost.is_set():
                raise RuntimeErrorSafe('Archive lease was lost during bootstrap.')
            self.start_dsh()
            if fresh:
                self.set_fresh_worker_limit()
            set_status('running', pid=os.getpid(), healthy=True, paused=False, last_heartbeat=self.last_heartbeat,
                       **self.backup_status())
            self.initial_backup_best_effort()
            attempt = 0
            while not self.stop_event.wait(5):
                if self.lease_lost.is_set():
                    self.stop_dsh(fenced=True); return 1
                was_intentional = self.intentional
                if not self._wait_for_resume():
                    return 1 if self.lease_lost.is_set() else 0
                if was_intentional and not self.dsh_started:
                    self.start_dsh()
                if not self._service_exists():
                    attempt += 1
                    if attempt > 5:
                        raise RuntimeErrorSafe('Managed DSH service stopped repeatedly; inspect the local service log.')
                    set_status('restarting', pid=os.getpid(), reason='service_exited', **self.backup_status())
                    time.sleep(min(60, 2 ** attempt))
                    self.start_dsh()
                self.periodic_backup_if_due()
            return 0
        finally:
            self.stop_web_tunnel()
            if not self.intentional and not self.lease_lost.is_set():
                try:
                    self.backup()
                except Exception as exc:
                    log('final_backup_error', reason=type(exc).__name__)
            self.heartbeat_stop.set()
            heartbeat.join(timeout=12)
            if heartbeat.is_alive():
                self.lease_lost.set()
            self.stop_dsh(fenced=self.lease_lost.is_set())
            if self.lease_acquired.is_set():
                try:
                    if not heartbeat.is_alive():
                        json_request(self.settings, '/release', 'POST',
                                     {'owner': self.owner, 'paused': self.intentional}, timeout=5)
                except RuntimeErrorSafe:
                    pass
            set_status('stopped', pid=os.getpid(), healthy=False, paused=self.intentional,
                       intentional_stop=self.intentional, **self.backup_status())

    def _service_exists(self) -> bool:
        try:
            result = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'dsh-superagent'), 'status',
                                     '--profile', PROFILE, '--url', URL], cwd=ROOT, capture_output=True,
                                    text=True, timeout=5,
                                    env=child_environment({'DSH_HOME': str(DATA / 'dsh-home'),
                                                           'DSH_SUPERAGENT_URL': URL}))
            if result.returncode in (0, 2, 3):
                return True
            try:
                status = json.loads(result.stdout)
                return len(status.get('pids', [])) == 1
            except (ValueError, AttributeError):
                return False
        except (OSError, subprocess.TimeoutExpired):
            return self._local_ready()


def lock_file(name: str):
    ensure_dirs()
    path = CONTROL / name
    stream = path.open('a+')
    if os.name != 'nt':
        os.chmod(path, 0o600)
    return stream


def start_lock_file():
    return lock_file('start.lock')


def serve_lock_file():
    return lock_file('serve.lock')


def acquire_exclusive_lock(stream) -> None:
    import fcntl
    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)


def clear_start_markers() -> None:
    """An explicit CLI start resumes only this runtime and its managed DSH profile."""
    OPERATOR_STOP.unlink(missing_ok=True)
    (ROOT / '.artifacts' / 'control' / 'profiles' / PROFILE / 'manually-stopped').unlink(missing_ok=True)


def start(timeout: int = 180) -> int:
    settings, runtime_owner = config(), owner()
    with start_lock_file() as lock:
        try:
            acquire_exclusive_lock(lock)
        except BlockingIOError:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                current = read_json(CONTROL / 'status.json', {})
                if current.get('state') in ('running', 'paused'):
                    print('CNB runtime is ready.')
                    return 0
                if current.get('state') == 'stopped':
                    raise RuntimeErrorSafe('Concurrent CNB runtime startup stopped before becoming ready.')
                time.sleep(0.5)
            raise RuntimeErrorSafe('Concurrent CNB runtime did not become ready within the startup deadline.')
        clear_start_markers()
        status = read_json(CONTROL / 'status.json', {})
        pid = status.get('pid') if isinstance(status, dict) else None
        if pid and process_alive(pid):
            child = None
        else:
            log_path = (CONTROL / 'runtime.log').open('a', encoding='utf-8')
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'serve'], cwd=ROOT,
                                     stdin=subprocess.DEVNULL, stdout=log_path, stderr=log_path, start_new_session=True,
                                     env={**os.environ, 'SUPERAGENT_ARCHIVE_URL': settings['url'],
                                          'SUPERAGENT_ARCHIVE_TOKEN': settings['token']})
            log_path.close()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = read_json(CONTROL / 'status.json', {})
            if current.get('pid') and (child is None or current.get('pid') == child.pid) and current.get('state') in ('running', 'paused'):
                print('CNB runtime is ready.')
                return 0
            if child is not None and child.poll() is not None:
                raise RuntimeErrorSafe('CNB runtime exited during startup; inspect control/runtime.log.')
            if child is None and not process_alive(pid):
                raise RuntimeErrorSafe('CNB runtime exited during startup; inspect control/runtime.log.')
            time.sleep(0.5)
        raise RuntimeErrorSafe('CNB runtime did not become ready within the startup deadline.')


def process_alive(pid: Any) -> bool:
    try:
        value = int(pid)
        os.kill(value, 0)
    except (ValueError, OSError):
        return False
    if os.name == 'nt':
        return True
    try:
        argv = Path(f'/proc/{value}/cmdline').read_bytes().decode(errors='replace').split('\0')
        return len(argv) >= 3 and Path(argv[1]).resolve() == Path(__file__).resolve() and argv[2] == 'serve'
    except (OSError, ValueError):
        return False


def stop(timeout: int = 360, intentional: bool = True) -> int:
    OPERATOR_STOP.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if intentional:
        OPERATOR_STOP.touch(mode=0o600, exist_ok=True)
    else:
        OPERATOR_STOP.unlink(missing_ok=True)
    status = read_json(CONTROL / 'status.json', {})
    pid = status.get('pid') if isinstance(status, dict) else None
    if not pid or not process_alive(pid):
        set_status('stopped', healthy=False, paused=intentional, intentional_stop=intentional)
        try:
            settings, runtime_owner = config(), owner()
            json_request(settings, '/release', 'POST', {'owner': runtime_owner, 'paused': intentional}, timeout=5)
        except (RuntimeErrorSafe, OSError):
            pass
        print('CNB runtime is stopped.')
        return 0
    os.kill(int(pid), signal.SIGTERM)
    deadline = time.monotonic() + timeout
    while process_alive(pid) and time.monotonic() < deadline:
        time.sleep(0.25)
    if process_alive(pid):
        raise RuntimeErrorSafe('CNB runtime did not stop before the deadline.')
    print('CNB runtime stopped.')
    return 0


def serve() -> int:
    settings, runtime_owner = config(), owner()
    with serve_lock_file() as lock:
        try:
            acquire_exclusive_lock(lock)
        except BlockingIOError:
            raise RuntimeErrorSafe('Another CNB runtime supervisor already owns the serve lock.') from None
        supervisor = Supervisor(settings, runtime_owner)
        supervisor.intentional = OPERATOR_STOP.exists()
        def shutdown(*_args):
            supervisor.intentional = supervisor.is_paused()
            supervisor.stop_event.set()
        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)
        set_status('starting', pid=os.getpid(), healthy=False, paused=False)
        return supervisor.run()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('start', 'serve', 'stop', 'shutdown', 'status'))
    parser.add_argument('--timeout', type=int, default=900)
    args = parser.parse_args(argv)
    try:
        if args.action == 'start':
            return start(args.timeout)
        if args.action == 'serve':
            return serve()
        if args.action == 'stop':
            return stop()
        if args.action == 'shutdown':
            return stop(intentional=False)
        ensure_dirs()
        value = read_json(CONTROL / 'status.json', {'state': 'stopped'})
        print(json.dumps(value, ensure_ascii=False))
        return 0 if value.get('state') in ('running', 'paused') else 1
    except (RuntimeErrorSafe, OSError, subprocess.SubprocessError) as exc:
        log('runtime_error', reason=str(exc)[:160])
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
