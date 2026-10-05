import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "vault_snapshot", Path(__file__).with_name("vault-snapshot.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SnapshotTests(unittest.TestCase):
    def test_preserves_ignored_files_modes_and_symlinks_without_following(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = root / "source"
            source.mkdir()
            (source / ".git").mkdir()
            (source / ".git/config").write_text("private config")
            (source / ".gitignore").write_text("draft\n")
            (source / "draft").write_bytes(bytes([0, 128, 255]))
            (source / "draft").chmod(0o755)
            (source / "link").symlink_to("../absent")
            result = module.preserve(source, root / "snapshot")
            self.assertEqual(result["status"], "verified-copy")
            self.assertEqual(
                module.inventory(source), module.inventory(root / "snapshot/tree")
            )
            self.assertEqual((root / "snapshot").stat().st_mode & 0o777, 0o700)
            self.assertEqual(
                (root / "snapshot/tree/link").readlink(), Path("../absent")
            )

    def test_refuses_destination_inside_source_or_existing_destination(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / "source"
            source.mkdir()
            with self.assertRaises(ValueError):
                module.preserve(source, source / "snapshot")
            target = Path(d) / "existing"
            target.mkdir()
            with self.assertRaises(FileExistsError):
                module.preserve(source, target)

    def test_changed_source_has_no_verified_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / "source"
            source.mkdir()
            (source / "draft").write_text("before")
            original = module.shutil.copytree

            def changing(*args, **kwargs):
                value = original(*args, **kwargs)
                (source / "draft").write_text("after")
                return value

            with patch.object(module.shutil, "copytree", side_effect=changing):
                with self.assertRaises(RuntimeError):
                    module.preserve(source, Path(d) / "snapshot")
            self.assertFalse((Path(d) / "snapshot/manifest.json").exists())

    def test_insufficient_space_refused_before_copy(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / "source"
            source.mkdir()
            (source / "draft").write_text("preserve me")
            with (
                patch.object(module.shutil, "disk_usage") as usage,
                patch.object(module.shutil, "copytree") as copy,
            ):
                usage.return_value.free = 1
                with self.assertRaises(OSError):
                    module.preserve(source, Path(d) / "snapshot")
                copy.assert_not_called()
            self.assertFalse((Path(d) / "snapshot/manifest.json").exists())

    def test_refuses_special_files(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / "source"
            source.mkdir()
            os.mkfifo(source / "pipe")
            with self.assertRaises(ValueError):
                module.preserve(source, Path(d) / "snapshot")


if __name__ == "__main__":
    unittest.main()
