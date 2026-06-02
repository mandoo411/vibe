(function () {
  const BOTTOM_NAV_ICONS = {
    home:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 12L12 3L21 12V21H15V15H9V21H3V12Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    realtime:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><polyline points="4,17 9,11 13,14 20,7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="17,7 20,7 20,10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    crypto:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M9 8.5H13.5C14.6 8.5 15.5 9.4 15.5 10.5C15.5 11.6 14.6 12.5 13.5 12.5H9V8.5Z" stroke="currentColor" stroke-width="1.5"/><path d="M9 12.5H14C15.1 12.5 16 13.4 16 14.5C16 15.6 15.1 16.5 14 16.5H9V12.5Z" stroke="currentColor" stroke-width="1.5"/></svg>',
    schedule:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="17" rx="2" stroke="currentColor" stroke-width="1.8"/><line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="1.8"/><line x1="8" y1="3" x2="8" y2="7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="16" y1="3" x2="16" y2="7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    analysis:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.8"/><circle cx="8" cy="12" r="2" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="13" x2="17" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  const BOTTOM_NAV_LABELS = {
    home: "홈",
    realtime: "시세",
    crypto: "코인",
    schedule: "일정",
    analysis: "AI분석",
    menu: "전체",
  };

  const BOTTOM_NAV_MENU_ICON =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<rect x="3" y="3" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.8"/>' +
    '<rect x="13" y="3" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.8"/>' +
    '<rect x="3" y="13" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.8"/>' +
    '<rect x="13" y="13" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.8"/></svg>';

  const BOTTOM_NAV_PRIMARY = ["home", "realtime", "analysis", "crypto"];

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

  function formatTickerPct(value) {
    if (value == null || value === "") return "";
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  }

  function renderTicker() {
    const el = document.getElementById("home-ticker");
    if (!el) return;
    fetch("/api/market-ticker?t=" + Date.now(), { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((data) => {
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) {
          el.innerHTML = '<span class="home-empty">시장 지표 로딩 중…</span>';
          return;
        }
        el.innerHTML = items
          .map((item) => {
            const pct = Number(item.changePct);
            const cls = Number.isFinite(pct) && pct > 0 ? "is-up" : Number.isFinite(pct) && pct < 0 ? "is-down" : "";
            const pctHtml =
              Number.isFinite(pct) ? `<span class="home-ticker__pct ${cls}">${formatTickerPct(pct)}</span>` : "";
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
    const el = document.createElement(isMenu ? "button" : "a");
    el.className = "tm-bottom-nav__item" + (isMenu ? " tm-bottom-nav__item--menu" : "");
    el.dataset.tmTab = tabId;
    if (isMenu) {
      el.type = "button";
      el.setAttribute("aria-label", "전체 메뉴");
      el.setAttribute("aria-controls", "tm-nav-sheet");
      el.setAttribute("aria-expanded", "false");
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
      if (e.target.closest(".tm-bottom-nav__item--menu")) {
        e.preventDefault();
        const sheet = document.getElementById("tm-nav-sheet");
        setNavSheetOpen(!(sheet && sheet.classList.contains("is-open")));
        return;
      }
      if (e.target.closest("[data-close-sheet]")) setNavSheetOpen(false);
      if (e.target.closest(".tm-nav-sheet__cell")) setNavSheetOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setNavSheetOpen(false);
    });
  }

  function rebuildBottomNav() {
    document.querySelectorAll(".tm-bottom-nav").forEach((nav) => {
      nav.classList.add("tm-bottom-nav--v2");
      nav.replaceChildren();
      BOTTOM_NAV_PRIMARY.forEach((id) => nav.appendChild(createBottomNavItem(id)));
      nav.appendChild(createBottomNavItem("menu"));
    });
    bindNavSheet();
    bindBottomNavActive();
  }

  function bindShellClock() {
    const el = document.getElementById("home-m-clock");
    if (!el) return;
    const tick = () => {
      const now = new Date();
      const parts = new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(now);
      const get = (type) => parts.find((p) => p.type === type)?.value || "";
      el.textContent = `${get("hour")}:${get("minute")}:${get("second")}`;
      el.setAttribute("datetime", now.toISOString());
    };
    tick();
    setInterval(tick, 1000);
  }

  function injectMobileMeta() {
    const nav = document.querySelector(".home-nav");
    if (!nav || nav.querySelector(".home-nav__m-meta")) return;
    const toggle = nav.querySelector(".home-nav__toggle");
    const meta = document.createElement("div");
    meta.className = "home-nav__m-meta";
    meta.innerHTML =
      '<div class="home-nav__live" aria-label="실시간">' +
      '<span class="home-nav__live-dot" aria-hidden="true"></span>' +
      '<span class="home-nav__live-text">LIVE</span></div>' +
      '<time class="home-nav__m-clock" id="home-m-clock" datetime="">--:--:--</time>';
    if (toggle) nav.insertBefore(meta, toggle);
    else nav.appendChild(meta);
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
    injectMobileMeta();
    bindShellClock();
    rebuildBottomNav();
  }

  function boot() {
    enhanceShell();
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
