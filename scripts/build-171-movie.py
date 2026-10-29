#!/usr/bin/env python3
"""Bake a Carrington-rotation AIA 171 movie for SuperSun.

One full solar turn of full-disk 171 frames (disk + real corona), every 1 hour,
encoded as a ~12 second seamless loop. Skips / replaces bad frames. Caches by
timestamp so rebakes do not re-download.

Usage:
  python3 scripts/build-171-movie.py              # sliding 27d window, fetch + encode
  python3 scripts/build-171-movie.py --fixed      # pinned Sep14→Oct11 window
  python3 scripts/build-171-movie.py --encode     # encode only from cache
  python3 scripts/build-171-movie.py --no-mp4     # scrub frames + meta only (CI)
  python3 scripts/build-171-movie.py --limit 12   # smoke test
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".sun-cache" / "movie-1h"
# Prior 2h bake — reuse even-hour slots so the first 1h run is ~half downloads.
CACHE_LEGACY = ROOT / ".sun-cache" / "movie-2h"
OUT_MP4 = ROOT / "carrington-171.mp4"
OUT_POSTER = ROOT / "carrington-171-poster.jpg"
OUT_META = ROOT / "movie.json"
OUT_FRAMES = ROOT / "frames"
OUT_FRAMES_META = ROOT / "frames.json"

AIA171 = 10
# Sliding Carrington-length window (overwritten in main unless --fixed).
WINDOW_DAYS = 27
T0 = datetime(2026, 9, 14, 0, 0, tzinfo=timezone.utc)
T1 = datetime(2026, 10, 11, 0, 0, tzinfo=timezone.utc)
STEP = timedelta(hours=1)
DURATION_SEC = 12.0
SIZE = 2048  # above GB's 1024; phone-friendly
# Match AIA's native FOV (~41′ / 2460″). Longer streamers are not in the
# instrument; framing the plate to the screen hides that hard FOV edge.
IMAGE_SCALE = 1.2
SCRUB_SIZE = 1024
# Nearby minutes first. The level plate and the one with the full right-hand
# loops were a couple of minutes off the ten-minute marks. Five-minute steps
# further out reach 19:55, the centered plate, after 19:50 is turned down.
_near = [0]
for _step in range(1, 21):
    _near.extend((-2 * _step, 2 * _step))
_far = []
for _step in range(9, 25):
    _far.extend((-5 * _step, 5 * _step))
OFFSETS_MIN = tuple(_near + _far)


def which_ffmpeg() -> str:
    for name in ("ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        path = shutil.which(name) if "/" not in name else (name if Path(name).exists() else None)
        if path:
            return path
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:
        raise SystemExit(
            "ffmpeg not found (no PATH binary, no imageio-ffmpeg)"
        ) from exc


def sliding_window(now: datetime | None = None) -> tuple[datetime, datetime]:
    """End at the last completed UTC hour; start WINDOW_DAYS earlier."""
    now = now or datetime.now(timezone.utc)
    t1 = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
    t0 = t1 - timedelta(days=WINDOW_DAYS)
    return t0, t1


def resolve_window(argv: list[str]) -> tuple[datetime, datetime]:
    """Default: sliding. --fixed keeps the pinned Sep14→Oct11 bake."""
    if "--fixed" in argv:
        return (
            datetime(2026, 9, 14, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 10, 11, 0, 0, tzinfo=timezone.utc),
        )
    return sliding_window()


def frame_times() -> list[datetime]:
    times = []
    t = T0
    while t <= T1:
        times.append(t)
        t += STEP
    return times


def frame_problem(path: Path) -> str | None:
    """None when the plate is usable. A short reason otherwise."""
    try:
        im = Image.open(path).convert("L")
    except Exception:
        return "unreadable"
    if im.size[0] < SIZE // 2 or im.size[1] < SIZE // 2:
        return "too small"
    arr = np.asarray(im, dtype=np.float32)
    h, w = arr.shape
    cy, cx = h / 2.0, w / 2.0
    yy, xx = np.ogrid[:h, :w]
    r = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
    rmax = 0.5 * min(h, w)
    disk = arr[r < 0.32 * rmax * 2]
    outer = arr[r > 0.92 * rmax]
    if disk.size < 1000 or outer.size < 1000:
        return "too small"
    d_mean = float(disk.mean())
    d_std = float(disk.std())
    o_mean = float(outer.mean())
    lit = float((arr > 18.0).mean())
    # Eclipse / missing data: disk too dark or flatter than noise.
    if d_mean < 28.0 or d_std < 10.0:
        return "dark"
    # Disk should outshine the black field.
    if d_mean < o_mean * 2.2:
        return "dim"
    # Too little lit area (empty) or whole frame lit (bad stretch / artifact).
    if lit < 0.06 or lit > 0.85:
        return "empty"
    # Horizontal dropout / missing scan lines (e.g. 2026-09-30 17:00Z).
    streak = float(np.std(np.diff(arr.mean(axis=1))))
    if streak > 0.55:
        return "streak"
    # Hole in the disk (black block from a bad Helioviewer cut).
    if float((disk < 8.0).mean()) > 0.02:
        return "hole"
    y0, y1 = int(0.5 * h), int(0.85 * h)
    x0, x1 = int(0.15 * w), int(0.55 * w)
    if float((arr[y0:y1, x0:x1] < 8.0).mean()) > 0.12:
        return "hole"
    # Severe registration shift — mild AIA drift (~2% of height) is normal.
    wgt = np.clip(arr - 20.0, 0.0, None)
    wsum = float(wgt.sum())
    if wsum > 0:
        bright_cy = float((yy * wgt).sum() / wsum)
        if abs(bright_cy - cy) > 0.04 * h:
            return "shift"
    # Smeared JPEG2000: only the coarse layer decoded. A real plate scores
    # about 1000 here. The softest good cached plate is about 660. The
    # smeared 21 Oct file scored about 90.
    crop = arr[int(0.32 * h) : int(0.68 * h), int(0.32 * w) : int(0.68 * w)]
    step = max(1, min(crop.shape) // 96)
    small = crop[::step, ::step]
    if small.shape[0] < 8 or small.shape[1] < 8:
        return "smear"
    lap = (
        small[1:-1, 1:-1] * 4
        - small[:-2, 1:-1]
        - small[2:, 1:-1]
        - small[1:-1, :-2]
        - small[1:-1, 2:]
    )
    if float(lap.var()) < 400.0:
        return "smear"
    # Disk sitting high or low. Hours around noon are centered. The 16:10
    # plate is about 0.9% low, so the sun drops. Good plates stay under 0.7%.
    mid = arr[:, w // 2]
    if np.any(mid[: h // 2] > 40.0) and np.any(mid[h // 2 :] > 40.0):
        top = int(np.where(mid[: h // 2] > 40.0)[0][0])
        bot = int(np.where(mid[h // 2 :] > 40.0)[0][-1] + h // 2)
        if abs((top + bot) / 2.0 - h / 2.0) / h > 0.008:
            return "shift"
    # One side black well inside the limb. Normal corona starts about 5–8%
    # in from the edge. A file that decoded in half starts around 15%.
    col = arr.mean(axis=0)
    rowm = arr.mean(axis=1)
    margins = (
        int(np.argmax(col > 8.0)) / w,
        int(np.argmax(col[::-1] > 8.0)) / w,
        int(np.argmax(rowm > 8.0)) / h,
        int(np.argmax(rowm[::-1] > 8.0)) / h,
    )
    if max(margins) > 0.12:
        return "cut"
    # Loops chopped by a hard wall. A real corona fades out. The 21 Oct
    # 18:40 plate scored ~68 here; a whole plate stays under ~12.
    if _hard_edge(arr):
        return "cut"
    return None


def _hard_edge(arr: np.ndarray) -> bool:
    """True when the disk meets black in a sharp step instead of fading."""
    h, w = arr.shape
    band = arr[int(0.35 * h) : int(0.75 * h)]
    steps = []
    for row in band[::8]:
        lit = np.where(row > 12.0)[0]
        if len(lit) == 0:
            continue
        right = int(lit[-1])
        left = int(lit[0])
        if 8 <= right <= w - 5:
            inner = float(row[right - 6 : right - 1].mean())
            outer = float(row[right + 1 : right + 4].mean())
            steps.append(inner - outer)
        if 4 <= left <= w - 8:
            inner = float(row[left + 1 : left + 6].mean())
            outer = float(row[left - 3 : left].mean())
            steps.append(inner - outer)
    if len(steps) < 8:
        return False
    # One bright pixel can spike a single row. The chopped flare is a wall
    # across many rows.
    return float(np.percentile(steps, 90)) > 30.0


def is_good_frame(path: Path) -> bool:
    """Reject dark, blank, smeared, cropped, or off-center plates."""
    return frame_problem(path) is None


def limb_edges(path: Path) -> tuple[int, int, int] | None:
    """Left and right bright limb on the middle row, plus the image width."""
    try:
        im = Image.open(path).convert("L")
    except Exception:
        return None
    arr = np.asarray(im, dtype=np.float32)
    h, w = arr.shape
    idx = np.where(arr[h // 2] > 80.0)[0]
    if len(idx) < 10:
        return None
    return int(idx[0]), int(idx[-1]), w


def rigid_slide(path: Path, anchor: tuple[int, int, int] | None) -> float:
    """Pixels both limbs moved together. 0 when the disk did not slide as a whole."""
    if anchor is None:
        return 0.0
    got = limb_edges(path)
    if got is None:
        return 0.0
    left, right, w = got
    a_left, a_right, a_w = anchor
    scale = w / a_w
    d_left = left - a_left * scale
    d_right = right - a_right * scale
    if d_left * d_right <= 0:
        return 0.0
    if abs(d_left - d_right) > 0.004 * w:
        return 0.0
    return max(abs(d_left), abs(d_right))


def slid_sideways(path: Path, anchor: tuple[int, int, int] | None) -> bool:
    """True when the whole disk jumps sideways from the previous hour.

    Slow pointing drift does not move both limbs together by this much in one
    hour. The 21 Oct 19:50 plate does: about 22px on a 2048 image.
    """
    got = limb_edges(path)
    if got is None:
        return False
    return rigid_slide(path, anchor) > 0.006 * got[2]


def download_at(when: datetime, dest: Path) -> bool:
    date = when.strftime("%Y-%m-%dT%H:%M:%SZ")
    url = (
        "https://api.helioviewer.org/v2/takeScreenshot/"
        f"?imageScale={IMAGE_SCALE}&layers=[{AIA171},1,100]&events=&eventLabels=false"
        f"&scale=false&date={date}&x0=0&y0=0&width={SIZE}&height={SIZE}"
        "&display=true&watermark=false"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "supersun-app-movie"})
    # Unique temp per attempt so concurrent/old bakers cannot steal the file.
    part = dest.with_name(f"{dest.stem}.{os.getpid()}.{when.strftime('%H%M%S')}.part")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                part.write_bytes(res.read())
            break
        except Exception as exc:
            part.unlink(missing_ok=True)
            if attempt >= 2:
                print(f"  fail {date}: {exc}", flush=True)
                return False
            print(f"  retry {date} ({attempt + 1})", flush=True)
    if not part.exists() or part.stat().st_size < 40_000:
        part.unlink(missing_ok=True)
        return False
    problem = frame_problem(part)
    if problem:
        print(f"  reject {problem} {date}", flush=True)
        part.unlink(missing_ok=True)
        return False
    try:
        os.replace(part, dest)
    except FileNotFoundError:
        part.unlink(missing_ok=True)
        return False
    return True


def fetch_slot(
    slot: datetime,
    dest: Path,
    anchor: tuple[int, int, int] | None = None,
) -> datetime | None:
    """Fetch slot time or a nearby good substitute. Returns actual time used."""
    if (
        dest.exists()
        and dest.stat().st_size > 40_000
        and is_good_frame(dest)
        and not slid_sideways(dest, anchor)
    ):
        return slot
    if dest.exists():
        print(f"  cached frame failed quality — re-fetch {slot.isoformat()}", flush=True)
        dest.unlink()

    # Reuse 2h-cache plate when this hour was already baked.
    legacy = CACHE_LEGACY / dest.name
    if (
        legacy.exists()
        and legacy.stat().st_size > 40_000
        and is_good_frame(legacy)
        and not slid_sideways(legacy, anchor)
    ):
        CACHE.mkdir(parents=True, exist_ok=True)
        shutil.copy2(legacy, dest)
        print(f"  reuse 2h cache {dest.name}", flush=True)
        return slot

    closest_path = dest.with_name(f"{dest.stem}.closest.jpg")
    closest_when: datetime | None = None
    closest_slide = 0.0
    try:
        for mins in OFFSETS_MIN:
            when = slot + timedelta(minutes=mins)
            print(
                f"  try {when.strftime('%Y-%m-%dT%H:%M:%SZ')}"
                + (f" (slot{mins:+d}m)" if mins else ""),
                flush=True,
            )
            if not download_at(when, dest):
                continue
            slide = rigid_slide(dest, anchor)
            edges = limb_edges(dest)
            limit = 0.006 * edges[2] if edges else 0.0
            if slide <= limit:
                return when
            print(
                f"  reject shift {when.strftime('%Y-%m-%dT%H:%M:%SZ')}",
                flush=True,
            )
            if closest_when is None or slide < closest_slide:
                closest_slide = slide
                closest_when = when
                shutil.copy2(dest, closest_path)
            dest.unlink(missing_ok=True)
        if closest_when is not None and closest_path.exists():
            os.replace(closest_path, dest)
            print(
                f"  keep closest {closest_when.strftime('%Y-%m-%dT%H:%M:%SZ')}",
                flush=True,
            )
            return closest_when
        return None
    finally:
        closest_path.unlink(missing_ok=True)


def fetch_all(limit: int | None) -> tuple[list[Path], list[dict]]:
    CACHE.mkdir(parents=True, exist_ok=True)
    times = frame_times()
    if limit is not None:
        times = times[:limit]
    paths: list[Path] = []
    log: list[dict] = []
    anchor: tuple[int, int, int] | None = None
    for i, slot in enumerate(times):
        dest = CACHE / f"{slot.strftime('%Y%m%dT%H%M%S')}.jpg"
        print(f"[{i + 1}/{len(times)}] slot {slot.strftime('%Y-%m-%dT%H:%M:%SZ')}", flush=True)
        used = fetch_slot(slot, dest, anchor)
        if used is None:
            print(f"  SKIP — no good frame near slot", flush=True)
            log.append({"slot": slot.isoformat(), "status": "skip"})
            continue
        edges = limb_edges(dest)
        if edges is not None:
            anchor = edges
        paths.append(dest)
        log.append(
            {
                "slot": slot.isoformat(),
                "used": used.isoformat(),
                "status": "ok" if used == slot else "substitute",
            }
        )
    return paths, log


def encode(paths: list[Path], fetch_log: list[dict] | None = None, *, no_mp4: bool = False) -> None:
    if len(paths) < 2:
        raise SystemExit("need at least 2 good frames to encode")
    fps = len(paths) / DURATION_SEC
    print(f"encode {len(paths)} frames → {DURATION_SEC:.0f}s @ {fps:.3f} fps", flush=True)

    mid = paths[len(paths) // 2]
    # Real JPEG poster (cache files may be PNG bytes).
    Image.open(mid).convert("RGB").save(OUT_POSTER, quality=90, optimize=True)

    # Scrub plates for the live app (snappy drawImage path).
    OUT_FRAMES.mkdir(parents=True, exist_ok=True)
    for old in list(OUT_FRAMES.glob("*.jpg")) + list(OUT_FRAMES.glob("*.webp")):
        old.unlink()
    print(f"scrub frames → {OUT_FRAMES} @ {SCRUB_SIZE}px webp", flush=True)
    for i, src in enumerate(paths):
        im = Image.open(src).convert("RGB").resize(
            (SCRUB_SIZE, SCRUB_SIZE), Image.Resampling.LANCZOS
        )
        im.save(OUT_FRAMES / f"{i:04d}.webp", format="WEBP", quality=90, method=4)
        if i % 50 == 0:
            print(f"  frame {i}/{len(paths)}", flush=True)
    OUT_FRAMES_META.write_text(
        json.dumps(
            {
                "count": len(paths),
                "size": SCRUB_SIZE,
                "start": T0.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "end": T1.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "durationSec": DURATION_SEC,
                "imageScale": IMAGE_SCALE,
                "bakeSize": SIZE,
                "pattern": "frames/{i:04d}.webp",
            },
            indent=2,
        )
        + "\n"
    )

    if no_mp4:
        print("skip mp4 (--no-mp4); scrub frames are enough for the app", flush=True)
    else:
        ffmpeg = which_ffmpeg()
        list_file = CACHE / "concat.txt"
        list_file.write_text("".join(f"file '{p.resolve()}'\n" for p in paths))
        subprocess.check_call(
            [
                ffmpeg,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-r",
                f"{fps:.6f}",
                "-i",
                str(list_file),
                "-vf",
                f"scale={SIZE}:{SIZE}:flags=lanczos,format=yuv420p",
                "-c:v",
                "libx264",
                "-preset",
                "slow",
                "-crf",
                "18",
                "-movflags",
                "+faststart",
                "-an",
                str(OUT_MP4),
            ]
        )
        print("wrote", OUT_MP4, OUT_MP4.stat().st_size, flush=True)

    skipped = sum(1 for e in (fetch_log or []) if e.get("status") == "skip")
    subs = sum(1 for e in (fetch_log or []) if e.get("status") == "substitute")
    meta = {
        "kind": "carrington-171-loop",
        "source": "AIA 171 via Helioviewer",
        "start": T0.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end": T1.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stepHours": 1,
        "frames": len(paths),
        "skipped": skipped,
        "substituted": subs,
        "durationSec": DURATION_SEC,
        "fps": round(fps, 4),
        "size": SIZE,
        "imageScale": IMAGE_SCALE,
        "file": OUT_MP4.name,
        "poster": OUT_POSTER.name,
        "scrubFrames": len(paths),
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n")
    print("wrote", OUT_FRAMES_META, flush=True)
    print("wrote", OUT_META, flush=True)
    print(
        f"covered window {T0.strftime('%Y-%m-%dT%H:%M:%SZ')} → "
        f"{T1.strftime('%Y-%m-%dT%H:%M:%SZ')} ({len(paths)} frames)",
        flush=True,
    )


def main() -> None:
    global T0, T1
    T0, T1 = resolve_window(sys.argv)
    print(
        f"window {T0.strftime('%Y-%m-%dT%H:%M:%SZ')} → "
        f"{T1.strftime('%Y-%m-%dT%H:%M:%SZ')} "
        f"({STEP.total_seconds() / 3600:.0f}h steps, {len(frame_times())} slots)",
        flush=True,
    )
    encode_only = "--encode" in sys.argv
    no_mp4 = "--no-mp4" in sys.argv
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    fetch_log: list[dict] | None = None
    if encode_only:
        slots = frame_times()
        if limit is not None:
            slots = slots[:limit]
        paths = []
        for slot in slots:
            dest = CACHE / f"{slot.strftime('%Y%m%dT%H%M%S')}.jpg"
            if dest.exists() and is_good_frame(dest):
                paths.append(dest)
            elif dest.exists():
                print("drop bad cached", dest.name, flush=True)
        print(f"encode-only: {len(paths)} good cached frames", flush=True)
    else:
        paths, fetch_log = fetch_all(limit)
        (CACHE / "fetch-log.json").write_text(json.dumps(fetch_log, indent=2) + "\n")
    encode(paths, fetch_log, no_mp4=no_mp4)
    subprocess.check_call([sys.executable, str(ROOT / "scripts" / "bump-version.py")])


if __name__ == "__main__":
    main()
