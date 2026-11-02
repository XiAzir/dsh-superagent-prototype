from __future__ import annotations

import json
import os
import shutil
import hashlib
import io
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request

from deploy.cnb import runtime


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = runtime.ROOT / "tmp"
        self.tmp.mkdir(exist_ok=True)
        self.root = self.tmp / f"cnb-runtime-test-{os.getpid()}-{id(self)}"
        self.root.mkdir()
        self.control = self.root / "control"
        self.data = self.root / "data"
        self.control.mkdir()
        self.data.mkdir()
        self.paths = patch.multiple(runtime, CONTROL=self.control, DATA=self.data)
        self.paths.start()

    def tearDown(self):
        self.paths.stop()
        shutil.rmtree(self.root)

    def test_config_saves_private_restart_credentials_without_printing(self):
        env = patch.dict(os.environ, {
            "SUPERAGENT_ARCHIVE_URL": "https://archive.example/superagent-runtime",
            "SUPERAGENT_ARCHIVE_TOKEN": "secret-token",
        })
        with env:
            value = runtime.config()
        saved = json.loads((self.control / "credentials.json").read_text())
        self.assertEqual(value, {"url": "https://archive.example/superagent-runtime", "token": "secret-token"})
        self.assertEqual(saved, value)
        if os.name != "nt":
            self.assertEqual((self.control / "credentials.json").stat().st_mode & 0o777, 0o600)
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runtime.config(), value)

    def test_config_rejects_plaintext_non_loopback_archive_url(self):
        with patch.dict(os.environ, {
            "SUPERAGENT_ARCHIVE_URL": "http://archive.example/runtime",
            "SUPERAGENT_ARCHIVE_TOKEN": "secret-token",
        }, clear=True):
            with self.assertRaises(runtime.RuntimeErrorSafe):
                runtime.config()

    def test_owner_uses_control_record_when_environment_is_unset_and_env_overrides(self):
        with patch.dict(os.environ, {"CNB_BUILD_ID": "cnb-build-old"}, clear=True):
            self.assertEqual(runtime.owner(), "cnb-build-old")
        owner_path = self.control / "owner.json"
        self.assertEqual(json.loads(owner_path.read_text()), {"owner": "cnb-build-old"})
        if os.name != "nt":
            self.assertEqual(owner_path.stat().st_mode & 0o777, 0o600)
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runtime.owner(), "cnb-build-old")
        with patch.dict(os.environ, {"CNB_BUILD_ID": "cnb-build-new"}, clear=True):
            self.assertEqual(runtime.owner(), "cnb-build-new")
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runtime.owner(), "cnb-build-new")

    def test_owner_requires_build_id_when_control_record_is_absent(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(runtime.RuntimeErrorSafe):
                runtime.owner()

    def test_start_reuses_saved_owner_with_unset_environment(self):
        with patch.dict(os.environ, {"CNB_BUILD_ID": "cnb-build-ssh"}, clear=True):
            runtime.owner()
        marker = self.control / "operator-stop"
        lock = self.control / "start.lock"
        child = type("Child", (), {"pid": 54321, "poll": lambda self: None})()

        def spawn(*_args, **_kwargs):
            runtime.write_json(self.control / "status.json", {"pid": child.pid, "state": "running"})
            return child

        with patch.dict(os.environ, {}, clear=True), \
             patch.object(runtime, "start_lock_file", return_value=lock.open("a+")), \
             patch.object(runtime, "acquire_exclusive_lock"), patch.object(runtime, "config",
                                                                           return_value={"url": "https://archive.example", "token": "x"}), \
             patch.object(runtime, "CONTROL", self.control), patch.object(runtime, "DATA", self.data), \
             patch.object(runtime, "ROOT", self.root), patch.object(runtime, "OPERATOR_STOP", marker), \
             patch.object(runtime.subprocess, "Popen", side_effect=spawn):
            self.assertEqual(runtime.start(timeout=2), 0)

    def test_lease_conflict_marks_lease_lost(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        with patch.object(runtime, "json_request", return_value=(409, {})):
            supervisor.heartbeat_loop()
        self.assertTrue(supervisor.lease_lost.is_set())
        self.assertFalse(supervisor.lease_acquired.is_set())

    def test_successful_lease_initializes_heartbeat_clock_before_first_renewal(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        calls = []

        def renew(_settings, path, _method, _value, **_kwargs):
            calls.append(path)
            if path == "/lease":
                return 200, {}
            supervisor.heartbeat_stop.set()
            return 503, {}

        with patch.object(runtime, "json_request", side_effect=renew), \
             patch.object(runtime, "log"), patch.object(runtime, "set_status"), \
             patch.object(runtime, "HEARTBEAT_SECONDS", 0):
            supervisor.heartbeat_loop()
        self.assertEqual(calls, ["/lease", "/heartbeat"])
        self.assertGreater(supervisor.last_heartbeat, 0)
        self.assertFalse(supervisor.lease_lost.is_set())

    def test_local_ready_sends_required_orchestrator_header_and_checks_actual_state_shape(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        class Response:
            def __init__(self, state="ready"): self.state = state
            def __enter__(self): return self
            def __exit__(self, *_args): pass
            def read(self, _limit):
                return json.dumps({"setup": {}, "masterReady": self.state == "ready", "paused": self.state == "paused",
                                   "health": {"runtime": {"state": self.state}}}).encode()
        seen = []
        def open_url(request, timeout):
            seen.append((request, timeout))
            return Response()
        with patch.object(runtime.urllib.request, "urlopen", side_effect=open_url):
            self.assertTrue(supervisor._local_ready())
        self.assertIsInstance(seen[0][0], Request)
        self.assertEqual(seen[0][0].get_header("X-orchestrator-request"), "1")

        with patch.object(runtime.urllib.request, "urlopen", return_value=Response("paused")):
            self.assertTrue(supervisor._local_ready())

    def test_backup_download_streams_to_disk_and_verifies_sha256(self):
        payload = b"snapshot-bytes" * 100
        class Response(io.BytesIO):
            status = 200
            headers = {"Content-Length": str(len(payload)), "X-Archive-SHA256": hashlib.sha256(payload).hexdigest()}
            reads = []
            def read(self, size=-1):
                self.reads.append(size)
                return super().read(size)
            def __enter__(self): return self
            def __exit__(self, *_args): self.close()
        response = Response(payload)
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "secret"}, "build-1")
        with patch.object(runtime, "OPENER") as opener:
            opener.open.return_value = response
            code, _ = supervisor._download_backup()
        self.assertEqual(code, 200)
        self.assertEqual(supervisor.backup_path.read_bytes(), payload)
        self.assertTrue(all(size == 1024 * 1024 for size in response.reads))
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")

    def test_backup_upload_streams_fixed_length_chunks_without_read_bytes(self):
        payload = b"archive" * (1024 * 300)
        archive = self.control / "upload.zip"
        archive.write_bytes(payload)
        class Response:
            status = 200
            def read(self, _limit): return b"{}"
        class Connection:
            def __init__(self, *_args, **_kwargs): self.headers = {}; self.sent = 0
            def putrequest(self, method, route): self.method, self.route = method, route
            def putheader(self, key, value): self.headers[key.lower()] = value
            def endheaders(self): pass
            def send(self, chunk): self.sent += len(chunk)
            def getresponse(self): return Response()
            def close(self): pass
        connection = Connection()
        with patch.object(runtime.http.client, "HTTPSConnection", return_value=connection):
            status = runtime.Supervisor({"url": "https://archive.example/superagent-runtime", "token": "secret"},
                                        "build-1")._upload_backup_file(archive, hashlib.sha256(payload).hexdigest())
        self.assertEqual(status, 200)
        self.assertEqual(connection.route, "/superagent-runtime/backup")
        self.assertEqual(connection.headers["content-length"], str(len(payload)))
        self.assertEqual(connection.headers["authorization"], "Bearer secret")
        self.assertEqual(connection.sent, len(payload))

    def test_dsh_startup_is_terminated_and_service_stopped_after_fencing(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        class Process:
            returncode = None
            terminated = False
            def poll(self): return self.returncode
            def terminate(self): self.terminated = True; self.returncode = -15
            def wait(self, timeout=None): return self.returncode
        child = Process()
        supervisor.lease_lost.set()
        with patch.object(runtime.subprocess, "Popen", return_value=child), \
             patch.object(supervisor, "is_paused", return_value=False), \
             patch.object(supervisor, "stop_dsh", side_effect=lambda **_kwargs: setattr(supervisor, "dsh_started", False)) as stop_dsh:
            with self.assertRaises(runtime.RuntimeErrorSafe):
                supervisor.start_dsh()
        self.assertTrue(child.terminated)
        stop_dsh.assert_called_once()
        self.assertFalse(supervisor.dsh_started)

    def test_cnb_dsh_launch_opts_into_http_no_reuse(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        child = type("Process", (), {"returncode": 0, "poll": lambda self: self.returncode})()
        with patch.object(runtime.subprocess, "Popen", return_value=child) as spawn, \
             patch.object(supervisor, "is_paused", return_value=False):
            supervisor.start_dsh()
        self.assertEqual(spawn.call_args.kwargs["env"]["DSH_SUPERAGENT_HTTP_CLOSE"], "1")

    def test_fenced_stop_uses_short_deadline_then_only_kills_verified_profile_pids(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        supervisor.dsh_started = True
        with patch.object(runtime.subprocess, "run", return_value=type("Result", (), {"returncode": 1})()) as stop, \
             patch.object(supervisor, "_force_kill_dsh_profile") as force_kill:
            supervisor.stop_dsh(fenced=True)
        self.assertIn("20", stop.call_args.args[0])
        self.assertEqual(stop.call_args.kwargs["timeout"], 25)
        force_kill.assert_called_once()
        self.assertFalse(supervisor.dsh_started)

    def test_dsh_force_kill_verifier_matches_only_superagent_profile_command(self):
        good = b"/usr/bin/node\0/home/cnb/.local/bin/dsh\0--profile\0superagent\0--no-open\0"
        bad = b"/usr/bin/node\0/home/cnb/.local/bin/dsh\0--profile\0other\0--no-open\0"
        with patch.object(Path, "read_bytes", return_value=good):
            self.assertTrue(runtime.Supervisor._verified_dsh_profile_pid(123))
        with patch.object(Path, "read_bytes", return_value=bad):
            self.assertFalse(runtime.Supervisor._verified_dsh_profile_pid(123))

    def test_release_paused_body_contract_is_explicit(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        supervisor.lease_acquired.set()
        supervisor.intentional = True
        class Thread:
            def __init__(self, **_kwargs): pass
            def start(self): pass
            def join(self, timeout=None): pass
            def is_alive(self): return False
        with patch.object(runtime.threading, "Thread", Thread), \
             patch.object(supervisor, "_wait_for_resume", return_value=False), \
             patch.object(supervisor, "restore_firstboot"), patch.object(supervisor, "bootstrap", return_value=False), \
             patch.object(supervisor, "start_dsh", side_effect=lambda: setattr(supervisor, "dsh_started", True)), \
             patch.object(supervisor, "backup") as backup, patch.object(supervisor, "stop_dsh"), \
             patch.object(runtime, "json_request", return_value=(200, {})) as release, \
             patch.object(runtime, "set_status"), patch.object(runtime, "log"):
            supervisor.stop_event.set()
            self.assertEqual(supervisor.run(), 0)
        self.assertEqual(release.call_args.args[3], {"owner": "build-1", "paused": True})
        backup.assert_not_called()

    def test_stop_and_shutdown_record_distinct_pause_intent(self):
        marker = self.control / "operator-stop"
        with patch.object(runtime, "OPERATOR_STOP", marker), patch.object(runtime, "process_alive", return_value=False), \
             patch.object(runtime, "read_json", return_value={}), patch.object(runtime, "set_status"), \
             patch.object(runtime, "config", return_value={"url": "https://archive.example", "token": "x"}), \
             patch.object(runtime, "owner", return_value="build-1"), \
             patch.object(runtime, "json_request", return_value=(200, {})) as release:
            self.assertEqual(runtime.stop(intentional=True), 0)
            self.assertTrue(marker.exists())
            self.assertTrue(release.call_args.args[3]["paused"])
            release.reset_mock()
            self.assertEqual(runtime.stop(intentional=False), 0)
            self.assertFalse(marker.exists())
            self.assertFalse(release.call_args.args[3]["paused"])

    def test_explicit_start_clears_only_runtime_and_superagent_pause_markers(self):
        repo = self.root / "repo"
        dsh_marker = repo / ".artifacts" / "control" / "profiles" / "superagent" / "manually-stopped"
        other_marker = repo / ".artifacts" / "control" / "profiles" / "other" / "manually-stopped"
        dsh_marker.parent.mkdir(parents=True)
        other_marker.parent.mkdir(parents=True)
        dsh_marker.touch()
        other_marker.touch()
        operator_marker = self.control / "operator-stop"
        operator_marker.touch()
        with patch.object(runtime, "ROOT", repo), patch.object(runtime, "OPERATOR_STOP", operator_marker):
            self.assertTrue(runtime.Supervisor({}, "build-1").is_paused())
            runtime.clear_start_markers()
            self.assertFalse(runtime.Supervisor({}, "build-1").is_paused())
        self.assertFalse(operator_marker.exists())
        self.assertFalse(dsh_marker.exists())
        self.assertTrue(other_marker.exists())

    def test_periodic_snapshot_failures_back_off_without_raising(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        supervisor.lease_acquired.set()
        supervisor.last_backup = 699
        failures = [
            subprocess.CalledProcessError(1, ["archive.py"]),
            subprocess.TimeoutExpired(["archive.py"], 180),
            OSError("disk unavailable"),
            runtime.RuntimeErrorSafe("archive validation failed"),
        ]
        with patch.object(supervisor, "is_paused", return_value=False), \
             patch.object(runtime.time, "time", return_value=1000), \
             patch.object(runtime, "set_status"), patch.object(runtime, "log"), \
             patch.object(supervisor, "_archive_call", side_effect=failures) as archive:
            for expected_delay in (60, 120, 240, 300):
                supervisor.next_backup_attempt = 0
                self.assertFalse(supervisor.periodic_backup_if_due())
                self.assertEqual(supervisor.last_backup_attempt, 1000)
                self.assertEqual(supervisor.next_backup_attempt, 1000 + expected_delay)
                self.assertFalse(supervisor.periodic_backup_if_due())
        self.assertEqual(archive.call_count, 4)

    def test_initial_snapshot_failure_is_recorded_but_nonfatal(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        with patch.object(supervisor, "backup", side_effect=subprocess.CalledProcessError(1, ["archive.py"])), \
             patch.object(supervisor, "note_backup_failure") as note:
            self.assertFalse(supervisor.initial_backup_best_effort())
        note.assert_called_once()

    def test_start_and_serve_use_distinct_locks_and_serve_lock_lives_through_run(self):
        start_path, serve_path = self.control / "start.lock", self.control / "serve.lock"
        with patch.object(runtime, "CONTROL", self.control), patch.object(runtime, "ensure_dirs"):
            start_lock = runtime.start_lock_file()
            serve_lock = runtime.serve_lock_file()
        self.assertEqual(Path(start_lock.name), start_path)
        self.assertEqual(Path(serve_lock.name), serve_path)
        start_lock.close(); serve_lock.close()

        acquired = {"value": False}
        def acquire(_stream):
            if acquired["value"]:
                raise BlockingIOError
            acquired["value"] = True
        testcase = self
        class RuntimeStub:
            def __init__(self, *_args): pass
            def run(self):
                with testcase.assertRaises(runtime.RuntimeErrorSafe):
                    runtime.serve()
                return 0
        with patch.object(runtime, "CONTROL", self.control), patch.object(runtime, "ensure_dirs"), \
             patch.object(runtime, "config", return_value={"url": "https://archive.example", "token": "x"}), \
             patch.object(runtime, "owner", return_value="build-1"), \
             patch.object(runtime, "acquire_exclusive_lock", side_effect=acquire), \
             patch.object(runtime, "Supervisor", RuntimeStub), patch.object(runtime, "set_status"), \
             patch.object(runtime.signal, "signal"):
            self.assertEqual(runtime.serve(), 0)

    def test_pause_is_healthy_for_watchdog_but_fenced_backup_is_skipped(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        supervisor.lease_acquired.set()
        with patch.object(supervisor, "is_paused", return_value=True), \
             patch.object(supervisor, "_local_ready", side_effect=AssertionError), \
             patch.object(supervisor, "_archive_call", side_effect=AssertionError("snapshot must not start")):
            self.assertTrue(supervisor.is_healthy())
            with self.assertRaises(runtime.RuntimeErrorSafe):
                supervisor.backup()
        supervisor.lease_lost.set()
        with patch.object(supervisor, "is_paused", return_value=False), \
             patch.object(supervisor, "_archive_call", side_effect=AssertionError("fenced snapshot must not start")):
            with self.assertRaises(runtime.RuntimeErrorSafe):
                supervisor.backup()

    def test_pause_heartbeat_reports_healthy_and_paused_while_retaining_lease(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        supervisor.lease_acquired.set()
        with patch.object(supervisor, "is_paused", return_value=True), \
             patch.object(supervisor, "is_healthy", return_value=True), \
             patch.object(runtime, "set_status"), patch.object(runtime, "log"), \
             patch.object(runtime, "json_request", return_value=(200, {})) as heartbeat:
            def stop_after_post(*_args, **_kwargs):
                supervisor.heartbeat_stop.set()
                return 200, {}
            heartbeat.side_effect = stop_after_post
            supervisor.heartbeat_loop()
        self.assertEqual(heartbeat.call_args.args[1], "/heartbeat")
        self.assertEqual(heartbeat.call_args.args[3]["healthy"], True)
        self.assertEqual(heartbeat.call_args.args[3]["paused"], True)

    def test_firstboot_404_leaves_data_empty(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        with patch.object(supervisor, "_download_backup", return_value=(404, None)):
            supervisor.restore_firstboot()
        self.assertEqual(list(self.data.iterdir()), [])

    def test_existing_data_skips_remote_restore(self):
        (self.data / "state").mkdir()
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        with patch.object(runtime, "request", side_effect=AssertionError("unexpected download")):
            supervisor.restore_firstboot()

    def test_non_404_restore_failure_aborts_firstboot(self):
        supervisor = runtime.Supervisor({"url": "https://archive.example", "token": "x"}, "build-1")
        with patch.object(supervisor, "_download_backup", return_value=(503, None)):
            with self.assertRaises(runtime.RuntimeErrorSafe):
                supervisor.restore_firstboot()


if __name__ == "__main__":
    unittest.main()
