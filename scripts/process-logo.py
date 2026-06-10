"""Export coin logo PNG with transparent background (grey or black backdrop)."""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "assets" / "totalmoney_ai.png"


def color_dist(a: tuple[int, ...], b: tuple[float, ...]) -> float:
    return math.sqrt(sum((float(a[i]) - b[i]) ** 2 for i in range(3)))


def corner_bg(px, w: int, h: int, margin: int = 32) -> tuple[float, float, float]:
    samples: list[tuple[int, int, int]] = []
    for y in range(margin):
        for x in range(margin):
            samples.append(px[x, y][:3])
            samples.append(px[w - 1 - x, y][:3])
            samples.append(px[x, h - 1 - y][:3])
            samples.append(px[w - 1 - x, h - 1 - y][:3])
    rs = sorted(s[0] for s in samples)
    gs = sorted(s[1] for s in samples)
    bs = sorted(s[2] for s in samples)
    mid = len(rs) // 2
    return (float(rs[mid]), float(gs[mid]), float(bs[mid]))


def is_backdrop(r: int, g: int, b: int, bg: tuple[float, float, float]) -> bool:
    dist = color_dist((r, g, b), bg)
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    bg_lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]
    # Flat grey studio backdrop or black letterbox
    if dist < 48:
        return True
    if lum < 42 and bg_lum < 60:
        return True
    if lum < 28:
        return True
    return False


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else OUT

    img = Image.open(src).convert("RGBA")
    w, h = img.size
    px = img.load()
    bg = corner_bg(px, w, h)
    cx, cy = w / 2.0, h / 2.0
    coin_r = min(cx, cy) * 0.94

    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            rad = math.hypot(x - cx, y - cy)
            if rad > coin_r or is_backdrop(r, g, b, bg):
                px[x, y] = (r, g, b, 0)
                continue
            if coin_r - 3 < rad <= coin_r + 1:
                t = (rad - (coin_r - 3)) / 4.0
                t = max(0.0, min(1.0, t))
                px[x, y] = (r, g, b, int(a * (1 - t)))

    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    img = img.resize((256, 256), Image.Resampling.LANCZOS)

    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "PNG", optimize=True)
    print(f"Wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
