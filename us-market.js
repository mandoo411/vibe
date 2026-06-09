/* global document, window, fetch, setInterval, clearInterval */
(function () {
  "use strict";

  const API = "/api/us-market-data";
  const FETCH_TIMEOUT_MS = 20000;
  const POLL_MS = 5 * 60 * 1000;
  const CLIENT_CACHE_MS = 5 * 60 * 1000;

  const TAB_CONFIG = {
    "market-cap": {
      rtTab: "cap",
      action: "market-cap",
      valueKey: "marketCap",
      valueLabel: "시가총액",
      valueFormat: fmtUsdCompact,
    },
    gainers: {
      rtTab: "gainers",
      action: "gainers",
      valueKey: "marketCap",
      valueLabel: "시가총액",
      valueFormat: fmtUsdCompact,
    },
    volume: {
      rtTab: "tv",
      action: "volume",
      valueKey: "marketCap",
      valueLabel: "시가총액",
      valueFormat: fmtUsdCompact,
    },
  };

  const state = {
    activeTab: "market-cap",
    rowsByTab: {},
    clientCache: new Map(),
    quoteCache: new Map(),
    openTicker: null,
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

  function tradingViewSymbol(row) {
    const ticker = String((row && row.ticker) || "").toUpperCase().replace(/[^A-Z0-9.]/g, "");
    if (!ticker) return "NASDAQ:AAPL";
    const exchange = String((row && row.exchange) || "").toUpperCase();
    const prefix = exchange === "NYS" ? "NYSE" : "NASDAQ";
    return `${prefix}:${ticker}`;
  }

  function tradingViewUrl(row) {
    const tv = window.tmTradingViewEmbedTheme
      ? window.tmTradingViewEmbedTheme()
      : { theme: "dark", toolbar_bg: "#1e2235" };
    const params = new URLSearchParams({
      symbol: tradingViewSymbol(row),
      interval: "D",
      timezone: "Asia/Seoul",
      theme: tv.theme,
      style: "1",
      locale: "kr",
      toolbar_bg: tv.toolbar_bg,
      hide_side_toolbar: "0",
      allow_symbol_change: "1",
      save_image: "0",
      calendar: "0",
      studies: "[]",
      withdateranges: "1",
      hideideas: "1",
    });
    return `https://www.tradingview.com/widgetembed/?${params.toString()}`;
  }

  function chartRowHtml(ticker) {
    const row = findRowByTicker(ticker) || { ticker };
    return `<tr class="rt-detail-row rt-chart-row" data-chart-for="${escapeHtml(ticker)}">
      <td colspan="8">
        <div class="rt-chart-wrap">
          <div class="rt-chart-body">
            <iframe
              class="us-tv-widget"
              title="${escapeHtml((row.name || row.ticker) + " chart")}"
              src="${escapeHtml(tradingViewUrl(row))}"
              loading="lazy"
              allowtransparency="true"
              scrolling="no"
            ></iframe>
          </div>
        </div>
      </td>
    </tr>`;
  }

  function rankRowHtml(row) {
    const chgCls = deltaClass(row.changePct);
    const vs = formatVsCell(row);
    const open = state.openTicker === row.ticker;
    return `<tr class="rt-stock-row us-stock-row" data-ticker="${escapeHtml(row.ticker)}">
      <td class="rt-td-rank num">${row.rank != null ? escapeHtml(String(row.rank)) : "—"}</td>
      <td class="rt-td-name">
        <button type="button" class="rt-name-chart-btn" data-ticker="${escapeHtml(row.ticker)}" aria-expanded="${open ? "true" : "false"}">${escapeHtml(row.name || row.ticker)}</button>
      </td>
      <td class="rt-td-ticker num">${escapeHtml(row.ticker || "—")}</td>
      <td class="rt-td-price num">${escapeHtml(fmtUsdPrice(row.price))}</td>
      <td class="num rt-td-vs"><span class="${escapeHtml(vs.cls)}">${vs.html}</span></td>
      <td class="rt-td-chg num"><span class="delta ${chgCls}">${escapeHtml(fmtPct(row.changePct))}</span></td>
      <td class="rt-td-tv num">${escapeHtml(fmtUsdCompact(row.tradingValue))}</td>
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
      table.removeAttribute("data-rt-tab");
    }
    const body = $("us-rank-tbody");
    if (!body) return;
    const rows = state.rowsByTab[state.activeTab] || [];
    if (!rows.length) {
      body.innerHTML = `<tr class="rt-table-loading"><td colspan="8" class="rt-table-loading-cell"><div class="rt-table-loading-inner"><span class="rt-spinner" aria-hidden="true"></span><p>데이터 불러오는 중...</p></div></td></tr>`;
      return;
    }
    const parts = [];
    for (const row of rows) {
      parts.push(rankRowHtml(row));
      if (state.openTicker === row.ticker) parts.push(chartRowHtml(row.ticker));
    }
    body.innerHTML = parts.join("");
    body.querySelectorAll(".rt-chart-row").forEach((row) => row.classList.add("rt-chart-row--ready"));
    syncUsPriceColumnAlign();
  }

  function setTabs() {
    document.querySelectorAll("[data-us-tab]").forEach((btn) => {
      const on = btn.getAttribute("data-us-tab") === state.activeTab;
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function showTableLoading() {
    const body = $("us-rank-tbody");
    if (!body) return;
    body.innerHTML = `<tr class="rt-table-loading"><td colspan="8" class="rt-table-loading-cell"><div class="rt-table-loading-inner"><span class="rt-spinner" aria-hidden="true"></span><p>데이터 불러오는 중...</p></div></td></tr>`;
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

  async function loadActiveTab(force) {
    const cfg = TAB_CONFIG[state.activeTab];
    if (!force && state.rowsByTab[state.activeTab]) {
      renderRankTable();
      return;
    }
    showTableLoading();
    const pack = await fetchJson(cfg.action);
    state.rowsByTab[state.activeTab] = pack.stocks || [];
    renderRankTable();
  }

  async function prefetchOtherTabs() {
    const order = ["market-cap", "gainers", "volume"].filter((t) => t !== state.activeTab);
    for (const tab of order) {
      if (state.rowsByTab[tab]) continue;
      try {
        const pack = await fetchJson(TAB_CONFIG[tab].action);
        state.rowsByTab[tab] = pack.stocks || [];
      } catch (e) {
        console.warn("[us-market] prefetch", tab, e);
      }
    }
  }

  async function refreshAll(force) {
    const errEl = $("us-error");
    if (errEl) errEl.hidden = true;
    try {
      if (force) {
        state.clientCache.clear();
        state.rowsByTab = {};
      }
      await loadActiveTab(force);
      void prefetchOtherTabs();
    } catch (e) {
      console.error("[us-market]", e);
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent =
          e && e.name === "AbortError"
            ? "데이터를 불러오지 못했습니다. 새로고침 해주세요."
            : e && e.message
              ? e.message
              : String(e);
      }
    }
  }

  function stockPanelHtml(row) {
    const chgCls = deltaClass(row.changePct);
    return `<div class="rt-acc">
      <div class="rt-acc-header">
        <div class="rt-acc-header__left">
          <span class="rt-acc-name">${escapeHtml(row.name || row.ticker)}</span>
          <span class="rt-acc-badges"><span class="rt-acc-badge">${escapeHtml(row.ticker || "")}</span></span>
        </div>
        <div class="rt-acc-header__right">
          <span class="rt-acc-price">${escapeHtml(fmtUsdPrice(row.price))}</span>
          <span class="rt-acc-chg delta ${chgCls}">${escapeHtml(fmtUsdChange(row.changePoints))}</span>
          <span class="rt-acc-chg delta ${chgCls}">${escapeHtml(fmtPct(row.changePct))}</span>
          <button type="button" class="rt-acc-close" id="us-stock-panel-close" aria-label="닫기">×</button>
        </div>
      </div>
      <div class="rt-chart-wrap" style="margin:0;border:none;border-radius:0">
        <div class="rt-chart-body">
          <iframe class="us-tv-widget" title="${escapeHtml(row.name || row.ticker)} chart" src="${escapeHtml(tradingViewUrl(row))}" loading="lazy" allowtransparency="true" scrolling="no"></iframe>
        </div>
      </div>
      <div class="rt-acc-grid rt-acc-grid--3 rt-acc-grid--section">
        <div class="rt-acc-cell"><div class="rt-acc-cell__k">시가총액</div><div class="rt-acc-cell__v">${escapeHtml(fmtUsdCompact(row.marketCap))}</div></div>
        <div class="rt-acc-cell"><div class="rt-acc-cell__k">거래량</div><div class="rt-acc-cell__v">${escapeHtml(fmtNumberCompact(row.volume))}</div></div>
        <div class="rt-acc-cell"><div class="rt-acc-cell__k">거래대금</div><div class="rt-acc-cell__v">${escapeHtml(fmtUsdCompact(row.tradingValue))}</div></div>
      </div>
    </div>`;
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
      const row = (await fetchStockQuoteRow(ticker)) || findRowByTicker(ticker) || { ticker, name: ticker };
      state.openTicker = null;
      renderRankTable();
      panel.innerHTML = stockPanelHtml(row);
      const closeBtn = $("us-stock-panel-close");
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
        await loadActiveTab(false);
      });
    });
  }

  function wireTable() {
    const body = $("us-rank-tbody");
    if (!body || body.dataset.usWire === "1") return;
    body.dataset.usWire = "1";
    body.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".rt-name-chart-btn");
      if (!btn || !body.contains(btn)) return;
      const ticker = btn.getAttribute("data-ticker");
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
    window.addEventListener("resize", () => {
      const table = $("us-rank-table");
      if (table) table.style.removeProperty("--us-name-w");
      syncUsPriceColumnAlign();
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
    await refreshAll(false);
    syncUsPriceColumnAlign();
    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
