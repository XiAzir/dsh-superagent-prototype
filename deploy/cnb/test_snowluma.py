from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import uuid
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from deploy.cnb import snowluma


class FakeDocker:
    def __init__(self):
        self.calls: list[tuple[list[str], dict[str, str]]] = []
        self.pulled = False
        self.info: dict | None = None
        self.configured_mac = ''

    @staticmethod
    def result(code=0, stdout='', stderr=''):
        return SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr)

    def __call__(self, args, *, capture_output, text, timeout, env, check):
        args = list(args)
        self.calls.append((args, dict(env)))
        if args[:3] == ['docker', 'image', 'inspect']:
            return self.result(0 if self.pulled else 1)
        if args[:2] == ['docker', 'pull']:
            self.pulled = True
            return self.result(stdout='image pulled')
        if args[:3] == ['docker', 'run', '--rm']:
            mount = args[args.index('-v') + 1]
            marker_path = Path(mount.rsplit(':', 2)[0])
            return self.result(stdout=marker_path.read_text(encoding='ascii'))
        if args[:2] == ['docker', 'inspect']:
            if self.info is None:
                return self.result(1)
            return self.result(stdout=json.dumps([self.info]))
        if args[:3] == ['docker', 'run', '-d']:
            self.info = self._container_from_run(args, env)
            self.configured_mac = self.info['NetworkSettings']['Networks']['bridge']['MacAddress']
            return self.result(stdout='container-id')
        if args[:2] == ['docker', 'start']:
            assert self.info is not None
            self.info['State']['Running'] = True
            self.info['NetworkSettings']['Networks']['bridge']['MacAddress'] = self.configured_mac
            return self.result(stdout=snowluma.CONTAINER)
        if args[:2] == ['docker', 'stop']:
            assert self.info is not None
            self.info['State']['Running'] = False
            return self.result(stdout=snowluma.CONTAINER)
        raise AssertionError(f'unexpected docker command: {args}')

    @staticmethod
    def _container_from_run(args, process_env):
        labels, env_names, binds, ports = {}, [], [], {}
        restart, network, hostname, mac = '', '', '', ''
        security, caps, log_opts, log_type, shm_size, ulimits = [], [], {}, '', 0, []
        i = 3
        while i < len(args):
            arg = args[i]
            if arg == '--label':
                key, value = args[i + 1].split('=', 1); labels[key] = value; i += 2
            elif arg in ('--hostname', '--restart', '--network', '--security-opt', '--mac-address',
                         '--log-driver', '--log-opt', '-e', '-v', '-p', '--ulimit'):
                value = args[i + 1]
                if arg == '--hostname': hostname = value
                elif arg == '--restart': restart = value
                elif arg == '--network': network = value
                elif arg == '--security-opt': security.append(value)
                elif arg == '--mac-address': mac = value
                elif arg == '--log-driver': log_type = value
                elif arg == '--log-opt':
                    key, val = value.split('=', 1); log_opts[key] = val
                elif arg == '-e': env_names.append(value)
                elif arg == '-v': binds.append(value)
                elif arg == '-p':
                    host, container = value.rsplit(':', 1)
                    host_ip, host_port = host.rsplit(':', 1)
                    ports.setdefault(f'{container}/tcp', []).append({'HostIp': host_ip, 'HostPort': host_port})
                elif arg == '--ulimit':
                    name, limit = value.split('=', 1); soft, hard = limit.split(':', 1)
                    ulimits.append({'Name': name, 'Soft': int(soft), 'Hard': int(hard)})
                i += 2
            elif arg == '--cap-add':
                caps.append(args[i + 1]); i += 2
            elif arg.startswith('--shm-size='):
                shm_size = 1073741824; i += 1
            elif arg == snowluma.IMAGE:
                break
            else:
                i += 1
        container_env = [f'{key}={process_env[key]}' for key in env_names]
        return {
            'Config': {'Image': snowluma.IMAGE, 'Hostname': hostname, 'Labels': labels, 'Env': container_env},
            'HostConfig': {
                'Binds': binds, 'PortBindings': ports, 'NetworkMode': network,
                'RestartPolicy': {'Name': restart}, 'SecurityOpt': security, 'Privileged': False,
                'CapAdd': caps, 'ShmSize': shm_size, 'Ulimits': ulimits,
                'LogConfig': {'Type': log_type, 'Config': log_opts},
            },
            'NetworkSettings': {'Networks': {'bridge': {'MacAddress': mac}}},
            'State': {'Running': True},
        }


class SnowLumaTests(unittest.TestCase):
    def setUp(self):
        test_root = Path(__file__).resolve().parents[2] / 'tmp'
        test_root.mkdir(exist_ok=True)
        self.tmp = test_root / f'cnb-snowluma-test-{os.getpid()}-{uuid.uuid4().hex}'
        self.tmp.mkdir()
        self.data, self.control = self.tmp / 'data', self.tmp / 'control'
        self.data.mkdir(); self.control.mkdir()
        self.docker = FakeDocker()
        self.client = snowluma.SnowLuma(self.data, self.control, self.docker, sleep=lambda _seconds: None)
        self._env = patch.dict(os.environ, {
            'SUPERAGENT_ARCHIVE_TOKEN': 'supervisor-private-token',
            'SUPERAGENT_WEB_TUNNEL_KEY_B64': 'supervisor-tunnel-private-key',
            'PATH': os.environ.get('PATH', ''),
        }, clear=True)
        self._env.start()

    def tearDown(self):
        self._env.stop()
        shutil.rmtree(self.tmp)

    def write_config(self, value):
        path = self.data / 'snowluma' / snowluma.CONFIG_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')
        if os.name != 'nt': os.chmod(path, 0o644)
        return path

    def test_missing_and_disabled_configuration_are_noops(self):
        expected = {'enabled': False, 'running': False, 'webui_ready': False, 'login': 'not_checked'}
        self.assertFalse(self.client.configured())
        self.assertEqual(self.client.ensure_started(), expected)
        self.assertEqual(self.docker.calls, [])
        config = self.write_config({'enabled': False})
        mode = config.stat().st_mode & 0o777
        self.assertFalse(self.client.configured())
        self.assertEqual(config.stat().st_mode & 0o777, mode)
        self.assertEqual(self.client.ensure_started(), expected)
        self.assertEqual(self.docker.calls, [])

    def test_configured_validates_enabled_configuration_read_only(self):
        config = self.write_config({'enabled': True})
        if os.name != 'nt': os.chmod(config, 0o644)
        self.assertTrue(self.client.configured())
        self.assertEqual(config.stat().st_mode & 0o777, 0o644) if os.name != 'nt' else None
        config.write_text('{bad json', encoding='utf-8')
        self.assertFalse(self.client.configured())

    def test_start_uses_pinned_image_private_paths_loopback_and_required_runtime_settings(self):
        config = self.write_config({'enabled': True})
        with patch.object(self.client, '_webui_reachable', return_value=True):
            result = self.client.ensure_started(timeout=0)
        self.assertEqual(result, {'enabled': True, 'running': True, 'webui_ready': True, 'login': 'pending'})
        self.assertEqual(config.stat().st_mode & 0o777, 0o600) if os.name != 'nt' else None
        create_call = next(call for call in self.docker.calls if call[0][:3] == ['docker', 'run', '-d'])
        args, child_env = create_call
        self.assertIn(snowluma.IMAGE, args)
        self.assertIn('127.0.0.1:6081:6081', args)
        self.assertIn('127.0.0.1:5099:5099', args)
        self.assertIn('127.0.0.1:3001:3001', args)
        self.assertNotIn('127.0.0.1:3000:3000', args)
        for bind in ('/app/data', '/app/.config', '/app/.local/share'):
            self.assertTrue(any(item.endswith(bind) for item in args if isinstance(item, str)))
        self.assertIn('--restart', args); self.assertIn('unless-stopped', args)
        self.assertIn('--shm-size=1g', args); self.assertIn('--cap-add=SYS_PTRACE', args)
        self.assertIn('seccomp=unconfined', args)
        self.assertNotIn('no-new-privileges:true', args)
        self.assertNotIn('supervisor-private-token', str(child_env))
        self.assertNotIn('supervisor-tunnel-private-key', str(child_env))
        self.assertEqual((self.data / 'snowluma' / 'identity' / 'mac-address').stat().st_mode & 0o777, 0o600) if os.name != 'nt' else None
        self.assertEqual(child_env['SNOWLUMA_UID'], '1000')
        self.assertEqual(child_env['SNOWLUMA_GID'], '1000')

    def test_optional_onebot_http_port_can_be_enabled(self):
        self.write_config({'enabled': True, 'http_enabled': True})
        with patch.object(self.client, '_webui_reachable', return_value=True):
            self.client.ensure_started(timeout=0)
        args = next(call[0] for call in self.docker.calls if call[0][:3] == ['docker', 'run', '-d'])
        self.assertIn('127.0.0.1:3000:3000', args)

    def test_readiness_does_not_depend_on_qq_login(self):
        self.write_config({'enabled': True})
        with patch.object(self.client, '_webui_reachable', return_value=True):
            result = self.client.ensure_started(timeout=0)
            self.assertTrue(self.client.healthy())
        self.assertEqual(result['login'], 'pending')

    def test_foreign_container_is_never_started_or_stopped(self):
        self.write_config({'enabled': True})
        self.docker.info = {'Config': {'Labels': {'other.owner': 'other'}}, 'HostConfig': {}, 'State': {'Running': True}}
        with self.assertRaises(snowluma.SnowLumaError):
            self.client.ensure_started(timeout=0)
        self.assertFalse(any(call[0][:2] == ['docker', 'stop'] for call in self.docker.calls))

    def test_existing_owned_container_with_changed_configuration_is_rejected(self):
        self.write_config({'enabled': True})
        self.docker.pulled = True
        self.docker.info = {
            'Config': {'Labels': {snowluma.LABEL_KEY: snowluma.LABEL_VALUE}, 'Image': 'wrong-image'},
            'HostConfig': {}, 'State': {'Running': False},
        }
        with self.assertRaisesRegex(snowluma.SnowLumaError, 'differs'):
            self.client.ensure_started(timeout=0)
        self.assertFalse(any(call[0][:2] in (['docker', 'rm'], ['docker', 'stop']) for call in self.docker.calls))

    def test_stop_only_stops_owned_running_container(self):
        self.docker.info = {
            'Config': {'Labels': {snowluma.LABEL_KEY: snowluma.LABEL_VALUE}},
            'HostConfig': {}, 'State': {'Running': True},
        }
        self.assertTrue(self.client.stop())
        self.assertIn(['docker', 'stop', '--time', '30', snowluma.CONTAINER], [call[0] for call in self.docker.calls])

    def test_docker_canonical_capability_and_cnb_nofile_limit_are_reusable(self):
        self.write_config({"enabled": True})
        with patch.object(self.client, '_webui_reachable', return_value=True):
            self.client.ensure_started()
            self.docker.info['HostConfig']['CapAdd'] = ['CAP_SYS_PTRACE']
            self.assertEqual(self.docker.info['HostConfig']['Ulimits'],
                             [{'Name': 'nofile', 'Soft': 65535, 'Hard': 65535}])
            self.client.ensure_started()
        creates = [args for args, _env in self.docker.calls if args[:3] == ['docker', 'run', '-d']]
        self.assertEqual(len(creates), 1)

    def test_symlinked_managed_path_is_rejected(self):
        if os.name == 'nt': self.skipTest('symlink creation requires privileges unavailable in standard Windows sessions')
        self.write_config({'enabled': True})
        outside = self.tmp / 'outside'; outside.mkdir()
        (self.data / 'snowluma' / '.config').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(snowluma.SnowLumaError): self.client.ensure_started(timeout=0)
        self.assertFalse(any(call[0][:3] == ['docker', 'run', '-d'] for call in self.docker.calls))

    def test_invalid_http_port_option_is_rejected(self):
        self.write_config({'enabled': True, 'http_enabled': 'yes'})
        with self.assertRaisesRegex(snowluma.SnowLumaError, 'boolean'):
            self.client.ensure_started(timeout=0)


if __name__ == '__main__':
    unittest.main()
