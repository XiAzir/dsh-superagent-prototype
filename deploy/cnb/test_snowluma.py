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
from deploy.cnb import snowluma_progress


class FakeDocker:
    def __init__(self):
        self.calls: list[tuple[list[str], dict[str, str]]] = []
        self.pulled = False
        self.images: dict[str, dict] = {}
        self.load_image = {'Id': snowluma.AMD64_MANIFEST, 'Os': 'linux', 'Architecture': 'amd64',
                           'Descriptor': {'digest': snowluma.AMD64_MANIFEST}}
        self.failed_pulls = set()
        self.info: dict | None = None
        self.configured_mac = ''

    @staticmethod
    def result(code=0, stdout='', stderr=''):
        return SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr)

    def __call__(self, args, *, capture_output, text, timeout, env, check):
        args = list(args)
        self.calls.append((args, dict(env)))
        if args[:3] == ['docker', 'image', 'inspect']:
            reference = args[3]
            if reference in self.images:
                return self.result(stdout=json.dumps([self.images[reference]]))
            return self.result(0 if self.pulled and reference == snowluma.IMAGE else 1)
        if args[:3] == ['docker', 'image', 'load']:
            self.images[snowluma.ARCHIVE_IMAGE] = dict(self.load_image)
            return self.result(stdout='Loaded image: ' + snowluma.ARCHIVE_IMAGE)
        if args[:2] == ['docker', 'pull']:
            if args[-1] in self.failed_pulls:
                return self.result(1, stderr='registry unavailable')
            if args[-1] == snowluma.IMAGE:
                self.pulled = True
            else:
                self.images[args[-1]] = dict(self.load_image)
            return self.result(stdout='image pulled')
        if args[:3] == ['docker', 'run', '--rm']:
            if '--entrypoint' in args and args[args.index('--entrypoint') + 1] == 'cat':
                return self.result(stdout='\n'.join(old for old, _new in snowluma_progress.REPLACEMENTS))
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
            elif arg.startswith('--cap-add='):
                caps.append(arg.split('=', 1)[1]); i += 1
            elif arg.startswith('--shm-size='):
                shm_size = 1073741824; i += 1
            elif arg in (snowluma.IMAGE, snowluma.AMD64_IMAGE, snowluma.ARCHIVE_IMAGE):
                break
            else:
                i += 1
        container_env = [f'{key}={process_env[key]}' for key in env_names]
        return {
            'Config': {'Image': args[i], 'Hostname': hostname, 'Labels': labels, 'Env': container_env},
            'Image': snowluma.AMD64_MANIFEST,
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
        self.docker.pulled = True
        self.client = snowluma.SnowLuma(self.data, self.control, self.docker, sleep=lambda _seconds: None)
        self._env = patch.dict(os.environ, {
            'SUPERAGENT_ARCHIVE_TOKEN': 'supervisor-private-token',
            'SUPERAGENT_WEB_TUNNEL_KEY_B64': 'supervisor-tunnel-private-key',
            'PATH': os.environ.get('PATH', ''),
            'SystemRoot': os.environ.get('SystemRoot', 'C:\\Windows'),
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
        self.assertIn('no-new-privileges=false', args)
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

    def test_progress_bundle_is_persisted_mounted_read_only_and_reused(self):
        self.write_config({'enabled': True})
        with patch.object(self.client, '_webui_reachable', return_value=True):
            self.client.ensure_started()
            self.client.ensure_started()
        path = self.client.progress_bundle
        self.assertTrue(path.read_text().startswith(snowluma_progress.MARKER))
        self.assertIn(f'{path}:/app/runtime/index.mjs:ro', self.docker.info['HostConfig']['Binds'])
        extracts = [args for args, _env in self.docker.calls if '/app/runtime/index.mjs' in args]
        self.assertEqual(len(extracts), 1)
        self.assertEqual(snowluma_progress.patch_bundle(path.read_text()), path.read_text())
        path.write_text(path.read_text().replace('Date.now() - lastAt < 8000', 'Date.now() - lastAt < 500'))
        path.chmod(0o600)  # Match the private snapshot restore mode.
        inode = path.stat().st_ino
        with patch.object(self.client, '_webui_reachable', return_value=True):
            self.client.ensure_started()
        self.assertIn('Date.now() - lastAt < 8000', path.read_text())
        self.assertEqual(path.stat().st_ino, inode)
        if os.name != 'nt':
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)

    def test_progress_patch_checks_anchors_before_publishing(self):
        with self.assertRaises(ValueError):
            snowluma_progress.prepare_bundle(self.tmp / 'runtime.mjs', '// incompatible runtime')
        self.assertFalse((self.tmp / 'runtime.mjs').exists())

    def test_archived_image_is_loaded_verified_and_used_by_every_container_operation(self):
        self.write_config({'enabled': True})
        self.docker.pulled = False
        self.client.image_archive.parent.mkdir(parents=True)
        self.client.image_archive.write_bytes(b'fixture image archive')
        with patch.object(self.client, '_webui_reachable', return_value=True):
            self.client.ensure_started(timeout=0)
            self.client.ensure_started(timeout=0)
            self.assertTrue(self.client.healthy())
        calls = [args for args, _env in self.docker.calls]
        loads = [args for args in calls if args[:3] == ['docker', 'image', 'load']]
        self.assertEqual(loads, [['docker', 'image', 'load', '--input', str(self.client.image_archive)]])
        self.assertFalse(any(args[:2] == ['docker', 'pull'] for args in calls))
        for args in calls:
            if args[:2] == ['docker', 'run']:
                self.assertIn(snowluma.ARCHIVE_IMAGE, args)
                self.assertIn('--pull=never', args)
        self.assertEqual(self.docker.info['Config']['Image'], snowluma.ARCHIVE_IMAGE)

    def test_loaded_archive_with_unexpected_content_is_rejected_before_run(self):
        self.write_config({'enabled': True})
        self.docker.pulled = False
        self.docker.load_image['Id'] = 'sha256:unexpected'
        self.client.image_archive.parent.mkdir(parents=True)
        self.client.image_archive.write_bytes(b'incompatible image archive')
        with self.assertRaisesRegex(snowluma.SnowLumaError, 'identity'):
            self.client.ensure_started(timeout=0)
        self.assertFalse(any(args[:2] == ['docker', 'run'] for args, _env in self.docker.calls))

    def test_missing_archive_uses_pinned_mirror_manifest_and_reuses_running_container(self):
        self.write_config({'enabled': True})
        self.docker.pulled = False
        with patch.object(self.client, '_webui_reachable', return_value=True):
            self.client.ensure_started(timeout=0)
            # The original reference becoming available must preserve this owned container.
            self.docker.pulled = True
            self.client.ensure_started(timeout=0)
            self.assertTrue(self.client.healthy())
        calls = [args for args, _env in self.docker.calls]
        self.assertEqual([args for args in calls if args[:2] == ['docker', 'pull']],
                         [['docker', 'pull', '--platform', 'linux/amd64', snowluma.AMD64_IMAGE]])
        self.assertEqual(len([args for args in calls if args[:3] == ['docker', 'run', '-d']]), 1)

    def test_upstream_pull_remains_available_if_pinned_mirror_is_unavailable(self):
        self.docker.pulled = False
        self.docker.failed_pulls.add(snowluma.AMD64_IMAGE)
        self.assertEqual(self.client._resolve_image(), snowluma.IMAGE)
        pulls = [args for args, _env in self.docker.calls if args[:2] == ['docker', 'pull']]
        self.assertEqual(pulls[-1], ['docker', 'pull', snowluma.IMAGE])

    def test_classic_config_identity_supported_but_platform_mismatch_rejected(self):
        self.docker.images[snowluma.ARCHIVE_IMAGE] = {'Id': snowluma.AMD64_CONFIG, 'Os': 'linux', 'Architecture': 'amd64'}
        self.assertTrue(self.client._verified_amd64_image(snowluma.ARCHIVE_IMAGE))
        self.docker.images[snowluma.ARCHIVE_IMAGE]['Architecture'] = 'arm64'
        with self.assertRaisesRegex(snowluma.SnowLumaError, 'identity'):
            self.client._verified_amd64_image(snowluma.ARCHIVE_IMAGE)

    def test_fallback_container_requires_pinned_content_identity(self):
        self.assertTrue(self.client._matches_image({'Config': {'Image': snowluma.ARCHIVE_IMAGE}, 'Image': snowluma.AMD64_CONFIG}))
        self.assertFalse(self.client._matches_image({'Config': {'Image': snowluma.ARCHIVE_IMAGE}, 'Image': 'sha256:other'}))
        self.assertFalse(self.client._matches_image({'Config': {'Image': 'snowluma:latest'}, 'Image': snowluma.AMD64_CONFIG}))

    def test_archive_path_cannot_traverse_outside_managed_data(self):
        self.docker.pulled = False
        self.client.image_archive = self.tmp / 'outside-image.tar.gz'
        self.client.image_archive.write_bytes(b'outside')
        with self.assertRaisesRegex(snowluma.SnowLumaError, 'managed data'):
            self.client._resolve_image()
        self.assertFalse(any(args[:3] == ['docker', 'image', 'load'] for args, _env in self.docker.calls))

    def test_progress_events_follow_the_request_and_opt_in_without_altering_final_results(self):
        source = snowluma_progress.HELPERS + r'''
import assert from "node:assert/strict";
const frames = [];
const emit = async raw => { frames.push(JSON.parse(raw)); };
const upload = (echo, bytes) => superagentWithUploadProgress("upload_private_file", {superagent_progress:true}, echo, emit, () => true, async () => {
    await new Promise(resolve => setTimeout(resolve, echo === 1 ? 10 : 1));
    await superagentReportUpload(bytes, bytes);
    await superagentReportUpload(bytes, bytes, "sending");
    return {status:"ok",retcode:0,data:{file_id:`file-${echo}`}};
});
const results = await Promise.all([upload(1, 1024), upload(2, 2048),
    superagentWithUploadProgress("upload_private_file", {}, 3, emit, () => true, async () => {
        await superagentReportUpload(3000, 3000); return "legacy-result";
    })]);
assert.deepEqual(frames.filter(frame => frame.echo === 1).map(frame => frame.data.uploaded_bytes), [1024,1024]);
assert.deepEqual(frames.filter(frame => frame.echo === 2).map(frame => frame.data.uploaded_bytes), [2048,2048]);
assert.equal(frames.length, 4);
assert.equal(results[0].data.file_id, "file-1");
assert.equal(results[1].data.file_id, "file-2");
assert.equal(results[2], "legacy-result");
const realNow = Date.now;
let now = 1000;
Date.now = () => now;
await superagentWithUploadProgress("upload_private_file", {superagent_progress:true}, 4, emit, () => true, async () => {
    await superagentReportUpload(0, 100);
    now = 1500; await superagentReportUpload(10, 100);
    now = 8999; await superagentReportUpload(20, 100);
    now = 9000; await superagentReportUpload(30, 100);
    now = 9001; await superagentReportUpload(100, 100);
    await superagentReportUpload(100, 100, "sending");
});
Date.now = realNow;
assert.deepEqual(frames.filter(frame => frame.echo === 4).map(frame => [frame.data.uploaded_bytes,frame.data.phase]),
    [[0,"uploading"],[30,"uploading"],[100,"uploading"],[100,"sending"]]);
'''
        result = snowluma.subprocess.run(['node', '--input-type=module', '-'], input=source,
                                        capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
