/* global document, window, fetch, setInterval, clearInterval */
(function () {
  "use strict";

  const API = "/api/us-market-data";
  const FETCH_TIMEOUT_MS = 20000;
  const POLL_MS = 5 * 60 * 1000;
  const CLIENT_CACHE_MS = 5 * 60 * 1000;
  const CHART_SCRIPT_TIMEOUT_MS = 8000;

  const TAB_CONFIG = {
    "market-cap": {
      label: "\uc2dc\ucd1d TOP50",
      action: "market-cap",
      valueKey: "marketCap",
      valueLabel: "\uc2dc\uac00\ucd1d\uc561",
      valueFormat: fmtUsdCompact,
    },
    gainers: {
      label: "\uc0c1\uc2b9\ub960 TOP50",
      action: "gainers",
      valueKey: "volume",
      valueLabel: "\uac70\ub798\ub7c9",
      valueFormat: fmtNumberCompact,
    },
    volume: {
      label: "\uac70\ub798\ub300\uae08 TOP50",
      action: "volume",
      valueKey: "tradingValue",
      valueLabel: "\uac70\ub798\ub300\uae08",
      valueFormat: fmtUsdCompact,
    },
  };

  const state = {
    indices: [],
    sectors: [],
    activeTab: "market-cap",
    rowsByTab: {},
    clientCache: new Map(),
    openTicker: null,
    chartPeriod: "D",
    lwChartsScriptPromise: null,
    lwChart: null,
    pollTimer: null,
  };

  const CANDLE_UP = "#26a69a";
  const CANDLE_DOWN = "#ef5350";

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
    if (pct == null || !Number.isFinite(pct)) return "us-delta--flat";
    if (pct > 0) return "us-delta--up";
    if (pct < 0) return "us-delta--down";
    return "us-delta--flat";
  }

  function fmtPct(n) {
    if (n == null || !Number.isFinite(n)) return "-";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  }

  function fmtUsdPrice(n) {
    if (n == null || !Number.isFinite(n)) return "-";
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtNumberCompact(n) {
    if (n == null || !Number.isFinite(n)) return "-";
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
    return String(Math.round(n));
  }

  function fmtUsdCompact(n) {
    if (n == null || !Number.isFinite(n)) return "-";
    if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
    return `$${Math.round(n)}`;
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

  function setUpdatedLabel(iso) {
    const el = $("us-updated");
    if (!el) return;
    if (!iso) {
      el.textContent = "\uac31\uc2e0 \uc2dc\uac01 -";
      return;
    }
    const d = new Date(iso);
    el.textContent = `\ub9c8\uc9c0\ub9c9 \uac31\uc2e0 ${d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} KST`;
  }

  function renderIndices() {
    const el = $("us-indexes");
    if (!el) return;
    el.innerHTML = state.indices
      .map((ix) => {
        const cls = deltaClass(ix.changePct);
        const pts =
          ix.changePoints == null || !Number.isFinite(ix.changePoints)
            ? ""
            : `${ix.changePoints > 0 ? "+" : ""}${ix.changePoints.toFixed(2)}`;
        return `<div class="us-index-chip">
          <div class="us-index-chip__name">${escapeHtml(ix.name)}</div>
          <div class="us-index-chip__price">${escapeHtml(fmtUsdPrice(ix.price))}</div>
          <div class="us-index-chip__sub ${cls}">${escapeHtml(fmtPct(ix.changePct))} ${pts ? `(${escapeHtml(pts)})` : ""}</div>
        </div>`;
      })
      .join("");
  }

  function renderSectors() {
    const el = $("us-sectors");
    if (!el) return;
    el.innerHTML = state.sectors
      .map((s) => {
        const cls = deltaClass(s.changePct);
        return `<div class="us-sector-card">
          <div class="us-sector-card__sym">${escapeHtml(s.label || s.symbol)}</div>
          <div class="us-sector-card__name">${escapeHtml(s.name)}</div>
          <div class="us-sector-card__pct ${cls}">${escapeHtml(fmtPct(s.changePct))}</div>
        </div>`;
      })
      .join("");
  }

  function renderRankHead() {
    const cfg = TAB_CONFIG[state.activeTab];
    const head = $("us-rank-head");
    if (!head) return;
    head.innerHTML = `<th class="num">\uc21c\uc704</th>
      <th>\uc885\ubaa9\uba85</th>
      <th>\ud2f0\ucee4</th>
      <th class="num">\ud604\uc7ac\uac00</th>
      <th class="num">\ub4f1\ub77d\ub960</th>
      <th class="num">${escapeHtml(cfg.valueLabel)}</th>`;
  }

  function rankRowHtml(row) {
    const cfg = TAB_CONFIG[state.activeTab];
    const cls = deltaClass(row.changePct);
    const open = state.openTicker === row.ticker ? "true" : "false";
    return `<tr class="us-stock-row" data-ticker="${escapeHtml(row.ticker)}">
      <td class="num">${row.rank != null ? escapeHtml(String(row.rank)) : "-"}</td>
      <td>
        <button type="button" class="us-name-chart-btn" data-ticker="${escapeHtml(row.ticker)}" aria-expanded="${open}">
          ${escapeHtml(row.name || row.ticker)}
        </button>
      </td>
      <td>${escapeHtml(row.ticker)}</td>
      <td class="num">${escapeHtml(fmtUsdPrice(row.price))}</td>
      <td class="num"><span class="${cls}">${escapeHtml(fmtPct(row.changePct))}</span></td>
      <td class="num">${escapeHtml(cfg.valueFormat(row[cfg.valueKey]))}</td>
    </tr>`;
  }

  function chartRowHtml(ticker) {
    return `<tr class="rt-chart-row" data-chart-for="${escapeHtml(ticker)}">
      <td colspan="6">
        <div class="rt-chart-wrap">
          <div class="rt-chart-toolbar" role="toolbar" aria-label="Chart period">
            <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="D" aria-pressed="true">D</button>
            <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="W" aria-pressed="false">W</button>
            <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="M" aria-pressed="false">M</button>
          </div>
          <div class="rt-chart-body">
            <p class="rt-chart-loading-msg" aria-live="polite">Loading chart...</p>
            <div class="rt-chart-panes rt-chart-panes--pending">
              <div class="rt-lw-candle-host" role="region" aria-label="Candlestick chart"></div>
            </div>
          </div>
        </div>
      </td>
    </tr>`;
  }

  function findOpenRow() {
    const rows = state.rowsByTab[state.activeTab] || [];
    return rows.find((row) => row.ticker === state.openTicker) || null;
  }

  function buildChartCandles(row) {
    if (!row || row.price == null || !Number.isFinite(row.price)) return [];
    const price = row.price;
    const change = row.changePct == null || !Number.isFinite(row.changePct) ? 0 : row.changePct / 100;
    const open = change === -1 ? price : price / (1 + change);
    const high = Math.max(open, price);
    const low = Math.min(open, price);
    const d = new Date();
    const time = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return [
      {
        time,
        open: Number(open.toFixed(4)),
        high: Number(high.toFixed(4)),
        low: Number(low.toFixed(4)),
        close: Number(price.toFixed(4)),
      },
    ];
  }

  function renderRankTable() {
    renderRankHead();
    const body = $("us-rank-tbody");
    if (!body) return;
    const rows = state.rowsByTab[state.activeTab] || [];
    const parts = [];
    for (const row of rows) {
      parts.push(rankRowHtml(row));
      if (state.openTicker === row.ticker) parts.push(chartRowHtml(row.ticker));
    }
    body.innerHTML = parts.join("");
    if (state.openTicker) void mountChart(body);
  }

  function setTabs() {
    document.querySelectorAll("[data-us-rank-tab]").forEach((btn) => {
      btn.setAttribute("aria-selected", btn.getAttribute("data-us-rank-tab") === state.activeTab ? "true" : "false");
    });
  }

  function raceWithTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  function ensureLightweightCharts(timeoutMs) {
    if (window.LightweightCharts && typeof window.LightweightCharts.createChart === "function") {
      return Promise.resolve();
    }
    if (!state.lwChartsScriptPromise) {
      state.lwChartsScriptPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.async = true;
        s.src = "https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js";
        s.crossOrigin = "anonymous";
        s.onload = () => {
          if (window.LightweightCharts && typeof window.LightweightCharts.createChart === "function") resolve();
          else {
            state.lwChartsScriptPromise = null;
            reject(new Error("Failed to load chart library."));
          }
        };
        s.onerror = () => {
          state.lwChartsScriptPromise = null;
          reject(new Error("Failed to load chart library."));
        };
        document.head.appendChild(s);
      });
    }
    return raceWithTimeout(state.lwChartsScriptPromise, timeoutMs, "Chart library load timed out.");
  }

  function disposeChart() {
    if (state.lwChart) {
      try {
        state.lwChart.remove();
      } catch (e) {
        /* noop */
      }
      state.lwChart = null;
    }
  }

  function setChartLoading(chartTr, on) {
    const msg = chartTr && chartTr.querySelector(".rt-chart-loading-msg");
    const panes = chartTr && chartTr.querySelector(".rt-chart-panes");
    if (msg) msg.hidden = !on;
    if (panes) panes.classList.toggle("rt-chart-panes--pending", !!on);
  }

  async function mountChart(body) {
    const chartTr = body.querySelector("tr.rt-chart-row");
    const panes = chartTr && chartTr.querySelector(".rt-chart-panes");
    const host = chartTr && chartTr.querySelector(".rt-lw-candle-host");
    if (!chartTr || !panes || !host || !state.openTicker) return;

    setChartLoading(chartTr, true);
    try {
      await ensureLightweightCharts(CHART_SCRIPT_TIMEOUT_MS);
      const LC = window.LightweightCharts;
      disposeChart();
      host.innerHTML = "";

      const w = Math.max(panes.clientWidth, 240);
      const chart = LC.createChart(host, {
        width: w,
        height: 300,
        layout: { background: { type: "solid", color: "#12100c" }, textColor: "#c4b8a8" },
        grid: {
          vertLines: { color: "rgba(212, 175, 55, 0.08)" },
          horzLines: { color: "rgba(212, 175, 55, 0.08)" },
        },
        rightPriceScale: { borderColor: "rgba(148, 130, 98, 0.35)" },
        timeScale: { borderColor: "rgba(148, 130, 98, 0.35)" },
      });
      const opts = {
        upColor: CANDLE_UP,
        downColor: CANDLE_DOWN,
        borderUpColor: CANDLE_UP,
        borderDownColor: CANDLE_DOWN,
        wickUpColor: CANDLE_UP,
        wickDownColor: CANDLE_DOWN,
      };
      const candle =
        LC.CandlestickSeries && typeof chart.addSeries === "function"
          ? chart.addSeries(LC.CandlestickSeries, opts)
          : chart.addCandlestickSeries(opts);
      const candles = buildChartCandles(findOpenRow());
      if (!candles.length) throw new Error("No chart data.");
      candle.setData(candles);
      chart.timeScale().fitContent();
      state.lwChart = chart;

      body.querySelectorAll(".rt-chart-interval-btn").forEach((btn) => {
        const p = btn.getAttribute("data-rt-candle-period");
        btn.setAttribute("aria-pressed", p === state.chartPeriod ? "true" : "false");
      });
    } catch (e) {
      host.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml(e && e.message ? e.message : String(e))}</p>`;
    } finally {
      setChartLoading(chartTr, false);
    }
  }

  async function loadBase() {
    const [idxPack, secPack] = await Promise.all([fetchJson("indices"), fetchJson("sectors")]);
    state.indices = idxPack.indices || [];
    state.sectors = secPack.sectors || [];
    setUpdatedLabel(idxPack.updatedAt || secPack.updatedAt || new Date().toISOString());
    renderIndices();
    renderSectors();
  }

  async function loadActiveTab(force) {
    const cfg = TAB_CONFIG[state.activeTab];
    if (!force && state.rowsByTab[state.activeTab]) {
      renderRankTable();
      return;
    }
    const pack = await fetchJson(cfg.action);
    state.rowsByTab[state.activeTab] = pack.stocks || [];
    setUpdatedLabel(pack.updatedAt || new Date().toISOString());
    renderRankTable();
  }

  async function refreshAll(force) {
    const errEl = $("us-error");
    if (errEl) errEl.hidden = true;
    try {
      if (force) state.clientCache.clear();
      await loadBase();
      await loadActiveTab(force);
    } catch (e) {
      console.error("[us-market]", e);
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent =
          e && e.name === "AbortError"
            ? "\ub370\uc774\ud130\ub97c \ubd88\ub7ec\uc624\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4. \uc0c8\ub85c\uace0\uce68 \ud574\uc8fc\uc138\uc694."
            : e && e.message
              ? e.message
              : String(e);
      }
    }
  }

  function wireTabs() {
    document.querySelectorAll("[data-us-rank-tab]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tab = btn.getAttribute("data-us-rank-tab");
        if (!TAB_CONFIG[tab] || tab === state.activeTab) return;
        state.activeTab = tab;
        state.openTicker = null;
        disposeChart();
        setTabs();
        renderRankTable();
        await loadActiveTab(false);
      });
    });
  }

  function wireTable() {
    const body = $("us-rank-tbody");
    if (!body || body.dataset.usWire === "1") return;
    body.dataset.usWire = "1";
    body.addEventListener("click", (ev) => {
      const intervalBtn = ev.target.closest(".rt-chart-interval-btn");
      if (intervalBtn && body.contains(intervalBtn)) {
        const p = intervalBtn.getAttribute("data-rt-candle-period");
        if (!p) return;
        state.chartPeriod = p;
        disposeChart();
        void mountChart(body);
        return;
      }

      const btn = ev.target.closest(".us-name-chart-btn");
      if (!btn || !body.contains(btn)) return;
      const ticker = btn.getAttribute("data-ticker");
      state.openTicker = state.openTicker === ticker ? null : ticker;
      state.chartPeriod = "D";
      disposeChart();
      renderRankTable();
    });
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      refreshAll(true).catch((e) => console.error("[us-market] poll", e));
    }, POLL_MS);
  }

  async function init() {
    wireTabs();
    wireTable();
    setTabs();
    await refreshAll(false);
    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
