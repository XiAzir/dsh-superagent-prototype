#!/usr/bin/env python3
"""Isolated loopback integration test for CNB snapshots and lease fencing.

Run from any working directory with ``python deploy/cnb/integration-test.py``.
The test starts a real archive HTTP server on an ephemeral loopback port and
uses the real Supervisor HTTP, archive CLI, ZIP validator, and SQLite backup
paths. It never starts or stops the managed DSH service.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import sys
import threading
import time
import unittest
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from deploy.cnb import archive, runtime  # noqa: E402
from deploy.cnb.archive_server import BASE_PREFIX, create_server  # noqa: E402


class SnapshotIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        test_root = PROJECT_ROOT / "tmp" / "cnb-integration-tests"
        test_root.mkdir(parents=True, exist_ok=True)
        self.root = test_root / f"case-{os.getpid()}-{uuid.uuid4().hex}"
        self.root.mkdir()
        self.server_root = self.root / "server"
        self.server_root.mkdir()
        self.runtime_root = self.root / "runtime-root"
        (self.runtime_root / ".artifacts" / "control" / "profiles" / "superagent").mkdir(parents=True)
        self.data = self.root / "data"
        self.data.mkdir()
        (self.data / "dsh-home" / "profiles" / "superagent").mkdir(parents=True)
        (self.data / "state").mkdir()
        (self.data / "work" / ".artifacts").mkdir(parents=True)
        self.control = self.root / "control"
        self.control.mkdir()
        self.restored_data = self.root / "restored-data"
        self.restored_data.mkdir()
        self.restore_control = self.root / "restore-control"
        self.restore_control.mkdir()

        self.token = "integration-" + uuid.uuid4().hex + uuid.uuid4().hex
        self.settings: dict[str, str] = {"url": "", "token": self.token}
        self.server = None
        self.server_thread: threading.Thread | None = None
        self._start_server()

        self.runtime_globals = {
            "DATA": self.data,
            "CONTROL": self.control,
            "ROOT": self.runtime_root,
            "OPERATOR_STOP": self.runtime_root / "operator-stop",
            "ARCHIVE": Path(__file__).with_name("archive.py"),
        }
        self.runtime_patcher = patch.multiple(runtime, **self.runtime_globals)
        self.runtime_patcher.start()
        self.sqlite_connection: sqlite3.Connection | None = None

    def tearDown(self) -> None:
        if self.sqlite_connection is not None:
            self.sqlite_connection.close()
        self._stop_server()
        self.runtime_patcher.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def _start_server(self) -> None:
        self.server = create_server(self.server_root, self.token, 0, host="127.0.0.1")
        self.server_thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.server_thread.start()
        self.settings["url"] = f"http://127.0.0.1:{self.server.server_port}{BASE_PREFIX}"

    def _stop_server(self) -> None:
        if self.server is None:
            return
        self.server.shutdown()
        self.server.server_close()
        if self.server_thread is not None:
            self.server_thread.join(timeout=3)
        self.server = None
        self.server_thread = None

    def _json_post(self, route: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        return runtime.json_request(self.settings, route, "POST", payload)

    def _health(self) -> dict[str, Any]:
        status, _headers, body = runtime.request(self.settings["url"], self.token, "/health")
        self.assertEqual(status, 200)
        return json.loads(body)

    def _status(self) -> dict[str, Any]:
        status, _headers, body = runtime.request(self.settings["url"], self.token, "/status")
        self.assertEqual(status, 200)
        return json.loads(body)

    def _seed_live_data(self) -> None:
        profile = self.data / "dsh-home" / "profiles" / "superagent"
        (profile / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
        (self.data / "state" / "session.json").write_text(
            json.dumps({"session": "kept", "cursor": 17}), encoding="utf-8"
        )
        (self.data / "work" / "business.log").write_text("business event\n", encoding="utf-8")
        (self.data / "work" / ".artifacts" / "dsh-superagent-superagent-20261102-123456-7.log").write_text(
            "generated runtime output\n", encoding="utf-8"
        )

        database = self.data / "state" / "sessions.sqlite"
        self.sqlite_connection = sqlite3.connect(database)
        self.sqlite_connection.execute("PRAGMA journal_mode=WAL")
        self.sqlite_connection.execute("PRAGMA wal_autocheckpoint=0")
        self.sqlite_connection.execute("CREATE TABLE sessions (value TEXT NOT NULL)")
        self.sqlite_connection.execute("INSERT INTO sessions VALUES ('committed-in-wal')")
        self.sqlite_connection.commit()
        self.assertTrue(Path(str(database) + "-wal").exists())

    def test_supervisor_backup_restore_restart_and_pause_fencing(self) -> None:
        self._seed_live_data()
        first_owner = "build-integration-a"
        second_owner = "build-integration-b"
        third_owner = "build-integration-c"

        code, _ = self._json_post("/lease", {"owner": first_owner})
        self.assertEqual(code, 200)
        supervisor = runtime.Supervisor(self.settings, first_owner)
        supervisor.lease_acquired.set()
        supervisor.backup()
        self.assertTrue(self.server.latest_path.is_file())
        original_archive = self.root / "original-snapshot.zip"
        shutil.copyfile(self.server.latest_path, original_archive)
        validated = archive.validate_archive(original_archive)
        self.assertIn("state/sessions.sqlite", {item["path"] for item in validated["files"]})

        code, _ = self._json_post("/lease", {"owner": second_owner})
        self.assertEqual(code, 409)

        # Simulate a server process restart while retaining its durable state.
        self._stop_server()
        self._start_server()
        status = self._status()
        self.assertTrue(status["lease"]["active"])
        self.assertEqual(status["lease"]["owner"], first_owner)
        self.assertTrue(self.server.latest_path.is_file())

        # Restore uses Supervisor's actual download, checksum, validate, and restore paths.
        runtime.DATA = self.restored_data
        runtime.CONTROL = self.restore_control
        restore_supervisor = runtime.Supervisor(self.settings, "restore-only")
        restore_supervisor.restore_firstboot()
        connection = sqlite3.connect(self.restored_data / "state" / "sessions.sqlite")
        try:
            self.assertEqual(connection.execute("SELECT value FROM sessions").fetchone(), ("committed-in-wal",))
        finally:
            connection.close()
        self.assertEqual(
            (self.restored_data / "state" / "session.json").read_text(encoding="utf-8"),
            json.dumps({"session": "kept", "cursor": 17}),
        )
        self.assertEqual((self.restored_data / "work" / "business.log").read_text(encoding="utf-8"), "business event\n")
        restored_paths = {item["path"] for item in archive.validate_archive(original_archive)["files"]}
        self.assertIn("dsh-home/profiles/superagent/pnpm-lock.yaml", restored_paths)
        self.assertNotIn("work/.artifacts/dsh-superagent-superagent-20261102-123456-7.log", restored_paths)

        # A fresh paused heartbeat remains healthy to the watchdog and pauses backups.
        runtime.DATA = self.data
        marker = self.runtime_root / ".artifacts" / "control" / "profiles" / "superagent" / "manually-stopped"
        marker.write_text("operator stop\n", encoding="utf-8")
        self.assertTrue(supervisor.is_paused())
        code, _ = self._json_post("/heartbeat", {"owner": first_owner, "healthy": True, "paused": True})
        self.assertEqual(code, 200)
        self.assertEqual(self._health()["status"], "ok")
        with self.assertRaises(runtime.RuntimeErrorSafe):
            supervisor.backup()

        # Expire the lease in durable test state, then fence an old queued upload over HTTP.
        server_state = self.server.state()
        server_state["lease"]["expires_at"] = time.time() - 1
        self.server.save_state(server_state)
        digest = hashlib.sha256(original_archive.read_bytes()).hexdigest()
        self.assertEqual(supervisor._upload_backup_file(original_archive, digest), 409)
        code, _ = self._json_post("/lease", {"owner": second_owner})
        self.assertEqual(code, 200)

        # Releasing an intentional pause preserves the watchdog sentinel across a new lease.
        code, _ = self._json_post("/release", {"owner": second_owner, "paused": True})
        self.assertEqual(code, 200)
        self.assertEqual(self._health()["status"], "ok")
        self.assertTrue(self._status()["intentional_paused"])
        code, _ = self._json_post("/lease", {"owner": third_owner})
        self.assertEqual(code, 200)
        self.assertTrue(self._status()["intentional_paused"])
        code, _ = self._json_post("/heartbeat", {"owner": third_owner, "healthy": True, "paused": False})
        self.assertEqual(code, 200)
        self.assertFalse(self._status()["intentional_paused"])
        self.assertEqual(self._health()["status"], "ok")


if __name__ == "__main__":
    unittest.main(verbosity=2)
