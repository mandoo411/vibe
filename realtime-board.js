/* global document, window, fetch, WebSocket, Intl, setInterval, clearInterval, requestAnimationFrame */
(function () {
  "use strict";

  const API = "/api/kis-realtime-data";
  const FETCH_TIMEOUT_MS = 10000;
  const TAB_CACHE_MS = 5 * 60 * 1000;
  /** 차트 캔들 API·라이브러리 로드 상한 (TradingView 미사용, Lightweight Charts 지연 로드) */
  const CHART_FETCH_TIMEOUT_MS = 8000;
  const CHART_SCRIPT_TIMEOUT_MS = 8000;
  const CHART_CACHE_MAX_ENTRIES = 24;

  /** Lightweight Charts 스크립트 1회 로드 Promise */
  let lwChartsScriptPromise = null;
  const chartCandleCache = new Map();

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
    lwVolChart: null,
    lwResizeObs: null,
    /** 캔들 주기: D|W|M — API period와 동일 */
    candlePeriod: "D",
    /** 화면에 쓸 최근 봉 개수 */
    chartBarsLimit: 200,
    lwBundle: null,
    /** 탭별 데이터 마지막 로드 시각(ms) — 3분 캐시 */
    tabLoadedAt: {},
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

  /** 누적 거래대금: API `tr_pbmn`은 백만원 단위 → 서버에서 원으로 환산한 문자열이 오면 조·억으로 압축 표기 */
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

  /** 시가총액 원본(stck_avls 또는 API의 mcapEok) — 원 단위: 1조 이상 X.XX조, 미만 XXXX억 */
  function readStckAvlsRaw(r) {
    if (!r) return null;
    const a = r.stck_avls;
    if (a != null && String(a).trim() !== "") return a;
    const b = r.mcapEok;
    if (b != null && String(b).trim() !== "") return b;
    return null;
  }

  function formatStckAvls(raw) {
    const n = Number(String(raw == null ? "" : raw).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1e12) {
      const jo = n / 1e12;
      const s = jo.toFixed(2);
      const trimmed = s.replace(/\.00$/, "");
      return `${trimmed}조`;
    }
    const eok = Math.round(n / 1e8);
    if (eok <= 0) return "—";
    return `${eok.toLocaleString("ko-KR")}억`;
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

  /** 종목 클릭 시까지 차트 스크립트 미로드 (페이지 초기 로드 경량화) */
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
    return raceWithTimeout(
      lwChartsScriptPromise,
      timeoutMs,
      "차트 라이브러리 로드 시간이 초과되었습니다."
    );
  }

  function chartCacheKey(code, periodUpper) {
    return `${chartSymbolSixDigits(code)}|${String(periodUpper || "D").toUpperCase()}`;
  }

  function readChartCandleCache(code, periodUpper) {
    const ent = chartCandleCache.get(chartCacheKey(code, periodUpper));
    return ent && Array.isArray(ent.candles) && ent.candles.length ? ent.candles : null;
  }

  function writeChartCandleCache(code, periodUpper, candles) {
    const k = chartCacheKey(code, periodUpper);
    while (chartCandleCache.size >= CHART_CACHE_MAX_ENTRIES) {
      const first = chartCandleCache.keys().next().value;
      chartCandleCache.delete(first);
    }
    chartCandleCache.set(k, { candles: candles.slice() });
  }

  function setChartRowLoading(chartTr, on) {
    if (!chartTr) return;
    const msg = chartTr.querySelector(".rt-chart-loading-msg");
    const panes = chartTr.querySelector(".rt-chart-panes");
    if (msg) msg.hidden = !on;
    if (panes) panes.classList.toggle("rt-chart-panes--pending", !!on);
  }

  const WD_KO_SUN0 = ["일", "월", "화", "수", "목", "금", "토"];

  /** LightweightCharts Time → { year, month, day } (월 1–12) */
  function parseChartBusinessDay(time) {
    if (time == null) return null;
    if (typeof time === "string") {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(time).trim());
      if (!m) return null;
      return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    }
    if (typeof time === "object" && time.year != null && time.month != null && time.day != null) {
      return { year: +time.year, month: +time.month, day: +time.day };
    }
    if (typeof time === "number" && Number.isFinite(time)) {
      const d = new Date(time * 1000);
      return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
      };
    }
    return null;
  }

  function chartTimeKey(time) {
    const bd = parseChartBusinessDay(time);
    if (!bd) return "";
    return `${bd.year}-${String(bd.month).padStart(2, "0")}-${String(bd.day).padStart(2, "0")}`;
  }

  /**
   * 십자선·x축용 한국어 날짜 (일봉 / 주봉 / 월봉)
   * - D: 2026년 5월 14일 (수)
   * - W: 2026년 5월 2주  (해당 영업일이 속한 달의 n주차, 1–7일→1주)
   * - M: 2026년 5월
   */
  function formatChartTimeKo(time, periodKey) {
    const bd = parseChartBusinessDay(time);
    if (!bd) return "";
    const p = String(periodKey || "D").toUpperCase();
    const { year, month, day } = bd;
    if (p === "M") {
      return `${year}년 ${month}월`;
    }
    if (p === "W") {
      const weekOfMonth = Math.min(5, Math.max(1, Math.ceil(day / 7)));
      return `${year}년 ${month}월 ${weekOfMonth}주`;
    }
    const utc = Date.UTC(year, month - 1, day);
    const dow = WD_KO_SUN0[new Date(utc).getUTCDay()];
    return `${year}년 ${month}월 ${day}일 (${dow})`;
  }

  function buildChartLocalization(periodKey) {
    const p = String(periodKey || "D").toUpperCase();
    return {
      locale: "ko-KR",
      timeFormatter: (time) => formatChartTimeKo(time, p),
    };
  }

  function fmtChartPrice(n) {
    if (n == null || !Number.isFinite(Number(n))) return "—";
    return Number(n).toLocaleString("ko-KR", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  }

  function fmtChartVol(n) {
    if (n == null || !Number.isFinite(Number(n))) return "—";
    return Math.round(Number(n)).toLocaleString("ko-KR");
  }

  function wireRtCrosshairTooltip(panesEl, candleHost, volHost, chartCandle, chartVol, periodKey) {
    let tip = panesEl.querySelector(".rt-lw-ohlc-tooltip");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "rt-lw-ohlc-tooltip";
      tip.setAttribute("aria-hidden", "true");
      panesEl.appendChild(tip);
    }
    const p = String(periodKey || "D").toUpperCase();

    function handle(param, hostEl) {
      const rows = state.lwBundle && state.lwBundle.fullCandles ? state.lwBundle.fullCandles : null;
      if (!param || param.time == null || !param.point || !rows || !rows.length) {
        tip.style.display = "none";
        return;
      }
      const tk = chartTimeKey(param.time);
      const row = rows.find((r) => chartTimeKey(r.time) === tk);
      if (!row || row.open == null) {
        tip.style.display = "none";
        return;
      }
      const dt = formatChartTimeKo(param.time, p);
      const o = fmtChartPrice(row.open);
      const h = fmtChartPrice(row.high);
      const l = fmtChartPrice(row.low);
      const c = fmtChartPrice(row.close);
      const v = fmtChartVol(row.volume);
      tip.innerHTML = [
        `<div class="rt-lw-ohlc-tooltip__dt">${escapeHtml(dt)}</div>`,
        `<div class="rt-lw-ohlc-tooltip__row"><span>시가</span><span>${escapeHtml(o)}</span></div>`,
        `<div class="rt-lw-ohlc-tooltip__row"><span>고가</span><span>${escapeHtml(h)}</span></div>`,
        `<div class="rt-lw-ohlc-tooltip__row"><span>저가</span><span>${escapeHtml(l)}</span></div>`,
        `<div class="rt-lw-ohlc-tooltip__row"><span>종가</span><span>${escapeHtml(c)}</span></div>`,
        `<div class="rt-lw-ohlc-tooltip__row"><span>거래량</span><span>${escapeHtml(v)}</span></div>`,
      ].join("");
      tip.style.display = "block";
      const pr = panesEl.getBoundingClientRect();
      const hr = hostEl.getBoundingClientRect();
      const pad = 8;
      let x = hr.left - pr.left + param.point.x + 14;
      let y = hr.top - pr.top + param.point.y + 14;
      tip.style.visibility = "hidden";
      const tw = tip.offsetWidth || 168;
      const th = tip.offsetHeight || 108;
      tip.style.visibility = "visible";
      const pw = panesEl.clientWidth;
      const ph = panesEl.clientHeight;
      if (x + tw + pad > pw) x = Math.max(pad, hr.left - pr.left + param.point.x - tw - 14);
      if (y + th + pad > ph) y = Math.max(pad, hr.top - pr.top + param.point.y - th - 14);
      tip.style.left = `${Math.max(pad, x)}px`;
      tip.style.top = `${Math.max(pad, y)}px`;
    }

    chartCandle.subscribeCrosshairMove((param) => handle(param, candleHost));
    chartVol.subscribeCrosshairMove((param) => handle(param, volHost));
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

  function sliceCandlesFromEnd(candles, days) {
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0 || candles.length <= n) return candles;
    return candles.slice(-n);
  }

  const CANDLE_UP = "#26a69a";
  const CANDLE_DOWN = "#ef5350";

  function buildVolumeHistogramData(candles) {
    const volData = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const t = c.time;
      const v = c.volume != null ? Number(c.volume) : 0;
      const o = c.open;
      const cl = c.close;
      let color = "#8a8580";
      if (cl > o) color = CANDLE_UP;
      else if (cl < o) color = CANDLE_DOWN;
      volData.push({
        time: t,
        value: Number.isFinite(v) ? v : 0,
        color,
      });
    }
    return volData;
  }

  function applyLwChartVisibleRange() {
    const b = state.lwBundle;
    if (!b || !b.chartCandle || !b.chartVol || !b.candle || !b.vol || !b.fullCandles || !b.fullCandles.length) return;
    const limit = state.chartBarsLimit || 200;
    const sliced = sliceCandlesFromEnd(b.fullCandles, limit);
    const volData = buildVolumeHistogramData(sliced);
    b.candle.setData(sliced);
    b.vol.setData(volData);
    b.chartCandle.timeScale().fitContent();
    b.chartVol.timeScale().fitContent();
    const r = b.chartCandle.timeScale().getVisibleLogicalRange();
    if (r) b.chartVol.timeScale().setVisibleLogicalRange(r);
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

  function linkLogicalRangeSync(chartA, chartB) {
    const tsA = chartA.timeScale();
    const tsB = chartB.timeScale();
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

  function updateChartQuoteStripFromCandles(body) {
    const strip = body.querySelector("tr.rt-chart-row .rt-chart-quote-strip");
    if (!strip) return;
    strip.classList.add("rt-chart-quote-strip--empty");
    strip.innerHTML = "";
  }

  async function mountLightweightChart(body) {
    if (!state.openChartCode) return;
    const chartTr = body.querySelector("tr.rt-chart-row");
    const panes = body.querySelector("tr.rt-chart-row .rt-chart-panes");
    const candleHost = body.querySelector("tr.rt-chart-row .rt-lw-candle-host");
    const volHost = body.querySelector("tr.rt-chart-row .rt-lw-volume-host");
    if (!panes || !candleHost || !volHost) return;

    setChartRowLoading(chartTr, true);
    try {
      await ensureLightweightCharts(CHART_SCRIPT_TIMEOUT_MS);
      const LC = window.LightweightCharts;
      if (!LC || typeof LC.createChart !== "function") {
        candleHost.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml("차트 라이브러리를 불러오지 못했습니다.")}</p>`;
        volHost.innerHTML = "";
        return;
      }

      if (
        panes.dataset.mountedFor === state.openChartCode &&
        panes.dataset.mountedPeriod === state.candlePeriod &&
        state.lwChart &&
        state.lwVolChart
      ) {
        const w = panes.clientWidth;
        const hC = Math.max(candleHost.clientHeight, 80);
        const hV = Math.max(volHost.clientHeight, 60);
        if (w > 0) {
          state.lwChart.applyOptions({ width: w, height: hC });
          state.lwVolChart.applyOptions({ width: w, height: hV });
        }
        syncChartPeriodToolbarPressed(body);
        updateChartQuoteStripFromCandles(body);
        return;
      }

      disposeLwChart();
      delete panes.dataset.mountedFor;
      delete panes.dataset.mountedPeriod;
      candleHost.innerHTML = "";
      volHost.innerHTML = "";
      panes.removeAttribute("data-error");

      const periodUpper = String(state.candlePeriod || "D").toUpperCase();
      const localization = buildChartLocalization(periodUpper);

      const chartCommon = (width, height, timeScaleVisible) => ({
        width: Math.max(width, 200),
        height: Math.max(height, 60),
        layout: {
          background: { type: "solid", color: "#12100c" },
          textColor: "#c4b8a8",
        },
        localization,
        crosshair: {
          vertLine: {
            labelVisible: true,
          },
          horzLine: {
            labelVisible: true,
          },
        },
        grid: {
          vertLines: { color: "rgba(212, 175, 55, 0.08)" },
          horzLines: { color: "rgba(212, 175, 55, 0.08)" },
        },
        rightPriceScale: { borderColor: "rgba(148, 130, 98, 0.35)" },
        timeScale: {
          visible: timeScaleVisible,
          borderVisible: true,
          borderColor: "rgba(148, 130, 98, 0.35)",
          timeVisible: false,
          secondsVisible: false,
          allowBoldLabels: true,
        },
      });

      const w0 = Math.max(panes.clientWidth, 200);
      const hC0 = Math.max(candleHost.clientHeight, 80);
      const hV0 = Math.max(volHost.clientHeight, 60);

      const chartCandle = LC.createChart(candleHost, chartCommon(w0, hC0, false));
      /* 날짜 축: 거래량 패널 하단만 표시. 범위는 linkLogicalRangeSync로 캔들과 동기화 */
      const chartVol = LC.createChart(volHost, chartCommon(w0, hV0, true));

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
      } else if (typeof chartCandle.addCandlestickSeries === "function") {
        candle = chartCandle.addCandlestickSeries(candleOpts);
      } else {
        try {
          chartCandle.remove();
        } catch (e) {
          /* noop */
        }
        try {
          chartVol.remove();
        } catch (e2) {
          /* noop */
        }
        candleHost.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml("캔들 시리즈를 만들 수 없습니다.")}</p>`;
        return;
      }

      const vol = addHistogramSeriesCompat(chartVol, LC, {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      });

      if (!vol) {
        try {
          chartCandle.remove();
        } catch (e) {
          /* noop */
        }
        try {
          chartVol.remove();
        } catch (e2) {
          /* noop */
        }
        candleHost.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml("거래량 시리즈를 초기화하지 못했습니다.")}</p>`;
        return;
      }

      linkLogicalRangeSync(chartCandle, chartVol);

      state.lwChart = chartCandle;
      state.lwVolChart = chartVol;
      panes.dataset.mountedFor = state.openChartCode;
      panes.dataset.mountedPeriod = state.candlePeriod;

      const ro = new ResizeObserver(() => {
        if (!state.lwChart || !state.lwVolChart || !panes.isConnected) return;
        const w = panes.clientWidth;
        const hC = Math.max(candleHost.clientHeight, 80);
        const hV = Math.max(volHost.clientHeight, 60);
        if (w > 0) {
          state.lwChart.applyOptions({ width: w, height: hC });
          state.lwVolChart.applyOptions({ width: w, height: hV });
        }
      });
      ro.observe(panes);
      state.lwResizeObs = ro;

      const code6 = chartSymbolSixDigits(state.openChartCode);
      let candles = readChartCandleCache(state.openChartCode, periodUpper);
      if (!candles) {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), CHART_FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(
            `${API}?action=candle&code=${encodeURIComponent(code6)}&period=${encodeURIComponent(periodUpper)}`,
            { cache: "no-store", signal: ctrl.signal }
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          candles = Array.isArray(data.candles) ? data.candles : [];
          if (!candles.length) throw new Error("차트 데이터가 없습니다.");
          writeChartCandleCache(state.openChartCode, periodUpper, candles);
        } finally {
          clearTimeout(tid);
        }
      }

      state.lwBundle = {
        chartCandle,
        chartVol,
        candle,
        vol,
        fullCandles: candles,
      };
      wireRtCrosshairTooltip(panes, candleHost, volHost, chartCandle, chartVol, state.candlePeriod);
      applyLwChartVisibleRange();
      syncChartPeriodToolbarPressed(body);
      updateChartQuoteStripFromCandles(body);
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

    syncNameChartButtonsAria(body);
  }

  async function fetchJson(action, timeoutMs, extraQuery) {
    const useAbort = typeof timeoutMs === "number" && timeoutMs > 0;
    const ctrl = useAbort ? new AbortController() : null;
    const tid = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : 0;
    let url = `${API}?action=${encodeURIComponent(action)}`;
    if (extraQuery && typeof extraQuery === "object") {
      for (const [k, v] of Object.entries(extraQuery)) {
        if (v == null || v === "") continue;
        url += `&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
      }
    }
    console.log("[realtime-board] fetch →", action, url);
    try {
      const res = await fetch(url, {
        cache: "no-store",
        signal: ctrl ? ctrl.signal : undefined,
      });
      const data = await res.json().catch(() => ({}));
      console.log("[realtime-board] fetch ←", action, {
        ok: res.ok,
        status: res.status,
        keys: data && typeof data === "object" ? Object.keys(data) : [],
        stocksLen: Array.isArray(data.stocks) ? data.stocks.length : null,
      });
      if (!res.ok) {
        const msg =
          (data && typeof data.error === "string" && data.error) || `HTTP ${res.status}`;
        const err = new Error(msg);
        err.fetchStatus = res.status;
        err.fetchAction = action;
        err.fetchUrl = url;
        console.error("[realtime-board] fetch HTTP error", {
          action,
          status: res.status,
          statusText: res.statusText,
          url,
          error: data && data.error,
        });
        throw err;
      }
      return data;
    } catch (e) {
      console.error("[realtime-board] fetch failed", {
        action,
        message: e && e.message,
        status: e && e.fetchStatus,
        url: e && e.fetchUrl,
      }, e);
      if (useAbort && e && e.name === "AbortError") {
        throw new Error("요청 시간이 초과되었습니다.");
      }
      throw e;
    } finally {
      if (tid) clearTimeout(tid);
    }
  }

  function rowsLoadedForTab(tab) {
    if (tab === "cap") return state.capRows.length >= 10;
    if (tab === "gainers") return state.gainerRows.length >= 10;
    return false;
  }

  function applyStocksArrayToTab(tab, stocks) {
    const rows = (stocks || [])
      .filter((r) => r && String(r.code || "").replace(/\D/g, "").length > 0)
      .map((r) => ({ ...r, tab: r.tab || tab }));
    if (tab === "cap") state.capRows = rows;
    else if (tab === "gainers") state.gainerRows = rows;
  }

  async function fetchStocksJsonForTab(tab) {
    const action = tab === "cap" ? "market-cap" : "gainers";
    return fetchJson(action, FETCH_TIMEOUT_MS);
  }

  /** 탭별 종목 목록만 갱신 (세션·지수는 유지) — 캐시 만료 시 백그라운드용 */
  async function refreshTabStocksOnly(tab) {
    const stockPack = await fetchStocksJsonForTab(tab);
    applyStocksArrayToTab(tab, stockPack.stocks);
    state.tabLoadedAt[tab] = Date.now();
  }

  async function loadBootstrapForTab(tab) {
    const [sess, idx, stockPack] = await Promise.all([
      fetchJson("session", FETCH_TIMEOUT_MS),
      fetchJson("index", FETCH_TIMEOUT_MS),
      fetchStocksJsonForTab(tab),
    ]);
    state.clockSession = sess.clock || null;
    state.marketTime = sess.marketTime || null;
    function normIndexId(x) {
      const idRaw = x && x.id != null ? String(x.id).trim() : "";
      const label = x && x.label != null ? String(x.label).trim() : "";
      if (idRaw === "0001" || label.includes("코스피")) return "0001";
      if (idRaw === "1001" || label.includes("코스닥")) return "1001";
      // 일부 응답에서 001/1 같은 값이 섞일 수 있어 정규화
      if (idRaw === "001" || idRaw === "1") return "0001";
      return idRaw;
    }

    const byId = new Map();
    for (const x of idx.indexes || []) {
      const id = normIndexId(x);
      if (!id) continue;
      byId.set(id, {
        id,
        label: x.label,
        value: x.value,
        changePct: x.changePct,
      });
    }
    if (!byId.has("0001")) byId.set("0001", { id: "0001", label: "코스피", value: "", changePct: null });
    if (!byId.has("1001")) byId.set("1001", { id: "1001", label: "코스닥", value: "", changePct: null });
    state.indexes = ["0001", "1001"].map((k) => byId.get(k));
    applyStocksArrayToTab(tab, stockPack.stocks);
    state.tabLoadedAt[tab] = Date.now();
  }

  function showTableSkeleton() {
    const body = $("rt-tbody");
    if (!body) return;
    body.dataset.rtSkeleton = "1";
    const cs = tableColSpan();
    const parts = [];
    for (let i = 0; i < 10; i++) {
      parts.push(
        `<tr class="rt-skel-row" aria-hidden="true"><td colspan="${cs}"><span class="rt-skel-bar"></span></td></tr>`
      );
    }
    body.innerHTML = parts.join("");
  }

  function hideTableSkeleton() {
    const body = $("rt-tbody");
    if (body) delete body.dataset.rtSkeleton;
  }

  function rtErrorTimeoutMessage(err) {
    const m = String(err && err.message ? err.message : err || "");
    return /시간이 초과|시간 초과|AbortError/i.test(m) ? "데이터를 불러오지 못했습니다. 새로고침 해주세요" : m;
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

  /** 웹소켓 CCNL 매핑 후에도 stck_prpr 우선 — 짧은 페이로드 시 cells[0]=종목코드, cells[2]=현재가 보정 */
  function pickWsStckPrpr(o, cells) {
    let p = String(o.STCK_PRPR || "").trim();
    if (p) return p;
    if (cells && cells.length > 2) {
      const c0 = String(cells[0] || "").replace(/\D/g, "");
      const code6 = c0.length <= 6 ? c0.padStart(6, "0") : c0.slice(-6);
      if (/^\d{6}$/.test(code6)) {
        p = String(cells[2] != null ? cells[2] : "").trim();
      }
    }
    return p;
  }

  function rowFromCcnl(cells, trId) {
    const o = {};
    CCNL_COLS.forEach((k, i) => {
      o[k] = cells[i] != null ? cells[i] : "";
    });
    let code = String(o.MKSC_SHRN_ISCD || "").trim().replace(/\D/g, "");
    if (code.length > 6) code = code.slice(-6);
    if (!/^\d{6}$/.test(code) && cells[0]) {
      const c0 = String(cells[0]).replace(/\D/g, "");
      const c6 = c0.length <= 6 ? c0.padStart(6, "0") : c0.slice(-6);
      if (/^\d{6}$/.test(c6)) code = c6;
    }
    const price = pickWsStckPrpr(o, cells);
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
    if (patch.stck_avls != null && String(patch.stck_avls).trim() !== "") cur.stck_avls = patch.stck_avls;
    if (patch.mcapEok != null && String(patch.mcapEok).trim() !== "") cur.mcapEok = patch.mcapEok;
    if (patch.hourCls) cur.hourCls = patch.hourCls;
    if (patch.mrkt) cur.mrktCls = patch.mrkt;
    list[i] = cur;
  }

  function getCurrentRows() {
    if (state.tab === "cap") return state.capRows;
    if (state.tab === "gainers") return state.gainerRows;
    return state.capRows;
  }

  function ccnlTrIdForTab() {
    return "H0UNCNT0";
  }

  function tableColSpan() {
    return 6;
  }

  function renderThead() {
    const tr = document.getElementById("rt-thead-row");
    if (!tr) return;
    if (state.tab === "gainers") {
      tr.innerHTML =
        '<th class="rt-td-rank">순위</th><th class="rt-td-name">종목명</th><th class="num rt-td-price">현재가</th><th class="num rt-td-chg">등락률</th><th class="num rt-td-vol">거래량</th><th class="num rt-td-tv">거래대금</th>';
      return;
    }
    tr.innerHTML =
      '<th class="rt-td-rank">순위</th><th class="rt-td-name">종목명</th><th class="num rt-td-price">가격</th><th class="num rt-td-chg">등락률</th><th class="num rt-td-tv">거래대금</th><th class="num rt-td-mcap">시가총액</th>';
  }

  function getTableTitle() {
    return "";
  }

  function renderIndexes() {
    const el = $("rt-indexes");
    if (!el) return;
    const rows = (state.indexes || []).filter(Boolean);
    const kospi = rows.find((r) => r && r.id === "0001");
    if (!kospi) {
      console.log("[realtime-board] indexes missing KOSPI", { indexes: rows });
    } else {
      console.log("[realtime-board] KOSPI index", kospi);
    }
    el.innerHTML = rows
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

    if (state.tab === "gainers") {
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

    const ch = r.changePct;
    const cls = deltaClass(ch);
    const tv = formatTradeVal(r.tradingValue);
    const mcap = formatStckAvls(readStckAvlsRaw(r));
    return `<tr class="rt-stock-row" data-code="${escapeHtml(r.code)}">
          <td class="num rt-td-rank">${r.rank != null ? escapeHtml(String(r.rank)) : "—"}</td>
          <td class="rt-td-name">${nameCell}</td>
          <td class="num rt-td-price">${escapeHtml(fmtNum(r.price))}</td>
          <td class="num rt-td-chg"><span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span></td>
          <td class="num rt-td-tv">${escapeHtml(tv)}</td>
          <td class="num rt-td-mcap">${escapeHtml(mcap)}</td>
        </tr>`;
  }

  function chartRowHtml(forCode) {
    const cs = tableColSpan();
    return `<tr class="rt-chart-row" data-chart-for="${escapeHtml(forCode)}">
          <td colspan="${cs}">
            <div class="rt-chart-wrap">
              <div class="rt-chart-quote-strip rt-chart-quote-strip--empty" aria-live="polite"></div>
              <div class="rt-chart-toolbar" role="toolbar" aria-label="캔들 주기">
                <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="D" aria-pressed="true">일봉</button>
                <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="W" aria-pressed="false">주봉</button>
                <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="M" aria-pressed="false">월봉</button>
              </div>
              <div class="rt-chart-body">
                <p class="rt-chart-loading-msg" aria-live="polite">차트 불러오는 중...</p>
                <div class="rt-chart-panes rt-chart-panes--pending">
                  <div class="rt-chart-pane rt-chart-pane--candle">
                    <div class="rt-lw-candle-host" role="region" aria-label="캔들 차트"></div>
                  </div>
                  <div class="rt-chart-pane-sep" aria-hidden="true"></div>
                  <div class="rt-chart-pane rt-chart-pane--vol">
                    <div class="rt-lw-volume-host" role="region" aria-label="거래량 차트"></div>
                  </div>
                </div>
              </div>
            </div>
          </td>
        </tr>`;
  }

  function applyRowToTr(tr, r) {
    const nm = escapeHtml(r.name);
    tr.cells[0].textContent = r.rank != null ? String(r.rank) : "—";

    tr.cells[1].innerHTML = `<button type="button" class="rt-name-chart-btn" data-code="${escapeHtml(r.code)}" aria-expanded="${state.openChartCode === r.code ? "true" : "false"}">${nm}</button>`;

    if (state.tab === "gainers") {
      const ch = r.changePct;
      const cls = deltaClass(ch);
      tr.cells[2].textContent = fmtNum(r.price);
      tr.cells[3].innerHTML = `<span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span>`;
      tr.cells[4].textContent = fmtNum(r.volume);
      tr.cells[5].textContent = formatTradeVal(r.tradingValue);
      return;
    }

    const ch = r.changePct;
    const cls = deltaClass(ch);
    tr.cells[2].textContent = fmtNum(r.price);
    tr.cells[3].innerHTML = `<span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span>`;
    tr.cells[4].textContent = formatTradeVal(r.tradingValue);
    tr.cells[5].textContent = formatStckAvls(readStckAvlsRaw(r));
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

  function syncTableChromeForTab() {
    const title = $("rt-table-title");
    if (title) title.textContent = getTableTitle();
    renderThead();
  }

  function renderTable() {
    const body = $("rt-tbody");
    const title = $("rt-table-title");
    if (!body) return;
    if (title) title.textContent = getTableTitle();
    if (body.dataset.rtSkeleton === "1") return;
    renderThead();
    const rows = getCurrentRows();
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

  function formatMarketCapPretty(rawOrNum) {
    const n = Number(String(rawOrNum == null ? "" : rawOrNum).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return "—";
    // 단위 불확실(원/백만원/억원)일 수 있어, 너무 큰 값은 그대로 표기
    if (n >= 1e12 && n <= 5e15) {
      const jo = n / 1e12;
      return `${jo.toFixed(2).replace(/\.?0+$/, "")}조`;
    }
    if (n >= 1e8 && n < 1e12) {
      return `${Math.round(n / 1e8).toLocaleString("ko-KR")}억`;
    }
    return n.toLocaleString("ko-KR");
  }

  function buildStockResultSkeleton() {
    return `<div class="rt-stock-loading"><span class="rt-spinner" aria-hidden="true"></span><span>종목 정보를 불러오는 중...</span></div>`;
  }

  function stockPanelHtml(data) {
    const name = escapeHtml(data.stockName || "—");
    const code = escapeHtml(data.stockCode || "");
    const market = escapeHtml(data.market || "");
    const badge = market ? `<span class="rt-badge">${market}</span>` : "";

    const ch = Number(data.changeRate);
    const cls = deltaClass(Number.isFinite(ch) ? ch : null);
    const price = escapeHtml(fmtNum(data.currentPrice));
    const pct = escapeHtml(fmtPct(Number.isFinite(ch) ? ch : null));

    const open = escapeHtml(fmtNum(data.open));
    const high = escapeHtml(fmtNum(data.high));
    const low = escapeHtml(fmtNum(data.low));
    const vol = escapeHtml(fmtNum(data.volume));
    const hi52 = escapeHtml(fmtNum(data.high52w));
    const lo52 = escapeHtml(fmtNum(data.low52w));
    const mcap = escapeHtml(formatMarketCapPretty(data.marketCapRaw || data.marketCap));
    const per = data.per == null || !Number.isFinite(Number(data.per)) ? "—" : Number(data.per).toFixed(2);

    const aiHref = `/stock-analysis.html?code=${encodeURIComponent(String(data.stockCode || ""))}&name=${encodeURIComponent(
      String(data.stockName || "")
    )}`;

    const fin = data.financials || {};
    const finPer = fin.per == null ? per : Number(fin.per).toFixed(2);
    const finEps = fin.eps == null ? "—" : fmtNum(fin.eps);
    const finPbr = fin.pbr == null ? "—" : String(fin.pbr);
    const finBps = fin.bps == null ? "—" : fmtNum(fin.bps);
    const finRoe = fin.roe == null ? "—" : `${Number(fin.roe).toFixed(2).replace(/\\.00$/, "")}%`;
    const finFhr = fin.foreignHoldRate == null ? "—" : `${Number(fin.foreignHoldRate).toFixed(2).replace(/\\.00$/, "")}%`;

    const sup = data.supply || {};
    const supInst = sup.institution == null ? "—" : fmtNum(sup.institution);
    const supIndv = sup.individual == null ? "—" : fmtNum(sup.individual);
    const supFrgn = sup.foreigner == null ? "—" : fmtNum(sup.foreigner);

    const pf = data.profit || {};
    const pfRev = pf.revenue == null ? "—" : fmtNum(pf.revenue);
    const pfOp = pf.operatingProfit == null ? "—" : fmtNum(pf.operatingProfit);
    const pfNet = pf.netIncome == null ? "—" : fmtNum(pf.netIncome);
    const pfDate = pf.baseDate ? String(pf.baseDate) : "—";

    return [
      `<div class="rt-stock-head rt-stock-head--wide">`,
      `  <div class="rt-stock-title">`,
      `    <span class="rt-stock-name">${name}</span>`,
      `    <span class="rt-stock-code">${code}</span>`,
      `    ${badge}`,
      `  </div>`,
      `  <div class="rt-stock-quote">`,
      `    <span class="rt-stock-price">${price}</span>`,
      `    <span class="delta ${cls}">${pct}</span>`,
      `  </div>`,
      `</div>`,

      `<div class="rt-stock-main">`,
      `  <div class="rt-stock-chart-col">`,
      `    <button type="button" class="rt-chart-toggle" aria-expanded="false">차트 보기 ▼</button>`,
      `    <div class="rt-chart-wrap">`,
      `      <div class="rt-chart-toolbar" role="toolbar" aria-label="캔들 주기" hidden>`,
      `        <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="D" aria-pressed="true">일봉</button>`,
      `        <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="W" aria-pressed="false">주봉</button>`,
      `        <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="M" aria-pressed="false">월봉</button>`,
      `      </div>`,
      `      <div class="rt-chart-body">`,
      `        <p class="rt-chart-loading-msg" aria-live="polite">차트 불러오는 중...</p>`,
      `        <div class="rt-chart-panes rt-chart-panes--pending" style="display:none;">`,
      `          <div class="rt-chart-pane rt-chart-pane--candle"><div class="rt-lw-candle-host" role="region" aria-label="캔들 차트"></div></div>`,
      `          <div class="rt-chart-pane-sep" aria-hidden="true"></div>`,
      `          <div class="rt-chart-pane rt-chart-pane--vol"><div class="rt-lw-volume-host" role="region" aria-label="거래량 차트"></div></div>`,
      `        </div>`,
      `      </div>`,
      `    </div>`,
      `  </div>`,
      `  <div class="rt-stock-side">`,
      `    <div class="rt-side-grid">`,
      `      <div class="rt-kv rt-kv--hi"><div class="rt-kv__k">시작가</div><div class="rt-kv__v">${open}</div></div>`,
      `      <div class="rt-kv rt-kv--hi"><div class="rt-kv__k">고가</div><div class="rt-kv__v">${high}</div></div>`,
      `      <div class="rt-kv rt-kv--lo"><div class="rt-kv__k">저가</div><div class="rt-kv__v">${low}</div></div>`,
      `      <div class="rt-kv"><div class="rt-kv__k">거래량</div><div class="rt-kv__v">${vol}</div></div>`,
      `      <div class="rt-kv rt-kv--hi52"><div class="rt-kv__k">52주 최고</div><div class="rt-kv__v">${hi52}</div></div>`,
      `      <div class="rt-kv rt-kv--lo52"><div class="rt-kv__k">52주 최저</div><div class="rt-kv__v">${lo52}</div></div>`,
      `      <div class="rt-kv"><div class="rt-kv__k">시가총액</div><div class="rt-kv__v">${mcap}</div></div>`,
      `      <div class="rt-kv"><div class="rt-kv__k">PER</div><div class="rt-kv__v">${escapeHtml(finPer)}</div></div>`,
      `    </div>`,
      `  </div>`,
      `</div>`,

      `<div class="rt-split">`,
      `  <div class="rt-card">`,
      `    <div class="rt-card__title">수급</div>`,
      `    <div class="rt-trip-grid">`,
      `      <div class="rt-kv"><div class="rt-kv__k">기관</div><div class="rt-kv__v">${escapeHtml(supInst)}</div></div>`,
      `      <div class="rt-kv"><div class="rt-kv__k">개인</div><div class="rt-kv__v">${escapeHtml(supIndv)}</div></div>`,
      `      <div class="rt-kv"><div class="rt-kv__k">외국인</div><div class="rt-kv__v">${escapeHtml(supFrgn)}</div></div>`,
      `    </div>`,
      `    <div class="rt-card__sub">외국인 보유율: ${escapeHtml(finFhr)}</div>`,
      `  </div>`,
      `  <div class="rt-card">`,
      `    <div class="rt-card__title">실적</div>`,
      `    <div class="rt-trip-grid">`,
      `      <div class="rt-kv"><div class="rt-kv__k">매출</div><div class="rt-kv__v">${escapeHtml(pfRev)}</div></div>`,
      `      <div class="rt-kv"><div class="rt-kv__k">영업이익</div><div class="rt-kv__v">${escapeHtml(pfOp)}</div></div>`,
      `      <div class="rt-kv"><div class="rt-kv__k">당기순이익</div><div class="rt-kv__v">${escapeHtml(pfNet)}</div></div>`,
      `    </div>`,
      `    <div class="rt-card__sub">기준일: ${escapeHtml(pfDate)}</div>`,
      `  </div>`,
      `</div>`,

      `<div class="rt-stock-actions">`,
      `  <a class="rt-cta" href="${escapeHtml(aiHref)}">이 종목 AI 분석하기</a>`,
      `</div>`,
    ].join("");
  }

  async function mountStockPanelChart(panelEl, code6, periodUpper) {
    const panes = panelEl.querySelector(".rt-chart-panes");
    const candleHost = panelEl.querySelector(".rt-lw-candle-host");
    const volHost = panelEl.querySelector(".rt-lw-volume-host");
    const msg = panelEl.querySelector(".rt-chart-loading-msg");
    if (!panes || !candleHost || !volHost) return;
    if (msg) msg.hidden = false;
    panes.classList.add("rt-chart-panes--pending");

    try {
      await ensureLightweightCharts(CHART_SCRIPT_TIMEOUT_MS);
      const LC = window.LightweightCharts;
      if (!LC || typeof LC.createChart !== "function") throw new Error("차트 라이브러리를 불러오지 못했습니다.");

      // 기존 테이블 차트와 충돌 방지: 패널에서는 별도 인스턴스 사용 (간단히 host 비우고 재생성)
      candleHost.innerHTML = "";
      volHost.innerHTML = "";

      const w0 = Math.max(panes.clientWidth, 200);
      const hC0 = Math.max(candleHost.clientHeight, 80);
      const hV0 = Math.max(volHost.clientHeight, 60);
      const localization = buildChartLocalization(periodUpper);
      const chartCommon = (width, height, timeScaleVisible) => ({
        width: Math.max(width, 200),
        height: Math.max(height, 60),
        layout: { background: { type: "solid", color: "#12100c" }, textColor: "#c4b8a8" },
        localization,
        grid: {
          vertLines: { color: "rgba(212, 175, 55, 0.08)" },
          horzLines: { color: "rgba(212, 175, 55, 0.08)" },
        },
        rightPriceScale: { borderColor: "rgba(148, 130, 98, 0.35)" },
        timeScale: {
          visible: timeScaleVisible,
          borderVisible: true,
          borderColor: "rgba(148, 130, 98, 0.35)",
          timeVisible: false,
          secondsVisible: false,
          allowBoldLabels: true,
        },
      });

      const chartCandle = LC.createChart(candleHost, chartCommon(w0, hC0, false));
      const chartVol = LC.createChart(volHost, chartCommon(w0, hV0, true));

      const candleOpts = {
        upColor: CANDLE_UP,
        downColor: CANDLE_DOWN,
        borderUpColor: CANDLE_UP,
        borderDownColor: CANDLE_DOWN,
        wickUpColor: CANDLE_UP,
        wickDownColor: CANDLE_DOWN,
      };
      const candle =
        LC.CandlestickSeries && typeof chartCandle.addSeries === "function"
          ? chartCandle.addSeries(LC.CandlestickSeries, candleOpts)
          : chartCandle.addCandlestickSeries(candleOpts);

      const vol = addHistogramSeriesCompat(chartVol, LC, {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      });
      if (!vol) throw new Error("거래량 시리즈를 초기화하지 못했습니다.");
      linkLogicalRangeSync(chartCandle, chartVol);
      wireRtCrosshairTooltip(panes, candleHost, volHost, chartCandle, chartVol, periodUpper);

      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), CHART_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(
          `${API}?action=candle&code=${encodeURIComponent(code6)}&period=${encodeURIComponent(periodUpper)}`,
          { cache: "no-store", signal: ctrl.signal }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const candles = Array.isArray(data.candles) ? data.candles : [];
        if (!candles.length) throw new Error("차트 데이터가 없습니다.");
        const sliced = sliceCandlesFromEnd(candles, state.chartBarsLimit || 200);
        candle.setData(sliced);
        vol.setData(buildVolumeHistogramData(sliced));
        chartCandle.timeScale().fitContent();
        chartVol.timeScale().fitContent();
      } finally {
        clearTimeout(tid);
      }
    } catch (e) {
      const msgText =
        e && e.name === "AbortError"
          ? "차트 불러오기 시간이 초과되었습니다."
          : e && e.message
            ? e.message
            : String(e);
      candleHost.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml(msgText)}</p>`;
      volHost.innerHTML = "";
    } finally {
      if (msg) msg.hidden = true;
      panes.classList.remove("rt-chart-panes--pending");
    }
  }

  async function searchStock() {
    const input = $("stock-search-input");
    const btn = $("stock-search-btn");
    const panel = $("stock-result-panel");
    const q = input && input.value ? String(input.value).trim() : "";
    if (!panel) return;
    if (!q) {
      panel.hidden = true;
      if (input) input.focus();
      return;
    }
    panel.hidden = false;
    panel.innerHTML = buildStockResultSkeleton();
    if (btn) btn.disabled = true;

    try {
      const res = await fetch(`/api/stock-analysis?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      if (data && data.error) {
        panel.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml(data.error)}</p>`;
        return;
      }

      panel.innerHTML = stockPanelHtml(data);

      const toggleBtn = panel.querySelector(".rt-chart-toggle");
      const panesEl = panel.querySelector(".rt-chart-panes");
      const toolbarEl = panel.querySelector(".rt-chart-toolbar");
      const loadingMsg = panel.querySelector(".rt-chart-loading-msg");
      let chartOpen = false;

      function applyChartVisibility(nextOpen) {
        chartOpen = !!nextOpen;
        if (toggleBtn) {
          toggleBtn.setAttribute("aria-expanded", chartOpen ? "true" : "false");
          toggleBtn.textContent = chartOpen ? "차트 닫기 ▲" : "차트 보기 ▼";
        }
        if (toolbarEl) toolbarEl.hidden = !chartOpen;
        if (panesEl) panesEl.style.display = chartOpen ? "" : "none";
        if (loadingMsg) loadingMsg.hidden = !chartOpen;
      }

      applyChartVisibility(false);
      if (toggleBtn) {
        toggleBtn.addEventListener("click", () => {
          applyChartVisibility(!chartOpen);
          if (chartOpen) {
            void mountStockPanelChart(panel, String(data.stockCode || ""), "D");
          }
        });
      }

      // 차트 버튼(패널) 주기 전환
      panel.querySelectorAll(".rt-chart-interval-btn").forEach((b) => {
        b.addEventListener("click", () => {
          if (!chartOpen) applyChartVisibility(true);
          const p = b.getAttribute("data-rt-candle-period") || "D";
          panel.querySelectorAll(".rt-chart-interval-btn").forEach((x) =>
            x.setAttribute("aria-pressed", x === b ? "true" : "false")
          );
          void mountStockPanelChart(panel, String(data.stockCode || ""), String(p).toUpperCase());
        });
      });
      // 초기에는 차트 로드하지 않음 (토글 열릴 때 로드)
    } catch (e) {
      panel.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml(rtErrorTimeoutMessage(e))}</p>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.searchStock = searchStock;

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
    if (trId === "H0UNCNT0" || trId === "H0STCNT0") {
      const row = rowFromCcnl(cells, trId);
      mergeStockRow(state.capRows, row);
      mergeStockRow(state.gainerRows, row);
      if (state.tab === "cap" || state.tab === "gainers") renderTable();
      return;
    }
  }

  function subscribeStocks(codes) {
    if (!state.ws || state.ws.readyState !== 1) return;
    const trId = ccnlTrIdForTab();
    const limit = state.tab === "cap" ? 30 : 50;
    const list = codes
      .map((c) => String(c || "").replace(/\D/g, ""))
      .map((d) => (d.length <= 6 ? d.padStart(6, "0") : d.slice(-6)))
      .filter((c) => /^\d{6}$/.test(c))
      .slice(0, limit);
    for (const c of list) {
      const key = `${trId}:${c}`;
      if (state.codesSubscribed.has(key)) continue;
      state.ws.send(makeWsPayload("1", trId, c));
      state.codesSubscribed.add(key);
    }
  }

  function unsubscribeAll() {
    if (!state.ws || state.ws.readyState !== 1) return;
    for (const key of state.codesSubscribed) {
      const sep = key.indexOf(":");
      const trId = sep >= 0 ? key.slice(0, sep) : "H0UNCNT0";
      const c = sep >= 0 ? key.slice(sep + 1) : key;
      state.ws.send(makeWsPayload("0", trId, c));
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

  async function refreshPartial() {
    try {
      const stockPromise =
        state.tab === "gainers" ? fetchJson("gainers", FETCH_TIMEOUT_MS) : fetchJson("market-cap", FETCH_TIMEOUT_MS);

      const [stockPack, idxPack, sessPack] = await Promise.all([
        stockPromise,
        fetchJson("index", FETCH_TIMEOUT_MS),
        fetchJson("session", FETCH_TIMEOUT_MS),
      ]);

      function normIndexId(x) {
        const idRaw = x && x.id != null ? String(x.id).trim() : "";
        const label = x && x.label != null ? String(x.label).trim() : "";
        if (idRaw === "0001" || label.includes("코스피")) return "0001";
        if (idRaw === "1001" || label.includes("코스닥")) return "1001";
        if (idRaw === "001" || idRaw === "1") return "0001";
        return idRaw;
      }
      const byId = new Map();
      for (const x of idxPack.indexes || []) {
        const id = normIndexId(x);
        if (!id) continue;
        byId.set(id, { id, label: x.label, value: x.value, changePct: x.changePct });
      }
      if (!byId.has("0001")) byId.set("0001", { id: "0001", label: "코스피", value: "", changePct: null });
      if (!byId.has("1001")) byId.set("1001", { id: "1001", label: "코스닥", value: "", changePct: null });
      state.indexes = ["0001", "1001"].map((k) => byId.get(k));
      state.clockSession = sessPack.clock || null;
      state.marketTime = sessPack.marketTime || null;

      if (state.tab === "gainers") {
        const { stocks } = stockPack;
        state.gainerRows = (stocks || []).map((r) => ({ ...r, tab: "gainers" }));
      } else {
        const { stocks } = stockPack;
        state.capRows = (stocks || []).map((r) => ({ ...r, tab: "cap" }));
      }
      state.tabLoadedAt[state.tab] = Date.now();
      renderAll();
      if (state.ws && state.ws.readyState === 1) {
        unsubscribeAll();
        subscribeStocks(getCurrentRows().map((r) => r.code));
      }
    } catch (e) {
      console.error("[realtime-board] refreshPartial", {
        tab: state.tab,
        message: e && e.message,
        status: e && e.fetchStatus,
      }, e);
      const err = $("rt-error");
      if (err) {
        if (rowsLoadedForTab(state.tab)) {
          err.hidden = true;
        } else {
          err.hidden = false;
          err.textContent = rtErrorTimeoutMessage(e);
        }
      }
    }
  }

  function setupTabs() {
    document.querySelectorAll("[data-rt-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.getAttribute("data-rt-tab");
        if (t === "gainers") state.tab = "gainers";
        else state.tab = "cap";
        state.openChartCode = null;
        state.candlePeriod = "D";
        document.querySelectorAll("[data-rt-tab]").forEach((b) => {
          b.setAttribute("aria-selected", b.getAttribute("data-rt-tab") === state.tab ? "true" : "false");
        });

        const finish = () => {
          startPolling();
          if (state.ws && state.ws.readyState === 1) {
            unsubscribeAll();
            subscribeStocks(getCurrentRows().map((r) => r.code));
          }
        };

        const tk = state.tab;
        const errEl = $("rt-error");
        const hasRows = rowsLoadedForTab(tk);
        const cacheFresh =
          state.tabLoadedAt[tk] && Date.now() - state.tabLoadedAt[tk] < TAB_CACHE_MS;

        if (hasRows) {
          if (errEl) errEl.hidden = true;
          renderAll();
          finish();
          if (!cacheFresh) {
            refreshTabStocksOnly(tk)
              .then(() => {
                if (errEl) errEl.hidden = true;
                renderAll();
              })
              .catch((e) => {
                console.error("[realtime-board] refreshTabStocksOnly (tab cache)", tk, e && e.message, e);
                if (errEl) {
                  errEl.hidden = false;
                  errEl.textContent = rtErrorTimeoutMessage(e);
                }
              });
          }
          return;
        }

        if (errEl) errEl.hidden = true;
        syncTableChromeForTab();
        showTableSkeleton();
        loadBootstrapForTab(tk)
          .then(() => {
            hideTableSkeleton();
            if (errEl) errEl.hidden = true;
            renderAll();
          })
          .catch((e) => {
            console.error("[realtime-board] loadBootstrapForTab", tk, e && e.message, e);
            hideTableSkeleton();
            if (errEl) {
              errEl.hidden = false;
              errEl.textContent = rtErrorTimeoutMessage(e);
            }
            renderAll();
          })
          .finally(() => {
            finish();
          });
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
        if (state.candlePeriod === p && state.lwBundle && state.lwChart && state.lwVolChart) {
          body.querySelectorAll(".rt-chart-interval-btn").forEach((btn) => {
            btn.setAttribute("aria-pressed", btn === intervalBtn ? "true" : "false");
          });
          return;
        }
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
      const btn = ev.target.closest(".rt-name-chart-btn");
      if (!btn || !body.contains(btn)) return;
      const code = btn.getAttribute("data-code");
      if (!code) return;
      if (state.openChartCode === code) {
        state.openChartCode = null;
      } else {
        state.openChartCode = code;
        state.candlePeriod = "D";
      }
      renderTable();
    });
  }

  function startPolling() {
    if (state.pollRest) clearInterval(state.pollRest);
    const period = state.tab === "gainers" ? 5000 : 12000;
    state.pollRest = setInterval(() => {
      refreshPartial().catch((e) => {
        console.error("[realtime-board] poll refreshPartial", e && e.message, e);
      });
    }, period);
  }

  async function init() {
    setupTabs();
    wireTableChartAccordion();
    const searchInput = $("stock-search-input");
    if (searchInput && !searchInput.dataset.wired) {
      searchInput.dataset.wired = "1";
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") searchStock();
      });
    }
    const err = $("rt-error");
    if (err) err.hidden = true;
    hideLoadingOverlay();
    syncTableChromeForTab();
    showTableSkeleton();
    try {
      await loadBootstrapForTab(state.tab);
      if (err) err.hidden = true;
    } catch (e) {
      if (err) {
        console.error("[realtime-board] init bootstrap", e && e.message, e);
        err.hidden = false;
        err.textContent = rtErrorTimeoutMessage(e);
      }
    } finally {
      hideTableSkeleton();
      renderAll();
      startPolling();
      await tryConnectWs();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
