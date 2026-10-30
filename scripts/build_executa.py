#!/usr/bin/env python3
# Copyright (c) 2026 Yash
# SPDX-License-Identifier: MIT
"""Build a self-contained Executa binary with its manifest and game data."""

from pathlib import Path
import os

from PyInstaller.__main__ import run

ROOT = Path(__file__).resolve().parents[1]
EXECUTA = ROOT / "executas" / "dnd-game-master"
ENTRY = EXECUTA / "dnd_game_master.py"
MANIFEST = EXECUTA / "manifest.json"
DATA = EXECUTA / "data"
BUILD = ROOT / "build" / "pyinstaller"
DIST = ROOT / "build" / "dist"

if not ENTRY.is_file() or not MANIFEST.is_file() or not DATA.is_dir():
    raise SystemExit("Executa source, manifest, or bundled game data is missing.")

run([
    "--noconfirm",
    "--clean",
    "--onefile",
    "--name", "dnd-game-master",
    "--distpath", str(DIST),
    "--workpath", str(BUILD / "work"),
    "--specpath", str(BUILD),
    "--add-data", f"{MANIFEST}{os.pathsep}.",
    "--add-data", f"{DATA}{os.pathsep}data",
    str(ENTRY),
])
