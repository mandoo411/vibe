(function () {
  const COIN_COLORS = { BTC: "#f7931a", ETH: "#627eea", XRP: "#346aa9", USDT: "#26a17b" };
  const COIN_SYMBOLS = ["BTC", "ETH", "XRP", "USDT"];

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toNum(v) {
    const n = Number(String(v == null ? "" : v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function seoulYmd() {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  function chgClass(pct, hero) {
    const n = toNum(pct);
    if (n == null || n === 0) return "";
    return n > 0 ? "is-up" : "is-down";
  }

  function fmtPct(pct) {
    const n = toNum(pct);
    if (n == null) return "";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  }

  function fmtTickerValue(item) {
    if (!item || item.value == null) return "—";
    const v = Number(item.value);
    if (!Number.isFinite(v)) return "—";
    const label = String(item.label || "");
    if (/비트코인|BTC/i.test(label)) return `$${Math.round(v).toLocaleString("ko-KR")}`;
    if (label.includes("원/달러")) return v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    if (/유가|금/.test(label)) return v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    return v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  }

  function fmtHeroValue(item, kind) {
    if (!item || item.value == null) return "—";
    const v = Number(item.value);
    if (!Number.isFinite(v)) return "—";
    if (kind === "usd" || kind === "crypto") {
      if (v >= 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
      if (v >= 1) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
      return `$${v.toFixed(4)}`;
    }
    if (kind === "krw") return `${Math.round(v).toLocaleString("ko-KR")}원`;
    return v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  }

  function renderTicker(items) {
    const el = $("home-ticker");
    if (!el) return;
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      el.innerHTML = '<span class="home-empty">시장 지표 로딩 중…</span>';
      return;
    }
    el.innerHTML = list
      .map((item) => {
        const pct = toNum(item.changePct);
        const pctCls = chgClass(pct);
        const pctHtml = pct != null ? `<span class="home-ticker__pct ${pctCls}">${escapeHtml(fmtPct(pct))}</span>` : "";
        return `<div class="home-ticker__item"><span class="home-ticker__name">${escapeHtml(item.label)}</span><span class="home-ticker__val">${escapeHtml(fmtTickerValue(item))}</span>${pctHtml}</div>`;
      })
      .join("");
  }

  function renderHeroPanel(panelId, rows, kind) {
    const el = $(panelId);
    if (!el) return;
    el.innerHTML = rows
      .map((row) => {
        const pct = toNum(row.changePct);
        const cls = chgClass(pct, true);
        const val = fmtHeroValue(row, kind);
        const pctStr = pct != null ? ` ${fmtPct(pct)}` : "";
        return `<div class="home-hero__row"><span class="home-hero__row-name">${escapeHtml(row.label)}</span><span class="home-hero__row-val ${cls}">${escapeHtml(val + pctStr)}</span></div>`;
      })
      .join("");
  }

  function renderHeroPanels(hub) {
    if (!hub) return;
    renderHeroPanel("hero-panel-index", [
      { label: "코스피", value: hub.kospi?.value, changePct: hub.kospi?.changePct },
      { label: "코스닥", value: hub.kosdaq?.value, changePct: hub.kosdaq?.changePct },
      { label: "나스닥선물", value: hub.nasdaqFutures?.value, changePct: hub.nasdaqFutures?.changePct },
    ], "index");
    renderHeroPanel("hero-panel-kr", [
      { label: "삼성전자", value: hub.samsung?.value, changePct: hub.samsung?.changePct },
      { label: "SK하이닉스", value: hub.skhynix?.value, changePct: hub.skhynix?.changePct },
      { label: "현대차", value: hub.hyundai?.value, changePct: hub.hyundai?.changePct },
    ], "krw");
    renderHeroPanel("hero-panel-crypto", [
      { label: "Bitcoin", value: hub.btc?.value, changePct: hub.btc?.changePct },
      { label: "Ethereum", value: hub.eth?.value, changePct: hub.eth?.changePct },
      { label: "XRP", value: hub.xrp?.value, changePct: hub.xrp?.changePct },
    ], "crypto");
    renderHeroPanel("hero-panel-us", [
      { label: "NVDA", value: hub.nvda?.value, changePct: hub.nvda?.changePct },
      { label: "AAPL", value: hub.aapl?.value, changePct: hub.aapl?.changePct },
      { label: "GOOG", value: hub.goog?.value, changePct: hub.goog?.changePct },
    ], "usd");
  }

  function renderDomesticTable(stocks) {
    const el = $("home-kr-top10");
    if (!el) return;
    const rows = (stocks || []).slice(0, 10);
    if (!rows.length) {
      el.innerHTML = '<p class="home-empty">데이터를 불러오는 중…</p>';
      return;
    }
    el.innerHTML = rows
      .map((r) => {
        const rank = r.rank != null ? r.rank : "";
        const rankCls = rank >= 1 && rank <= 3 ? " is-top3" : "";
        const pct = toNum(r.changePct);
        const chgCls = chgClass(pct);
        const price = r.price != null ? Number(String(r.price).replace(/,/g, "")).toLocaleString("ko-KR") : "—";
        return `<a class="home-tr" href="./realtime.html"><div class="home-tr__rank${rankCls}">${escapeHtml(rank)}</div><div><div class="home-tr__name">${escapeHtml(r.name)}</div><div class="home-tr__code">${escapeHtml(r.code)}</div></div><div class="home-tr__price">${escapeHtml(price)}</div><div class="home-tr__chg ${chgCls}">${escapeHtml(fmtPct(pct) || "—")}</div></a>`;
      })
      .join("");
  }

  function renderUsTable(indices, stocks) {
    const el = $("home-us-body");
    if (!el) return;
    const symMap = new Map((stocks || []).map((s) => [String(s.ticker || s.symbol || "").toUpperCase(), s]));
    const pick = ["NVDA", "AAPL", "GOOG"].map((sym) => {
      const live = symMap.get(sym);
      if (live) return { ...live, symbol: live.ticker || live.symbol || sym };
      return { symbol: sym, name: sym, price: null, changePct: null };
    });

    const idxPick = (indices || []).filter((r) => r.id === "sp500" || r.id === "nasdaq");

    const all = [
      ...pick.map((r) => ({ ...r, name: r.name || r.symbol, isIndex: false })),
      ...idxPick.map((r) => ({
        symbol: r.symbol || r.id,
        name: r.name,
        price: r.price,
        changePct: r.changePct,
        isIndex: true,
      })),
    ];

    if (!all.length) {
      el.innerHTML = '<p class="home-empty">데이터를 불러오는 중…</p>';
      return;
    }

    el.innerHTML = all
      .map((r) => {
        const pct = toNum(r.changePct);
        const chgCls = chgClass(pct);
        let price = "—";
        const pv = toNum(r.price);
        if (pv != null) {
          price = r.isIndex ? pv.toLocaleString("en-US", { maximumFractionDigits: 2 }) : `$${pv.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
        }
        return `<div class="home-tr"><div class="home-tr__rank">●</div><div><div class="home-tr__name">${escapeHtml(r.name)}</div>${r.symbol && !r.isIndex ? `<div class="home-tr__code">${escapeHtml(r.symbol)}</div>` : ""}</div><div class="home-tr__price">${escapeHtml(price)}</div><div class="home-tr__chg ${chgCls}">${escapeHtml(fmtPct(pct) || "—")}</div></div>`;
      })
      .join("");
  }

  function renderCryptoTable(coins) {
    const el = $("home-crypto-body");
    if (!el) return;
    const bySym = new Map((coins || []).map((c) => [String(c.symbol || "").toUpperCase(), c]));
    const rows = COIN_SYMBOLS.map((sym) => bySym.get(sym)).filter(Boolean);
    if (!rows.length) {
      el.innerHTML = '<p class="home-empty">데이터를 불러오는 중…</p>';
      return;
    }
    el.innerHTML = rows
      .map((c) => {
        const sym = String(c.symbol || "").toUpperCase();
        const pct = toNum(c.change24h ?? c.changePct);
        const chgCls = chgClass(pct);
        const pv = toNum(c.priceUsd ?? c.price);
        let price = "—";
        if (pv != null) {
          price = pv >= 1 ? `$${pv.toLocaleString("en-US", { maximumFractionDigits: pv >= 100 ? 0 : 2 })}` : `$${pv.toFixed(4)}`;
        }
        const bg = COIN_COLORS[sym] || "#888";
        return `<a class="home-tr home-tr--coin" href="./crypto.html"><div><div class="home-coin-icon" style="background:${bg}">${escapeHtml(sym.charAt(0))}</div></div><div><div class="home-tr__name">${escapeHtml(c.name || sym)}</div><div class="home-tr__code">${escapeHtml(sym)}</div></div><div class="home-tr__price">${escapeHtml(price)}</div><div class="home-tr__chg ${chgCls}">${escapeHtml(fmtPct(pct) || "0.00%")}</div></a>`;
      })
      .join("");
  }

  function impBadge(row) {
    const imp = String(row.impact || "").toLowerCase();
    const n = toNum(row.importance);
    if (imp === "high" || n >= 3) return '<span class="home-imp--h">HIGH</span>';
    if (imp === "medium" || n === 2) return '<span class="home-imp--m">MID</span>';
    return '<span class="home-imp--m">MID</span>';
  }

  function renderSchedule(rows) {
    const el = $("home-schedule-body");
    if (!el) return;
    const today = seoulYmd();
    const list = (rows || []).filter((r) => String(r.date || "").slice(0, 10) === today).slice(0, 4);
    if (!list.length) {
      el.innerHTML = '<p class="home-empty">오늘 예정된 지표가 없습니다.</p>';
      return;
    }
    el.innerHTML =
      list
        .map((r) => {
          const label = `${escapeHtml(r.time || "")} ${escapeHtml(r.event || "")} ${escapeHtml(r.country || "")}`.trim();
          return `<div class="home-mini-row"><span class="home-mini-row__name">${label}</span>${impBadge(r)}</div>`;
        })
        .join("") + '<div style="margin-top:8px"><a class="home-section__more" href="./weekly-market.html">전체 일정 보기 →</a></div>';
  }

  function renderBriefing(data) {
    const textEl = $("home-brief-text");
    const timeEl = $("home-brief-time");
    if (!textEl) return;
    const ai = data && data.aiAnalysis ? data.aiAnalysis : {};
    const text = ai.domesticImpact || (Array.isArray(ai.keyIssues) ? ai.keyIssues[0] : "") || "브리핑 데이터를 불러오는 중…";
    textEl.textContent = String(text).slice(0, 220) + (String(text).length > 220 ? "…" : "");
    if (timeEl) {
      const t = data?.updatedAt || data?.meta?.lastUpdatedKst || "";
      timeEl.textContent = t ? `${String(t).replace("T", " ").slice(0, 19)} 업데이트` : "";
    }
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchDataJson(path) {
    if (typeof tmFetchJson === "function") return tmFetchJson(path);
    const t = Date.now();
    const urls = [`/api/repo-data?path=${encodeURIComponent(path)}&t=${t}`, `./${path}?t=${t}`];
    for (const url of urls) {
      try {
        return await fetchJson(url);
      } catch (_) {
        /* next */
      }
    }
    throw new Error("data fetch failed");
  }

  async function loadTickerAndHero() {
    try {
      const data = await fetchJson("/api/market-ticker?t=" + Date.now());
      renderTicker(data.items);
      renderHeroPanels(data.hub);
    } catch (_) {
      renderTicker([]);
    }
  }

  async function loadDomesticTop10() {
    try {
      const data = await fetchJson("/api/kis-realtime-data?action=market-cap&page=1&pageSize=10&t=" + Date.now());
      renderDomesticTable(data.stocks);
    } catch (_) {
      renderDomesticTable([]);
    }
  }

  async function loadUsAndCrypto() {
    let indices = [];
    let usStocks = [];
    let coins = [];
    let hub = null;
    try {
      const ticker = await fetchJson("/api/market-ticker?t=" + Date.now());
      hub = ticker.hub;
    } catch (_) {}
    try {
      const us = await fetchJson("/api/us-market-data?action=indices&t=" + Date.now());
      indices = us.indices || [];
    } catch (_) {}
    try {
      const cap = await fetchJson("/api/us-market-data?action=market-cap&t=" + Date.now());
      usStocks = cap.stocks || [];
    } catch (_) {}
    try {
      const briefing = await fetchDataJson("data/morning-briefing.json");
      if (!usStocks.length && briefing.topStocks) usStocks = briefing.topStocks;
      if (!indices.length && briefing.usMarket?.indices) {
        indices = briefing.usMarket.indices.map((r) => ({
          id: r.id,
          name: r.name,
          symbol: r.symbol,
          price: r.close,
          changePct: r.changePct,
        }));
      }
    } catch (_) {}
    if (hub) {
      const hubStocks = [
        { ticker: "NVDA", name: "NVDA", price: hub.nvda?.value, changePct: hub.nvda?.changePct },
        { ticker: "AAPL", name: "AAPL", price: hub.aapl?.value, changePct: hub.aapl?.changePct },
        { ticker: "GOOG", name: "GOOG", price: hub.goog?.value, changePct: hub.goog?.changePct },
      ];
      const byTicker = new Map(usStocks.map((s) => [String(s.ticker || s.symbol || "").toUpperCase(), s]));
      hubStocks.forEach((s) => {
        const cur = byTicker.get(s.ticker);
        if (!cur || cur.price == null) byTicker.set(s.ticker, { ...s, ...cur });
      });
      usStocks = [...byTicker.values()];
    }
    try {
      const crypto = await fetchJson("/api/crypto-data?action=listings&t=" + Date.now());
      coins = crypto.coins || [];
    } catch (_) {}
    renderUsTable(indices, usStocks);
    renderCryptoTable(coins);
  }

  async function loadSideCards() {
    try {
      const schedule = await fetchDataJson("data/weekly-schedule.json");
      renderSchedule(schedule.economicCalendar);
    } catch (_) {
      renderSchedule([]);
    }
    try {
      const briefing = await fetchDataJson("data/morning-briefing.json");
      renderBriefing(briefing);
    } catch (_) {
      renderBriefing(null);
    }
  }

  function bindAiForm() {
    const form = $("home-ai-form");
    if (!form) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("home-ai-input");
      const q = input && input.value ? String(input.value).trim() : "";
      if (!q) return;
      window.location.href = `./stock-analysis.html?q=${encodeURIComponent(q)}`;
    });
  }

  function bindNavToggle() {
    const nav = document.querySelector(".home-nav");
    const btn = document.querySelector(".home-nav__toggle");
    if (!nav || !btn) return;
    btn.addEventListener("click", () => nav.classList.toggle("is-open"));
    document.addEventListener("click", (e) => {
      if (window.innerWidth > 768) return;
      if (!nav.contains(e.target)) nav.classList.remove("is-open");
    });
  }

  async function boot() {
    bindAiForm();
    bindNavToggle();
    await Promise.all([loadTickerAndHero(), loadDomesticTop10(), loadUsAndCrypto(), loadSideCards()]);
    setInterval(loadTickerAndHero, 5 * 60 * 1000);
    setInterval(loadDomesticTop10, 5 * 60 * 1000);
    setInterval(loadUsAndCrypto, 5 * 60 * 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
