#!/usr/bin/env python3
import base64
from email.message import Message
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
import uuid
import unittest
from unittest.mock import patch

from deploy.cnb import web_tunnel


class WebTunnelTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(__file__).resolve().parents[2] / 'tmp' / ('web-tunnel-test-' + uuid.uuid4().hex)
        self.temp.mkdir(parents=True)
        self.addCleanup(lambda: shutil.rmtree(self.temp, ignore_errors=True))
        self.control = self.temp / 'control'
        self.key = b'-----BEGIN PRIVATE KEY-----\nprivate-test-material\n-----END PRIVATE KEY-----\n'
        self.env = {
            'SUPERAGENT_WEB_TUNNEL_KEY_B64': base64.b64encode(self.key).decode(),
            'SUPERAGENT_WEB_TUNNEL_KNOWN_HOSTS': '8.148.72.235 ssh-ed25519 ' + base64.b64encode(b'x' * 48).decode(),
            'SUPERAGENT_WEB_TUNNEL_HOST': '8.148.72.235',
        }

    def test_empty_config_is_optional_and_complete_config_writes_private_files(self):
        self.assertIsNone(web_tunnel.load_config({}, self.control))
        config = web_tunnel.load_config(self.env, self.control)
        self.assertEqual(config.host, '8.148.72.235')
        self.assertEqual(config.key_path.read_bytes(), self.key)
        self.assertEqual(config.known_hosts_path.read_text().split()[0], '8.148.72.235')
        self.assertEqual(json.loads(config.config_path.read_text())['remote_bind'],
                         '127.0.0.1:13083:127.0.0.1:13082')
        if os.name != 'nt':
            self.assertEqual(config.key_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(config.known_hosts_path.stat().st_mode & 0o777, 0o600)

    def test_unset_environment_resumes_only_from_validated_saved_control_config(self):
        first = web_tunnel.load_config(self.env, self.control)
        resumed = web_tunnel.load_config({}, self.control)
        self.assertEqual(resumed, first)
        self.assertEqual(resumed.key_path.read_bytes(), self.key)
        value = json.loads(resumed.config_path.read_text())
        value['remote_bind'] = '0.0.0.0:22:127.0.0.1:13082'
        resumed.config_path.write_text(json.dumps(value), encoding='utf-8')
        with self.assertRaises(web_tunnel.TunnelConfigError):
            web_tunnel.load_config({}, self.control)

    def test_partial_or_unpinned_configuration_is_rejected(self):
        with self.assertRaises(web_tunnel.TunnelConfigError):
            web_tunnel.load_config({'SUPERAGENT_WEB_TUNNEL_HOST': '8.148.72.235'}, self.control)
        bad = {**self.env, 'SUPERAGENT_WEB_TUNNEL_HOST': 'example.com'}
        with self.assertRaises(web_tunnel.TunnelConfigError):
            web_tunnel.load_config(bad, self.control)

    def test_ssh_command_has_only_fixed_reverse_forwarding_and_strict_pins(self):
        config = web_tunnel.TunnelConfig('8.148.72.235', self.control / 'key', self.control / 'known_hosts')
        argv = web_tunnel.ssh_argv(config)
        self.assertEqual(argv[argv.index('-R') + 1], '127.0.0.1:13083:127.0.0.1:13082')
        self.assertEqual(argv[-1], 'cnb-superagent-web@8.148.72.235')
        self.assertIn('-oStrictHostKeyChecking=yes', argv)
        self.assertIn('-oExitOnForwardFailure=yes', argv)
        self.assertIn('-oIdentitiesOnly=yes', argv)
        self.assertEqual(argv[argv.index('-p') + 1], '22')
        self.assertNotIn(self.key.decode(), argv)
        self.assertFalse(any('13082' in arg and arg != '127.0.0.1:13083:127.0.0.1:13082' for arg in argv))

    def test_launch_url_parser_accepts_only_fixed_loopback_shape_and_strips_ansi(self):
        valid = '\x1b[32mOpen http://127.0.0.1:13082/?token=secret-token\x1b[0m'
        self.assertEqual(web_tunnel.extract_launch_url(valid), 'http://127.0.0.1:13082/?token=secret-token')
        self.assertIsNone(web_tunnel.extract_launch_url('http://evil.example:13082/?token=x'))
        self.assertIsNone(web_tunnel.extract_launch_url('http://127.0.0.1:13082/?token=x&other=y'))

    def test_cookie_pair_requires_exactly_one_sanitized_set_cookie(self):
        name = 'dsh-auth-' + 'A' * 43
        headers = Message()
        headers.add_header('Set-Cookie', name + '=abc123; HttpOnly; Path=/')
        headers.add_header('Set-Cookie', 'analytics=ignore-me; Path=/')
        self.assertEqual(web_tunnel.extract_cookie_pair(headers), name + '=abc123')
        headers.add_header('Set-Cookie', 'dsh-auth-' + 'B' * 43 + '=second; Path=/')
        self.assertIsNone(web_tunnel.extract_cookie_pair(headers))
        invalid = Message()
        invalid.add_header('Set-Cookie', name + '=x; Path=/; comment=bad')
        self.assertEqual(web_tunnel.extract_cookie_pair(invalid), name + '=x')

    def test_dsh_cookie_exchanges_latest_log_url_without_returning_launch_token(self):
        artifacts = self.temp / '.artifacts'
        artifacts.mkdir()
        (artifacts / 'dsh-superagent-superagent-20261102-123456-1.log').write_text(
            'Started at http://127.0.0.1:13082/?token=do-not-upload\n', encoding='utf-8')
        headers = Message()
        name = 'dsh-auth-' + 'A' * 43
        headers.add_header('Set-Cookie', name + '=server-session; HttpOnly; Path=/')
        seen = []

        class Response:
            status = 303
            def __init__(self): self.headers = headers
            def close(self): pass

        class Opener:
            def open(self, request, timeout):
                seen.append((request.full_url, timeout))
                return Response()

        cookie, _identity = web_tunnel.dsh_cookie(self.temp, Opener())
        self.assertEqual(cookie, name + '=server-session')
        self.assertEqual(seen[0][0], 'http://127.0.0.1:13082/?token=do-not-upload')
        self.assertEqual(seen[0][1], 10)

    def test_child_reconnects_after_exit_and_stop_terminates_its_process(self):
        config = web_tunnel.TunnelConfig('8.148.72.235', self.control / 'key', self.control / 'known_hosts')
        calls, events = [], []

        class Child:
            pid = 4321
            def __init__(self, persistent): self.persistent, self.dead = persistent, False
            def wait(self, timeout=None):
                if self.dead: return -15
                if not self.persistent: self.dead = True; return 255
                raise subprocess.TimeoutExpired('ssh', timeout)
            def poll(self): return -15 if self.dead else None
            def terminate(self): self.dead = True
            def kill(self): self.dead = True

        def spawn(argv, **kwargs):
            calls.append((argv, kwargs))
            return Child(persistent=len(calls) > 1)

        tunnel = web_tunnel.WebTunnel(config, 'owner-1', self.temp, lambda *_: 200,
                                      event_log=lambda event, **metadata: events.append(event), popen=spawn,
                                      should_stop=lambda: False)
        with patch.object(web_tunnel, 'RETRY_BASE_SECONDS', 0.01), patch.dict(os.environ, {
                 'SUPERAGENT_WEB_TUNNEL_KEY_B64': 'private-key',
                 'SUPERAGENT_WEB_TUNNEL_KNOWN_HOSTS': 'pinned-host',
                 'SUPERAGENT_ARCHIVE_TOKEN': 'archive-secret',
             }):
            tunnel.start()
            deadline = time.monotonic() + 2
            while len(calls) < 2 and time.monotonic() < deadline:
                threading.Event().wait(0.01)
            tunnel.stop()
            tunnel.start()
        self.assertGreaterEqual(len(calls), 2)
        self.assertEqual(len(calls), 2)
        self.assertIn('web_tunnel_started', events)
        self.assertTrue(calls[0][1]['close_fds'])
        self.assertTrue(calls[1][1]['start_new_session'] == (os.name != 'nt'))
        for _argv, kwargs in calls:
            self.assertNotIn('SUPERAGENT_WEB_TUNNEL_KEY_B64', kwargs['env'])
            self.assertNotIn('SUPERAGENT_WEB_TUNNEL_KNOWN_HOSTS', kwargs['env'])
            self.assertNotIn('SUPERAGENT_ARCHIVE_TOKEN', kwargs['env'])

    def test_lease_lost_prevents_cookie_upload(self):
        config = web_tunnel.TunnelConfig('8.148.72.235', self.control / 'key', self.control / 'known_hosts')
        uploaded = []
        tunnel = web_tunnel.WebTunnel(config, 'owner-1', self.temp,
                                      lambda owner, cookie: uploaded.append((owner, cookie)) or 200,
                                      should_stop=lambda: True, cookie_reader=lambda: ('sid=secret', ('log', 1, 1)))
        tunnel._cookie_loop()
        self.assertEqual(uploaded, [])


if __name__ == '__main__':
    unittest.main()
