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
    market:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 4V20H20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="7,15 11,10 14,13 19,6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    schedule:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="17" rx="2" stroke="currentColor" stroke-width="1.8"/><line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="1.8"/><line x1="8" y1="3" x2="8" y2="7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="16" y1="3" x2="16" y2="7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    analysis:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.8"/><circle cx="8" cy="12" r="2" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="13" x2="17" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  const BOTTOM_NAV_LABELS = {
    home: "홈",
    market: "지표",
    realtime: "시세",
    us: "미국주식",
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

  const BOTTOM_NAV_PRIMARY = ["home", "market", "realtime", "us"];

  /** AI 종목분석 접근 제한 (베타) */
  const ANALYSIS_PAGE_LOCKED = true;
  const ANALYSIS_HREF = "./stock-analysis.html";

  /**
   * 2026-07-11: 과거 베타 기간에 있던 ?betakey= 우회 장치(localStorage에 영구 저장되어
   * 로그인 없이 게이트를 통과시킴)를 완전히 제거했다. 그 키가 이 파일(공개 소스)에 평문으로
   * 노출되어 있었고, 한 번이라도 그 파라미터가 붙은 링크로 접속한 브라우저는 로그인 여부와
   * 무관하게 영구적으로 게이트가 풀리는 실질적 보안 구멍이었다 — "게이트 팝업이 떴다가
   * 바로 사라지고 검색 화면으로 넘어간다"는 버그의 원인. 이제는 오직 실제 로그인/구독
   * 상태(window.TM_AUTH_STATE)만으로 접근 여부를 판단한다.
   */
  function authState() {
    return window.TM_AUTH_STATE || { loaded: false, isLoggedIn: false, hasProAccess: false, setupPending: true };
  }

  function hasAnalysisBetaAccess() {
    const st = authState();
    if (st.setupPending) return false;
    return !!st.isLoggedIn;
  }

  const TM_ALL_PAGES = [
    { id: "home", href: "./index.html", label: "홈", icon: "ti-home" },
    { id: "realtime", href: "./realtime.html", label: "실시간시세", icon: "ti-activity" },
    { id: "analysis", href: "./stock-analysis.html", label: "AI 종목분석", icon: "ti-robot" },
    { id: "schedule", href: "./weekly-market.html", label: "일정", icon: "ti-calendar" },
    { id: "briefing", href: "./briefing.html", label: "브리핑", icon: "ti-file-description" },
    { id: "daily", href: "./daily-market.html", label: "마감시황", icon: "ti-chart-bar" },
    { id: "market", href: "./market.html", label: "시장지표", icon: "ti-chart-line" },
    { id: "us", href: "./us-market.html", label: "미국주식", icon: "ti-building-skyscraper" },
    { id: "crypto", href: "./crypto.html", label: "암호화폐", icon: "ti-currency-bitcoin" },
    { id: "world", href: "./world-market.html", label: "글로벌랭킹", icon: "ti-world" },
    { id: "pricing", href: "./pricing.html", label: "요금제", icon: "ti-credit-card" },
  ];

  /** 전체 메뉴 시트 (행 우선). "account"는 로그인 상태에 따라 로그인/마이페이지로 동적 표시. */
  const NAV_SHEET_GRID = [
    ["home", "realtime", "analysis"],
    ["schedule", "briefing", "daily"],
    ["market", "us", "crypto"],
    ["world", "account", "pricing"],
  ];

  const NAV_SHEET_LABELS = {
    home: "홈",
    realtime: "시세",
    analysis: "AI분석",
    schedule: "일정",
    briefing: "브리핑",
    daily: "마감시황",
    market: "시장지표",
    us: "미국주식",
    crypto: "암호화폐",
    world: "글로벌랭킹",
    account: "계정",
    pricing: "요금제",
  };

  const PATH_TO_PAGE_ID = {
    "/": "home",
    "/index.html": "home",
    "/daily-market.html": "daily",
    "/market.html": "market",
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
      '<h2 id="ai-access-gate-title" class="ai-access-gate__title">이용 가능 여부 확인 중</h2>' +
      '<p id="ai-access-gate-text" class="ai-access-gate__text">잠시만 기다려 주세요…</p>' +
      '<a id="ai-access-gate-btn" class="ai-access-gate__btn" href="./index.html">홈으로 돌아가기</a>' +
      '<p id="ai-access-gate-secondary" class="ai-access-gate__secondary" hidden></p>' +
      "</div>";
    document.body.insertBefore(gate, document.body.firstChild);
  }

  function updateAnalysisGateContent() {
    const gate = document.getElementById("ai-access-gate");
    if (!gate) return;
    const st = authState();
    const titleEl = gate.querySelector("#ai-access-gate-title");
    const textEl = gate.querySelector("#ai-access-gate-text");
    const btnEl = gate.querySelector("#ai-access-gate-btn");
    const secondaryEl = gate.querySelector("#ai-access-gate-secondary");
    if (!titleEl || !textEl || !btnEl) return;
    if (st.setupPending) {
      titleEl.textContent = "서비스 준비 중";
      textEl.innerHTML = "AI 종목분석은 현재 베타 테스트 중입니다.<br>정식 오픈 시 알림을 드리겠습니다.";
      btnEl.textContent = "홈으로 돌아가기";
      btnEl.setAttribute("href", "./index.html");
      if (secondaryEl) secondaryEl.hidden = true;
    } else if (!st.isLoggedIn) {
      titleEl.textContent = "회원가입이 필요합니다";
      textEl.innerHTML = "AI 종목분석은 회원가입 후 이용하실 수 있습니다.<br>무료 회원가입 시 매월 체험 3회가 제공됩니다.";
      btnEl.textContent = "회원가입 하러 가기";
      btnEl.setAttribute("href", "./signup.html?next=/stock-analysis.html");
      if (secondaryEl) {
        secondaryEl.hidden = false;
        secondaryEl.innerHTML = '이미 계정이 있으신가요? <a href="./login.html?next=/stock-analysis.html">로그인</a>';
      }
    } else {
      titleEl.textContent = "AI 종목분석 이용 안내";
      textEl.innerHTML = "무료 플랜은 매월 체험 횟수가 제한됩니다.<br>Pro 플랜으로 업그레이드하면 무제한 이용 가능합니다.";
      btnEl.textContent = "요금제 보기";
      btnEl.setAttribute("href", "./pricing.html");
      if (secondaryEl) secondaryEl.hidden = true;
    }
  }

  function openAnalysisGate() {
    ensureAnalysisGate();
    updateAnalysisGateContent();
    const gate = document.getElementById("ai-access-gate");
    if (gate) gate.hidden = false;
    document.body.classList.add("ai-access-gate-open");
    setNavSheetOpen(false);
  }

  function bindAnalysisGateTrigger(el) {
    if (!el || el.dataset.analysisGateBound === "1") return;
    el.dataset.analysisGateBound = "1";
    el.addEventListener("click", (e) => {
      if (ANALYSIS_PAGE_LOCKED && !hasAnalysisBetaAccess()) {
        e.preventDefault();
        openAnalysisGate();
        return;
      }
      if (el.tagName === "BUTTON") {
        e.preventDefault();
        window.location.href = ANALYSIS_HREF;
      }
    });
  }

  function lockAnalysisNavLink(el) {
    if (!el) return;
    el.classList.add("home-nav__link--analysis-locked");
    el.classList.remove("is-disabled", "home-nav__link--disabled", "tm-bottom-nav__item--disabled");
    el.removeAttribute("aria-current");
    el.setAttribute("aria-disabled", "true");
    bindAnalysisGateTrigger(el);
  }

  function unlockAnalysisNavLink(el) {
    if (!el) return;
    el.classList.remove("home-nav__link--analysis-locked");
    el.removeAttribute("aria-disabled");
    if (getCurrentPageId() === "analysis") {
      el.setAttribute("aria-current", "page");
    }
  }

  function applyAnalysisNavLock() {
    if (!ANALYSIS_PAGE_LOCKED) return;
    const locked = !hasAnalysisBetaAccess();
    if (locked) document.querySelectorAll(".home-nav__soon-badge").forEach((el) => el.remove());
    document.querySelectorAll('a[href*="stock-analysis.html"]').forEach((el) => {
      if (el.closest(".ai-access-gate")) return;
      if (locked) lockAnalysisNavLink(el);
      else unlockAnalysisNavLink(el);
    });
    document.querySelectorAll("[data-analysis-locked]").forEach((el) => {
      el.classList.toggle("home-nav__link--analysis-locked", locked);
      bindAnalysisGateTrigger(el);
    });
    if (document.getElementById("ai-access-gate-title")) updateAnalysisGateContent();
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

  function liveDotHtml(live) {
    const on = live === true;
    const cls = on ? "tm-live-dot--live" : "tm-live-dot--closed";
    const title = on ? "실시간" : "장 마감";
    return `<span class="tm-live-dot ${cls}" aria-hidden="true" title="${title}"></span>`;
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
        const itemsHtml = items
          .map((item) => {
            const pctHtml = tickerPctHtml(item);
            return `<div class="home-ticker__item">${liveDotHtml(item.live)}<span class="home-ticker__name">${item.label || "-"}</span><span class="home-ticker__val">${formatTickerValue(item)}</span>${pctHtml}</div>`;
          })
          .join("");
        // 주식방송 자막처럼 좌측으로 끊김없이 흐르게: 동일 항목을 두 번 이어붙여
        // .home-ticker__track을 -50% 만큼 translateX 하면 이음매가 보이지 않는다.
        el.innerHTML = `<div class="home-ticker__track">${itemsHtml}${itemsHtml}</div>`;
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

  let requestNavRecalc = null;

  /* 2026-07-17: "우선순위 네비게이션" — 데스크톱 GNB에 메뉴 항목이 늘어나면서 화면에
     다 안 들어가는 경우가 생겨, 스크롤(숨겨진 스크롤바 때문에 "잘려보임") 대신 우선순위가
     낮은 항목부터 "더보기" 드롭다운으로 자동 이동시킨다. 화면이 넓으면 전부 펼쳐지고,
     좋아지면 "더보기" 자체가 사라진다 — 가로 스크롤이나 잘림 없이 항상 다 들어간다. */

  /* 숫자가 작을수록 우선순위 높음(화면이 좍을 때 더 오래 남아있음) — PRO 기능과 핵심
     트래픽 페이지를 우선, 보조 정보성 페이지(일정/글로벌랑킹 등)를 먼저 "더보기"로 보낸다. */
  // 2026-07-17: 사용자가 지정한 순서(홈 브리핑 마감시황 실시간시세 일정 매매시그널
  // AI종목분석 더보기...)를 그대로 우선순위로 씀 — 이 순서의 항목들이 좁은 화면에서도
  // 가장 먼저 노출되고, 나머지(시장지표/미국주식/암호화폐/글로벌랭킹)가 먼저 "더보기"로
  // 밀려난다. 실제 노출 순서는 DOM 순서(각 HTML의 .home-nav__links 안 배치)를 따른다 —
  // 이 숫자는 "좁을 때 누구부터 접을지"만 결정한다.
  // 2026-07-18: 사용자 지정 순서(홈 시장지표 브리핑 마감시황 일정 실시간시세 미국주식
  // 매매시그널 AI종목분석 더보기...)를 우선순위로 반영.
  const NAV_PRIORITY = {
    "./market.html": 1,
    "./briefing.html": 2,
    "./daily-market.html": 3,
    "./weekly-market.html": 4,
    "./realtime.html": 5,
    "./us-market.html": 6,
    "./trade-signal.html": 7,
    "./stock-analysis.html": 8,
    "./crypto.html": 9,
    "./world-market.html": 10,
  };

  function bindNavPriorityMenu() {
    const nav = document.querySelector(".home-nav");
    const menu = document.querySelector(".home-nav__menu");
    const linksWrap = document.getElementById("home-nav-links");
    const moreWrap = document.getElementById("home-nav-more");
    const moreBtn = document.getElementById("home-nav-more-btn");
    const morePanel = document.getElementById("home-nav-more-panel");
    if (!nav || !menu || !linksWrap || !moreWrap || !moreBtn || !morePanel) return;

    const items = Array.from(linksWrap.querySelectorAll(":scope > .home-nav__link")).map((el) => ({
      el,
      width: 0,
      priority: NAV_PRIORITY[el.getAttribute("href") || ""] ?? 99,
    }));
    if (!items.length) return;

    // 자연 폭은 한 번만 측정(리사이즈마다 다시 측정하면 레이아웃 스래싱 발생)
    items.forEach((it) => {
      it.el.hidden = false;
      it.width = it.el.offsetWidth;
    });

    let raf = 0;
    function recalc() {
      // 현재 페이지 링크는 우선순위와 상관없이 항상 보이도록 0순위로 취급
      const rank = items
        .map((it, idx) => ({ idx, priority: it.el.hasAttribute("aria-current") ? -1 : it.priority }))
        .sort((a, b) => a.priority - b.priority);

      const gap = parseFloat(getComputedStyle(linksWrap).columnGap || getComputedStyle(linksWrap).gap) || 6;
      const available = linksWrap.clientWidth;

      const visible = new Set();
      let used = 0;
      for (const { idx } of rank) {
        const w = items[idx].width;
        const next = used + (visible.size > 0 ? gap : 0) + w;
        // 2026-07-18: continue를 쓰면 폭이 좁은 낮은 우선순위 항목이 넓은 높은
        // 우선순위 항목을 건너뛰고 먼저 끼어들어가 보이는 문제(매매시그널/AI종목분석은
        // 더보기로 밀리는데 암호화폐가 그 자리를 채우는 문제)가 생긴다.
        // 우선순위 순서를 그대로 지키기 위해 안 들어가는 순간 바로 멈춘다.
        if (next > available && visible.size > 0) break;
        visible.add(idx);
        used = next;
      }

      function applyVisibility() {
        const hiddenCount = items.reduce((n, it, idx) => n + (visible.has(idx) ? 0 : 1), 0);
        if (hiddenCount > 0) {
          moreWrap.classList.add("has-overflow");
          // 더보기 패널 안은 항상 원래 링크 순서(DOM 순서)로 정리
          items.forEach((it, idx) => {
            if (visible.has(idx)) linksWrap.appendChild(it.el);
            else morePanel.appendChild(it.el);
          });
        } else {
          moreWrap.classList.remove("has-overflow");
          moreWrap.classList.remove("is-open");
          moreBtn.setAttribute("aria-expanded", "false");
          items.forEach((it) => linksWrap.appendChild(it.el));
        }
      }

      applyVisibility();
      nav.classList.add("home-nav--priority-ready");

      // 2026-07-17: 사전 계산한 폭이 폰트 로딩/서브픽셀 반올림 등으로 실제 렌더링과
      // 살짝 어긋나면(예: "매매시그널 PRO"가 "더보기"와 겹쳐 보이던 버그) overflow:hidden
      // 만으로는 "잘린 링크"가 남을 수 있어 — 실측값(scrollWidth)으로 한 번 더 확인해
      // 여전히 넘치면 낮은 우선순위 항목부터 실제로 안 들어갈 때까지 계속 더보기로 옮긴다.
      let guard = items.length;
      while (guard-- > 0 && linksWrap.scrollWidth > linksWrap.clientWidth + 1) {
        const rankVisible = rank.filter(({ idx }) => visible.has(idx));
        const worst = rankVisible[rankVisible.length - 1];
        if (!worst) break;
        visible.delete(worst.idx);
        applyVisibility();
      }
    }

    function scheduleRecalc() {
      // 2026-07-17: 백그라운드 탭(document.hidden===true)에서는 requestAnimationFrame
      // 콜백이 브라우저에 의해 사실상 무기한 지연/차단된다 — 탭 안에서 링크 폭 측정
      // 자체는 정상이지만(레이아웃은 계속 계산됨) rAF만 안 돌아서 "더보기" 정리가
      // 영원히 안 되는 경우가 있었다. 보이는 탭이면 즉시 실행하고, rAF는 리사이즈처럼
      // 짧은 시간에 여러 번 발생하는 이벤트를 한 프레임으로 묶는 용도로만 쓴다.
      if (raf) cancelAnimationFrame(raf);
      if (document.visibilityState === "visible") {
        raf = requestAnimationFrame(recalc);
      } else {
        recalc();
      }
    }

    requestNavRecalc = scheduleRecalc;
    scheduleRecalc();
    window.addEventListener("resize", scheduleRecalc);
    // 백그라운드 탭에서 로드된 경우를 대비해, 탭이 실제로 보이게 되는 시점에 한 번 더
    // 재계산해 확실히 맞춰준다.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") scheduleRecalc();
    });

    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !moreWrap.classList.contains("is-open");
      moreWrap.classList.toggle("is-open", open);
      moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", (e) => {
      if (!moreWrap.contains(e.target)) {
        moreWrap.classList.remove("is-open");
        moreBtn.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        moreWrap.classList.remove("is-open");
        moreBtn.setAttribute("aria-expanded", "false");
      }
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
    const st = authState();
    const accountHref = st.isLoggedIn ? "./mypage.html" : "./login.html";
    const accountLabel = st.isLoggedIn ? "마이페이지" : "로그인";
    const accountIcon = st.isLoggedIn ? "ti-user-circle" : "ti-login";
    const cells = NAV_SHEET_GRID.flat()
      .map((id) => {
        if (id === "account") {
          return (
            `<a class="tm-nav-sheet__cell" href="${accountHref}" data-tm-page="account" id="tm-nav-sheet-account">` +
            `<i class="ti ${accountIcon}" aria-hidden="true"></i><span>${accountLabel}</span></a>`
          );
        }
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
        if (ANALYSIS_PAGE_LOCKED && !hasAnalysisBetaAccess()) {
          e.preventDefault();
          openAnalysisGate();
        }
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
    // 2026-07-11: 기본값을 곧바로 "로그인"으로 박아두지 않는다 — 로그인 상태 확인이
    // 끝나기 전까지는 home-nav__account-link--pending 클래스로 숨겨 두고, 확인이 끝나면
    // updateMobileAccountLink()가 실제 상태에 맞는 라벨과 함께 한 번만 보여준다. 예전엔
    // 항상 "로그인"을 먼저 그렸다가 인증 완료 후 "마이페이지"로 바꿔서, 로그인된 사용자도
    // 페이지 이동/마이페이지 클릭마다 "로그인" 버튼이 잠깐 보였다 바뀌는 깜빡임이 있었다.
    meta.innerHTML =
      '<div class="home-nav__live" aria-label="실시간">' +
      '<span class="home-nav__live-dot" aria-hidden="true"></span>' +
      '<span class="home-nav__live-text">LIVE</span></div>' +
      '<button type="button" class="home-nav__theme home-nav__theme--header tm-theme-toggle" aria-label="테마 전환" title="테마 전환">' +
      '<i class="ti ti-moon" data-theme-icon-mobile aria-hidden="true"></i></button>' +
      '<a class="home-nav__theme home-nav__theme--header home-nav__account-link home-nav__account-link--pending" id="home-nav__account-link" href="./login.html" aria-label="로그인" title="로그인">' +
      '<i class="ti ti-login" aria-hidden="true"></i><span class="home-nav__account-link-label">로그인</span></a>';
    updateMobileAccountLink();
  }

  /** 모바일 상단바 계정 버튼 — 로그인 상태에 따라 아이콘+텍스트 라벨을 로그인/마이페이지로 갱신.
   * 상태 확인이 아직 끝나지 않았으면(!st.loaded) 아무것도 바꾸지 않고 숨김 상태를 유지한다 —
   * 그래야 "로그인"으로 잘못 확정 표시했다가 로그인 상태로 바뀌는 깜빡임이 생기지 않는다. */
  function updateMobileAccountLink() {
    const el = document.getElementById("home-nav__account-link");
    if (!el) return;
    const st = authState();
    if (!st.loaded) return;
    el.classList.remove("home-nav__account-link--pending");
    if (st.isLoggedIn) {
      el.setAttribute("href", "./mypage.html");
      el.setAttribute("aria-label", "마이페이지");
      el.setAttribute("title", "마이페이지");
      el.innerHTML = '<i class="ti ti-user-circle" aria-hidden="true"></i><span class="home-nav__account-link-label">마이페이지</span>';
    } else {
      el.setAttribute("href", "./login.html");
      el.setAttribute("aria-label", "로그인");
      el.setAttribute("title", "로그인");
      el.innerHTML = '<i class="ti ti-login" aria-hidden="true"></i><span class="home-nav__account-link-label">로그인</span>';
    }
  }

  /* 2026-07-17: 예전엔 "AI 종목분석" 링크를 .home-nav__menu의 직계 자식으로 강제 이동시켜
     로그인/테마 버튼 바로 옆에 고정시켰다. 지금은 .home-nav__links(우선순위 네비게이션)
     안에서 최우선순위(가장 늦게 접힘)로 처리되므로 굳이 DOM을 옮길 필요가 없다 — 오히려
     .home-nav__links 밖으로 빼내면 폭 계산에서 빠져 다른 항목과 겹쳐 보이는 버그가 생겼다.
     하위 호환을 위해 함수/전역 노출은 남겨두되, 우선순위 네비 재계산만 요청하도록 바꾼다. */
  function reorderGnbAnalysisLink() {
    if (typeof requestNavRecalc === "function") requestNavRecalc();
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
    bindNavPriorityMenu();
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

  document.addEventListener("tm-auth-ready", applyAnalysisNavLock);
  document.addEventListener("tm-auth-ready", updateMobileAccountLink);
  // 로그인/마이페이지 링크(.home-nav__auth-link)가 로그인 상태에 따라 폭이 달라지므로,
  // 인증 상태가 확정된 뒤에도 우선순위 네비게이션 폭 계산을 다시 실행한다.
  document.addEventListener("tm-auth-ready", () => {
    if (typeof requestNavRecalc === "function") requestNavRecalc();
  });

  /**
   * 2026-07-11: 모바일 브라우저(특히 iOS Safari)는 뒤로가기/스와이프로 돌아올 때 페이지를
   * 다시 로드하지 않고 bfcache(back-forward cache)에 저장해둔 이전 DOM 상태를 그대로
   * 복원한다. 예전에 접근 가능했던 상태(게이트가 이미 해제된 화면)가 그대로 보일 수 있으므로,
   * pageshow에서 event.persisted === true(캐시 복원)면 잠금 상태를 강제로 다시 계산한다.
   */
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    // bfcache 복원 시 window.TM_AUTH_STATE도 그 시점(캐시 당시)의 스냅샷이라 로그인/로그아웃이
    // 그 사이 바뀌었을 수 있다. 세션을 먼저 새로 확인한 뒤 잠금/버튼 상태를 다시 계산한다.
    if (window.TMAuth && typeof window.TMAuth.refreshState === "function") {
      window.TMAuth.refreshState().then(() => {
        applyAnalysisNavLock();
        updateMobileAccountLink();
      });
    } else {
      applyAnalysisNavLock();
      updateMobileAccountLink();
    }
  });

  window.tmHasAnalysisAccess = hasAnalysisBetaAccess;
  window.tmOpenAnalysisGate = openAnalysisGate;
  window.tmEnsureAnalysisGate = ensureAnalysisGate;
  window.tmReorderGnbAnalysisLink = reorderGnbAnalysisLink;
})();
