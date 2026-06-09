(function () {
  const BOTTOM_NAV_ICONS = {
    home:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 12L12 3L21 12V21H15V15H9V21H3V12Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    realtime:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><polyline points="4,17 9,11 13,14 20,7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="17,7 20,7 20,10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    crypto:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M9 8.5H13.5C14.6 8.5 15.5 9.4 15.5 10.5C15.5 11.6 14.6 12.5 13.5 12.5H9V8.5Z" stroke="currentColor" stroke-width="1.5"/><path d="M9 12.5H14C15.1 12.5 16 13.4 16 14.5C16 15.6 15.1 16.5 14 16.5H9V12.5Z" stroke="currentColor" stroke-width="1.5"/></svg>',
    us:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="16" height="18" rx="1.5" stroke="currentColor" stroke-width="1.8"/><path d="M8 8H8.01M12 8H12.01M16 8H16.01M8 12H8.01M12 12H12.01M16 12H16.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10 16H14V21H10V16Z" stroke="currentColor" stroke-width="1.5"/></svg>',
    schedule:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="17" rx="2" stroke="currentColor" stroke-width="1.8"/><line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="1.8"/><line x1="8" y1="3" x2="8" y2="7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="16" y1="3" x2="16" y2="7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    analysis:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.8"/><circle cx="8" cy="12" r="2" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="13" x2="17" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  const BOTTOM_NAV_LABELS = {
    home: "홈",
    realtime: "시세",
    us: "미국시장",
    crypto: "암호화폐",
    schedule: "일정",
    analysis: "AI분석",
    menu: "전체보기",
  };

  const BOTTOM_NAV_MENU_ICON =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<rect x="3" y="3" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.8"/>' +
    '<rect x="13" y="3" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.8"/>' +
    '<rect x="3" y="13" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.8"/>' +
    '<rect x="13" y="13" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.8"/></svg>';

  const BOTTOM_NAV_PRIMARY = ["home", "realtime", "us", "crypto"];

  /** AI 종목분석 접근 제한 (베타) */
  const ANALYSIS_PAGE_LOCKED = true;
  const ANALYSIS_HREF = "./stock-analysis.html";

  const TM_ALL_PAGES = [
    { id: "home", href: "./index.html", label: "홈", icon: "ti-home" },
    { id: "realtime", href: "./realtime.html", label: "실시간시세", icon: "ti-activity" },
    { id: "analysis", href: "./stock-analysis.html", label: "AI 종목분석", icon: "ti-robot" },
    { id: "schedule", href: "./weekly-market.html", label: "일정", icon: "ti-calendar" },
    { id: "briefing", href: "./briefing.html", label: "브리핑", icon: "ti-file-description" },
    { id: "daily", href: "./daily-market.html", label: "마감시황", icon: "ti-chart-bar" },
    { id: "us", href: "./us-market.html", label: "미국시장", icon: "ti-building-skyscraper" },
    { id: "crypto", href: "./crypto.html", label: "암호화폐", icon: "ti-currency-bitcoin" },
    { id: "world", href: "./world-market.html", label: "글로벌랭킹", icon: "ti-world" },
  ];

  /** 전체 메뉴 시트 3×3 (행 우선) */
  const NAV_SHEET_GRID = [
    ["home", "realtime", "analysis"],
    ["schedule", "briefing", "daily"],
    ["us", "crypto", "world"],
  ];

  const NAV_SHEET_LABELS = {
    home: "홈",
    realtime: "시세",
    analysis: "AI분석",
    schedule: "일정",
    briefing: "브리핑",
    daily: "마감시황",
    us: "미국시장",
    crypto: "암호화폐",
    world: "글로벌랭킹",
  };

  const PATH_TO_PAGE_ID = {
    "/": "home",
    "/index.html": "home",
    "/daily-market.html": "daily",
    "/briefing.html": "briefing",
    "/realtime.html": "realtime",
    "/weekly-market.html": "schedule",
    "/us-market.html": "us",
    "/crypto.html": "crypto",
    "/world-market.html": "world",
    "/stock-analysis.html": "analysis",
  };

  function getCurrentPageId() {
    const path = window.location.pathname.replace(/\\/g, "/");
    const base = path.slice(path.lastIndexOf("/"));
    if (PATH_TO_PAGE_ID[base]) return PATH_TO_PAGE_ID[base];
    const file = path.split("/").pop() || "";
    const hit = TM_ALL_PAGES.find((p) => p.href.endsWith(file));
    return hit ? hit.id : null;
  }

  function ensureAnalysisGate() {
    if (document.getElementById("ai-access-gate")) return;
    const gate = document.createElement("div");
    gate.id = "ai-access-gate";
    gate.className = "ai-access-gate";
    gate.hidden = true;
    gate.setAttribute("role", "dialog");
    gate.setAttribute("aria-modal", "true");
    gate.setAttribute("aria-labelledby", "ai-access-gate-title");
    gate.innerHTML =
      '<div class="ai-access-gate__backdrop" aria-hidden="true"></div>' +
      '<div class="ai-access-gate__card">' +
      '<h2 id="ai-access-gate-title" class="ai-access-gate__title">서비스 준비 중</h2>' +
      '<p class="ai-access-gate__text">AI 종목분석은 현재 베타 테스트 중입니다.<br>정식 오픈 시 알림을 드리겠습니다.</p>' +
      '<a class="ai-access-gate__btn" href="./index.html">홈으로 돌아가기</a>' +
      "</div>";
    document.body.insertBefore(gate, document.body.firstChild);
  }

  function openAnalysisGate() {
    ensureAnalysisGate();
    const gate = document.getElementById("ai-access-gate");
    if (gate) gate.hidden = false;
    document.body.classList.add("ai-access-gate-open");
    setNavSheetOpen(false);
  }

  function bindAnalysisGateTrigger(el) {
    if (!el || el.dataset.analysisGateBound === "1") return;
    el.dataset.analysisGateBound = "1";
    el.addEventListener("click", (e) => {
      e.preventDefault();
      openAnalysisGate();
    });
  }

  function lockAnalysisNavLink(el) {
    if (!el || el.dataset.analysisLocked === "1") return;
    el.dataset.analysisLocked = "1";
    el.classList.add("home-nav__link--analysis-locked");
    el.classList.remove("is-disabled", "home-nav__link--disabled", "tm-bottom-nav__item--disabled");
    el.removeAttribute("aria-current");
    el.setAttribute("aria-disabled", "true");
    bindAnalysisGateTrigger(el);
  }

  function applyAnalysisNavLock() {
    if (!ANALYSIS_PAGE_LOCKED) return;
    document.querySelectorAll(".home-nav__soon-badge").forEach((el) => el.remove());
    document.querySelectorAll('a[href*="stock-analysis.html"]').forEach((el) => {
      if (el.closest(".ai-access-gate")) return;
      lockAnalysisNavLink(el);
    });
    document.querySelectorAll(".home-nav__link--analysis-locked").forEach((el) => {
      bindAnalysisGateTrigger(el);
    });
    document.querySelectorAll("[data-analysis-locked]").forEach(bindAnalysisGateTrigger);
  }

  function syncBodyTab() {
    const pageId = getCurrentPageId();
    if (!pageId) return;
    document.body.dataset.tmPage = pageId;
    document.body.dataset.tmTab = BOTTOM_NAV_PRIMARY.includes(pageId) ? pageId : "menu";
  }

  function formatTickerValue(item) {
    if (!item || item.value == null || item.value === "") return "—";
    const value = Number(item.value);
    if (!Number.isFinite(value)) return "—";
    const label = String(item.label || "");
    if (/비트코인|BTC/i.test(label)) return `$${Math.round(value).toLocaleString("ko-KR")}`;
    if (label.includes("원/달러")) return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    if (label.includes("유가") || label.includes("금")) return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  }

  function formatTickerPct(value, label) {
    const n = Number(value);
    const isUsdKrw = String(label || "").includes("원/달러");
    if (!Number.isFinite(n)) return isUsdKrw ? "—" : "";
    if (isUsdKrw && Math.abs(n) < 0.0001) return "—";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  }

  function tickerPctHtml(item) {
    const label = item?.label || "";
    const pct = Number(item?.changePct);
    const isUsdKrw = label.includes("원/달러");
    if (!Number.isFinite(pct)) {
      return isUsdKrw ? '<span class="home-ticker__pct">—</span>' : "";
    }
    if (isUsdKrw && Math.abs(pct) < 0.0001) {
      return '<span class="home-ticker__pct">—</span>';
    }
    const cls = pct > 0 ? "is-up" : pct < 0 ? "is-down" : "";
    return `<span class="home-ticker__pct ${cls}">${formatTickerPct(pct, label)}</span>`;
  }

  function filterWebTickerItems(items) {
    const list = Array.isArray(items) ? items : [];
    if (window.innerWidth <= 768) return list;
    return list.filter((item) => !String(item?.label || "").includes("금시세"));
  }

  window.tmFilterWebTickerItems = filterWebTickerItems;

  function renderTicker() {
    const el = document.getElementById("home-ticker");
    if (!el) return;
    fetch("/api/market-ticker?t=" + Date.now(), { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((data) => {
        const items = filterWebTickerItems(data.items);
        if (!items.length) {
          el.innerHTML = '<span class="home-empty">시장 지표 로딩 중…</span>';
          return;
        }
        el.innerHTML = items
          .map((item) => {
            const pctHtml = tickerPctHtml(item);
            return `<div class="home-ticker__item"><span class="home-ticker__name">${item.label || "-"}</span><span class="home-ticker__val">${formatTickerValue(item)}</span>${pctHtml}</div>`;
          })
          .join("");
      })
      .catch(() => {
        el.innerHTML = '<span class="home-empty">시장 지표를 불러오지 못했습니다</span>';
      });
  }

  function bindNavToggle() {
    const nav = document.querySelector(".home-nav");
    const btn = document.querySelector(".home-nav__toggle");
    if (!nav || !btn) return;
    btn.addEventListener("click", () => {
      const open = nav.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", (e) => {
      if (window.innerWidth > 768) return;
      if (!nav.contains(e.target)) nav.classList.remove("is-open");
    });
  }

  function bindBottomNavActive() {
    const pageId = getCurrentPageId();
    const sheet = document.getElementById("tm-nav-sheet");
    const sheetOpen = sheet && sheet.classList.contains("is-open");
    let barTab = BOTTOM_NAV_PRIMARY.includes(pageId) ? pageId : "menu";
    if (sheetOpen) barTab = "menu";
    document.querySelectorAll(".tm-bottom-nav__item").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.tmTab === barTab);
    });
    document.querySelectorAll(".tm-nav-sheet__cell").forEach((el) => {
      const on = pageId && el.dataset.tmPage === pageId;
      el.classList.toggle("is-active", on);
      if (on) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
  }

  function createBottomNavItem(tabId) {
    const page = TM_ALL_PAGES.find((p) => p.id === tabId);
    const isMenu = tabId === "menu";
    const isLockedAnalysis = !isMenu && tabId === "analysis" && ANALYSIS_PAGE_LOCKED;
    const el = document.createElement(isMenu || isLockedAnalysis ? "button" : "a");
    el.className = "tm-bottom-nav__item" + (isMenu ? " tm-bottom-nav__item--menu" : "");
    if (isLockedAnalysis) el.className += " tm-bottom-nav__item--analysis-locked home-nav__link--analysis-locked";
    el.dataset.tmTab = tabId;
    if (isMenu) {
      el.type = "button";
      el.setAttribute("aria-label", "전체 메뉴");
      el.setAttribute("aria-controls", "tm-nav-sheet");
      el.setAttribute("aria-expanded", "false");
    } else if (isLockedAnalysis) {
      el.type = "button";
      el.dataset.analysisLocked = "1";
    } else if (page) {
      el.href = page.href;
    }
    const iconWrap = document.createElement("span");
    iconWrap.className = "tm-bottom-nav__icon";
    iconWrap.setAttribute("aria-hidden", "true");
    iconWrap.innerHTML = isMenu ? BOTTOM_NAV_MENU_ICON : BOTTOM_NAV_ICONS[tabId] || "";
    const label = document.createElement("span");
    label.textContent = BOTTOM_NAV_LABELS[tabId] || page?.label || tabId;
    el.append(iconWrap, label);
    if (isLockedAnalysis) bindAnalysisGateTrigger(el);
    return el;
  }

  function pageById(id) {
    return TM_ALL_PAGES.find((p) => p.id === id);
  }

  function ensureNavSheet() {
    if (document.getElementById("tm-nav-sheet")) return;
    const cells = NAV_SHEET_GRID.flat()
      .map((id) => {
        const p = pageById(id);
        if (!p) return "";
        const label = NAV_SHEET_LABELS[id] || p.label;
        if (id === "analysis" && ANALYSIS_PAGE_LOCKED) {
          return (
            `<button type="button" class="tm-nav-sheet__cell home-nav__link--analysis-locked" data-tm-page="${p.id}" data-analysis-locked="1">` +
            `<i class="ti ${p.icon}" aria-hidden="true"></i><span>${label}</span></button>`
          );
        }
        return (
          `<a class="tm-nav-sheet__cell" href="${p.href}" data-tm-page="${p.id}">` +
          `<i class="ti ${p.icon}" aria-hidden="true"></i><span>${label}</span></a>`
        );
      })
      .join("");
    const body = `<div class="tm-nav-sheet__grid tm-nav-sheet__grid--9">${cells}</div>`;
    const sheet = document.createElement("div");
    sheet.id = "tm-nav-sheet";
    sheet.className = "tm-nav-sheet";
    sheet.hidden = true;
    sheet.innerHTML =
      '<div class="tm-nav-sheet__backdrop" data-close-sheet tabindex="-1"></div>' +
      '<div class="tm-nav-sheet__panel" role="dialog" aria-modal="true" aria-labelledby="tm-nav-sheet-title">' +
      '<header class="tm-nav-sheet__head"><h2 id="tm-nav-sheet-title">전체 메뉴</h2>' +
      '<button type="button" class="tm-nav-sheet__close" data-close-sheet aria-label="닫기"><i class="ti ti-x"></i></button></header>' +
      `<div class="tm-nav-sheet__body">${body}</div></div>`;
    document.body.appendChild(sheet);
  }

  let navSheetBound = false;

  function setNavSheetOpen(open) {
    const sheet = document.getElementById("tm-nav-sheet");
    if (!sheet) return;
    sheet.hidden = !open;
    sheet.classList.toggle("is-open", open);
    document.body.classList.toggle("tm-nav-sheet-open", open);
    const menuBtn = document.querySelector(".tm-bottom-nav__item--menu");
    if (menuBtn) menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) sheet.querySelector(".tm-nav-sheet__close")?.focus();
    bindBottomNavActive();
  }

  function bindNavSheet() {
    if (navSheetBound) return;
    navSheetBound = true;
    ensureNavSheet();
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-analysis-locked]")) {
        e.preventDefault();
        openAnalysisGate();
        return;
      }
      if (e.target.closest(".tm-bottom-nav__item--menu")) {
        e.preventDefault();
        const sheet = document.getElementById("tm-nav-sheet");
        setNavSheetOpen(!(sheet && sheet.classList.contains("is-open")));
        return;
      }
      if (e.target.closest("[data-close-sheet]")) setNavSheetOpen(false);
      if (e.target.closest(".tm-nav-sheet__cell:not([data-analysis-locked])")) setNavSheetOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setNavSheetOpen(false);
    });
  }

  function rebuildBottomNav() {
    document.querySelectorAll(".tm-bottom-nav").forEach((nav) => {
      nav.classList.add("tm-bottom-nav--v2");
      nav.style.transform = "none";
      nav.replaceChildren();
      BOTTOM_NAV_PRIMARY.forEach((id) => nav.appendChild(createBottomNavItem(id)));
      nav.appendChild(createBottomNavItem("menu"));
    });
    bindNavSheet();
    bindBottomNavActive();
  }

  function injectMobileMeta() {
    const nav = document.querySelector(".home-nav");
    if (!nav) return;
    let meta = nav.querySelector(".home-nav__m-meta");
    if (!meta) {
      meta = document.createElement("div");
      meta.className = "home-nav__m-meta";
      const toggle = nav.querySelector(".home-nav__toggle");
      if (toggle) nav.insertBefore(meta, toggle);
      else nav.appendChild(meta);
    }
    meta.innerHTML =
      '<div class="home-nav__live" aria-label="실시간">' +
      '<span class="home-nav__live-dot" aria-hidden="true"></span>' +
      '<span class="home-nav__live-text">LIVE</span></div>' +
      '<button type="button" class="home-nav__theme home-nav__theme--header tm-theme-toggle" aria-label="테마 전환" title="테마 전환">' +
      '<i class="ti ti-moon" data-theme-icon-mobile aria-hidden="true"></i></button>';
  }

  function reorderGnbAnalysisLink() {
    const menu = document.querySelector(".home-nav__menu");
    if (!menu) return;
    const analysis =
      menu.querySelector('a[href*="stock-analysis"]') ||
      menu.querySelector(".home-nav__link--analysis-locked");
    const themeBtn = menu.querySelector(".home-nav__theme");
    if (!analysis || !themeBtn) return;
    if (analysis.nextElementSibling === themeBtn) return;
    menu.insertBefore(analysis, themeBtn);
  }

  function wrapShellTop() {
    const wrap = document.querySelector(".tm-wrap, .home-wrap");
    const nav = wrap?.querySelector(".home-nav");
    const ticker = document.getElementById("home-ticker");
    if (!wrap || !nav || wrap.querySelector(".home-top")) return;

    const top = document.createElement("div");
    top.className = "home-top";
    nav.parentNode.insertBefore(top, nav);
    top.appendChild(nav);

    let bar = wrap.querySelector(".home-ticker-bar");
    if (ticker) {
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "home-ticker-bar";
        const label = document.createElement("span");
        label.className = "home-ticker-bar__label";
        label.textContent = "실시간";
        bar.appendChild(label);
        ticker.parentNode.insertBefore(bar, ticker);
        bar.appendChild(ticker);
      }
      if (bar.parentNode !== top) top.appendChild(bar);
    }
  }

  function enhanceShell() {
    if (!document.body.classList.contains("page-tm-v2")) return;
    syncBodyTab();
    wrapShellTop();
    reorderGnbAnalysisLink();
    injectMobileMeta();
    rebuildBottomNav();
    if (typeof window.tmBindThemeToggle === "function") {
      window.tmBindThemeToggle();
    }
    if (typeof window.tmApplyTheme === "function") {
      const cur = document.documentElement.getAttribute("data-theme") || "light";
      window.tmApplyTheme(cur);
    }
  }

  function boot() {
    enhanceShell();
    applyAnalysisNavLock();
    bindNavToggle();
    if (!document.body.classList.contains("page-home-v2")) {
      renderTicker();
      setInterval(renderTicker, 5 * 60 * 1000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
