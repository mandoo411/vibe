(function () {
  const STORAGE_KEY = "theme";

  function normalizeTheme(value) {
    return value === "light" ? "light" : "dark";
  }

  function getStoredTheme() {
    try {
      return normalizeTheme(localStorage.getItem(STORAGE_KEY));
    } catch (_) {
      return "dark";
    }
  }

  function setMetaThemeColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#ffffff" : "#131722");
  }

  function updateThemeIcon(theme) {
    const icon = document.getElementById("theme-icon");
    const btn = document.getElementById("theme-toggle");
    const glyph = theme === "light" ? "🌙" : "☀️";
    if (icon) {
      icon.className = theme === "light" ? "ti ti-moon" : "ti ti-sun";
      icon.textContent = "";
    }
    if (btn) {
      btn.setAttribute("data-fallback", glyph);
    }
    if (!icon && btn) {
      btn.textContent = glyph;
    }
  }

  function applyTheme(theme) {
    const next = normalizeTheme(theme);
    document.documentElement.setAttribute("data-theme", next);
    document.body.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch (_) {}
    setMetaThemeColor(next);
    updateThemeIcon(next);
    const btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.setAttribute(
        "aria-label",
        next === "light" ? "다크 모드로 전환" : "라이트 모드로 전환"
      );
      btn.setAttribute("title", next === "light" ? "다크 모드" : "라이트 모드");
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(current === "light" ? "dark" : "light");
  }

  function bindThemeToggle() {
    const btn = document.getElementById("theme-toggle");
    if (!btn || btn.dataset.tmBound === "1") return;
    btn.dataset.tmBound = "1";
    btn.addEventListener("click", toggleTheme);
  }

  function initTheme() {
    applyTheme(getStoredTheme());
    bindThemeToggle();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initTheme, { once: true });
  } else {
    initTheme();
  }

  function tradingViewEmbedTheme() {
    const light = document.documentElement.getAttribute("data-theme") === "light";
    return {
      theme: light ? "light" : "dark",
      toolbar_bg: light ? "#e8ecf5" : "#1e2235",
    };
  }

  window.tmApplyTheme = applyTheme;
  window.toggleTheme = toggleTheme;
  window.tmTradingViewEmbedTheme = tradingViewEmbedTheme;
})();
