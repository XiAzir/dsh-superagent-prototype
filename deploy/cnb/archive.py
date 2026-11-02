"""Create, validate, and restore bounded private Superagent data snapshots.

The archive contains ``snapshot/dsh-home``, ``snapshot/state`` and optionally
``snapshot/work``. It is a ZIP file with a JSON manifest at
``snapshot/manifest.json``. Source data is copied into a temporary staging
directory before the archive is atomically installed. SQLite databases are
copied through SQLite's online backup API so WAL contents are included.

The public API is :func:`create_snapshot`, :func:`validate_archive`, and
:func:`restore_snapshot`. The module can also be run with ``create``,
``validate``, or ``restore`` subcommands.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import shutil
import secrets
import sqlite3
import stat
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


SCHEMA_VERSION = 1
MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_MEMBERS = 200_000
CHUNK_SIZE = 1024 * 1024
SQLITE_BACKUP_TIMEOUT = 15.0
ROOTS = ("dsh-home", "state", "work")
REQUIRED_ROOTS = ("dsh-home", "state")
MANIFEST_NAME = "snapshot/manifest.json"

_SKIP_DIRS = {"node_modules", ".pnpm-store", ".cache", "cache", "caches"}
_RUNTIME_LOG = re.compile(r"dsh-superagent-[A-Za-z0-9_-]+-\d{8}-\d{6}-\d+\.log\Z", re.IGNORECASE)
_COPY_ATTEMPTS = 3
_DIR_FD_SUPPORTED = os.open in os.supports_dir_fd and os.scandir in os.supports_fd


class SnapshotError(ValueError):
    """Raised when a snapshot cannot be safely created, validated, or restored."""


@contextlib.contextmanager
def _temporary_directory(parent: Path, prefix: str):
    path = _new_private_dir(parent, prefix)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def _new_private_dir(parent: Path, prefix: str) -> Path:
    mode = 0o777 if os.name == "nt" else 0o700
    for _ in range(10):
        path = parent / (prefix + secrets.token_hex(8))
        try:
            path.mkdir(mode=mode)
            return path
        except FileExistsError:
            continue
    raise SnapshotError(f"Cannot allocate a temporary directory in {parent}")


def _mkdir_private(path: Path, *, parents: bool = False, exist_ok: bool = False) -> None:
    path.mkdir(mode=0o777 if os.name == "nt" else 0o700, parents=parents, exist_ok=exist_ok)


def _is_runtime_log(relative: Path, name: str) -> bool:
    return relative.parts[:1] == (".artifacts",) and bool(_RUNTIME_LOG.fullmatch(name))


def _safe_mode(mode: int) -> int:
    return 0o700 if mode & stat.S_IXUSR else 0o600


def _set_mode(path: Path, mode: int) -> None:
    # On Windows chmod maps most mode changes to the read-only attribute.
    if os.name != "nt":
        os.chmod(path, mode)


def _hash_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while block := stream.read(CHUNK_SIZE):
            size += len(block)
            digest.update(block)
    return size, digest.hexdigest()


def _sqlite_backup(source: Path, target: Path, expanded_so_far: int, expanded_limit: int) -> None:
    uri = source.as_uri() + "?mode=ro"
    started = time.monotonic()
    src: sqlite3.Connection | None = None
    dst: sqlite3.Connection | None = None
    try:
        src = sqlite3.connect(uri, uri=True, timeout=SQLITE_BACKUP_TIMEOUT)
        src.execute(f"PRAGMA busy_timeout={int(SQLITE_BACKUP_TIMEOUT * 1000)}")
        dst = sqlite3.connect(target)
        page_size = int(src.execute("PRAGMA page_size").fetchone()[0])

        def progress(_status: int, remaining: int, total: int) -> None:
            if time.monotonic() - started > SQLITE_BACKUP_TIMEOUT:
                raise SnapshotError(f"SQLite backup exceeded {SQLITE_BACKUP_TIMEOUT:g}s: {source}")
            estimated = total * page_size
            if expanded_so_far + estimated > expanded_limit:
                raise SnapshotError(f"Snapshot exceeds expanded byte limit ({expanded_limit})")

        src.backup(dst, pages=256, progress=progress, sleep=0.05)
    except (sqlite3.Error, OSError) as exc:
        raise SnapshotError(f"SQLite backup failed for {source}: {exc}") from exc
    finally:
        if dst is not None:
            dst.close()
        if src is not None:
            src.close()


def _same_source_version(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        stat.S_ISREG(after.st_mode)
        and before.st_dev == after.st_dev
        and before.st_ino == after.st_ino
        and before.st_size == after.st_size
        and before.st_mtime_ns == after.st_mtime_ns
    )


def _same_sqlite_identity(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        stat.S_ISREG(before.st_mode)
        and stat.S_ISREG(after.st_mode)
        and before.st_dev == after.st_dev
        and before.st_ino == after.st_ino
    )


def _source_lstat(source: Path, name: str | None, directory_fd: int | None) -> os.stat_result:
    if directory_fd is not None and name is not None:
        return os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    return source.lstat()


def _open_source(source: Path, name: str | None, directory_fd: int | None, flags: int) -> int:
    if directory_fd is not None and name is not None:
        return os.open(name, flags, dir_fd=directory_fd)
    return os.open(source, flags)


def _record_member(budget: dict[str, int], member_limit: int) -> None:
    if budget["members"] + 1 > member_limit:
        raise SnapshotError(f"Snapshot exceeds member limit ({member_limit})")
    budget["members"] += 1


def _copy_regular_file(
    source: Path,
    target: Path,
    initial_stat: os.stat_result,
    budget: dict[str, int],
    expanded_limit: int,
    source_dir_fd: int | None = None,
    source_name: str | None = None,
) -> tuple[int, str] | str:
    """Copy a stable regular file without following a final-component symlink."""
    for attempt in range(_COPY_ATTEMPTS):
        try:
            before = _source_lstat(source, source_name, source_dir_fd)
        except FileNotFoundError:
            if attempt + 1 == _COPY_ATTEMPTS:
                raise SnapshotError(f"Source file disappeared during snapshot: {source}")
            continue
        if stat.S_ISLNK(before.st_mode):
            return "symlink"
        if not stat.S_ISREG(before.st_mode):
            return "special_file"
        if not _same_source_version(initial_stat, before):
            initial_stat = before
            if attempt + 1 < _COPY_ATTEMPTS:
                continue
        if budget["expanded"] + before.st_size > expanded_limit:
            raise SnapshotError(f"Snapshot exceeds expanded byte limit ({expanded_limit})")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd: int | None = None
        copied = 0
        digest = hashlib.sha256()
        try:
            fd = _open_source(source, source_name, source_dir_fd, flags)
            opened = os.fstat(fd)
            if not _same_source_version(before, opened):
                os.close(fd)
                fd = None
                if attempt + 1 == _COPY_ATTEMPTS:
                    raise SnapshotError(f"Source file changed during snapshot: {source}")
                continue
            with os.fdopen(fd, "rb", closefd=True) as src, target.open("wb") as dest:
                fd = None
                while block := src.read(CHUNK_SIZE):
                    if budget["expanded"] + copied + len(block) > expanded_limit:
                        raise SnapshotError(f"Snapshot exceeds expanded byte limit ({expanded_limit})")
                    copied += len(block)
                    digest.update(block)
                    dest.write(block)
                after_fd = os.fstat(src.fileno())
            after_path = _source_lstat(source, source_name, source_dir_fd)
            if not _same_source_version(before, after_fd) or not _same_source_version(before, after_path) or copied != before.st_size:
                target.unlink(missing_ok=True)
                if attempt + 1 == _COPY_ATTEMPTS:
                    raise SnapshotError(f"Source file changed during snapshot: {source}")
                initial_stat = after_path
                continue
            budget["expanded"] += copied
            return copied, digest.hexdigest()
        except SnapshotError:
            target.unlink(missing_ok=True)
            raise
        except OSError as exc:
            target.unlink(missing_ok=True)
            if fd is not None:
                os.close(fd)
                fd = None
            if attempt + 1 == _COPY_ATTEMPTS:
                raise SnapshotError(f"Cannot copy stable source file {source}: {exc}") from exc
        finally:
            if fd is not None:
                os.close(fd)
    raise SnapshotError(f"Source file changed during snapshot: {source}")


def _sqlite_header(
    source: Path,
    expected: os.stat_result,
    source_dir_fd: int | None = None,
    source_name: str | None = None,
) -> bool:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    for attempt in range(_COPY_ATTEMPTS):
        fd: int | None = None
        try:
            before = _source_lstat(source, source_name, source_dir_fd)
            if stat.S_ISLNK(before.st_mode):
                return False
            if not stat.S_ISREG(before.st_mode):
                return False
            if not _same_source_version(expected, before):
                expected = before
                if attempt + 1 < _COPY_ATTEMPTS:
                    continue
            fd = _open_source(source, source_name, source_dir_fd, flags)
            opened = os.fstat(fd)
            if not _same_source_version(before, opened):
                os.close(fd)
                fd = None
                if attempt + 1 < _COPY_ATTEMPTS:
                    continue
                raise SnapshotError(f"Source file changed during snapshot: {source}")
            with os.fdopen(fd, "rb", closefd=True) as stream:
                fd = None
                header = stream.read(16)
                after_fd = os.fstat(stream.fileno())
            after_path = _source_lstat(source, source_name, source_dir_fd)
            if _same_source_version(before, after_fd) and _same_source_version(before, after_path):
                return header == b"SQLite format 3\x00"
            if attempt + 1 == _COPY_ATTEMPTS:
                raise SnapshotError(f"Source file changed during snapshot: {source}")
            expected = after_path
        except FileNotFoundError:
            if attempt + 1 == _COPY_ATTEMPTS:
                raise SnapshotError(f"Source file disappeared during snapshot: {source}")
        except OSError as exc:
            if attempt + 1 == _COPY_ATTEMPTS:
                raise SnapshotError(f"Cannot inspect stable source file {source}: {exc}") from exc
        finally:
            if fd is not None:
                os.close(fd)
    return False


def _walk_source(
    source: Path,
    root_name: str,
    stage: Path,
    skip_counts: dict[str, int],
    budget: dict[str, int],
    expanded_limit: int,
    member_limit: int,
) -> list[dict[str, Any]]:
    root_stage = stage / root_name
    _mkdir_private(root_stage, parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []
    sqlite_bases: set[Path] = set()

    def visit(
        directory: Path,
        relative: Path,
        *,
        expected_stat: os.stat_result | None = None,
        parent_fd: int | None = None,
        entry_name: str | None = None,
    ) -> None:
        owned_fd: int | None = None
        directory_fd: int | None = None
        try:
            if _DIR_FD_SUPPORTED:
                flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
                if parent_fd is not None and entry_name is not None:
                    owned_fd = os.open(entry_name, flags, dir_fd=parent_fd)
                else:
                    owned_fd = os.open(directory, flags)
                directory_fd = owned_fd
                directory_stat = os.fstat(directory_fd)
                if expected_stat is not None and not _same_directory(expected_stat, directory_stat):
                    raise SnapshotError(f"Source directory changed during snapshot: {directory}")
                proc_fd_path = Path(f"/proc/self/fd/{directory_fd}")
                if proc_fd_path.exists():
                    scan_fd = os.dup(directory_fd)
                    try:
                        with os.scandir(f"/proc/self/fd/{scan_fd}") as iterator:
                            children = sorted(
                                ((item.name, item.stat(follow_symlinks=False)) for item in iterator),
                                key=lambda item: item[0],
                            )
                    finally:
                        os.close(scan_fd)
                else:
                    with os.scandir(directory) as iterator:
                        children = sorted(
                            ((item.name, item.stat(follow_symlinks=False)) for item in iterator),
                            key=lambda item: item[0],
                        )
                if not _same_directory(directory_stat, os.fstat(directory_fd)):
                    raise SnapshotError(f"Source directory changed during snapshot: {directory}")
            else:
                directory_stat = directory.lstat()
                if expected_stat is not None and not _same_directory(expected_stat, directory_stat):
                    raise SnapshotError(f"Source directory changed during snapshot: {directory}")
                with os.scandir(directory) as iterator:
                    children = sorted(
                        ((item.name, item.stat(follow_symlinks=False)) for item in iterator),
                        key=lambda item: item[0],
                    )
                if not _same_directory(directory_stat, directory.lstat()):
                    raise SnapshotError(f"Source directory changed during snapshot: {directory}")
            if not stat.S_ISDIR(directory_stat.st_mode):
                raise SnapshotError(f"Source directory changed during snapshot: {directory}")
        except OSError as exc:
            if owned_fd is not None:
                os.close(owned_fd)
                owned_fd = None
            if parent_fd is not None and entry_name is not None:
                try:
                    raced = os.stat(entry_name, dir_fd=parent_fd, follow_symlinks=False)
                    if stat.S_ISLNK(raced.st_mode):
                        skip_counts["symlink"] += 1
                        return
                except OSError:
                    pass
            raise SnapshotError(f"Cannot read source directory {directory}: {exc}") from exc
        except BaseException:
            if owned_fd is not None:
                os.close(owned_fd)
            raise
        try:
            for name, file_stat in children:
                src_path = directory / name
                rel_path = relative / name
                if stat.S_ISLNK(file_stat.st_mode):
                    skip_counts["symlink"] += 1
                    continue
                if stat.S_ISDIR(file_stat.st_mode):
                    if name.lower() in _SKIP_DIRS:
                        skip_counts["generated_directory"] += 1
                        continue
                    _record_member(budget, member_limit)
                    _mkdir_private(root_stage / rel_path, parents=True, exist_ok=True)
                    visit(src_path, rel_path, expected_stat=file_stat, parent_fd=directory_fd, entry_name=name)
                elif stat.S_ISREG(file_stat.st_mode):
                    if _is_runtime_log(rel_path, name):
                        skip_counts["generated_file"] += 1
                        continue
                    # SQLite's adjacent WAL and SHM are represented by the consistent backup.
                    base_name = name[:-4] if name.endswith(("-wal", "-shm")) else None
                    if base_name is not None and (directory / base_name).resolve() in sqlite_bases:
                        skip_counts["sqlite_sidecar"] += 1
                        continue
                    _record_member(budget, member_limit)
                    dst_path = root_stage / rel_path
                    _mkdir_private(dst_path.parent, parents=True, exist_ok=True)
                    if _sqlite_header(src_path, file_stat, directory_fd, name):
                        backed_up = False
                        for attempt in range(_COPY_ATTEMPTS):
                            before_sqlite = _source_lstat(src_path, name, directory_fd)
                            if not stat.S_ISREG(before_sqlite.st_mode):
                                raise SnapshotError(f"SQLite source changed during snapshot: {src_path}")
                            if directory_fd is not None and not _same_directory(os.fstat(directory_fd), directory.lstat()):
                                raise SnapshotError(f"SQLite source directory changed during snapshot: {directory}")
                            _sqlite_backup(src_path, dst_path, budget["expanded"], expanded_limit)
                            after_sqlite = _source_lstat(src_path, name, directory_fd)
                            parent_stable = directory_fd is None or _same_directory(os.fstat(directory_fd), directory.lstat())
                            if parent_stable and _same_sqlite_identity(before_sqlite, after_sqlite):
                                backed_up = True
                                break
                            dst_path.unlink(missing_ok=True)
                            if attempt + 1 == _COPY_ATTEMPTS:
                                raise SnapshotError(f"SQLite source changed during snapshot: {src_path}")
                        if not backed_up:
                            raise SnapshotError(f"SQLite source changed during snapshot: {src_path}")
                        sqlite_bases.add(src_path.resolve())
                        size, digest = _hash_file(dst_path)
                        if budget["expanded"] + size > expanded_limit:
                            raise SnapshotError(f"Snapshot exceeds expanded byte limit ({expanded_limit})")
                        budget["expanded"] += size
                    else:
                        result = _copy_regular_file(
                            src_path, dst_path, file_stat, budget, expanded_limit, directory_fd, name
                        )
                        if isinstance(result, str):
                            budget["members"] -= 1
                            skip_counts[result] += 1
                            continue
                        size, digest = result
                    mode = _safe_mode(file_stat.st_mode)
                    _set_mode(dst_path, mode)
                    archive_rel = (PurePosixPath(root_name) / PurePosixPath(*rel_path.parts)).as_posix()
                    entries.append({"path": archive_rel, "size": size, "sha256": digest, "mode": mode})
                else:
                    skip_counts["special_file"] += 1
        finally:
            if owned_fd is not None:
                os.close(owned_fd)

    visit(source, Path())
    return entries


def _same_directory(before: os.stat_result, after: os.stat_result) -> bool:
    if not stat.S_ISDIR(after.st_mode):
        return False
    if os.name == "nt" and (before.st_dev == 0 or before.st_ino == 0):
        return True
    return before.st_dev == after.st_dev and before.st_ino == after.st_ino


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def create_snapshot(
    data_dir: str | os.PathLike[str],
    archive_path: str | os.PathLike[str],
    *,
    max_expanded_bytes: int = MAX_EXPANDED_BYTES,
    max_archive_bytes: int = MAX_ARCHIVE_BYTES,
    max_members: int = MAX_MEMBERS,
) -> dict[str, Any]:
    """Create an atomic ZIP snapshot from data_dir and return its manifest.

    ``data_dir`` contains dsh-home and state directories, plus optional work.
    Existing archives remain intact when creation fails.
    """
    source_input = Path(data_dir).absolute()
    try:
        source_stat = source_input.lstat()
    except OSError as exc:
        raise SnapshotError(f"Snapshot source directory is unavailable: {source_input}") from exc
    if stat.S_ISLNK(source_stat.st_mode) or not stat.S_ISDIR(source_stat.st_mode):
        raise SnapshotError(f"Expected a real directory at {source_input}")
    source = source_input.resolve()
    root_stats: dict[str, os.stat_result] = {}
    for root_name in REQUIRED_ROOTS:
        root = source / root_name
        try:
            root_stat = root.lstat()
        except OSError as exc:
            raise SnapshotError(f"Required snapshot source directory is missing: {root}") from exc
        if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
            raise SnapshotError(f"Required snapshot root must be a real directory: {root}")
        root_stats[root_name] = root_stat
    work_root = source / "work"
    try:
        work_stat = work_root.lstat()
    except FileNotFoundError:
        work_stat = None
    except OSError as exc:
        raise SnapshotError(f"Cannot inspect optional work directory: {work_root}") from exc
    if work_stat is not None and (stat.S_ISLNK(work_stat.st_mode) or not stat.S_ISDIR(work_stat.st_mode)):
        raise SnapshotError(f"Optional work root must be a real directory: {work_root}")
    output = Path(archive_path).absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    if _is_within(output.resolve(), source):
        raise SnapshotError("Archive output must be outside the source data directory")
    if max_expanded_bytes < 0 or max_archive_bytes < 0 or max_members < 0:
        raise ValueError("Limits must be non-negative")

    skip_counts = {key: 0 for key in ("symlink", "special_file", "generated_directory", "generated_file", "sqlite_sidecar")}
    with _temporary_directory(output.parent, ".cnb-snapshot-") as temp_root:
        stage = temp_root / "stage"
        _mkdir_private(stage)
        budget = {"expanded": 0, "members": 0}
        for _root in REQUIRED_ROOTS:
            _record_member(budget, max_members)
        if work_stat is not None:
            _record_member(budget, max_members)
        files: list[dict[str, Any]] = []
        for root_name in REQUIRED_ROOTS:
            source_root = source / root_name
            if not _same_directory(root_stats[root_name], source_root.lstat()):
                raise SnapshotError(f"Required snapshot source directory changed: {source_root}")
            files.extend(_walk_source(source_root, root_name, stage, skip_counts, budget, max_expanded_bytes, max_members))
        if work_stat is not None:
            if not _same_directory(work_stat, work_root.lstat()):
                raise SnapshotError(f"Optional work source directory changed: {work_root}")
            files.extend(_walk_source(work_root, "work", stage, skip_counts, budget, max_expanded_bytes, max_members))
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "files": sorted(files, key=lambda item: item["path"]),
            "skipped": skip_counts,
        }
        manifest_path = stage / "manifest.json"
        manifest_bytes = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        _record_member(budget, max_members)
        if budget["expanded"] + len(manifest_bytes) > max_expanded_bytes:
            raise SnapshotError(f"Snapshot exceeds expanded byte limit ({max_expanded_bytes})")
        manifest_path.write_bytes(manifest_bytes)
        _set_mode(manifest_path, 0o600)
        modes_by_path = {item["path"]: item["mode"] for item in files}
        temp_archive = temp_root / "snapshot.zip"
        with zipfile.ZipFile(temp_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for root_name in (*REQUIRED_ROOTS, *(('work',) if work_stat is not None else ())):
                root = stage / root_name
                _write_directory(archive, f"snapshot/{root_name}/")
                for current, dirs, names in os.walk(root):
                    dirs.sort()
                    names.sort()
                    relative_dir = Path(current).relative_to(stage)
                    for name in dirs:
                        rel = (relative_dir / name).as_posix()
                        _write_directory(archive, f"snapshot/{rel}/")
                    for name in names:
                        path = Path(current) / name
                        rel = (relative_dir / name).as_posix()
                        mode = modes_by_path[rel]
                        _write_file(archive, f"snapshot/{rel}", path, mode)
            _write_file(archive, MANIFEST_NAME, manifest_path, 0o600)
            if len(archive.filelist) > max_members:
                raise SnapshotError(f"Snapshot exceeds member limit ({max_members})")
        archive_size = temp_archive.stat().st_size
        if archive_size > max_archive_bytes:
            raise SnapshotError(f"Archive exceeds byte limit ({max_archive_bytes})")
        _set_mode(temp_archive, 0o600)
        os.replace(temp_archive, output)
    return {**manifest, "archive_size": archive_size}


def _write_directory(archive: zipfile.ZipFile, name: str) -> None:
    info = zipfile.ZipInfo(name)
    info.create_system = 3
    info.external_attr = (stat.S_IFDIR | 0o700) << 16 | 0x10
    archive.writestr(info, b"")


def _write_file(archive: zipfile.ZipFile, name: str, path: Path, mode: int) -> None:
    info = zipfile.ZipInfo(name)
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (stat.S_IFREG | mode) << 16
    with path.open("rb") as stream, archive.open(info, "w") as dest:
        shutil.copyfileobj(stream, dest, CHUNK_SIZE)


def _clean_member_name(name: str) -> str:
    if not name or "\\" in name or name.startswith("/") or "\x00" in name:
        raise SnapshotError(f"Unsafe archive member path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("", ".", "..") for part in name.rstrip("/").split("/")):
        raise SnapshotError(f"Unsafe archive member path: {name!r}")
    if not name.startswith("snapshot/"):
        raise SnapshotError(f"Unknown archive root: {name!r}")
    parts = path.parts
    if len(parts) < 2 or parts[1] not in ROOTS and name != MANIFEST_NAME:
        raise SnapshotError(f"Unknown archive root: {name!r}")
    return name.rstrip("/")


def _member_kind(info: zipfile.ZipInfo) -> str:
    mode = info.external_attr >> 16
    kind = stat.S_IFMT(mode)
    if info.is_dir() or kind == stat.S_IFDIR:
        return "directory"
    if kind in (0, stat.S_IFREG):
        return "file"
    raise SnapshotError(f"Links and special files are forbidden in snapshots: {info.filename!r}")


def _read_manifest(archive: zipfile.ZipFile) -> dict[str, Any]:
    try:
        info = archive.getinfo(MANIFEST_NAME)
        if info.file_size > 16 * 1024 * 1024:
            raise SnapshotError("Snapshot manifest exceeds 16 MiB")
        raw = archive.read(info)
        value = json.loads(raw.decode("utf-8"))
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
        raise SnapshotError(f"Missing or invalid snapshot manifest: {exc}") from exc
    if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION or not isinstance(value.get("files"), list):
        raise SnapshotError("Unsupported or malformed snapshot manifest")
    return value


def validate_archive(
    archive_path: str | os.PathLike[str],
    *,
    max_expanded_bytes: int = MAX_EXPANDED_BYTES,
    max_archive_bytes: int = MAX_ARCHIVE_BYTES,
    max_members: int = MAX_MEMBERS,
) -> dict[str, Any]:
    """Validate all ZIP paths, types, limits, and manifest hashes without extraction."""
    path = Path(archive_path)
    if path.stat().st_size > max_archive_bytes:
        raise SnapshotError(f"Archive exceeds byte limit ({max_archive_bytes})")
    try:
        archive = zipfile.ZipFile(path, "r")
    except (OSError, zipfile.BadZipFile) as exc:
        raise SnapshotError(f"Cannot open snapshot archive: {exc}") from exc
    with archive:
        infos = archive.infolist()
        if len(infos) > max_members:
            raise SnapshotError(f"Snapshot exceeds member limit ({max_members})")
        entries: dict[str, tuple[zipfile.ZipInfo, str]] = {}
        total_size = 0
        for info in infos:
            clean = _clean_member_name(info.filename)
            if clean in entries:
                raise SnapshotError(f"Duplicate archive member: {clean}")
            kind = _member_kind(info)
            entries[clean] = (info, kind)
            if kind == "file":
                total_size += info.file_size
        if total_size > max_expanded_bytes:
            raise SnapshotError(f"Snapshot exceeds expanded byte limit ({max_expanded_bytes})")
        files_count = sum(kind == "file" and name != MANIFEST_NAME for name, (_, kind) in entries.items())
        if files_count > max_members:
            raise SnapshotError(f"Snapshot exceeds member limit ({max_members})")
        if MANIFEST_NAME not in entries or entries[MANIFEST_NAME][1] != "file":
            raise SnapshotError("Snapshot manifest is missing")
        _check_prefix_conflicts(entries)
        roots_seen = {name.split("/")[1] for name in entries if name != MANIFEST_NAME}
        if not set(REQUIRED_ROOTS).issubset(roots_seen) or not roots_seen.issubset(ROOTS):
            raise SnapshotError("Snapshot must contain dsh-home and state roots, with optional work")
        manifest = _read_manifest(archive)
        declared: dict[str, dict[str, Any]] = {}
        for item in manifest["files"]:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                raise SnapshotError("Malformed file entry in manifest")
            name = _clean_member_name("snapshot/" + item["path"])
            if name == MANIFEST_NAME or name in declared:
                raise SnapshotError(f"Duplicate or invalid manifest path: {name}")
            size, digest, mode = item.get("size"), item.get("sha256"), item.get("mode")
            if not isinstance(size, int) or size < 0 or not isinstance(digest, str) or len(digest) != 64 or mode not in (0o600, 0o700):
                raise SnapshotError(f"Malformed manifest file metadata: {name}")
            declared[name] = item
        actual_files = {name for name, (_, kind) in entries.items() if kind == "file" and name != MANIFEST_NAME}
        if actual_files != set(declared):
            raise SnapshotError("Archive files do not match the manifest")
        for name, item in declared.items():
            info, _ = entries[name]
            if info.file_size != item["size"]:
                raise SnapshotError(f"Size mismatch for {name}")
            digest = hashlib.sha256()
            with archive.open(info, "r") as stream:
                while block := stream.read(CHUNK_SIZE):
                    digest.update(block)
            if digest.hexdigest() != item["sha256"]:
                raise SnapshotError(f"SHA-256 mismatch for {name}")
    return manifest


def _check_prefix_conflicts(entries: dict[str, tuple[zipfile.ZipInfo, str]]) -> None:
    files = {name for name, (_, kind) in entries.items() if kind == "file"}
    for name in entries:
        parts = name.split("/")
        for index in range(1, len(parts)):
            prefix = "/".join(parts[:index])
            if prefix in files:
                raise SnapshotError(f"File conflicts with member path: {prefix} and {name}")


def restore_snapshot(
    archive_path: str | os.PathLike[str],
    data_dir: str | os.PathLike[str],
    *,
    max_expanded_bytes: int = MAX_EXPANDED_BYTES,
    max_archive_bytes: int = MAX_ARCHIVE_BYTES,
    max_members: int = MAX_MEMBERS,
) -> dict[str, Any]:
    """Restore a validated snapshot into an absent or empty data_dir atomically."""
    archive_path = Path(archive_path)
    destination = Path(data_dir).absolute()
    if destination.is_symlink():
        raise SnapshotError(f"Restore destination is a symlink: {destination}")
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise SnapshotError(f"Restore destination must be absent or empty: {destination}")
    manifest = validate_archive(
        archive_path,
        max_expanded_bytes=max_expanded_bytes,
        max_archive_bytes=max_archive_bytes,
        max_members=max_members,
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = _new_private_dir(destination.parent, ".cnb-restore-")
    try:
        for root in REQUIRED_ROOTS:
            _mkdir_private(stage / root)
        with zipfile.ZipFile(archive_path, "r") as archive:
            has_work = any(name.rstrip("/") == "snapshot/work" or name.startswith("snapshot/work/") for name in archive.namelist())
        if has_work:
            _mkdir_private(stage / "work")
        with zipfile.ZipFile(archive_path, "r") as archive:
            by_name = {info.filename.rstrip("/"): info for info in archive.infolist()}
            for item in manifest["files"]:
                name = item["path"]
                target = stage.joinpath(*PurePosixPath(name).parts)
                _mkdir_private(target.parent, parents=True, exist_ok=True)
                digest = hashlib.sha256()
                size = 0
                with archive.open(by_name["snapshot/" + name], "r") as source, target.open("xb") as dest:
                    while block := source.read(CHUNK_SIZE):
                        size += len(block)
                        if size > item["size"] or size > max_expanded_bytes:
                            raise SnapshotError(f"Size changed while restoring {name}")
                        digest.update(block)
                        dest.write(block)
                if size != item["size"] or digest.hexdigest() != item["sha256"]:
                    raise SnapshotError(f"Integrity check failed while restoring {name}")
                _set_mode(target, item["mode"])
        if destination.exists():
            destination.rmdir()
        os.replace(stage, destination)
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return manifest


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage private bounded Superagent snapshots")
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create", help="create a snapshot archive")
    create.add_argument("data_dir")
    create.add_argument("archive")
    validate = sub.add_parser("validate", help="validate a snapshot archive")
    validate.add_argument("archive")
    restore = sub.add_parser("restore", help="restore a snapshot archive")
    restore.add_argument("archive")
    restore.add_argument("data_dir")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "create":
        result = create_snapshot(args.data_dir, args.archive)
    elif args.command == "validate":
        result = validate_archive(args.archive)
    else:
        result = restore_snapshot(args.archive, args.data_dir)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
