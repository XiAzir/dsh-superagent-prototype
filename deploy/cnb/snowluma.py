#!/usr/bin/env python3
"""Manage the optional, workspace-owned SnowLuma container for the CNB runtime."""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
import urllib.error
import urllib.request
from typing import Any, Callable

try:
    from deploy.cnb.snowluma_progress import patch_bundle, prepare_bundle
except ModuleNotFoundError:
    from snowluma_progress import patch_bundle, prepare_bundle


# Docker Hub v2.4.0 multi-platform index (verified 2026-11-05).
IMAGE = 'motricseven7/snowluma@sha256:9b035551e8615a20d8367601a6a61c641796d9ed870f5501830f045b68f74667'
AMD64_MANIFEST = 'sha256:74215e3c785099b809a6d00be107c63ecd6deeabf521ec99faf863e156b8573b'
AMD64_CONFIG = 'sha256:99d5fd5c5aceaeb3994a3a59293d39997f2d3bf4923b42aaf141eebb4c731149'
AMD64_IMAGE = 'mirror.ccs.tencentyun.com/motricseven7/snowluma@' + AMD64_MANIFEST
ARCHIVE_IMAGE = 'superagent-snowluma:v2.4.0-amd64'
CONTAINER = 'superagent-snowluma'
LABEL_KEY = 'io.superagent.runtime.owner'
LABEL_VALUE = 'superagent-snowluma-v1'
CONFIG_NAME = 'deployment.json'
WEBUI_URL = 'http://127.0.0.1:5099/'
NOVNC_PORT = 6081
WEBUI_PORT = 5099
ONEBOT_HTTP_PORT = 3000
ONEBOT_WS_PORT = 3001
START_TIMEOUT = 180
PULL_TIMEOUT = 600
BIND_TIMEOUT = 30
PRIVATE_DIR_MODE = 0o777 if os.name == 'nt' else 0o700


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


WEBUI_OPENER = urllib.request.build_opener(_NoRedirect)


class SnowLumaError(RuntimeError):
    """A sanitized SnowLuma runtime error; command output stays private."""


def _safe_child_environment() -> dict[str, str]:
    """Drop secrets owned by the supervisor before invoking Docker."""
    return {key: value for key, value in os.environ.items()
            if key != 'SUPERAGENT_ARCHIVE_TOKEN' and not key.startswith('SUPERAGENT_WEB_TUNNEL_')}


def _as_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode('utf-8', errors='replace')
    return str(value or '')


class SnowLuma:
    """Start, inspect and stop only the specifically labelled SnowLuma container.

    The container's QQ account and SnowLuma state persist in three separate
    directories under ``DATA/snowluma``. The client checks service readiness
    through the WebUI HTTP listener; QQ login remains an operator action.
    """

    def __init__(self, data: Path, control: Path, runner: Callable[..., Any] | None = None,
                 *, webui_url: str = WEBUI_URL, sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic):
        self.data = Path(data)
        self.control = Path(control)
        self.root = self.data / 'snowluma'
        self.runner = runner or subprocess.run
        self.webui_url = webui_url
        self.sleep = sleep
        self.clock = clock
        self.config_path = self.root / CONFIG_NAME
        self.progress_bundle = self.root / 'runtime' / 'index.mjs'
        self.image_archive = self.root / 'runtime' / 'image-amd64.tar.gz'
        self.resolved_image = IMAGE
        self.paths = {
            'data': self.root / 'data',
            'config': self.root / '.config',
            'share': self.root / '.local' / 'share',
            'identity': self.root / 'identity',
        }

    def _run(self, args: list[str], *, timeout: int = 30, env: dict[str, str] | None = None,
             check: bool = True) -> Any:
        try:
            result = self.runner(args, capture_output=True, text=True, timeout=timeout,
                                 env=env if env is not None else _safe_child_environment(), check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            raise SnowLumaError(f'SnowLuma Docker operation failed ({type(exc).__name__}).') from None
        if check and getattr(result, 'returncode', 1) != 0:
            raise SnowLumaError('SnowLuma Docker operation failed; command output was suppressed.')
        return result

    def _assert_managed_path(self, path: Path) -> None:
        data = Path(os.path.abspath(self.data))
        candidate = Path(os.path.abspath(path))
        try:
            relative = candidate.relative_to(data)
        except ValueError:
            raise SnowLumaError('SnowLuma persistent paths must stay inside the managed data directory.') from None
        if self.data.is_symlink():
            raise SnowLumaError('SnowLuma data root must be a real directory.')
        cursor = data
        if cursor.exists() and not cursor.is_dir():
            raise SnowLumaError('SnowLuma data root must be a directory.')
        if os.path.normcase(str(cursor.resolve())) != os.path.normcase(str(data)):
            raise SnowLumaError('SnowLuma data root resolves outside its configured path.')
        for part in relative.parts:
            cursor = cursor / part
            if cursor.is_symlink():
                raise SnowLumaError('SnowLuma persistent paths cannot traverse symlinks.')
        try:
            if not candidate.resolve().is_relative_to(data.resolve()):
                raise SnowLumaError('SnowLuma persistent paths must resolve inside the managed data directory.')
        except OSError:
            raise SnowLumaError('SnowLuma persistent path could not be resolved safely.') from None

    def _load_config(self, *, secure_permissions: bool = True) -> dict[str, Any] | None:
        self._assert_managed_path(self.config_path)
        if not self.config_path.exists():
            return None
        if self.config_path.is_symlink() or not self.config_path.is_file():
            raise SnowLumaError('SnowLuma deployment configuration must be a regular file.')
        try:
            config = json.loads(self.config_path.read_text(encoding='utf-8'))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise SnowLumaError('SnowLuma deployment configuration is invalid.') from None
        if not isinstance(config, dict) or type(config.get('enabled')) is not bool:
            raise SnowLumaError('SnowLuma deployment configuration must contain an enabled boolean.')
        if set(config) - {'enabled', 'http_enabled'}:
            raise SnowLumaError('SnowLuma deployment configuration contains unsupported fields.')
        if 'http_enabled' in config and type(config['http_enabled']) is not bool:
            raise SnowLumaError('SnowLuma http_enabled must be a boolean.')
        if secure_permissions and os.name != 'nt':
            try:
                os.chmod(self.config_path, 0o600)
            except OSError:
                raise SnowLumaError('SnowLuma deployment configuration permissions could not be secured.') from None
        return config

    def configured(self) -> bool:
        """Read and validate the enable bit without changing config permissions."""
        try:
            config = self._load_config(secure_permissions=False)
            return bool(config and config.get('enabled') is True)
        except (SnowLumaError, OSError):
            return False

    def _prepare_paths(self) -> None:
        self._assert_managed_path(self.root)
        if self.control.is_symlink():
            raise SnowLumaError('SnowLuma control directory must be a real directory.')
        self.control.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
        self.data.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
        self.root.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
        for name, path in self.paths.items():
            self._assert_managed_path(path)
            if path.is_symlink() or (path.exists() and not path.is_dir()):
                raise SnowLumaError(f'SnowLuma {name} path must be a real directory.')
            path.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
            if os.name != 'nt':
                os.chmod(path, 0o700)

    def _identity(self) -> str:
        identity = self.paths['identity']
        mac = self._read_or_create(identity / 'mac-address', self._new_mac)
        if len(mac) != 17 or not mac.startswith('02:') or any(
                char not in '0123456789abcdef:' for char in mac):
            raise SnowLumaError('Saved SnowLuma MAC address is invalid.')
        return mac

    @staticmethod
    def _new_mac() -> str:
        return ':'.join(f'{part:02x}' for part in [0x02] + [secrets.randbelow(256) for _ in range(5)])

    @staticmethod
    def _read_or_create(path: Path, factory: Callable[[], str]) -> str:
        if path.is_symlink():
            raise SnowLumaError('SnowLuma identity files must be regular files.')
        if path.exists():
            try:
                value = path.read_text(encoding='ascii').strip()
            except (OSError, UnicodeError):
                raise SnowLumaError('Saved SnowLuma identity is unreadable.') from None
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

    def _probe_bind(self) -> None:
        marker = secrets.token_hex(24)
        marker_path = self.control / f'.snowluma-bind-{secrets.token_hex(8)}'
        try:
            marker_path.write_text(marker, encoding='ascii')
            if os.name != 'nt':
                os.chmod(marker_path, 0o600)
            result = self._run([
                'docker', 'run', '--rm', '--pull=never', '--entrypoint', '/bin/sh',
                '-v', f'{marker_path}:/tmp/superagent-snowluma-bind:ro', self.resolved_image,
                '-c', 'cat /tmp/superagent-snowluma-bind',
            ], timeout=BIND_TIMEOUT, check=False)
            if getattr(result, 'returncode', 1) != 0 or _as_text(getattr(result, 'stdout', '')).strip() != marker:
                raise SnowLumaError('SnowLuma bind mount is not visible to the CNB Docker service.')
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
            raise SnowLumaError('SnowLuma container inspection returned invalid data.') from None

    def _assert_owned(self, info: dict[str, Any]) -> None:
        labels = info.get('Config', {}).get('Labels') or {}
        if labels.get(LABEL_KEY) != LABEL_VALUE:
            raise SnowLumaError('The fixed SnowLuma container name is occupied by a container this runtime does not own.')

    def _expected_binds(self) -> set[str]:
        return {
            f"{self.paths['data']}:/app/data",
            f"{self.paths['config']}:/app/.config",
            f"{self.paths['share']}:/app/.local/share",
            f'{self.progress_bundle}:/app/runtime/index.mjs:ro',
        }

    def _prepare_progress_bundle(self) -> None:
        self._assert_managed_path(self.progress_bundle)
        if self.progress_bundle.is_file():
            original = self.progress_bundle.read_text(encoding='utf-8')
            patched = patch_bundle(original)
            if patched != original:
                # Keep the inode used by an existing read-only Docker bind mount.
                self.progress_bundle.write_text(patched, encoding='utf-8', newline='\n')
            # Private snapshots restore files as 0600; this public-code bind is read by UID 1000.
            self.progress_bundle.chmod(0o644)
            return
        result = self._run(['docker', 'run', '--rm', '--pull=never', '--entrypoint', 'cat', self.resolved_image,
                            '/app/runtime/index.mjs'], timeout=60)
        try:
            prepare_bundle(self.progress_bundle, _as_text(result.stdout))
        except ValueError as exc:
            raise SnowLumaError(str(exc)) from None

    @staticmethod
    def _expected_env() -> dict[str, str]:
        return {
            'SNOWLUMA_WEBUI_HOST': '0.0.0.0',
            'SNOWLUMA_WEBUI_PORT': str(WEBUI_PORT),
            'SNOWLUMA_UID': '1000',
            'SNOWLUMA_GID': '1000',
            'TZ': 'Asia/Shanghai',
        }

    def _expected_ports(self, config: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
        ports = {
            f'{NOVNC_PORT}/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(NOVNC_PORT)}],
            f'{WEBUI_PORT}/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(WEBUI_PORT)}],
            f'{ONEBOT_WS_PORT}/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(ONEBOT_WS_PORT)}],
        }
        if config.get('http_enabled', False):
            ports[f'{ONEBOT_HTTP_PORT}/tcp'] = [{'HostIp': '127.0.0.1', 'HostPort': str(ONEBOT_HTTP_PORT)}]
        return ports

    def _matches(self, info: dict[str, Any], config: dict[str, Any], mac: str) -> bool:
        container_config = info.get('Config') or {}
        host = info.get('HostConfig') or {}
        network_mac = info.get('NetworkSettings', {}).get('Networks', {}).get('bridge', {}).get('MacAddress')
        mac_actual = container_config.get('MacAddress') or network_mac
        mac_matches = mac_actual == mac or (info.get('State', {}).get('Running') is False and not mac_actual)
        env_items = container_config.get('Env') or []
        env_map = dict(item.split('=', 1) for item in env_items if isinstance(item, str) and '=' in item)
        expected_env = self._expected_env()
        actual_managed_env = {key: value for key, value in env_map.items() if key in expected_env}
        return bool(
            self._matches_image(info)
            and container_config.get('Hostname') == 'superagent-snowluma'
            and container_config.get('Labels', {}).get(LABEL_KEY) == LABEL_VALUE
            and actual_managed_env == expected_env
            and set(host.get('Binds') or []) == self._expected_binds()
            and host.get('NetworkMode') == 'bridge'
            and host.get('RestartPolicy', {}).get('Name') == 'unless-stopped'
            and host.get('ShmSize') == 1073741824
            and sorted(cap.removeprefix('CAP_') for cap in (host.get('CapAdd') or [])) == ['SYS_PTRACE']
            and set(host.get('SecurityOpt') or []) == {'seccomp=unconfined', 'no-new-privileges=false'}
            and host.get('Privileged') is False
            and mac_matches
            and (host.get('PortBindings') or {}) == self._expected_ports(config)
            and host.get('Ulimits') and any(item.get('Name') == 'nofile'
                                             and item.get('Soft') == 65535 and item.get('Hard') == 65535
                                             for item in host['Ulimits'])
            and (host.get('LogConfig') or {}).get('Type') == 'json-file'
            and (host.get('LogConfig') or {}).get('Config') == {'max-size': '10m', 'max-file': '3'}
        )

    def _create(self, config: dict[str, Any], mac: str) -> None:
        args = [
            'docker', 'run', '-d', '--pull=never', '--name', CONTAINER,
            '--hostname', 'superagent-snowluma', '--label', f'{LABEL_KEY}={LABEL_VALUE}',
            '--restart', 'unless-stopped', '--network', 'bridge',
            # SnowLuma's Node binary grants CAP_SYS_PTRACE at exec to UID1000.
            # Keep file capabilities enabled so the hook can attach to the QQ process.
            '--shm-size=1g', '--ulimit', 'nofile=65535:65535', '--cap-add=SYS_PTRACE',
            '--security-opt', 'seccomp=unconfined', '--security-opt', 'no-new-privileges=false',
            '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
            '--mac-address', mac,
        ]
        for container_port, binding in self._expected_ports(config).items():
            host_port = binding[0]['HostPort']
            args.extend(['-p', f'127.0.0.1:{host_port}:{container_port.split("/", 1)[0]}'])
        for key in self._expected_env():
            args.extend(['-e', key])
        args.extend([
            '-v', f'{self.paths["data"]}:/app/data',
            '-v', f'{self.paths["config"]}:/app/.config',
            '-v', f'{self.paths["share"]}:/app/.local/share',
            '-v', f'{self.progress_bundle}:/app/runtime/index.mjs:ro',
            self.resolved_image,
        ])
        env = _safe_child_environment()
        env.update(self._expected_env())
        self._run(args, timeout=30, env=env)

    def _running(self, info: dict[str, Any] | None = None) -> bool:
        value = info if info is not None else self._container_info()
        return bool(value and value.get('State', {}).get('Running') is True)

    @staticmethod
    def _matches_image(info: dict[str, Any]) -> bool:
        reference = (info.get('Config') or {}).get('Image')
        if reference == IMAGE:
            return True
        return reference in (AMD64_IMAGE, ARCHIVE_IMAGE) and info.get('Image') in (AMD64_MANIFEST, AMD64_CONFIG)

    def _verified_amd64_image(self, reference: str) -> bool:
        result = self._run(['docker', 'image', 'inspect', reference], check=False)
        if getattr(result, 'returncode', 1) != 0:
            return False
        try:
            values = json.loads(_as_text(getattr(result, 'stdout', '')))
            image = values[0] if isinstance(values, list) and len(values) == 1 else None
            if not isinstance(image, dict):
                raise ValueError
            if image.get('Os') != 'linux' or image.get('Architecture') != 'amd64':
                raise ValueError
            # Docker 29 containerd uses manifest IDs; classic image stores use config IDs.
            if image.get('Id') not in (AMD64_MANIFEST, AMD64_CONFIG):
                raise ValueError
            descriptor = image.get('Descriptor')
            if descriptor and descriptor.get('digest') != AMD64_MANIFEST:
                raise ValueError
            return True
        except (ValueError, TypeError, KeyError, AttributeError):
            raise SnowLumaError('SnowLuma fallback image identity differs from the pinned v2.4.0 amd64 image.') from None

    def _resolve_image(self) -> str:
        """Reuse the original pin or restore the exact amd64 image from managed storage."""
        original = self._run(['docker', 'image', 'inspect', IMAGE], check=False)
        if getattr(original, 'returncode', 1) == 0:
            return IMAGE
        # A previously restored image avoids archive imports or registry requests on restarts.
        for reference in (ARCHIVE_IMAGE, AMD64_IMAGE):
            if self._verified_amd64_image(reference):
                return reference
        self._assert_managed_path(self.image_archive)
        if self.image_archive.exists():
            if self.image_archive.is_symlink() or not self.image_archive.is_file():
                raise SnowLumaError('SnowLuma image archive must be a regular managed file.')
            self._run(['docker', 'image', 'load', '--input', str(self.image_archive)], timeout=PULL_TIMEOUT)
            for reference in (ARCHIVE_IMAGE, AMD64_IMAGE):
                if self._verified_amd64_image(reference):
                    return reference
            raise SnowLumaError('SnowLuma image archive did not restore the pinned image.')
        mirror = self._run(['docker', 'pull', '--platform', 'linux/amd64', AMD64_IMAGE], timeout=PULL_TIMEOUT, check=False)
        if getattr(mirror, 'returncode', 1) == 0 and self._verified_amd64_image(AMD64_IMAGE):
            return AMD64_IMAGE
        # Keep the multi-platform upstream path for installations that still have access.
        self._run(['docker', 'pull', IMAGE], timeout=PULL_TIMEOUT)
        original = self._run(['docker', 'image', 'inspect', IMAGE], check=False)
        if getattr(original, 'returncode', 1) != 0:
            raise SnowLumaError('SnowLuma pinned image is unavailable after pull.')
        return IMAGE

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
        """Return container/WebUI readiness; QQ authentication is deliberately separate."""
        try:
            config = self._load_config()
            if config is None or config['enabled'] is False:
                return True
            info = self._container_info()
            if info is None:
                return False
            self._assert_owned(info)
            return self._matches_image(info) and self._running(info) and self._webui_reachable()
        except (SnowLumaError, OSError):
            return False

    def ensure_started(self, *, timeout: int = START_TIMEOUT) -> dict[str, Any]:
        """Start a configured container, or report a clean disabled/no-config state."""
        config = self._load_config()
        if config is None or config['enabled'] is False:
            return {'enabled': False, 'running': False, 'webui_ready': False, 'login': 'not_checked'}
        self._prepare_paths()
        mac = self._identity()
        self.resolved_image = self._resolve_image()
        self._probe_bind()
        self._prepare_progress_bundle()
        info = self._container_info()
        if info is not None:
            self._assert_owned(info)
            if not self._matches(info, config, mac):
                raise SnowLumaError('Owned SnowLuma container configuration differs; operator review is required before replacement.')
            if not self._running(info):
                self._run(['docker', 'start', CONTAINER])
                started = self._container_info()
                if started is None:
                    raise SnowLumaError('SnowLuma container disappeared after startup.')
                self._assert_owned(started)
                if not self._running(started) or not self._matches(started, config, mac):
                    self.stop()
                    raise SnowLumaError('SnowLuma identity verification failed after startup; the owned container was stopped.')
        else:
            self._create(config, mac)
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
        """Stop the fixed-name container only after verifying its ownership label."""
        info = self._container_info()
        if info is None:
            return False
        self._assert_owned(info)
        if not self._running(info):
            return False
        self._run(['docker', 'stop', '--time', str(max(1, timeout)), CONTAINER], timeout=timeout + 5)
        return True


__all__ = ['SnowLuma', 'SnowLumaError']
