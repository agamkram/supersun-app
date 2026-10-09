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


def cap_poles(best: np.ndarray) -> None:
    """The poles are never photographed straight on. Continue them in the same gold.

    Sampled in the pole's own plane so the cap is not a black hole, a spoke, or rings.
    """
    h, w = best.shape[:2]
    rng = np.random.default_rng(5)
    noise = rng.normal(0, 1, (256, 256)).astype(np.float32)
    pic = Image.fromarray(np.clip(noise * 28 + 128, 0, 255).astype(np.uint8))
    pic = pic.resize((128, 128), Image.BILINEAR).resize((480, 480), Image.BILINEAR)
    grain = np.asarray(pic).astype(np.float32)
    grain = (grain - grain.mean()) / (grain.std() + 1e-3)
    gh, gw = grain.shape
    xs = np.arange(w)
    lon = (0.5 - xs / w) * 2 * math.pi
    cosl = np.cos(lon)
    sinl = np.sin(lon)

    def row_at(lat: float) -> int:
        return int(round((90.0 - lat) / 180.0 * (h - 1)))

    for sign in (1, -1):
        color = best[row_at(72.0 * sign)].mean(axis=0).astype(np.float32)
        y0, y1 = (0, row_at(74)) if sign > 0 else (row_at(-74), h)
        for y in range(y0, y1):
            lat = 90.0 - (y / (h - 1)) * 180.0
            alat = abs(lat)
            if alat < 78:
                continue
            t = min(1.0, (alat - 78.0) / 5.0)
            t = t * t * (3 - 2 * t)
            r = math.cos(math.radians(lat)) / math.cos(math.radians(78))
            u = 0.5 + 0.46 * r * cosl
            v = 0.5 + 0.46 * r * sinl
            iu = np.clip((u * (gw - 1)).astype(np.int32), 0, gw - 1)
            iv = np.clip((v * (gh - 1)).astype(np.int32), 0, gh - 1)
            shade = (1.0 + 0.16 * grain[iv, iu])[:, None]
            cap = np.clip(color * shade, 0, 255)
            best[y] = ((1 - t) * best[y] + t * cap).astype(np.uint8)


def fetch_sdo() -> list[tuple[datetime, Path]]:
    """One AIA 171 disk per day for a full Carrington turn. Cached on disk."""
    cache = ROOT / ".sun-cache"
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
            part = dest.with_suffix(".part")
            try:
                with urllib.request.urlopen(req, timeout=90) as res:
                    part.write_bytes(res.read())
            except Exception as exc:
                part.unlink(missing_ok=True)
                raise SystemExit(f"download failed for {date}: {exc}") from exc
            if part.stat().st_size < 100000:
                part.unlink(missing_ok=True)
                raise SystemExit(f"download too small for {date}")
            part.replace(dest)
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
    if covered.mean() < 0.9:
        raise SystemExit(f"coverage {covered.mean():.1%} is too low, keeping the current sun")
    cap_poles(best)
    south = best[int(H * 0.98) :]
    north = best[: int(H * 0.02)]
    if float(south.mean()) < 20 or float(north.mean()) < 20:
        raise SystemExit("a pole is still empty, keeping the current sun")
    part = OUT.with_suffix(".jpg.part")
    Image.fromarray(best).save(part, "JPEG", quality=93, subsampling=0)
    if part.stat().st_size < 1_000_000:
        part.unlink(missing_ok=True)
        raise SystemExit("surface file is too small, keeping the current sun")
    part.replace(OUT)
    print("wrote", OUT, OUT.stat().st_size, flush=True)
    subprocess.check_call([sys.executable, str(ROOT / "scripts" / "bump-version.py")])


if __name__ == "__main__":
    main()
