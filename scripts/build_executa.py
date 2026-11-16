#!/usr/bin/env python3
# Copyright (c) 2026 Yash
# SPDX-License-Identifier: MIT
"""Build the Executa as a PyInstaller one-folder app with its manifest and game data.

One-folder (not one-file) so a cold start does not re-extract the bundled data
on every spawn: Anna expects `describe` to answer within a few seconds. The
Open5e reference files are pruned to the fields the Executa reads, and files
it never opens are left out.
"""

from pathlib import Path
import json
import os
import shutil
import sys

from PyInstaller.__main__ import run

ROOT = Path(__file__).resolve().parents[1]
EXECUTA = ROOT / "executas" / "dnd-game-master"
ENTRY = EXECUTA / "dnd_game_master.py"
MANIFEST = EXECUTA / "manifest.json"
DATA = EXECUTA / "data"
BUILD = ROOT / "build" / "pyinstaller"
DIST = ROOT / "build" / "dist"
STAGED_DATA = BUILD / "data"

sys.path.insert(0, str(EXECUTA))
from dnd_game_master_core.data import _CLASS_PROFILE_FIELDS, _RESOURCE_FIELDS  # noqa: E402

# Archetypes only need what get_class_profiles returns.
_ARCHETYPE_FIELDS = ("name", "slug", "desc")


def prune_open5e(source: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for resource_type, fields in _RESOURCE_FIELDS.items():
        keep = set(fields) | {"slug"}
        if resource_type == "classes":
            keep |= set(_CLASS_PROFILE_FIELDS)
        items = json.loads((source / f"{resource_type}.json").read_text(encoding="utf-8"))
        pruned = []
        for item in items:
            row = {key: value for key, value in item.items() if key in keep}
            if resource_type == "classes" and isinstance(row.get("archetypes"), list):
                row["archetypes"] = [
                    {key: archetype.get(key, "") for key in _ARCHETYPE_FIELDS}
                    for archetype in row["archetypes"] if isinstance(archetype, dict)
                ]
            pruned.append(row)
        (target / f"{resource_type}.json").write_text(
            json.dumps(pruned, ensure_ascii=False, separators=(",", ":")), encoding="utf-8",
        )


def stage_data() -> Path:
    shutil.rmtree(STAGED_DATA, ignore_errors=True)
    shutil.copytree(DATA, STAGED_DATA, ignore=shutil.ignore_patterns("open5e"))
    prune_open5e(DATA / "open5e", STAGED_DATA / "open5e")
    before = sum(path.stat().st_size for path in DATA.rglob("*") if path.is_file())
    after = sum(path.stat().st_size for path in STAGED_DATA.rglob("*") if path.is_file())
    print(f"Staged game data: {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB")
    return STAGED_DATA


if not ENTRY.is_file() or not MANIFEST.is_file() or not DATA.is_dir():
    raise SystemExit("Executa source, manifest, or bundled game data is missing.")

if __name__ == "__main__":
    data = stage_data()
    run([
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name", "dnd-game-master",
        "--distpath", str(DIST),
        "--workpath", str(BUILD / "work"),
        "--specpath", str(BUILD),
        "--add-data", f"{MANIFEST}{os.pathsep}.",
        "--add-data", f"{data}{os.pathsep}data",
        str(ENTRY),
    ])
