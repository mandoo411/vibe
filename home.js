(function () {
  const COIN_SYMBOLS = ["BTC", "ETH", "XRP"];
  const COIN_CMC_IDS = { BTC: 1, ETH: 1027, XRP: 52 };
  const COIN_NAMES_KO = { BTC: "비트코인", ETH: "이더리움", XRP: "리플" };

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

  function fmtPctParts(pct) {
    const s = fmtPct(pct);
    if (!s) return { num: "—", sym: "" };
    if (s.endsWith("%")) return { num: s.slice(0, -1), sym: "%" };
    return { num: s, sym: "" };
  }

  function homeRtPctHtml(pct, chgCls) {
    const { num, sym } = fmtPctParts(pct);
    return `<div class="home-rt-col home-rt-col--chg home-tr__chg ${chgCls}"><span class="home-rt-pct"><span class="home-rt-pct__num">${escapeHtml(num)}</span><span class="home-rt-pct__sym">${escapeHtml(sym)}</span></span></div>`;
  }

  const HOME_RT_METRIC_LABEL = {
    cap: "시가총액",
    gainers: "거래대금",
    tv: "거래대금",
  };

  function formatWonJoEok(n) {
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1e12) return `${(n / 1e12).toFixed(1)}조`;
    const eok = n / 1e8;
    if (eok >= 10000) return `${(eok / 10000).toFixed(1)}조`;
    if (eok >= 100) return `${eok.toFixed(1)}억`;
    const eokR = Math.round(eok);
    return eokR > 0 ? `${eokR}억` : "—";
  }

  function formatTradeVal(raw) {
    const n = toNum(raw);
    if (n == null || n <= 0) return "—";
    if (n >= 1e12) return `${(n / 1e12).toFixed(1)}조`;
    const eok = Math.round(n / 1e8);
    if (eok <= 0) return "—";
    if (n >= 1e11) return `${eok.toLocaleString("ko-KR")}억`;
    return `${eok}억`;
  }

  function readStckAvlsRaw(r) {
    if (!r) return null;
    const a = r.stck_avls;
    if (a != null && String(a).trim() !== "") return a;
    const b = r.mcapEok;
    if (b != null && String(b).trim() !== "") return b;
    return null;
  }

  function calcTradeValFromRow(r) {
    const p = toNum(r && r.price);
    const v = toNum(r && r.volume);
    if (p != null && v != null && p > 0 && v > 0) return Math.round(p * v);
    const tv = toNum(r && r.tradingValue);
    return tv != null && tv > 0 ? tv : null;
  }

  function formatHomeRtMetric(r, tab) {
    if (tab === "cap") {
      const raw = readStckAvlsRaw(r);
      const n = toNum(raw);
      return n != null ? formatWonJoEok(n) : "—";
    }
    const tv = calcTradeValFromRow(r);
    return tv != null ? formatTradeVal(tv) : "—";
  }

  function logoWrap(inner) {
    return `<span class="home-tr__logo-wrap">${inner}</span>`;
  }

  function stockLogoUrl(symbol) {
    const sym = String(symbol || "").toUpperCase();
    return sym ? `https://financialmodelingprep.com/image-stock/${encodeURIComponent(sym)}.png` : "";
  }

  function stockLogoFallback(symbol) {
    const sym = String(symbol || "").toUpperCase();
    return sym ? `https://companiesmarketcap.com/img/company-logos/64/${encodeURIComponent(sym)}.png` : "";
  }

  function stockLogoHtml(symbol) {
    const src = stockLogoUrl(symbol);
    if (!src) return logoWrap(`<span class="home-tr__logo home-tr__logo--fallback" aria-hidden="true">•</span>`);
    const fb = stockLogoFallback(symbol);
    return logoWrap(`<img class="home-tr__logo" src="${escapeHtml(src)}" alt="" loading="lazy" data-fallback="${escapeHtml(fb)}" onerror="homeLogoFail(this)">`);
  }

  function coinLogoUrl(coin) {
    const sym = String(coin?.symbol || "").toUpperCase();
    const id = coin?.id || COIN_CMC_IDS[sym];
    return id ? `https://s2.coinmarketcap.com/static/img/coins/64x64/${id}.png` : "";
  }

  function coinLogoHtml(coin) {
    const sym = String(coin?.symbol || "").toUpperCase();
    const src = coinLogoUrl(coin);
    if (!src) {
      return logoWrap(`<span class="home-tr__logo home-tr__logo--fallback" aria-hidden="true">${escapeHtml(sym.charAt(0) || "?")}</span>`);
    }
    return logoWrap(`<img class="home-tr__logo" src="${escapeHtml(src)}" alt="" loading="lazy" onerror="homeLogoFail(this)">`);
  }

  function identityCell(name, code, logoHtml, rank) {
    const r = Number(rank);
    const rankHtml =
      Number.isFinite(r) && r > 0
        ? `<span class="home-rank" aria-hidden="true">${escapeHtml(String(r))}</span>`
        : "";
    return `<div class="home-tr__identity">${rankHtml}${logoHtml}<div><div class="home-tr__name">${escapeHtml(name)}</div><div class="home-tr__code">${escapeHtml(code)}</div></div></div>`;
  }

  window.homeLogoFail = function homeLogoFail(img) {
    if (!img || img.dataset.failed) return;
    const fb = img.getAttribute("data-fallback");
    if (fb && !img.dataset.retried) {
      img.dataset.retried = "1";
      img.src = fb;
      return;
    }
    img.dataset.failed = "1";
    const span = document.createElement("span");
    span.className = "home-tr__logo home-tr__logo--fallback";
    span.setAttribute("aria-hidden", "true");
    span.textContent = "?";
    img.replaceWith(span);
  };

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
    const list =
      typeof window.tmFilterWebTickerItems === "function"
        ? window.tmFilterWebTickerItems(items)
        : Array.isArray(items)
          ? items
          : [];
    if (!list.length) {
      el.innerHTML = '<span class="home-empty">시장 지표 로딩 중…</span>';
      return;
    }
    el.innerHTML = list
      .map((item) => {
        const label = String(item.label || "");
        const isUsdKrw = label.includes("원/달러");
        const pct = toNum(item.changePct);
        let pctHtml = "";
        if (isUsdKrw && (pct == null || Math.abs(pct) < 0.0001)) {
          pctHtml = '<span class="home-ticker__pct">—</span>';
        } else if (pct != null) {
          const pctCls = chgClass(pct);
          pctHtml = `<span class="home-ticker__pct ${pctCls}">${escapeHtml(fmtPct(pct))}</span>`;
        } else if (isUsdKrw) {
          pctHtml = '<span class="home-ticker__pct">—</span>';
        }
        return `<div class="home-ticker__item"><span class="home-ticker__name">${escapeHtml(label)}</span><span class="home-ticker__val">${escapeHtml(fmtTickerValue(item))}</span>${pctHtml}</div>`;
      })
      .join("");
  }

  function renderHeroPanel(panelId, rows, kind) {
    const el = $(panelId);
    if (!el) return;
    el.innerHTML = rows
      .map((row) => {
        const pct = toNum(row.changePct);
        const cls = chgClass(pct);
        const val = fmtHeroValue(row, kind);
        const pctHtml =
          pct != null && row.value != null
            ? `<span class="home-hero__row-pct ${cls}">${escapeHtml(fmtPct(pct))}</span>`
            : `<span class="home-hero__row-pct">—</span>`;
        return `<div class="home-hero__row"><span class="home-hero__row-name">${escapeHtml(row.label)}</span><span class="home-hero__row-price">${escapeHtml(val)}</span>${pctHtml}</div>`;
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

  const HOME_RT_ACTION = {
    cap: "market-cap",
    gainers: "gainers",
    tv: "trading-value",
  };

  let homeRtTab = "cap";
  const homeRtCache = {};
  let homeRtRequestId = 0;

  const HOME_US_ACTION = { cap: "market-cap", gainers: "gainers", tv: "volume" };
  const HOME_US_METRIC_LABEL = {
    cap: "시가총액",
    gainers: "거래대금",
    tv: "거래대금",
  };
  let homeUsTab = "cap";

  function fmtUsdCompact(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
    return `$${Math.round(n)}`;
  }

  function readUsTradingValue(r) {
    let n = toNum(r && r.tradingValue);
    if (n == null || n <= 0) {
      const p = toNum(r && r.price);
      const v = toNum(r && r.volume);
      if (p != null && v != null && p > 0 && v > 0) n = p * v;
    }
    return n;
  }

  function formatHomeUsMetric(r, tab) {
    if (tab === "cap") {
      const n = toNum(r && r.marketCap);
      return n != null && n > 0 ? fmtUsdCompact(n) : "—";
    }
    const tv = readUsTradingValue(r);
    return tv != null && tv > 0 ? fmtUsdCompact(tv) : "—";
  }

  function syncHomeUsChrome() {
    const metricH = $("home-us-metric-h");
    if (metricH) metricH.textContent = HOME_US_METRIC_LABEL[homeUsTab] || HOME_US_METRIC_LABEL.cap;
  }

  function realtimePageHref(tab) {
    const t = HOME_RT_ACTION[tab] ? tab : "cap";
    return `./realtime.html?tab=${encodeURIComponent(t)}`;
  }

  function renderHomeRtTable(stocks) {
    const el = $("home-rt-body");
    if (!el) return;
    const rows = (stocks || []).slice(0, 10);
    if (!rows.length) {
      el.innerHTML = '<p class="home-empty">데이터를 불러오는 중…</p>';
      return;
    }
    const moreHref = realtimePageHref(homeRtTab);
    el.innerHTML = rows
      .map((r, idx) => {
        const rankHtml = `<span class="home-rank" aria-hidden="true">${escapeHtml(String(idx + 1))}</span>`;
        const pct = toNum(r.changePct);
        const chgCls = chgClass(pct);
        const price = r.price != null ? Number(String(r.price).replace(/,/g, "")).toLocaleString("ko-KR") : "—";
        const metric = formatHomeRtMetric(r, homeRtTab);
        const ariaLabel = r.code ? `${r.name} ${r.code}` : String(r.name || "");
        const displayName = String(r.name || "").trim() || "—";
        return `<a class="home-tr home-tr--rt" href="${escapeHtml(moreHref)}" aria-label="${escapeHtml(ariaLabel)}"><div class="home-rt-col home-rt-col--name">${rankHtml}<div class="home-tr__name-stack"><div class="home-tr__name">${escapeHtml(displayName)}</div><div class="home-tr__code">${escapeHtml(r.code || "")}</div></div></div><div class="home-rt-col home-rt-col--price home-tr__price">${escapeHtml(price)}</div>${homeRtPctHtml(pct, chgCls)}<div class="home-rt-col home-rt-col--metric home-tr__metric">${escapeHtml(metric)}</div></a>`;
      })
      .join("");
  }

  function syncHomeRtChrome() {
    const more = $("home-rt-more");
    if (more) more.href = realtimePageHref(homeRtTab);
    const metricH = $("home-rt-metric-h");
    if (metricH) metricH.textContent = HOME_RT_METRIC_LABEL[homeRtTab] || HOME_RT_METRIC_LABEL.cap;
    document.querySelectorAll("[data-home-rt-tab]").forEach((btn) => {
      const on = btn.getAttribute("data-home-rt-tab") === homeRtTab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  async function fetchHomeRtStocks(tab) {
    const action = HOME_RT_ACTION[tab] || HOME_RT_ACTION.cap;
    const data = await fetchJson(
      `/api/kis-realtime-data?action=${encodeURIComponent(action)}&page=1&pageSize=10&t=` + Date.now()
    );
    return Array.isArray(data.stocks) ? data.stocks : [];
  }

  async function loadHomeRtTab(tab, { background = false, force = false } = {}) {
    const key = HOME_RT_ACTION[tab] ? tab : "cap";
    let reqId = null;
    if (!background) {
      reqId = ++homeRtRequestId;
      homeRtTab = key;
      syncHomeRtChrome();
      const hit = homeRtCache[key];
      if (hit && !force) renderHomeRtTable(hit.stocks);
      else {
        const el = $("home-rt-body");
        if (el && !hit) el.innerHTML = '<p class="home-empty">로딩 중…</p>';
      }
    }
    try {
      const stocks = await fetchHomeRtStocks(key);
      homeRtCache[key] = { stocks, at: Date.now() };
      if (background) {
        if (homeRtTab === key) renderHomeRtTable(stocks);
      } else if (reqId === homeRtRequestId) {
        renderHomeRtTable(stocks);
      }
    } catch (_) {
      if (!background && homeRtTab === key && !homeRtCache[key]) renderHomeRtTable([]);
    }
  }

  function prefetchHomeRtTabs(skipTab) {
    Object.keys(HOME_RT_ACTION).forEach((tab) => {
      if (tab === skipTab) return;
      void loadHomeRtTab(tab, { background: true, force: true });
    });
  }

  function bindHomeRtTabs() {
    document.querySelectorAll("[data-home-rt-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-home-rt-tab");
        if (!tab || tab === homeRtTab) return;
        const hit = homeRtCache[tab];
        if (hit) {
          homeRtTab = tab;
          syncHomeRtChrome();
          renderHomeRtTable(hit.stocks);
          void loadHomeRtTab(tab, { background: true, force: true });
        } else {
          void loadHomeRtTab(tab);
        }
      });
    });
  }

  function renderUsTable(stocks) {
    const el = $("home-us-body");
    if (!el) return;
    const tab = HOME_US_ACTION[homeUsTab] ? homeUsTab : "cap";
    const list = Array.isArray(stocks) ? stocks.slice() : [];
    const sorted = list.sort((a, b) => {
      if (tab === "gainers") return (toNum(b?.changePct) ?? 0) - (toNum(a?.changePct) ?? 0);
      if (tab === "tv") return (toNum(b?.tradingValue) ?? 0) - (toNum(a?.tradingValue) ?? 0);
      return (toNum(b?.marketCap) ?? 0) - (toNum(a?.marketCap) ?? 0);
    });
    const rows = sorted.slice(0, 5);

    if (!rows.length) {
      el.innerHTML = '<p class="home-empty">데이터를 불러오는 중…</p>';
      return;
    }

    el.innerHTML = rows
      .map((r, idx) => {
        const sym = String(r.symbol || r.ticker || "").toUpperCase();
        const name = r.nameKo || r.name || sym || "—";
        const pct = toNum(r.changePct ?? r.changeRate);
        const chgCls = chgClass(pct);
        let price = "—";
        const pv = toNum(r.price);
        if (pv != null) {
          price = `$${pv.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
        }
        const metric = formatHomeUsMetric(r, tab);
        return `<a class="home-tr home-tr--logo home-tr--us" href="./us-market.html">${identityCell(name, sym, stockLogoHtml(sym), idx + 1)}<div class="home-tr__price">${escapeHtml(price)}</div><div class="home-tr__chg ${chgCls}">${escapeHtml(fmtPct(pct) || "—")}</div><div class="home-tr__metric">${escapeHtml(metric)}</div></a>`;
      })
      .join("");
  }

  function formatCryptoMarketCap(c) {
    const usd = toNum(c && (c.marketCapUsd ?? c.market_cap_usd));
    if (usd != null && usd > 0) return fmtUsdCompact(usd);
    const krw = toNum(c && (c.marketCapKrw ?? c.marketCap));
    if (krw != null && krw > 0) {
      if (krw >= 1e12) return `${(krw / 1e12).toFixed(1)}조`;
      if (krw >= 1e8) return `${Math.round(krw / 1e8)}억`;
      if (krw >= 1e4) return `${Math.round(krw / 1e4)}만`;
      return krw.toLocaleString("ko-KR");
    }
    return "—";
  }

  function renderCryptoTable(coins) {
    const el = $("home-crypto-body");
    if (!el) return;
    const bySym = new Map((coins || []).map((c) => [String(c.symbol || "").toUpperCase(), c]));
    const rows = COIN_SYMBOLS.map((sym) => {
      const live = bySym.get(sym);
      if (!live) return null;
      return { ...live, symbol: sym };
    }).filter(Boolean);
    if (!rows.length) {
      el.innerHTML = '<p class="home-empty">데이터를 불러오는 중…</p>';
      return;
    }
    el.innerHTML = rows
      .map((c, idx) => {
        const sym = String(c.symbol || "").toUpperCase();
        const pct = toNum(c.change24h ?? c.changePct);
        const chgCls = chgClass(pct);
        const pv = toNum(c.priceUsd ?? c.price);
        let price = "—";
        if (pv != null) {
          price = pv >= 1 ? `$${pv.toLocaleString("en-US", { maximumFractionDigits: pv >= 100 ? 0 : 2 })}` : `$${pv.toFixed(4)}`;
        }
        const name = COIN_NAMES_KO[sym] || c.name || sym;
        const mcap = formatCryptoMarketCap(c);
        return `<a class="home-tr home-tr--logo home-tr--coin" href="./crypto.html">${identityCell(name, sym, coinLogoHtml(c), idx + 1)}<div class="home-tr__price">${escapeHtml(price)}</div><div class="home-tr__chg ${chgCls}">${escapeHtml(fmtPct(pct) || "0.00%")}</div><div class="home-tr__metric">${escapeHtml(mcap)}</div></a>`;
      })
      .join("");
  }

  function impBadge(row) {
    const imp = String(row.impact || "").toLowerCase();
    const n = toNum(row.importance);
    if (imp === "high" || n >= 3) return '<span class="home-imp--h">높음</span>';
    if (imp === "medium" || n === 2) return '<span class="home-imp--m">보통</span>';
    return '<span class="home-imp--m">보통</span>';
  }

  function renderSchedule(rows) {
    const el = $("home-schedule-body");
    if (!el) return;
    const today = seoulYmd();
    const isUsKr = (r) => {
      const c = String(r?.country || "").toUpperCase();
      return c === "US" || c === "KR" || c === "미국" || c === "한국" || c === "대한민국";
    };
    const list = (rows || []).filter((r) => isUsKr(r) && String(r.date || "").slice(0, 10) === today).slice(0, 4);
    if (!list.length) {
      el.innerHTML = '<p class="home-empty">오늘 예정된 지표가 없습니다.</p>';
      return;
    }
    const trCountry =
      typeof window.tmTranslateCountry === "function"
        ? (name) => window.tmTranslateCountry(name)
        : (name) => String(name || "");

    el.innerHTML =
      list
        .map((r) => {
          const eventKo =
            typeof window.tmEventLabelText === "function"
              ? window.tmEventLabelText(r)
              : typeof window.tmTranslateIndicator === "function"
                ? window.tmTranslateIndicator(r.event)
                : String(r.event || "");
          const countryKo = trCountry(r.country);
          const label = `${escapeHtml(r.time || "")} ${escapeHtml(eventKo)} ${escapeHtml(countryKo)}`.trim();
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

  async function loadUsAndCrypto() {
    let coins = [];
    try {
      const crypto = await fetchJson("/api/crypto-data?action=listings&t=" + Date.now());
      coins = crypto.coins || [];
    } catch (_) {}
    renderCryptoTable(coins);
  }

  async function loadHomeUsTab(tab) {
    const t = HOME_US_ACTION[tab] ? tab : "cap";
    homeUsTab = t;
    syncHomeUsChrome();
    document.querySelectorAll("[data-home-us-tab]").forEach((btn) => {
      const on = btn.getAttribute("data-home-us-tab") === homeUsTab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    const el = $("home-us-body");
    if (el) el.innerHTML = '<p class="home-empty">로딩 중…</p>';

    let usStocks = [];
    try {
      const action = HOME_US_ACTION[homeUsTab] || HOME_US_ACTION.cap;
      const res = await fetchJson(`/api/us-market-data?action=${encodeURIComponent(action)}&t=` + Date.now());
      usStocks = res.stocks || [];
    } catch (_) {}
    try {
      const briefing = await fetchDataJson("data/morning-briefing.json");
      if (!usStocks.length && briefing.topStocks) usStocks = briefing.topStocks;
    } catch (_) {}
    renderUsTable(usStocks);
  }

  function bindHomeUsTabs() {
    document.querySelectorAll("[data-home-us-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-home-us-tab");
        if (!tab || tab === homeUsTab) return;
        loadHomeUsTab(tab);
      });
    });
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

  function bindMobileHomeUi() {
    const input = $("home-ai-input");
    const mq = window.matchMedia("(max-width: 768px)");
    const applyPlaceholder = () => {
      if (!input) return;
      const mPh = input.getAttribute("data-m-placeholder");
      const dPh = "종목명 입력 (예: 삼성전자, AAPL)";
      if (mq.matches && mPh) input.placeholder = mPh;
      else input.placeholder = dPh;
    };
    applyPlaceholder();
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", applyPlaceholder);
    else if (typeof mq.addListener === "function") mq.addListener(applyPlaceholder);
  }

  function aiFeedBadgeClass(direction) {
    if (direction === "매수") return "home-m-insight__badge--buy";
    if (direction === "회피") return "home-m-insight__badge--avoid";
    return "home-m-insight__badge--hold";
  }

  function aiFeedBarClass(conf) {
    if (conf == null) return "home-m-insight__bar--low";
    if (conf >= 70) return "";
    if (conf >= 50) return "home-m-insight__bar--mid";
    return "home-m-insight__bar--low";
  }

  function aiFeedPctClass(conf) {
    if (conf == null) return "home-m-insight__pct--low";
    if (conf >= 70) return "home-m-insight__pct--high";
    if (conf >= 50) return "home-m-insight__pct--mid";
    return "home-m-insight__pct--low";
  }

  function fmtFeedTime(iso) {
    try {
      return new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(iso));
    } catch (_) {
      return "";
    }
  }

  function renderMobileAiFeed(list, rows) {
    if (!rows.length) {
      list.innerHTML =
        '<li class="home-m-insight home-m-insight--empty">아직 실시간 분석 결과가 없습니다 — AI 종목분석을 이용해보세요.</li>';
      return;
    }
    list.innerHTML = rows
      .map((r) => {
        const conf = toNum(r.confidence);
        const confText = conf == null ? "—" : `${Math.round(conf)}%`;
        const barW = conf == null ? 0 : Math.max(0, Math.min(100, conf));
        return `<li class="home-m-insight">
          <div class="home-m-insight__badge ${aiFeedBadgeClass(r.direction)}">${escapeHtml(r.direction || "관망")}</div>
          <div class="home-m-insight__main">
            <div class="home-m-insight__row">
              <span class="home-m-insight__symbol">${escapeHtml(r.stock_name || "")}</span>
              <div class="home-m-insight__bar-track"><span class="home-m-insight__bar ${aiFeedBarClass(conf)}" style="width:${barW}%"></span></div>
              <span class="home-m-insight__pct ${aiFeedPctClass(conf)}">${confText}</span>
            </div>
            <p class="home-m-insight__desc">${escapeHtml(r.summary || "")}</p>
          </div>
          <time class="home-m-insight__time">${escapeHtml(fmtFeedTime(r.created_at))}</time>
        </li>`;
      })
      .join("");
  }

  function renderHeroAiFeed(list, rows) {
    if (!rows.length) {
      list.innerHTML = '<li class="home-hero__ai-empty">아직 실시간 분석 결과가 없습니다 — AI 종목분석을 이용해보세요.</li>';
      return;
    }
    list.innerHTML = rows
      .map((r) => {
        const badge = r.direction === "매수" ? "home-hero__ai-badge--buy" : r.direction === "회피" ? "home-hero__ai-badge--avoid" : "home-hero__ai-badge--hold";
        return `<li class="home-hero__ai-item">
          <span class="home-hero__ai-badge ${badge}">${escapeHtml(r.direction || "관망")}</span>
          <span class="home-hero__ai-name">${escapeHtml(r.stock_name || "")}</span>
          <span class="home-hero__ai-desc">${escapeHtml(r.summary || "")}</span>
          <span class="home-hero__ai-time">${escapeHtml(fmtFeedTime(r.created_at))}</span>
        </li>`;
      })
      .join("");
  }

  /* 홈 화면에는 모바일 전용 리스트(home-m-insights)와 데스크톱 히어로 배너 안의
   * 리스트(home-hero-ai-feed)가 동시에 존재할 수 있으므로, Supabase는 한 번만
   * 호출하고 두 컨테이너에 각각 맞는 마크업으로 렌더링한다. */
  async function loadAiLiveFeed() {
    const mList = $("home-m-insights");
    const hList = $("home-hero-ai-feed");
    if (!mList && !hList) return;
    const cfg = window.TM_AUTH_CONFIG;
    if (!cfg || cfg.SETUP_PENDING || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;
    try {
      const base = cfg.SUPABASE_URL.replace(/\/+$/, "");
      const url = `${base}/rest/v1/public_ai_feed?select=stock_name,direction,confidence,summary,created_at&order=created_at.desc&limit=3`;
      const res = await fetch(url, {
        headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}` },
        cache: "no-store",
      });
      if (!res.ok) return; // 테이블이 아직 없거나(마이그레이션 전) 일시 오류 — 조용히 스킵, 기존 표시 유지
      const rows = await res.json();
      const list = Array.isArray(rows) ? rows : [];
      if (mList) renderMobileAiFeed(mList, list);
      if (hList) renderHeroAiFeed(hList, list);
    } catch (e) {
      console.warn("[home] AI 실시간 피드 로드 실패", e);
    }
  }

  async function boot() {
    bindAiForm();
    bindNavToggle();
    bindMobileHomeUi();
    bindHomeRtTabs();
    bindHomeUsTabs();
    syncHomeRtChrome();
    await Promise.all([
      loadTickerAndHero(),
      loadHomeRtTab("cap"),
      loadHomeUsTab("cap"),
      loadUsAndCrypto(),
      loadSideCards(),
      loadAiLiveFeed(),
    ]);
    prefetchHomeRtTabs("cap");
    setInterval(loadTickerAndHero, 5 * 60 * 1000);
    setInterval(() => {
      const cur = homeRtTab;
      void loadHomeRtTab(cur, { force: true });
      prefetchHomeRtTabs(cur);
    }, 5 * 60 * 1000);
    setInterval(loadUsAndCrypto, 5 * 60 * 1000);
    setInterval(() => loadHomeUsTab(homeUsTab), 5 * 60 * 1000);
    setInterval(loadAiLiveFeed, 3 * 60 * 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
