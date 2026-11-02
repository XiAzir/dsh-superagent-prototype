from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import uuid
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from deploy.cnb import napcat


class FakeDocker:
    def __init__(self):
        self.calls: list[tuple[list[str], dict[str, str]]] = []
        self.pulled = False
        self.info: dict | None = None

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
            return self.result(stdout='container-id')
        if args[:2] == ['docker', 'start']:
            assert self.info is not None
            self.info['State']['Running'] = True
            return self.result(stdout='superagent-napcat')
        if args[:2] == ['docker', 'stop']:
            assert self.info is not None
            self.info['State']['Running'] = False
            return self.result(stdout='superagent-napcat')
        raise AssertionError(f'unexpected docker command: {args}')

    @staticmethod
    def _container_from_run(args, process_env):
        labels = {}
        env_names = []
        binds = []
        ports = {}
        restart = ''
        network = ''
        security = []
        log_opts = {}
        log_type = ''
        mac = ''
        hostname = ''
        i = 3
        while i < len(args):
            arg = args[i]
            if arg == '--label':
                key, value = args[i + 1].split('=', 1)
                labels[key] = value
                i += 2
            elif arg == '--hostname':
                hostname = args[i + 1]
                i += 2
            elif arg in ('--restart', '--network', '--security-opt', '--mac-address', '--log-driver', '--log-opt', '-e', '-v', '-p'):
                value = args[i + 1]
                if arg == '--restart': restart = value
                elif arg == '--network': network = value
                elif arg == '--security-opt': security.append(value)
                elif arg == '--mac-address': mac = value
                elif arg == '--log-driver': log_type = value
                elif arg == '--log-opt':
                    key, val = value.split('=', 1)
                    log_opts[key] = val
                elif arg == '-e': env_names.append(value)
                elif arg == '-v': binds.append(value)
                elif arg == '-p':
                    host, container = value.rsplit(':', 1)
                    host_ip, host_port = host.rsplit(':', 1)
                    ports.setdefault(f'{container}/tcp', []).append({'HostIp': host_ip, 'HostPort': host_port})
                i += 2
            elif arg == napcat.IMAGE:
                break
            else:
                i += 1
        container_env = [f'{key}={process_env[key]}' for key in env_names]
        return {
            'Config': {'Image': napcat.IMAGE, 'Hostname': hostname, 'Labels': labels, 'Env': container_env},
            'HostConfig': {
                'Binds': binds, 'PortBindings': ports, 'NetworkMode': network,
                'RestartPolicy': {'Name': restart}, 'SecurityOpt': security, 'Privileged': False,
                'LogConfig': {'Type': log_type, 'Config': log_opts},
            },
            'NetworkSettings': {'Networks': {'bridge': {'MacAddress': mac}}},
            'State': {'Running': True},
        }


class NapCatTests(unittest.TestCase):
    def setUp(self):
        test_root = Path(__file__).resolve().parents[2] / 'tmp'
        test_root.mkdir(exist_ok=True)
        self.tmp = test_root / f'cnb-napcat-test-{os.getpid()}-{uuid.uuid4().hex}'
        self.tmp.mkdir()
        self.data = self.tmp / 'data'
        self.control = self.tmp / 'control'
        self.aliases = self.tmp / 'aliases'
        self.data.mkdir()
        self.control.mkdir()
        (self.data / 'state' / 'artifacts').mkdir(parents=True)
        self.docker = FakeDocker()
        self.client = napcat.NapCat(self.data, self.control, self.docker,
                                     alias_root=self.aliases, sleep=lambda _seconds: None)
        self._env = patch.dict(os.environ, {
            'NAPCAT_WEBUI_TOKEN': 'private-webui-token',
            'SUPERAGENT_ARCHIVE_TOKEN': 'supervisor-private-token',
            'SUPERAGENT_WEB_TUNNEL_KEY_B64': 'supervisor-tunnel-private-key',
            'PATH': os.environ.get('PATH', ''),
        }, clear=True)
        self._env.start()

    def tearDown(self):
        self._env.stop()
        shutil.rmtree(self.tmp)

    def write_config(self, value):
        path = self.data / 'napcat' / napcat.CONFIG_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')
        if os.name != 'nt':
            os.chmod(path, 0o644)
        return path

    def write_webui_config(self, token):
        path = self.data / 'napcat' / 'config' / 'webui.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'token': token}), encoding='utf-8')
        if os.name != 'nt':
            os.chmod(path, 0o644)
        return path

    def test_missing_and_disabled_configuration_are_noops(self):
        self.assertEqual(self.client.ensure_started(), {
            'enabled': False, 'running': False, 'webui_ready': False, 'login': 'not_checked',
        })
        self.assertEqual(self.docker.calls, [])
        self.write_config({'enabled': False})
        self.assertEqual(self.client.ensure_started()['enabled'], False)
        self.assertEqual(self.docker.calls, [])

    def test_persisted_webui_token_is_used_after_environment_is_removed(self):
        self.write_config({'enabled': True})
        webui = self.write_webui_config('persisted-webui-token')
        with patch.dict(os.environ, {'PATH': os.environ.get('PATH', '')}, clear=True), \
             patch.object(self.client, '_webui_reachable', return_value=True), \
             patch.object(self.client, '_ensure_alias'):
            result = self.client.ensure_started(timeout=0)
            self.assertTrue(self.client.healthy())
        self.assertTrue(result['webui_ready'])
        self.assertEqual(webui.stat().st_mode & 0o777, 0o600) if os.name != 'nt' else None
        create_call = next(call for call in self.docker.calls if call[0][:3] == ['docker', 'run', '-d'])
        self.assertEqual(create_call[1]['WEBUI_TOKEN'], 'persisted-webui-token')
        self.assertNotIn('persisted-webui-token', str(create_call[0]))
        self.assertFalse(any('persisted-webui-token' in str(call[1]) for call in self.docker.calls
                             if call[0][:2] == ['docker', 'inspect']))

    def test_empty_and_unsafe_persisted_webui_tokens_are_rejected(self):
        with patch.dict(os.environ, {'NAPCAT_WEBUI_TOKEN': ''}, clear=True):
            with self.assertRaisesRegex(napcat.NapCatError, 'non-empty'):
                self.client._webui_token()
        self.write_webui_config('')
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(napcat.NapCatError, 'non-empty'):
                self.client._webui_token()
        self.write_webui_config('valid-persisted-token')
        path = self.data / 'napcat' / 'config' / 'webui.json'
        path.unlink()
        path.mkdir()
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(napcat.NapCatError, 'missing or unsafe'):
                self.client._webui_token()

    def test_oversized_persisted_webui_json_is_rejected_before_parsing(self):
        path = self.data / 'napcat' / 'config' / 'webui.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(' ' * (napcat.MAX_WEBUI_CONFIG_BYTES + 1), encoding='utf-8')
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(napcat.NapCatError, 'bounded regular file'):
                self.client._webui_token()

    @unittest.skipIf(os.name == 'nt', 'symlink creation requires privileges unavailable in standard Windows sessions')
    def test_persisted_webui_config_symlink_is_rejected(self):
        self.write_webui_config('valid-persisted-token')
        path = self.data / 'napcat' / 'config' / 'webui.json'
        outside = self.tmp / 'webui-outside.json'
        outside.write_text('{"token":"outside-token"}', encoding='utf-8')
        path.unlink()
        path.symlink_to(outside)
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(napcat.NapCatError):
                self.client._webui_token()

    def test_start_creates_private_persistent_paths_and_uses_only_owned_environment(self):
        config = self.write_config({'enabled': True, 'account': '12345678'})
        with patch.object(self.client, '_webui_reachable', return_value=True):
            with patch.object(self.client, '_ensure_alias') as aliases:
                result = self.client.ensure_started(timeout=0)
        self.assertEqual(aliases.call_count, 2)
        self.assertEqual(result, {'enabled': True, 'running': True, 'webui_ready': True, 'login': 'pending'})
        self.assertEqual(config.stat().st_mode & 0o777, 0o600) if os.name != 'nt' else None
        if os.name != 'nt':
            app_link = self.aliases / 'napcat'
            qq_link = self.aliases / '.config' / 'QQ'
            self.assertTrue(app_link.is_symlink())
            self.assertEqual(app_link.resolve(), (self.data / 'napcat' / 'app').resolve())
            self.assertTrue(qq_link.is_symlink())
            self.assertEqual(qq_link.resolve(), (self.data / 'napcat' / 'qq').resolve())
        machine_before = (self.data / 'napcat' / 'identity' / 'machine-id').read_text()
        mac_before = (self.data / 'napcat' / 'identity' / 'mac-address').read_text()
        self.assertEqual(len(machine_before.strip()), 32)
        self.assertTrue(mac_before.startswith('02:'))

        create_call = next(call for call in self.docker.calls if call[0][:3] == ['docker', 'run', '-d'])
        args, child_env = create_call
        self.assertIn('127.0.0.1:6099:6099', args)
        self.assertIn('127.0.0.1:3001:3001', args)
        self.assertIn('--restart', args)
        self.assertIn('unless-stopped', args)
        self.assertNotIn('private-webui-token', args)
        self.assertNotIn('supervisor-private-token', str(child_env))
        self.assertNotIn('supervisor-tunnel-private-key', str(child_env))
        self.assertIn('WEBUI_TOKEN', [args[i + 1] for i, item in enumerate(args[:-1]) if item == '-e'])
        self.assertEqual(child_env['WEBUI_TOKEN'], 'private-webui-token')
        self.assertEqual((self.data / 'napcat' / 'identity' / 'machine-id').read_text(), machine_before)
        self.assertEqual((self.data / 'napcat' / 'identity' / 'mac-address').read_text(), mac_before)
        if os.name != 'nt':
            self.assertEqual((self.data / 'napcat' / 'identity' / 'machine-id').stat().st_mode & 0o777, 0o600)
        with patch.object(self.client, '_webui_reachable', return_value=True), \
             patch.object(self.client, '_ensure_alias'):
            self.client.ensure_started(timeout=0)
        self.assertEqual(sum(call[0][:3] == ['docker', 'run', '-d'] for call in self.docker.calls), 1)

    def test_existing_container_with_foreign_label_is_never_started_or_stopped(self):
        self.write_config({'enabled': True})
        self.docker.info = {
            'Config': {'Labels': {'other.owner': 'other'}},
            'HostConfig': {}, 'State': {'Running': True},
        }
        with patch.object(self.client, '_ensure_alias'), self.assertRaises(napcat.NapCatError):
            self.client.ensure_started(timeout=0)
        self.assertFalse(any(call[0][:2] == ['docker', 'stop'] for call in self.docker.calls))

    def test_owned_container_with_mismatched_config_is_rejected_without_removal(self):
        self.write_config({'enabled': True})
        self.docker.pulled = True
        self.docker.info = {
            'Config': {'Labels': {napcat.LABEL_KEY: napcat.LABEL_VALUE}, 'Image': 'wrong-image'},
            'HostConfig': {}, 'State': {'Running': False},
        }
        with patch.object(self.client, '_ensure_alias'), self.assertRaisesRegex(napcat.NapCatError, 'differs'):
            self.client.ensure_started(timeout=0)
        self.assertFalse(any(call[0][:2] in (['docker', 'rm'], ['docker', 'stop']) for call in self.docker.calls))

    def test_stop_only_stops_owned_running_container(self):
        self.docker.info = {
            'Config': {'Labels': {napcat.LABEL_KEY: napcat.LABEL_VALUE}},
            'HostConfig': {}, 'State': {'Running': True},
        }
        self.assertTrue(self.client.stop())
        self.assertIn(['docker', 'stop', '--time', '30', napcat.CONTAINER], [call[0] for call in self.docker.calls])
        self.assertFalse(any(call[0][:2] == ['docker', 'rm'] for call in self.docker.calls))

    def test_alias_collision_is_refused(self):
        self.write_config({'enabled': True})
        self.aliases.mkdir(exist_ok=True)
        (self.aliases / 'napcat').mkdir()
        with self.assertRaisesRegex(napcat.NapCatError, 'occupied'):
            self.client.ensure_started(timeout=0)
        self.assertFalse(any(call[0][:3] == ['docker', 'run', '-d'] for call in self.docker.calls))

    def test_missing_artifacts_directory_is_created_before_bind_mount(self):
        self.write_config({'enabled': True})
        artifacts = self.data / 'state' / 'artifacts'
        artifacts.rmdir()
        with patch.object(self.client, '_ensure_alias'), patch.object(self.client, '_webui_reachable', return_value=True):
            self.client.ensure_started(timeout=0)
        self.assertTrue(artifacts.is_dir())
        self.assertIn(f'{artifacts}:{artifacts}:ro', next(call[0] for call in self.docker.calls
                                                         if call[0][:3] == ['docker', 'run', '-d']))

    @unittest.skipIf(os.name == 'nt', 'symlink creation requires privileges unavailable in standard Windows sessions')
    def test_symlinked_managed_path_is_rejected(self):
        self.write_config({'enabled': True})
        outside = self.tmp / 'outside'
        outside.mkdir()
        (self.data / 'napcat' / 'config').rmdir()
        (self.data / 'napcat' / 'config').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(napcat.NapCatError, 'symlink'):
            self.client.ensure_started(timeout=0)
        self.assertFalse(any(call[0][:3] == ['docker', 'run', '-d'] for call in self.docker.calls))

    def test_webui_health_and_login_state_are_separate(self):
        self.write_config({'enabled': True})
        self.docker.info = {
            'Config': {'Labels': {napcat.LABEL_KEY: napcat.LABEL_VALUE}},
            'HostConfig': {}, 'State': {'Running': True},
        }
        with patch.object(self.client, '_webui_reachable', return_value=True):
            self.assertTrue(self.client.healthy())


if __name__ == '__main__':
    unittest.main()
