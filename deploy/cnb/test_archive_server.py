from __future__ import annotations

import hashlib
import http.client
import json
import threading
import time
import uuid
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from unittest.mock import patch

try:
    from .archive_server import (
        BOOTSTRAP_GRACE_SECONDS,
        HEARTBEAT_TIMEOUT_SECONDS,
        MAX_REQUEST_THREADS,
        BASE_PREFIX,
        create_server,
    )
except ImportError:
    from archive_server import (
        BOOTSTRAP_GRACE_SECONDS,
        HEARTBEAT_TIMEOUT_SECONDS,
        MAX_REQUEST_THREADS,
        BASE_PREFIX,
        create_server,
    )


TOKEN = "test-token-" + "x" * 40


def validator(path: Path) -> dict[str, Any]:
    if path.read_bytes().startswith(b"valid archive:"):
        return {"members": 3, "expanded_bytes": 40, "snapshot_kind": "dsh-superagent"}
    raise ValueError("invalid archive")


class ArchiveServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(__file__).parent / (".archive-test-" + uuid.uuid4().hex)
        self.root.mkdir()
        self.server = create_server(self.root, TOKEN, 0, validator=validator)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}{BASE_PREFIX}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        for path in self.root.iterdir():
            path.unlink(missing_ok=True)
        self.root.rmdir()

    def request(
        self,
        method: str,
        route: str,
        body: bytes | dict[str, Any] | None = None,
        *,
        auth: bool = True,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, bytes, dict[str, str]]:
        request_headers = dict(headers or {})
        if auth:
            request_headers["Authorization"] = f"Bearer {TOKEN}"
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            request_headers.setdefault("Content-Type", "application/json")
        request = urllib.request.Request(self.base + route, data=body, headers=request_headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, response.read(), dict(response.headers.items())
        except urllib.error.HTTPError as error:
            return error.code, error.read(), dict(error.headers.items())

    def post(self, route: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        code, body, _ = self.request("POST", route, payload)
        return code, json.loads(body)

    def upload(self, data: bytes, owner: str = "build-a") -> tuple[int, bytes, dict[str, str]]:
        return self.request(
            "PUT",
            "/backup",
            data,
            headers={"Content-Type": "application/zip", "X-Superagent-Owner": owner},
        )

    def test_authentication_and_anonymous_health(self) -> None:
        code, body, headers = self.request("GET", "/status", auth=False)
        self.assertEqual(code, 401)
        self.assertEqual(headers.get("Connection"), "close")
        self.assertEqual(json.loads(body)["error"], "authentication required")
        code, body, _ = self.request("GET", "/health", auth=False)
        self.assertEqual((code, json.loads(body)), (200, {"status": "waiting"}))

    def test_lease_exclusivity_heartbeat_expiry_and_release(self) -> None:
        self.assertEqual(self.post("/lease", {"owner": "build-a"})[0], 200)
        self.assertEqual(self.post("/lease", {"owner": "build-b"})[0], 409)
        self.assertEqual(self.post("/heartbeat", {"owner": "build-b", "healthy": True})[0], 409)
        self.assertEqual(
            self.post("/heartbeat", {"owner": "build-a", "healthy": True, "workspace_sn": "cnb-123"})[0],
            200,
        )
        code, body, _ = self.request("GET", "/health", auth=False)
        self.assertEqual((code, json.loads(body)), (200, {"status": "ok"}))
        self.assertEqual(self.post("/heartbeat", {"owner": "build-a", "healthy": True, "paused": True})[0], 200)
        code, body, _ = self.request("GET", "/health", auth=False)
        self.assertEqual((code, json.loads(body)), (200, {"status": "ok"}))

        state = self.server.state()
        state["lease"]["expires_at"] = time.time() - 1
        self.server.save_state(state)
        self.assertEqual(self.post("/heartbeat", {"owner": "build-a", "healthy": True})[0], 409)
        self.assertEqual(self.post("/lease", {"owner": "build-b"})[0], 200)
        self.assertEqual(self.post("/release", {"owner": "build-a"})[0], 409)
        self.assertEqual(self.post("/release", {"owner": "build-b"})[0], 200)

    def test_web_session_is_private_owner_fenced_and_cleared_on_owner_change(self) -> None:
        cookie = "dsh-auth-" + "A" * 43 + "=private-value"
        self.assertEqual(self.post("/web-session", {"owner": "build-a", "cookie": cookie})[0], 409)
        self.assertEqual(self.post("/lease", {"owner": "build-a"})[0], 200)
        self.assertEqual(self.post("/web-session", {"owner": "build-a", "cookie": cookie})[0], 200)
        saved = self.server.state()["web_session"]
        self.assertEqual(saved["owner"], "build-a")
        self.assertEqual(saved["cookie"], cookie)
        self.assertIsInstance(saved["updated_at"], (int, float))

        # Same-owner lease renewal retains the session, while status and health never return it.
        self.assertEqual(self.post("/lease", {"owner": "build-a"})[0], 200)
        self.assertEqual(self.server.state()["web_session"]["cookie"], cookie)
        for route in ("/status", "/health"):
            code, body, _ = self.request("GET", route)
            self.assertEqual(code, 200)
            self.assertNotIn(cookie.encode(), body)
            self.assertNotIn(b"web_session", body)

        self.assertEqual(self.post("/web-session", {"owner": "build-b", "cookie": cookie})[0], 409)
        state = self.server.state()
        state["lease"]["expires_at"] = time.time() - 1
        self.server.save_state(state)
        self.assertEqual(self.post("/web-session", {"owner": "build-a", "cookie": cookie})[0], 409)
        self.assertEqual(self.post("/lease", {"owner": "build-b"})[0], 200)
        self.assertNotIn("web_session", self.server.state())
        self.assertEqual(self.post("/web-session", {"owner": "build-b", "cookie": cookie})[0], 200)
        self.assertEqual(self.post("/release", {"owner": "build-b"})[0], 200)
        self.assertNotIn("web_session", self.server.state())

    def test_web_session_rejects_invalid_cookie_without_echoing_it(self) -> None:
        self.post("/lease", {"owner": "build-a"})
        for cookie in ("a=b; other=c", "a=b\r\nInjected: x", "a=two words", "", "dsh-auth-" + "A" * 43 + "=" + "x" * 4096):
            code, body, _ = self.request("POST", "/web-session", {"owner": "build-a", "cookie": cookie})
            self.assertIn(code, (400, 413))
            if cookie:
                self.assertNotIn(cookie.encode(), body)
        self.assertNotIn("web_session", self.server.state())
        boundary_cookie = "dsh-auth-" + "A" * 43 + "=" + "x" * (4096 - len("dsh-auth-" + "A" * 43 + "="))
        self.assertEqual(self.post("/web-session", {"owner": "build-a", "cookie": boundary_cookie})[0], 200)
        self.assertEqual(len(self.server.state()["web_session"]["cookie"].encode()), 4096)

    def test_watchdog_health_bootstrap_heartbeat_timeout_and_pause(self) -> None:
        self.assertEqual(self.post("/lease", {"owner": "build-a"})[0], 200)
        code, body, _ = self.request("GET", "/health", auth=False)
        self.assertEqual((code, json.loads(body)), (200, {"status": "ok"}))

        state = self.server.state()
        state["lease"]["acquired_at"] = time.time() - BOOTSTRAP_GRACE_SECONDS - 1
        state["lease"]["expires_at"] = time.time() + 60
        state["heartbeat"] = {
            "owner": "build-a", "at": time.time() - HEARTBEAT_TIMEOUT_SECONDS - 1,
            "healthy": True, "paused": False,
        }
        self.server.save_state(state)
        code, body, _ = self.request("GET", "/health", auth=False)
        self.assertEqual((code, json.loads(body)), (200, {"status": "waiting"}))

        self.assertEqual(self.post("/release", {"owner": "build-a", "paused": True})[0], 200)
        code, body, _ = self.request("GET", "/health", auth=False)
        self.assertEqual((code, json.loads(body)), (200, {"status": "ok"}))
        code, body, _ = self.request("GET", "/status")
        self.assertTrue(json.loads(body)["intentional_paused"])

        self.assertEqual(self.post("/lease", {"owner": "build-b"})[0], 200)
        self.assertTrue(self.server.state()["intentional_paused"])
        self.assertEqual(self.server.state()["heartbeat"]["paused"], True)
        self.assertEqual(self.post("/heartbeat", {"owner": "build-b", "healthy": False, "paused": False})[0], 200)
        self.assertTrue(self.server.state()["intentional_paused"])
        code, body, _ = self.request("GET", "/health", auth=False)
        self.assertEqual((code, json.loads(body)), (200, {"status": "ok"}))
        self.assertEqual(self.post("/heartbeat", {"owner": "build-b", "healthy": True, "paused": False})[0], 200)
        self.assertFalse(self.server.state()["intentional_paused"])
        self.assertLessEqual(MAX_REQUEST_THREADS, 32)

    def test_lease_survives_server_restart_and_fences_old_owner(self) -> None:
        self.assertEqual(self.post("/lease", {"owner": "build-a"})[0], 200)
        old_lease = self.server.state()["lease"]
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

        self.server = create_server(self.root, TOKEN, 0, validator=validator)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}{BASE_PREFIX}"
        self.assertEqual(self.server.state()["lease"], old_lease)
        self.assertEqual(self.post("/lease", {"owner": "build-b"})[0], 409)

        state = self.server.state()
        state["lease"]["expires_at"] = time.time() - 1
        self.server.save_state(state)
        self.assertEqual(self.upload(b"valid archive: expired", owner="build-a")[0], 409)
        self.assertEqual(self.post("/lease", {"owner": "build-b"})[0], 200)
        self.assertEqual(self.upload(b"valid archive: stale", owner="build-a")[0], 409)
        self.assertFalse(self.server.latest_path.exists())

    def test_valid_backup_serves_checksum_and_invalid_upload_preserves_latest(self) -> None:
        self.assertEqual(self.post("/lease", {"owner": "build-a"})[0], 200)
        original = b"valid archive: snapshot one"
        self.assertEqual(self.upload(original)[0], 200)
        self.assertEqual(self.server.latest_path.read_bytes(), original)
        old_metadata = self.server.state()["backup"]
        self.assertEqual(old_metadata["sha256"], hashlib.sha256(original).hexdigest())

        status, body, _ = self.upload(b"not an archive")
        self.assertEqual(status, 400)
        self.assertIn(b"validation failed", body)
        self.assertEqual(self.server.latest_path.read_bytes(), original)
        self.assertEqual(self.server.state()["backup"], old_metadata)

        code, downloaded, headers = self.request("GET", "/backup")
        self.assertEqual(code, 200)
        self.assertEqual(downloaded, original)
        self.assertEqual(headers.get("X-Superagent-SHA256"), hashlib.sha256(original).hexdigest())
        self.assertEqual(headers.get("X-Archive-SHA256"), hashlib.sha256(original).hexdigest())

    def test_second_valid_backup_preserves_previous_generation(self) -> None:
        self.post("/lease", {"owner": "build-a"})
        first = b"valid archive: first"
        second = b"valid archive: second"
        self.assertEqual(self.upload(first)[0], 200)
        self.assertEqual(self.upload(second)[0], 200)
        self.assertEqual(self.server.latest_path.read_bytes(), second)
        self.assertEqual(self.server.previous_path.read_bytes(), first)

    def test_backup_get_reconciles_metadata_after_file_rotation(self) -> None:
        self.post("/lease", {"owner": "build-a"})
        first = b"valid archive: previous"
        recovered = b"valid archive: recovered latest"
        self.assertEqual(self.upload(first)[0], 200)
        self.server.latest_path.write_bytes(recovered)

        code, body, headers = self.request("GET", "/backup")
        self.assertEqual(code, 200)
        self.assertEqual(body, recovered)
        self.assertEqual(headers.get("X-Superagent-SHA256"), hashlib.sha256(recovered).hexdigest())
        metadata = self.server.state()["backup"]
        self.assertTrue(metadata["reconciled"])
        self.assertEqual(metadata["sha256"], hashlib.sha256(recovered).hexdigest())

    def test_upload_requires_owner_lease_and_size_limit(self) -> None:
        code, body, _ = self.upload(b"valid archive: no lease")
        self.assertEqual(code, 409)
        self.assertIn(b"lease required", body)
        self.post("/lease", {"owner": "build-a"})

        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.putrequest("PUT", BASE_PREFIX + "/backup")
        connection.putheader("Authorization", f"Bearer {TOKEN}")
        connection.putheader("X-Superagent-Owner", "build-a")
        with patch("deploy.cnb.archive_server.MAX_BACKUP_BYTES", 16):
            connection.putheader("Content-Length", "17")
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 413)
            response.read()
            connection.close()

    def test_request_thread_limit_rejects_excess_connections(self) -> None:
        acquired = 0
        try:
            for _ in range(MAX_REQUEST_THREADS):
                self.server.request_slots.acquire()
                acquired += 1
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
            connection.request("GET", BASE_PREFIX + "/health")
            with self.assertRaises((OSError, http.client.HTTPException)):
                connection.getresponse()
            connection.close()
        finally:
            for _ in range(acquired):
                self.server.request_slots.release()

    def test_partial_upload_keeps_previous_latest(self) -> None:
        self.post("/lease", {"owner": "build-a"})
        original = b"valid archive: stable"
        self.assertEqual(self.upload(original)[0], 200)

        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.putrequest("PUT", BASE_PREFIX + "/backup")
        connection.putheader("Authorization", f"Bearer {TOKEN}")
        connection.putheader("X-Superagent-Owner", "build-a")
        connection.putheader("Content-Length", "100")
        connection.endheaders()
        connection.send(b"partial")
        connection.sock.shutdown(1)
        try:
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            response.read()
        except (OSError, http.client.HTTPException):
            # Some HTTP stacks close the connection after the client half-close.
            pass
        finally:
            connection.close()
        time.sleep(0.1)
        self.assertEqual(self.server.latest_path.read_bytes(), original)
        self.assertFalse(list(self.root.glob(".upload-*.tmp")))


if __name__ == "__main__":
    unittest.main()
