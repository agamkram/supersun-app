#!/usr/bin/env python3
"""SuperSun PWA icons — gold S on the globe-app black."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BG = (2, 3, 8)
GOLD = (232, 168, 74)
GLOW = (255, 140, 40)


def _font(size: int) -> ImageFont.ImageFont:
    for path, index in (
        ("/System/Library/Fonts/Avenir Next.ttc", 3),  # Heavy
        ("/System/Library/Fonts/Avenir Next.ttc", 2),  # Bold
        ("/System/Library/Fonts/Supplemental/Futura.ttc", 1),
        ("/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf", 0),
        ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
    ):
        try:
            return ImageFont.truetype(path, size, index=index)
        except OSError:
            continue
    return ImageFont.load_default()


def build_icon(size: int, *, maskable: bool = False) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (*BG, 255))
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    pad = int(size * (0.22 if maskable else 0.12))
    gd.ellipse((pad, pad, size - pad, size - pad), fill=(*GLOW, 55))
    canvas = Image.alpha_composite(
        canvas, glow.filter(ImageFilter.GaussianBlur(radius=max(8, size // 10)))
    )

    draw = ImageDraw.Draw(canvas)
    f = _font(int(size * (0.62 if maskable else 0.72)))
    s = "S"
    bbox = draw.textbbox((0, 0), s, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) / 2 - bbox[0]
    ty = (size - th) / 2 - bbox[1] - size * 0.02
    draw.text((tx, ty), s, font=f, fill=(*GOLD, 255))
    return canvas.convert("RGB")


def save_icons() -> None:
    icon_512 = build_icon(512)
    icon_512.save(ROOT / "icon-512.png", "PNG")
    build_icon(512, maskable=True).save(ROOT / "icon-maskable-512.png", "PNG")
    icon_512.resize((192, 192), Image.Resampling.LANCZOS).save(ROOT / "icon-192.png", "PNG")
    icon_512.resize((180, 180), Image.Resampling.LANCZOS).save(
        ROOT / "apple-touch-icon.png", "PNG"
    )
    icon_64 = icon_512.resize((64, 64), Image.Resampling.LANCZOS)
    icon_32 = icon_512.resize((32, 32), Image.Resampling.LANCZOS)
    icon_64.save(ROOT / "favicon-64.png", "PNG")
    icon_32.save(ROOT / "favicon-32.png", "PNG")
    icon_32.save(
        ROOT / "favicon.ico",
        format="ICO",
        sizes=[(32, 32), (16, 16)],
    )
    print("Wrote icons in", ROOT)


if __name__ == "__main__":
    save_icons()
