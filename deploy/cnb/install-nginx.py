#!/usr/bin/env python3
"""Safely add the Superagent archive API location to the fixed HTTPS vhost."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence


DEFAULT_CONFIG = Path("/etc/nginx/sites-available/superagent.example.com")
DEFAULT_SERVER_NAME = "superagent.example.com"
BEGIN_MARKER = "# BEGIN CNB-SUPERAGENT-RUNTIME"
END_MARKER = "# END CNB-SUPERAGENT-RUNTIME"


class ConfigError(RuntimeError):
    """The vhost is ambiguous or cannot be safely patched."""


@dataclass(frozen=True)
class Token:
    value: str
    start: int
    end: int


@dataclass(frozen=True)
class Block:
    opening: int
    closing: int
    header: tuple[Token, ...]
    parent: int | None
    directives: tuple[tuple[Token, ...], ...]


def tokenize(source: str) -> list[Token]:
    """Tokenize braces/directives while ignoring comments and quoted braces."""
    result: list[Token] = []
    index = 0
    punctuation = "{};"
    while index < len(source):
        char = source[index]
        if char.isspace():
            index += 1
            continue
        if char == "#":
            newline = source.find("\n", index)
            index = len(source) if newline < 0 else newline + 1
            continue
        if char in punctuation:
            result.append(Token(char, index, index + 1))
            index += 1
            continue
        if char in ("'", '"'):
            quote = char
            start = index
            index += 1
            value: list[str] = []
            while index < len(source):
                char = source[index]
                if char == "\\" and index + 1 < len(source):
                    value.extend((char, source[index + 1]))
                    index += 2
                    continue
                if char == quote:
                    index += 1
                    break
                value.append(char)
                index += 1
            else:
                raise ConfigError("Unterminated quoted string in Nginx config.")
            result.append(Token("".join(value), start, index))
            continue
        start = index
        while index < len(source) and not source[index].isspace() and source[index] not in punctuation + "#'\"":
            index += 1
        if index == start:
            raise ConfigError(f"Unexpected character at byte offset {index}.")
        result.append(Token(source[start:index], start, index))
    return result


def parse_blocks(tokens: Sequence[Token]) -> dict[int, Block]:
    """Return brace blocks with their direct directives and parent context."""
    open_stack: list[int] = []
    headers: dict[int, tuple[Token, ...]] = {}
    parents: dict[int, int | None] = {}
    directives: dict[int, list[tuple[Token, ...]]] = {}
    closings: dict[int, int] = {}
    statement: list[Token] = []
    for index, token in enumerate(tokens):
        if token.value == "{":
            headers[index] = tuple(statement)
            parents[index] = open_stack[-1] if open_stack else None
            directives[index] = []
            open_stack.append(index)
            statement = []
        elif token.value == ";":
            if open_stack and statement:
                directives[open_stack[-1]].append(tuple(statement))
            statement = []
        elif token.value == "}":
            if not open_stack:
                raise ConfigError("Unbalanced closing brace in Nginx config.")
            opening = open_stack.pop()
            closings[opening] = index
            statement = []
        else:
            statement.append(token)
    if open_stack:
        raise ConfigError("Unbalanced opening brace in Nginx config.")
    return {
        opening: Block(opening, closing, headers[opening], parents[opening], tuple(directives[opening]))
        for opening, closing in closings.items()
    }


def _is_443_ssl(block: Block, tokens: Sequence[Token]) -> bool:
    for directive in block.directives:
        values = [token.value.lower() for token in directive]
        if not values or values[0] != "listen" or "ssl" not in values[1:]:
            continue
        for endpoint in values[1:2]:
            if endpoint == "443" or endpoint.endswith(":443"):
                return True
    return False


def select_https_server(source: str, server_name: str) -> tuple[Block, list[Token], dict[int, Block]]:
    tokens = tokenize(source)
    blocks = parse_blocks(tokens)
    candidates: list[Block] = []
    for block in blocks.values():
        if not block.header or block.header[0].value.lower() != "server":
            continue
        names = {
            token.value.rstrip(";").lower()
            for directive in block.directives
            if directive and directive[0].value.lower() == "server_name"
            for token in directive[1:]
        }
        if server_name.lower() in names and _is_443_ssl(block, tokens):
            candidates.append(block)
    if len(candidates) != 1:
        raise ConfigError(
            f"Expected one TLS server for {server_name}; found {len(candidates)}. No config was changed."
        )
    return candidates[0], tokens, blocks


def _descends_from(block: Block, ancestor: int, blocks: dict[int, Block]) -> bool:
    parent = block.parent
    while parent is not None:
        if parent == ancestor:
            return True
        parent_block = blocks.get(parent)
        parent = parent_block.parent if parent_block else None
    return False


def _overlaps_runtime_location(args: Sequence[str]) -> bool:
    for value in args:
        normalized = value.replace("\\/", "/")
        if normalized == "/superagent-runtime" or "/superagent-runtime/" in normalized:
            return True
    return False


def _managed_span(source: str) -> tuple[int, int] | None:
    begin = list(re.finditer(r"(?m)^[ \t]*# BEGIN CNB-SUPERAGENT-RUNTIME[ \t]*\r?$", source))
    end = list(re.finditer(r"(?m)^[ \t]*# END CNB-SUPERAGENT-RUNTIME[ \t]*\r?$", source))
    if not begin and not end:
        return None
    if len(begin) != 1 or len(end) != 1 or begin[0].start() >= end[0].start():
        raise ConfigError("Managed Nginx markers are missing, duplicated, or out of order.")
    start, finish = begin[0].start(), end[0].end()
    if finish < len(source) and source[finish] == "\n":
        finish += 1
    return start, finish


def _line_indent(source: str, offset: int) -> str:
    line_start = source.rfind("\n", 0, offset) + 1
    prefix = source[line_start:offset]
    return prefix if not prefix.strip() else ""


def _insert_before_close(source: str, close_offset: int, block_text: str, newline: str) -> str:
    line_start = source.rfind("\n", 0, close_offset) + 1
    prefix = source[line_start:close_offset]
    if not prefix.strip():
        return source[:line_start] + block_text + source[line_start:]
    return source[:close_offset] + newline + block_text + source[close_offset:]


def render_block(indent: str, newline: str) -> str:
    inner = indent + "    "
    deeper = inner + "    "
    lines = [
        indent + BEGIN_MARKER,
        inner + "location ^~ /superagent-runtime/ {",
        deeper + "client_max_body_size 512m;",
        deeper + "client_body_timeout 60s;",
        "",
        deeper + "proxy_pass http://127.0.0.1:9012/superagent-runtime/;",
        deeper + "proxy_http_version 1.1;",
        deeper + "proxy_request_buffering off;",
        deeper + "proxy_buffering off;",
        "",
        deeper + "proxy_connect_timeout 5s;",
        deeper + "proxy_send_timeout 180s;",
        deeper + "proxy_read_timeout 60s;",
        "",
        deeper + "proxy_set_header Host $host;",
        deeper + "proxy_set_header Authorization $http_authorization;",
        deeper + "proxy_set_header X-Real-IP $remote_addr;",
        deeper + "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
        deeper + "proxy_set_header X-Forwarded-Proto https;",
        inner + "}",
        indent + END_MARKER,
    ]
    return newline.join(lines) + newline


def patch_config(source: str, server_name: str = DEFAULT_SERVER_NAME) -> tuple[str, bool]:
    server, tokens, blocks = select_https_server(source, server_name)
    server_start = tokens[server.opening].end
    server_end = tokens[server.closing].start
    managed = _managed_span(source)
    if managed:
        start, finish = managed
        if not (server_start <= start < finish <= server_end):
            raise ConfigError("Managed block is outside the selected HTTPS server.")
        if source[server_start:start].count("{") != source[server_start:start].count("}"):
            raise ConfigError("Managed block is nested inside another Nginx context.")
        if source[start:finish].count("{") != source[start:finish].count("}"):
            raise ConfigError("Managed block has unbalanced braces.")
        remainder = source[:start] + source[finish:]
        shifted_server, shifted_tokens, shifted_blocks = select_https_server(remainder, server_name)
        shifted_start = shifted_tokens[shifted_server.opening].end
        shifted_end = shifted_tokens[shifted_server.closing].start
        for block in shifted_blocks.values():
            if not _descends_from(block, shifted_server.opening, shifted_blocks):
                continue
            if block.header and block.header[0].value.lower() == "location":
                args = [token.value for token in block.header[1:]]
                if _overlaps_runtime_location(args):
                    raise ConfigError("An unmanaged /superagent-runtime/ location already exists.")
        closing_indent = _line_indent(remainder, shifted_end)
        indent = closing_indent + "    "
        newline = "\r\n" if "\r\n" in remainder else "\n"
        replacement = render_block(indent, newline)
        updated = _insert_before_close(remainder, shifted_end, replacement, newline)
        if updated == source:
            return source, False
        return updated, True

    for block in blocks.values():
        if not _descends_from(block, server.opening, blocks):
            continue
        if block.header and block.header[0].value.lower() == "location":
            args = [token.value for token in block.header[1:]]
            if _overlaps_runtime_location(args):
                raise ConfigError("An unmanaged /superagent-runtime/ location already exists.")
    closing_indent = _line_indent(source, server_end)
    indent = closing_indent + "    "
    newline = "\r\n" if "\r\n" in source else "\n"
    block_text = render_block(indent, newline)
    updated = _insert_before_close(source, server_end, block_text, newline)
    return updated, True


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        pass


def atomic_write(path: Path, data: bytes, metadata: os.stat_result) -> None:
    descriptor, temp_name = tempfile.mkstemp(prefix=".install-nginx-", dir=path.parent)
    temporary = Path(temp_name)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, metadata.st_mode & 0o7777)
        if hasattr(os, "fchown"):
            os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _run(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)


def configure(config_path: Path = DEFAULT_CONFIG, server_name: str = DEFAULT_SERVER_NAME) -> tuple[bool, Path | None]:
    if config_path.is_symlink() or not config_path.is_file():
        raise ConfigError(f"Nginx config must be a regular non-symlink file: {config_path}")
    original = config_path.read_bytes()
    try:
        source = original.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ConfigError("Nginx config is not valid UTF-8; refusing to rewrite it.") from exc
    updated, changed = patch_config(source, server_name)
    if not changed:
        return False, None

    metadata = config_path.stat()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + f".{time.time_ns() % 1_000_000_000:09d}Z"
    backup = config_path.with_name(config_path.name + ".bak." + stamp)
    shutil.copy2(config_path, backup)
    atomic_write(config_path, updated.encode("utf-8"), metadata)

    tested = _run(("nginx", "-t"))
    if tested.returncode != 0:
        atomic_write(config_path, backup.read_bytes(), metadata)
        raise ConfigError("nginx -t failed; the original config was restored. " + (tested.stdout or "").strip())
    reloaded = _run(("systemctl", "reload", "nginx"))
    if reloaded.returncode != 0:
        atomic_write(config_path, backup.read_bytes(), metadata)
        _run(("nginx", "-t"))
        _run(("systemctl", "reload", "nginx"))
        raise ConfigError("Nginx reload failed; the original config was restored. " + (reloaded.stdout or "").strip())
    return True, backup


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--server-name", default=DEFAULT_SERVER_NAME)
    args = parser.parse_args(argv)
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        parser.error("run this installer as root")
    try:
        changed, backup = configure(args.config, args.server_name)
    except (ConfigError, OSError) as exc:
        print(f"Nginx patch failed: {exc}", file=sys.stderr)
        return 1
    if not changed:
        print("Superagent archive location is already installed; no reload was needed.")
    else:
        print(f"Installed Superagent archive location. Backup: {backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
