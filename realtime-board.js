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
    capPage: 1,
    capPageSize: 25,
    capTotal: 100,
    gainerPage: 1,
    gainerPageSize: 25,
    gainerTotal: 100,
    tvRows: [],
    tvPage: 1,
    tvPageSize: 25,
    tvTotal: 100,
    /** 페이지별 클라이언트 캐시 { [page]: { stocks, loadedAt } } */
    capPageCache: {},
    gainerPageCache: {},
    tvPageCache: {},
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
    /** 캔들 주기: D|W|M — API period와 동일 */
    candlePeriod: "D",
    /** 화면에 쓸 최근 봉 개수 */
    chartBarsLimit: 200,
    /** 탭별 데이터 마지막 로드 시각(ms) — 3분 캐시 */
    tabLoadedAt: {},
    /** 종목 상세 fetch 중단용 */
    detailFetchAbort: null,
  };

  /** 전체 종목 리스트(자동완성용) */
  let stockList = [];
  const acState = { open: false, items: [], active: -1 };

  function $(id) {
    return document.getElementById(id);
  }

  function normalizeQuery(s) {
    return String(s == null ? "" : s).trim();
  }

  function code6Maybe(s) {
    const digits = String(s || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length === 6) return digits;
    if (digits.length < 6) return digits.padStart(6, "0");
    return digits.slice(-6);
  }

  async function loadStockListOnce() {
    if (stockList && stockList.length) return stockList;
    try {
      const res = await fetch("/assets/stock-list.json?t=" + Date.now(), { cache: "no-store" });
      const data = await res.json().catch(() => []);
      if (Array.isArray(data)) {
        stockList = data
          .filter((x) => x && x.code && x.name)
          .map((x) => ({
            code: code6Maybe(x.code),
            name: String(x.name || "").trim(),
            market: String(x.market || "").toUpperCase() === "KOSDAQ" ? "KOSDAQ" : "KOSPI",
          }))
          .filter((x) => /^\d{6}$/.test(x.code) && x.name);
      }
    } catch {}
    return stockList;
  }

  function acHost() {
    return $("rt-ac");
  }

  function closeAutocomplete() {
    const host = acHost();
    acState.open = false;
    acState.items = [];
    acState.active = -1;
    if (host) host.hidden = true;
  }

  function renderAutocomplete(items, total) {
    const host = acHost();
    if (!host) return;
    if (!items || !items.length) {
      closeAutocomplete();
      return;
    }
    acState.open = true;
    acState.items = items;
    if (acState.active >= items.length) acState.active = items.length - 1;
    if (acState.active < 0) acState.active = 0;
    host.hidden = false;
    host.innerHTML =
      items
        .map((it, idx) => {
          const activeCls = idx === acState.active ? " is-active" : "";
          return `<div class="rt-ac-item${activeCls}" data-ac-idx="${idx}" role="button" tabindex="-1">
            <div class="rt-ac-item__main">
              <span class="rt-ac-item__name">${escapeHtml(it.name)}</span>
              <span class="rt-ac-item__code">${escapeHtml(it.code)}</span>
            </div>
            <span class="rt-ac-item__badge">${escapeHtml(it.market)}</span>
          </div>`;
        })
        .join("") +
      (total > items.length ? `<div class="rt-ac-more">외 ${escapeHtml(String(total - items.length))}개 더 있습니다</div>` : "");
  }

  function moveAutocomplete(delta) {
    if (!acState.open || !acState.items.length) return;
    const next = Math.max(0, Math.min(acState.items.length - 1, (acState.active || 0) + delta));
    acState.active = next;
    renderAutocomplete(acState.items, acState.items.length);
  }

  function pickActiveAutocomplete() {
    if (!acState.open || !acState.items.length) return null;
    const idx = acState.active;
    return idx >= 0 && idx < acState.items.length ? acState.items[idx] : null;
  }

  function resolveCodeFromQuery(qRaw) {
    const q = normalizeQuery(qRaw);
    const code6 = code6Maybe(q);
    if (/^\d{6}$/.test(code6)) return code6;
    const list = stockList || [];
    const exact = list.find((x) => x && x.name === q);
    if (exact) return exact.code;
    return "";
  }

  function normalizeCode6ForQuote(raw) {
    const digits = String(raw || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length === 6) return digits;
    if (digits.length < 6) return digits.padStart(6, "0");
    return digits.slice(-6);
  }

  function enrichPanelFromTableRow(panel, code6) {
    if (!panel || panel.stockName) return panel;
    const rows = getCurrentRows() || [];
    const hit = rows.find((r) => r && r.code === code6);
    if (hit && hit.name) panel.stockName = hit.name;
    return panel;
  }

  async function fetchStockQuoteDetail(q, opts) {
    const code6 = normalizeCode6ForQuote(q);
    if (!/^\d{6}$/.test(code6)) throw new Error("종목을 찾을 수 없습니다.");
    const fetchOpts = { cache: "no-store" };
    if (opts && opts.signal) fetchOpts.signal = opts.signal;
    const res = await fetch(
      `/api/stock-analysis?q=${encodeURIComponent(code6)}&quoteOnly=1`,
      fetchOpts
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    if (data && data.error) throw new Error(data.error);
    try {
      if (typeof window !== "undefined" && /(?:\?|&)rtDebug=1\b/.test(window.location.search || "")) {
        console.log("[realtime-board] /api/stock-analysis quoteOnly", {
          code6,
          volTurnoverRate: data && data.volTurnoverRate,
          creditLoanRmndRate: data && data.creditLoanRmndRate,
          keys: data ? Object.keys(data).slice(0, 60) : [],
        });
      }
    } catch (_) {}
    return enrichPanelFromTableRow(data || {}, code6);
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

  /** 전일 대비 가격 변동(원) — 상승 +빨강, 하락 -파랑 */
  function fmtChangeAmt(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n === 0) return "0";
    const sign = n > 0 ? "+" : "";
    return `${sign}${Math.round(n).toLocaleString("ko-KR")}`;
  }

  function formatVsCell(r) {
    const n = r && Number.isFinite(Number(r.changeAmt)) ? Number(r.changeAmt) : null;
    if (n == null) return { html: "—", cls: "" };
    const text = fmtChangeAmt(n);
    return { html: escapeHtml(text), cls: n > 0 ? "rt-vs-pos" : n < 0 ? "rt-vs-neg" : "" };
  }

  /** 거래량: 만 단위 78,861,000 → 7886.1만 (웹/모바일 공통) */
  function formatVolumeMan(raw) {
    const n = Number(String(raw == null ? "" : raw).replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n < 10000) return n.toLocaleString("ko-KR");
    const man = Math.round(n / 1000) / 10; // 1 decimal
    return `${man.toFixed(1)}만`;
  }

  /** 거래대금(원) 표기: 1조 이상 X.XX조 · 1000억 이상 X,XXX억 · 그 이하 X억 */
  function formatTradeVal(raw) {
    const n = Number(String(raw == null ? "" : raw).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1e12) {
      const jo = n / 1e12;
      return `${jo.toFixed(1)}조`;
    }
    const eok = Math.round(n / 1e8);
    if (eok <= 0) return "—";
    if (n >= 1e11) return `${eok.toLocaleString("ko-KR")}억`;
    return `${eok}억`;
  }

  // (legacy formatVolumeMan removed)

  /** 원 단위 → X.X조 / XXX.X억(100억 이상 소수1자리) */
  function formatWonJoEok(n) {
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1e12) return `${(n / 1e12).toFixed(1)}조`;
    const eok = n / 1e8;
    if (eok >= 10000) return `${(eok / 10000).toFixed(1)}조`;
    if (eok >= 100) return `${eok.toFixed(1)}억`;
    const eokR = Math.round(eok);
    if (eokR <= 0) return "—";
    return `${eokR}억`;
  }

  /** 억 단위(API 수급·실적) → X.X조 / XXX.X억 */
  function formatEokJoEok(n0) {
    const n = Math.abs(Number(String(n0).replace(/,/g, "")));
    if (!Number.isFinite(n) || n === 0) return "0억";
    if (n >= 10000) return `${(n / 10000).toFixed(1)}조`;
    if (n >= 100) return `${n.toFixed(1)}억`;
    return `${Math.round(n)}억`;
  }

  function formatForeignHoldCompact(data) {
    const fin = data.financials || {};
    const hold = data.foreignHoldRate ?? fin.foreignHoldRate;
    const limit = data.foreignLimitRate ?? fin.foreignLimitRate;
    const holdOk = hold != null && Number.isFinite(Number(hold));
    const limitOk = limit != null && Number.isFinite(Number(limit));
    if (!holdOk && !limitOk) return "—";
    if (holdOk && limitOk) {
      return `${Number(hold).toFixed(1)}/${Number(limit).toFixed(1)}`;
    }
    if (holdOk) return Number(hold).toFixed(1);
    return Number(limit).toFixed(1);
  }

  function formatKoMoneyEokSigned(raw) {
    if (raw == null || raw === "") return "—";
    const n0 = Number(String(raw).replace(/,/g, ""));
    if (!Number.isFinite(n0) || n0 === 0) return "0억";
    const sign = n0 < 0 ? "-" : "+";
    return `${sign}${formatEokJoEok(n0)}`;
  }

  function formatKoMoneyEok(raw) {
    if (raw == null || raw === "") return "—";
    const n0 = Number(String(raw).replace(/,/g, ""));
    if (!Number.isFinite(n0) || n0 === 0) return "0억";
    return formatEokJoEok(n0);
  }

  function numFromMoneyish(v) {
    const n = Number(String(v == null ? "" : v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  /** 거래대금(원) = stck_prpr(현재가) × acml_vol(거래량) */
  function calcTradeValFromPriceVol(priceRaw, volRaw) {
    const p = numFromMoneyish(priceRaw);
    const v = numFromMoneyish(volRaw);
    if (p == null || v == null || p <= 0 || v <= 0) return null;
    const x = p * v;
    if (!Number.isFinite(x) || x <= 0) return null;
    if (x > Number.MAX_SAFE_INTEGER) return null;
    return Math.round(x);
  }

  function formatRowTradeVal(r) {
    const calc = calcTradeValFromPriceVol(r && r.price, r && r.volume);
    if (calc != null) return formatTradeVal(String(calc));
    const tvRaw = r && r.tradingValue != null ? Number(String(r.tradingValue).replace(/,/g, "")) : null;
    if (tvRaw != null && Number.isFinite(tvRaw) && tvRaw > 0) return formatTradeVal(String(tvRaw));
    return "—";
  }

  function pickLargerVolumeStr(a, b) {
    const va = numFromMoneyish(a);
    const vb = numFromMoneyish(b);
    if (va == null) return b != null && String(b).trim() !== "" ? b : a;
    if (vb == null) return a;
    return vb >= va ? b : a;
  }

  /** 폴링 시 행 순서 유지하며 시세만 병합 (열린 종목 패널 깜빡임 방지) */
  function mergeStocksInPlaceForTab(tab, incoming) {
    const list =
      tab === "gainers" ? state.gainerRows : tab === "tv" ? state.tvRows : state.capRows;
    const inc = (incoming || []).filter((r) => r && String(r.code || "").replace(/\D/g, "").length > 0);
    if (!list.length) {
      applyStocksArrayToTab(tab, inc);
      return { reordered: true };
    }
    const pageCodes = new Set(inc.map((r) => r.code));
    const curCodes = new Set(list.map((r) => r.code));
    const samePage =
      pageCodes.size === curCodes.size && [...pageCodes].every((c) => curCodes.has(c));
    if (!samePage) {
      applyStocksArrayToTab(tab, inc);
      return { reordered: true };
    }
    const byCode = new Map(inc.map((r) => [r.code, r]));
    const merged = list.map((r) => {
      const n = byCode.get(r.code);
      if (!n) return r;
      const price = n.price || r.price;
      const volume = pickLargerVolumeStr(r.volume, n.volume);
      const tvCalc = calcTradeValFromPriceVol(price, volume);
      return {
        ...r,
        ...n,
        price,
        volume,
        rank: n.rank != null ? n.rank : r.rank,
        changePct: n.changePct != null ? n.changePct : r.changePct,
        changeAmt: n.changeAmt != null ? n.changeAmt : r.changeAmt,
        tradingValue: tvCalc != null ? String(tvCalc) : "",
        stck_avls: n.stck_avls || n.mcapEok || r.stck_avls || r.mcapEok,
        mcapEok: n.mcapEok || n.stck_avls || r.mcapEok || r.stck_avls,
      };
    });
    applyStocksArrayToTab(tab, merged);
    return { reordered: false };
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
    return formatWonJoEok(n);
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
        s.src = "https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js";
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

  function wireRtCrosshairTooltip(panesEl, candleHost, chartCandle, chartVol, periodKey, getCandles) {
    let tip = panesEl.querySelector(".rt-lw-ohlc-tooltip");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "rt-lw-ohlc-tooltip";
      tip.setAttribute("aria-hidden", "true");
      panesEl.appendChild(tip);
    }
    const p = String(periodKey || "D").toUpperCase();

    function handle(param, hostEl) {
      const rows = getCandles ? getCandles() : null;
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
    if (chartVol !== chartCandle) {
      chartVol.subscribeCrosshairMove((param) => handle(param, candleHost));
    }
  }

  function sliceCandlesFromEnd(candles, days) {
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0 || candles.length <= n) return candles;
    return candles.slice(-n);
  }

  const CANDLE_UP = "#e24b4a";
  const CANDLE_DOWN = "#3b82f6";
  const VOL_UP = "rgba(226, 75, 74, 0.5)";
  const VOL_DOWN = "rgba(59, 130, 246, 0.5)";

  function isLwChartDarkTheme() {
    return (
      document.documentElement.getAttribute("data-theme") === "dark" ||
      (document.body && document.body.classList.contains("dark"))
    );
  }

  function getLwChartTheme() {
    const dark = isLwChartDarkTheme();
    return {
      bg: dark ? "#131722" : "#ffffff",
      textColor: dark ? "#aaaaaa" : "#555555",
      gridColor: dark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.06)",
    };
  }
  const LW_CHART_TOTAL_H = 300;
  const LW_CANDLE_H = 210;
  const LW_VOL_H = 90;

  /** 아코디언 패널별 차트 인스턴스 */
  const panelLwCharts = new WeakMap();

  function buildVolumeHistogramData(candles) {
    const volData = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const t = c.time;
      const v = c.volume != null ? Number(c.volume) : 0;
      const o = c.open;
      const cl = c.close;
      let color = VOL_UP;
      if (cl > o) color = VOL_UP;
      else if (cl < o) color = VOL_DOWN;
      volData.push({
        time: t,
        value: Number.isFinite(v) ? v : 0,
        color,
      });
    }
    return volData;
  }

  function getLwChartPaneMounts(root) {
    if (!root) return null;
    const candleHost = root.querySelector(".rt-lw-candle-host");
    const volHost = root.querySelector(".rt-lw-volume-host");
    if (!candleHost || !volHost) return null;
    return { candleHost, volHost };
  }

  const LW_TIME_SCALE_BASE = {
    barSpacing: 6,
    minBarSpacing: 3,
    rightOffset: 4,
    fixLeftEdge: false,
    fixRightEdge: false,
    borderVisible: false,
    timeVisible: true,
    secondsVisible: false,
    allowBoldLabels: true,
  };

  const LW_RIGHT_SCALE_BASE = {
    borderVisible: false,
    autoScale: true,
    minimumWidth: 52,
  };

  function lwChartLayoutOptions(width, height, timeScaleVisible, localization) {
    const t = getLwChartTheme();
    return {
      width: Math.max(width, 200),
      height: Math.max(height, 60),
      layout: {
        background: { type: "solid", color: t.bg },
        textColor: t.textColor,
      },
      localization,
      crosshair: {
        vertLine: { labelVisible: timeScaleVisible },
        horzLine: { labelVisible: true },
      },
      grid: {
        vertLines: { color: t.gridColor },
        horzLines: { color: t.gridColor },
      },
      leftPriceScale: { visible: false },
      rightPriceScale: { ...LW_RIGHT_SCALE_BASE },
      timeScale: { ...LW_TIME_SCALE_BASE, visible: timeScaleVisible },
    };
  }

  /** 이중 차트: 우측 눈금 폭·barSpacing 맞춤 (격자/봉 위치 일치) */
  function syncLwDualChartAxes(chartCandle, chartVol) {
    if (!chartCandle || !chartVol || chartCandle === chartVol) return;
    try {
      chartCandle.timeScale().applyOptions({ ...LW_TIME_SCALE_BASE, visible: false });
      chartVol.timeScale().applyOptions({ ...LW_TIME_SCALE_BASE, visible: true });
      chartCandle.priceScale("right").applyOptions(LW_RIGHT_SCALE_BASE);
      chartVol.priceScale("right").applyOptions(LW_RIGHT_SCALE_BASE);
      const wA = chartCandle.priceScale("right").width();
      const wB = chartVol.priceScale("right").width();
      const mw = Math.max(wA, wB, 76);
      chartCandle.priceScale("right").applyOptions({ minimumWidth: mw });
      chartVol.priceScale("right").applyOptions({ minimumWidth: mw });
      chartCandle.timeScale().fitContent();
      chartVol.timeScale().fitContent();
      const r = chartCandle.timeScale().getVisibleLogicalRange();
      if (r) chartVol.timeScale().setVisibleLogicalRange(r);
    } catch (e) {
      /* noop */
    }
  }

  function addCandleSeries(LC, chart) {
    const opts = {
      upColor: CANDLE_UP,
      downColor: CANDLE_DOWN,
      borderUpColor: CANDLE_UP,
      borderDownColor: CANDLE_DOWN,
      wickUpColor: CANDLE_UP,
      wickDownColor: CANDLE_DOWN,
    };
    if (LC.CandlestickSeries && typeof chart.addSeries === "function") {
      return chart.addSeries(LC.CandlestickSeries, opts);
    }
    if (typeof chart.addCandlestickSeries === "function") return chart.addCandlestickSeries(opts);
    return null;
  }

  function addVolSeries(LC, chart) {
    const opts = {
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    };
    return addHistogramSeriesCompat(chart, LC, opts);
  }

  function buildCrosshairLookup(candles) {
    const closeByTime = new Map();
    const volByTime = new Map();
    for (const c of candles || []) {
      const k = chartTimeKey(c.time);
      if (!k) continue;
      closeByTime.set(k, Number(c.close));
      volByTime.set(k, c.volume != null ? Number(c.volume) : 0);
    }
    return { closeByTime, volByTime };
  }

  function linkCrosshairSync(chartCandle, candleSeries, chartVol, volSeries, bundle) {
    if (
      !chartCandle ||
      !chartVol ||
      !candleSeries ||
      !volSeries ||
      typeof chartCandle.subscribeCrosshairMove !== "function"
    ) {
      return;
    }
    chartCandle.subscribeCrosshairMove((param) => {
      const lookup = bundle && bundle.crosshairLookup;
      if (!param || param.time == null || !lookup) {
        chartVol.clearCrosshairPosition();
        return;
      }
      const v = lookup.volByTime.get(chartTimeKey(param.time));
      if (v == null || !Number.isFinite(v)) {
        chartVol.clearCrosshairPosition();
        return;
      }
      chartVol.setCrosshairPosition(v, param.time, volSeries);
    });
    chartVol.subscribeCrosshairMove((param) => {
      const lookup = bundle && bundle.crosshairLookup;
      if (!param || param.time == null || !lookup) {
        chartCandle.clearCrosshairPosition();
        return;
      }
      const c = lookup.closeByTime.get(chartTimeKey(param.time));
      if (c == null || !Number.isFinite(c)) {
        chartCandle.clearCrosshairPosition();
        return;
      }
      chartCandle.setCrosshairPosition(c, param.time, candleSeries);
    });
  }

  /**
   * 캔들(70%) + 거래량(30%) 이중 패널 차트
   * @returns {{ chartCandle, chartVol, candle, vol }}
   */
  function createLwDualPanelCharts(LC, mounts, opts) {
    const { width, localization } = opts;
    mounts.candleHost.innerHTML = "";
    mounts.volHost.innerHTML = "";
    const chartCandle = LC.createChart(
      mounts.candleHost,
      lwChartLayoutOptions(width, LW_CANDLE_H, false, localization)
    );
    const chartVol = LC.createChart(
      mounts.volHost,
      lwChartLayoutOptions(width, LW_VOL_H, true, localization)
    );
    const candle = addCandleSeries(LC, chartCandle);
    const vol = addVolSeries(LC, chartVol);
    if (!candle || !vol) throw new Error("차트 시리즈를 초기화하지 못했습니다.");
    linkLogicalRangeSync(chartCandle, chartVol);
    syncLwDualChartAxes(chartCandle, chartVol);
    return { chartCandle, chartVol, candle, vol };
  }

  function applyLwChartSeriesData(bundle, candles, limit) {
    if (!bundle || !bundle.candle || !bundle.vol || !candles || !candles.length) return [];
    const sliced = sliceCandlesFromEnd(candles, limit || state.chartBarsLimit || 200);
    bundle.candle.setData(sliced);
    bundle.vol.setData(buildVolumeHistogramData(sliced));
    bundle.crosshairLookup = buildCrosshairLookup(sliced);
    syncLwDualChartAxes(bundle.chartCandle, bundle.chartVol);
    return sliced;
  }

  function applyLwChartThemeToBundle(bundle) {
    if (!bundle || !bundle.chartCandle || !bundle.chartVol) return;
    const t = getLwChartTheme();
    const opts = {
      layout: {
        background: { type: "solid", color: t.bg },
        textColor: t.textColor,
      },
      grid: {
        vertLines: { color: t.gridColor },
        horzLines: { color: t.gridColor },
      },
    };
    bundle.chartCandle.applyOptions(opts);
    bundle.chartVol.applyOptions(opts);
  }

  function refreshAllLwChartsTheme() {
    document.querySelectorAll(".rt-chart-wrap").forEach((host) => {
      const bundle = panelLwCharts.get(host);
      if (bundle) applyLwChartThemeToBundle(bundle);
    });
  }
  window.tmRefreshLwChartsTheme = refreshAllLwChartsTheme;

  function wireLwChartThemeRefresh() {
    const btn = document.getElementById("theme-toggle");
    if (!btn || btn.dataset.rtLwThemeBound === "1") return;
    btn.dataset.rtLwThemeBound = "1";
    btn.addEventListener("click", () => {
      setTimeout(refreshAllLwChartsTheme, 0);
    });
  }

  function disposePanelLwChart(panelRoot) {
    const s = panelLwCharts.get(panelRoot);
    if (!s) return;
    if (s.resizeObs) {
      try {
        s.resizeObs.disconnect();
      } catch (e) {
        /* noop */
      }
    }
    if (s.chartCandle) {
      try {
        s.chartCandle.remove();
      } catch (e) {
        /* noop */
      }
    }
    if (s.chartVol) {
      try {
        s.chartVol.remove();
      } catch (e) {
        /* noop */
      }
    }
    panelLwCharts.delete(panelRoot);
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
    const cache =
      tab === "gainers" ? state.gainerPageCache : tab === "tv" ? state.tvPageCache : state.capPageCache;
    const page =
      tab === "gainers" ? state.gainerPage : tab === "tv" ? state.tvPage : state.capPage;
    const hit = cache[page];
    return !!(hit && hit.stocks && hit.stocks.length >= 10);
  }

  function pageCacheForTab(tab) {
    if (tab === "gainers") return state.gainerPageCache;
    if (tab === "tv") return state.tvPageCache;
    return state.capPageCache;
  }

  function currentPageForTab(tab) {
    if (tab === "gainers") return state.gainerPage;
    if (tab === "tv") return state.tvPage;
    return state.capPage;
  }

  function setCurrentPageForTab(tab, page) {
    if (tab === "gainers") state.gainerPage = page;
    else if (tab === "tv") state.tvPage = page;
    else state.capPage = page;
  }

  function isRankListTab(tab) {
    return tab === "cap" || tab === "gainers" || tab === "tv";
  }

  function updatePaginationUI(page) {
    const tab = state.tab;
    if (!isRankListTab(tab)) return;
    const pg = Math.max(1, Math.min(4, Number(page) || 1));
    setCurrentPageForTab(tab, pg);
    const el = $("rt-table-pager");
    if (!el) return;
    el.querySelectorAll("[data-rt-table-page]").forEach((b) => {
      const n = Number(b.getAttribute("data-rt-table-page") || "1") || 1;
      const active = n === pg;
      b.setAttribute("aria-current", active ? "page" : "false");
      b.classList.toggle("active", active);
    });
  }

  function showTableLoading() {
    const body = $("rt-tbody");
    if (!body) return;
    body.dataset.rtLoading = "1";
    const cs = tableColSpan();
    body.innerHTML = [
      `<tr class="rt-table-loading">`,
      `  <td colspan="${cs}" class="rt-table-loading-cell">`,
      `    <div class="rt-table-loading-inner">`,
      `      <span class="rt-spinner" aria-hidden="true"></span>`,
      `      <p>데이터 불러오는 중...</p>`,
      `    </div>`,
      `  </td>`,
      `</tr>`,
    ].join("");
  }

  function hideTableLoading() {
    const body = $("rt-tbody");
    if (body) delete body.dataset.rtLoading;
  }

  async function ensureTabPageLoaded(tab, page, opts) {
    const force = !!(opts && opts.force);
    const prevPage = currentPageForTab(tab);
    const pg = Math.max(1, Math.min(4, Number(page) || 1));
    setCurrentPageForTab(tab, pg);
    if (pg !== prevPage) state.openChartCode = null;

    const cache = pageCacheForTab(tab);
    const hit = cache[pg];
    if (!force && hit && hit.stocks && hit.stocks.length) {
      applyStocksArrayToTab(tab, hit.stocks);
      state.tabLoadedAt[tab] = hit.loadedAt || Date.now();
      return { fromCache: true };
    }

    const skipTableUi = !!(opts && opts.skipTableUi);
    const showUi = !force && !skipTableUi;
    if (showUi) {
      showTableLoading();
    }
    try {
      if (tab === "cap") state.capPage = pg;
      else if (tab === "gainers") state.gainerPage = pg;
      else state.tvPage = pg;
      const pack = await fetchStocksJsonForTab(tab);
      const stocks = pack.stocks || [];
      cache[pg] = { stocks, loadedAt: Date.now() };
      if (tab === "cap") state.capTotal = Number(pack.total || 100) || 100;
      else if (tab === "gainers") state.gainerTotal = Number(pack.total || 100) || 100;
      else state.tvTotal = Number(pack.total || 100) || 100;
      applyStocksArrayToTab(tab, stocks);
      state.tabLoadedAt[tab] = Date.now();
      return { fromCache: false, cached: !!pack.cached };
    } finally {
      if (showUi) {
        hideTableLoading();
      }
    }
  }

  function applyStocksArrayToTab(tab, stocks) {
    const rows = (stocks || [])
      .filter((r) => r && String(r.code || "").replace(/\D/g, "").length > 0)
      .map((r) => ({ ...r, tab: r.tab || tab }));
    if (tab === "cap") state.capRows = rows;
    else if (tab === "gainers") state.gainerRows = rows;
    else if (tab === "tv") state.tvRows = rows;
  }

  async function fetchStocksJsonForTab(tab) {
    const ps = 25;
    if (tab === "cap") {
      const p = Math.max(1, Number(state.capPage) || 1);
      return fetchJson("market-cap", FETCH_TIMEOUT_MS, { page: p, pageSize: ps });
    }
    if (tab === "tv") {
      const p = Math.max(1, Number(state.tvPage) || 1);
      return fetchJson("trading-value", FETCH_TIMEOUT_MS, { page: p, pageSize: ps });
    }
    const p = Math.max(1, Number(state.gainerPage) || 1);
    return fetchJson("gainers", FETCH_TIMEOUT_MS, { page: p, pageSize: ps });
  }

  function renderTablePager() {
    const el = $("rt-table-pager");
    if (!el) return;
    const show = isRankListTab(state.tab);
    el.hidden = !show;
    if (!show) return;

    if (!el.dataset.pagerWired) {
      el.dataset.pagerWired = "1";
      el.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-rt-table-page]");
        if (!btn || !el.contains(btn)) return;
        const next = Number(btn.getAttribute("data-rt-table-page") || "1") || 1;
        void loadTablePage(next);
      });
    }

    if (!el.querySelector("[data-rt-table-page]")) {
      const btns = [];
      for (let i = 1; i <= 4; i++) {
        btns.push(
          `<button type="button" class="page-btn" data-rt-table-page="${i}" aria-current="false">${i}</button>`
        );
      }
      el.insertAdjacentHTML("beforeend", btns.join(""));
    }
    updatePaginationUI(currentPageForTab(state.tab));
  }

  async function loadTablePage(page) {
    const tab = state.tab;
    if (!isRankListTab(tab)) return;
    const pg = Math.max(1, Math.min(4, Number(page) || 1));
    const prevPage = currentPageForTab(tab);
    const cache = pageCacheForTab(tab);

    updatePaginationUI(pg);
    if (pg !== prevPage) state.openChartCode = null;

    if (pg === prevPage && cache[pg] && cache[pg].stocks && cache[pg].stocks.length) {
      renderAll();
      return;
    }

    showTableLoading();
    const errEl = $("rt-error");
    try {
      await ensureTabPageLoaded(tab, pg, { skipTableUi: true });
      if (errEl) errEl.hidden = true;
      renderAll();
      if (state.ws && state.ws.readyState === 1) {
        unsubscribeAll();
        subscribeStocks(getCurrentRows().map((r) => r.code));
      }
    } catch (e) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = rtErrorTimeoutMessage(e);
      }
    }
  }

  window.loadTablePage = loadTablePage;

  /** 탭별 종목 목록만 갱신 (세션·지수는 유지) — 캐시 만료 시 백그라운드용 */
  async function refreshTabStocksOnly(tab) {
    const page = currentPageForTab(tab);
    await ensureTabPageLoaded(tab, page, { force: true, skipTableUi: true });
  }

  /** 다른 탭 1페이지 미리 받아 두기 — 탭 전환 시 잔상·대기 완화 */
  async function prefetchRankTabPage1(tab) {
    if (!isRankListTab(tab)) return;
    const cache = pageCacheForTab(tab);
    if (cache[1] && cache[1].stocks && cache[1].stocks.length) return;
    const prevTab = state.tab;
    const prevCapPage = state.capPage;
    const prevGainerPage = state.gainerPage;
    const prevTvPage = state.tvPage;
    try {
      if (tab === "cap") state.capPage = 1;
      else if (tab === "gainers") state.gainerPage = 1;
      else state.tvPage = 1;
      const pack = await fetchStocksJsonForTab(tab);
      const stocks = pack.stocks || [];
      if (stocks.length) {
        cache[1] = { stocks, loadedAt: Date.now() };
        applyStocksArrayToTab(tab, stocks);
      }
    } catch (e) {
      console.warn("[realtime-board] prefetchRankTabPage1", tab, e && e.message);
    } finally {
      state.tab = prevTab;
      state.capPage = prevCapPage;
      state.gainerPage = prevGainerPage;
      state.tvPage = prevTvPage;
    }
  }

  function prefetchOtherRankTabs() {
    const cur = state.tab;
    for (const tab of ["cap", "gainers", "tv"]) {
      if (tab === cur) continue;
      void prefetchRankTabPage1(tab);
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
    if (tab === "gainers") {
      state.gainerTotal = 100;
    } else if (tab === "tv") {
      state.tvTotal = 100;
    } else if (tab === "cap") {
      state.capTotal = 100;
    }
    const page = currentPageForTab(tab);
    pageCacheForTab(tab)[page] = { stocks: stockPack.stocks || [], loadedAt: Date.now() };
    applyStocksArrayToTab(tab, stockPack.stocks);
    state.tabLoadedAt[tab] = Date.now();
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
    const changeAmt = Number(String(o.PRDY_VRSS || "").replace(/,/g, ""));
    const vol = String(o.ACML_VOL || "").trim();
    const tvCalc = calcTradeValFromPriceVol(price, vol);
    const hourCls = String(o.HOUR_CLS_CODE || "").trim();
    const mrkt = String(o.MRKT_TRTM_CLS_CODE || "").trim();
    return {
      code,
      price,
      changePct: Number.isFinite(changePct) ? changePct : null,
      changeAmt: Number.isFinite(changeAmt) ? changeAmt : null,
      volume: vol,
      tradingValue: tvCalc != null ? String(tvCalc) : "",
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
    if (patch.changeAmt != null && Number.isFinite(patch.changeAmt)) cur.changeAmt = patch.changeAmt;
    if (patch.volume != null && String(patch.volume).trim() !== "") {
      cur.volume = pickLargerVolumeStr(cur.volume, patch.volume);
    }
    const tvCalc = calcTradeValFromPriceVol(cur.price, cur.volume);
    if (tvCalc != null) cur.tradingValue = String(tvCalc);
    if (patch.stck_avls != null && String(patch.stck_avls).trim() !== "") cur.stck_avls = patch.stck_avls;
    if (patch.mcapEok != null && String(patch.mcapEok).trim() !== "") cur.mcapEok = patch.mcapEok;
    if (patch.hourCls) cur.hourCls = patch.hourCls;
    if (patch.mrkt) cur.mrktCls = patch.mrkt;
    list[i] = cur;
  }

  function getCurrentRows() {
    if (state.tab === "cap") return state.capRows;
    if (state.tab === "gainers") return state.gainerRows;
    if (state.tab === "tv") return state.tvRows;
    return state.capRows;
  }

  function ccnlTrIdForTab() {
    return "H0UNCNT0";
  }

  function tableColSpan() {
    return 8;
  }

  function syncTableLayoutAttr() {
    const table = document.querySelector(".rt-table");
    if (table) table.setAttribute("data-rt-tab", state.tab || "cap");
  }

  function tableHeadHtmlForTab(tab) {
    const base = [
      '<th class="rt-td-rank">순위</th>',
      '<th class="rt-td-name">종목명</th>',
      '<th class="num rt-td-price">가격</th>',
      '<th class="num rt-td-vs">대비</th>',
      '<th class="num rt-td-chg">등락률</th>',
      '<th class="num rt-td-vol">거래량</th>',
    ];
    // cap/gainers: ... 거래대금 → 시총
    if (tab === "tv") {
      // tv tab: ... 시총 → 거래대금
      base.push('<th class="num rt-td-mcap">시가총액</th>');
      base.push('<th class="num rt-td-tv">거래대금</th>');
    } else {
      base.push('<th class="num rt-td-tv">거래대금</th>');
      base.push('<th class="num rt-td-mcap">시가총액</th>');
    }
    return base.join("");
  }

  function mobileLastColumnLabel(tab) {
    const t = tab || state.tab || "cap";
    if (t === "tv") return "거래대금";
    return "시가총액";
  }

  function mobileLastColumnValue(r, tab) {
    const t = tab || state.tab || "cap";
    if (t === "tv") return escapeHtml(formatRowTradeVal(r));
    return escapeHtml(formatStckAvls(readStckAvlsRaw(r)));
  }

  function syncMobileHeaderRow() {
    const last = document.querySelector(".rt-header-row .rt-col-last");
    if (!last) return;
    last.textContent = mobileLastColumnLabel(state.tab);
  }

  function renderThead() {
    const tr = document.getElementById("rt-thead-row");
    if (!tr) return;
    syncTableLayoutAttr();
    tr.innerHTML = tableHeadHtmlForTab(state.tab || "cap");
    syncMobileHeaderRow();
  }

  function isMobileLayout() {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 768px)").matches
    );
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
    if (isMobileLayout()) {
      const nm = escapeHtml(r.name);
      const ch = r.changePct;
      const cls = deltaClass(ch);
      const price = escapeHtml(fmtNum(r.price));
      const lastVal = mobileLastColumnValue(r);
      const rank = r.rank != null ? escapeHtml(String(r.rank)) : "—";
      const nameBtn = `<button type="button" class="rt-name-chart-btn" data-code="${escapeHtml(r.code)}" aria-expanded="false">${nm}</button>`;
      const row = [
        `<div class="rt-mobile-row">`,
        `  <span class="rt-col-rank">${rank}</span>`,
        `  <span class="rt-col-name">${nameBtn}</span>`,
        `  <span class="rt-col-price">${price}</span>`,
        `  <span class="rt-col-change"><span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span></span>`,
        `  <span class="rt-col-last">${lastVal}</span>`,
        `</div>`,
      ].join("");
      return `<tr class="rt-stock-row" data-code="${escapeHtml(r.code)}"><td colspan="${tableColSpan()}">${row}</td></tr>`;
    }
    const nm = escapeHtml(r.name);
    const nameCell = `<button type="button" class="rt-name-chart-btn" data-code="${escapeHtml(r.code)}" aria-expanded="false">${nm}</button>`;
    const ch = r.changePct;
    const cls = deltaClass(ch);
    const tv = formatRowTradeVal(r);
    const mcap = formatStckAvls(readStckAvlsRaw(r));
    const vs = formatVsCell(r);
    const vol = escapeHtml(formatVolumeMan(r && r.volume));
    const common = [
      `<td class="num rt-td-rank">${r.rank != null ? escapeHtml(String(r.rank)) : "—"}</td>`,
      `<td class="rt-td-name">${nameCell}</td>`,
      `<td class="num rt-td-price">${escapeHtml(fmtNum(r.price))}</td>`,
      `<td class="num rt-td-vs"><span class="${escapeHtml(vs.cls)}">${vs.html}</span></td>`,
      `<td class="num rt-td-chg"><span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span></td>`,
      `<td class="num rt-td-vol">${vol}</td>`,
    ];
    const tail =
      (state.tab || "cap") === "tv"
        ? [
            `<td class="num rt-td-mcap">${escapeHtml(mcap)}</td>`,
            `<td class="num rt-td-tv">${escapeHtml(tv)}</td>`,
          ]
        : [
            `<td class="num rt-td-tv">${escapeHtml(tv)}</td>`,
            `<td class="num rt-td-mcap">${escapeHtml(mcap)}</td>`,
          ];
    return `<tr class="rt-stock-row" data-code="${escapeHtml(r.code)}">${common.join("")}${tail.join("")}</tr>`;
  }

  function detailRowHtml(forCode) {
    const cs = tableColSpan();
    const body = $("rt-tbody");
    const existing = body?.querySelector(`tr.rt-detail-row[data-detail-for="${forCode}"] .rt-detail-acc`);
    if (
      existing &&
      existing.dataset.loadedFor === forCode &&
      existing.querySelector(".rt-acc")
    ) {
      return `<tr class="rt-detail-row" data-detail-for="${escapeHtml(forCode)}">
          <td colspan="${cs}">${existing.outerHTML}</td>
        </tr>`;
    }
    return `<tr class="rt-detail-row" data-detail-for="${escapeHtml(forCode)}">
          <td colspan="${cs}">
            <div class="rt-detail-acc" data-detail-code="${escapeHtml(forCode)}">${buildStockResultSkeleton()}</div>
          </td>
        </tr>`;
  }

  function applyRowToTr(tr, r) {
    if (isMobileLayout()) return;
    const nm = escapeHtml(r.name);
    tr.cells[0].textContent = r.rank != null ? String(r.rank) : "—";

    tr.cells[1].innerHTML = `<button type="button" class="rt-name-chart-btn" data-code="${escapeHtml(r.code)}" aria-expanded="${state.openChartCode === r.code ? "true" : "false"}">${nm}</button>`;

    const ch = r.changePct;
    const cls = deltaClass(ch);
    tr.cells[2].textContent = fmtNum(r.price);
    tr.cells[3].innerHTML = `<span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span>`;
    tr.cells[4].textContent = formatRowTradeVal(r);
    tr.cells[5].textContent = formatStckAvls(readStckAvlsRaw(r));
  }

  function syncDetailDomAfterRows(body, rows) {
    if (!state.openChartCode) return;
    const code = state.openChartCode;
    const anchor = body.querySelector(`tr.rt-stock-row[data-code="${code}"]`);
    if (!anchor) {
      const onPage = (rows || []).some((r) => r.code === code);
      if (!onPage) {
        state.openChartCode = null;
        renderThead();
        body.innerHTML = rows.map((r) => stockRowHtml(r)).join("");
      }
      return;
    }
    let detailTr = body.querySelector("tr.rt-detail-row");
    if (!detailTr) {
      anchor.insertAdjacentHTML("afterend", detailRowHtml(code));
      detailTr = body.querySelector("tr.rt-detail-row");
    } else {
      if (detailTr.getAttribute("data-detail-for") !== code) {
        detailTr.setAttribute("data-detail-for", code);
        const host = detailTr.querySelector(".rt-detail-acc");
        if (host) {
          host.setAttribute("data-detail-code", code);
          delete host.dataset.loadedFor;
          host.innerHTML = buildStockResultSkeleton();
        }
      }
      if (detailTr.previousElementSibling !== anchor) anchor.after(detailTr);
    }
    if (detailTr) detailTr.setAttribute("data-detail-for", code);
    syncNameChartButtonsAria(body);
    const host = detailTr && detailTr.querySelector(".rt-detail-acc");
    const needsLoad = !host || host.dataset.loadedFor !== code || !host.querySelector(".rt-acc");
    if (needsLoad) void mountTableDetailAccordion(body);
    else wireDetailAccordionClose(host);
  }

  function wireDetailAccordionClose(host) {
    if (!host) return;
    const closeBtn = host.querySelector(".rt-acc-close");
    if (!closeBtn || closeBtn.dataset.wired === "1") return;
    closeBtn.dataset.wired = "1";
    closeBtn.addEventListener("click", () => {
      state.openChartCode = null;
      renderTable();
    });
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
    if (body.dataset.rtSkeleton === "1" || body.dataset.rtLoading === "1") return;
    renderThead();
    const rows = getCurrentRows();
    if (isMobileLayout()) {
      if (!state.openChartCode) {
        body.innerHTML = rows.map((r) => stockRowHtml(r)).join("");
      } else {
        const parts = [];
        for (const r of rows) {
          parts.push(stockRowHtml(r));
          if (state.openChartCode === r.code) parts.push(detailRowHtml(r.code));
        }
        body.innerHTML = parts.join("");
      }
      syncNameChartButtonsAria(body);
      syncDetailDomAfterRows(body, rows);
      return;
    }
    if (!state.openChartCode) {
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
      const parts = [];
      for (const r of rows) {
        parts.push(stockRowHtml(r));
        if (state.openChartCode === r.code) parts.push(detailRowHtml(r.code));
      }
      body.innerHTML = parts.join("");
    }
    syncDetailDomAfterRows(body, rows);
  }

  function renderAll() {
    renderIndexes();
    renderMeta();
    renderTablePager();
    hideTableLoading();
    renderTable();
  }

  function formatMarketCapPretty(rawOrNum) {
    const n = Number(String(rawOrNum == null ? "" : rawOrNum).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1e8 && n <= 5e15) return formatWonJoEok(n);
    // KIS hts_avls 등 억원 단위(약 1만~1억 미만)
    if (n >= 1e4 && n < 1e8) return formatWonJoEok(n * 1e8);
    return n.toLocaleString("ko-KR");
  }

  function buildStockResultSkeleton() {
    return `<div class="rt-stock-loading"><span class="rt-spinner" aria-hidden="true"></span><span>종목 정보를 불러오는 중...</span></div>`;
  }

  /** 수급: 양수 빨강, 음수 파랑 (기관·개인·외국인 동일) */
  function supplyAmountCls(val) {
    if (val == null || !Number.isFinite(val) || val === 0) return "";
    return val < 0 ? "rt-acc-val--sup-neg" : "rt-acc-val--sup-pos";
  }

  function accGridCell(label, valueHtml, valueCls) {
    const cls = valueCls ? `rt-acc-cell__v ${valueCls}` : "rt-acc-cell__v";
    return `<div class="rt-acc-cell"><div class="rt-acc-cell__k">${escapeHtml(label)}</div><div class="${cls}">${valueHtml}</div></div>`;
  }

  function formatCreditLoanRmndRate(data) {
    console.log("[신용융자잔고]", data && data.whol_loan_rmnd_rate);
    const raw =
      data.whol_loan_rmnd_rate ??
      data.wholLoanRmndRate ??
      data.creditLoanRmndRate ??
      data.loanRmndRate ??
      data.loan_rmnd_ratem ??
      data.itewhol_loan_rmnd_ratem ??
      null;
    if (raw === undefined || raw === null || raw === "") return { text: "-", cls: "" };
    const loanRate = parseFloat(String(raw).replace(/,/g, ""));
    if (!Number.isFinite(loanRate) || Number.isNaN(loanRate)) return { text: "-", cls: "" };
    let pct = loanRate;
    if (Math.abs(pct) > 0 && Math.abs(pct) < 0.01) pct *= 100;
    if (!Number.isFinite(pct) || pct <= 0) return { text: "-", cls: "" };
    return {
      text: `${escapeHtml(pct.toFixed(2))}%`,
      cls: "rt-acc-val--credit-warn",
    };
  }

  function stockPanelChartShellHtml(chartId) {
    return [
      `<div class="rt-chart-toolbar" role="toolbar" aria-label="캔들 주기">`,
      `  <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="D" aria-pressed="true">일봉</button>`,
      `  <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="W" aria-pressed="false">주봉</button>`,
      `  <button type="button" class="rt-chart-interval-btn" data-rt-candle-period="M" aria-pressed="false">월봉</button>`,
      `</div>`,
      `<div class="rt-chart-body">`,
      `  <p class="rt-chart-loading-msg" aria-live="polite" hidden>차트 불러오는 중...</p>`,
      `  <div class="rt-chart-panes rt-chart-panes--pending" style="display:none;">`,
      `    <div class="rt-chart-pane--candle"><div class="rt-lw-candle-host" role="region" aria-label="캔들 차트"></div></div>`,
      `    <div class="rt-chart-pane--vol"><div class="rt-lw-volume-host" role="region" aria-label="거래량 차트"></div></div>`,
      `  </div>`,
      `</div>`,
    ].join("");
  }

  function findPanelElById(root, id) {
    if (!root || !id) return null;
    try {
      if (typeof CSS !== "undefined" && CSS.escape) return root.querySelector(`#${CSS.escape(id)}`);
    } catch {}
    return root.querySelector(`[id="${String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`);
  }

  function wireStockPanelChart(panelEl, code6) {
    const toggleBtn = panelEl.querySelector(".rt-chart-toggle");
    const targetId = toggleBtn ? toggleBtn.getAttribute("data-chart-target") : "";
    const chartHost = findPanelElById(panelEl, targetId);
    const codeNorm = chartSymbolSixDigits(code6);
    if (!toggleBtn || !chartHost || !codeNorm) return;

    let chartOpen = false;

    function setToggle(open) {
      chartOpen = !!open;
      toggleBtn.setAttribute("aria-expanded", chartOpen ? "true" : "false");
      toggleBtn.textContent = chartOpen ? "차트 닫기" : "차트 보기";
      chartHost.hidden = !chartOpen;
      chartHost.style.display = chartOpen ? "" : "none";
      if (!chartOpen) {
        const panes = chartHost.querySelector(".rt-chart-panes");
        if (panes) panes.style.display = "none";
      }
    }

    setToggle(false);
    toggleBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setToggle(!chartOpen);
      if (!chartOpen) return;
      if (!chartHost.dataset.mounted) {
        chartHost.innerHTML = stockPanelChartShellHtml(targetId);
        chartHost.dataset.mounted = "1";
        const panes = chartHost.querySelector(".rt-chart-panes");
        if (panes) panes.style.display = "";
        chartHost.querySelectorAll(".rt-chart-interval-btn").forEach((b) => {
          b.addEventListener("click", (ev2) => {
            ev2.stopPropagation();
            const p = b.getAttribute("data-rt-candle-period") || "D";
            chartHost.querySelectorAll(".rt-chart-interval-btn").forEach((x) =>
              x.setAttribute("aria-pressed", x === b ? "true" : "false")
            );
            void mountStockPanelChart(chartHost, codeNorm, String(p).toUpperCase());
          });
        });
      } else {
        const panes = chartHost.querySelector(".rt-chart-panes");
        if (panes) panes.style.display = "";
      }
      void mountStockPanelChart(chartHost, codeNorm, "D");
    });
  }

  function wireStockPanel(panelEl, data, opts) {
    if (opts && typeof opts.onClose === "function") {
      const closeBtn = panelEl.querySelector(".rt-acc-close");
      if (closeBtn) closeBtn.addEventListener("click", opts.onClose);
    }
    wireStockPanelChart(panelEl, chartSymbolSixDigits(data.stockCode));
  }

  async function mountTableDetailAccordion(body) {
    if (!state.openChartCode) return;
    const code = state.openChartCode;
    const row = body.querySelector(`tr.rt-detail-row[data-detail-for="${code}"]`);
    if (!row) return;
    const host = row.querySelector(".rt-detail-acc");
    if (!host) return;
    if (host.dataset.loadedFor === code && host.querySelector(".rt-acc")) {
      wireDetailAccordionClose(host);
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

    host.innerHTML = buildStockResultSkeleton();
    try {
      const data = await fetchStockQuoteDetail(code, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      if (state.openChartCode !== code) return;
      host.innerHTML = stockPanelHtml(data, { accordion: true });
      host.dataset.loadedFor = code;
      wireStockPanel(host, data, {
        onClose: () => {
          state.openChartCode = null;
          renderTable();
        },
      });
      const closeBtn = host.querySelector(".rt-acc-close");
      if (closeBtn) closeBtn.dataset.wired = "1";
    } catch (e) {
      if (e && e.name === "AbortError") return;
      if (state.openChartCode !== code) return;
      host.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml(rtErrorTimeoutMessage(e))}</p>`;
    } finally {
      if (state.detailFetchAbort === ctrl) state.detailFetchAbort = null;
    }
  }

  function stockPanelHtml(data, opts) {
    const isMobile =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 768px)").matches;
    const name = escapeHtml(data.stockName || "—");
    const code = escapeHtml(data.stockCode || "");
    const market = escapeHtml(data.market || "");
    const warnRaw = String(data.warn || "").trim();
    const badges = [
      code ? `<span class="rt-acc-badge">${code}</span>` : "",
      market ? `<span class="rt-acc-badge">${market}</span>` : "",
      warnRaw ? `<span class="rt-acc-badge" style="background: rgba(226,75,74,0.12); border: 1px solid rgba(226,75,74,0.35); color: #e24b4a;">${escapeHtml(warnRaw)}</span>` : "",
    ]
      .filter(Boolean)
      .join("");

    const ch = Number(data.changeRate);
    const cls = deltaClass(Number.isFinite(ch) ? ch : null);
    const price = escapeHtml(fmtNum(data.currentPrice));
    const pct = escapeHtml(fmtPct(Number.isFinite(ch) ? ch : null));

    const open = escapeHtml(fmtNum(data.open));
    const high = escapeHtml(fmtNum(data.high));
    const low = escapeHtml(fmtNum(data.low));
    const vol = escapeHtml(formatVolumeMan(data.volume));
    const prevClose = data.prevClose == null ? "—" : escapeHtml(fmtNum(data.prevClose));
    const prevVol = data.prevVolume == null ? "—" : escapeHtml(formatVolumeMan(data.prevVolume));
    const hi52 = escapeHtml(fmtNum(data.high52w));
    const lo52 = escapeHtml(fmtNum(data.low52w));
    const labelHi52 = isMobile ? "52주 최고" : "52주고";
    const labelLo52 = isMobile ? "52주 최저" : "52주저";
    const vsAbsRaw = data.changeValue ?? data.vsValue ?? data.vs ?? data.change ?? null;
    const vsAbs = vsAbsRaw == null ? "—" : escapeHtml(fmtNum(vsAbsRaw));
    const volTurnoverRateRaw = data.volTurnoverRate ?? data.vol_tnrt ?? null;
    const creditLoanRmnd = formatCreditLoanRmndRate(data);
    const volTurnoverRate =
      volTurnoverRateRaw == null || !Number.isFinite(Number(volTurnoverRateRaw)) || Number(volTurnoverRateRaw) === 0
        ? "—"
        : `${escapeHtml(Number(volTurnoverRateRaw).toFixed(2))}%`;
    const mcap = escapeHtml(formatMarketCapPretty(data.marketCapRaw || data.marketCap));
    const tvCalc = calcTradeValFromPriceVol(data.currentPrice, data.volume);
    const tvDisp = escapeHtml(tvCalc != null ? formatTradeVal(String(tvCalc)) : "—");

    const aiHref = `/stock-analysis.html?code=${encodeURIComponent(String(data.stockCode || ""))}&name=${encodeURIComponent(
      String(data.stockName || "")
    )}`;

    const fin = data.financials || {};
    const finPer =
      fin.per == null
        ? data.per == null || !Number.isFinite(Number(data.per))
          ? "—"
          : escapeHtml(Number(data.per).toFixed(1))
        : escapeHtml(Number(fin.per).toFixed(1));
    const finEps = fin.eps == null ? "—" : escapeHtml(fmtNum(fin.eps));
    const finBps = fin.bps == null ? "—" : escapeHtml(fmtNum(fin.bps));
    const finPbr =
      fin.pbr == null
        ? "—"
        : Number.isFinite(Number(fin.pbr))
          ? escapeHtml(Number(fin.pbr).toFixed(1))
          : escapeHtml(String(fin.pbr));
    const frgnHold = escapeHtml(formatForeignHoldCompact(data));

    const sup = data.supply || {};
    const supInstVal = sup.institution == null ? null : Number(String(sup.institution).replace(/,/g, ""));
    const supIndvVal = sup.individual == null ? null : Number(String(sup.individual).replace(/,/g, ""));
    const supFrgnVal = sup.foreigner == null ? null : Number(String(sup.foreigner).replace(/,/g, ""));
    const supInst = sup.institution == null ? "—" : escapeHtml(formatKoMoneyEokSigned(sup.institution));
    const supIndv = sup.individual == null ? "—" : escapeHtml(formatKoMoneyEokSigned(sup.individual));
    const supFrgn = sup.foreigner == null ? "—" : escapeHtml(formatKoMoneyEokSigned(sup.foreigner));
    const supInstCls = supplyAmountCls(supInstVal);
    const supIndvCls = supplyAmountCls(supIndvVal);
    const supFrgnCls = supplyAmountCls(supFrgnVal);

    const pf = data.profit || {};
    const pfRev = pf.revenue == null ? "—" : escapeHtml(formatKoMoneyEok(pf.revenue));
    const pfOp = pf.operatingProfit == null ? "—" : escapeHtml(formatKoMoneyEok(pf.operatingProfit));
    const pfNet = pf.netIncome == null ? "—" : escapeHtml(formatKoMoneyEok(pf.netIncome));
    const pfDate = pf.baseDate ? escapeHtml(String(pf.baseDate)) : "—";

    const chartId = `rt-chart-${String(data.stockCode || "").replace(/\D/g, "")}`;
    const closeBtn = `<button type="button" class="rt-acc-close" aria-label="닫기">×</button>`;

    const basicGrid = [
      accGridCell("시가", open),
      accGridCell("고가", high, "rt-acc-val--hi"),
      accGridCell("저가", low, "rt-acc-val--lo"),
      accGridCell("전일종가", prevClose),
      accGridCell("거래량", vol),
      accGridCell("거래대금", tvDisp),
      accGridCell("시총", mcap),
      accGridCell("거래량회전율", volTurnoverRate),
      accGridCell("PER", finPer),
      accGridCell("PBR", finPbr),
      accGridCell(labelHi52, hi52, "rt-acc-val--hi"),
      accGridCell(labelLo52, lo52, "rt-acc-val--lo"),
      accGridCell("EPS", finEps),
      accGridCell("BPS", finBps),
      accGridCell("외국인보유", frgnHold),
      accGridCell("신용융자잔고", creditLoanRmnd.text, creditLoanRmnd.cls),
    ].join("");

    const supplyGrid = [
      accGridCell("기관", supInst, supInstCls),
      accGridCell("개인", supIndv, supIndvCls),
      accGridCell("외국인", supFrgn, supFrgnCls),
    ].join("");

    const pfDateFmt = (() => {
      const raw = String(pf.baseDate || "").replace(/\D/g, "");
      if (raw.length >= 6) return escapeHtml(`${raw.slice(0, 4)}.${raw.slice(4, 6)}`);
      return pfDate;
    })();

    const profitGrid = [
      accGridCell("매출", pfRev),
      accGridCell("영업이익", pfOp),
      accGridCell("당기순이익", pfNet),
    ].join("");

    return [
      `<div class="rt-acc">`,
      `  <header class="rt-acc-header">`,
      `    <div class="rt-acc-header__left">`,
      `      <span class="rt-acc-name">${name}</span>`,
      badges ? `<span class="rt-acc-badges">${badges}</span>` : "",
      `    </div>`,
      `    <div class="rt-acc-header__right">`,
      `      <div>`,
      `        <div class="rt-acc-price">${price}</div>`,
      `        <div class="rt-acc-chg delta ${cls}">${pct}</div>`,
      `      </div>`,
      closeBtn,
      `    </div>`,
      `  </header>`,
      `  <div class="rt-acc-grid rt-acc-grid--4">${basicGrid}</div>`,
      `  <div class="rt-acc-grid rt-acc-grid--3 rt-acc-grid--section">${supplyGrid}</div>`,
      `  <div class="rt-acc-section-bar">`,
      `    <span class="rt-acc-section-bar__title">실적</span>`,
      `    <span class="rt-acc-section-bar__date">${pfDateFmt}</span>`,
      `  </div>`,
      `  <div class="rt-acc-grid rt-acc-grid--3 rt-acc-grid--profit">${profitGrid}</div>`,
      `  <footer class="rt-acc-footer">`,
      `    <a class="rt-acc-btn rt-acc-btn--ai" href="${escapeHtml(aiHref)}">AI 분석하기</a>`,
      `    <button type="button" class="rt-acc-btn rt-acc-btn--chart rt-chart-toggle" data-chart-target="${escapeHtml(chartId)}" aria-expanded="false">차트 보기</button>`,
      `    <div id="${escapeHtml(chartId)}" class="rt-chart-wrap" hidden></div>`,
      `  </footer>`,
      `</div>`,
    ].join("");
  }

  async function mountStockPanelChart(panelEl, code6, periodUpper) {
    const panes = panelEl.querySelector(".rt-chart-panes");
    const mounts = getLwChartPaneMounts(panes);
    const msg = panelEl.querySelector(".rt-chart-loading-msg");
    if (!panes || !mounts) return;
    const periodKey = String(periodUpper || "D").toUpperCase();
    const mountKey = `${code6}|${periodKey}`;

    if (panes.dataset.mountedKey === mountKey && panelLwCharts.has(panelEl)) {
      const w = Math.max(panes.clientWidth, 200);
      const s = panelLwCharts.get(panelEl);
      if (s && w > 0) {
        s.chartCandle.applyOptions({ width: w, height: LW_CANDLE_H });
        s.chartVol.applyOptions({ width: w, height: LW_VOL_H });
        syncLwDualChartAxes(s.chartCandle, s.chartVol);
      }
      return;
    }

    if (msg) msg.hidden = false;
    panes.classList.add("rt-chart-panes--pending");
    disposePanelLwChart(panelEl);
    delete panes.dataset.mountedKey;

    try {
      await ensureLightweightCharts(CHART_SCRIPT_TIMEOUT_MS);
      const LC = window.LightweightCharts;
      if (!LC || typeof LC.createChart !== "function") throw new Error("차트 라이브러리를 불러오지 못했습니다.");

      const w0 = Math.max(panes.clientWidth, 200);
      const localization = buildChartLocalization(periodKey);
      const created = createLwDualPanelCharts(LC, mounts, { width: w0, localization });
      const bundle = { ...created, fullCandles: [] };
      panelLwCharts.set(panelEl, bundle);

      bundle.crosshairLookup = buildCrosshairLookup([]);
      linkCrosshairSync(created.chartCandle, created.candle, created.chartVol, created.vol, bundle);
      wireRtCrosshairTooltip(
        panes,
        mounts.candleHost,
        created.chartCandle,
        created.chartVol,
        periodKey,
        () => bundle.fullCandles
      );

      const resizeObs = new ResizeObserver(() => {
        const s = panelLwCharts.get(panelEl);
        if (!s || !panes.isConnected) return;
        const w = panes.clientWidth;
        if (w <= 0) return;
        s.chartCandle.applyOptions({ width: w, height: LW_CANDLE_H });
        s.chartVol.applyOptions({ width: w, height: LW_VOL_H });
        syncLwDualChartAxes(s.chartCandle, s.chartVol);
      });
      resizeObs.observe(panes);
      bundle.resizeObs = resizeObs;

      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), CHART_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(
          `${API}?action=candle&code=${encodeURIComponent(code6)}&period=${encodeURIComponent(periodKey)}`,
          { cache: "no-store", signal: ctrl.signal }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const candles = Array.isArray(data.candles) ? data.candles : [];
        if (!candles.length) throw new Error("차트 데이터가 없습니다.");
        bundle.fullCandles = applyLwChartSeriesData(bundle, candles, state.chartBarsLimit || 200);
        writeChartCandleCache(code6, periodKey, candles);
        panes.dataset.mountedKey = mountKey;
      } finally {
        clearTimeout(tid);
      }
    } catch (e) {
      disposePanelLwChart(panelEl);
      const msgText =
        e && e.name === "AbortError"
          ? "차트 불러오기 시간이 초과되었습니다."
          : e && e.message
            ? e.message
            : String(e);
      mounts.candleHost.innerHTML = `<p class="rt-lw-chart-err">${escapeHtml(msgText)}</p>`;
      mounts.volHost.innerHTML = "";
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
    closeAutocomplete();
    // 테이블 아코디언(리스트 중간)과 검색 결과 패널은 분리
    if (state.openChartCode) {
      state.openChartCode = null;
      renderTable();
    }

    try {
      await loadStockListOnce();
      const code6 = resolveCodeFromQuery(q) || "";
      if (!/^\d{6}$/.test(code6)) {
        panel.innerHTML = `<p class="rt-lw-chart-err">종목을 찾을 수 없습니다.</p>`;
        return;
      }

      // 기존 구현(시세 조회/결과 표시 로직)을 그대로 사용
      const data = await fetchStockQuoteDetail(code6);
      panel.innerHTML = stockPanelHtml(data);

      const hidePanel = () => {
        panel.hidden = true;
        panel.innerHTML = "";
        const input2 = $("stock-search-input");
        if (input2) input2.value = "";
        try {
          const tabs = document.querySelector(".rt-tabs");
          if (tabs) tabs.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch {}
      };
      wireStockPanel(panel, data, { onClose: hidePanel });
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
      if (isRankListTab(state.tab)) renderTable();
      return;
    }
  }

  function subscribeStocks(codes) {
    if (!state.ws || state.ws.readyState !== 1) return;
    const trId = ccnlTrIdForTab();
    const limit = 25;
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
      const tab = state.tab;
      const page = currentPageForTab(tab);
      const detailOpen = !!state.openChartCode;

      if (detailOpen && isRankListTab(tab)) {
        try {
          const pack = await fetchStocksJsonForTab(tab);
          mergeStocksInPlaceForTab(tab, pack.stocks || []);
          const cache = pageCacheForTab(tab);
          if (cache[page]) cache[page].loadedAt = Date.now();
        } catch (e) {
          console.warn("[realtime-board] refreshPartial stocks merge", e && e.message);
        }
      } else {
        await ensureTabPageLoaded(tab, page, { force: true, skipTableUi: true });
      }

      const [idxPack, sessPack] = await Promise.all([
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

      if (state.tab !== tab) return;

      state.tabLoadedAt[state.tab] = Date.now();
      if (detailOpen) {
        renderIndexes();
        renderMeta();
        renderTable();
      } else {
        renderAll();
      }
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

  async function switchToTab(tk) {
    if (tk === "gainers") state.tab = "gainers";
    else if (tk === "tv") state.tab = "tv";
    else state.tab = "cap";
    state.openChartCode = null;
    state.candlePeriod = "D";

    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", state.tab);
      window.history.replaceState(null, "", url.pathname + url.search);
    } catch (_) {
      /* noop */
    }

    const stockPanel = $("stock-result-panel");
    if (stockPanel) {
      stockPanel.hidden = true;
      stockPanel.innerHTML = "";
    }

    if (state.tab === "cap") state.capPage = 1;
    else if (state.tab === "gainers") state.gainerPage = 1;
    else state.tvPage = 1;

    document.querySelectorAll("[data-rt-tab]").forEach((b) => {
      b.setAttribute("aria-selected", b.getAttribute("data-rt-tab") === tk ? "true" : "false");
    });

    syncTableLayoutAttr();
    renderThead();
    showTableLoading();

    const finish = () => {
      startPolling();
      if (state.ws && state.ws.readyState === 1) {
        unsubscribeAll();
        subscribeStocks(getCurrentRows().map((r) => r.code));
      }
    };

    const errEl = $("rt-error");
    const page1Hit = pageCacheForTab(tk)[1];

    if (page1Hit && page1Hit.stocks && page1Hit.stocks.length) {
      setCurrentPageForTab(tk, 1);
      applyStocksArrayToTab(tk, page1Hit.stocks);
      state.tabLoadedAt[tk] = page1Hit.loadedAt || Date.now();
      if (errEl) errEl.hidden = true;
      hideTableLoading();
      renderAll();
      finish();
      const cacheFresh = state.tabLoadedAt[tk] && Date.now() - state.tabLoadedAt[tk] < TAB_CACHE_MS;
      if (!cacheFresh) {
        refreshTabStocksOnly(tk)
          .then(() => {
            if (state.tab !== tk) return;
            if (errEl) errEl.hidden = true;
            renderAll();
          })
          .catch((e) => {
            console.error("[realtime-board] refreshTabStocksOnly (tab cache)", tk, e && e.message, e);
            if (state.tab !== tk) return;
            if (errEl) {
              errEl.hidden = false;
              errEl.textContent = rtErrorTimeoutMessage(e);
            }
          });
      }
      prefetchOtherRankTabs();
      return;
    }

    if (errEl) errEl.hidden = true;
    try {
      await loadBootstrapForTab(tk);
      if (state.tab !== tk) return;
      if (errEl) errEl.hidden = true;
      hideTableLoading();
      renderAll();
      prefetchOtherRankTabs();
    } catch (e) {
      console.error("[realtime-board] loadBootstrapForTab", tk, e && e.message, e);
      if (state.tab !== tk) return;
      hideTableLoading();
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = rtErrorTimeoutMessage(e);
      }
      renderAll();
    } finally {
      if (state.tab === tk) finish();
    }
  }

  function setupTabs() {
    document.querySelectorAll("[data-rt-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.getAttribute("data-rt-tab");
        if (!t) return;
        const tk = t === "gainers" ? "gainers" : t === "tv" ? "tv" : "cap";
        if (tk === state.tab) return;
        void switchToTab(tk);
      });
    });
  }

  function wireTableChartAccordion() {
    const body = $("rt-tbody");
    if (!body || body.dataset.rtChartWire === "1") return;
    body.dataset.rtChartWire = "1";
    body.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".rt-name-chart-btn");
      if (!btn || !body.contains(btn)) return;
      const code = btn.getAttribute("data-code");
      if (!code) return;
      if (state.openChartCode === code) {
        state.openChartCode = null;
        renderTable();
        return;
      }
      state.openChartCode = code;
      renderTable();
      if (state.openChartCode === code) void mountTableDetailAccordion(body);
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

  function tabFromUrl() {
    try {
      const t = new URLSearchParams(window.location.search).get("tab");
      if (t === "gainers" || t === "tv" || t === "cap") return t;
    } catch (_) {
      /* noop */
    }
    return "cap";
  }

  function applyTabFromUrl() {
    const tab = tabFromUrl();
    state.tab = tab;
    document.querySelectorAll("[data-rt-tab]").forEach((b) => {
      b.setAttribute("aria-selected", b.getAttribute("data-rt-tab") === tab ? "true" : "false");
    });
    syncTableLayoutAttr();
  }

  async function init() {
    applyTabFromUrl();
    setupTabs();
    wireLwChartThemeRefresh();
    wireTableChartAccordion();
    void loadStockListOnce();
    const searchInput = $("stock-search-input");
    if (searchInput && !searchInput.dataset.wired) {
      searchInput.dataset.wired = "1";
      searchInput.addEventListener("input", async () => {
        const q = normalizeQuery(searchInput.value);
        if (q.length < 2) {
          closeAutocomplete();
          return;
        }
        await loadStockListOnce();
        const lc = q.toLowerCase();
        const matches = (stockList || []).filter((x) => String(x.name || "").toLowerCase().includes(lc));
        renderAutocomplete(matches.slice(0, 8), matches.length);
      });
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveAutocomplete(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          moveAutocomplete(-1);
          return;
        }
        if (e.key === "Enter") {
          const picked = pickActiveAutocomplete();
          if (picked) {
            e.preventDefault();
            searchInput.value = picked.code;
            closeAutocomplete();
            searchStock();
            return;
          }
          searchStock();
        }
        if (e.key === "Escape") {
          closeAutocomplete();
        }
      });
    }
    const ac = acHost();
    if (ac && !ac.dataset.wired) {
      ac.dataset.wired = "1";
      ac.addEventListener("mousemove", (e) => {
        const it = e.target && e.target.closest ? e.target.closest("[data-ac-idx]") : null;
        if (!it) return;
        const idx = Number(it.getAttribute("data-ac-idx") || "-1");
        if (Number.isFinite(idx) && idx >= 0) {
          acState.active = idx;
          renderAutocomplete(acState.items, acState.items.length);
        }
      });
      ac.addEventListener("mousedown", (e) => {
        const it = e.target && e.target.closest ? e.target.closest("[data-ac-idx]") : null;
        if (!it) return;
        e.preventDefault();
        const idx = Number(it.getAttribute("data-ac-idx") || "-1");
        const picked = idx >= 0 && idx < acState.items.length ? acState.items[idx] : null;
        if (picked) {
          const input = $("stock-search-input");
          if (input) input.value = picked.code;
          closeAutocomplete();
          searchStock();
        }
      });
    }
    if (!document.body.dataset.rtAcOutside) {
      document.body.dataset.rtAcOutside = "1";
      document.addEventListener("mousedown", (e) => {
        const host = acHost();
        const input = $("stock-search-input");
        if (!host || host.hidden) return;
        const t = e.target;
        if (host.contains(t) || (input && input.contains(t))) return;
        closeAutocomplete();
      });
    }
    const err = $("rt-error");
    if (err) err.hidden = true;
    hideLoadingOverlay();
    syncTableChromeForTab();
    showTableLoading();
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
      renderAll();
      startPolling();
      prefetchOtherRankTabs();
      await tryConnectWs();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
