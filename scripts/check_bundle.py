# Copyright (c) 2026 Yash
# SPDX-License-Identifier: MIT
"""Fail when bundle/ would be rejected by Anna or is close to it.

Checks: total size under a safety margin of the 50 MB cap, every path matches
Anna's ^[A-Za-z0-9_./-]+$ rule, and every inline script in index.html has its
hash in manifest.json (the CSP would block it otherwise).

    python scripts/check_bundle.py
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "bundle"
LIMIT_BYTES = 40 * 1000 * 1000  # Anna's cap is 50 MB; keep 10 MB of headroom.
PATH_RULE = re.compile(r"^[A-Za-z0-9_./\-]+$")
SCRIPT = re.compile(r"<script\b([^>]*)>([\s\S]*?)</script\s*>", re.IGNORECASE)


def main() -> None:
    if not (BUNDLE / "index.html").is_file():
        raise SystemExit("bundle/index.html is missing; run `npm run build --prefix ui` first.")
    errors: list[str] = []
    files = [path for path in BUNDLE.rglob("*") if path.is_file()]
    total = sum(path.stat().st_size for path in files)
    if total > LIMIT_BYTES:
        errors.append(f"bundle/ is {total / 1e6:.1f} MB; keep it under {LIMIT_BYTES / 1e6:.0f} MB.")
    for path in files:
        relative = path.relative_to(BUNDLE).as_posix()
        if not PATH_RULE.match(relative):
            errors.append(f"Path not allowed by Anna: {relative!r}")

    html = (BUNDLE / "index.html").read_text(encoding="utf-8")
    allowed = set(json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
                  .get("ui", {}).get("csp_overrides", {}).get("script-src", []))
    for attrs, body in SCRIPT.findall(html):
        if "src=" in attrs or re.search(r"type\s*=\s*[\"']application/(ld\+)?json", attrs) or not body.strip():
            continue
        digest = base64.b64encode(hashlib.sha256(body.encode("utf-8")).digest()).decode()
        if f"'sha256-{digest}'" not in allowed:
            errors.append(f"Inline script sha256-{digest[:12]}… is not in manifest.json script-src.")

    if errors:
        raise SystemExit("Bundle check failed:\n- " + "\n- ".join(errors))
    print(f"Bundle OK: {len(files)} files, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
