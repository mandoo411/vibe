/* global document, window, fetch, setInterval, clearInterval */
(function () {
  "use strict";

  const API = "/api/us-market-data";
  const FETCH_TIMEOUT_MS = 20000;
  const POLL_MS = 5 * 60 * 1000;
  const CHART_FETCH_TIMEOUT_MS = 8000;
  const CHART_SCRIPT_TIMEOUT_MS = 8000;
  const CHART_CACHE_MAX = 24;

  let lwChartsScriptPromise = null;
  const chartCache = new Map();

  const state = {
    indices: [],
    sectors: [],
    gainerRows: [],
    volumeRows: [],
    openChartTicker: null,
    openChartTable: null,
    candlePeriod: "D",
    chartBarsLimit: 200,
    lwChart: null,
    lwVolChart: null,
    lwResizeObs: null,
    lwBundle: null,
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

  function toNum(v) {
    if (v == null || v === "") return null;
    const n = Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function usDeltaClass(pct) {
    if (pct == null || !Number.isFinite(pct)) return "us-delta--flat";
    if (pct > 0) return "us-delta--up";
    if (pct < 0) return "us-delta--down";
    return "us-delta--flat";
  }

  function fmtPct(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  }

  function fmtUsdPrice(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtUsdVol(n) {
    if (n == null || !Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
    return `$${Math.round(n)}`;
  }

  function fmtPoints(n) {
    if (n == null || !Number.isFinite(n)) return "";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}`;
  }

  async function fetchJson(action, timeoutMs) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${API}?action=${encodeURIComponent(action)}`, {
        cache: "no-store",
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } finally {
      clearTimeout(tid);
    }
  }

  function setUpdatedLabel(iso) {
    const el = $("us-updated");
    if (!el) return;
    if (!iso) {
      el.textContent = "갱신 시각 —";
      return;
    }
    const d = new Date(iso);
    el.textContent = `마지막 갱신 ${d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} KST`;
  }

  function renderIndices() {
    const el = $("us-indexes");
    if (!el) return;
    el.innerHTML = state.indices
      .map((ix) => {
        const cls = usDeltaClass(ix.changePct);
        const pts = fmtPoints(ix.changePoints);
        const pct = fmtPct(ix.changePct);
        return `<div class="us-index-chip">
          <div class="us-index-chip__name">${escapeHtml(ix.name)}</div>
          <div class="us-index-chip__price">${escapeHtml(fmtUsdPrice(ix.price))}</div>
          <div class="us-index-chip__sub ${cls}">${escapeHtml(pct)} ${pts ? `(${escapeHtml(pts)})` : ""}</div>
        </div>`;
      })
      .join("");
  }

  function renderSectors() {
    const el = $("us-sectors");
    if (!el) return;
    el.innerHTML = state.sectors
      .map((s) => {
        const cls = usDeltaClass(s.changePct);
        return `<div class="us-sector-card">
          <div class="us-sector-card__sym">${escapeHtml(s.label || s.symbol)}</div>
          <div class="us-sector-card__name">${escapeHtml(s.name)}</div>
          <div class="us-sector-card__pct ${cls}">${escapeHtml(fmtPct(s.changePct))}</div>
        </div>`;
      })
      .join("");
  }

  function stockRowHtml(r, tableKey) {
    const cls = usDeltaClass(r.changePct);
    const open =
      state.openChartTicker === r.ticker && state.openChartTable === tableKey ? "true" : "false";
    return `<tr class="us-stock-row" data-ticker="${escapeHtml(r.ticker)}" data-table="${escapeHtml(tableKey)}">
      <td class="num">${r.rank != null ? escapeHtml(String(r.rank)) : "—"}</td>
      <td>
        <button type="button" class="us-name-chart-btn" data-ticker="${escapeHtml(r.ticker)}" data-table="${escapeHtml(tableKey)}" aria-expanded="${open}">
          ${escapeHtml(r.name)}
        </button>
        <span class="us-ticker">${escapeHtml(r.ticker)}</span>
      </td>
      <td class="num">${escapeHtml(fmtUsdPrice(r.price))}</td>
      <td class="num"><span class="${cls}">${escapeHtml(fmtPct(r.changePct))}</span></td>
      <td class="num">${escapeHtml(fmtUsdVol(r.tradingValue))}</td>
    </tr>`;
  }

  function chartRowHtml(ticker) {
    return `<tr class="rt-chart-row" data-chart-for="${escapeHtml(ticker)}">
      <td colspan="5">
        <div class="rt-chart-wrap">
          <div class="rt-chart-toolbar" role="toolbar" aria-label="캔들 주기">
            <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="D" aria-pressed="true">일봉</button>
            <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="W" aria-pressed="false">주봉</button>
            <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="M" aria-pressed="false">월봉</button>
          </div>
          <div class="rt-chart-body">
            <p class="rt-chart-loading-msg" aria-live="polite">차트 불러오는 중...</p>
            <div class="rt-chart-panes rt-chart-panes--pending">
              <div class="rt-lw-candle-host" role="region" aria-label="캔들 차트"></div>
              <div class="rt-lw-volume-host" role="region" aria-label="거래량 차트"></div>
            </div>
          </div>
        </div>
      </td>
    </tr>`;
  }

  function renderStockTable(bodyId, rows, tableKey) {
    const body = $(bodyId);
    if (!body) return;
    const parts = [];
    for (const r of rows) {
      parts.push(stockRowHtml(r, tableKey));
      if (state.openChartTicker === r.ticker && state.openChartTable === tableKey) {
        parts.push(chartRowHtml(r.ticker));
      }
    }
    body.innerHTML = parts.join("");
    if (state.openChartTicker && state.openChartTable === tableKey) {
      void mountLightweightChart(body);
    }
  }

  function renderAll() {
    renderIndices();
    renderSectors();
    renderStockTable("us-gainers-tbody", state.gainerRows, "gainers");
    renderStockTable("us-volume-tbody", state.volumeRows, "volume");
  }

  async function refreshAll() {
    const errEl = $("us-error");
    if (errEl) errEl.hidden = true;
    try {
      const [idxPack, secPack, gainPack, volPack] = await Promise.all([
        fetchJson("indices", FETCH_TIMEOUT_MS),
        fetchJson("sectors", FETCH_TIMEOUT_MS),
        fetchJson("gainers", FETCH_TIMEOUT_MS),
        fetchJson("volume", FETCH_TIMEOUT_MS),
      ]);
      state.indices = idxPack.indices || [];
      state.sectors = secPack.sectors || [];
      state.gainerRows = gainPack.stocks || [];
      state.volumeRows = volPack.stocks || [];
      const updatedAt = gainPack.updatedAt || idxPack.updatedAt || new Date().toISOString();
      setUpdatedLabel(updatedAt);
      renderAll();
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
    if (!lwChartsScriptPromise) {
      lwChartsScriptPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.async = true;
        s.src = "https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js";
        s.crossOrigin = "anonymous";
        s.onload = () => {
          if (window.LightweightCharts && typeof window.LightweightCharts.createChart === "function") {
            resolve();
          } else {
            lwChartsScriptPromise = null;
            reject(new Error("차트 라이브러리를 불러오지 못했습니다."));
          }
        };
        s.onerror = () => {
          lwChartsScriptPromise = null;
          reject(new Error("차트 라이브러리를 불러오지 못했습니다."));
        };
        document.head.appendChild(s);
      });
    }
    return raceWithTimeout(lwChartsScriptPromise, timeoutMs, "차트 라이브러리 로드 시간이 초과되었습니다.");
  }

  function disposeLwChart() {
    if (state.lwResizeObs) {
      try {
        state.lwResizeObs.disconnect();
      } catch (e) {
        /* noop */
      }
      state.lwResizeObs = null;
    }
    if (state.lwChart) {
      try {
        state.lwChart.remove();
      } catch (e) {
        /* noop */
      }
      state.lwChart = null;
    }
    if (state.lwVolChart) {
      try {
        state.lwVolChart.remove();
      } catch (e) {
        /* noop */
      }
      state.lwVolChart = null;
    }
    state.lwBundle = null;
  }

  function chartCacheKey(ticker, period) {
    return `${String(ticker).toUpperCase()}|${String(period || "D").toUpperCase()}`;
  }

  function setChartRowLoading(chartTr, on) {
    if (!chartTr) return;
    const msg = chartTr.querySelector(".rt-chart-loading-msg");
    const panes = chartTr.querySelector(".rt-chart-panes");
    if (msg) msg.hidden = !on;
    if (panes) panes.classList.toggle("rt-chart-panes--pending", !!on);
  }

  function buildVolumeData(candles) {
    return candles.map((c) => {
      let color = "#8a8580";
      if (c.close > c.open) color = CANDLE_UP;
      else if (c.close < c.open) color = CANDLE_DOWN;
      return {
        time: c.time,
        value: Number.isFinite(c.volume) ? c.volume : 0,
        color,
      };
    });
  }

  function linkLogicalRangeSync(a, b) {
    const tsA = a.timeScale();
    const tsB = b.timeScale();
    if (typeof tsA.subscribeVisibleLogicalRangeChange !== "function") return;
    let ignoreA = false;
    let ignoreB = false;
    tsA.subscribeVisibleLogicalRangeChange((range) => {
      if (!range || ignoreA) return;
      ignoreB = true;
      try {
        tsB.setVisibleLogicalRange(range);
      } catch (e) {
        /* noop */
      }
      ignoreB = false;
    });
    tsB.subscribeVisibleLogicalRangeChange((range) => {
      if (!range || ignoreB) return;
      ignoreA = true;
      try {
        tsA.setVisibleLogicalRange(range);
      } catch (e) {
        /* noop */
      }
      ignoreA = false;
    });
  }

  function addHistogramSeriesCompat(chart, LC, opts) {
    if (LC.HistogramSeries && typeof chart.addSeries === "function") {
      return chart.addSeries(LC.HistogramSeries, opts);
    }
    if (typeof chart.addHistogramSeries === "function") {
      return chart.addHistogramSeries(opts);
    }
    return null;
  }

  async function mountLightweightChart(body) {
    if (!state.openChartTicker) return;
    const chartTr = body.querySelector("tr.rt-chart-row");
    const panes = chartTr && chartTr.querySelector(".rt-chart-panes");
    const candleHost = chartTr && chartTr.querySelector(".rt-lw-candle-host");
    const volHost = chartTr && chartTr.querySelector(".rt-lw-volume-host");
    if (!chartTr || !panes || !candleHost || !volHost) return;

    setChartRowLoading(chartTr, true);
    try {
      await ensureLightweightCharts(CHART_SCRIPT_TIMEOUT_MS);
      const LC = window.LightweightCharts;
      if (!LC || typeof LC.createChart !== "function") {
        candleHost.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml("차트 라이브러리를 불러오지 못했습니다.")}</p>`;
        return;
      }

      if (
        panes.dataset.mountedFor === state.openChartTicker &&
        panes.dataset.mountedPeriod === state.candlePeriod &&
        state.lwChart &&
        state.lwVolChart
      ) {
        setChartRowLoading(chartTr, false);
        return;
      }

      disposeLwChart();
      candleHost.innerHTML = "";
      volHost.innerHTML = "";

      const w0 = Math.max(panes.clientWidth, 200);
      const chartCandle = LC.createChart(candleHost, {
        width: w0,
        height: 240,
        layout: { background: { type: "solid", color: "#12100c" }, textColor: "#c4b8a8" },
        grid: {
          vertLines: { color: "rgba(212, 175, 55, 0.08)" },
          horzLines: { color: "rgba(212, 175, 55, 0.08)" },
        },
        rightPriceScale: { borderColor: "rgba(148, 130, 98, 0.35)" },
        timeScale: { visible: false, borderColor: "rgba(148, 130, 98, 0.35)" },
      });
      const chartVol = LC.createChart(volHost, {
        width: w0,
        height: 100,
        layout: { background: { type: "solid", color: "#12100c" }, textColor: "#c4b8a8" },
        grid: {
          vertLines: { color: "rgba(212, 175, 55, 0.08)" },
          horzLines: { color: "rgba(212, 175, 55, 0.08)" },
        },
        rightPriceScale: { borderColor: "rgba(148, 130, 98, 0.35)" },
        timeScale: { visible: true, borderColor: "rgba(148, 130, 98, 0.35)" },
      });

      const candleOpts = {
        upColor: CANDLE_UP,
        downColor: CANDLE_DOWN,
        borderUpColor: CANDLE_UP,
        borderDownColor: CANDLE_DOWN,
        wickUpColor: CANDLE_UP,
        wickDownColor: CANDLE_DOWN,
      };
      let candle;
      if (LC.CandlestickSeries && typeof chartCandle.addSeries === "function") {
        candle = chartCandle.addSeries(LC.CandlestickSeries, candleOpts);
      } else {
        candle = chartCandle.addCandlestickSeries(candleOpts);
      }
      const vol = addHistogramSeriesCompat(chartVol, LC, {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      });
      if (!vol) throw new Error("거래량 시리즈를 초기화하지 못했습니다.");

      linkLogicalRangeSync(chartCandle, chartVol);
      state.lwChart = chartCandle;
      state.lwVolChart = chartVol;
      panes.dataset.mountedFor = state.openChartTicker;
      panes.dataset.mountedPeriod = state.candlePeriod;

      const ro = new ResizeObserver(() => {
        if (!state.lwChart || !state.lwVolChart || !panes.isConnected) return;
        const w = panes.clientWidth;
        if (w > 0) {
          state.lwChart.applyOptions({ width: w, height: 240 });
          state.lwVolChart.applyOptions({ width: w, height: 100 });
        }
      });
      ro.observe(panes);
      state.lwResizeObs = ro;

      const ticker = state.openChartTicker;
      const period = String(state.candlePeriod || "D").toUpperCase();
      const ck = chartCacheKey(ticker, period);
      let candles = chartCache.get(ck);
      if (!candles) {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), CHART_FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(
            `${API}?action=candle&ticker=${encodeURIComponent(ticker)}&period=${encodeURIComponent(period)}`,
            { cache: "no-store", signal: ctrl.signal }
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          candles = Array.isArray(data.candles) ? data.candles : [];
          if (!candles.length) throw new Error("차트 데이터가 없습니다.");
          while (chartCache.size >= CHART_CACHE_MAX) {
            const first = chartCache.keys().next().value;
            chartCache.delete(first);
          }
          chartCache.set(ck, candles);
        } finally {
          clearTimeout(tid);
        }
      }

      const sliced = candles.slice(-state.chartBarsLimit);
      candle.setData(sliced);
      vol.setData(buildVolumeData(sliced));
      chartCandle.timeScale().fitContent();
      chartVol.timeScale().fitContent();
      const r = chartCandle.timeScale().getVisibleLogicalRange();
      if (r) chartVol.timeScale().setVisibleLogicalRange(r);

      state.lwBundle = { chartCandle, chartVol, candle, vol, fullCandles: candles };

      body.querySelectorAll(".rt-chart-interval-btn").forEach((btn) => {
        const p = btn.getAttribute("data-rt-candle-period");
        btn.setAttribute("aria-pressed", p === state.candlePeriod ? "true" : "false");
      });
    } catch (e) {
      disposeLwChart();
      delete panes.dataset.mountedFor;
      delete panes.dataset.mountedPeriod;
      const msg =
        e && e.name === "AbortError"
          ? "차트 불러오기 시간이 초과되었습니다."
          : e && e.message
            ? e.message
            : String(e);
      candleHost.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml(msg)}</p>`;
      volHost.innerHTML = "";
    } finally {
      setChartRowLoading(chartTr, false);
    }
  }

  function wireTables() {
    ["us-gainers-tbody", "us-volume-tbody"].forEach((id) => {
      const body = $(id);
      if (!body || body.dataset.usWire === "1") return;
      body.dataset.usWire = "1";
      body.addEventListener("click", (ev) => {
        const intervalBtn = ev.target.closest(".rt-chart-interval-btn");
        if (intervalBtn && body.contains(intervalBtn)) {
          const p = intervalBtn.getAttribute("data-rt-candle-period");
          if (!p) return;
          state.candlePeriod = p;
          body.querySelectorAll(".rt-chart-interval-btn").forEach((btn) => {
            btn.setAttribute("aria-pressed", btn === intervalBtn ? "true" : "false");
          });
          const panes = body.querySelector("tr.rt-chart-row .rt-chart-panes");
          if (panes) {
            delete panes.dataset.mountedFor;
            delete panes.dataset.mountedPeriod;
          }
          disposeLwChart();
          void mountLightweightChart(body);
          return;
        }

        const btn = ev.target.closest(".us-name-chart-btn");
        if (!btn || !body.contains(btn)) return;
        const ticker = btn.getAttribute("data-ticker");
        const tableKey = btn.getAttribute("data-table");
        if (!ticker) return;
        if (state.openChartTicker === ticker && state.openChartTable === tableKey) {
          state.openChartTicker = null;
          state.openChartTable = null;
        } else {
          state.openChartTicker = ticker;
          state.openChartTable = tableKey;
          state.candlePeriod = "D";
        }
        disposeLwChart();
        renderAll();
      });
    });
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      refreshAll().catch((e) => console.error("[us-market] poll", e));
    }, POLL_MS);
  }

  async function init() {
    wireTables();
    await refreshAll();
    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
