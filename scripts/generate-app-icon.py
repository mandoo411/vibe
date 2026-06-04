"""Generate indigo T-only app icons (not TM/AI header logo)."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"

COLOR_TOP = (85, 96, 232)
COLOR_BOTTOM = (51, 57, 191)
# 헤더 로고 박스 "AI" 텍스트와 동일 (site-shell.css #f59e0b)
LETTER_T = (245, 158, 11, 255)


def lerp(a: int, b: int, t: float) -> int:
    return int(a + (b - a) * t)


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), COLOR_BOTTOM + (255,))
    draw = ImageDraw.Draw(img)
    radius = max(4, size // 6)
    for y in range(size):
        t = y / max(size - 1, 1)
        row = (
            lerp(COLOR_TOP[0], COLOR_BOTTOM[0], t),
            lerp(COLOR_TOP[1], COLOR_BOTTOM[1], t),
            lerp(COLOR_TOP[2], COLOR_BOTTOM[2], t),
            255,
        )
        draw.line([(0, y), (size, y)], fill=row)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=None, outline=None)

    font_size = int(size * 0.62)
    try:
        font = ImageFont.truetype("arialbd.ttf", font_size)
    except OSError:
        try:
            font = ImageFont.truetype("Arial Bold.ttf", font_size)
        except OSError:
            font = ImageFont.load_default()

    text = "T"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=LETTER_T)
    return img


def save_png(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    draw_icon(size).save(path, "PNG", optimize=True)
    print(f"wrote {path} ({size}x{size}, {path.stat().st_size} bytes)")


def save_ico(path: Path) -> None:
    sizes = [16, 32, 48]
    images = [draw_icon(s).convert("RGBA") for s in sizes]
    path.parent.mkdir(parents=True, exist_ok=True)
    images[0].save(
        path,
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=images[1:],
    )
    print(f"wrote {path} ({path.stat().st_size} bytes)")


def main() -> None:
    targets = [
        (ASSETS / "icon-t-32.png", 32),
        (ASSETS / "icon-t-180.png", 180),
        (ASSETS / "icon-t-192.png", 192),
        (ROOT / "icon-t-180.png", 180),
        (ROOT / "apple-touch-icon.png", 180),
        (ROOT / "apple-touch-icon-precomposed.png", 180),
        (ASSETS / "apple-touch-icon.png", 180),
        (ASSETS / "favicon-32.png", 32),
        (ASSETS / "favicon-16.png", 16),
        (ASSETS / "favicon.png", 192),
    ]
    seen: set[tuple[str, int]] = set()
    for path, size in targets:
        key = (str(path.resolve()), size)
        if key in seen:
            continue
        seen.add(key)
        save_png(path, size)
    save_ico(ROOT / "favicon.ico")
    save_ico(ASSETS / "favicon.ico")


if __name__ == "__main__":
    main()
