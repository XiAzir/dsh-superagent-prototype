#!/usr/bin/env python3
"""Restricted CNB reverse SSH tunnel and DSH web-session synchronizer."""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import http.client
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Any

HOST = '8.148.72.235'
USER = 'cnb-superagent-web'
PORT = 22
REMOTE_BIND = '127.0.0.1:13083:127.0.0.1:13082'
COOKIE_INTERVAL = 45
RETRY_BASE_SECONDS = 2
ANSI = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))')
URL_RE = re.compile(r'https?://[^\s\]\[()<>"\']+')
COOKIE_NAME = re.compile(r'^[!#$%&\'*+.^_`|~0-9A-Za-z-]+$')
DSH_COOKIE_NAME = re.compile(r'^dsh-auth-[A-Za-z0-9_-]{43}$')


class TunnelConfigError(ValueError):
    """Invalid or incomplete reverse-tunnel configuration."""


@dataclass(frozen=True)
class TunnelConfig:
    host: str
    key_path: Path
    known_hosts_path: Path
    config_path: Path | None = None


def load_config(env: dict[str, str] | None = None, control: Path | None = None) -> TunnelConfig | None:
    """Load complete environment settings, or a validated private CONTROL copy."""
    source = os.environ if env is None else env
    names = ('SUPERAGENT_WEB_TUNNEL_KEY_B64', 'SUPERAGENT_WEB_TUNNEL_KNOWN_HOSTS', 'SUPERAGENT_WEB_TUNNEL_HOST')
    values = [source.get(name, '').strip() for name in names]
    directory = control or Path('/workspace/.superagent-runtime/control')
    if not any(values):
        return _load_saved_config(directory)
    if not all(values):
        raise TunnelConfigError('Web tunnel configuration is incomplete.')
    encoded, known_hosts, host = values
    try:
        key = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise TunnelConfigError('Web tunnel private key encoding is invalid.') from None
    _validate_private_key(key)
    pinned_host_line = _validate_known_hosts(known_hosts)
    if host != HOST:
        raise TunnelConfigError('Web tunnel host does not match the pinned host.')
    if os.name == 'nt':
        directory.mkdir(parents=True, exist_ok=True)
    else:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != 'nt':
        os.chmod(directory, 0o700)
    key_path = directory / 'web-tunnel-key'
    known_hosts_path = directory / 'web-tunnel-known-hosts'
    _private_write(key_path, key)
    _private_write(known_hosts_path, (pinned_host_line + '\n').encode('ascii'))
    config_path = directory / 'web-tunnel-config.json'
    config = json.dumps({'host': host, 'user': USER, 'port': PORT, 'remote_bind': REMOTE_BIND,
                         'identity_file': str(key_path), 'known_hosts_file': str(known_hosts_path)},
                        separators=(',', ':')).encode('utf-8') + b'\n'
    _private_write(config_path, config)
    return TunnelConfig(host=host, key_path=key_path, known_hosts_path=known_hosts_path,
                        config_path=config_path)


def _validate_private_key(key: bytes) -> None:
    if len(key) > 64 * 1024 or not key.startswith(b'-----BEGIN ') or b'PRIVATE KEY-----' not in key.splitlines()[0]:
        raise TunnelConfigError('Web tunnel private key is not PEM encoded.')
    if b'\x00' in key:
        raise TunnelConfigError('Web tunnel private key contains invalid data.')


def _validate_known_hosts(known_hosts: str) -> str:
    lines = [line.strip() for line in known_hosts.splitlines() if line.strip() and not line.lstrip().startswith('#')]
    if len(lines) != 1:
        raise TunnelConfigError('Web tunnel requires exactly one pinned host key.')
    parts = lines[0].split()
    if len(parts) < 3 or parts[0] != HOST or parts[1] != 'ssh-ed25519' or not re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', parts[2]):
        raise TunnelConfigError('Web tunnel host key pin is invalid.')
    try:
        if len(base64.b64decode(parts[2], validate=True)) < 32:
            raise ValueError
    except (binascii.Error, ValueError):
        raise TunnelConfigError('Web tunnel host key pin is invalid.') from None
    return lines[0]


def _check_private_path(path: Path, expected_mode: int) -> None:
    try:
        if path.is_symlink():
            raise TunnelConfigError('Saved web tunnel files must be regular private files.')
        info = path.stat()
    except OSError:
        raise TunnelConfigError('Saved web tunnel configuration is incomplete.') from None
    if not stat.S_ISREG(info.st_mode):
        raise TunnelConfigError('Saved web tunnel files must be regular private files.')
    if os.name != 'nt' and (info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_mode & 0o777 != expected_mode):
        raise TunnelConfigError('Saved web tunnel file permissions are unsafe.')


def _load_saved_config(directory: Path) -> TunnelConfig | None:
    config_path = directory / 'web-tunnel-config.json'
    key_path = directory / 'web-tunnel-key'
    known_hosts_path = directory / 'web-tunnel-known-hosts'
    paths = (config_path, key_path, known_hosts_path)
    if not any(path.exists() or path.is_symlink() for path in paths):
        return None
    if os.name != 'nt':
        try:
            info = directory.stat()
        except OSError:
            raise TunnelConfigError('Saved web tunnel configuration is incomplete.') from None
        if (directory.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_mode & 0o777 != 0o700):
            raise TunnelConfigError('Saved web tunnel control directory permissions are unsafe.')
    _check_private_path(config_path, 0o600)
    _check_private_path(key_path, 0o600)
    _check_private_path(known_hosts_path, 0o600)
    try:
        value = json.loads(config_path.read_text(encoding='utf-8'))
        key = key_path.read_bytes()
        known_hosts = known_hosts_path.read_text(encoding='ascii')
    except (OSError, UnicodeError, ValueError):
        raise TunnelConfigError('Saved web tunnel configuration is unreadable.') from None
    expected = {'host': HOST, 'user': USER, 'port': PORT, 'remote_bind': REMOTE_BIND,
                'identity_file': str(key_path), 'known_hosts_file': str(known_hosts_path)}
    if value != expected:
        raise TunnelConfigError('Saved web tunnel configuration does not match fixed settings.')
    _validate_private_key(key)
    if _validate_known_hosts(known_hosts) != known_hosts.rstrip('\n') or not known_hosts.endswith('\n'):
        raise TunnelConfigError('Saved web tunnel host key pin is malformed.')
    return TunnelConfig(HOST, key_path, known_hosts_path, config_path)


def _private_write(path: Path, content: bytes) -> None:
    temp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    try:
        with temp.open('wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if os.name != 'nt':
            os.chmod(temp, 0o600)
        temp.replace(path)
        if os.name != 'nt':
            os.chmod(path, 0o600)
    finally:
        temp.unlink(missing_ok=True)


def ssh_argv(config: TunnelConfig) -> list[str]:
    """Build a fixed, host-pinned forwarding command; secrets stay in files."""
    return [
        'ssh', '-F', '/dev/null', '-N', '-T', '-p', str(PORT), '-i', str(config.key_path),
        '-oIdentitiesOnly=yes', '-oStrictHostKeyChecking=yes',
        '-oUserKnownHostsFile=' + str(config.known_hosts_path),
        '-oExitOnForwardFailure=yes', '-oServerAliveInterval=15', '-oServerAliveCountMax=3',
        '-R', REMOTE_BIND, f'{USER}@{config.host}',
    ]


def ssh_child_environment() -> dict[str, str]:
    return {key: value for key, value in os.environ.items()
            if not key.startswith('SUPERAGENT_WEB_TUNNEL_') and key != 'SUPERAGENT_ARCHIVE_TOKEN'}


def extract_launch_url(log_text: str) -> str | None:
    """Extract a fixed-loopback DSH launch URL without exposing it to callers' logs."""
    cleaned = ANSI.sub('', log_text)
    for candidate in URL_RE.findall(cleaned):
        candidate = candidate.rstrip('.,;')
        try:
            parsed = urllib.parse.urlsplit(candidate)
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            if (parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and parsed.port == 13082
                    and parsed.path == '/' and set(query) == {'token'} and len(query['token']) == 1
                    and query['token'][0] and not parsed.username and not parsed.password):
                return candidate
        except (ValueError, UnicodeError):
            continue
    return None


def extract_cookie_pair(headers: Any) -> str | None:
    """Take the sole Set-Cookie pair from the DSH redirect, excluding attributes."""
    getter = getattr(headers, 'get_all', None)
    values = getter('Set-Cookie', []) if getter else []
    pairs: list[str] = []
    for header in values or []:
        first = str(header).split(';', 1)[0].strip()
        if '=' not in first:
            continue
        name, value = first.split('=', 1)
        pair = name + '=' + value
        if DSH_COOKIE_NAME.fullmatch(name) and COOKIE_NAME.fullmatch(name) and value and len(pair) <= 4096 \
                and not any(ch in pair for ch in '\r\n;'):
            pairs.append(pair)
    return pairs[0] if len(pairs) == 1 else None


def dsh_cookie(root: Path, opener: Any = None) -> tuple[str | None, tuple[str, int, int] | None]:
    """Read the latest runtime log and exchange its launch URL for the session cookie."""
    logs = root / '.artifacts'
    candidates = list(logs.glob('dsh-superagent-superagent-*.log'))
    if not candidates:
        return None, None
    try:
        latest = max(candidates, key=lambda item: item.stat().st_mtime_ns)
        stat = latest.stat()
        identity = (str(latest), stat.st_mtime_ns, stat.st_size)
        text = latest.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None, None
    launch_url = extract_launch_url(text)
    if launch_url is None:
        return None, identity
    request = urllib.request.Request(launch_url, method='GET')
    client = opener or urllib.request.build_opener(_NoRedirect())
    try:
        response = client.open(request, timeout=10)
        headers = response.headers
        status = response.status
        response.close()
    except urllib.error.HTTPError as exc:
        headers, status = exc.headers, exc.code
        exc.close()
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException):
        return None, identity
    if status != 303:
        return None, identity
    return extract_cookie_pair(headers), identity


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class WebTunnel:
    """Own one SSH process group and an independent, retrying cookie reporter."""
    def __init__(self, config: TunnelConfig, owner: str, root: Path, archive_post: Callable[[str, str], Any],
                 event_log: Callable[..., None] | None = None, should_stop: Callable[[], bool] | None = None,
                 popen: Callable[..., Any] | None = None, cookie_reader: Callable[[], tuple[str | None, Any]] | None = None):
        self.config, self.owner, self.root = config, owner, root
        self.archive_post = archive_post
        self.event_log = event_log or (lambda *_args, **_kwargs: None)
        self.should_stop = should_stop or (lambda: False)
        self._popen = popen or subprocess.Popen
        self._cookie_reader = cookie_reader or (lambda: dsh_cookie(self.root))
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.process: Any = None
        self.thread: threading.Thread | None = None
        self.cookie_thread: threading.Thread | None = None

    def start(self) -> None:
        if self.stop_event.is_set():
            return
        if self.thread and self.thread.is_alive():
            return
        self.cookie_thread = threading.Thread(target=self._cookie_loop, name='cnb-web-cookie', daemon=True)
        self.thread = threading.Thread(target=self._ssh_loop, name='cnb-web-tunnel', daemon=True)
        self.cookie_thread.start()
        self.thread.start()

    def _ssh_loop(self) -> None:
        attempt = 0
        while not self.stop_event.is_set():
            try:
                child = self._popen(ssh_argv(self.config), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    start_new_session=(os.name != 'nt'), close_fds=True,
                                    env=ssh_child_environment())
                with self.lock:
                    self.process = child
                self.event_log('web_tunnel_started')
                while not self.stop_event.is_set():
                    try:
                        code = child.wait(timeout=1)
                        self.event_log('web_tunnel_exited', code=code)
                        break
                    except subprocess.TimeoutExpired:
                        continue
                if self.stop_event.is_set():
                    # stop() owns process-group termination and its single shutdown deadline.
                    break
                attempt += 1
                delay = min(60, RETRY_BASE_SECONDS * 2 ** min(attempt - 1, 5))
                self.event_log('web_tunnel_retry', attempt=attempt)
                self.stop_event.wait(delay)
            except (OSError, subprocess.SubprocessError) as exc:
                attempt += 1
                self.event_log('web_tunnel_error', reason=type(exc).__name__, attempt=attempt)
                self.stop_event.wait(min(60, RETRY_BASE_SECONDS * 2 ** min(attempt - 1, 5)))
            finally:
                with self.lock:
                    if (self.process is not None and locals().get('child') is self.process
                            and not self.stop_event.is_set()):
                        self.process = None

    def _cookie_loop(self) -> None:
        last_identity: Any = None
        last_upload = 0.0
        failures = 0
        while not self.stop_event.is_set() and not self.should_stop():
            try:
                cookie, identity = self._cookie_reader()
                due = identity is not None and (identity != last_identity or time.monotonic() - last_upload >= COOKIE_INTERVAL)
                if cookie and due and not self.should_stop():
                    status = self.archive_post(self.owner, cookie)
                    if status in (200, 201, 204):
                        last_identity, last_upload, failures = identity, time.monotonic(), 0
                        self.event_log('web_cookie_reported')
                    else:
                        raise RuntimeError(f'http_{status}')
                failures = 0 if not due or cookie else failures
            except Exception as exc:
                failures += 1
                self.event_log('web_cookie_report_error', reason=type(exc).__name__, attempt=failures)
            delay = min(COOKIE_INTERVAL, RETRY_BASE_SECONDS * 2 ** min(failures - 1, 5)) if failures else COOKIE_INTERVAL
            self.stop_event.wait(delay)

    def _terminate(self, child: Any, deadline: float) -> None:
        remaining = lambda: max(0.05, deadline - time.monotonic())
        try:
            if child.poll() is None:
                if os.name != 'nt' and getattr(child, 'pid', None):
                    os.killpg(child.pid, signal.SIGTERM)
                else:
                    child.terminate()
                try:
                    child.wait(timeout=min(5, remaining()))
                except subprocess.TimeoutExpired:
                    if os.name != 'nt' and getattr(child, 'pid', None):
                        os.killpg(child.pid, signal.SIGKILL)
                    else:
                        child.kill()
                    child.wait(timeout=min(5, remaining()))
        except (OSError, ProcessLookupError, subprocess.SubprocessError):
            pass

    def stop(self, timeout: float = 12) -> None:
        deadline = time.monotonic() + max(0, timeout)
        self.stop_event.set()
        with self.lock:
            child = self.process
        if child is not None:
            self._terminate(child, deadline)
            with self.lock:
                if self.process is child:
                    self.process = None
        for thread in (self.thread, self.cookie_thread):
            if thread and thread.is_alive() and thread is not threading.current_thread():
                thread.join(timeout=max(0, deadline - time.monotonic()))

