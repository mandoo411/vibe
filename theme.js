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

  function applyTheme(theme) {
    const next = normalizeTheme(theme);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch (_) {}
    setMetaThemeColor(next);
    const btn = document.querySelector(".tm-theme-toggle");
    if (btn) {
      btn.textContent = next === "light" ? "☀️" : "🌙";
      btn.setAttribute("aria-label", next === "light" ? "다크 모드로 전환" : "라이트 모드로 전환");
      btn.setAttribute("title", next === "light" ? "다크 모드" : "라이트 모드");
    }
  }

  function ensureThemeToggle() {
    const header = document.querySelector(".tm-site-header");
    if (!header || header.querySelector(".tm-theme-toggle")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tm-theme-toggle";
    btn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "dark";
      applyTheme(current === "light" ? "dark" : "light");
    });
    header.appendChild(btn);
    applyTheme(getStoredTheme());
  }

  applyTheme(getStoredTheme());

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureThemeToggle, { once: true });
  } else {
    ensureThemeToggle();
  }

  window.tmApplyTheme = applyTheme;
})();
