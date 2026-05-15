/* global document, window, fetch, WebSocket, Intl, setInterval, clearInterval, requestAnimationFrame */
(function () {
  "use strict";

  const API = "/api/kis-realtime-data";
  const FETCH_TIMEOUT_MS = 10000;
  /** 거래대금 TOP50 — 시장당 API 1회(mrkt=J|Q); 클라이언트 대기 상한 */
  const TRADE_PBMN_FETCH_TIMEOUT_MS = 20000;
  const TAB_CACHE_MS = 5 * 60 * 1000;
  /** 차트 캔들 API·라이브러리 로드 상한 (TradingView 미사용, Lightweight Charts 지연 로드) */
  const CHART_FETCH_TIMEOUT_MS = 8000;
  const CHART_SCRIPT_TIMEOUT_MS = 8000;
  const CHART_CACHE_MAX_ENTRIES = 24;

  /** Lightweight Charts 스크립트 1회 로드 Promise */
  let lwChartsScriptPromise = null;
  const chartCandleCache = new Map();
  /** 한투 REST는 NXT 전용 fid_cond_mrkt_div_code 미지원 → UI만 준비중 */
  const NXT_DISABLED = true;

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
    nxtSub: "fluctuation",
    capRows: [],
    gainerRows: [],
    /** 거래대금 탭: 시장별 캐시 — API는 mrkt=J|Q 로 시장당 1회만 호출 */
    tradeValSub: "kospi",
    tradeValKospiRows: [],
    tradeValKosdaqRows: [],
    tradeValSubLoadedAt: {},
    prevDayRows: [],
    prevDayNoData: false,
    prevDayLoaded: false,
    nxtFluctRows: [],
    nxtPbmnRows: [],
    nxtVolRows: [],
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
    /** NXT 서브탭별 마지막 성공 로드 시각 */
    nxtSubLoadedAt: {},
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

  function updateChartQuoteStripFromCandles(body, candles) {
    const strip = body.querySelector("tr.rt-chart-row .rt-chart-quote-strip");
    if (!strip) return;
    if (state.tab !== "prevday") {
      strip.classList.add("rt-chart-quote-strip--empty");
      strip.innerHTML = "";
      return;
    }
    if (!Array.isArray(candles) || candles.length === 0) {
      strip.classList.add("rt-chart-quote-strip--empty");
      strip.innerHTML = "";
      return;
    }
    strip.classList.remove("rt-chart-quote-strip--empty");
    const last = candles[candles.length - 1];
    const close = Number(last && last.close);
    const prevBar = candles.length >= 2 ? candles[candles.length - 2] : null;
    let chg = null;
    if (prevBar != null && Number.isFinite(Number(prevBar.close)) && Number(prevBar.close) !== 0) {
      const pc = Number(prevBar.close);
      chg = ((close - pc) / pc) * 100;
    }
    const priceStr = Number.isFinite(close) ? fmtNum(String(close)) : "—";
    const chgStr = chg != null && Number.isFinite(chg) ? fmtPct(chg) : "—";
    const cls = deltaClass(chg);
    strip.innerHTML = `<span class="rt-chart-quote-strip__inner">
      <span class="rt-chart-quote-strip__lbl">현재가(선택 봉 종가)</span>
      <span class="rt-chart-quote-strip__val">${escapeHtml(priceStr)}</span>
      <span class="rt-chart-quote-strip__sep">·</span>
      <span class="rt-chart-quote-strip__lbl">등락률(직전 봉 대비)</span>
      <span class="delta ${cls}">${escapeHtml(chgStr)}</span>
    </span>`;
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
        updateChartQuoteStripFromCandles(body, state.lwBundle && state.lwBundle.fullCandles);
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
      updateChartQuoteStripFromCandles(body, candles);
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
    if (tab === "nxt" && NXT_DISABLED) return true;
    if (tab === "cap") return state.capRows.length >= 10;
    if (tab === "gainers") return state.gainerRows.length >= 10;
    if (tab === "tradeval") return getTradeValRowsForSub().length >= 10;
    if (tab === "prevday") {
      return state.prevDayLoaded && (state.prevDayRows.length > 0 || state.prevDayNoData);
    }
    if (tab === "nxt") {
      const rows = getNxtRowsForSub();
      return rows.length >= 5;
    }
    return false;
  }

  function getNxtRowsForSub() {
    if (state.nxtSub === "trade") return state.nxtPbmnRows;
    if (state.nxtSub === "volume") return state.nxtVolRows;
    return state.nxtFluctRows;
  }

  function getTradeValRowsForSub() {
    return state.tradeValSub === "kosdaq" ? state.tradeValKosdaqRows : state.tradeValKospiRows;
  }

  function applyStocksArrayToTab(tab, stocks) {
    const rows = (stocks || [])
      .filter((r) => r && String(r.code || "").replace(/\D/g, "").length > 0)
      .map((r) => ({ ...r, tab: tab === "nxt" ? "nxt" : r.tab || tab }));
    if (tab === "cap") state.capRows = rows;
    else if (tab === "gainers") state.gainerRows = rows;
    else if (tab === "tradeval") {
      if (state.tradeValSub === "kosdaq") state.tradeValKosdaqRows = rows;
      else state.tradeValKospiRows = rows;
    }
    else if (tab === "prevday") state.prevDayRows = rows;
    else if (tab === "nxt") {
      if (state.nxtSub === "trade") state.nxtPbmnRows = rows;
      else if (state.nxtSub === "volume") state.nxtVolRows = rows;
      else state.nxtFluctRows = rows;
    }
  }

  async function fetchStocksJsonForTab(tab) {
    if (tab === "nxt" && NXT_DISABLED) return { stocks: [] };
    const action =
      tab === "cap"
        ? "market-cap"
        : tab === "gainers"
          ? "gainers"
          : tab === "tradeval"
            ? "trade-pbmn-top50"
            : tab === "prevday"
              ? "prev-day-top50"
              : nxtFetchAction();
    const ms = tab === "tradeval" ? TRADE_PBMN_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS;
    if (tab === "tradeval") {
      const mrkt = state.tradeValSub === "kosdaq" ? "Q" : "J";
      return fetchJson(action, ms, { mrkt });
    }
    return fetchJson(action, ms);
  }

  /** 탭별 종목 목록만 갱신 (세션·지수는 유지) — 캐시 만료 시 백그라운드용 */
  async function refreshTabStocksOnly(tab) {
    const stockPack = await fetchStocksJsonForTab(tab);
    if (tab === "prevday") {
      state.prevDayNoData = Boolean(stockPack.noData);
      state.prevDayLoaded = true;
    }
    applyStocksArrayToTab(tab, stockPack.stocks);
    state.tabLoadedAt[tab] = Date.now();
    if (tab === "nxt" && !NXT_DISABLED) {
      state.nxtSubLoadedAt[state.nxtSub] = Date.now();
    }
    if (tab === "tradeval") {
      state.tradeValSubLoadedAt[state.tradeValSub] = Date.now();
    }
  }

  async function loadBootstrapForTab(tab) {
    const [sess, idx, stockPack] = await Promise.all([
      fetchJson("session", FETCH_TIMEOUT_MS),
      fetchJson("index", FETCH_TIMEOUT_MS),
      fetchStocksJsonForTab(tab),
    ]);
    state.clockSession = sess.clock || null;
    state.marketTime = sess.marketTime || null;
    state.indexes = (idx.indexes || []).map((x) => ({
      id: x.id,
      label: x.label,
      value: x.value,
      changePct: x.changePct,
    }));
    if (tab === "prevday") {
      state.prevDayNoData = Boolean(stockPack.noData);
      state.prevDayLoaded = true;
    }
    applyStocksArrayToTab(tab, stockPack.stocks);
    state.tabLoadedAt[tab] = Date.now();
    if (tab === "nxt" && !NXT_DISABLED) {
      state.nxtSubLoadedAt[state.nxtSub] = Date.now();
    }
    if (tab === "tradeval") {
      state.tradeValSubLoadedAt[state.tradeValSub] = Date.now();
    }
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
    if (state.tab === "tradeval") return getTradeValRowsForSub();
    if (state.tab === "prevday") return state.prevDayRows;
    if (state.tab === "nxt") {
      if (NXT_DISABLED) return [];
      return getNxtRowsForSub();
    }
    return state.capRows;
  }

  function ccnlTrIdForTab(tab) {
    if (tab === "nxt") return "H0NXCNT0";
    return "H0UNCNT0";
  }

  function nxtFetchAction() {
    if (state.nxtSub === "trade") return "nxt-trade-pbmn-30";
    if (state.nxtSub === "volume") return "nxt-volume-30";
    return "nxt-fluctuation-30";
  }

  function updateNxtSubtabsVisibility() {
    const bar = $("rt-nxt-subtabs");
    if (!bar) return;
    if (state.tab === "nxt") bar.removeAttribute("hidden");
    else bar.setAttribute("hidden", "");
  }

  function updateTradevalSubtabsVisibility() {
    const bar = $("rt-tradeval-subtabs");
    if (!bar) return;
    if (state.tab === "tradeval") bar.removeAttribute("hidden");
    else bar.setAttribute("hidden", "");
  }

  function updateSubtabBarsVisibility() {
    updateNxtSubtabsVisibility();
    updateTradevalSubtabsVisibility();
  }

  function syncNxtSubtabAria() {
    document.querySelectorAll("[data-rt-nxt-sub]").forEach((b) => {
      b.setAttribute("aria-selected", b.getAttribute("data-rt-nxt-sub") === state.nxtSub ? "true" : "false");
    });
  }

  function syncTradevalSubtabAria() {
    document.querySelectorAll("[data-rt-tradeval-sub]").forEach((b) => {
      const s = b.getAttribute("data-rt-tradeval-sub");
      const on = (s === "kosdaq" && state.tradeValSub === "kosdaq") || (s === "kospi" && state.tradeValSub === "kospi");
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  async function refreshNxtPanel() {
    if (NXT_DISABLED) {
      state.nxtFluctRows = [];
      state.nxtPbmnRows = [];
      state.nxtVolRows = [];
      renderAll();
      return;
    }
    const act = nxtFetchAction();
    const { stocks } = await fetchJson(act, FETCH_TIMEOUT_MS);
    const rows = (stocks || []).map((r) => ({ ...r, tab: "nxt" }));
    if (state.nxtSub === "trade") state.nxtPbmnRows = rows;
    else if (state.nxtSub === "volume") state.nxtVolRows = rows;
    else state.nxtFluctRows = rows;
    renderAll();
    if (!NXT_DISABLED) {
      state.nxtSubLoadedAt[state.nxtSub] = Date.now();
    }
  }

  function tableColSpan() {
    if (state.tab === "prevday") return 3;
    return 6;
  }

  function renderThead() {
    const tr = document.getElementById("rt-thead-row");
    if (!tr) return;
    if (state.tab === "nxt") {
      tr.innerHTML =
        '<th class="rt-td-rank">순위</th><th class="rt-td-name">종목명</th><th class="num rt-td-price">현재가</th><th class="num rt-td-chg">등락률</th><th class="num rt-td-vol">거래량</th><th class="num rt-td-tv">거래대금</th>';
      return;
    }
    if (state.tab === "tradeval") {
      tr.innerHTML =
        '<th class="rt-td-rank">순위</th><th class="rt-td-name">종목명</th><th class="num rt-td-price">현재가</th><th class="num rt-td-chg">등락률</th><th class="num rt-td-vol">거래량</th><th class="num rt-td-tv">거래대금</th>';
      return;
    }
    if (state.tab === "gainers") {
      tr.innerHTML =
        '<th class="rt-td-rank">순위</th><th class="rt-td-name">종목명</th><th class="num rt-td-price">현재가</th><th class="num rt-td-chg">등락률</th><th class="num rt-td-vol">거래량</th><th class="num rt-td-tv">거래대금</th>';
      return;
    }
    if (state.tab === "prevday") {
      tr.innerHTML =
        '<th class="rt-td-rank">순위</th><th class="rt-td-name">종목명</th><th class="num rt-td-chg">전일등락률</th>';
      return;
    }
    tr.innerHTML =
      '<th class="rt-td-rank">순위</th><th class="rt-td-name">종목명</th><th class="num rt-td-price">가격</th><th class="num rt-td-chg">등락률</th><th class="num rt-td-tv">거래대금</th><th class="num rt-td-mcap">시가총액</th>';
  }

  function getTableTitle() {
    if (state.tab === "cap") return "코스피 시가총액 상위 30";
    if (state.tab === "gainers") return "코스피·코스닥 통합 상승률 상위 50";
    if (state.tab === "tradeval") {
      return state.tradeValSub === "kosdaq" ? "코스닥 거래대금 TOP50" : "코스피 거래대금 TOP50";
    }
    if (state.tab === "prevday") return "전일 상승 TOP50 (data/prev-top50.json)";
    if (state.tab === "nxt") {
      if (state.nxtSub === "trade") return "NXT 거래대금 TOP30";
      if (state.nxtSub === "volume") return "NXT 거래량 TOP30";
      return "NXT 상승률 TOP30";
    }
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
      const nameBtn = `<button type="button" class="rt-name-chart-btn rt-name-chart-btn--prevday" data-code="${escapeHtml(r.code)}" aria-expanded="false"><span class="rt-prevday-name-txt">${nm}</span><span class="rt-prevday-chart-ico" aria-hidden="true">📊</span></button>`;
      return `<tr class="rt-stock-row rt-prevday-stock-row" data-code="${escapeHtml(r.code)}">
          <td class="num rt-td-rank">${r.rank != null ? escapeHtml(String(r.rank)) : "—"}</td>
          <td class="rt-td-name">${nameBtn}</td>
          <td class="num rt-td-chg"><span class="delta ${clsPrev}">${escapeHtml(fmtPct(chPrev))}</span></td>
        </tr>`;
    }

    if (state.tab === "nxt") {
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

    if (state.tab === "tradeval") {
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

    if (state.tab === "prevday") {
      const chPrev = r.prevDayChangePct;
      const clsPrev = deltaClass(chPrev);
      tr.cells[1].innerHTML = `<button type="button" class="rt-name-chart-btn rt-name-chart-btn--prevday" data-code="${escapeHtml(r.code)}" aria-expanded="${state.openChartCode === r.code ? "true" : "false"}"><span class="rt-prevday-name-txt">${nm}</span><span class="rt-prevday-chart-ico" aria-hidden="true">📊</span></button>`;
      tr.cells[2].innerHTML = `<span class="delta ${clsPrev}">${escapeHtml(fmtPct(chPrev))}</span>`;
      return;
    }

    tr.cells[1].innerHTML = `<button type="button" class="rt-name-chart-btn" data-code="${escapeHtml(r.code)}" aria-expanded="${state.openChartCode === r.code ? "true" : "false"}">${nm}</button>`;

    if (state.tab === "nxt") {
      const ch = r.changePct;
      const cls = deltaClass(ch);
      tr.cells[2].textContent = fmtNum(r.price);
      tr.cells[3].innerHTML = `<span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span>`;
      tr.cells[4].textContent = fmtNum(r.volume);
      tr.cells[5].textContent = formatTradeVal(r.tradingValue);
      return;
    }

    if (state.tab === "gainers") {
      const ch = r.changePct;
      const cls = deltaClass(ch);
      tr.cells[2].textContent = fmtNum(r.price);
      tr.cells[3].innerHTML = `<span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span>`;
      tr.cells[4].textContent = fmtNum(r.volume);
      tr.cells[5].textContent = formatTradeVal(r.tradingValue);
      return;
    }

    if (state.tab === "tradeval") {
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
    updatePrevdayHint();
  }

  function updatePrevdayHint() {
    const el = $("rt-prevday-hint");
    if (!el) return;
    el.hidden = state.tab !== "prevday" || (state.prevDayNoData && state.prevDayRows.length === 0);
  }

  function renderTable() {
    const body = $("rt-tbody");
    const title = $("rt-table-title");
    if (!body) return;
    if (title) title.textContent = getTableTitle();
    updatePrevdayHint();
    if (body.dataset.rtSkeleton === "1") return;
    renderThead();
    if (state.tab === "nxt" && NXT_DISABLED) {
      disposeLwChart();
      state.openChartCode = null;
      const cs = tableColSpan();
      body.innerHTML = `<tr class="rt-stock-row rt-nxt-soon-row" data-code="">
          <td colspan="${cs}" class="rt-nxt-soon-cell">
            <span class="rt-nxt-soon-label">준비중</span>
            <span class="rt-nxt-soon-msg">한국투자증권 API에서 NXT 전용 순위를 제공하지 않습니다.</span>
          </td>
        </tr>`;
      return;
    }
    if (state.tab === "prevday" && state.prevDayNoData && state.prevDayRows.length === 0) {
      disposeLwChart();
      state.openChartCode = null;
      const cs = tableColSpan();
      body.innerHTML = `<tr class="rt-stock-row rt-prevday-empty-row" data-code="">
          <td colspan="${cs}" class="rt-prevday-empty-cell">데이터 없음</td>
        </tr>`;
      updatePrevdayHint();
      return;
    }
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

  function hideRtErrorIfNxt() {
    const err = $("rt-error");
    if (err && state.tab === "nxt" && NXT_DISABLED) err.hidden = true;
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
    if (trId === "H0UNCNT0" || trId === "H0STCNT0") {
      const row = rowFromCcnl(cells, trId);
      mergeStockRow(state.capRows, row);
      mergeStockRow(state.gainerRows, row);
      mergeStockRow(state.tradeValKospiRows, row);
      mergeStockRow(state.tradeValKosdaqRows, row);
      if (state.tab === "cap" || state.tab === "gainers" || state.tab === "tradeval") renderTable();
      return;
    }
    if (trId === "H0NXCNT0") {
      const row = rowFromCcnl(cells);
      mergeStockRow(state.nxtFluctRows, row);
      mergeStockRow(state.nxtPbmnRows, row);
      mergeStockRow(state.nxtVolRows, row);
      if (state.tab === "nxt") renderTable();
    }
  }

  function subscribeStocks(codes) {
    if (!state.ws || state.ws.readyState !== 1) return;
    if (state.tab === "prevday") return;
    const trId = ccnlTrIdForTab(state.tab);
    const limit = state.tab === "cap" || state.tab === "nxt" ? 30 : 50;
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
    hideRtErrorIfNxt();
    try {
      if (state.tab === "nxt" && NXT_DISABLED) {
        const [{ indexes }, { clock, marketTime }] = await Promise.all([
          fetchJson("index", FETCH_TIMEOUT_MS),
          fetchJson("session", FETCH_TIMEOUT_MS),
        ]);
        state.indexes = (indexes || []).map((x) => ({
          id: x.id,
          label: x.label,
          value: x.value,
          changePct: x.changePct,
        }));
        state.clockSession = clock;
        state.marketTime = marketTime;
        renderAll();
        if (state.ws && state.ws.readyState === 1) {
          unsubscribeAll();
          subscribeStocks(getCurrentRows().map((r) => r.code));
        }
        return;
      }

      const stockPromise =
        state.tab === "gainers"
          ? fetchJson("gainers", FETCH_TIMEOUT_MS)
          : state.tab === "tradeval"
            ? fetchJson("trade-pbmn-top50", TRADE_PBMN_FETCH_TIMEOUT_MS, {
                mrkt: state.tradeValSub === "kosdaq" ? "Q" : "J",
              })
            : state.tab === "prevday"
              ? fetchJson("prev-day-top50", FETCH_TIMEOUT_MS)
              : state.tab === "nxt"
                ? fetchJson(nxtFetchAction(), FETCH_TIMEOUT_MS)
                : fetchJson("market-cap", FETCH_TIMEOUT_MS);

      const [stockPack, idxPack, sessPack] = await Promise.all([
        stockPromise,
        fetchJson("index", FETCH_TIMEOUT_MS),
        fetchJson("session", FETCH_TIMEOUT_MS),
      ]);

      state.indexes = (idxPack.indexes || []).map((x) => ({
        id: x.id,
        label: x.label,
        value: x.value,
        changePct: x.changePct,
      }));
      state.clockSession = sessPack.clock || null;
      state.marketTime = sessPack.marketTime || null;

      if (state.tab === "gainers") {
        const { stocks } = stockPack;
        state.gainerRows = (stocks || []).map((r) => ({ ...r, tab: "gainers" }));
      } else if (state.tab === "tradeval") {
        const { stocks } = stockPack;
        const rows = (stocks || []).map((r) => ({ ...r, tab: "tradeval" }));
        if (state.tradeValSub === "kosdaq") state.tradeValKosdaqRows = rows;
        else state.tradeValKospiRows = rows;
      } else if (state.tab === "prevday") {
        state.prevDayNoData = Boolean(stockPack.noData);
        state.prevDayLoaded = true;
        const { stocks } = stockPack;
        state.prevDayRows = (stocks || []).map((r) => ({ ...r, tab: "prevday" }));
      } else if (state.tab === "nxt") {
        const { stocks } = stockPack;
        const rows = (stocks || []).map((r) => ({ ...r, tab: "nxt" }));
        if (state.nxtSub === "trade") state.nxtPbmnRows = rows;
        else if (state.nxtSub === "volume") state.nxtVolRows = rows;
        else state.nxtFluctRows = rows;
      } else {
        const { stocks } = stockPack;
        state.capRows = (stocks || []).map((r) => ({ ...r, tab: "cap" }));
      }
      state.tabLoadedAt[state.tab] = Date.now();
      if (state.tab === "tradeval") {
        state.tradeValSubLoadedAt[state.tradeValSub] = Date.now();
      }
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
        if (state.tab === "nxt" && NXT_DISABLED) {
          err.hidden = true;
        } else if (rowsLoadedForTab(state.tab)) {
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
        else if (t === "tradeval") state.tab = "tradeval";
        else if (t === "prevday") state.tab = "prevday";
        else if (t === "nxt") state.tab = "nxt";
        else state.tab = "cap";
        state.openChartCode = null;
        state.candlePeriod = "D";
        document.querySelectorAll("[data-rt-tab]").forEach((b) => {
          b.setAttribute("aria-selected", b.getAttribute("data-rt-tab") === state.tab ? "true" : "false");
        });
        updateSubtabBarsVisibility();
        syncNxtSubtabAria();
        syncTradevalSubtabAria();

        const finish = () => {
          hideRtErrorIfNxt();
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
          if (!cacheFresh && !(tk === "nxt" && NXT_DISABLED)) {
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

        if (tk === "nxt" && NXT_DISABLED) {
          if (errEl) errEl.hidden = true;
          renderAll();
          finish();
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

  function setupNxtSubtabs() {
    document.querySelectorAll("[data-rt-nxt-sub]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.tab !== "nxt") return;
        const s = btn.getAttribute("data-rt-nxt-sub");
        if (s === "trade") state.nxtSub = "trade";
        else if (s === "volume") state.nxtSub = "volume";
        else state.nxtSub = "fluctuation";
        syncNxtSubtabAria();
        state.openChartCode = null;
        state.candlePeriod = "D";
        const errEl = $("rt-error");
        if (errEl) errEl.hidden = true;
        const finish = () => {
          hideRtErrorIfNxt();
          startPolling();
          if (state.ws && state.ws.readyState === 1) {
            unsubscribeAll();
            subscribeStocks(getCurrentRows().map((r) => r.code));
          }
        };
        if (NXT_DISABLED) {
          renderAll();
          finish();
          return;
        }
        const subKey = state.nxtSub;
        const hasRows = getNxtRowsForSub().length >= 5;
        const subFresh =
          state.nxtSubLoadedAt[subKey] && Date.now() - state.nxtSubLoadedAt[subKey] < TAB_CACHE_MS;

        if (hasRows) {
          renderAll();
          finish();
          if (!subFresh) {
            refreshNxtPanel()
              .then(() => {
                if (errEl) errEl.hidden = true;
                renderAll();
              })
              .catch((e) => {
                console.error("[realtime-board] refreshNxtPanel (bg)", subKey, e && e.message, e);
                if (errEl) {
                  errEl.hidden = false;
                  errEl.textContent = rtErrorTimeoutMessage(e);
                }
              });
          }
          return;
        }

        syncTableChromeForTab();
        showTableSkeleton();
        refreshNxtPanel()
          .then(() => {
            hideTableSkeleton();
            if (errEl) errEl.hidden = true;
            renderAll();
          })
          .catch((e) => {
            console.error("[realtime-board] refreshNxtPanel", state.nxtSub, e && e.message, e);
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

  function setupTradevalSubtabs() {
    document.querySelectorAll("[data-rt-tradeval-sub]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.tab !== "tradeval") return;
        const s = btn.getAttribute("data-rt-tradeval-sub");
        if (s === "kosdaq") state.tradeValSub = "kosdaq";
        else state.tradeValSub = "kospi";
        syncTradevalSubtabAria();
        state.openChartCode = null;
        state.candlePeriod = "D";
        const errEl = $("rt-error");
        if (errEl) errEl.hidden = true;
        const finish = () => {
          hideRtErrorIfNxt();
          startPolling();
          if (state.ws && state.ws.readyState === 1) {
            unsubscribeAll();
            subscribeStocks(getCurrentRows().map((r) => r.code));
          }
        };
        const subKey = state.tradeValSub;
        const hasRows = getTradeValRowsForSub().length >= 10;
        const subFresh =
          state.tradeValSubLoadedAt[subKey] && Date.now() - state.tradeValSubLoadedAt[subKey] < TAB_CACHE_MS;

        if (hasRows) {
          syncTableChromeForTab();
          renderAll();
          finish();
          if (!subFresh) {
            refreshTabStocksOnly("tradeval")
              .then(() => {
                if (errEl) errEl.hidden = true;
                renderAll();
              })
              .catch((e) => {
                console.error("[realtime-board] refreshTabStocksOnly tradeval (bg)", subKey, e && e.message, e);
                if (errEl) {
                  errEl.hidden = false;
                  errEl.textContent = rtErrorTimeoutMessage(e);
                }
              });
          }
          return;
        }

        syncTableChromeForTab();
        showTableSkeleton();
        refreshTabStocksOnly("tradeval")
          .then(() => {
            hideTableSkeleton();
            if (errEl) errEl.hidden = true;
            renderAll();
          })
          .catch((e) => {
            console.error("[realtime-board] refreshTabStocksOnly tradeval", subKey, e && e.message, e);
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
    const period =
      state.tab === "prevday"
        ? 5 * 60 * 1000
        : state.tab === "nxt"
          ? 15000
          : state.tab === "gainers" || state.tab === "tradeval"
            ? 5000
            : 12000;
    state.pollRest = setInterval(() => {
      refreshPartial().catch((e) => {
        console.error("[realtime-board] poll refreshPartial", e && e.message, e);
      });
    }, period);
  }

  async function init() {
    setupTabs();
    setupNxtSubtabs();
    setupTradevalSubtabs();
    wireTableChartAccordion();
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
