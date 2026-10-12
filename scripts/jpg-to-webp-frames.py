#!/usr/bin/env python3
"""Convert frames/*.jpg to WebP at similar size, then remove the JPEGs."""
from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
FRAMES = ROOT / "frames"
QUALITY = 90


def convert_one(path: Path) -> tuple[str, int, int]:
    out = path.with_suffix(".webp")
    img = Image.open(path).convert("RGB")
    img.save(out, format="WEBP", quality=QUALITY, method=4)
    return path.name, path.stat().st_size, out.stat().st_size


def main() -> None:
    jpgs = sorted(FRAMES.glob("*.jpg"))
    if not jpgs:
        raise SystemExit("no frames/*.jpg to convert")
    print(f"converting {len(jpgs)} frames → webp q={QUALITY}", flush=True)
    jpg_total = 0
    webp_total = 0
    workers = min(8, max(2, (os.cpu_count() or 2)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(convert_one, p) for p in jpgs]
        for i, fut in enumerate(as_completed(futs), 1):
            _name, js, ws = fut.result()
            jpg_total += js
            webp_total += ws
            if i % 50 == 0 or i == len(jpgs):
                print(
                    f"{i}/{len(jpgs)}  webp={webp_total/1e6:.1f}MB  jpg={jpg_total/1e6:.1f}MB",
                    flush=True,
                )
    removed = 0
    for p in jpgs:
        p.unlink()
        removed += 1
    print(f"removed {removed} jpg; webp total {webp_total/1e6:.1f}MB", flush=True)


if __name__ == "__main__":
    main()
