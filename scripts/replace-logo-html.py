#!/usr/bin/env python3
"""Replace image header logo with TM AI text logo in all site HTML pages."""
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

NEW = """          <a class="logo-link header-top__link" href="./index.html" aria-label="TotalMoney AI 홈">
            <div class="logo-tm-box" aria-hidden="true">
              <span class="logo-tm-text">TM</span>
              <span class="logo-ai-text">AI</span>
            </div>
            <div class="logo-text-block">
              <div class="logo-title-row">
                <span class="logo-main-text">TotalMoney</span>
                <span class="logo-ai-badge">AI</span>
              </div>
              <div class="logo-sub-text">SMARTER FINANCIAL DECISIONS</div>
            </div>
          </a>"""

OLD_BLOCKS = [
    """          <a class="header-top__link" href="./index.html" aria-label="TotalMoney AI 홈">
            <img
              class="header-top__logo"
              src="./assets/totalmoney_ai.png?v=2"
              alt=""
              width="36"
              height="36"
              decoding="async"
            />
            <span class="header-top__title">TotalMoney AI</span>
            <span class="header-top__tagline">Smarter Financial Decisions</span>
          </a>""",
    """          <a class="header-top__link" href="./index.html" aria-label="TotalMoney AI 홈">
            <img class="header-top__logo" src="./assets/totalmoney_ai.png?v=2" alt="" width="36" height="36" decoding="async" />
            <span class="header-top__title">TotalMoney AI</span>
            <span class="header-top__tagline">Smarter Financial Decisions</span>
          </a>""",
    """          <a class="header-top__link" href="./index.html" aria-label="TotalMoney AI 홈">
            <img class="header-top__logo" src="./assets/totalmoney_ai.png" alt="" width="36" height="36" decoding="async" />
            <span class="header-top__title">TotalMoney AI</span>
            <span class="header-top__tagline">Smarter Financial Decisions</span>
          </a>""",
]


def main() -> None:
    for name in FILES:
        path = ROOT / name
        text = path.read_text(encoding="utf-8")
        original = text
        for old in OLD_BLOCKS:
            text = text.replace(old, NEW)
        if text == original:
            raise SystemExit(f"No logo block replaced in {name}")
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"updated {name}")


if __name__ == "__main__":
    main()
