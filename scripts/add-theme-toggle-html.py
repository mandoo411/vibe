#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "index.html",
    "daily-market.html",
    "briefing.html",
    "realtime.html",
    "weekly-market.html",
    "us-market.html",
    "crypto.html",
    "live-report.html",
    "world-market.html",
]

BUTTON = """
          <button
            type="button"
            class="tm-theme-toggle"
            id="theme-toggle"
            aria-label="테마 전환"
            title="테마 전환"
          >
            <i class="ti ti-sun" id="theme-icon" aria-hidden="true"></i>
          </button>"""

MARKER = '          <a class="tm-site-nav__link" href="./world-market.html"'
INSERT_AFTER = '          <a class="tm-site-nav__link" href="./world-market.html">글로벌 랭킹</a>\n'


def main() -> None:
    for name in FILES:
        path = ROOT / name
        text = path.read_text(encoding="utf-8")
        if 'id="theme-toggle"' in text:
            print(f"skip {name} (already has toggle)")
            continue
        if INSERT_AFTER not in text:
            raise SystemExit(f"anchor not found in {name}")
        text = text.replace(INSERT_AFTER, INSERT_AFTER + BUTTON + "\n", 1)
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"updated {name}")


if __name__ == "__main__":
    main()
