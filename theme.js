(function () {
  const STORAGE_KEY = "theme";

  function normalizeTheme(value) {
    return value === "dark" ? "dark" : "light";
  }

  function getStoredTheme() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark") return stored;
      return "light";
    } catch (_) {
      return "light";
    }
  }

  function setMetaThemeColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#ffffff" : "#131722");
  }

  function updateThemeIcon(theme) {
    const icon = document.getElementById("theme-icon");
    const btn = document.getElementById("theme-toggle");
    // 라이트 모드: 원 안 달(다크로 전환) · 다크 모드: 태양(라이트로 전환)
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
    if (document.body) {
      document.body.dataset.theme = next;
    }
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
    const current = document.documentElement.getAttribute("data-theme") || "light";
    applyTheme(current === "light" ? "dark" : "light");
  }

  function bindThemeToggle() {
    const btn = document.getElementById("theme-toggle");
    if (!btn || btn.dataset.tmBound === "1") return;
    btn.dataset.tmBound = "1";
    btn.addEventListener("click", toggleTheme);
  }

  // DOMContentLoaded 전에 적용해 페이지 전환 시 다크 모드 깜빡임 방지
  applyTheme(getStoredTheme());

  function onDomReady() {
    const current = document.documentElement.getAttribute("data-theme") || getStoredTheme();
    if (document.body) {
      document.body.dataset.theme = current;
    }
    updateThemeIcon(current);
    bindThemeToggle();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onDomReady, { once: true });
  } else {
    onDomReady();
  }

  function tradingViewEmbedTheme() {
    const light = document.documentElement.getAttribute("data-theme") === "light";
    return {
      theme: light ? "light" : "dark",
      toolbar_bg: light ? "#ffffff" : "#131722",
    };
  }

  /** TradingView widgetembed candle/bar colors + pane background */
  function tradingViewCandleOverrides(isDark) {
    const bg = isDark ? "#131722" : "#ffffff";
    const grid = isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.06)";
    return {
      "mainSeriesProperties.candleStyle.upColor": "#e24b4a",
      "mainSeriesProperties.candleStyle.downColor": "#3b82f6",
      "mainSeriesProperties.candleStyle.borderUpColor": "#e24b4a",
      "mainSeriesProperties.candleStyle.borderDownColor": "#3b82f6",
      "mainSeriesProperties.candleStyle.wickUpColor": "#e24b4a",
      "mainSeriesProperties.candleStyle.wickDownColor": "#3b82f6",
      "mainSeriesProperties.barStyle.upColor": "#e24b4a",
      "mainSeriesProperties.barStyle.downColor": "#3b82f6",
      "paneProperties.background": bg,
      "paneProperties.backgroundType": "solid",
      "paneProperties.vertGridProperties.color": grid,
      "paneProperties.horzGridProperties.color": grid,
    };
  }

  window.tmApplyTheme = applyTheme;
  window.toggleTheme = toggleTheme;
  window.tmTradingViewEmbedTheme = tradingViewEmbedTheme;
  window.tmTradingViewCandleOverrides = tradingViewCandleOverrides;
})();
