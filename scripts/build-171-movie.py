#!/usr/bin/env python3
"""Bake a Carrington-rotation AIA 171 movie for SuperSun.

One full solar turn of full-disk 171 frames (disk + real corona), every 2 hours,
encoded as a ~12 second seamless loop — same idea as the GB loop
(Sep 14 → Oct 11, 2-hour cadence, 12 seconds).

Usage:
  python3 scripts/build-171-movie.py           # fetch + encode
  python3 scripts/build-171-movie.py --encode  # encode only from cache
  python3 scripts/build-171-movie.py --limit 12  # smoke test
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".sun-cache" / "movie-2h"
OUT_MP4 = ROOT / "carrington-171.mp4"
OUT_WEBM = ROOT / "carrington-171.webm"
OUT_POSTER = ROOT / "carrington-171-poster.jpg"
OUT_META = ROOT / "movie.json"

AIA171 = 10
# Match the GB loop description: Sep 14 → Oct 11, one Carrington turn.
T0 = datetime(2026, 9, 14, 0, 0, tzinfo=timezone.utc)
T1 = datetime(2026, 10, 11, 0, 0, tzinfo=timezone.utc)
STEP = timedelta(hours=2)
DURATION_SEC = 12.0
SIZE = 1536  # square full-disk; corona included in the frame


def which_ffmpeg() -> str:
    for name in ("ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        path = shutil.which(name) if "/" not in name else name
        if path and Path(path).exists():
            return path
    raise SystemExit("ffmpeg not found — install with: brew install ffmpeg")


def frame_times() -> list[datetime]:
    times = []
    t = T0
    while t <= T1:
        times.append(t)
        t += STEP
    return times


def fetch_one(when: datetime, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 50_000:
        return
    date = when.strftime("%Y-%m-%dT%H:%M:%SZ")
    # imageScale ~0.6″/px at 1536 keeps the full disk + corona in frame.
    url = (
        "https://api.helioviewer.org/v2/takeScreenshot/"
        f"?imageScale=0.65&layers=[{AIA171},1,100]&events=&eventLabels=false"
        f"&scale=false&date={date}&x0=0&y0=0&width={SIZE}&height={SIZE}"
        "&display=true&watermark=false"
    )
    print("  download", date, flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "supersun-app-movie"})
    part = dest.with_suffix(".part")
    last_exc = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                part.write_bytes(res.read())
            last_exc = None
            break
        except Exception as exc:
            last_exc = exc
            part.unlink(missing_ok=True)
            if attempt < 2:
                print("  retry", date, attempt + 1, flush=True)
    if last_exc:
        raise SystemExit(f"download failed for {date}: {last_exc}") from last_exc
    if part.stat().st_size < 50_000:
        part.unlink(missing_ok=True)
        raise SystemExit(f"download too small for {date}")
    part.replace(dest)


def fetch_all(limit: int | None) -> list[Path]:
    CACHE.mkdir(parents=True, exist_ok=True)
    times = frame_times()
    if limit is not None:
        times = times[:limit]
    paths = []
    for i, when in enumerate(times):
        dest = CACHE / f"{when.strftime('%Y%m%dT%H%M%S')}.jpg"
        print(f"[{i + 1}/{len(times)}]", flush=True)
        fetch_one(when, dest)
        paths.append(dest)
    return paths


def encode(paths: list[Path]) -> None:
    if len(paths) < 2:
        raise SystemExit("need at least 2 frames to encode")
    ffmpeg = which_ffmpeg()
    fps = len(paths) / DURATION_SEC
    list_file = CACHE / "concat.txt"
    # ffmpeg concat demuxer — one file per line
    list_file.write_text("".join(f"file '{p.resolve()}'\n" for p in paths))
    print(f"encode {len(paths)} frames → {DURATION_SEC:.0f}s @ {fps:.3f} fps", flush=True)

    # Poster = middle frame
    mid = paths[len(paths) // 2]
    shutil.copyfile(mid, OUT_POSTER)

    common = [
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
        "format=yuv420p",
    ]
    subprocess.check_call(
        [
            *common,
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
    # WebM for Safari-friendly progressive where mp4 is awkward; Safari prefers mp4.
    try:
        subprocess.check_call(
            [
                *common,
                "-c:v",
                "libvpx-vp9",
                "-b:v",
                "0",
                "-crf",
                "28",
                "-an",
                str(OUT_WEBM),
            ]
        )
    except subprocess.CalledProcessError:
        print("webm encode skipped (vp9 unavailable)", flush=True)
        if OUT_WEBM.exists():
            OUT_WEBM.unlink()

    meta = {
        "kind": "carrington-171-loop",
        "source": "AIA 171 via Helioviewer",
        "start": T0.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end": T1.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stepHours": 2,
        "frames": len(paths),
        "durationSec": DURATION_SEC,
        "fps": round(fps, 4),
        "size": SIZE,
        "file": OUT_MP4.name,
        "poster": OUT_POSTER.name,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n")
    print("wrote", OUT_MP4, OUT_MP4.stat().st_size, flush=True)
    print("wrote", OUT_META, flush=True)


def main() -> None:
    encode_only = "--encode" in sys.argv
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    if encode_only:
        paths = sorted(CACHE.glob("20*.jpg"))
        if limit is not None:
            paths = paths[:limit]
    else:
        paths = fetch_all(limit)
    encode(paths)


if __name__ == "__main__":
    main()
