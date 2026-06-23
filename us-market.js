/* global document, window, fetch, setInterval, clearInterval */
(function () {
  "use strict";

  const API = "/api/us-market-data";
  const FETCH_TIMEOUT_MS = 20000;
  const POLL_MS = 5 * 60 * 1000;
  const CLIENT_CACHE_MS = 3 * 60 * 1000;
  const TAB_TTL_MS = 3 * 60 * 1000;

  const TAB_CONFIG = {
    "market-cap": {
      rtTab: "cap",
      action: "market-cap",
      jsonFile: "us-market-cap.json",
      valueKey: "marketCap",
      valueLabel: "시가총액",
      valueFormat: fmtUsdCompact,
    },
    gainers: {
      rtTab: "gainers",
      action: "gainers",
      jsonFile: "us-market-gainers.json",
      valueKey: "marketCap",
      valueLabel: "시가총액",
      valueFormat: fmtUsdCompact,
    },
    volume: {
      rtTab: "tv",
      action: "volume",
      jsonFile: "us-market-volume.json",
      valueKey: "marketCap",
      valueLabel: "시가총액",
      valueFormat: fmtUsdCompact,
    },
  };

  const KIS_QUOTE_API = "/api/kis-stock-quote";
  const TABLE_COLSPAN = 8;

  const state = {
    activeTab: "market-cap",
    rowsByTab: {},
    tabLoadedAt: {},
    dataUpdatedAt: null,
    detailPrefetch: new Set(),
    clientCache: new Map(),
    quoteCache: new Map(),
    openTicker: null,
    detailFetchAbort: null,
    pollTimer: null,
    acIndex: -1,
    acTimer: null,
    acRequestId: 0,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function deltaClass(pct) {
    if (pct == null || !Number.isFinite(pct)) return "delta--flat";
    if (pct > 0) return "delta--pos";
    if (pct < 0) return "delta--neg";
    return "delta--flat";
  }

  function fmtPct(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  }

  function fmtUsdPrice(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function fmtUsdChange(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n === 0) return "0";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}`;
  }

  function formatVsCell(row) {
    const n = row && Number.isFinite(Number(row.changePoints)) ? Number(row.changePoints) : null;
    if (n == null) return { html: "—", cls: "" };
    return { html: escapeHtml(fmtUsdChange(n)), cls: n > 0 ? "rt-vs-pos" : n < 0 ? "rt-vs-neg" : "" };
  }

  function fmtNumberCompact(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
    return String(Math.round(n));
  }

  function fmtUsdCompact(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
    return `$${Math.round(n)}`;
  }

  function rowTradingValue(row) {
    const price = row && Number(row.price);
    const volume = row && Number(row.volume);
    const calc =
      Number.isFinite(price) && Number.isFinite(volume) ? Math.round(price * volume) : null;
    const tv = row && Number(row.tradingValue);
    const stored = Number.isFinite(tv) && tv > 0 ? tv : null;
    if (calc != null && stored != null) return Math.max(calc, stored);
    if (calc != null) return calc;
    return stored;
  }

  function normalizeQuery(q) {
    return String(q || "").trim();
  }

  async function fetchJson(action, timeoutMs = FETCH_TIMEOUT_MS, params = {}) {
    const qs = new URLSearchParams({ action });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
    }
    const cacheKey = qs.toString();
    const cached = state.clientCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;

    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${API}?${cacheKey}`, {
        cache: "no-store",
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      state.clientCache.set(cacheKey, { value: data, expiresAt: now + CLIENT_CACHE_MS });
      return data;
    } finally {
      clearTimeout(tid);
    }
  }

  function isLocalHost() {
    const h = typeof location !== "undefined" ? location.hostname : "";
    return h === "localhost" || h === "127.0.0.1" || h === "";
  }

  // 미리 생성된 data/*.json 읽기: 운영=/api/repo-data, 로컬=./data 직접
  async function fetchStaticJson(file) {
    const bust = Date.now();
    const urls = [];
    if (!isLocalHost()) urls.push(`/api/repo-data?path=${encodeURIComponent(`data/${file}`)}&t=${bust}`);
    urls.push(`./data/${file}?t=${bust}`);
    let lastErr;
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) return await res.json();
        lastErr = new Error(`${url} → ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error(`static json unavailable: ${file}`);
  }

  async function fetchTabFromApi(tab) {
    const cfg = TAB_CONFIG[tab];
    const pack = await fetchJson(cfg.action);
    const stocks = pack.stocks || [];
    if (!stocks.length) throw new Error("api returned no stocks");
    return {
      stocks,
      updatedAt: pack.updatedAt || new Date().toISOString(),
      cached: false,
    };
  }

  async function fetchTabFromStatic(tab) {
    const cfg = TAB_CONFIG[tab];
    const data = await fetchStaticJson(cfg.jsonFile);
    if (!data || !Array.isArray(data.stocks) || !data.stocks.length) {
      throw new Error(`static json empty: ${cfg.jsonFile}`);
    }
    return { stocks: data.stocks, updatedAt: data.updatedAt || null, cached: true, stale: true };
  }

  /** DOM 전 정적 JSON 선로드 — 첫 페인트 가속 */
  const usStaticWarm = Object.fromEntries(
    Object.entries(TAB_CONFIG).map(([tab, cfg]) => [
      tab,
      fetchStaticJson(cfg.jsonFile).catch(() => null),
    ])
  );

  async function fetchTabFromStaticWarm(tab) {
    const warmed = usStaticWarm[tab];
    const data = warmed ? await warmed : await fetchStaticJson(TAB_CONFIG[tab].jsonFile);
    if (!data || !Array.isArray(data.stocks) || !data.stocks.length) return null;
    return { stocks: data.stocks, updatedAt: data.updatedAt || null, cached: true, stale: true };
  }

  function applyTabPack(tab, pack) {
    if (!pack || !(pack.stocks || []).length) return;
    state.rowsByTab[tab] = pack.stocks;
    state.tabLoadedAt[tab] = Date.now();
    if (state.activeTab === tab) {
      if (pack.updatedAt) setDataUpdatedAt(pack.updatedAt);
      else if (!pack.stale) setDataUpdatedAt(new Date().toISOString());
    }
  }

  /**
   * 정적 JSON 즉시 표시 + API 최신화.
   * onInstant — 정적 데이터 도착 시 1회 호출.
   */
  async function loadTabPackProgressive(tab, onInstant) {
    let instantDone = false;
    const fireInstant = (pack) => {
      if (instantDone || !pack || !(pack.stocks || []).length) return;
      instantDone = true;
      if (typeof onInstant === "function") onInstant(pack);
    };

    const staticP = fetchTabFromStaticWarm(tab);
    staticP.then((pack) => fireInstant(pack));

    try {
      return await fetchTabFromApi(tab);
    } catch (e) {
      const fallback = await staticP;
      if (fallback && fallback.stocks && fallback.stocks.length) return fallback;
      throw e;
    }
  }

  /** 탭 종목 — 정적 선표시 후 API 갱신 */
  async function loadTabPack(tab, onInstant) {
    return loadTabPackProgressive(tab, onInstant);
  }

  function formatFreshness(iso) {
    if (!iso) return "";
    const t = new Date(iso);
    if (isNaN(t.getTime())) return "";
    const mins = Math.max(0, Math.round((Date.now() - t.getTime()) / 60000));
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    const rel = mins < 1 ? "방금 전" : mins < 60 ? `${mins}분 전` : `${Math.floor(mins / 60)}시간 ${mins % 60}분 전`;
    return `데이터 기준: ${hh}:${mm} (${rel})`;
  }

  function setDataUpdatedAt(iso) {
    if (iso) state.dataUpdatedAt = iso;
    const el = $("us-data-freshness");
    if (el) el.textContent = state.dataUpdatedAt ? formatFreshness(state.dataUpdatedAt) : "";
  }

  function allKnownRows() {
    const map = new Map();
    Object.values(state.rowsByTab).forEach((rows) => {
      (rows || []).forEach((row) => {
        if (row && row.ticker) map.set(String(row.ticker).toUpperCase(), row);
      });
    });
    return [...map.values()];
  }

  function findRowByTicker(ticker) {
    const t = String(ticker || "").toUpperCase();
    if (!t) return null;
    for (const tab of Object.keys(TAB_CONFIG)) {
      const hit = (state.rowsByTab[tab] || []).find((row) => String(row.ticker || "").toUpperCase() === t);
      if (hit) return hit;
    }
    return null;
  }

  function resolveTickerFromQuery(q) {
    const raw = normalizeQuery(q);
    if (!raw) return null;
    const upper = raw.toUpperCase();
    const rows = allKnownRows();
    const exact = rows.find((r) => String(r.ticker || "").toUpperCase() === upper);
    if (exact) return exact.ticker;
    const byName = rows.find((r) => String(r.name || "").toLowerCase().includes(raw.toLowerCase()));
    if (byName) return byName.ticker;
    if (/^[A-Za-z][A-Za-z0-9.]{0,9}$/.test(raw)) return upper;
    return null;
  }

  async function resolveTickerFromQueryAsync(q) {
    const local = resolveTickerFromQuery(q);
    if (local && findRowByTicker(local)) return local;
    try {
      const pack = await fetchJson("search", FETCH_TIMEOUT_MS, { q });
      const hit = (pack.results || []).find((row) => row && row.ticker);
      if (hit) return hit.ticker;
    } catch (e) {
      console.warn("[us-market] search resolve", e);
    }
    return local;
  }

  async function fetchStockQuoteRow(ticker) {
    const sym = String(ticker || "").toUpperCase();
    if (!sym) return null;
    const cached = state.quoteCache.get(sym);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const hit = findRowByTicker(sym);
    if (hit && hit.price != null && hit.changePoints != null && hit.marketCap != null) {
      return hit;
    }
    const pack = await fetchJson("quote", FETCH_TIMEOUT_MS, { ticker: sym });
    const row = pack.stock || null;
    if (row) {
      state.quoteCache.set(sym, { value: row, expiresAt: Date.now() + CLIENT_CACHE_MS });
    }
    return row;
  }

  function buildDetailSkeleton() {
    return `<div class="rt-stock-loading"><span class="rt-spinner" aria-hidden="true"></span><span>종목 정보를 불러오는 중...</span></div>`;
  }

  function detailRowHtml(ticker) {
    const body = $("us-rank-tbody");
    const existing = body && body.querySelector(`tr.rt-detail-row[data-detail-for="${ticker}"] .rt-detail-acc`);
    if (existing && existing.dataset.loadedFor === ticker && existing.querySelector(".rt-acc")) {
      return `<tr class="rt-detail-row" data-detail-for="${escapeHtml(ticker)}">
        <td colspan="${TABLE_COLSPAN}">${existing.outerHTML}</td>
      </tr>`;
    }
    return `<tr class="rt-detail-row" data-detail-for="${escapeHtml(ticker)}">
      <td colspan="${TABLE_COLSPAN}">
        <div class="rt-detail-acc" data-detail-ticker="${escapeHtml(ticker)}">${buildDetailSkeleton()}</div>
      </td>
    </tr>`;
  }

  function accGridCell(label, valueHtml, valueCls) {
    const cls = valueCls ? `rt-acc-cell__v ${valueCls}` : "rt-acc-cell__v";
    return `<div class="rt-acc-cell"><div class="rt-acc-cell__k">${escapeHtml(label)}</div><div class="${cls}">${valueHtml}</div></div>`;
  }

  function fmtUsdCell(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return escapeHtml(fmtUsdPrice(n));
  }

  function fmtPer(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return escapeHtml(Number(n).toFixed(1));
  }

  function fmtEps(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return escapeHtml(`$${Number(n).toFixed(2)}`);
  }

  function fmtVolumeUs(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return escapeHtml(fmtNumberCompact(n));
  }

  function tradingViewSymbol(data) {
    const ticker = String((data && data.stockCode) || "").toUpperCase().replace(/[^A-Z0-9.]/g, "");
    if (!ticker) return "NASDAQ:AAPL";
    const exchange = String((data && data.exchange) || "").toUpperCase();
    const prefix = exchange === "NYS" ? "NYSE" : "NASDAQ";
    return `${prefix}:${ticker}`;
  }

  function tradingViewUrl(data) {
    const sym = tradingViewSymbol(data);
    if (window.tmTradingViewWidgetEmbedUrl) return window.tmTradingViewWidgetEmbedUrl(sym);
    return `https://www.tradingview.com/widgetembed/?symbol=${encodeURIComponent(sym)}`;
  }

  function tvChartShellHtml(iframeClass, tvSymbol, ticker, title, src) {
    return [
      `<div class="tm-tv-chart-shell">`,
      `  <div class="tm-tv-chart-toolbar">`,
      `    <button type="button" class="tm-tv-fullscreen-btn" title="차트 전체화면" aria-label="차트 전체화면">전체화면</button>`,
      `  </div>`,
      `  <iframe class="${iframeClass}" data-tv-symbol="${escapeHtml(tvSymbol)}" data-symbol="${escapeHtml(ticker)}" title="${escapeHtml(title)}" src="${escapeHtml(src)}" loading="lazy" allowtransparency="true" scrolling="no"></iframe>`,
      `</div>`,
    ].join("");
  }

  function usStockAccHtml(data) {
    const name = escapeHtml(data.stockName || data.stockCode || "—");
    const ticker = escapeHtml(data.stockCode || "");
    const market = escapeHtml(data.market || "US");
    const ch = Number(data.changeRate);
    const cls = deltaClass(Number.isFinite(ch) ? ch : null);
    const price = fmtUsdCell(data.currentPrice);
    const pct = escapeHtml(fmtPct(Number.isFinite(ch) ? ch : null));
    const chgAmt = escapeHtml(fmtUsdChange(data.changeAmt));
    const aiHref = `./stock-analysis.html?q=${encodeURIComponent(String(data.stockCode || ""))}`;
    const closeBtn = `<button type="button" class="rt-acc-close" aria-label="닫기">×</button>`;
    const fin = data.financials || {};
    const chartId = `us-chart-${String(data.stockCode || "").replace(/[^A-Za-z0-9]/g, "")}`;

    const basicGrid = [
      accGridCell("시가", fmtUsdCell(data.open)),
      accGridCell("고가", fmtUsdCell(data.high), "rt-acc-val--hi"),
      accGridCell("저가", fmtUsdCell(data.low), "rt-acc-val--lo"),
      accGridCell("전일종가", fmtUsdCell(data.prevClose)),
    ].join("");

    const metricsGrid = [
      accGridCell("52주고", fmtUsdCell(data.high52w), "rt-acc-val--hi"),
      accGridCell("52주저", fmtUsdCell(data.low52w), "rt-acc-val--lo"),
      accGridCell("PER", fmtPer(fin.per)),
      accGridCell("EPS", fmtEps(fin.eps)),
    ].join("");

    const volumeGrid = [
      accGridCell("거래량", fmtVolumeUs(data.volume)),
      accGridCell("거래대금", escapeHtml(fmtUsdCompact(data.tradingValue))),
      accGridCell("시가총액", escapeHtml(fmtUsdCompact(data.marketCap))),
      `<div class="rt-acc-cell rt-acc-cell--spacer" aria-hidden="true"></div>`,
    ].join("");

    return [
      `<div class="rt-acc">`,
      `  <header class="rt-acc-header">`,
      `    <div class="rt-acc-header__left">`,
      `      <span class="rt-acc-name">${name}</span>`,
      `      <span class="rt-acc-badges">`,
      `        <span class="rt-acc-badge">${ticker}</span>`,
      `        <span class="rt-acc-badge">${market}</span>`,
      `      </span>`,
      `    </div>`,
      `    <div class="rt-acc-header__right">`,
      `      <div>`,
      `        <div class="rt-acc-price">${price}</div>`,
      `        <div class="rt-acc-chg delta ${cls}">${pct}</div>`,
      `        <div class="rt-acc-chg delta ${cls}">${chgAmt}</div>`,
      `      </div>`,
      closeBtn,
      `    </div>`,
      `  </header>`,
      `  <div class="rt-acc-grid rt-acc-grid--4">${basicGrid}</div>`,
      `  <div class="rt-acc-grid rt-acc-grid--4 rt-acc-grid--section">${metricsGrid}</div>`,
      `  <div class="rt-acc-grid rt-acc-grid--4 rt-acc-grid--section">${volumeGrid}</div>`,
      `  <footer class="rt-acc-footer">`,
      `    <a class="rt-acc-btn rt-acc-btn--ai" href="${escapeHtml(aiHref)}">AI 분석하기</a>`,
      `    <button type="button" class="rt-acc-btn rt-acc-btn--chart us-chart-toggle" data-chart-target="${escapeHtml(chartId)}" aria-expanded="false">차트 보기</button>`,
      `    <div id="${escapeHtml(chartId)}" class="rt-chart-wrap" hidden>`,
      `      <div class="rt-chart-body">`,
      tvChartShellHtml(
        "us-tv-widget",
        tradingViewSymbol(data),
        String(data.stockCode || ""),
        `${data.stockName || data.stockCode || ""} chart`,
        tradingViewUrl(data)
      ),
      `      </div>`,
      `    </div>`,
      `  </footer>`,
      `</div>`,
    ].join("");
  }

  function wireUsStockAcc(host, data) {
    if (!host) return;
    wireDetailAccordionClose(host);
    const toggle = host.querySelector(".us-chart-toggle");
    const chartId = toggle && toggle.getAttribute("data-chart-target");
    const chartHost = chartId ? document.getElementById(chartId) : null;
    if (!toggle || !chartHost) return;
    let chartOpen = false;
    const setToggle = (open) => {
      chartOpen = !!open;
      toggle.setAttribute("aria-expanded", chartOpen ? "true" : "false");
      toggle.textContent = chartOpen ? "차트 닫기" : "차트 보기";
      chartHost.hidden = !chartOpen;
    };
    setToggle(false);
    toggle.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setToggle(!chartOpen);
      if (!chartOpen) return;
      const iframe = chartHost.querySelector(".us-tv-widget");
      if (iframe && !iframe.dataset.mounted) {
        iframe.src = tradingViewUrl(data);
        iframe.dataset.mounted = "1";
      }
      if (window.tmWireTradingViewChartTools) window.tmWireTradingViewChartTools(chartHost);
    });
  }

  async function fetchUsKisQuote(ticker, nameHint) {
    const sym = String(ticker || "").toUpperCase();
    const cacheKey = `kis:${sym}:${String(nameHint || "")}`;
    const cached = state.quoteCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const qs = new URLSearchParams({ code: sym, market: "US" });
    if (nameHint) qs.set("name", nameHint);
    const res = await fetch(`${KIS_QUOTE_API}?${qs.toString()}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    state.quoteCache.set(cacheKey, { value: data, expiresAt: Date.now() + CLIENT_CACHE_MS });
    return data;
  }

  async function fetchUsDetailData(ticker, nameHint, signal) {
    const sym = String(ticker || "").toUpperCase();
    const key = `detail:${sym}`;
    const cached = state.quoteCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const qs = new URLSearchParams({ code: sym, market: "US" });
    if (nameHint) qs.set("name", nameHint);
    const res = await fetch(`${KIS_QUOTE_API}?${qs.toString()}`, { cache: "no-store", signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    state.quoteCache.set(key, { value: data, expiresAt: Date.now() + CLIENT_CACHE_MS });
    return data;
  }

  // 종목 행 호버 시 상세(시세) 데이터를 미리 받아 둠 → 클릭 시 즉시 표시
  function prefetchUsDetail(ticker) {
    const sym = String(ticker || "").toUpperCase();
    if (!sym || state.detailPrefetch.has(sym)) return;
    const cached = state.quoteCache.get(`detail:${sym}`);
    if (cached && cached.expiresAt > Date.now()) return;
    state.detailPrefetch.add(sym);
    const listRow = findRowByTicker(sym);
    const nameHint = listRow && listRow.name ? listRow.name : "";
    fetchUsDetailData(sym, nameHint)
      .catch(() => {})
      .finally(() => state.detailPrefetch.delete(sym));
  }

  function syncNameChartButtonsAria(body) {
    if (!body) return;
    body.querySelectorAll(".rt-name-chart-btn").forEach((btn) => {
      const ticker = btn.getAttribute("data-ticker");
      btn.setAttribute("aria-expanded", ticker === state.openTicker ? "true" : "false");
    });
  }

  function wireDetailAccordionClose(host) {
    if (!host) return;
    const closeBtn = host.querySelector(".rt-acc-close");
    if (!closeBtn || closeBtn.dataset.wired === "1") return;
    closeBtn.dataset.wired = "1";
    closeBtn.addEventListener("click", () => {
      state.openTicker = null;
      renderRankTable();
    });
  }

  async function mountUsDetailAccordion() {
    if (!state.openTicker) return;
    const ticker = state.openTicker;
    const body = $("us-rank-tbody");
    if (!body) return;
    const row = body.querySelector(`tr.rt-detail-row[data-detail-for="${ticker}"]`);
    if (!row) return;
    const host = row.querySelector(".rt-detail-acc");
    if (!host) return;
    if (host.dataset.loadedFor === ticker && host.querySelector(".rt-acc")) {
      const existingData = host.dataset.quoteJson ? JSON.parse(host.dataset.quoteJson) : { stockCode: ticker };
      wireUsStockAcc(host, existingData);
      return;
    }

    if (state.detailFetchAbort) {
      try {
        state.detailFetchAbort.abort();
      } catch (e) {
        /* noop */
      }
    }
    const ctrl = new AbortController();
    state.detailFetchAbort = ctrl;

    const listRow = findRowByTicker(ticker);
    const nameHint = listRow && listRow.name ? listRow.name : "";
    const prefetched = state.quoteCache.get(`detail:${String(ticker).toUpperCase()}`);
    const hasFresh = prefetched && prefetched.expiresAt > Date.now();
    // 호버 프리패치로 이미 받아둔 데이터가 있으면 스켈레톤 없이 즉시 표시
    if (!hasFresh) host.innerHTML = buildDetailSkeleton();
    try {
      const data = await fetchUsDetailData(ticker, nameHint, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (state.openTicker !== ticker) return;
      if (listRow && listRow.name && (!data.stockName || data.stockName === ticker || /^D(NYS|NAS|AMS)/i.test(data.stockName))) {
        data.stockName = listRow.name;
      }
      host.innerHTML = usStockAccHtml(data);
      host.dataset.loadedFor = ticker;
      host.dataset.quoteJson = JSON.stringify(data);
      wireUsStockAcc(host, data);
    } catch (e) {
      if (e && e.name === "AbortError") return;
      if (state.openTicker !== ticker) return;
      host.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml(
        e && e.message ? e.message : "종목 정보를 불러오지 못했습니다."
      )}</p>`;
    } finally {
      if (state.detailFetchAbort === ctrl) state.detailFetchAbort = null;
    }
  }

  function isMobileLayout() {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 768px)").matches
    );
  }

  function mobileLastColumnLabel() {
    return state.activeTab === "volume" ? "거래대금" : "시가총액";
  }

  function mobileLastColumnValue(row) {
    if (state.activeTab === "volume") {
      return escapeHtml(fmtUsdCompact(rowTradingValue(row)));
    }
    return escapeHtml(fmtUsdCompact(row.marketCap));
  }

  function syncMobileHeaderRow() {
    const last = document.querySelector(".rt-header-row .rt-col-last");
    if (last) last.textContent = mobileLastColumnLabel();
  }

  function rankRowHtml(row) {
    const chgCls = deltaClass(row.changePct);
    const vs = formatVsCell(row);
    const open = state.openTicker === row.ticker;
    const nameBtn = `<button type="button" class="rt-name-chart-btn" data-ticker="${escapeHtml(row.ticker)}" aria-expanded="${open ? "true" : "false"}">${escapeHtml(row.name || row.ticker)}</button>`;

    if (isMobileLayout()) {
      const rank = row.rank != null ? escapeHtml(String(row.rank)) : "—";
      const price = escapeHtml(fmtUsdPrice(row.price));
      const lastVal = mobileLastColumnValue(row);
      const rowInner = [
        `<div class="rt-mobile-row">`,
        `  <span class="rt-col-rank">${rank}</span>`,
        `  <span class="rt-col-name">${nameBtn}</span>`,
        `  <span class="rt-col-price">${price}</span>`,
        `  <span class="rt-col-change"><span class="delta ${chgCls}">${escapeHtml(fmtPct(row.changePct))}</span></span>`,
        `  <span class="rt-col-last">${lastVal}</span>`,
        `</div>`,
      ].join("");
      return `<tr class="rt-stock-row us-stock-row" data-ticker="${escapeHtml(row.ticker)}"><td colspan="${TABLE_COLSPAN}">${rowInner}</td></tr>`;
    }

    return `<tr class="rt-stock-row us-stock-row" data-ticker="${escapeHtml(row.ticker)}">
      <td class="rt-td-rank num">${row.rank != null ? escapeHtml(String(row.rank)) : "—"}</td>
      <td class="rt-td-name">${nameBtn}</td>
      <td class="rt-td-ticker num">${escapeHtml(row.ticker || "—")}</td>
      <td class="rt-td-price num">${escapeHtml(fmtUsdPrice(row.price))}</td>
      <td class="num rt-td-vs"><span class="${escapeHtml(vs.cls)}">${vs.html}</span></td>
      <td class="rt-td-chg num"><span class="delta ${chgCls}">${escapeHtml(fmtPct(row.changePct))}</span></td>
      <td class="rt-td-tv num">${escapeHtml(fmtUsdCompact(rowTradingValue(row)))}</td>
      <td class="rt-td-mcap num">${escapeHtml(fmtUsdCompact(row.marketCap))}</td>
    </tr>`;
  }

  function renderRankTable() {
    const cfg = TAB_CONFIG[state.activeTab];
    const metricH = $("us-metric-h");
    if (metricH) metricH.textContent = cfg.valueLabel;
    const table = $("us-rank-table");
    if (table) {
      table.setAttribute("data-us-tab", state.activeTab);
      table.setAttribute("data-rt-tab", cfg.rtTab);
    }
    syncMobileHeaderRow();
    const body = $("us-rank-tbody");
    if (!body) return;
    const rows = state.rowsByTab[state.activeTab] || [];
    if (!rows.length) {
      if (body.dataset.rtLoading === "1") {
        body.innerHTML = skeletonRowsHtml(10);
      }
      return;
    }
    const parts = [];
    for (const row of rows) {
      parts.push(rankRowHtml(row));
      if (state.openTicker === row.ticker) parts.push(detailRowHtml(row.ticker));
    }
    body.innerHTML = parts.join("");
    syncNameChartButtonsAria(body);
    syncUsPriceColumnAlign();
    void mountUsDetailAccordion();
  }

  function setTabs() {
    document.querySelectorAll("[data-us-tab]").forEach((btn) => {
      const on = btn.getAttribute("data-us-tab") === state.activeTab;
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function skeletonRowsHtml(count) {
    const row = `<tr class="rt-skel-row" aria-hidden="true"><td colspan="${TABLE_COLSPAN}"><div class="rt-skel-line"><span class="rt-skel-box rt-skel-box--rank"></span><span class="rt-skel-box rt-skel-box--name"></span><span class="rt-skel-box rt-skel-box--num"></span><span class="rt-skel-box rt-skel-box--num"></span><span class="rt-skel-box rt-skel-box--num"></span></div></td></tr>`;
    return row.repeat(Math.max(1, count || 10));
  }

  function hideLoadingOverlay() {
    const el = $("us-loading");
    if (el) {
      el.hidden = true;
      el.setAttribute("aria-busy", "false");
    }
  }

  function showTableLoading() {
    const body = $("us-rank-tbody");
    if (!body) return;
    body.dataset.rtLoading = "1";
    body.classList.remove("rt-tbody--fresh");
    body.innerHTML = skeletonRowsHtml(10);
    setTableLoadingHint(true);
  }

  function hideTableLoading() {
    const body = $("us-rank-tbody");
    if (body) delete body.dataset.rtLoading;
    setTableLoadingHint(false);
  }

  function setTableLoadingHint(on) {
    const el = $("us-data-freshness");
    if (!el) return;
    el.classList.toggle("rt-data-freshness--loading", !!on);
    if (on && !state.dataUpdatedAt) {
      el.textContent = "미국주식 시세 불러오는 중";
    } else if (!on && state.dataUpdatedAt) {
      el.textContent = formatFreshness(state.dataUpdatedAt);
    }
  }

  function markTableFresh() {
    const body = $("us-rank-tbody");
    if (!body || body.dataset.rtLoading === "1") return;
    body.classList.remove("rt-tbody--fresh");
    void body.offsetWidth;
    body.classList.add("rt-tbody--fresh");
  }

  function syncUsPriceColumnAlign() {
    const table = $("us-rank-table");
    const marker = document.querySelector("#us-tab-gainers [data-us-tab-measure-end]");
    const priceTh = table && table.querySelector("th.rt-td-price");
    if (!table || !marker || !priceTh) return;
    if (!window.matchMedia("(min-width: 769px)").matches) {
      table.style.removeProperty("--us-name-w");
      return;
    }
    const gapX = marker.getBoundingClientRect().right;
    const priceLeft = priceTh.getBoundingClientRect().left;
    const delta = gapX - priceLeft;
    if (Math.abs(delta) < 0.5) return;
    const current = parseFloat(getComputedStyle(table).getPropertyValue("--us-name-w")) || 140;
    table.style.setProperty("--us-name-w", `${Math.max(72, Math.round(current + delta))}px`);
    const priceLeft2 = priceTh.getBoundingClientRect().left;
    const remain = gapX - priceLeft2;
    if (Math.abs(remain) >= 0.5) {
      const next = parseFloat(getComputedStyle(table).getPropertyValue("--us-name-w")) || 140;
      table.style.setProperty("--us-name-w", `${Math.max(72, Math.round(next + remain))}px`);
    }
  }

  function tabIsFresh(tab) {
    const at = state.tabLoadedAt[tab];
    return at != null && Date.now() - at < TAB_TTL_MS;
  }

  async function loadActiveTab(force) {
    const tab = state.activeTab;
    const hasRows = !!state.rowsByTab[tab];
    if (!force && hasRows) {
      renderRankTable();
      if (tabIsFresh(tab)) return;
      try {
        const pack = await loadTabPack(tab);
        applyTabPack(tab, pack);
        if (state.activeTab === tab) renderRankTable();
      } catch (e) {
        console.warn("[us-market] background refresh", tab, e);
      }
      return;
    }
    showTableLoading();
    let firstPaint = false;
    const paint = () => {
      if (!firstPaint) {
        firstPaint = true;
        hideLoadingOverlay();
      }
      hideTableLoading();
      renderRankTable();
      markTableFresh();
    };
    try {
      const pack = await loadTabPack(tab, (instantPack) => {
        if (state.activeTab !== tab) return;
        applyTabPack(tab, instantPack);
        paint();
      });
      if (state.activeTab === tab) {
        applyTabPack(tab, pack);
        paint();
      }
    } catch (e) {
      hideTableLoading();
      throw e;
    }
  }

  // 활성 탭 우선 로드 후 렌더, 나머지 탭은 백그라운드 프리패치
  async function refreshAll(force) {
    const errEl = $("us-error");
    if (errEl) errEl.hidden = true;
    if (force) {
      state.clientCache.clear();
      state.rowsByTab = {};
      state.tabLoadedAt = {};
    }
    const tabs = ["market-cap", "gainers", "volume"];
    const currentTab = state.activeTab;
    if (!state.rowsByTab[currentTab]) showTableLoading();

    let firstPaint = false;
    const paintActive = () => {
      if (!firstPaint) {
        firstPaint = true;
        hideLoadingOverlay();
      }
      hideTableLoading();
      renderRankTable();
      markTableFresh();
    };

    let activeErr = null;
    try {
      const pack = await loadTabPack(currentTab, (instantPack) => {
        applyTabPack(currentTab, instantPack);
        if (state.activeTab === currentTab) paintActive();
      });
      applyTabPack(currentTab, pack);
      if (state.activeTab === currentTab) paintActive();
    } catch (e) {
      activeErr = e;
      hideTableLoading();
    }

    const otherTabs = tabs.filter((tab) => tab !== currentTab);
    Promise.all(
      otherTabs.map(async (tab) => {
        try {
          const pack = await loadTabPack(tab, (instantPack) => {
            applyTabPack(tab, instantPack);
          });
          applyTabPack(tab, pack);
        } catch (e) {
          console.warn("[us-market] prefetch", tab, e);
        }
      })
    );

    if (activeErr) {
      console.error("[us-market]", activeErr);
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = activeErr && activeErr.message ? activeErr.message : String(activeErr);
      }
    }
  }

  function mapListRowToQuote(row) {
    return {
      stockCode: row.ticker,
      stockName: row.name || row.ticker,
      market: row.exchange === "NYS" ? "NYSE" : "NASDAQ",
      currentPrice: row.price,
      changeAmt: row.changePoints,
      changeRate: row.changePct,
      volume: row.volume,
      tradingValue: row.tradingValue,
      marketCap: row.marketCap,
      financials: {},
    };
  }

  function closeAutocomplete() {
    const ac = $("us-ac");
    if (ac) ac.hidden = true;
    state.acIndex = -1;
  }

  function renderAutocomplete(items) {
    const ac = $("us-ac");
    const input = $("us-stock-search-input");
    if (!ac || !input) return;
    if (!items.length) {
      ac.hidden = true;
      return;
    }
    ac.hidden = false;
    ac.innerHTML = items
      .slice(0, 8)
      .map((row, i) => {
        const active = i === state.acIndex ? " is-active" : "";
        return `<div class="rt-ac-item${active}" data-ticker="${escapeHtml(row.ticker)}" role="option">
          <div class="rt-ac-item__main">
            <span class="rt-ac-item__name">${escapeHtml(row.name || row.ticker)}</span>
            <span class="rt-ac-item__code">${escapeHtml(row.ticker || "")}</span>
          </div>
        </div>`;
      })
      .join("");
  }

  function filterLocalRows(q) {
    const raw = normalizeQuery(q);
    const lower = raw.toLowerCase();
    const upper = raw.toUpperCase();
    return allKnownRows().filter((row) => {
      const ticker = String(row.ticker || "").toUpperCase();
      const name = String(row.name || "").toLowerCase();
      return ticker.includes(upper) || name.includes(lower);
    });
  }

  function filterAutocomplete(q) {
    const raw = normalizeQuery(q);
    if (!raw) {
      closeAutocomplete();
      return;
    }
    const local = filterLocalRows(raw);
    state.acIndex = local.length ? 0 : -1;
    renderAutocomplete(local);
    if (state.acTimer) clearTimeout(state.acTimer);
    const requestId = ++state.acRequestId;
    state.acTimer = setTimeout(async () => {
      try {
        const pack = await fetchJson("search", FETCH_TIMEOUT_MS, { q: raw });
        if (requestId !== state.acRequestId) return;
        const input = $("us-stock-search-input");
        if (!input || normalizeQuery(input.value) !== raw) return;
        const remote = pack.results || [];
        const seen = new Set();
        const merged = [];
        for (const row of [...local, ...remote]) {
          const ticker = String(row.ticker || "").toUpperCase();
          if (!ticker || seen.has(ticker)) continue;
          seen.add(ticker);
          merged.push(row);
        }
        state.acIndex = merged.length ? 0 : -1;
        renderAutocomplete(merged);
      } catch (e) {
        console.warn("[us-market] autocomplete", e);
      }
    }, 280);
  }

  async function searchUsStock() {
    const input = $("us-stock-search-input");
    const btn = $("us-stock-search-btn");
    const panel = $("us-stock-result-panel");
    const q = input && input.value ? normalizeQuery(input.value) : "";
    if (!panel) return;
    if (!q) {
      panel.hidden = true;
      panel.innerHTML = "";
      if (input) input.focus();
      return;
    }
    closeAutocomplete();
    if (btn) btn.disabled = true;
    panel.hidden = false;
    panel.innerHTML = `<div class="rt-table-loading-inner"><span class="rt-spinner" aria-hidden="true"></span><p>종목 조회 중…</p></div>`;
    try {
      const ticker = await resolveTickerFromQueryAsync(q);
      if (!ticker) {
        panel.innerHTML = `<p class="rt-lw-chart-err">종목을 찾을 수 없습니다. 종목명 또는 티커(예: NVDA, RGTI)를 입력해 주세요.</p>`;
        return;
      }
      const listRow = findRowByTicker(ticker);
      let quote;
      try {
        quote = await fetchUsKisQuote(ticker, listRow && listRow.name ? listRow.name : "");
      } catch (e) {
        if (listRow) quote = mapListRowToQuote(listRow);
        else throw e;
      }
      if (listRow && listRow.name) quote.stockName = listRow.name;
      state.openTicker = null;
      renderRankTable();
      panel.innerHTML = usStockAccHtml(quote);
      wireUsStockAcc(panel, quote);
      const closeBtn = panel.querySelector(".rt-acc-close");
      if (closeBtn) {
        closeBtn.addEventListener("click", () => {
          panel.hidden = true;
          panel.innerHTML = "";
          if (input) input.value = "";
        });
      }
    } catch (e) {
      console.error("[us-market] search", e);
      panel.innerHTML = `<p class="rt-lw-chart-err">종목을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.searchUsStock = searchUsStock;

  function wireTabs() {
    document.querySelectorAll("[data-us-tab]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tab = btn.getAttribute("data-us-tab");
        if (!TAB_CONFIG[tab] || tab === state.activeTab) return;
        state.activeTab = tab;
        state.openTicker = null;
        $("us-stock-result-panel").hidden = true;
        setTabs();
        const errEl = $("us-error");
        try {
          await loadActiveTab(false);
          if (errEl) errEl.hidden = true;
        } catch (e) {
          console.error("[us-market] tab switch", tab, e);
          if (errEl) {
            errEl.hidden = false;
            errEl.textContent = e && e.message ? e.message : String(e);
          }
        }
      });
    });
  }

  function wireTable() {
    const body = $("us-rank-tbody");
    if (!body || body.dataset.usWire === "1") return;
    body.dataset.usWire = "1";
    body.addEventListener("mouseover", (ev) => {
      const stockRow = ev.target.closest("tr.us-stock-row");
      if (!stockRow || !body.contains(stockRow)) return;
      const ticker = stockRow.getAttribute("data-ticker");
      if (ticker) prefetchUsDetail(ticker);
    });
    body.addEventListener("click", (ev) => {
      if (ev.target.closest(".rt-acc-close")) return;
      const stockRow = ev.target.closest("tr.us-stock-row");
      if (!stockRow || !body.contains(stockRow)) return;
      const ticker = stockRow.getAttribute("data-ticker");
      if (!ticker) return;
      state.openTicker = state.openTicker === ticker ? null : ticker;
      $("us-stock-result-panel").hidden = true;
      renderRankTable();
    });
  }

  function wireSearch() {
    const input = $("us-stock-search-input");
    const btn = $("us-stock-search-btn");
    const ac = $("us-ac");
    if (!input || input.dataset.wired === "1") return;
    input.dataset.wired = "1";
    input.addEventListener("input", () => filterAutocomplete(input.value));
    input.addEventListener("keydown", (e) => {
      if (!ac || ac.hidden) {
        if (e.key === "Enter") {
          e.preventDefault();
          searchUsStock();
        }
        return;
      }
      const items = [...ac.querySelectorAll(".rt-ac-item")];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.acIndex = Math.min(items.length - 1, state.acIndex + 1);
        renderAutocomplete(filterLocalRows(input.value));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        state.acIndex = Math.max(0, state.acIndex - 1);
        filterAutocomplete(input.value);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = items[state.acIndex] || items[0];
        if (pick) {
          input.value = pick.getAttribute("data-ticker") || "";
          closeAutocomplete();
        }
        searchUsStock();
      } else if (e.key === "Escape") {
        closeAutocomplete();
      }
    });
    if (btn) btn.addEventListener("click", searchUsStock);
    if (ac) {
      ac.addEventListener("click", (e) => {
        const item = e.target.closest(".rt-ac-item");
        if (!item) return;
        input.value = item.getAttribute("data-ticker") || "";
        closeAutocomplete();
        searchUsStock();
      });
    }
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".rt-tab-search-wrap")) closeAutocomplete();
    });
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      refreshAll(true).catch((e) => console.error("[us-market] poll", e));
    }, POLL_MS);
  }

  function wireLayoutSync() {
    if (window.__usLayoutSyncWired) return;
    window.__usLayoutSyncWired = true;
    let wasMobile = isMobileLayout();
    window.addEventListener("resize", () => {
      const table = $("us-rank-table");
      if (table) table.style.removeProperty("--us-name-w");
      syncUsPriceColumnAlign();
      const mobile = isMobileLayout();
      if (mobile !== wasMobile) {
        wasMobile = mobile;
        renderRankTable();
      }
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(syncUsPriceColumnAlign).catch(() => {});
    }
  }

  async function init() {
    wireTabs();
    wireTable();
    wireSearch();
    wireLayoutSync();
    setTabs();
    const overlayCap = window.setTimeout(() => hideLoadingOverlay(), 500);
    try {
      await refreshAll(false);
    } finally {
      window.clearTimeout(overlayCap);
      hideLoadingOverlay();
    }
    syncUsPriceColumnAlign();
    startPolling();
    setInterval(() => setDataUpdatedAt(), 60000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
