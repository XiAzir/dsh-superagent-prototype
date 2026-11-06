import hashlib
import json
import os
import sys
import shutil
import sqlite3
import stat
import unittest
import warnings
import zipfile
from pathlib import Path

from deploy.cnb.archive import SnapshotError, create_snapshot, restore_snapshot, validate_archive


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.test_root = Path(__file__).resolve().parents[3] / "tmp" / "cnb-snapshot-tests"
        self.test_root.mkdir(parents=True, exist_ok=True)
        self.base = self.test_root / f"case-{os.getpid()}-{id(self)}"
        self.base.mkdir()
        self.data = self.base / "data"
        (self.data / "dsh-home").mkdir(parents=True)
        (self.data / "state").mkdir()
        self.archive = self.base / "snapshot.zip"

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def make_snapshot(self):
        return create_snapshot(self.data, self.archive)

    def _rewrite(self, members):
        with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, value in members:
                if isinstance(value, zipfile.ZipInfo):
                    archive.writestr(value, b"link")
                else:
                    archive.writestr(name, value)

    def _members(self):
        with zipfile.ZipFile(self.archive) as archive:
            return [(info.filename, archive.read(info)) for info in archive.infolist()]

    def test_sqlite_wal_backup_is_consistent(self):
        db = self.data / "state" / "session.sqlite"
        connection = sqlite3.connect(db)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute("CREATE TABLE sessions (value TEXT)")
        connection.execute("INSERT INTO sessions VALUES ('wal-value')")
        connection.commit()
        self.assertTrue(Path(str(db) + "-wal").exists())
        connection.close()

        result = self.make_snapshot()
        restored = self.base / "restored"
        restore_snapshot(self.archive, restored)
        copy = sqlite3.connect(restored / "state" / "session.sqlite")
        try:
            self.assertEqual(copy.execute("SELECT value FROM sessions").fetchone(), ("wal-value",))
        finally:
            copy.close()
        self.assertEqual(result["skipped"]["sqlite_sidecar"], 0)

    def test_private_modes_dependency_directories_runtime_logs_and_lockfiles(self):
        home = self.data / "dsh-home"
        (home / "operator.yaml").write_text("secret: retained\n", encoding="utf-8")
        (home / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        os.chmod(home / "run.sh", 0o755)
        (home / "pnpm-lock.yaml").write_text("pnpm lock", encoding="utf-8")
        (home / "package-lock.json").write_text("package lock", encoding="utf-8")
        (home / "Cargo.lock").write_text("cargo lock", encoding="utf-8")
        (home / "poetry.lock").write_text("poetry lock", encoding="utf-8")
        (home / "node_modules").mkdir()
        (home / "node_modules" / "large.js").write_text("generated")
        (home / "logs").mkdir()
        (home / "logs" / "service.log").write_text("business log")
        artifacts = self.data / "work" / ".artifacts"
        artifacts.mkdir(parents=True)
        (artifacts / "dsh-superagent-superagent-20261102-123456-12.log").write_text("runtime log")
        try:
            (home / "linked").symlink_to(home / "operator.yaml")
        except (OSError, NotImplementedError):
            pass

        self.make_snapshot()
        manifest = validate_archive(self.archive)
        paths = {entry["path"] for entry in manifest["files"]}
        self.assertIn("dsh-home/operator.yaml", paths)
        self.assertIn("dsh-home/run.sh", paths)
        for preserved in ("dsh-home/pnpm-lock.yaml", "dsh-home/package-lock.json", "dsh-home/Cargo.lock", "dsh-home/poetry.lock", "dsh-home/logs/service.log"):
            self.assertIn(preserved, paths)
        self.assertNotIn("work/.artifacts/dsh-superagent-superagent-20261102-123456-12.log", paths)
        self.assertFalse(any("node_modules" in path for path in paths))
        restored = self.base / "restored"
        restore_snapshot(self.archive, restored)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE((restored / "dsh-home" / "operator.yaml").stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((restored / "dsh-home" / "run.sh").stat().st_mode), 0o700)

    def test_home_config_and_browser_profile_are_saved_but_rebuildable_caches_are_skipped(self):
        home = self.data / "home"
        (home / ".config" / "agent-tool").mkdir(parents=True)
        (home / ".config" / "agent-tool" / "settings.json").write_text('{"theme":"dark"}', encoding="utf-8")
        (home / ".config" / "chromium" / "Default").mkdir(parents=True)
        (home / ".config" / "chromium" / "Default" / "Preferences").write_text('{"profile":"kept"}', encoding="utf-8")
        (home / ".cache" / "browser").mkdir(parents=True)
        (home / ".cache" / "browser" / "rebuildable.bin").write_bytes(b"cache")
        (home / ".local" / "share" / "pnpm").mkdir(parents=True)
        (home / ".local" / "share" / "pnpm" / "store.bin").write_bytes(b"store")
        (home / "node_modules" / ".pnpm-store").mkdir(parents=True)
        (home / "node_modules" / ".pnpm-store" / "generated").write_text("generated", encoding="utf-8")
        (self.data / "work" / "cache").mkdir(parents=True)
        (self.data / "work" / "cache" / "business-state.json").write_text('{"cursor":4}', encoding="utf-8")
        (self.data / "work" / "caches").mkdir()
        (self.data / "work" / "caches" / "index.json").write_text("index", encoding="utf-8")
        (self.data / "work" / ".cache").mkdir()
        (self.data / "work" / ".cache" / "project-state").write_text("keep", encoding="utf-8")

        self.make_snapshot()
        paths = {entry["path"] for entry in validate_archive(self.archive)["files"]}
        for kept in (
            "home/.config/agent-tool/settings.json",
            "home/.config/chromium/Default/Preferences",
            "work/cache/business-state.json",
            "work/caches/index.json",
            "work/.cache/project-state",
        ):
            self.assertIn(kept, paths)
        self.assertFalse(any(path.startswith("home/.cache/") for path in paths))
        self.assertFalse(any(path.startswith("home/.local/share/pnpm/") for path in paths))
        self.assertFalse(any("node_modules" in path or ".pnpm-store" in path for path in paths))

        restored = self.base / "restored-home"
        restore_snapshot(self.archive, restored)
        self.assertEqual((restored / "home" / ".config" / "agent-tool" / "settings.json").read_text(encoding="utf-8"), '{"theme":"dark"}')
        self.assertEqual((restored / "work" / "cache" / "business-state.json").read_text(encoding="utf-8"), '{"cursor":4}')
        self.assertFalse((restored / "home" / ".cache").exists())

    def test_legacy_archive_without_home_root_still_restores(self):
        (self.data / "state" / "value.json").write_text('{"legacy":true}', encoding="utf-8")
        self.make_snapshot()

        restored = self.base / "restored-legacy"
        restore_snapshot(self.archive, restored)
        self.assertEqual((restored / "state" / "value.json").read_text(encoding="utf-8"), '{"legacy":true}')
        self.assertFalse((restored / "home").exists())

    def test_napcat_root_preserves_complete_runtime_tree(self):
        napcat = self.data / "napcat"
        for relative in (
            "qq/config",
            "plugins/state",
            "app",
            "identity",
            "cache",
            "node_modules/example",
        ):
            (napcat / relative).mkdir(parents=True, exist_ok=True)
            (napcat / relative / "value.bin").write_bytes(relative.encode("utf-8"))

        self.make_snapshot()
        paths = {entry["path"] for entry in validate_archive(self.archive)["files"]}
        for relative in (
            "qq/config/value.bin",
            "plugins/state/value.bin",
            "app/value.bin",
            "identity/value.bin",
            "cache/value.bin",
            "node_modules/example/value.bin",
        ):
            self.assertIn(f"napcat/{relative}", paths)

        restored = self.base / "restored-napcat"
        restore_snapshot(self.archive, restored)
        self.assertEqual((restored / "napcat" / "qq" / "config" / "value.bin").read_bytes(), b"qq/config")
        self.assertEqual((restored / "napcat" / "node_modules" / "example" / "value.bin").read_bytes(), b"node_modules/example")

    def test_legacy_archive_without_napcat_root_still_restores(self):
        (self.data / "state" / "legacy.json").write_text('{"legacy":true}', encoding="utf-8")
        self.make_snapshot()

        restored = self.base / "restored-without-napcat"
        restore_snapshot(self.archive, restored)
        self.assertEqual((restored / "state" / "legacy.json").read_text(encoding="utf-8"), '{"legacy":true}')
        self.assertFalse((restored / "napcat").exists())

    def test_snowluma_login_configuration_identity_and_cache_roundtrip(self):
        root = self.data / "snowluma"
        values = {
            "deployment.json": '{"enabled":true}',
            "data/config/onebot.json": '{"websocketServers":[]}',
            ".config/QQ/login/session.bin": "saved-login-ticket",
            ".local/share/QQ/cache/native-state.bin": "client-state",
            "identity/machine-id": "stable-device-id",
            "data/node_modules/plugin/state.bin": "plugin-state",
        }
        for relative, value in values.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value, encoding="utf-8")
        self.make_snapshot()
        paths = {entry["path"] for entry in validate_archive(self.archive)["files"]}
        restored = self.base / "restored-snowluma"
        restore_snapshot(self.archive, restored)
        for relative, value in values.items():
            with self.subTest(relative=relative):
                self.assertIn(f"snowluma/{relative}", paths)
                self.assertEqual((restored / "snowluma" / relative).read_text(encoding="utf-8"), value)

    def test_snowluma_exclusive_chromium_cache_does_not_block_login_state_backup(self):
        partition = self.data / 'snowluma' / '.config' / 'QQ' / 'Partitions' / 'qqnt_9210'
        partition.mkdir(parents=True)
        cache = partition / 'SharedStorage'
        connection = sqlite3.connect(cache)
        profile_cache = self.data / 'snowluma' / '.config' / 'QQ' / 'SharedStorage'
        profile_connection = sqlite3.connect(profile_cache)
        browser_cache = partition.parent / 'qq-browser-12345' / 'DIPS'
        browser_cache.parent.mkdir()
        browser_connection = sqlite3.connect(browser_cache)
        try:
            browser_connection.execute('PRAGMA locking_mode=EXCLUSIVE')
            browser_connection.execute('CREATE TABLE cache (value TEXT)')
            browser_connection.commit()
            (browser_cache.parent / 'DIPS-wal').write_bytes(b'rebuildable')
            profile_connection.execute('PRAGMA locking_mode=EXCLUSIVE')
            profile_connection.execute('CREATE TABLE cache (value TEXT)')
            profile_connection.commit()
            connection.execute('PRAGMA locking_mode=EXCLUSIVE')
            connection.execute('CREATE TABLE cache (value TEXT)')
            connection.commit()
            (partition / 'SharedStorage-journal').write_bytes(b'rebuildable')
            login = partition / 'login-state.json'
            login.write_text('{"session":"preserved"}', encoding='utf-8')
            # The same filename outside this exact Chromium cache is retained.
            business = self.data / 'snowluma' / 'data' / 'SharedStorage'
            business.parent.mkdir()
            business.write_bytes(b'business state')
            snapshot = self.make_snapshot()
        finally:
            connection.close()
            profile_connection.close()
            browser_connection.close()
        paths = {item['path'] for item in snapshot['files']}
        self.assertNotIn('snowluma/.config/QQ/Partitions/qqnt_9210/SharedStorage', paths)
        self.assertNotIn('snowluma/.config/QQ/Partitions/qqnt_9210/SharedStorage-journal', paths)
        self.assertNotIn('snowluma/.config/QQ/SharedStorage', paths)
        self.assertNotIn('snowluma/.config/QQ/Partitions/qq-browser-12345/DIPS', paths)
        self.assertNotIn('snowluma/.config/QQ/Partitions/qq-browser-12345/DIPS-wal', paths)
        restored = self.base / 'restored-exclusive'
        restore_snapshot(self.archive, restored)
        self.assertEqual((restored / login.relative_to(self.data)).read_text(), '{"session":"preserved"}')
        self.assertEqual((restored / business.relative_to(self.data)).read_bytes(), b'business state')
        self.assertTrue(cache.exists())

    def test_snowluma_remains_optional_for_existing_snapshots(self):
        self.make_snapshot()
        restored = self.base / "restored-without-snowluma"
        restore_snapshot(self.archive, restored)
        self.assertTrue((restored / "state").is_dir())
        self.assertFalse((restored / "snowluma").exists())

    def test_tampered_hash_rejected(self):
        (self.data / "state" / "value.json").write_text('{"ok":true}', encoding="utf-8")
        self.make_snapshot()
        members = self._members()
        changed = []
        for name, data in members:
            if name == "snapshot/state/value.json":
                data = b'{"ok":xxxx}'
            changed.append((name, data))
        self._rewrite(changed)
        with self.assertRaisesRegex(SnapshotError, "SHA-256"):
            validate_archive(self.archive)

    def test_path_traversal_rejected(self):
        payload = b"evil"
        manifest = {"schema_version": 1, "files": [{"path": "../escape", "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest(), "mode": 0o600}]}
        self._rewrite([
            ("snapshot/dsh-home/", b""),
            ("snapshot/state/", b""),
            ("snapshot/../escape", payload),
            ("snapshot/manifest.json", json.dumps(manifest).encode()),
        ])
        with self.assertRaises(SnapshotError):
            validate_archive(self.archive)

    def test_link_member_rejected(self):
        self._rewrite([
            ("snapshot/dsh-home/", b""),
            ("snapshot/state/", b""),
            ("snapshot/manifest.json", b'{"schema_version":1,"files":[]}'),
        ])
        link = zipfile.ZipInfo("snapshot/state/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(self.archive, "a") as archive:
            archive.writestr(link, b"target")
        with self.assertRaisesRegex(SnapshotError, "Links and special"):
            validate_archive(self.archive)

    def test_duplicate_member_rejected(self):
        (self.data / "state" / "value").write_text("x")
        self.make_snapshot()
        with zipfile.ZipFile(self.archive) as source:
            manifest = source.read("snapshot/manifest.json")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with zipfile.ZipFile(self.archive, "w") as archive:
                archive.writestr("snapshot/dsh-home/", b"")
                archive.writestr("snapshot/state/", b"")
                archive.writestr("snapshot/state/value", b"x")
                archive.writestr("snapshot/state/value", b"x")
                archive.writestr("snapshot/manifest.json", manifest)
        with self.assertRaisesRegex(SnapshotError, "Duplicate"):
            validate_archive(self.archive)

    def test_size_bound_enforced(self):
        (self.data / "state" / "value").write_bytes(b"123456789")
        with self.assertRaisesRegex(SnapshotError, "expanded byte limit"):
            create_snapshot(self.data, self.archive, max_expanded_bytes=4)
        self.assertFalse(self.archive.exists())
        self.make_snapshot()
        with self.assertRaisesRegex(SnapshotError, "expanded byte limit"):
            validate_archive(self.archive, max_expanded_bytes=4)

    def test_repeated_payload_is_deflated(self):
        payload = b"repeatable-data-" * 65_536
        (self.data / "state" / "repetitive.bin").write_bytes(payload)
        result = self.make_snapshot()
        self.assertLess(result["archive_size"], len(payload) // 10)

    @unittest.skipUnless(sys.platform.startswith("linux") and Path("/proc/self/fd").exists(), "Linux /proc fd accounting")
    def test_repeated_snapshots_do_not_leak_file_descriptors(self):
        (self.data / "state" / "value").write_text("stable")
        fd_root = Path("/proc/self/fd")
        before = len(list(fd_root.iterdir()))
        for _ in range(20):
            self.make_snapshot()
        after = len(list(fd_root.iterdir()))
        self.assertEqual(after, before)

    def test_missing_required_roots_rejected(self):
        (self.data / "state").rmdir()
        with self.assertRaisesRegex(SnapshotError, "Required snapshot source directory is missing"):
            self.make_snapshot()
        self.assertFalse(self.archive.exists())

    def test_member_bound_counts_directories_and_manifest(self):
        (self.data / "state" / "nested").mkdir()
        (self.data / "state" / "nested" / "value").write_text("x")
        with self.assertRaisesRegex(SnapshotError, "member limit"):
            create_snapshot(self.data, self.archive, max_members=3)
        self.assertFalse(self.archive.exists())

    def test_restore_refuses_nonempty_destination_without_changes(self):
        (self.data / "state" / "value").write_text("from archive")
        self.make_snapshot()
        destination = self.base / "destination"
        destination.mkdir()
        sentinel = destination / "keep.txt"
        sentinel.write_text("keep")
        with self.assertRaisesRegex(SnapshotError, "must be absent or empty"):
            restore_snapshot(self.archive, destination)
        self.assertEqual(sentinel.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
