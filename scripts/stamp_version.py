# Copyright (c) 2026 Yash
# SPDX-License-Identifier: MIT
"""Copy the app version from app.json into every file that repeats it.

app.json is the single source of truth. The Executa reads its own version from
its manifest at runtime, so after this script nothing else needs editing.

    python scripts/stamp_version.py            # stamp
    python scripts/stamp_version.py --check    # fail if any file disagrees (CI)
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXECUTA = ROOT / "executas" / "dnd-game-master"


def _json_edit(path: Path, change) -> tuple[str, str]:
    before = path.read_text(encoding="utf-8")
    data = json.loads(before)
    change(data)
    return before, json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def plan(version: str) -> dict[Path, tuple[str, str]]:
    edits: dict[Path, tuple[str, str]] = {}

    def set_version(data):
        data["version"] = version

    def set_min_version(data):
        for item in data.get("required_executas", []):
            if item.get("tool_id") == "bundled:dnd-game-master":
                item["min_version"] = version

    edits[EXECUTA / "manifest.json"] = _json_edit(EXECUTA / "manifest.json", set_version)
    edits[EXECUTA / "executa.json"] = _json_edit(EXECUTA / "executa.json", set_version)
    edits[ROOT / "manifest.json"] = _json_edit(ROOT / "manifest.json", set_min_version)
    pyproject = EXECUTA / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")
    edits[pyproject] = (text, re.sub(r'(?m)^version = "[^"]*"', f'version = "{version}"', text, count=1))
    return edits


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="report drift instead of writing")
    args = parser.parse_args()
    version = json.loads((ROOT / "app.json").read_text(encoding="utf-8"))["version"]
    drift = []
    for path, (before, after) in plan(version).items():
        if before == after:
            continue
        drift.append(path.relative_to(ROOT))
        if not args.check:
            path.write_text(after, encoding="utf-8")
    if args.check and drift:
        raise SystemExit(f"Version drift from app.json {version}: " + ", ".join(map(str, drift)))
    print(f"{'Checked' if args.check else 'Stamped'} version {version}" + (f" ({len(drift)} files updated)" if drift and not args.check else ""))


if __name__ == "__main__":
    main()
