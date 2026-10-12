#!/usr/bin/env python3
"""PWA icons from a face-on AIA 171 plate — matches the Carrington loop app."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
# Mid-loop plate with clear active regions (face-on, not the old equirect map).
PLATE = ROOT / "frames" / "0200.webp"
BG = (2, 3, 8)


def render_icon(size: int, *, maskable: bool = False) -> Image.Image:
    src = Image.open(PLATE).convert("RGB")
    # Fit disk in the safe zone; maskable needs a smaller disk.
    margin = 0.22 if maskable else 0.12
    disk = int(round(size * (1.0 - 2 * margin)))
    plate = src.resize((disk, disk), Image.Resampling.LANCZOS)
    arr = np.asarray(plate, dtype=np.float32)

    # Soft circular alpha from the plate (AIA FOV is square; mask to a disk).
    yy, xx = np.ogrid[:disk, :disk]
    cx = cy = (disk - 1) * 0.5
    r = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / (disk * 0.5)
    # Soft rim so the square FOV cut does not read as a hard edge.
    alpha = np.clip((1.05 - r) / 0.08, 0.0, 1.0)
    alpha = alpha * alpha * (3 - 2 * alpha)

    canvas = np.zeros((size, size, 3), dtype=np.float32)
    canvas[:] = np.array(BG, dtype=np.float32)
    ox = oy = (size - disk) // 2
    region = canvas[oy : oy + disk, ox : ox + disk]
    a = alpha[..., None]
    region[:] = region * (1.0 - a) + arr * a

    # A few faint field stars outside the disk.
    rng = np.random.default_rng(171)
    n_stars = 22 if not maskable else 12
    r_keep = disk * 0.52
    for _ in range(n_stars):
        sx = int(rng.integers(0, size))
        sy = int(rng.integers(0, size))
        if (sx - size * 0.5) ** 2 + (sy - size * 0.5) ** 2 < r_keep**2:
            continue
        bright = float(rng.uniform(80, 170))
        rad = 0 if size < 64 else (1 if rng.random() < 0.65 else 0)
        y0, y1 = max(0, sy - rad), min(size, sy + rad + 1)
        x0, x1 = max(0, sx - rad), min(size, sx + rad + 1)
        canvas[y0:y1, x0:x1] = np.maximum(canvas[y0:y1, x0:x1], bright)

    return Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8))


def save_icons() -> None:
    if not PLATE.exists():
        raise SystemExit(f"missing plate {PLATE}")
    hi = render_icon(1024)
    icon_512 = hi.resize((512, 512), Image.Resampling.LANCZOS)
    icon_512.save(ROOT / "icon-512.png", "PNG")
    render_icon(1024, maskable=True).resize((512, 512), Image.Resampling.LANCZOS).save(
        ROOT / "icon-maskable-512.png", "PNG"
    )
    icon_512.resize((192, 192), Image.Resampling.LANCZOS).save(ROOT / "icon-192.png", "PNG")
    apple = icon_512.resize((180, 180), Image.Resampling.LANCZOS).convert("RGBA")
    apple.save(ROOT / "apple-touch-icon.png", "PNG")
    apple.save(ROOT / "apple-touch-icon-precomposed.png", "PNG")
    apple.save(ROOT / "apple-touch-icon-180x180.png", "PNG")
    icon_64 = icon_512.resize((64, 64), Image.Resampling.LANCZOS)
    icon_32 = icon_512.resize((32, 32), Image.Resampling.LANCZOS)
    icon_64.save(ROOT / "favicon-64.png", "PNG")
    icon_32.save(ROOT / "favicon-32.png", "PNG")
    icon_32.convert("RGBA").save(
        ROOT / "favicon.ico", format="ICO", sizes=[(32, 32), (16, 16)]
    )
    print("Wrote face-on AIA 171 icons in", ROOT)


if __name__ == "__main__":
    save_icons()
