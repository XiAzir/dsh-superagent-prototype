#!/usr/bin/env python3
"""Read-only public smoke checks for the protected Superagent Web gateway.

Run on the VPS as root. This script never prints response bodies,
credentials, cookies, tokens, or request headers.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
from http.cookies import SimpleCookie
from pathlib import Path
import select
import socket
import ssl
import struct
import sys
import time
from typing import Any
from urllib.parse import urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener


ORIGIN = os.environ.get("PUBLIC_ORIGIN", "https://superagent.example.com")
_PUBLIC_URL = urlsplit(ORIGIN)
if (_PUBLIC_URL.scheme != "https" or not _PUBLIC_URL.hostname or _PUBLIC_URL.username or _PUBLIC_URL.password
        or _PUBLIC_URL.path not in ("", "/") or _PUBLIC_URL.query or _PUBLIC_URL.fragment
        or any(ord(char) < 0x21 or ord(char) == 0x7f for char in ORIGIN)):
    raise SystemExit("PUBLIC_ORIGIN must be a safe HTTPS origin without a path or credentials")
HOST = _PUBLIC_URL.hostname
BASE = f"https://{_PUBLIC_URL.netloc}"
PORT = _PUBLIC_URL.port or 443
CREDENTIALS = Path("/root/.cnb-superagent/web-credentials.json")
STATE_ROUTE = "/orchestrator/api/state"
SMOKE_POST_ROUTE = "/orchestrator/api/__public_web_smoke_noop__"
WS_ROUTE = "/api/remote.mux"
COOKIE_NAME_PREFIX = "dsh-auth-"
COOKIE_NAME_LENGTH = len(COOKIE_NAME_PREFIX) + 43
TLS_CONTEXT = ssl.create_default_context()


class ProbeFailure(Exception):
    """A safe-to-report probe failure without response content or credentials."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> None:
        return None


OPENER = build_opener(ProxyHandler({}), NoRedirect(), HTTPSHandler(context=TLS_CONTEXT))


def credentials() -> tuple[str, str]:
    try:
        if CREDENTIALS.is_symlink():
            raise ProbeFailure("credential file is unavailable or invalid")
        info = CREDENTIALS.stat()
        if info.st_uid != 0 or info.st_mode & 0o077:
            raise ProbeFailure("credential file permissions are unsafe")
        value = json.loads(CREDENTIALS.read_text(encoding="utf-8"))
        username, password = value["username"], value["password"]
    except ProbeFailure:
        raise
    except Exception as exc:
        raise ProbeFailure("credential file is unavailable or invalid") from exc
    if not isinstance(username, str) or not isinstance(password, str) or not username or not password:
        raise ProbeFailure("credential file is unavailable or invalid")
    return username, password


def basic_header(username: str, password: str) -> str:
    raw = f"{username}:{password}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def http_request(path: str, *, auth: str | None = None, cookie: str | None = None,
                 origin: str | None = None, method: str = "GET",
                 orchestrator_marker: bool = False) -> tuple[int, Any]:
    headers: dict[str, str] = {"Accept": "application/json, text/html;q=0.9, */*;q=0.8"}
    if auth is not None:
        headers["Authorization"] = auth
    if cookie is not None:
        headers["Cookie"] = cookie
    if origin is not None:
        headers["Origin"] = origin
    if orchestrator_marker:
        headers["X-Orchestrator-Request"] = "1"
    request = Request(BASE + path, data=b"" if method == "POST" else None,
                      headers=headers, method=method)
    try:
        response = OPENER.open(request, timeout=12)
        try:
            return response.status, response.headers
        finally:
            response.close()
    except HTTPError as response:
        try:
            return response.code, response.headers
        finally:
            response.close()
    except (URLError, TimeoutError, OSError, ssl.SSLError) as exc:
        raise ProbeFailure("HTTPS request failed") from exc


def bootstrap_cookie(headers: Any) -> tuple[str, str]:
    set_cookie_headers = headers.get_all("Set-Cookie", [])
    if len(set_cookie_headers) != 1:
        raise ProbeFailure("root bootstrap did not return exactly one session cookie")
    parsed = SimpleCookie()
    try:
        parsed.load(set_cookie_headers[0])
    except Exception as exc:
        raise ProbeFailure("root bootstrap returned an invalid session cookie") from exc
    if len(parsed) != 1:
        raise ProbeFailure("root bootstrap returned an invalid session cookie")
    name, morsel = next(iter(parsed.items()))
    if (not re.fullmatch(r"dsh-auth-[A-Za-z0-9_-]{43}", name) or len(name) != COOKIE_NAME_LENGTH
            or not morsel.value or not morsel["secure"] or not morsel["httponly"]
            or morsel["samesite"].lower() != "strict" or morsel["path"] != "/"):
        raise ProbeFailure("root bootstrap cookie flags or name are invalid")
    if len((name + "=" + morsel.value).encode("ascii")) > 4096:
        raise ProbeFailure("root bootstrap session cookie exceeded the limit")
    return name, morsel.value


def ws_handshake(auth: str, cookie: str, *, origin: str | None,
                 fetch_site: str = "same-origin") -> tuple[socket.socket, int, bytes]:
    raw = socket.create_connection((HOST, PORT), timeout=8)
    try:
        tls = TLS_CONTEXT.wrap_socket(raw, server_hostname=HOST)
    except Exception:
        raw.close()
        raise
    tls.settimeout(8)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    lines = [
        f"GET {WS_ROUTE} HTTP/1.1",
        f"Host: {HOST}",
        f"Authorization: {auth}",
        f"Cookie: {cookie}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
        f"Sec-Fetch-Site: {fetch_site}",
    ]
    if origin is not None:
        lines.append(f"Origin: {origin}")
    tls.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
    response = bytearray()
    while b"\r\n\r\n" not in response:
        block = tls.recv(4096)
        if not block:
            raise ProbeFailure("WebSocket handshake closed before its response")
        response.extend(block)
        if len(response) > 16 * 1024:
            raise ProbeFailure("WebSocket handshake response exceeded the limit")
    header_end = response.index(b"\r\n\r\n") + 4
    header_block = bytes(response[:header_end])
    rest = bytes(response[header_end:])
    first_line = header_block.split(b"\r\n", 1)[0]
    try:
        status = int(first_line.split()[1])
    except (IndexError, ValueError) as exc:
        raise ProbeFailure("WebSocket handshake returned an invalid status") from exc
    return tls, status, rest


def masked_frame(opcode: int, payload: bytes = b"") -> bytes:
    if len(payload) > 125:
        raise ProbeFailure("unexpected oversized WebSocket control frame")
    mask = os.urandom(4)
    encoded = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return bytes((0x80 | opcode, 0x80 | len(payload))) + mask + encoded


def service_websocket_idle(tls: socket.socket, initial: bytes, seconds: float) -> None:
    """Keep a quiet WebSocket alive by answering control pings for the interval."""
    deadline = time.monotonic() + seconds
    pending = bytearray(initial)
    while time.monotonic() < deadline:
        consumed = 0
        while len(pending) - consumed >= 2:
            first, second = pending[consumed], pending[consumed + 1]
            length = second & 0x7F
            offset = consumed + 2
            if length == 126:
                if len(pending) - offset < 2:
                    break
                length = struct.unpack_from("!H", pending, offset)[0]
                offset += 2
            elif length == 127:
                if len(pending) - offset < 8:
                    break
                length = struct.unpack_from("!Q", pending, offset)[0]
                offset += 8
            masked = bool(second & 0x80)
            mask = b""
            if masked:
                if len(pending) - offset < 4:
                    break
                mask = bytes(pending[offset:offset + 4])
                offset += 4
            if length > 64 * 1024:
                raise ProbeFailure("WebSocket sent an oversized frame")
            if len(pending) - offset < length:
                break
            payload = bytes(pending[offset:offset + length])
            if masked:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            consumed = offset + length
            opcode = first & 0x0F
            if opcode == 0x8:
                raise ProbeFailure("WebSocket closed during the idle check")
            if opcode == 0x9:
                tls.sendall(masked_frame(0xA, payload))
        if consumed:
            del pending[:consumed]
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        readable = [tls] if tls.pending() else select.select([tls], [], [], min(remaining, 1.0))[0]
        if not readable:
            continue
        try:
            block = tls.recv(4096)
        except (TimeoutError, socket.timeout):
            continue
        if not block:
            raise ProbeFailure("WebSocket closed during the idle check")
        pending.extend(block)
    if pending:
        # Partial trailing data is fine; it remains opaque application traffic.
        pass


def expect_status(actual: int, expected: int, label: str) -> None:
    if actual != expected:
        raise ProbeFailure(f"{label} returned HTTP {actual}; expected {expected}")


def run(*, skip_ws_idle: bool) -> None:
    username, password = credentials()
    good_auth = basic_header(username, password)
    bad_auth = basic_header(username, password + "-invalid")

    expect_status(http_request("/")[0], 401, "anonymous root")
    expect_status(http_request("/", auth=bad_auth)[0], 401, "incorrect Basic auth")
    print("PASS: anonymous and incorrect Basic auth rejected (401)")

    root_status, root_headers = http_request("/", auth=good_auth)
    expect_status(root_status, 200, "authenticated root bootstrap")
    cookie_name, cookie_value = bootstrap_cookie(root_headers)
    cookie_header = f"{cookie_name}={cookie_value}"
    print("PASS: authenticated root bootstrap returned Secure, HttpOnly, SameSite=Strict cookie")

    api_status, _ = http_request(STATE_ROUTE, auth=good_auth, cookie=cookie_header,
                                 origin=ORIGIN, orchestrator_marker=True)
    expect_status(api_status, 200, "management state GET")
    print("PASS: authenticated management state GET (200)")

    expect_status(http_request(SMOKE_POST_ROUTE, auth=good_auth, cookie=cookie_header,
                               origin="https://invalid.example", method="POST")[0], 403,
                  "cross-origin POST")
    expect_status(http_request(SMOKE_POST_ROUTE, auth=good_auth, cookie=cookie_header,
                               method="POST")[0], 403, "POST without Origin")
    same_origin_status, _ = http_request(SMOKE_POST_ROUTE, auth=good_auth, cookie=cookie_header,
                                         origin=ORIGIN, method="POST", orchestrator_marker=True)
    expect_status(same_origin_status, 404, "same-origin no-op POST")
    expect_status(http_request("/?token=smoke", auth=good_auth)[0], 400, "token query")
    print("PASS: unsafe cross-origin/missing-Origin POST rejected; same-origin no-op POST returned 404; token query rejected")

    for ws_origin, fetch_site, expected, label in (
        ("https://invalid.example", "cross-site", 403, "cross-origin WebSocket"),
        (None, "same-origin", 403, "WebSocket without Origin"),
    ):
        tls, status, _ = ws_handshake(good_auth, cookie_header, origin=ws_origin,
                                      fetch_site=fetch_site)
        tls.close()
        expect_status(status, expected, label)
    print("PASS: cross-origin and missing-Origin WebSocket handshakes rejected (403)")

    tls, status, initial = ws_handshake(good_auth, cookie_header, origin=ORIGIN)
    try:
        expect_status(status, 101, "WebSocket handshake")
        if not skip_ws_idle:
            service_websocket_idle(tls, initial, 16.0)
    finally:
        tls.close()
    if skip_ws_idle:
        print("PASS: WebSocket handshake returned 101 (idle check skipped)")
    else:
        print("PASS: WebSocket handshake returned 101 and remained open for 16 seconds")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-ws-idle", action="store_true",
                        help="check the WebSocket 101 handshake without the 16-second idle wait")
    args = parser.parse_args()
    if not sys.platform.startswith("linux") or os.geteuid() != 0:
        print("FAIL: run this script as root on the Linux VPS")
        return 2
    try:
        run(skip_ws_idle=args.skip_ws_idle)
    except ProbeFailure as exc:
        print(f"FAIL: {exc}")
        return 1
    except Exception:
        print("FAIL: unexpected probe error (details suppressed)")
        return 1
    print("PASS: public Web smoke checks complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
