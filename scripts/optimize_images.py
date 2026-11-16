# Copyright (c) 2026 Yash
# SPDX-License-Identifier: MIT
"""Convert the UI's PNG artwork to WebP at display size.

Anna caps a bundle at 50 MB and only accepts paths matching ^[A-Za-z0-9_./\\-]+$,
so each PNG is resized, re-encoded as WebP and given a kebab-case name. The
source PNG is removed once its WebP exists. Re-running the script is a no-op.

    python scripts/optimize_images.py
"""
from __future__ import annotations

import re
from pathlib import Path

from PIL import Image

UI = Path(__file__).resolve().parents[1] / "ui"

# (glob relative to ui/, longest edge in px, WebP quality)
RULES = [
    ("public/characters/*.png", 1040, 80),
    ("public/landing/*.png", 1920, 78),
    ("public/party/*.png", 256, 82),
    ("public/logos/dm_logo.png", 768, 82),
    ("public/logos/d20.png", 512, 85),
    ("public/logos/d20_empty.png", 512, 85),
    ("public/logos/d100.png", 512, 85),
    ("public/logos/arrow.png", 512, 85),
    ("src/app/texture.png", 1254, 70),
]


def kebab(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.\-]+", "-", name.strip()).strip("-")


def convert(path: Path, longest: int, quality: int) -> Path:
    target = path.with_name(kebab(path.stem) + ".webp")
    with Image.open(path) as image:
        image.load()
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "transparency" in image.info else "RGB")
        scale = longest / max(image.size)
        if scale < 1:
            image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
        image.save(target, "WEBP", quality=quality, method=6)
    path.unlink()
    return target


def main() -> None:
    before = after = 0
    for pattern, longest, quality in RULES:
        for path in sorted(UI.glob(pattern)):
            size = path.stat().st_size
            target = convert(path, longest, quality)
            before += size
            after += target.stat().st_size
            print(f"{path.relative_to(UI)} -> {target.name} ({size // 1024} KB -> {target.stat().st_size // 1024} KB)")
    print(f"total {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
