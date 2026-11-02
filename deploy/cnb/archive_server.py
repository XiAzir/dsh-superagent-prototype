#!/usr/bin/env python3
"""Local CNB workspace lease and durable snapshot receiver.

The receiver stores only the dsh-superagent ``home/state/work`` archive. It is
kept on a loopback listener and expects an independently provisioned bearer
token. The archive format and path allowlist live in the adjacent archive.py.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

BASE_PREFIX = "/superagent-runtime"
LEASE_SECONDS = 180
BOOTSTRAP_GRACE_SECONDS = 900
HEARTBEAT_TIMEOUT_SECONDS = 120
MAX_JSON_BYTES = 8 * 1024
MAX_BACKUP_BYTES = 512 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024
SOCKET_TIMEOUT_SECONDS = 30
MAX_REQUEST_THREADS = 32
OWNER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def _default_validator(path: Path) -> dict[str, Any]:
    """Load the sibling archive validator when serving an upload."""
    try:
        try:
            from .archive import validate_archive
        except ImportError:
            from archive import validate_archive  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("archive validator unavailable") from exc
    result = validate_archive(path)
    if not isinstance(result, dict):
        raise ValueError("archive validator returned invalid metadata")
    return result


def _clean_metadata(value: Any) -> dict[str, Any]:
    """Keep only bounded, nonsecret archive metadata from the validator."""
    if not isinstance(value, dict):
        return {}
    result: dict[str, Any] = {}
    schema_version = value.get("schema_version")
    files = value.get("files")
    if isinstance(schema_version, int) and not isinstance(schema_version, bool) and schema_version >= 0:
        result["manifest_version"] = schema_version
    if isinstance(files, list):
        result["files"] = len(files)
    for key in ("members", "expanded_bytes", "manifest_version", "snapshot_kind"):
        item = value.get(key)
        if key in ("members", "expanded_bytes"):
            if isinstance(item, int) and not isinstance(item, bool) and item >= 0:
                result[key] = item
        elif isinstance(item, str) and len(item) <= 80:
            result[key] = item
    return result


class ArchiveServer(ThreadingHTTPServer):
    """Server factory suitable for production startup and ephemeral tests."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        directory: str | os.PathLike[str],
        token: str,
        validator: Callable[[Path], dict[str, Any]] | None = None,
    ) -> None:
        if not isinstance(token, str) or len(token) < 32:
            raise ValueError("SUPERAGENT_ARCHIVE_TOKEN must be at least 32 characters")
        self.root = Path(directory)
        self.root.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            try:
                self.root.chmod(0o700)
            except OSError:
                pass
        self.token = token.encode("utf-8")
        self.validator = validator or _default_validator
        self.state_path = self.root / "state.json"
        self.latest_path = self.root / "latest.zip"
        self.previous_path = self.root / "previous.zip"
        self.lock = threading.RLock()
        self.upload_slot = threading.BoundedSemaphore(1)
        self.request_slots = threading.BoundedSemaphore(MAX_REQUEST_THREADS)
        super().__init__(server_address, ArchiveHandler)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self.request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.request_slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()

    def state(self) -> dict[str, Any]:
        try:
            value = json.loads(self.state_path.read_text(encoding="utf-8"))
            if isinstance(value, dict):
                return value
        except (OSError, ValueError):
            pass
        return {"lease": None, "heartbeat": None, "backup": None}

    def save_state(self, value: dict[str, Any]) -> None:
        """Durably replace state JSON and its directory entry."""
        fd, temp_name = tempfile.mkstemp(prefix=".state-", suffix=".tmp", dir=self.root)
        temp = Path(temp_name)
        try:
            if os.name != "nt":
                os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(value, stream, separators=(",", ":"), ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self.state_path)
            self._fsync_root()
        finally:
            temp.unlink(missing_ok=True)

    def _fsync_root(self) -> None:
        if os.name == "nt":
            return
        try:
            fd = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError:
            pass

    def active_lease(self, state: dict[str, Any], now: float | None = None) -> dict[str, Any] | None:
        lease = state.get("lease")
        if not isinstance(lease, dict) or not isinstance(lease.get("expires_at"), (int, float)):
            return None
        if lease["expires_at"] <= (time.time() if now is None else now):
            return None
        return lease

    @staticmethod
    def file_signature(path: Path) -> dict[str, int]:
        stat_result = path.stat()
        return {
            "bytes": stat_result.st_size,
            "file_id": getattr(stat_result, "st_ino", 0),
            "file_mtime_ns": getattr(stat_result, "st_mtime_ns", int(stat_result.st_mtime * 1_000_000_000)),
        }

    @staticmethod
    def hash_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            while block := source.read(UPLOAD_CHUNK_BYTES):
                digest.update(block)
        return digest.hexdigest()


class ArchiveHandler(BaseHTTPRequestHandler):
    server: ArchiveServer
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        self.request.settimeout(SOCKET_TIMEOUT_SECONDS)
        super().setup()

    def log_message(self, _format: str, *_args: Any) -> None:
        # Requests can contain sensitive credentials in malformed headers.
        return

    def _reply(self, code: int, value: dict[str, Any], close: bool = False) -> None:
        data = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _auth(self) -> bool:
        value = self.headers.get("Authorization", "")
        prefix, separator, supplied = value.partition(" ")
        return (
            separator == " "
            and prefix.lower() == "bearer"
            and bool(supplied)
            and hmac.compare_digest(supplied.encode("utf-8"), self.server.token)
        )

    def _authorized(self) -> bool:
        if self._auth():
            return True
        self._reply(401, {"error": "authentication required"}, close=True)
        return False

    def _route(self) -> str | None:
        path = self.path.split("?", 1)[0]
        if not path.startswith(BASE_PREFIX + "/"):
            return None
        suffix = path[len(BASE_PREFIX) :]
        return suffix if suffix in ("/health", "/status", "/lease", "/heartbeat", "/release", "/backup") else None

    def _read_json(self) -> dict[str, Any] | None:
        if self.headers.get("Transfer-Encoding"):
            self._reply(400, {"error": "invalid request"}, close=True)
            return None
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = MAX_JSON_BYTES + 1
        if length <= 0 or length > MAX_JSON_BYTES:
            self._reply(413 if length > MAX_JSON_BYTES else 400, {"error": "invalid request size"}, close=True)
            return None
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("incomplete body")
            value = json.loads(body)
        except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._reply(400, {"error": "invalid JSON"}, close=True)
            return None
        if not isinstance(value, dict):
            self._reply(400, {"error": "JSON object required"}, close=True)
            return None
        return value

    @staticmethod
    def _owner(value: Any) -> str | None:
        return value if isinstance(value, str) and OWNER_RE.fullmatch(value) else None

    def do_GET(self) -> None:  # noqa: N802
        route = self._route()
        if route is None:
            self._reply(404, {"error": "not found"})
            return
        if route == "/health":
            with self.server.lock:
                state = self.server.state()
                lease = self.server.active_lease(state)
                heartbeat = state.get("heartbeat") or {}
                now = time.time()
                heartbeat_at = heartbeat.get("at") if isinstance(heartbeat, dict) else None
                heartbeat_recent = (
                    isinstance(heartbeat_at, (int, float))
                    and 0 <= now - heartbeat_at <= HEARTBEAT_TIMEOUT_SECONDS
                )
                acquired_at = (
                    lease.get("acquired_at", lease.get("expires_at", now) - LEASE_SECONDS)
                    if lease
                    else now
                )
                bootstrapping = bool(
                    lease
                    and isinstance(acquired_at, (int, float))
                    and 0 <= now - acquired_at <= BOOTSTRAP_GRACE_SECONDS
                )
                intentionally_paused = state.get("intentional_paused") is True
                fresh_paused = bool(
                    lease
                    and heartbeat_recent
                    and isinstance(heartbeat, dict)
                    and heartbeat.get("paused") is True
                )
                healthy = bool(
                    (intentionally_paused and (not lease or bootstrapping))
                    or fresh_paused
                    or (
                        lease
                        and (
                            bootstrapping
                            or (
                                heartbeat_recent
                                and isinstance(heartbeat, dict)
                                and heartbeat.get("healthy") is True
                                and heartbeat.get("paused") is not True
                            )
                        )
                    )
                )
            self._reply(200, {"status": "ok" if healthy else "waiting"})
            return
        if not self._authorized():
            return
        if route == "/status":
            with self.server.lock:
                state = self.server.state()
                lease = self.server.active_lease(state)
                heartbeat = state.get("heartbeat")
                backup = state.get("backup")
                summary = {
                    "health": {
                        "healthy": bool(isinstance(heartbeat, dict) and heartbeat.get("healthy") is True),
                        "paused": bool(isinstance(heartbeat, dict) and heartbeat.get("paused", False)),
                        "age_sec": max(0, int(time.time() - heartbeat["at"]))
                        if isinstance(heartbeat, dict) and isinstance(heartbeat.get("at"), (int, float))
                        else None,
                    },
                    "lease": {
                        "active": lease is not None,
                        "owner": lease.get("owner") if lease else None,
                        "expires_in_sec": max(0, int(lease["expires_at"] - time.time())) if lease else 0,
                    },
                    "intentional_paused": state.get("intentional_paused") is True,
                    "backup": backup if isinstance(backup, dict) else None,
                }
            self._reply(200, summary)
            return
        if route == "/backup":
            with self.server.lock:
                if not self.server.latest_path.is_file():
                    self._reply(404, {"error": "no snapshot yet"})
                    return
                state = self.server.state()
                backup = state.get("backup")
                if not isinstance(backup, dict):
                    backup = {}
                signature = self.server.file_signature(self.server.latest_path)
                signature_matches = all(backup.get(key) == value for key, value in signature.items())
                sha256 = backup.get("sha256")
                if not signature_matches or not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
                    sha256 = self.server.hash_file(self.server.latest_path)
                    backup = {
                        **backup,
                        "uploaded_at": backup.get("uploaded_at", self.server.latest_path.stat().st_mtime),
                        "sha256": sha256,
                        **signature,
                        "reconciled": True,
                    }
                    state["backup"] = backup
                    self.server.save_state(state)
                size = signature["bytes"]
                try:
                    source = self.server.latest_path.open("rb")
                except OSError:
                    self._reply(404, {"error": "no snapshot yet"})
                    return
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            if isinstance(sha256, str) and re.fullmatch(r"[0-9a-f]{64}", sha256):
                self.send_header("X-Archive-SHA256", sha256)
                self.send_header("X-Superagent-SHA256", sha256)
            self.end_headers()
            try:
                with source:
                    shutil.copyfileobj(source, self.wfile, UPLOAD_CHUNK_BYTES)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return

    def do_POST(self) -> None:  # noqa: N802
        route = self._route()
        if route not in ("/lease", "/heartbeat", "/release"):
            self._reply(404, {"error": "not found"})
            return
        if not self._authorized():
            return
        payload = self._read_json()
        if payload is None:
            return
        owner = self._owner(payload.get("owner"))
        if owner is None:
            self._reply(400, {"error": "invalid owner"})
            return
        now = time.time()
        with self.server.lock:
            state = self.server.state()
            lease = self.server.active_lease(state, now)
            if route == "/lease":
                if lease and lease.get("owner") != owner:
                    self._reply(409, {"error": "lease held"})
                    return
                acquired_at = lease.get("acquired_at", now) if lease and lease.get("owner") == owner else now
                state["lease"] = {"owner": owner, "acquired_at": acquired_at, "expires_at": now + LEASE_SECONDS}
                if not lease or (state.get("heartbeat") or {}).get("owner") != owner:
                    if state.get("intentional_paused") is not True:
                        state["heartbeat"] = None
                self.server.save_state(state)
                self._reply(200, {"ok": True, "lease_seconds": LEASE_SECONDS})
                return
            if not lease or lease.get("owner") != owner:
                self._reply(409, {"error": "active lease required"})
                return
            if route == "/release":
                paused = payload.get("paused", False)
                if not isinstance(paused, bool):
                    self._reply(400, {"error": "paused must be boolean"})
                    return
                state["lease"] = None
                state["intentional_paused"] = paused
                state["heartbeat"] = (
                    {"owner": owner, "at": now, "healthy": False, "paused": True, "released": True}
                    if paused
                    else None
                )
                self.server.save_state(state)
                self._reply(200, {"ok": True})
                return
            healthy = payload.get("healthy")
            if not isinstance(healthy, bool):
                self._reply(400, {"error": "healthy must be boolean"})
                return
            paused = payload.get("paused", False)
            if not isinstance(paused, bool):
                self._reply(400, {"error": "paused must be boolean"})
                return
            allowed = {"workspace_sn": 80, "version": 80, "stage": 80, "detail": 240}
            metadata: dict[str, str] = {}
            for key, limit in allowed.items():
                item = payload.get(key)
                if item is None:
                    continue
                if not isinstance(item, str) or len(item) > limit or any(ord(ch) < 32 for ch in item):
                    self._reply(400, {"error": "invalid metadata"})
                    return
                metadata[key] = item
            acquired_at = lease.get("acquired_at", lease.get("expires_at", now) - LEASE_SECONDS)
            state["lease"] = {"owner": owner, "acquired_at": acquired_at, "expires_at": now + LEASE_SECONDS}
            state["heartbeat"] = {"owner": owner, "at": now, "healthy": healthy, "paused": paused, **metadata}
            if paused:
                state["intentional_paused"] = True
            elif healthy:
                state["intentional_paused"] = False
            self.server.save_state(state)
        self._reply(200, {"ok": True, "lease_seconds": LEASE_SECONDS})

    def do_PUT(self) -> None:  # noqa: N802
        route = self._route()
        if route != "/backup":
            self._reply(404, {"error": "not found"})
            return
        if not self._authorized():
            return
        owner = self._owner(self.headers.get("X-Superagent-Owner"))
        if owner is None:
            self._reply(400, {"error": "invalid owner"}, close=True)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BACKUP_BYTES or self.headers.get("Transfer-Encoding"):
            self._reply(413 if length > MAX_BACKUP_BYTES else 400, {"error": "invalid archive size"}, close=True)
            return
        if not self.server.upload_slot.acquire(blocking=False):
            self._reply(429, {"error": "upload in progress"}, close=True)
            return
        temp_path: Path | None = None
        try:
            with self.server.lock:
                state = self.server.state()
                lease = self.server.active_lease(state)
                if not lease or lease.get("owner") != owner:
                    self._reply(409, {"error": "active lease required"}, close=True)
                    return
            self.connection.settimeout(SOCKET_TIMEOUT_SECONDS)
            fd, name = tempfile.mkstemp(prefix=".upload-", suffix=".tmp", dir=self.server.root)
            temp_path = Path(name)
            digest = hashlib.sha256()
            received = 0
            try:
                if os.name != "nt":
                    os.fchmod(fd, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    remaining = length
                    while remaining:
                        block = self.rfile.read(min(UPLOAD_CHUNK_BYTES, remaining))
                        if not block:
                            raise EOFError("incomplete upload")
                        stream.write(block)
                        digest.update(block)
                        received += len(block)
                        remaining -= len(block)
                    stream.flush()
                    os.fsync(stream.fileno())
            except (OSError, EOFError, TimeoutError):
                self._reply(400, {"error": "incomplete archive"}, close=True)
                return
            try:
                archive_info = self.server.validator(temp_path)
                clean_info = _clean_metadata(archive_info)
            except Exception:
                self._reply(400, {"error": "archive validation failed"}, close=True)
                return
            with self.server.lock:
                state = self.server.state()
                lease = self.server.active_lease(state)
                if not lease or lease.get("owner") != owner:
                    self._reply(409, {"error": "active lease required"}, close=True)
                    return
                if self.server.latest_path.exists():
                    self._preserve_previous()
                os.replace(temp_path, self.server.latest_path)
                temp_path = None
                self.server._fsync_root()
                backup = {
                    "uploaded_at": time.time(),
                    "sha256": digest.hexdigest(),
                    "owner": owner,
                    **self.server.file_signature(self.server.latest_path),
                    **clean_info,
                }
                state["backup"] = backup
                self.server.save_state(state)
            self._reply(200, {"ok": True, "bytes": received, "sha256": digest.hexdigest(), **clean_info})
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
            self.server.upload_slot.release()

    def _preserve_previous(self) -> None:
        """Copy current latest to a temp and replace previous without moving latest."""
        fd, name = tempfile.mkstemp(prefix=".previous-", suffix=".tmp", dir=self.server.root)
        temp = Path(name)
        try:
            if os.name != "nt":
                os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as destination, self.server.latest_path.open("rb") as source:
                shutil.copyfileobj(source, destination, UPLOAD_CHUNK_BYTES)
                destination.flush()
                os.fsync(destination.fileno())
            os.replace(temp, self.server.previous_path)
            self.server._fsync_root()
        finally:
            temp.unlink(missing_ok=True)

    def do_HEAD(self) -> None:  # noqa: N802
        self._reply(405, {"error": "method not allowed"})


def create_server(
    directory: str | os.PathLike[str] | None = None,
    token: str | None = None,
    port: int | None = None,
    host: str = "127.0.0.1",
    validator: Callable[[Path], dict[str, Any]] | None = None,
) -> ArchiveServer:
    """Create a server without starting its serving loop (also used by tests)."""
    archive_token = token if token is not None else os.environ.get("SUPERAGENT_ARCHIVE_TOKEN", "")
    archive_dir = directory if directory is not None else os.environ.get("SUPERAGENT_ARCHIVE_DIR", "/var/lib/cnb-superagent")
    try:
        listen_port = int(port if port is not None else os.environ.get("SUPERAGENT_ARCHIVE_PORT", "9012"))
    except (TypeError, ValueError) as exc:
        raise ValueError("SUPERAGENT_ARCHIVE_PORT must be an integer") from exc
    if not 0 <= listen_port <= 65535:
        raise ValueError("SUPERAGENT_ARCHIVE_PORT is out of range")
    return ArchiveServer((host, listen_port), archive_dir, archive_token, validator)


def main() -> None:
    server = create_server()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
