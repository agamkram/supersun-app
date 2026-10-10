#!/usr/bin/env python3
"""Bump cache-bust queries on sun.js and the surface JPEG. No on-page build badge."""
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
    INDEX.write_text(index2)
    sun = SUN.read_text()
    sun2, c2 = re.subn(r"sun-2k\.jpg\?v=\d+", f"sun-2k.jpg?v={n}", sun)
    if c2 != 1:
        raise SystemExit(f"sun.js texture query count {c2}")
    SUN.write_text(sun2)


def main() -> None:
    n = current()
    if "--check" in sys.argv:
        sun = SUN.read_text()
        index = INDEX.read_text()
        if f"./sun.js?v={n}" not in index or f"sun-2k.jpg?v={n}" not in sun:
            raise SystemExit(f"v{n} is not consistent")
        print(f"v{n}")
        return
    write(n + 1)
    print(f"v{n + 1}")


if __name__ == "__main__":
    main()
