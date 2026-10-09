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

W, H = 8192, 4096
# Continuum limb darkening, fit to the HMI browse images. Divided out of the
# map and put back in the viewer, so the dark rim stays on the silhouette.
LD_U = 0.62
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


def screenshot(when: datetime, size: int = 1024, scale: int = 2) -> Image.Image | None:
    date = when.strftime("%Y-%m-%dT%H:%M:%SZ")
    url = (
        "https://api.helioviewer.org/v2/takeScreenshot/"
        f"?imageScale={scale}&layers=[{HMI},1,100]&events=&eventLabels=false"
        f"&scale=false&date={date}&x0=0&y0=0&width={size}&height={size}"
        "&display=true&watermark=false"
    )
    path = Path("/tmp") / f"sunstrip-{size}-{date}.png"
    if path.exists() and path.stat().st_size > 10000:
        try:
            return Image.open(path).convert("RGB")
        except Exception:
            pass
    try:
        raw = fetch(url, timeout=90)
    except Exception as exc:
        print("  miss", date, exc)
        return None
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
    import numpy as np

    found = disk(photo)
    if not found:
        print("  no disk")
        return
    cx, cy, radius = found
    radius *= 1.02
    if radius < 100:
        print("  disk too small", round(radius))
        return
    gray = np.asarray(photo.convert("L"), dtype=np.float32)
    sh, sw = gray.shape
    out = np.asarray(canvas, dtype=np.float32)
    lat = np.radians(90.0 - (np.arange(H) / (H - 1)) * 180.0)
    sinlat = np.sin(lat)
    coslat = np.cos(lat)
    lon = (0.5 - np.arange(W) / W) * 360.0
    dlon = np.radians((lon - l0 + 540.0) % 360.0 - 180.0)
    z = coslat[:, None] * np.cos(dlon)[None, :]
    iy = cy - radius * sinlat[:, None]
    ix = cx - radius * coslat[:, None] * np.sin(dlon)[None, :]
    mask = (z >= z_min) & (iy >= 1) & (iy < sh - 2) & (ix >= 1) & (ix < sw - 2)
    g = gray[np.clip(iy.astype(np.int32), 0, sh - 1), np.clip(ix.astype(np.int32), 0, sw - 1)]
    mask &= g >= 28
    # Remove this photo's limb darkening. The viewer puts it back from the camera.
    ld = (1.0 - LD_U) + LD_U * np.maximum(z, 0.2)
    corrected = np.clip(g / ld, 0, 255).astype(np.int32)
    colors = np.asarray(TONE, dtype=np.float32)[corrected]
    fade = np.ones_like(z) if z_min <= 0 else np.clip((z - z_min) / 0.32, 0, 1)
    blended = out * (1 - fade[..., None]) + colors * fade[..., None]
    out[mask] = blended[mask]
    canvas.paste(Image.fromarray(out.astype(np.uint8), "RGB"))


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


def fill_poles(canvas: Image.Image) -> None:
    """The last few degrees at each pole never face us squarely. Copy the nearest real row."""
    import numpy as np

    arr = np.asarray(canvas).copy()
    row_std = arr.std(axis=(1, 2))
    filled = row_std > 1.5
    if not filled.any():
        return
    idx = np.arange(arr.shape[0])
    good = idx[filled]
    for y in idx[~filled]:
        src = good[np.argmin(np.abs(good - y))]
        arr[y] = arr[src]
    canvas.paste(Image.fromarray(arr, "RGB"))


def contribute(best, best_mu, photo: Image.Image, l0: float) -> None:
    """Keep the sample that was closest to disk center. That is the sharp one."""
    import numpy as np

    found = disk(photo)
    if not found:
        print("  no disk")
        return
    cx, cy, radius = found
    if radius < 100:
        return
    gray = np.asarray(photo.convert("L"), dtype=np.float32)
    sh, sw = gray.shape
    lat = np.radians(90.0 - (np.arange(H) / (H - 1)) * 180.0)
    lon = (0.5 - np.arange(W) / W) * 360.0
    dlon = np.radians((lon - l0 + 540.0) % 360.0 - 180.0)
    z = np.cos(lat)[:, None] * np.cos(dlon)[None, :]
    iy = cy - radius * np.sin(lat)[:, None]
    ix = cx - radius * np.cos(lat)[:, None] * np.sin(dlon)[None, :]
    mask = (z > best_mu) & (z >= 0.05) & (iy >= 1) & (iy < sh - 2) & (ix >= 1) & (ix < sw - 2)
    g = gray[np.clip(iy.astype(np.int32), 0, sh - 1), np.clip(ix.astype(np.int32), 0, sw - 1)]
    mask &= g >= 28
    ld = (1.0 - LD_U) + LD_U * np.maximum(z, 0.12)
    corrected = np.clip(g / ld, 0, 255).astype(np.int32)
    colors = np.asarray(TONE, dtype=np.uint8)[corrected]
    best[mask] = colors[mask]
    best_mu[mask] = z[mask]


def paint_flat() -> None:
    """Each point on the Sun is taken from the day it was seen most face-on.

    The side facing Earth on open is today's full-resolution frame.
    """
    import numpy as np

    meta = json.loads(META.read_text())
    anchor = datetime.fromisoformat(meta["anchor"].replace("Z", "+00:00"))
    anchor_l0 = float(meta["l0"])
    best = np.empty((H, W, 3), dtype=np.uint8)
    best[:] = TONE[210]
    best_mu = np.zeros((H, W), dtype=np.float32)
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    for i in range(27, -1, -1):
        when = (now - timedelta(days=i)).replace(hour=12)
        print(f"flat -{i} {when.date()}", flush=True)
        photo = screenshot(when, size=4096, scale=0.5)
        if photo is None:
            continue
        contribute(best, best_mu, photo, l0_at(when, anchor, anchor_l0))
        del photo
    covered = float((best_mu > 0).mean())
    print(f"covered {covered:.1%}", flush=True)
    # The extreme poles are never seen face-on, and a flat fill there reads as a
    # bald cap. Match them to the real photosphere just below.
    ref_rows = []
    for lat in (58, -58):
        ref_rows.append(best[int(round((90 - lat) / 180 * (H - 1)))])
    ref = np.mean(ref_rows, axis=0).mean(axis=0)
    rng = np.random.default_rng(4)
    for y in range(H):
        alat = abs(90.0 - (y / (H - 1)) * 180.0)
        if alat < 66:
            continue
        t = min(1.0, (alat - 66) / 24.0)
        t = t * t * (3 - 2 * t)
        cap = np.clip(ref + rng.normal(0, 3.2, size=(W, 3)), 0, 255)
        best[y] = ((1 - t) * best[y] + t * cap).astype(np.uint8)
    Image.fromarray(best, "RGB").save(OUT, "JPEG", quality=93, optimize=True, subsampling=0)
    print("wrote", OUT, OUT.stat().st_size, "bytes")


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
    if "--flat" in sys.argv:
        paint_flat()
    elif "--face" in sys.argv:
        paint_faces()
    else:
        main()
