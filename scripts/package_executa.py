#!/usr/bin/env python3
# Copyright (c) 2026 Yash
# SPDX-License-Identifier: MIT
"""Package a PyInstaller executable in Anna's platform-specific archive."""

import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXECUTA = ROOT / "executas" / "dnd-game-master"


def read_version() -> str:
    with (ROOT / "app.json").open(encoding="utf-8") as handle:
        return str(json.load(handle)["version"])


def package(platform: str) -> Path:
    windows = platform == "windows-x86_64"
    executable = "dnd-game-master.exe" if windows else "dnd-game-master"
    built = ROOT / "build" / "dist" / executable
    if not built.is_file():
        raise SystemExit(f"Built executable not found: {built}")
    if not windows:
        built.chmod(built.stat().st_mode | 0o111)

    version = read_version()
    suffix = "zip" if windows else "tar.gz"
    output = EXECUTA / "dist" / f"dnd-game-master-{version}-{platform}.{suffix}"
    output.parent.mkdir(parents=True, exist_ok=True)
    if windows:
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(built, arcname=executable)
    else:
        with tarfile.open(output, "w:gz") as archive:
            archive.add(built, arcname=executable)

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
