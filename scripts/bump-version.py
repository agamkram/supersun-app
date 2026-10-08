#!/usr/bin/env python3
"""Bump the visible SuperSun build marker. JS and the surface image share it."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
SUN = ROOT / "sun.js"


def current() -> int:
    text = INDEX.read_text()
    m = re.search(r'data-build="s(\d+)"', text)
    if not m:
        raise SystemExit("no data-build marker in index.html")
    return int(m.group(1))


def write(n: int) -> None:
    index = INDEX.read_text()
    index2, c1 = re.subn(r'data-build="s\d+"', f'data-build="s{n}"', index)
    index2, c2 = re.subn(r"\./sun\.js\?v=\d+", f"./sun.js?v={n}", index2)
    if c1 < 1 or c2 != 1:
        raise SystemExit(f"index replacements build={c1} script={c2}")
    INDEX.write_text(index2)
    sun = SUN.read_text()
    sun2, c3 = re.subn(r"sun-2k\.jpg\?v=\d+", f"sun-2k.jpg?v={n}", sun)
    if c3 != 2:
        raise SystemExit(f"sun.js texture query count {c3}")
    SUN.write_text(sun2)


def main() -> None:
    n = current()
    if "--check" in sys.argv:
        sun = SUN.read_text()
        index = INDEX.read_text()
        if f"./sun.js?v={n}" not in index or f"sun-2k.jpg?v={n}" not in sun:
            raise SystemExit(f"s{n} is not consistent")
        if index.count(f'data-build="s{n}"') < 1:
            raise SystemExit("marker missing")
        print(f"s{n}")
        return
    write(n + 1)
    print(f"s{n + 1}")


if __name__ == "__main__":
    main()
