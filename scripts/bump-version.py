#!/usr/bin/env python3
"""Bump cache-bust queries on sun.js and Carrington frame assets."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
SUN = ROOT / "sun.js"


def current() -> int:
    text = INDEX.read_text()
    m = re.search(r"\./sun\.js\?v=(\d+)", text)
    if not m:
        raise SystemExit("no sun.js?v= marker in index.html")
    return int(m.group(1))


def write(n: int) -> None:
    index = INDEX.read_text()
    index2, c1 = re.subn(r"\./sun\.js\?v=\d+", f"./sun.js?v={n}", index)
    if c1 != 1:
        raise SystemExit(f"index script query count {c1}")
    index2 = re.sub(
        r"carrington-171-poster\.jpg\?v=\d+",
        f"carrington-171-poster.jpg?v={n}",
        index2,
    )
    index2 = re.sub(r"frames\.json\?v=\d+", f"frames.json?v={n}", index2)
    INDEX.write_text(index2)

    sun = SUN.read_text()
    sun2, c2 = re.subn(
        r'frames\.json\?v=\d+',
        f"frames.json?v={n}",
        sun,
    )
    sun2, c3 = re.subn(
        r"carrington-171-poster\.jpg\?v=\d+",
        f"carrington-171-poster.jpg?v={n}",
        sun2,
    )
    sun2, c5 = re.subn(
        r"(frames/\$\{String\(i\)\.padStart\(4, \"0\"\)\}\.jpg)\?v=\d+",
        rf"\1?v={n}",
        sun2,
    )
    if c2 != 1 or c3 != 1 or c5 != 1:
        raise SystemExit(f"sun.js query counts meta={c2} poster={c3} frames={c5}")
    SUN.write_text(sun2)
    print(f"v{n}")


def main() -> None:
    n = current()
    if "--check" in sys.argv:
        sun = SUN.read_text()
        index = INDEX.read_text()
        if f"./sun.js?v={n}" not in index:
            raise SystemExit(f"v{n} is not consistent in index")
        if "build-mark" in index:
            raise SystemExit("build-mark still present in index.html")
        if f"frames.json?v={n}" not in sun:
            raise SystemExit(f"v{n} frames.json missing in sun.js")
        print(f"v{n}")
        return
    write(n + 1)


if __name__ == "__main__":
    main()
