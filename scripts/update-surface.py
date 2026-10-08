#!/usr/bin/env python3
"""Build the Sun sphere texture from the last Carrington turn of HMI continuum.

Each day Earth sees a new strip of longitude. This keeps those strips and
wraps them into one equirectangular JPEG the globe can load. The Earth-facing
longitude is today; the rest is the last time that side rotated through view.
"""
from __future__ import annotations

import json
import math
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "sun-2k.jpg"
META = ROOT / "surface.json"
MISSIONS = ROOT / "missions.js"

W, H = 2048, 1024
DAYS = 27
STRIP_DEG = 12.0
# Synodic Carrington period. Central-meridian longitude decreases at this rate.
ROTATION_DAYS = 27.2753
DEG_PER_DAY = 360.0 / ROTATION_DAYS
HMI = 18  # Helioviewer sourceId, SDO/HMI continuum


def fetch(url: str, timeout: int = 40) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "supersun-app"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def l0_from_regions(rows: list) -> tuple[datetime, float]:
    """Carrington longitude of disk center, from today's active-region list.

    NOAA longitude is the east-positive central-meridian offset (west is negative).
    Feature longitude = L0 + that offset, so L0 = carrington - offset.
    """
    best_day = max(str(r.get("observed_date") or "") for r in rows)
    samples = []
    for r in rows:
        if str(r.get("observed_date") or "") != best_day:
            continue
        if r.get("carrington_longitude") is None or r.get("longitude") is None:
            continue
        samples.append(float(r["carrington_longitude"]) - float(r["longitude"]))
    if not samples:
        raise SystemExit("no region longitudes to anchor L0")
    samples.sort()
    l0 = samples[len(samples) // 2] % 360.0
    anchor = datetime.fromisoformat(best_day).replace(tzinfo=timezone.utc)
    # The report is for that UTC date; pin the anchor at 12:00.
    anchor = anchor.replace(hour=12)
    return anchor, l0


def l0_at(when: datetime, anchor: datetime, anchor_l0: float) -> float:
    days = (when - anchor).total_seconds() / 86400.0
    return (anchor_l0 - DEG_PER_DAY * days) % 360.0


def screenshot(when: datetime) -> Image.Image | None:
    date = when.strftime("%Y-%m-%dT%H:%M:%SZ")
    url = (
        "https://api.helioviewer.org/v2/takeScreenshot/"
        f"?imageScale=2&layers=[{HMI},1,100]&events=&eventLabels=false"
        f"&scale=false&date={date}&x0=0&y0=0&width=1024&height=1024"
        "&display=true&watermark=false"
    )
    try:
        raw = fetch(url, timeout=50)
    except Exception as exc:
        print("  miss", date, exc)
        return None
    path = Path("/tmp") / f"sunstrip-{date}.png"
    path.write_bytes(raw)
    try:
        return Image.open(path).convert("RGB")
    except Exception as exc:
        print("  bad image", date, exc)
        return None


def disk(im: Image.Image):
    g = im.convert("L")
    w, h = g.size
    px = g.load()
    # Bounding box of the bright disk.
    minx, miny, maxx, maxy = w, h, 0, 0
    seen = False
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if px[x, y] > 28:
                seen = True
                if x < minx:
                    minx = x
                if y < miny:
                    miny = y
                if x > maxx:
                    maxx = x
                if y > maxy:
                    maxy = y
    if not seen:
        return None
    cx = (minx + maxx) / 2
    cy = (miny + maxy) / 2
    r = min(maxx - minx, maxy - miny) / 2
    return cx, cy, r


def tone_lut():
    """Stretch the gray disk so spots stay dark and the photosphere stays warm."""
    lut = []
    for i in range(256):
        t = (i - 88) / 150.0
        if t < 0:
            t = 0.0
        elif t > 1:
            t = 1.0
        t = t ** 1.45
        lut.append((int(10 + t * 245), int(3 + t * 170), int(1 + t * 62)))
    return lut


TONE = tone_lut()


def paint_hemisphere(canvas: Image.Image, photo: Image.Image, l0: float, z_min: float) -> None:
    """Project a full-disk photo onto the longitudes that faced Earth that day."""
    found = disk(photo)
    if not found:
        print("  no disk")
        return
    cx, cy, radius = found
    radius *= 1.02
    if radius < 100:
        print("  disk too small", round(radius))
        return
    src = photo.convert("L").load()
    sw, sh = photo.size
    dst = canvas.load()
    # Longitude increases to solar east. Texture u = 0.5 - lon/360.
    half = math.degrees(math.acos(max(-1.0, min(1.0, z_min)))) + 2
    for my in range(H):
        lat = math.radians(90.0 - (my / (H - 1)) * 180.0)
        sinlat = math.sin(lat)
        coslat = math.cos(lat)
        iy = cy - radius * sinlat
        if iy < 1 or iy > sh - 2:
            continue
        iy0 = int(iy)
        fy = iy - iy0
        for mx in range(W):
            lon = (0.5 - mx / W) * 360.0
            dlon = (lon - l0 + 540.0) % 360.0 - 180.0
            if abs(dlon) > half:
                continue
            dlon_r = math.radians(dlon)
            z = coslat * math.cos(dlon_r)
            if z < z_min:
                continue
            ix = cx - radius * coslat * math.sin(dlon_r)
            if ix < 1 or ix > sw - 2:
                continue
            ix0 = int(ix)
            fx = ix - ix0
            g = (
                src[ix0, iy0] * (1 - fx) * (1 - fy)
                + src[ix0 + 1, iy0] * fx * (1 - fy)
                + src[ix0, iy0 + 1] * (1 - fx) * fy
                + src[ix0 + 1, iy0 + 1] * fx * fy
            )
            if g < 28:
                continue
            color = TONE[int(g)]
            if z_min <= 0 or z > z_min + 0.32:
                dst[mx, my] = color
            else:
                fade = (z - z_min) / 0.32
                old = dst[mx, my]
                dst[mx, my] = tuple(int(old[c] * (1 - fade) + color[c] * fade) for c in range(3))


def colorize(im: Image.Image) -> Image.Image:
    """Gray continuum → photosphere. Spots stay dark."""
    g = im.convert("L")
    lut_r, lut_g, lut_b = [], [], []
    for i in range(256):
        t = (i / 255.0) ** 0.92
        lut_r.append(int(28 + t * 227))
        lut_g.append(int(12 + t * 176))
        lut_b.append(int(6 + t * 92))
    return Image.merge("RGB", (g.point(lut_r), g.point(lut_g), g.point(lut_b)))


def place_strip(canvas: Image.Image, photo: Image.Image, l0: float) -> None:
    """Paste the low-foreshortening meridian of one full-disk photo."""
    found = disk(photo)
    if not found:
        print("  no disk")
        return
    cx, cy, radius = found
    if radius < 100:
        print("  disk too small", round(radius))
        return
    half = radius * math.sin(math.radians(STRIP_DEG))
    x0 = int(cx - half)
    x1 = int(cx + half)
    photo_w, photo_h = photo.size
    x0 = max(0, x0)
    x1 = min(photo_w - 1, x1)
    if x1 <= x0 + 4:
        return
    # Orthographic y → latitude, then onto the equirectangular rows.
    column = photo.crop((x0, 0, x1, photo_h))
    map_w = max(2, int(round(2 * STRIP_DEG / 360.0 * W)))
    mapped = Image.new("RGB", (map_w, H))
    local_cx = cx - x0
    step = 2
    for my in range(0, H, step):
        lat = 90.0 - (my / (H - 1)) * 180.0
        s = math.sin(math.radians(lat))
        sy = int(round(cy - radius * s))
        sy = max(0, min(photo_h - 1, sy))
        # Stay inside the disk. The corners of a rectangular strip are black space.
        chord = radius * math.sqrt(max(0.0, 1.0 - s * s))
        half_px = max(1.0, min(column.size[0] / 2.0, chord))
        sx0 = int(max(0, local_cx - half_px))
        sx1 = int(min(column.size[0], local_cx + half_px))
        if sx1 <= sx0:
            sx0, sx1 = 0, column.size[0]
        row = column.crop((sx0, sy, sx1, sy + 1)).resize((map_w, step), Image.BILINEAR)
        mapped.paste(row, (0, my))
    mapped = colorize(mapped)
    # East (higher longitude, left side of the photo) goes to the smaller u.
    u_east = (0.5 - ((l0 + STRIP_DEG) % 360.0) / 360.0) % 1.0
    dest_x = int(round(u_east * W)) % W
    mask = Image.new("L", (map_w, H), 0)
    mp = mask.load()
    for x in range(map_w):
        edge = min(x, map_w - 1 - x) / max(1, map_w / 2)
        a = int(255 * min(1.0, edge * 2.2))
        for y in range(H):
            mp[x, y] = a
    for dx in (dest_x, dest_x - W):
        if dx >= W or dx + map_w <= 0:
            continue
        canvas.paste(mapped, (dx, 0), mask)


def main() -> None:
    regions = json.loads(fetch("https://services.swpc.noaa.gov/json/solar_regions.json"))
    anchor, anchor_l0 = l0_from_regions(regions)
    print(f"L0 {anchor_l0:.1f} at {anchor.isoformat()}", flush=True)

    canvas = Image.new("RGB", (W, H), (48, 22, 8))
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    # Oldest first, so today's strip wins the Earth-facing longitude.
    for i in range(DAYS, -1, -1):
        when = (now - timedelta(days=i)).replace(hour=12)
        print(f"day -{i} {when.date()}", flush=True)
        photo = screenshot(when)
        if photo is None:
            continue
        place_strip(canvas, photo, l0_at(when, anchor, anchor_l0))

    out = canvas
    out.save(OUT, "JPEG", quality=88, optimize=True)
    meta = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "anchor": anchor.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "l0": round(anchor_l0, 3),
        "rotationDays": ROTATION_DAYS,
    }
    META.write_text(json.dumps(meta, indent=2) + "\n")
    write_missions(regions)
    print("wrote", OUT, OUT.stat().st_size, "bytes")


def write_missions(rows: list) -> None:
    best_day = max(str(r.get("observed_date") or "") for r in rows)
    by_id = {}
    for r in rows:
        if str(r.get("observed_date") or "") != best_day:
            continue
        if r.get("latitude") is None or r.get("carrington_longitude") is None:
            continue
        rid = r.get("region")
        prev = by_id.get(rid)
        spots = r.get("number_spots") or 0
        if prev is None or spots > (prev.get("number_spots") or 0):
            by_id[rid] = r
    sites = []
    for r in sorted(by_id.values(), key=lambda r: -(r.get("number_spots") or 0)):
        spots = r.get("number_spots") or 0
        loc = r.get("location") or ""
        klass = r.get("spot_class") or ""
        sites.append(
            {
                "id": f"ar{r.get('region')}",
                "name": f"AR {r.get('region')}",
                "lat": r.get("latitude"),
                "lon": r.get("carrington_longitude"),
                "famous": spots >= 5,
                "meta": " · ".join(p for p in (loc, klass, f"{spots} spots" if spots else "") if p),
                "blurb": (
                    f"Active region on the Earth-facing side, {best_day}. "
                    f"Carrington longitude {r.get('carrington_longitude')}."
                ),
            }
        )
    body = (
        "/** Active regions for the current Earth-facing side. Regenerated by scripts/update-surface.py. */\n"
        "export const MISSION_SITES = "
        + json.dumps(sites, indent=2)
        + ";\n"
    )
    MISSIONS.write_text(body)
    print("regions", len(sites))


def paint_faces() -> None:
    """Lay real full-disk photos on the sphere. Today covers the whole near side."""
    meta = json.loads(META.read_text())
    anchor = datetime.fromisoformat(meta["anchor"].replace("Z", "+00:00"))
    if anchor.tzinfo is None:
        anchor = anchor.replace(tzinfo=timezone.utc)
    anchor_l0 = float(meta["l0"])
    canvas = Image.open(OUT).convert("RGB")
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    days = [0] if "--today" in sys.argv else list(range(24, 0, -3)) + [0]
    for i in days:
        when = (now - timedelta(days=i)).replace(hour=12)
        print(f"face -{i} {when.date()}", flush=True)
        photo = screenshot(when)
        if photo is None:
            continue
        # Today owns the hemisphere you see on open. Older days fill the back.
        z_min = 0.0 if i == 0 else 0.42
        paint_hemisphere(canvas, photo, l0_at(when, anchor, anchor_l0), z_min)
    canvas.save(OUT, "JPEG", quality=92, optimize=True)
    print("wrote", OUT, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    if "--face" in sys.argv:
        paint_faces()
    else:
        main()
