#!/usr/bin/env python3
"""Manage the optional, workspace-owned NapCat container for the CNB runtime."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Callable


IMAGE = 'mlikiowa/napcat-docker@sha256:b101b8968cc31ae428ec0f8e117386e4ced7773b2d8226ed9f7ddfcec55f1b7e'
CONTAINER = 'superagent-napcat'
LABEL_KEY = 'io.superagent.runtime.owner'
LABEL_VALUE = 'superagent-napcat-v1'
CONFIG_NAME = 'deployment.json'
WEBUI_URL = 'http://127.0.0.1:6099/'
WEBUI_PORT = 6099
ONEBOT_PORT = 3001
START_TIMEOUT = 120
PULL_TIMEOUT = 300
BIND_TIMEOUT = 30
MAX_WEBUI_CONFIG_BYTES = 64 * 1024
MAX_WEBUI_TOKEN_LENGTH = 4096
PRIVATE_DIR_MODE = 0o777 if os.name == 'nt' else 0o700


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


WEBUI_OPENER = urllib.request.build_opener(_NoRedirect)


class NapCatError(RuntimeError):
    """A sanitized NapCat runtime error; command output and credentials stay private."""


def _safe_child_environment() -> dict[str, str]:
    """Pass NapCat's own settings while dropping supervisor-only secrets."""
    return {key: value for key, value in os.environ.items()
            if not (key == 'SUPERAGENT_ARCHIVE_TOKEN' or key.startswith('SUPERAGENT_WEB_TUNNEL_'))}


def _as_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode('utf-8', errors='replace')
    return str(value or '')


class NapCat:
    """Start, inspect and stop only the specifically labelled NapCat container.

    ``runner`` follows the ``subprocess.run`` call signature and can be replaced
    by a deterministic fake in unit tests. The class does not remove containers
    or persistent data; incompatible owned containers are rejected for an
    operator-controlled recovery.
    """

    def __init__(self, data: Path, control: Path, runner: Callable[..., Any] | None = None,
                 *, alias_root: Path = Path('/app'), webui_url: str = WEBUI_URL,
                 sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic):
        self.data = Path(data)
        self.control = Path(control)
        self.root = self.data / 'napcat'
        self.runner = runner or subprocess.run
        self.alias_root = Path(alias_root)
        self.webui_url = webui_url
        self.sleep = sleep
        self.clock = clock
        self.config_path = self.root / CONFIG_NAME
        self.paths = {
            'app': self.root / 'app',
            'qq': self.root / 'qq',
            'config': self.root / 'config',
            'plugins': self.root / 'plugins',
            'identity': self.root / 'identity',
        }

    def _run(self, args: list[str], *, timeout: int = 30, env: dict[str, str] | None = None,
             check: bool = True) -> Any:
        try:
            result = self.runner(args, capture_output=True, text=True, timeout=timeout,
                                 env=env if env is not None else _safe_child_environment(), check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            raise NapCatError(f'NapCat Docker operation failed ({type(exc).__name__}).') from None
        if check and getattr(result, 'returncode', 1) != 0:
            raise NapCatError('NapCat Docker operation failed; command output was suppressed.')
        return result

    def _load_config(self) -> dict[str, Any] | None:
        self._assert_managed_path(self.config_path)
        if not self.config_path.exists():
            return None
        if self.config_path.is_symlink() or not self.config_path.is_file():
            raise NapCatError('NapCat deployment configuration must be a regular file.')
        try:
            config = json.loads(self.config_path.read_text(encoding='utf-8'))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise NapCatError('NapCat deployment configuration is invalid.') from None
        if not isinstance(config, dict) or type(config.get('enabled')) is not bool:
            raise NapCatError('NapCat deployment configuration must contain an enabled boolean.')
        if set(config) - {'enabled', 'account'}:
            raise NapCatError('NapCat deployment configuration contains unsupported fields.')
        if 'account' in config and config['account'] is not None:
            account = config['account']
            if not isinstance(account, str) or not re.fullmatch(r'[1-9][0-9]{3,19}', account):
                raise NapCatError('NapCat account must be a QQ number.')
        if os.name != 'nt':
            try:
                os.chmod(self.config_path, 0o600)
            except OSError:
                raise NapCatError('NapCat deployment configuration permissions could not be secured.') from None
        return config

    def configured(self) -> bool:
        """Validate the persisted deployment and return its enable state."""
        config = self._load_config()
        return bool(config and config['enabled'])

    def _prepare_paths(self) -> None:
        self._assert_managed_path(self.root)
        if self.control.is_symlink():
            raise NapCatError('NapCat control directory must be a real directory.')
        self.control.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
        self.data.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
        self.root.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
        for name, path in self.paths.items():
            if path.is_symlink():
                raise NapCatError(f'NapCat {name} path must be a real directory.')
            path.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
            if os.name != 'nt':
                os.chmod(path, 0o700)
        tmp = self.paths['app'] / 'tmp'
        if tmp.is_symlink():
            raise NapCatError('NapCat temporary directory must stay inside its managed app directory.')
        tmp.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
        if os.name != 'nt':
            os.chmod(tmp, 0o700)
        artifacts = self.data / 'state' / 'artifacts'
        self._assert_managed_path(artifacts)
        if artifacts.is_symlink():
            raise NapCatError('Persistent state/artifacts must be a real directory.')
        if artifacts.exists() and not artifacts.is_dir():
            raise NapCatError('Persistent state/artifacts must be a real directory.')
        artifacts.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
        if os.name != 'nt':
            os.chmod(artifacts, 0o700)
        self._ensure_alias(self.alias_root / 'napcat', self.paths['app'])
        self._ensure_alias(self.alias_root / '.config' / 'QQ', self.paths['qq'])

    def _assert_managed_path(self, path: Path) -> None:
        """Reject symlink traversal and paths resolving outside the managed DATA root."""
        data = Path(os.path.abspath(self.data))
        candidate = Path(os.path.abspath(path))
        try:
            relative = candidate.relative_to(data)
        except ValueError:
            raise NapCatError('NapCat persistent paths must stay inside the managed data directory.') from None
        if self.data.is_symlink():
            raise NapCatError('NapCat data root must be a real directory.')
        cursor = data
        if cursor.exists() and not cursor.is_dir():
            raise NapCatError('NapCat data root must be a directory.')
        if os.path.normcase(str(cursor.resolve())) != os.path.normcase(str(data)):
            raise NapCatError('NapCat data root resolves outside its configured path.')
        for part in relative.parts:
            cursor = cursor / part
            if cursor.is_symlink():
                raise NapCatError('NapCat persistent paths cannot traverse symlinks.')
        try:
            if not candidate.resolve().is_relative_to(data.resolve()):
                raise NapCatError('NapCat persistent paths must resolve inside the managed data directory.')
        except OSError:
            raise NapCatError('NapCat persistent path could not be resolved safely.') from None

    @staticmethod
    def _ensure_alias(alias: Path, target: Path) -> None:
        """Create a safe absolute compatibility symlink or accept its exact target."""
        root = alias.parents[1] if alias.name == 'QQ' else alias.parent
        try:
            parent_relative = alias.parent.relative_to(root)
        except ValueError:
            raise NapCatError('NapCat compatibility path is outside its configured alias root.') from None
        cursor = root
        if cursor.is_symlink():
            raise NapCatError(f'NapCat compatibility path is occupied: {cursor}.')
        for part in parent_relative.parts:
            cursor = cursor / part
            if cursor.is_symlink() or (cursor.exists() and not cursor.is_dir()):
                raise NapCatError(f'NapCat compatibility path is occupied: {cursor}.')
        resolved_target = target.resolve()
        if alias.is_symlink():
            try:
                if alias.resolve(strict=True) == resolved_target:
                    return
            except OSError:
                pass
            raise NapCatError(f'NapCat compatibility path is occupied: {alias}.')
        if alias.exists():
            raise NapCatError(f'NapCat compatibility path is occupied: {alias}.')
        try:
            alias.parent.mkdir(parents=True, exist_ok=True)
            alias.symlink_to(resolved_target, target_is_directory=True)
        except OSError as exc:
            raise NapCatError(f'NapCat compatibility path could not be created ({type(exc).__name__}).') from None

    def _identity(self) -> tuple[str, str]:
        identity = self.paths['identity']
        machine_path = identity / 'machine-id'
        mac_path = identity / 'mac-address'
        machine = self._read_or_create(machine_path, lambda: uuid.uuid4().hex)
        mac = self._read_or_create(mac_path, self._new_mac)
        if not re.fullmatch(r'[0-9a-f]{32}', machine):
            raise NapCatError('Saved NapCat machine-id is invalid.')
        if not re.fullmatch(r'02(?::[0-9a-f]{2}){5}', mac):
            raise NapCatError('Saved NapCat MAC address is invalid.')
        return machine, mac

    @staticmethod
    def _new_mac() -> str:
        octets = [0x02] + [secrets.randbelow(256) for _ in range(5)]
        return ':'.join(f'{part:02x}' for part in octets)

    @staticmethod
    def _read_or_create(path: Path, factory: Callable[[], str]) -> str:
        if path.is_symlink():
            raise NapCatError('NapCat identity files must be regular files.')
        if path.exists():
            try:
                value = path.read_text(encoding='ascii').strip()
            except (OSError, UnicodeError):
                raise NapCatError('Saved NapCat identity is unreadable.') from None
            if os.name != 'nt':
                os.chmod(path, 0o600)
            return value
        value = factory()
        path.parent.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
        temp = path.with_name(f'.{path.name}.{secrets.token_hex(8)}.tmp')
        try:
            temp.write_text(value + '\n', encoding='ascii')
            if os.name != 'nt':
                os.chmod(temp, 0o600)
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)
        return value

    def _webui_token(self) -> str:
        env_token = os.environ.get('NAPCAT_WEBUI_TOKEN')
        if env_token is not None:
            token = env_token.strip()
            if not token:
                raise NapCatError('NapCat WebUI token must be a non-empty single-line value.')
            return self._validate_webui_token(token)

        path = self.paths['config'] / 'webui.json'
        self._assert_managed_path(path)
        if path.is_symlink() or not path.is_file():
            raise NapCatError('Persistent NapCat WebUI configuration is missing or unsafe.')
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        try:
            descriptor = os.open(path, flags)
        except OSError:
            raise NapCatError('Persistent NapCat WebUI configuration could not be opened safely.') from None
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_WEBUI_CONFIG_BYTES:
                raise NapCatError('Persistent NapCat WebUI configuration is not a bounded regular file.')
            if os.name != 'nt':
                os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, 'rb') as stream:
                descriptor = -1
                raw = stream.read(MAX_WEBUI_CONFIG_BYTES + 1)
            if len(raw) > MAX_WEBUI_CONFIG_BYTES:
                raise NapCatError('Persistent NapCat WebUI configuration exceeds its size limit.')
            try:
                config = json.loads(raw.decode('utf-8'))
            except (UnicodeError, json.JSONDecodeError):
                raise NapCatError('Persistent NapCat WebUI configuration is invalid.') from None
            if not isinstance(config, dict):
                raise NapCatError('Persistent NapCat WebUI configuration must be a JSON object.')
            token = config.get('token')
            if not isinstance(token, str):
                raise NapCatError('Persistent NapCat WebUI configuration does not contain a token.')
            return self._validate_webui_token(token.strip())
        except NapCatError:
            raise
        except OSError:
            raise NapCatError('Persistent NapCat WebUI configuration could not be read safely.') from None
        finally:
            if descriptor >= 0:
                os.close(descriptor)

    @staticmethod
    def _validate_webui_token(token: str) -> str:
        if not token or len(token) > MAX_WEBUI_TOKEN_LENGTH or '\n' in token or '\r' in token:
            raise NapCatError('NapCat WebUI token must be a bounded non-empty single-line value.')
        return token

    def _probe_bind(self) -> None:
        self.control.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
        marker = secrets.token_hex(24)
        marker_path = self.control / f'.napcat-bind-{secrets.token_hex(8)}'
        try:
            marker_path.write_text(marker, encoding='ascii')
            if os.name != 'nt':
                os.chmod(marker_path, 0o600)
            result = self._run([
                'docker', 'run', '--rm', '--pull=never', '--entrypoint', '/bin/sh',
                '-v', f'{marker_path}:/tmp/superagent-napcat-bind:ro', IMAGE,
                '-c', 'cat /tmp/superagent-napcat-bind',
            ], timeout=BIND_TIMEOUT, check=False)
            if getattr(result, 'returncode', 1) != 0 or _as_text(getattr(result, 'stdout', '')).strip() != marker:
                raise NapCatError('NapCat bind mount is not visible to the CNB Docker service.')
        finally:
            marker_path.unlink(missing_ok=True)

    def _container_info(self) -> dict[str, Any] | None:
        result = self._run(['docker', 'inspect', CONTAINER], check=False)
        if getattr(result, 'returncode', 1) != 0:
            return None
        try:
            value = json.loads(_as_text(getattr(result, 'stdout', '')))
            if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
                raise ValueError
            return value[0]
        except (ValueError, TypeError):
            raise NapCatError('NapCat container inspection returned invalid data.') from None

    def _assert_owned(self, info: dict[str, Any]) -> None:
        labels = info.get('Config', {}).get('Labels') or {}
        if labels.get(LABEL_KEY) != LABEL_VALUE:
            raise NapCatError('The fixed NapCat container name is occupied by a container this runtime does not own.')

    def _expected_env(self, config: dict[str, Any], token: str) -> dict[str, str]:
        result = {
            'MODE': 'ws',
            'WEBUI_TOKEN': token,
            'TMPDIR': '/app/napcat/tmp',
            'TMP': '/app/napcat/tmp',
            'TEMP': '/app/napcat/tmp',
        }
        if config.get('account'):
            result['ACCOUNT'] = config['account']
        return result

    def _expected_binds(self) -> set[str]:
        return {
            f"{self.paths['app']}:/app/napcat",
            f"{self.paths['qq']}:/app/.config/QQ",
            f"{self.paths['config']}:/app/napcat/config",
            f"{self.paths['plugins']}:/app/napcat/plugins",
            f"{self.paths['identity'] / 'machine-id'}:/etc/machine-id:ro",
            f"{self.paths['identity'] / 'machine-id'}:/var/lib/dbus/machine-id:ro",
            f"{self.data / 'state' / 'artifacts'}:{self.data / 'state' / 'artifacts'}:ro",
        }

    def _matches(self, info: dict[str, Any], config: dict[str, Any], token: str, mac: str) -> bool:
        container_config = info.get('Config') or {}
        host = info.get('HostConfig') or {}
        network_mac = info.get('NetworkSettings', {}).get('Networks', {}).get('bridge', {}).get('MacAddress')
        mac_actual = container_config.get('MacAddress') or network_mac
        # Docker 29 clears endpoint MAC details while a container is stopped.
        # Revalidate its actual identity immediately after starting that container.
        mac_matches = mac_actual == mac or (info.get('State', {}).get('Running') is False and not mac_actual)
        expected_env = self._expected_env(config, token)
        env_items = container_config.get('Env') or []
        env_map = dict(item.split('=', 1) for item in env_items if isinstance(item, str) and '=' in item)
        managed_env_keys = {'MODE', 'ACCOUNT', 'WEBUI_TOKEN', 'TMPDIR', 'TMP', 'TEMP'}
        actual_managed_env = {key: value for key, value in env_map.items() if key in managed_env_keys}
        port_bindings = host.get('PortBindings') or {}
        expected_ports = {
            f'{WEBUI_PORT}/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(WEBUI_PORT)}],
            f'{ONEBOT_PORT}/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(ONEBOT_PORT)}],
        }
        log_cfg = host.get('LogConfig') or {}
        expected = (
            container_config.get('Image') == IMAGE
            and container_config.get('Hostname') == 'superagent-qq'
            and container_config.get('Labels', {}).get(LABEL_KEY) == LABEL_VALUE
            and actual_managed_env == expected_env
            and set(host.get('Binds') or []) == self._expected_binds()
            and host.get('NetworkMode') == 'bridge'
            and host.get('RestartPolicy', {}).get('Name') == 'unless-stopped'
            and host.get('SecurityOpt') == ['no-new-privileges:true']
            and host.get('Privileged') is False
            and mac_matches
            and port_bindings == expected_ports
            and log_cfg.get('Type') == 'json-file'
            and log_cfg.get('Config') == {'max-size': '10m', 'max-file': '3'}
        )
        return bool(expected)

    def _create(self, config: dict[str, Any], token: str, mac: str) -> None:
        args = [
            'docker', 'run', '-d', '--name', CONTAINER,
            '--hostname', 'superagent-qq',
            '--label', f'{LABEL_KEY}={LABEL_VALUE}',
            '--restart', 'unless-stopped', '--network', 'bridge',
            '--security-opt', 'no-new-privileges:true',
            '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
            '--mac-address', mac,
            '-p', f'127.0.0.1:{WEBUI_PORT}:{WEBUI_PORT}',
            '-p', f'127.0.0.1:{ONEBOT_PORT}:{ONEBOT_PORT}',
        ]
        for key, value in self._expected_env(config, token).items():
            args.extend(['-e', key])
        args.extend([
            '-v', f'{self.paths["app"]}:/app/napcat',
            '-v', f'{self.paths["qq"]}:/app/.config/QQ',
            '-v', f'{self.paths["config"]}:/app/napcat/config',
            '-v', f'{self.paths["plugins"]}:/app/napcat/plugins',
            '-v', f'{self.paths["identity"] / "machine-id"}:/etc/machine-id:ro',
            '-v', f'{self.paths["identity"] / "machine-id"}:/var/lib/dbus/machine-id:ro',
            '-v', f'{self.data / "state" / "artifacts"}:{self.data / "state" / "artifacts"}:ro',
            IMAGE,
        ])
        env = _safe_child_environment()
        env.update(self._expected_env(config, token))
        self._run(args, timeout=30, env=env)

    def _running(self, info: dict[str, Any] | None = None) -> bool:
        value = info if info is not None else self._container_info()
        return bool(value and value.get('State', {}).get('Running') is True)

    def _webui_reachable(self) -> bool:
        try:
            with WEBUI_OPENER.open(self.webui_url, timeout=2) as response:
                return 200 <= response.status < 500
        except urllib.error.HTTPError as exc:
            try:
                return 200 <= exc.code < 500
            finally:
                exc.close()
        except (urllib.error.URLError, TimeoutError, OSError, socket.timeout):
            return False

    def healthy(self) -> bool:
        """Return container/WebUI readiness; QQ authentication is intentionally separate."""
        try:
            config = self._load_config()
            if config is None or config['enabled'] is False:
                return True
            info = self._container_info()
            if info is None:
                return False
            self._assert_owned(info)
            return self._running(info) and self._webui_reachable()
        except (NapCatError, OSError):
            return False

    def ensure_started(self, *, timeout: int = START_TIMEOUT) -> dict[str, Any]:
        """Start a configured container, or report a clean disabled/no-config state."""
        config = self._load_config()
        if config is None or config['enabled'] is False:
            return {'enabled': False, 'running': False, 'webui_ready': False, 'login': 'not_checked'}
        self._prepare_paths()
        token = self._webui_token()
        _, mac = self._identity()
        image_probe = self._run(['docker', 'image', 'inspect', IMAGE], check=False)
        if getattr(image_probe, 'returncode', 1) != 0:
            self._run(['docker', 'pull', IMAGE], timeout=PULL_TIMEOUT)
        self._probe_bind()
        info = self._container_info()
        if info is not None:
            self._assert_owned(info)
            if not self._matches(info, config, token, mac):
                raise NapCatError('Owned NapCat container configuration differs; operator review is required before replacement.')
            if not self._running(info):
                self._run(['docker', 'start', CONTAINER])
                started = self._container_info()
                if started is None:
                    raise NapCatError('NapCat container disappeared after startup.')
                self._assert_owned(started)
                if not self._running(started) or not self._matches(started, config, token, mac):
                    self.stop()
                    raise NapCatError('NapCat identity verification failed after startup; the owned container was stopped.')
        else:
            self._create(config, token, mac)
        deadline = self.clock() + max(0, timeout)
        while True:
            info = self._container_info()
            if info is not None:
                self._assert_owned(info)
            if self._running(info) and self._webui_reachable():
                return {'enabled': True, 'running': True, 'webui_ready': True, 'login': 'pending'}
            if self.clock() >= deadline:
                return {'enabled': True, 'running': self._running(info), 'webui_ready': False, 'login': 'pending'}
            self.sleep(min(2, max(0.0, deadline - self.clock())))

    def stop(self, *, timeout: int = 30) -> bool:
        """Stop the exact fixed-name container only after verifying its ownership label."""
        info = self._container_info()
        if info is None:
            return False
        self._assert_owned(info)
        if not self._running(info):
            return False
        self._run(['docker', 'stop', '--time', str(max(1, timeout)), CONTAINER], timeout=timeout + 5)
        return True


__all__ = ['NapCat', 'NapCatError']
