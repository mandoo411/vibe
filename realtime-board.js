/* global document, window, fetch, WebSocket, Intl, setInterval, clearInterval, requestAnimationFrame, LightweightCharts */
(function () {
  "use strict";

  const API = "/api/kis-realtime-data";

  const CCNL_COLS = [
    "MKSC_SHRN_ISCD",
    "STCK_CNTG_HOUR",
    "STCK_PRPR",
    "PRDY_VRSS_SIGN",
    "PRDY_VRSS",
    "PRDY_CTRT",
    "WGHN_AVRG_STCK_PRC",
    "STCK_OPRC",
    "STCK_HGPR",
    "STCK_LWPR",
    "ASKP1",
    "BIDP1",
    "CNTG_VOL",
    "ACML_VOL",
    "ACML_TR_PBMN",
    "SELN_CNTG_CSNU",
    "SHNU_CNTG_CSNU",
    "NTBY_CNTG_CSNU",
    "CTTR",
    "SELN_CNTG_SMTN",
    "SHNU_CNTG_SMTN",
    "CCLD_DVSN",
    "SHNU_RATE",
    "PRDY_VOL_VRSS_ACML_VOL_RATE",
    "OPRC_HOUR",
    "OPRC_VRSS_PRPR_SIGN",
    "OPRC_VRSS_PRPR",
    "HGPR_HOUR",
    "HGPR_VRSS_PRPR_SIGN",
    "HGPR_VRSS_PRPR",
    "LWPR_HOUR",
    "LWPR_VRSS_PRPR_SIGN",
    "LWPR_VRSS_PRPR",
    "BSOP_DATE",
    "NEW_MKOP_CLS_CODE",
    "TRHT_YN",
    "ASKP_RSQN1",
    "BIDP_RSQN1",
    "TOTAL_ASKP_RSQN",
    "TOTAL_BIDP_RSQN",
    "VOL_TNRT",
    "PRDY_SMNS_HOUR_ACML_VOL",
    "PRDY_SMNS_HOUR_ACML_VOL_RATE",
    "HOUR_CLS_CODE",
    "MRKT_TRTM_CLS_CODE",
    "VI_STND_PRC",
  ];

  const MKOP_LABEL = {
    "11": "장전 동시호가",
    "21": "장중 매매",
    "31": "장종료 후 시간외",
    "41": "시간외 단일가",
    "51": "NXT 매매",
    "61": "NXT 종료",
  };

  const state = {
    tab: "cap",
    capRows: [],
    gainerRows: [],
    prevDayRows: [],
    tradeValRows: [],
    indexes: [],
    clockSession: null,
    marketTime: null,
    ws: null,
    wsMode: "off",
    pollRest: null,
    approvalKey: null,
    wsUrl: null,
    marketStatusWs: null,
    codesSubscribed: new Set(),
    openChartCode: null,
    lwChart: null,
    lwResizeObs: null,
    /** 캔들 주기: 1|5|15|30|60|240(분) 또는 D|W|M — API period 파라미터와 동일 */
    candlePeriod: "D",
    /** 일/주/월봉에서 화면에 쓸 최근 봉 개수 (분봉은 전체 사용) */
    chartBarsLimit: 200,
    lwBundle: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function hideLoadingOverlay() {
    const el = $("rt-loading");
    if (el) {
      el.hidden = true;
      el.setAttribute("aria-busy", "false");
    }
  }

  function fmtNum(s) {
    if (s == null || s === "") return "—";
    const n = Number(String(s).replace(/,/g, ""));
    if (!Number.isFinite(n)) return String(s);
    return n.toLocaleString("ko-KR");
  }

  function fmtPct(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  }

  /** 누적 거래대금(원) → 조·억 등 */
  function formatTradeVal(raw) {
    const n = Number(String(raw == null ? "" : raw).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1e12) {
      const jo = n / 1e12;
      return `${jo.toFixed(2).replace(/\.?0+$/, "")}조`;
    }
    if (n >= 1e8) {
      return `${Math.round(n / 1e8).toLocaleString("ko-KR")}억`;
    }
    if (n >= 1e4) {
      return `${Math.round(n / 1e4).toLocaleString("ko-KR")}만`;
    }
    return n.toLocaleString("ko-KR");
  }

  function deltaClass(pct) {
    if (pct == null || !Number.isFinite(pct)) return "delta--flat";
    if (pct > 0) return "delta--pos";
    if (pct < 0) return "delta--neg";
    return "delta--flat";
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 종목코드 6자리 정규화 (차트 URL 등) */
  function chartSymbolSixDigits(code) {
    const digits = String(code || "").replace(/\D/g, "");
    if (!digits) return "";
    return digits.length <= 6 ? digits.padStart(6, "0") : digits.slice(-6);
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
    state.lwBundle = null;
  }

  function sliceCandlesFromEnd(candles, days) {
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0 || candles.length <= n) return candles;
    return candles.slice(-n);
  }

  function computeSma(closes, period) {
    const n = closes.length;
    const out = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      let s = 0;
      for (let k = 0; k < period; k++) s += closes[i - k];
      out[i] = s / period;
    }
    return out;
  }

  /** Wilder smoothing RSI(14) — closes[i] 기준 값은 rsi[i] (초기 i<14 는 null) */
  function computeRsiWilder14(closes) {
    const period = 14;
    const n = closes.length;
    const rsi = new Array(n).fill(null);
    if (n < period + 1) return rsi;
    let avgG = 0;
    let avgL = 0;
    for (let i = 1; i <= period; i++) {
      const ch = closes[i] - closes[i - 1];
      avgG += ch > 0 ? ch : 0;
      avgL += ch < 0 ? -ch : 0;
    }
    avgG /= period;
    avgL /= period;
    const rs0 = avgL === 0 ? Infinity : avgG / avgL;
    rsi[period] = 100 - 100 / (1 + rs0);
    for (let i = period + 1; i < n; i++) {
      const ch = closes[i] - closes[i - 1];
      const g = ch > 0 ? ch : 0;
      const l = ch < 0 ? -ch : 0;
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      const rs = avgL === 0 ? Infinity : avgG / avgL;
      rsi[i] = 100 - 100 / (1 + rs);
    }
    return rsi;
  }

  function buildIndicatorSeriesData(candles) {
    const closes = candles.map((c) => c.close);
    const sma50 = computeSma(closes, 50);
    const sma200 = computeSma(closes, 200);
    const rsiArr = computeRsiWilder14(closes);
    const ma50Data = [];
    const ma200Data = [];
    const rsiData = [];
    const volData = [];
    const green = "#7cffb3";
    const red = "#f87171";
    for (let i = 0; i < candles.length; i++) {
      const t = candles[i].time;
      if (sma50[i] != null) ma50Data.push({ time: t, value: sma50[i] });
      if (sma200[i] != null) ma200Data.push({ time: t, value: sma200[i] });
      if (rsiArr[i] != null) rsiData.push({ time: t, value: rsiArr[i] });
      const v = candles[i].volume != null ? Number(candles[i].volume) : 0;
      const up = candles[i].close >= candles[i].open;
      volData.push({
        time: t,
        value: Number.isFinite(v) ? v : 0,
        color: up ? green : red,
      });
    }
    return { ma50Data, ma200Data, rsiData, volData };
  }

  function isIntradayCandlePeriod(p) {
    return ["1", "5", "15", "30", "60", "240"].includes(String(p || ""));
  }

  function applyLwChartVisibleRange() {
    const b = state.lwBundle;
    if (!b || !b.chart || !b.candle || !b.fullCandles || !b.fullCandles.length) return;
    const intraday = isIntradayCandlePeriod(state.candlePeriod);
    const limit = state.chartBarsLimit || 200;
    const sliced = intraday ? b.fullCandles : sliceCandlesFromEnd(b.fullCandles, limit);
    const ind = buildIndicatorSeriesData(sliced);
    b.candle.setData(sliced);
    b.ma50.setData(ind.ma50Data);
    b.ma200.setData(ind.ma200Data);
    b.vol.setData(ind.volData);
    b.rsi.setData(ind.rsiData);
    b.chart.timeScale().fitContent();
  }

  function syncChartPeriodToolbarPressed(body) {
    const wrap = body.querySelector("tr.rt-chart-row .rt-chart-toolbar");
    if (!wrap) return;
    const p = String(state.candlePeriod || "D");
    wrap.querySelectorAll(".rt-chart-interval-btn").forEach((btn) => {
      const active = btn.getAttribute("data-rt-candle-period") === p;
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function addLineSeriesCompat(chart, LC, opts) {
    if (LC.LineSeries && typeof chart.addSeries === "function") {
      return chart.addSeries(LC.LineSeries, opts);
    }
    if (typeof chart.addLineSeries === "function") {
      return chart.addLineSeries(opts);
    }
    return null;
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

  function syncNameChartButtonsAria(body) {
    body.querySelectorAll(".rt-name-chart-btn").forEach((btn) => {
      const c = btn.getAttribute("data-code");
      btn.setAttribute("aria-expanded", c === state.openChartCode ? "true" : "false");
    });
  }

  async function mountLightweightChart(body) {
    if (!state.openChartCode) return;
    const host = body.querySelector("tr.rt-chart-row .rt-lw-chart-host");
    if (!host) return;

    const LC = window.LightweightCharts;
    if (!LC || typeof LC.createChart !== "function") {
      host.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml("차트 라이브러리를 불러오지 못했습니다.")}</p>`;
      return;
    }

    if (
      host.dataset.mountedFor === state.openChartCode &&
      host.dataset.mountedPeriod === state.candlePeriod &&
      state.lwChart
    ) {
      const w = host.clientWidth;
      if (w > 0) state.lwChart.applyOptions({ width: w });
      syncNameChartButtonsAria(body);
      syncChartPeriodToolbarPressed(body);
      return;
    }

    disposeLwChart();
    delete host.dataset.mountedFor;
    delete host.dataset.mountedPeriod;
    host.innerHTML = "";
    host.removeAttribute("data-error");

    const intraday = isIntradayCandlePeriod(state.candlePeriod);
    const chartHeight = 360;
    const chart = LC.createChart(host, {
      width: Math.max(host.clientWidth, 200),
      height: chartHeight,
      layout: {
        background: { type: "solid", color: "#12100c" },
        textColor: "#c4b8a8",
      },
      grid: {
        vertLines: { color: "rgba(212, 175, 55, 0.08)" },
        horzLines: { color: "rgba(212, 175, 55, 0.08)" },
      },
      rightPriceScale: { borderColor: "rgba(148, 130, 98, 0.35)" },
      timeScale: {
        borderColor: "rgba(148, 130, 98, 0.35)",
        timeVisible: intraday,
        secondsVisible: false,
      },
    });

    const paneMargins = { candleTop: 0.02, candleBottom: 0.35, volTop: 0.65, volBottom: 0.15, rsiTop: 0.85, rsiBottom: 0 };

    const candleOpts = {
      upColor: "#7cffb3",
      downColor: "#f87171",
      borderUpColor: "#7cffb3",
      borderDownColor: "#f87171",
      wickUpColor: "#7cffb3",
      wickDownColor: "#f87171",
      priceScaleId: "right",
      scaleMargins: { top: paneMargins.candleTop, bottom: paneMargins.candleBottom },
    };

    let candle;
    if (LC.CandlestickSeries && typeof chart.addSeries === "function") {
      candle = chart.addSeries(LC.CandlestickSeries, candleOpts);
    } else if (typeof chart.addCandlestickSeries === "function") {
      candle = chart.addCandlestickSeries(candleOpts);
    } else {
      try {
        chart.remove();
      } catch (e) {
        /* noop */
      }
      host.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml("캔들 시리즈를 만들 수 없습니다.")}</p>`;
      return;
    }

    const lineCommon = {
      priceScaleId: "right",
      scaleMargins: { top: paneMargins.candleTop, bottom: paneMargins.candleBottom },
      priceLineVisible: false,
      lastValueVisible: true,
    };

    const ma50 = addLineSeriesCompat(chart, LC, {
      ...lineCommon,
      color: "#2196F3",
      lineWidth: 3,
      title: "MA50",
    });
    const ma200 = addLineSeriesCompat(chart, LC, {
      ...lineCommon,
      color: "#FFFFFF",
      lineWidth: 3,
      title: "MA200",
    });

    const vol = addHistogramSeriesCompat(chart, LC, {
      priceScaleId: "vol",
      scaleMargins: { top: paneMargins.volTop, bottom: paneMargins.volBottom },
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const rsi = addLineSeriesCompat(chart, LC, {
      priceScaleId: "rsi",
      scaleMargins: { top: paneMargins.rsiTop, bottom: paneMargins.rsiBottom },
      color: "#2196F3",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "RSI(14)",
    });

    if (!ma50 || !ma200 || !vol || !rsi) {
      try {
        chart.remove();
      } catch (e) {
        /* noop */
      }
      host.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml("보조 시리즈를 초기화하지 못했습니다.")}</p>`;
      return;
    }

    try {
      if (typeof rsi.applyOptions === "function") {
        rsi.applyOptions({
          autoscaleInfoProvider: () => ({
            priceRange: { minValue: 0, maxValue: 100 },
          }),
        });
      }
    } catch (e) {
      /* RSI 0–100 고정 스케일 미지원 시 자동 스케일 유지 */
    }

    const dashed = LC.LineStyle != null ? LC.LineStyle.Dashed : 2;
    if (typeof rsi.createPriceLine === "function") {
      rsi.createPriceLine({
        price: 70,
        color: "rgba(248, 113, 113, 0.8)",
        lineWidth: 1,
        lineStyle: dashed,
        axisLabelVisible: false,
      });
      rsi.createPriceLine({
        price: 30,
        color: "rgba(74, 222, 128, 0.85)",
        lineWidth: 1,
        lineStyle: dashed,
        axisLabelVisible: false,
      });
    }

    try {
      chart.priceScale("vol").applyOptions({ visible: false });
      chart.priceScale("rsi").applyOptions({ visible: false });
    } catch (e) {
      /* noop */
    }

    state.lwChart = chart;
    host.dataset.mountedFor = state.openChartCode;
    host.dataset.mountedPeriod = state.candlePeriod;

    const ro = new ResizeObserver(() => {
      if (!state.lwChart || !host.isConnected) return;
      const w = host.clientWidth;
      if (w > 0) state.lwChart.applyOptions({ width: w });
    });
    ro.observe(host);
    state.lwResizeObs = ro;

    try {
      const code = chartSymbolSixDigits(state.openChartCode);
      const period = encodeURIComponent(state.candlePeriod || "D");
      const res = await fetch(`${API}?action=candle&code=${encodeURIComponent(code)}&period=${period}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const candles = Array.isArray(data.candles) ? data.candles : [];
      if (!candles.length) throw new Error("차트 데이터가 없습니다.");

      state.lwBundle = {
        chart,
        candle,
        ma50,
        ma200,
        vol,
        rsi,
        fullCandles: candles,
      };
      applyLwChartVisibleRange();
      syncChartPeriodToolbarPressed(body);
    } catch (e) {
      disposeLwChart();
      delete host.dataset.mountedFor;
      delete host.dataset.mountedPeriod;
      host.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml(e.message || String(e))}</p>`;
    }

    syncNameChartButtonsAria(body);
  }

  async function fetchJson(action) {
    const res = await fetch(`${API}?action=${encodeURIComponent(action)}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function parsePipeFrame(raw) {
    const s = String(raw).trim();
    if (!s.length || (s[0] !== "0" && s[0] !== "1")) return null;
    const parts = s.split("|");
    if (parts.length < 4) return null;
    const trId = parts[1];
    const payload = parts[3];
    const cells = payload.split("^");
    return { trId, cells };
  }

  function rowFromCcnl(cells) {
    const o = {};
    CCNL_COLS.forEach((k, i) => {
      o[k] = cells[i] != null ? cells[i] : "";
    });
    const code = String(o.MKSC_SHRN_ISCD || "").trim();
    const price = String(o.STCK_PRPR || "").trim();
    const changePct = Number(String(o.PRDY_CTRT || "").replace(/,/g, ""));
    const vol = String(o.ACML_VOL || "").trim();
    const tv = String(o.ACML_TR_PBMN || "").trim();
    const hourCls = String(o.HOUR_CLS_CODE || "").trim();
    const mrkt = String(o.MRKT_TRTM_CLS_CODE || "").trim();
    return {
      code,
      price,
      changePct: Number.isFinite(changePct) ? changePct : null,
      volume: vol,
      tradingValue: tv,
      hourCls,
      mrkt,
    };
  }

  function rowFromIndexCcnl(cells) {
    const pr = cells[2];
    const chg = cells[9] != null ? Number(String(cells[9]).replace(/,/g, "")) : null;
    return {
      value: pr != null ? String(pr).trim() : "",
      changePct: Number.isFinite(chg) ? chg : null,
    };
  }

  function rowFromMarketStatus(cells) {
    return {
      mkop: String(cells[3] || "").trim(),
      antc: String(cells[4] || "").trim(),
      mrkt: String(cells[5] || "").trim(),
    };
  }

  function mergeStockRow(list, patch) {
    if (!patch.code) return;
    const i = list.findIndex((r) => r.code === patch.code);
    if (i < 0) return;
    const cur = { ...list[i] };
    if (patch.price != null && patch.price !== "") cur.price = patch.price;
    if (patch.changePct != null) cur.changePct = patch.changePct;
    if (patch.volume) cur.volume = patch.volume;
    if (patch.tradingValue != null && patch.tradingValue !== "") cur.tradingValue = patch.tradingValue;
    if (patch.hourCls) cur.hourCls = patch.hourCls;
    if (patch.mrkt) cur.mrktCls = patch.mrkt;
    list[i] = cur;
  }

  function getCurrentRows() {
    if (state.tab === "cap") return state.capRows;
    if (state.tab === "gainers") return state.gainerRows;
    if (state.tab === "prevday") return state.prevDayRows;
    if (state.tab === "tradeval") return state.tradeValRows;
    return state.capRows;
  }

  function tableColSpan() {
    if (state.tab === "prevday") return 7;
    if (state.tab === "tradeval") return 5;
    return 6;
  }

  function renderThead() {
    const tr = document.getElementById("rt-thead-row");
    if (!tr) return;
    if (state.tab === "prevday") {
      tr.innerHTML =
        '<th class="rt-td-rank">순위</th><th class="rt-td-name">종목명</th><th class="num rt-td-price">현재가</th><th class="num rt-td-chg">전일등락률</th><th class="num rt-td-chg">오늘등락률</th><th class="num rt-td-vol">거래량</th><th class="num rt-td-tv">거래대금</th>';
      return;
    }
    if (state.tab === "tradeval") {
      tr.innerHTML =
        '<th class="rt-td-rank">순위</th><th class="rt-td-name">종목명</th><th class="num rt-td-price">가격</th><th class="num rt-td-chg">등락률</th><th class="num rt-td-tv">거래대금</th>';
      return;
    }
    tr.innerHTML =
      '<th class="rt-td-rank">순위</th><th class="rt-td-name">종목명</th><th class="num rt-td-price">가격</th><th class="num rt-td-chg">등락률</th><th class="num rt-td-vol">거래량</th><th class="num rt-td-tv">거래대금</th>';
  }

  function getTableTitle() {
    if (state.tab === "cap") return "코스피 시가총액 상위 30";
    if (state.tab === "gainers") return "코스피·코스닥 통합 상승률 상위 50";
    if (state.tab === "prevday") return "전일 상승 상위 50 · 오늘 조정·추세 추적";
    if (state.tab === "tradeval") return "거래대금 상위 50 (시총 랭킹 데이터 기준)";
    return "실시간 시세";
  }

  function renderIndexes() {
    const el = $("rt-indexes");
    if (!el) return;
    el.innerHTML = state.indexes
      .map((ix) => {
        const ch = ix.changePct;
        const cls = deltaClass(ch);
        return `<div class="rt-index-chip">
          <span class="rt-index-chip__name">${escapeHtml(ix.label)}</span>
          <span class="rt-index-chip__val">${escapeHtml(ix.value || "—")}</span>
          <span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span>
        </div>`;
      })
      .join("");
  }

  function sessionBadge() {
    const mk = state.marketStatusWs || {};
    const clock = state.clockSession || { label: "—", detail: "" };
    let sub = clock.detail || "";
    if (mk.mkop) {
      sub = MKOP_LABEL[mk.mkop] || `운영코드 ${mk.mkop}`;
    }
    return `<span class="rt-session rt-session--${escapeHtml(clock.key || "na")}">${escapeHtml(
      clock.label || "—"
    )}</span><span class="rt-session__sub">${escapeHtml(sub)}</span>`;
  }

  function renderMeta() {
    const el = $("rt-meta");
    if (el) el.innerHTML = sessionBadge();
    const conn = $("rt-conn");
    if (conn) {
      const m =
        state.wsMode === "live"
          ? "WebSocket 실시간"
          : state.wsMode === "rest"
            ? "REST 고속 갱신"
            : "대기";
      conn.textContent = m;
    }
  }

  function stockRowHtml(r) {
    const nm = escapeHtml(r.name);
    const nameCell = `<button type="button" class="rt-name-chart-btn" data-code="${escapeHtml(r.code)}" aria-expanded="false">${nm}</button>`;

    if (state.tab === "prevday") {
      const chPrev = r.prevDayChangePct;
      const clsPrev = deltaClass(chPrev);
      const chToday = r.changePct;
      const clsToday = deltaClass(chToday);
      const vol = fmtNum(r.volume);
      const tv = formatTradeVal(r.tradingValue);
      return `<tr class="rt-stock-row" data-code="${escapeHtml(r.code)}">
          <td class="num rt-td-rank">${r.rank != null ? escapeHtml(String(r.rank)) : "—"}</td>
          <td class="rt-td-name">${nameCell}</td>
          <td class="num rt-td-price">${escapeHtml(fmtNum(r.price))}</td>
          <td class="num rt-td-chg"><span class="delta ${clsPrev}">${escapeHtml(fmtPct(chPrev))}</span></td>
          <td class="num rt-td-chg"><span class="delta ${clsToday}">${escapeHtml(fmtPct(chToday))}</span></td>
          <td class="num rt-td-vol">${escapeHtml(vol)}</td>
          <td class="num rt-td-tv">${escapeHtml(tv)}</td>
        </tr>`;
    }

    if (state.tab === "tradeval") {
      const ch = r.changePct;
      const cls = deltaClass(ch);
      const tv = formatTradeVal(r.tradingValue);
      return `<tr class="rt-stock-row" data-code="${escapeHtml(r.code)}">
          <td class="num rt-td-rank">${r.rank != null ? escapeHtml(String(r.rank)) : "—"}</td>
          <td class="rt-td-name">${nameCell}</td>
          <td class="num rt-td-price">${escapeHtml(fmtNum(r.price))}</td>
          <td class="num rt-td-chg"><span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span></td>
          <td class="num rt-td-tv">${escapeHtml(tv)}</td>
        </tr>`;
    }

    const ch = r.changePct;
    const cls = deltaClass(ch);
    const tv = formatTradeVal(r.tradingValue);
    const vol = fmtNum(r.volume);
    return `<tr class="rt-stock-row" data-code="${escapeHtml(r.code)}">
          <td class="num rt-td-rank">${r.rank != null ? escapeHtml(String(r.rank)) : "—"}</td>
          <td class="rt-td-name">${nameCell}</td>
          <td class="num rt-td-price">${escapeHtml(fmtNum(r.price))}</td>
          <td class="num rt-td-chg"><span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span></td>
          <td class="num rt-td-vol">${escapeHtml(vol)}</td>
          <td class="num rt-td-tv">${escapeHtml(tv)}</td>
        </tr>`;
  }

  function chartRowHtml(forCode) {
    const cs = tableColSpan();
    return `<tr class="rt-chart-row" data-chart-for="${escapeHtml(forCode)}">
          <td colspan="${cs}">
            <div class="rt-chart-wrap">
              <div class="rt-chart-toolbar" role="toolbar" aria-label="캔들 주기">
                <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="1" aria-pressed="false">1분</button>
                <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="5" aria-pressed="false">5분</button>
                <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="15" aria-pressed="false">15분</button>
                <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="30" aria-pressed="false">30분</button>
                <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="60" aria-pressed="false">60분</button>
                <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="240" aria-pressed="false">4시간</button>
                <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="D" aria-pressed="false">일봉</button>
                <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="W" aria-pressed="false">주봉</button>
                <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="M" aria-pressed="false">월봉</button>
              </div>
              <div class="rt-lw-chart-host" id="rt-lw-chart-host" role="region" aria-label="캔들 차트"></div>
            </div>
          </td>
        </tr>`;
  }

  function applyRowToTr(tr, r) {
    const nm = escapeHtml(r.name);
    tr.cells[0].textContent = r.rank != null ? String(r.rank) : "—";
    tr.cells[1].innerHTML = `<button type="button" class="rt-name-chart-btn" data-code="${escapeHtml(r.code)}" aria-expanded="${state.openChartCode === r.code ? "true" : "false"}">${nm}</button>`;

    if (state.tab === "prevday") {
      const chPrev = r.prevDayChangePct;
      const clsPrev = deltaClass(chPrev);
      const chToday = r.changePct;
      const clsToday = deltaClass(chToday);
      tr.cells[2].textContent = fmtNum(r.price);
      tr.cells[3].innerHTML = `<span class="delta ${clsPrev}">${escapeHtml(fmtPct(chPrev))}</span>`;
      tr.cells[4].innerHTML = `<span class="delta ${clsToday}">${escapeHtml(fmtPct(chToday))}</span>`;
      tr.cells[5].textContent = fmtNum(r.volume);
      tr.cells[6].textContent = formatTradeVal(r.tradingValue);
      return;
    }

    if (state.tab === "tradeval") {
      const ch = r.changePct;
      const cls = deltaClass(ch);
      tr.cells[2].textContent = fmtNum(r.price);
      tr.cells[3].innerHTML = `<span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span>`;
      tr.cells[4].textContent = formatTradeVal(r.tradingValue);
      return;
    }

    const ch = r.changePct;
    const cls = deltaClass(ch);
    tr.cells[2].textContent = fmtNum(r.price);
    tr.cells[3].innerHTML = `<span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span>`;
    tr.cells[4].textContent = fmtNum(r.volume);
    tr.cells[5].textContent = formatTradeVal(r.tradingValue);
  }

  function syncChartDomAfterRows(body, rows) {
    if (!state.openChartCode) return;
    const anchor = body.querySelector(`tr.rt-stock-row[data-code="${state.openChartCode}"]`);
    if (!anchor) {
      state.openChartCode = null;
      disposeLwChart();
      renderThead();
      body.innerHTML = rows.map((r) => stockRowHtml(r)).join("");
      return;
    }
    let chartTr = body.querySelector("tr.rt-chart-row");
    if (!chartTr) {
      anchor.insertAdjacentHTML("afterend", chartRowHtml(state.openChartCode));
      chartTr = body.querySelector("tr.rt-chart-row");
    } else {
      const expectedFor = state.openChartCode;
      if (chartTr.getAttribute("data-chart-for") !== expectedFor) {
        chartTr.setAttribute("data-chart-for", expectedFor);
      }
      anchor.after(chartTr);
    }
    if (chartTr) chartTr.setAttribute("data-chart-for", state.openChartCode);
    syncNameChartButtonsAria(body);
    void mountLightweightChart(body);
  }

  function renderTable() {
    const body = $("rt-tbody");
    const title = $("rt-table-title");
    if (!body) return;
    const rows = getCurrentRows();
    renderThead();
    if (title) {
      title.textContent = getTableTitle();
    }
    if (!state.openChartCode) {
      disposeLwChart();
      body.innerHTML = rows.map((r) => stockRowHtml(r)).join("");
      return;
    }

    const stockRows = body.querySelectorAll("tr.rt-stock-row");
    const colN = tableColSpan();
    const canPatch =
      stockRows.length === rows.length &&
      Array.from(stockRows).every(
        (tr, i) => tr.getAttribute("data-code") === rows[i]?.code && tr.cells.length === colN
      );

    if (canPatch) {
      for (let i = 0; i < rows.length; i++) {
        applyRowToTr(stockRows[i], rows[i]);
      }
    } else {
      disposeLwChart();
      const parts = [];
      for (const r of rows) {
        parts.push(stockRowHtml(r));
        if (state.openChartCode === r.code) parts.push(chartRowHtml(r.code));
      }
      body.innerHTML = parts.join("");
    }
    syncChartDomAfterRows(body, rows);
  }

  function renderAll() {
    renderIndexes();
    renderMeta();
    renderTable();
  }

  function applySnapshot(data) {
    state.clockSession = data.clock || null;
    state.marketTime = data.marketTime || null;
    state.indexes = (data.indexes || []).map((x) => ({
      id: x.id,
      label: x.label,
      value: x.value,
      changePct: x.changePct,
    }));
    state.capRows = (data.marketCap || []).map((r) => ({ ...r, tab: "cap" }));
    state.gainerRows = (data.gainers || []).map((r) => ({ ...r, tab: "gainers" }));
    state.prevDayRows = (data.prevDayGainers || []).map((r) => ({ ...r, tab: "prevday" }));
    state.tradeValRows = (data.tradeValueTop50 || []).map((r) => ({ ...r, tab: "tradeval" }));
  }

  function makeWsPayload(trType, trId, trKey) {
    return JSON.stringify({
      header: {
        approval_key: state.approvalKey,
        custtype: "P",
        tr_type: trType,
        "content-type": "utf-8",
      },
      body: {
        input: {
          tr_id: trId,
          tr_key: trKey,
        },
      },
    });
  }

  function handleWsMessage(raw) {
    const s = String(raw).trim();
    if (s.startsWith("{")) {
      let j;
      try {
        j = JSON.parse(s);
      } catch {
        return;
      }
      const tid = j && j.header && j.header.tr_id;
      if (tid === "PINGPONG" && state.ws && state.ws.readyState === 1) {
        state.ws.send(s);
      }
      return;
    }
    const frame = parsePipeFrame(s);
    if (!frame) return;
    const { trId, cells } = frame;
    if (trId === "H0UPCNT0") {
      const p = rowFromIndexCcnl(cells);
      const ub = String(cells[0] || "").trim();
      const i1 = state.indexes.findIndex((x) => x.id === "0001");
      const i2 = state.indexes.findIndex((x) => x.id === "1001");
      if (ub === "0001" || ub === "001") {
        if (i1 >= 0 && p.value) {
          state.indexes[i1].value = p.value;
          if (p.changePct != null) state.indexes[i1].changePct = p.changePct;
        }
      } else if (ub === "1001") {
        if (i2 >= 0 && p.value) {
          state.indexes[i2].value = p.value;
          if (p.changePct != null) state.indexes[i2].changePct = p.changePct;
        }
      }
      renderIndexes();
      return;
    }
    if (trId === "H0STMKO0") {
      const st = rowFromMarketStatus(cells);
      state.marketStatusWs = st;
      renderMeta();
      return;
    }
    if (trId === "H0UNCNT0" || trId === "H0STCNT0" || trId === "H0NXCNT0") {
      const row = rowFromCcnl(cells);
      mergeStockRow(state.capRows, row);
      mergeStockRow(state.gainerRows, row);
      mergeStockRow(state.prevDayRows, row);
      if (state.tab === "cap" || state.tab === "gainers" || state.tab === "prevday") renderTable();
    }
  }

  function subscribeStocks(codes) {
    if (!state.ws || state.ws.readyState !== 1) return;
    const limit = state.tab === "cap" ? 30 : 50;
    const list = codes.slice(0, limit);
    for (const c of list) {
      if (state.codesSubscribed.has(c)) continue;
      state.ws.send(makeWsPayload("1", "H0UNCNT0", c));
      state.codesSubscribed.add(c);
    }
  }

  function unsubscribeAll() {
    if (!state.ws || state.ws.readyState !== 1) return;
    for (const c of state.codesSubscribed) {
      state.ws.send(makeWsPayload("0", "H0UNCNT0", c));
    }
    state.codesSubscribed.clear();
    state.ws.send(makeWsPayload("0", "H0UPCNT0", "0001"));
    state.ws.send(makeWsPayload("0", "H0UPCNT0", "1001"));
    state.ws.send(makeWsPayload("0", "H0STMKO0", "005930"));
  }

  function wireWs() {
    if (!state.wsUrl || !state.approvalKey) return;
    try {
      state.ws = new WebSocket(state.wsUrl);
    } catch (e) {
      state.wsMode = "rest";
      return;
    }
    state.ws.binaryType = "arraybuffer";
    state.ws.onopen = () => {
      state.wsMode = "live";
      state.ws.send(makeWsPayload("1", "H0UPCNT0", "0001"));
      state.ws.send(makeWsPayload("1", "H0UPCNT0", "1001"));
      state.ws.send(makeWsPayload("1", "H0STMKO0", "005930"));
      subscribeStocks(getCurrentRows().map((r) => r.code));
      renderMeta();
    };
    state.ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      handleWsMessage(raw);
    };
    state.ws.onerror = () => {
      state.wsMode = "rest";
      renderMeta();
    };
    state.ws.onclose = () => {
      if (state.wsMode === "live") state.wsMode = "rest";
      renderMeta();
    };
  }

  async function tryConnectWs() {
    if (location.protocol === "https:") {
      state.wsMode = "rest";
      renderMeta();
      return;
    }
    try {
      const ap = await fetchJson("approval");
      state.approvalKey = ap.approval_key;
      state.wsUrl = ap.wsUrl || "ws://ops.koreainvestment.com:21000";
      wireWs();
    } catch {
      state.wsMode = "rest";
      renderMeta();
    }
  }

  async function refreshSnapshot() {
    const data = await fetchJson("snapshot");
    applySnapshot(data);
    renderAll();
    if (state.ws && state.ws.readyState === 1) {
      unsubscribeAll();
      subscribeStocks(getCurrentRows().map((r) => r.code));
    }
  }

  async function refreshPartial() {
    try {
      if (state.tab === "gainers") {
        const { stocks } = await fetchJson("gainers");
        state.gainerRows = stocks.map((r) => ({ ...r, tab: "gainers" }));
      } else if (state.tab === "prevday") {
        const { stocks } = await fetchJson("prev-day-gainers");
        state.prevDayRows = stocks.map((r) => ({ ...r, tab: "prevday" }));
      } else if (state.tab === "tradeval") {
        const { stocks } = await fetchJson("trade-value-top50");
        state.tradeValRows = stocks.map((r) => ({ ...r, tab: "tradeval" }));
      } else {
        const { stocks } = await fetchJson("market-cap");
        state.capRows = stocks.map((r) => ({ ...r, tab: "cap" }));
      }
      const { indexes } = await fetchJson("index");
      state.indexes = (indexes || []).map((x) => ({
        id: x.id,
        label: x.label,
        value: x.value,
        changePct: x.changePct,
      }));
      const { clock, marketTime } = await fetchJson("session");
      state.clockSession = clock;
      state.marketTime = marketTime;
      renderAll();
      if (state.ws && state.ws.readyState === 1) {
        unsubscribeAll();
        subscribeStocks(getCurrentRows().map((r) => r.code));
      }
    } catch (e) {
      const err = $("rt-error");
      if (err) {
        err.hidden = false;
        err.textContent = e.message || String(e);
      }
    }
  }

  function setupTabs() {
    document.querySelectorAll("[data-rt-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.getAttribute("data-rt-tab");
        if (t === "gainers") state.tab = "gainers";
        else if (t === "prevday") state.tab = "prevday";
        else if (t === "tradeval") state.tab = "tradeval";
        else state.tab = "cap";
        state.openChartCode = null;
        state.candlePeriod = "D";
        document.querySelectorAll("[data-rt-tab]").forEach((b) => {
          b.setAttribute("aria-selected", b.getAttribute("data-rt-tab") === state.tab ? "true" : "false");
        });
        renderTable();
        startPolling();
        if (state.ws && state.ws.readyState === 1) {
          unsubscribeAll();
          subscribeStocks(getCurrentRows().map((r) => r.code));
        }
      });
    });
  }

  function wireTableChartAccordion() {
    const body = $("rt-tbody");
    if (!body || body.dataset.rtChartWire === "1") return;
    body.dataset.rtChartWire = "1";
    body.addEventListener("click", (ev) => {
      const intervalBtn = ev.target.closest(".rt-chart-interval-btn");
      if (intervalBtn && body.contains(intervalBtn)) {
        const p = intervalBtn.getAttribute("data-rt-candle-period");
        if (!p) return;
        if (state.candlePeriod === p && state.lwBundle && state.lwChart) {
          body.querySelectorAll(".rt-chart-interval-btn").forEach((btn) => {
            btn.setAttribute("aria-pressed", btn === intervalBtn ? "true" : "false");
          });
          return;
        }
        state.candlePeriod = p;
        body.querySelectorAll(".rt-chart-interval-btn").forEach((btn) => {
          btn.setAttribute("aria-pressed", btn === intervalBtn ? "true" : "false");
        });
        const chartHost = body.querySelector("tr.rt-chart-row .rt-lw-chart-host");
        if (chartHost) {
          delete chartHost.dataset.mountedFor;
          delete chartHost.dataset.mountedPeriod;
        }
        disposeLwChart();
        void mountLightweightChart(body);
        return;
      }
      const btn = ev.target.closest(".rt-name-chart-btn");
      if (!btn || !body.contains(btn)) return;
      const code = btn.getAttribute("data-code");
      if (!code) return;
      if (state.openChartCode === code) state.openChartCode = null;
      else state.openChartCode = code;
      renderTable();
    });
  }

  function startPolling() {
    if (state.pollRest) clearInterval(state.pollRest);
    const period =
      state.tab === "prevday"
        ? 5 * 60 * 1000
        : state.tab === "tradeval"
          ? 15000
          : state.tab === "gainers"
            ? 5000
            : 12000;
    state.pollRest = setInterval(() => {
      refreshPartial().catch(() => {});
    }, period);
  }

  async function init() {
    setupTabs();
    wireTableChartAccordion();
    const err = $("rt-error");
    if (err) err.hidden = true;
    try {
      await refreshSnapshot();
      startPolling();
      await tryConnectWs();
    } catch (e) {
      if (err) {
        err.hidden = false;
        err.textContent = e.message || String(e);
      }
    } finally {
      hideLoadingOverlay();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
