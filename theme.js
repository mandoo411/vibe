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
    if (meta) meta.setAttribute("content", theme === "light" ? "#ffffff" : "#0d172a");
  }

  function updateThemeIcon(theme) {
    const iconClass = theme === "light" ? "ti ti-moon" : "ti ti-sun";
    const glyph = theme === "light" ? "🌙" : "☀️";
    const label = theme === "light" ? "다크 모드로 전환" : "라이트 모드로 전환";
    const title = theme === "light" ? "다크 모드" : "라이트 모드";
    document.querySelectorAll("#theme-icon, [data-theme-icon-mobile]").forEach((icon) => {
      icon.className = iconClass;
      icon.textContent = "";
    });
    document.querySelectorAll(".tm-theme-toggle, #theme-toggle").forEach((btn) => {
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", title);
      btn.setAttribute("data-fallback", glyph);
      if (!btn.querySelector("i") && !btn.querySelector("#theme-icon")) {
        btn.textContent = glyph;
      }
    });
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
    setTimeout(() => refreshTradingViewIframes(), 0);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    applyTheme(current === "light" ? "dark" : "light");
  }

  function bindThemeToggle() {
    document.querySelectorAll(".tm-theme-toggle, #theme-toggle").forEach((btn) => {
      if (!btn || btn.dataset.tmBound === "1") return;
      btn.dataset.tmBound = "1";
      btn.addEventListener("click", toggleTheme);
    });
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

  function tradingViewIsDark() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }

  /** TradingView widgetembed candle/bar colors + pane background */
  function tradingViewCandleOverrides(isDark) {
    const bg = isDark ? "#131722" : "#ffffff";
    const grid = isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.06)";
    const text = isDark ? "#d1d4dc" : "#131722";
    return {
      "mainSeriesProperties.candleStyle.upColor": "#e24b4a",
      "mainSeriesProperties.candleStyle.downColor": "#3b82f6",
      "mainSeriesProperties.candleStyle.borderUpColor": "#e24b4a",
      "mainSeriesProperties.candleStyle.borderDownColor": "#3b82f6",
      "mainSeriesProperties.candleStyle.wickUpColor": "#e24b4a",
      "mainSeriesProperties.candleStyle.wickDownColor": "#3b82f6",
      "mainSeriesProperties.barStyle.upColor": "#e24b4a",
      "mainSeriesProperties.barStyle.downColor": "#3b82f6",
      "mainSeriesProperties.hollowCandleStyle.upColor": "#e24b4a",
      "mainSeriesProperties.hollowCandleStyle.downColor": "#3b82f6",
      "paneProperties.background": bg,
      "paneProperties.backgroundType": "solid",
      "paneProperties.vertGridProperties.color": grid,
      "paneProperties.horzGridProperties.color": grid,
      "paneProperties.legendProperties.textColor": text,
      "scalesProperties.textColor": text,
      "scalesProperties.lineColor": grid,
    };
  }

  function tradingViewStudiesOverrides() {
    return {
      "volume.volume.color.0": "#3b82f6",
      "volume.volume.color.1": "#e24b4a",
    };
  }

  function tradingViewWidgetEmbedUrl(symbol, options) {
    const opts = options && typeof options === "object" ? options : {};
    const isDark = tradingViewIsDark();
    const theme = isDark ? "dark" : "light";
    const chartBg = isDark ? "#131722" : "#ffffff";
    const params = new URLSearchParams({
      symbol: String(symbol || "NASDAQ:AAPL"),
      interval: opts.interval || "D",
      timezone: "Asia/Seoul",
      theme,
      style: "1",
      locale: "kr",
      toolbar_bg: chartBg,
      bgcolor: chartBg,
      gridcolor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
      hide_side_toolbar: "0",
      allow_symbol_change: "1",
      save_image: "0",
      calendar: "0",
      withdateranges: "1",
      hideideas: "1",
      up_color: "#e24b4a",
      down_color: "#3b82f6",
      border_up_color: "#e24b4a",
      border_down_color: "#3b82f6",
      wick_up_color: "#e24b4a",
      wick_down_color: "#3b82f6",
    });
    // 2026-07-11: 거래량 바 색상이 캔들 색상과 다르게 나오는 문제 — TradingView 위젯이
    // 거래량 스터디를 자동으로 붙일 때도 있고 안 붙일 때도 있어서, studies_overrides의
    // volume.volume.color.* 가 어떤 인스턴스에 적용될지 불확실했다. 항상 명시적으로
    // Volume 스터디를 요청해서(같은 known id) 오버라이드가 확실히 그 인스턴스에 걸리게 한다.
    const studies = Array.isArray(opts.studies) ? opts.studies.slice() : [];
    if (!opts.noVolume && !studies.some((s) => /volume/i.test(String(s)))) {
      studies.push("Volume@tv-basicstudies");
    }
    if (studies.length) params.set("studies", JSON.stringify(studies));
    params.set("overrides", JSON.stringify(tradingViewCandleOverrides(isDark)));
    params.set("studies_overrides", JSON.stringify(tradingViewStudiesOverrides()));
    return `https://www.tradingview.com/widgetembed/?${params.toString()}`;
  }

  function refreshTradingViewIframes(selector) {
    const sel = selector || ".crypto-tv-widget, .us-tv-widget, .realtime-tv-widget, .ai-tv-widget";
    document.querySelectorAll(sel).forEach((iframe) => {
      const sym = iframe.getAttribute("data-tv-symbol");
      if (!sym) return;
      iframe.src = tradingViewWidgetEmbedUrl(sym);
    });
  }

  function chartShellFullscreenActive(shell) {
    const nativeEl =
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement;
    return nativeEl === shell || shell.classList.contains("tm-tv-chart-shell--expanded");
  }

  function setChartFullscreenBtn(btn, on) {
    if (!btn) return;
    btn.textContent = on ? "전체화면 닫기" : "전체화면";
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function rememberChartShellAnchor(shell) {
    if (shell.__tmFsAnchor) return;
    shell.__tmFsAnchor = { parent: shell.parentNode, next: shell.nextSibling };
  }

  function restoreChartShellAnchor(shell) {
    const anchor = shell.__tmFsAnchor;
    if (!anchor || !anchor.parent) return;
    if (anchor.next && anchor.next.parentNode === anchor.parent) {
      anchor.parent.insertBefore(shell, anchor.next);
    } else {
      anchor.parent.appendChild(shell);
    }
  }

  function lockChartPageScroll(lock) {
    document.documentElement.classList.toggle("tm-tv-chart-fs-lock", !!lock);
  }

  function enterChartExpandedFullscreen(shell, btn) {
    rememberChartShellAnchor(shell);
    document.body.appendChild(shell);
    shell.classList.add("tm-tv-chart-shell--expanded");
    lockChartPageScroll(true);
    setChartFullscreenBtn(btn, true);
  }

  function exitChartExpandedFullscreen(shell, btn) {
    shell.classList.remove("tm-tv-chart-shell--expanded");
    restoreChartShellAnchor(shell);
    if (!document.querySelector(".tm-tv-chart-shell--expanded")) {
      lockChartPageScroll(false);
    }
    setChartFullscreenBtn(btn, false);
  }

  async function enterChartFullscreen(shell, btn) {
    const req = shell.requestFullscreen || shell.webkitRequestFullscreen || shell.msRequestFullscreen;
    if (req && document.fullscreenEnabled !== false) {
      try {
        await req.call(shell);
        setChartFullscreenBtn(btn, true);
        return;
      } catch (_) {
        /* iOS·일부 모바일: div 전체화면 미지원 → CSS 폴백 */
      }
    }
    enterChartExpandedFullscreen(shell, btn);
  }

  function exitChartFullscreen(shell, btn) {
    const nativeEl =
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement;
    if (nativeEl === shell) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (exit) exit.call(document);
      return;
    }
    if (shell.classList.contains("tm-tv-chart-shell--expanded")) {
      exitChartExpandedFullscreen(shell, btn);
    }
  }

  function onChartNativeFullscreenChange(shell, btn) {
    const nativeEl =
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement;
    const on = nativeEl === shell;
    setChartFullscreenBtn(btn, on);
    if (!on && shell.classList.contains("tm-tv-chart-shell--expanded")) return;
    if (!on) lockChartPageScroll(false);
  }

  if (!window.__tmTvChartFsEscapeWired) {
    window.__tmTvChartFsEscapeWired = true;
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const expanded = document.querySelector(".tm-tv-chart-shell--expanded");
      if (!expanded) return;
      exitChartExpandedFullscreen(expanded, expanded.querySelector(".tm-tv-fullscreen-btn"));
    });
  }

  function wireTradingViewChartTools(root) {
    const host = root && root.querySelector ? root : document;
    host.querySelectorAll(".tm-tv-chart-shell").forEach((shell) => {
      if (shell.dataset.tvToolsWired === "1") return;
      shell.dataset.tvToolsWired = "1";
      const btn = shell.querySelector(".tm-tv-fullscreen-btn");
      if (!btn) return;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (chartShellFullscreenActive(shell)) {
          exitChartFullscreen(shell, btn);
          return;
        }
        enterChartFullscreen(shell, btn);
      });
      shell.addEventListener("fullscreenchange", () => onChartNativeFullscreenChange(shell, btn));
      shell.addEventListener("webkitfullscreenchange", () => onChartNativeFullscreenChange(shell, btn));
    });
  }

  function bindTradingViewThemeRefresh() {
    document.querySelectorAll(".tm-theme-toggle, #theme-toggle").forEach((btn) => {
      if (btn.dataset.tvThemeRefresh === "1") return;
      btn.dataset.tvThemeRefresh = "1";
      btn.addEventListener("click", () => {
        setTimeout(() => refreshTradingViewIframes(), 0);
      });
    });
  }

  window.tmApplyTheme = applyTheme;
  window.tmBindThemeToggle = bindThemeToggle;
  window.toggleTheme = toggleTheme;
  window.tmTradingViewEmbedTheme = tradingViewEmbedTheme;
  window.tmTradingViewCandleOverrides = tradingViewCandleOverrides;
  window.tmTradingViewWidgetEmbedUrl = tradingViewWidgetEmbedUrl;
  window.tmRefreshTradingViewIframes = refreshTradingViewIframes;
  window.tmWireTradingViewChartTools = wireTradingViewChartTools;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindTradingViewThemeRefresh, { once: true });
  } else {
    bindTradingViewThemeRefresh();
  }
})();
