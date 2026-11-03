#!/usr/bin/env python3
# Copyright (c) 2026 Yash
# SPDX-License-Identifier: MIT
"""Package a PyInstaller executable in Anna's platform-specific archive."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXECUTA = ROOT / "executas" / "dnd-game-master"


def read_tool_manifest() -> dict:
    with (EXECUTA / "manifest.json").open(encoding="utf-8") as handle:
        return json.load(handle)


def archive_manifest(name: str, version: str, entrypoint: str) -> bytes:
    """Root manifest.json the Anna Agent reads to locate the entrypoint."""
    manifest = {
        "name": name,
        "version": version,
        "runtime": {"binary": {
            "entrypoint": entrypoint,
            "permissions": {entrypoint: "0o755"},
        }},
    }
    return (json.dumps(manifest, indent=2) + "\n").encode("utf-8")


def package(platform: str) -> Path:
    windows = platform == "windows-x86_64"
    executable = "dnd-game-master.exe" if windows else "dnd-game-master"
    built = ROOT / "build" / "dist" / executable
    if not built.is_file():
        raise SystemExit(f"Built executable not found: {built}")
    if not windows:
        built.chmod(built.stat().st_mode | 0o111)

    tool = read_tool_manifest()
    version = str(tool["version"])
    entrypoint = f"bin/{executable}"
    manifest = archive_manifest(str(tool["name"]), version, entrypoint)
    suffix = "zip" if windows else "tar.gz"
    output = EXECUTA / "dist" / f"dnd-game-master-v{version}-{platform}.{suffix}"
    output.parent.mkdir(parents=True, exist_ok=True)
    if windows:
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", manifest)
            archive.write(built, arcname=entrypoint)
    else:
        with tarfile.open(output, "w:gz") as archive:
            info = tarfile.TarInfo("manifest.json")
            info.size, info.mode = len(manifest), 0o644
            archive.addfile(info, io.BytesIO(manifest))
            folder = tarfile.TarInfo("bin")
            folder.type, folder.mode = tarfile.DIRTYPE, 0o755
            archive.addfile(folder)
            archive.add(built, arcname=entrypoint)

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + ".sha256").write_text(
        f"{digest}  {output.name}\n", encoding="utf-8"
    )
    print(f"Packaged {output.relative_to(ROOT)}")
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--platform",
        required=True,
        choices=("linux-x86_64", "darwin-arm64", "darwin-x86_64", "windows-x86_64"),
    )
    args = parser.parse_args()
    package(args.platform)


if __name__ == "__main__":
    main()
