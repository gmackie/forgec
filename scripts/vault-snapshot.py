#!/usr/bin/env python3
"""Private, verified filesystem copy for a migration rehearsal; not writer fencing."""

import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import time


def inventory(source, max_bytes=2 * 1024**3, max_entries=100000):
    """Inventory bytes, modes and link text, never symlink targets or file contents in output."""
    source = Path(source)
    entries = []
    total = 0

    def visit(directory):
        nonlocal total
        for path in sorted(directory.iterdir()):
            info = path.lstat()
            mode = stat.S_IMODE(info.st_mode)
            row = {"path": path.relative_to(source).as_posix(), "mode": mode}
            if len(entries) >= max_entries:
                raise ValueError("Snapshot entry budget exceeded")
            if stat.S_ISLNK(info.st_mode):
                row.update(type="symlink", target=os.readlink(path))
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                if total > max_bytes:
                    raise ValueError("Snapshot byte budget exceeded")
                digest = hashlib.sha256()
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, "rb") as stream:
                    opened = os.fstat(stream.fileno())
                    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                        raise RuntimeError("Source changed during inventory")
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                    after = os.fstat(stream.fileno())
                    if (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (
                        info.st_size,
                        info.st_mtime_ns,
                        info.st_ctime_ns,
                    ):
                        raise RuntimeError("Source changed during inventory")
                row.update(type="file", size=info.st_size, sha256=digest.hexdigest())
            elif stat.S_ISDIR(info.st_mode):
                row.update(type="directory")
            else:
                raise ValueError("Special file requires separate preservation")
            entries.append(row)
            if row["type"] == "directory":
                visit(path)

    visit(source)
    return entries


def preserve(source, destination, max_bytes=2 * 1024**3):
    source = Path(source).resolve(strict=True)
    destination = Path(destination).absolute()
    parent = destination.parent.resolve(strict=True)
    destination = parent / destination.name
    if source == destination or source in destination.parents:
        raise ValueError("Snapshot destination must be outside the source")
    # Never reuse or overwrite another snapshot. Parent is operator-controlled.
    destination.mkdir(mode=0o700)
    before = inventory(source, max_bytes)
    required_bytes = sum(e.get("size", 0) for e in before)
    # Account for a full copy and leave bounded filesystem/manifest headroom.
    if shutil.disk_usage(parent).free < required_bytes + max(
        64 * 1024**2, len(before) * 8192
    ):
        raise OSError(errno.ENOSPC, "Insufficient space for private preservation")
    shutil.copytree(source, destination / "tree", symlinks=True)
    copied = inventory(destination / "tree", max_bytes)
    after = inventory(source, max_bytes)
    if before != after or before != copied:
        raise RuntimeError("Source or copied tree changed; unverified copy retained")
    manifest = {
        "version": "forge-vault-snapshot/1",
        "status": "verified-copy",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scope": "All regular files, directories, modes and symlink text, including ignored files and .git; excludes xattrs/ACLs/hardlink topology. Not a fenced backup or proof against concurrent ABA writes.",
        "entries": copied,
        "bytes": sum(e.get("size", 0) for e in copied),
    }
    fd = os.open(
        destination / "manifest.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
    )
    with os.fdopen(fd, "w") as out:
        json.dump(manifest, out, indent=2)
        out.write("\n")
    return {k: v for k, v in manifest.items() if k != "entries"} | {
        "entryCount": len(copied)
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("--max-bytes", type=int, default=2 * 1024**3)
    args = parser.parse_args()
    try:
        result = preserve(args.source, args.destination, args.max_bytes)
    except Exception as error:
        # OS errors can contain private file names; don't print exception text.
        raise SystemExit(
            "Snapshot failed: "
            + type(error).__name__
            + "; any partial copy is unverified"
        ) from None
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
