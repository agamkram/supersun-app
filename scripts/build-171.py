#!/usr/bin/env python3
"""Build the Sun texture from the 14-day SDO/AIA 171 slideshow on the Desktop.

Each frame is one full-disk 171 image. The off-limb glow is left out of the
map; the viewer draws that rim from the camera.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
VIDEO = Path("/Users/Mark/Desktop/SDO 171 Slideshow/sdo171_14day_4k.mp4")
FRAMES = Path("/tmp/sdo171/days")
OUT = ROOT / "sun-2k.jpg"
META = ROOT / "surface.json"
W, H = 8192, 4096
AIA171 = 10
ROTATION_DAYS = 27.2753
DEG_PER_DAY = 360.0 / ROTATION_DAYS
# Video runs 22 Sep 10:47 → 5 Oct 10:57 across 10.5 seconds.
T0 = datetime(2026, 9, 22, 10, 47, tzinfo=timezone.utc)
T1 = datetime(2026, 10, 5, 10, 57, tzinfo=timezone.utc)
DURATION = 10.5


def solar_pb(when: datetime) -> tuple[float, float]:
    """Position angle P and disk-center latitude B0, in degrees.

    P is 0 near 5 Jan and 7 Jul, and about +26° in early October.
    B0 is about -7° in early June and +7° in early December.
    """
    a = (14 - when.month) // 12
    y = when.year + 4800 - a
    m = when.month + 12 * a - 3
    jdn = when.day + (153 * m + 2) // 5 + 365 * y + y // 4 - y // 100 + y // 400 - 32045
    j = jdn - 0.5 + (when.hour + when.minute / 60.0) / 24.0
    T = (j - 2451545.0) / 36525.0
    L = math.radians(280.46645 + 36000.76983 * T)
    M = math.radians(357.52910 + 35999.05030 * T)
    C = math.radians(
        (1.914600 - 0.004817 * T) * math.sin(M)
        + (0.019993 - 0.000101 * T) * math.sin(2 * M)
    )
    theta = L + C
    eps = math.radians(23.4392911 - 0.0130042 * T)
    K = math.radians(73.6667 + 1.3958333 * (j - 2415020.0) / 36525.0)
    I = math.radians(7.25)
    p_ang = math.degrees(math.atan(-math.cos(theta) * math.tan(eps)))
    p_ang += math.degrees(math.atan(-math.cos(theta - K) * math.tan(I)))
    b0 = math.degrees(math.asin(-math.cos(theta - K) * math.sin(I)))
    return p_ang, b0


def l0_at(when: datetime) -> float:
    meta = json.loads(META.read_text())
    anchor = datetime.fromisoformat(meta["anchor"].replace("Z", "+00:00"))
    days = (when - anchor).total_seconds() / 86400.0
    return (float(meta["l0"]) - DEG_PER_DAY * days) % 360.0


def extract() -> list[tuple[datetime, Path]]:
    FRAMES.mkdir(parents=True, exist_ok=True)
    times = list(range(0, 11))
    if not Path("/tmp/sdo171/t0.png").exists():
        subprocess.check_call(["swift", "/tmp/sdo171/grab.swift", str(VIDEO), *[str(t) for t in times]])
    out = []
    for t in times:
        when = T0 + (T1 - T0) * (t / DURATION)
        src = Path(f"/tmp/sdo171/t{t}.png")
        dest = FRAMES / f"{when.strftime('%Y-%m-%d')}.png"
        dest.write_bytes(src.read_bytes())
        out.append((when, dest))
    return out


def disk_radius(gray: np.ndarray) -> tuple[float, float, float]:
    """The bright limb ring, inside the fainter off-disk glow."""
    h, w = gray.shape
    cy, cx = h / 2.0, w / 2.0
    profile = gray[int(cy), int(cx) :].astype(np.float32)
    kernel = np.ones(21) / 21
    smooth = np.convolve(profile, kernel, mode="same")
    # Outermost bright pixel on the equator is the limb, at any image size.
    inner = float(np.median(smooth[int(0.08 * len(smooth)) : int(0.2 * len(smooth))]))
    above = np.where(smooth > max(40.0, inner * 0.5))[0]
    edge = int(above[-1]) if len(above) else int(0.42 * len(smooth))
    return cx, cy, float(edge) * 0.98


def project(photo: Image.Image, l0: float, when: datetime):
    """Map one 171 disk onto heliographic lat/lon. z is how face-on it was."""
    rgb = np.asarray(photo.convert("RGB")).astype(np.float32)
    gray = rgb.mean(axis=2)
    cx, cy, radius = disk_radius(gray)
    p_ang, b0 = solar_pb(when)
    print(f"  radius {radius:.0f}  P {p_ang:+.1f}  B0 {b0:+.1f}", flush=True)
    sh, sw = gray.shape
    lat = np.radians(90.0 - (np.arange(H) / (H - 1)) * 180.0)
    lon = (0.5 - np.arange(W) / W) * 360.0
    dlon = np.radians((lon - l0 + 540.0) % 360.0 - 180.0)
    sinlat = np.sin(lat)[:, None]
    coslat = np.cos(lat)[:, None]
    sind = np.sin(dlon)[None, :]
    cosd = np.cos(dlon)[None, :]
    br = math.radians(b0)
    pr = math.radians(p_ang)
    # Heliographic direction of this surface point, as seen that day.
    x_east = coslat * sind
    y_north = sinlat * math.cos(br) - coslat * cosd * math.sin(br)
    z = sinlat * math.sin(br) + coslat * cosd * math.cos(br)
    # Frames are celestial-north up. P leans solar north toward the east.
    x_img = x_east * math.cos(pr) - y_north * math.sin(pr)
    y_img = x_east * math.sin(pr) + y_north * math.cos(pr)
    ix = cx - radius * x_img
    iy = cy - radius * y_img
    valid = (z >= 0.05) & (iy >= 1) & (iy < sh - 2) & (ix >= 1) & (ix < sw - 2)
    sample = rgb[np.clip(iy.astype(np.int32), 0, sh - 1), np.clip(ix.astype(np.int32), 0, sw - 1)]
    valid &= sample.sum(axis=2) > 40
    return sample, z, valid


def quiet_level(photo: Image.Image) -> float:
    """Center of the disk. Whole-frame medians hide a 3x exposure difference."""
    gray = np.asarray(photo.convert("L"))
    h, w = gray.shape
    center = gray[h // 2 - 120 : h // 2 + 120, w // 2 - 120 : w // 2 + 120]
    return float(np.median(center)) if center.size else 40.0


def add_day(best, best_mu, flat, z, valid, gain: float) -> None:
    """Keep the sharpest day. gain makes that day's disk as bright as the others."""
    flat = np.clip(flat * gain, 0, 255)
    better = valid & (z >= best_mu)
    # A short blend where two days are equally face-on, so the join is not a cut.
    close = valid & ~better & (best_mu > 0) & (z > best_mu - 0.08)
    best[better] = flat[better].astype(np.uint8)
    if close.any():
        fade = ((z[close] - (best_mu[close] - 0.08)) / 0.08)[:, None]
        best[close] = ((1 - fade) * best[close] + fade * flat[close]).astype(np.uint8)
    best_mu[better] = z[better]


def fetch_sdo() -> list[tuple[datetime, Path]]:
    """One AIA 171 disk per day for a full Carrington turn. Cached on disk."""
    cache = Path("/tmp/sdo171/aia")
    cache.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
    frames = []
    for i in range(27, -1, -1):
        when = now - timedelta(days=i)
        dest = cache / f"{when.strftime('%Y-%m-%d')}.jpg"
        if not (dest.exists() and dest.stat().st_size > 100000):
            date = when.strftime("%Y-%m-%dT%H:%M:%SZ")
            url = (
                "https://api.helioviewer.org/v2/takeScreenshot/"
                f"?imageScale=0.5&layers=[{AIA171},1,100]&events=&eventLabels=false"
                f"&scale=false&date={date}&x0=0&y0=0&width=4096&height=4096"
                "&display=true&watermark=false"
            )
            print("  download", date, flush=True)
            req = urllib.request.Request(url, headers={"User-Agent": "supersun-app"})
            with urllib.request.urlopen(req, timeout=90) as res:
                dest.write_bytes(res.read())
        frames.append((when, dest))
    return frames


def main() -> None:
    frames = fetch_sdo() if "--sdo" in sys.argv else extract()
    levels = []
    for when, path in frames:
        levels.append(quiet_level(Image.open(path)))
    target = float(np.median(levels))
    print(f"quiet target {target:.1f}", flush=True)
    best = np.zeros((H, W, 3), dtype=np.uint8)
    best_mu = np.zeros((H, W), dtype=np.float32)
    for (when, path), level in zip(frames, levels):
        gain = target / level if level > 5 else 1.0
        print(when.date(), "L0", round(l0_at(when), 1), "gain", round(gain, 2), flush=True)
        flat, z, valid = project(Image.open(path), l0_at(when), when)
        add_day(best, best_mu, flat, z, valid, gain)
        del flat, z, valid
    covered = best_mu > 0
    print(f"covered {covered.mean():.1%}", flush=True)
    # Any leftover pole pixels take the nearest real row. No flat disc, no blur.
    row_has = best.reshape(H, -1).std(axis=1) > 1
    good = np.where(row_has)[0]
    if len(good):
        for y in np.where(~row_has)[0]:
            best[y] = best[int(good[np.argmin(np.abs(good - y))])]
    try_path = Path("/tmp/sun-try.jpg")
    Image.fromarray(best).save(try_path, "JPEG", quality=93, subsampling=0)
    print("wrote", try_path, try_path.stat().st_size)


if __name__ == "__main__":
    main()
