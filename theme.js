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
    if (icon) {
      icon.className = theme === "light" ? "ti ti-moon" : "ti ti-sun";
    }
    const btn = document.querySelector(".tm-theme-toggle");
    if (btn && !icon) {
      btn.textContent = theme === "light" ? "☀️" : "🌙";
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
    const btn = document.querySelector(".tm-theme-toggle");
    if (btn) {
      btn.setAttribute("aria-label", next === "light" ? "다크 모드로 전환" : "라이트 모드로 전환");
      btn.setAttribute("title", next === "light" ? "다크 모드" : "라이트 모드");
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(current === "light" ? "dark" : "light");
  }

  function ensureThemeToggle() {
    const header = document.querySelector(".tm-site-header");
    if (!header || header.querySelector(".tm-theme-toggle")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "theme-toggle";
    btn.className = "tm-theme-toggle";
    btn.innerHTML = '<i class="ti ti-sun" id="theme-icon" aria-hidden="true"></i>';
    btn.addEventListener("click", toggleTheme);
    header.appendChild(btn);
    applyTheme(getStoredTheme());
  }

  applyTheme(getStoredTheme());

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureThemeToggle, { once: true });
  } else {
    ensureThemeToggle();
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
