/**
 * KIS(한국투자증권) 일봉 캔들 조회 + 이동평균/RSI 계산 — 공용 모듈.
 *
 * 2026-07-15: api/kis-stock-quote.js에 있는 로직(이동평균/RSI 계산, 일봉 조회)과
 * 100% 동일한 코드를 매매 시그널 스캔(scripts/trade-signal-scan.mjs)에서도 써야 해서
 * 이 공용 모듈로 뺐다. NOTE: api/kis-stock-quote.js 자체는 안정적으로 운영 중인
 * 엔드포인트라 이번 작업에서는 건드리지 않았다(회귀 위험 최소화) — 그 파일은 여전히
 * 자체 사본을 갖고 있다. 이건 프로젝트에 이미 있는 "같은 로직 여러 곳에 존재" 패턴을
 * 하나 더 늘리는 셈이라, 다음에 두 파일 중 한쪽만 고치는 일이 없도록 주의할 것
 * (예: RSI 계산식을 고칠 일이 생기면 여기와 api/kis-stock-quote.js 둘 다 확인).
 */

const DEFAULT_KIS_BASE = "https://openapi.koreainvestment.com:9443";

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNum(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeCode6(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 6) return digits;
  if (digits.length < 6) return digits.padStart(6, "0");
  return digits.slice(-6);
}

function ymdKst(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d).replace(/-/g, "");
}

function subtractCalendarDaysFromYmd(ymd, days) {
  const s = String(ymd || "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(s)) return s;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6)) - 1;
  const day = Number(s.slice(6, 8));
  const dt = new Date(Date.UTC(y, m, day));
  dt.setUTCDate(dt.getUTCDate() - Number(days || 0));
  return ymdKst(dt);
}

function requireKisCreds() {
  const token = sanitizeStr(process.env.KIS_ACCESS_TOKEN);
  const appkey = sanitizeStr(process.env.KIS_APP_KEY);
  const appsecret = sanitizeStr(process.env.KIS_APP_SECRET);
  if (!token || !appkey || !appsecret) {
    const err = new Error("Missing KIS credentials");
    err.statusCode = 503;
    throw err;
  }
  return { token, appkey, appsecret };
}

function kisBaseUrl() {
  return sanitizeStr(process.env.KIS_BASE_URL || DEFAULT_KIS_BASE).replace(/\/+$/, "");
}

async function kisGetJson(path, trId, params) {
  const { token, appkey, appsecret } = requireKisCreds();
  const url = new URL(path, kisBaseUrl());
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, v == null ? "" : String(v));
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey,
      appsecret,
      tr_id: trId,
    },
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    const err = new Error(`KIS invalid JSON: ${text.slice(0, 200)}`);
    err.statusCode = 502;
    throw err;
  }
  if (!res.ok || (j && j.rt_cd && j.rt_cd !== "0")) {
    const msg = (j && (j.msg1 || j.msg_cd)) || `HTTP ${res.status}`;
    const err = new Error(`KIS error: ${msg}`);
    err.statusCode = 502;
    throw err;
  }
  return j;
}

function mapDailyRow(row) {
  if (!row || typeof row !== "object") return null;
  const dateRaw = sanitizeStr(row.stck_bsop_date || row.STCK_BSOP_DATE);
  if (!/^\d{8}$/.test(dateRaw)) return null;
  const time = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
  const open = toNum(row.stck_oprc || row.STCK_OPRC);
  const high = toNum(row.stck_hgpr || row.STCK_HGPR);
  const low = toNum(row.stck_lwpr || row.STCK_LWPR);
  const close = toNum(row.stck_clpr || row.STCK_CLPR || row.stck_prpr || row.STCK_PRPR);
  if (open == null || high == null || low == null || close == null) return null;
  const volRaw = toNum(row.acml_vol || row.ACML_VOL);
  const volume = volRaw != null && volRaw >= 0 ? volRaw : 0;
  return {
    time,
    open: Math.round(open),
    high: Math.round(high),
    low: Math.round(low),
    close: Math.round(close),
    volume: Math.round(volume),
  };
}

function normalizePeriod(raw) {
  const p = sanitizeStr(raw).toUpperCase();
  if (p === "W" || p === "M") return p;
  return "D";
}

function targetCount(periodDiv) {
  if (periodDiv === "M") return 120;
  if (periodDiv === "W") return 200;
  return 500;
}

function firstWindowDays(periodDiv) {
  if (periodDiv === "M") return 3650;
  if (periodDiv === "W") return 1460;
  return 750;
}

function backwardChunkDays(periodDiv) {
  if (periodDiv === "M") return 4000;
  if (periodDiv === "W") return 1000;
  return 400;
}

async function fetchChartCandles(code6, periodDiv, targetOverride) {
  const period = normalizePeriod(periodDiv);
  const target =
    targetOverride && Number.isFinite(targetOverride) && targetOverride > 0
      ? Math.floor(targetOverride)
      : targetCount(period);
  const endAll = ymdKst(new Date());
  const byTime = new Map();
  let chunkEnd = endAll;
  const floorYmd = subtractCalendarDaysFromYmd(endAll, firstWindowDays(period));

  for (let iter = 0; iter < 20; iter++) {
    const chunkStart =
      iter === 0 ? floorYmd : subtractCalendarDaysFromYmd(chunkEnd, backwardChunkDays(period));
    let d1 = chunkStart;
    let d2 = chunkEnd;
    if (d1 >= d2) d1 = subtractCalendarDaysFromYmd(d2, 30);
    if (d1 >= d2) break;

    const j = await kisGetJson(
      "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
      "FHKST03010100",
      {
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: code6,
        FID_INPUT_DATE_1: d1,
        FID_INPUT_DATE_2: d2,
        FID_PERIOD_DIV_CODE: period,
        FID_ORG_ADJ_PRC: "0",
      }
    );

    let raw = j.output2;
    if (raw && !Array.isArray(raw)) raw = [raw];
    if (!Array.isArray(raw)) raw = [];
    const batch = [];
    for (const row of raw) {
      const b = mapDailyRow(row);
      if (b) batch.push(b);
    }
    batch.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    if (!batch.length) break;

    const before = byTime.size;
    for (const b of batch) byTime.set(b.time, b);
    if (byTime.size >= target) break;
    if (byTime.size === before && iter > 1) break;

    const oldestYmd = String(batch[0].time).replace(/\D/g, "").slice(0, 8);
    if (!/^\d{8}$/.test(oldestYmd)) break;
    const nextEnd = subtractCalendarDaysFromYmd(oldestYmd, 1);
    if (nextEnd >= chunkEnd) break;
    chunkEnd = nextEnd;
  }

  return [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)).slice(-target);
}

function roundSmart(n) {
  if (!Number.isFinite(n)) return n;
  const abs = Math.abs(n);
  if (abs >= 100) return Math.round(n * 100) / 100;
  if (abs >= 1) return Math.round(n * 1000) / 1000;
  return Math.round(n * 1e6) / 1e6;
}

function computeMaSeries(closes, period, smart) {
  const out = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const avg = sum / period;
    out.push(smart ? roundSmart(avg) : Math.round(avg));
  }
  return out;
}

function computeRsi14(closes) {
  const period = 14;
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function computeRsiSeries(closes) {
  const period = 14;
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 100) / 100;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 100) / 100;
  }
  return out;
}

function enrichChart(candles, assetType) {
  const closes = candles.map((c) => c.close);
  const smart = assetType === "US" || assetType === "CRYPTO";
  return {
    candles,
    ma20: computeMaSeries(closes, 20, smart),
    ma60: computeMaSeries(closes, 60, smart),
    ma120: computeMaSeries(closes, 120, smart),
    ma200: computeMaSeries(closes, 200, smart),
    rsi14: computeRsi14(closes),
  };
}


/**
 * 2026-07-17: 매매시그널 '즉시검색' — RSI 다이버전스(강세/약세) 감지.
 * 스윙 저점/고점(좌우 PIVOT_WINDOW일 대비 극값) 두 개를 최근 DIVERGENCE_LOOKBACK 거래일
 * 안에서 찾아 가격과 RSI 방향이 어긋나는지 비교한다. 가장 최근 스윙포인트가
 * DIVERGENCE_RECENCY 거래일 이내여야 "지금" 신호로 인정한다(너무 오래된 다이버전스는 무시).
 * 단순화된 v1 구현 — 차트 프로그램의 정교한 피벗 알고리즘과 100% 동일하진 않지만
 * 스크리닝 목적으로는 충분히 유의미하다.
 */
const DIVERGENCE_PIVOT_WINDOW = 2;
const DIVERGENCE_LOOKBACK = 40;
const DIVERGENCE_RECENCY = 5;

function findSwingLows(closes, window) {
  const out = [];
  for (let i = window; i < closes.length - window; i++) {
    let isLow = true;
    for (let k = i - window; k <= i + window; k++) {
      if (k !== i && closes[k] <= closes[i]) {
        isLow = false;
        break;
      }
    }
    if (isLow) out.push(i);
  }
  return out;
}

function findSwingHighs(closes, window) {
  const out = [];
  for (let i = window; i < closes.length - window; i++) {
    let isHigh = true;
    for (let k = i - window; k <= i + window; k++) {
      if (k !== i && closes[k] >= closes[i]) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) out.push(i);
  }
  return out;
}

function detectDivergence(closes, rsiSeries) {
  const result = { bullish: false, bearish: false };
  const n = closes.length;
  if (n < DIVERGENCE_LOOKBACK + DIVERGENCE_PIVOT_WINDOW * 2) return result;

  const startIdx = n - DIVERGENCE_LOOKBACK;
  const lows = findSwingLows(closes, DIVERGENCE_PIVOT_WINDOW).filter((i) => i >= startIdx);
  const highs = findSwingHighs(closes, DIVERGENCE_PIVOT_WINDOW).filter((i) => i >= startIdx);

  if (lows.length >= 2) {
    const i2 = lows[lows.length - 1];
    const i1 = lows[lows.length - 2];
    const recent = n - 1 - i2 <= DIVERGENCE_RECENCY;
    if (
      recent &&
      closes[i2] < closes[i1] &&
      rsiSeries[i2] != null &&
      rsiSeries[i1] != null &&
      rsiSeries[i2] > rsiSeries[i1]
    ) {
      result.bullish = true;
    }
  }
  if (highs.length >= 2) {
    const i2 = highs[highs.length - 1];
    const i1 = highs[highs.length - 2];
    const recent = n - 1 - i2 <= DIVERGENCE_RECENCY;
    if (
      recent &&
      closes[i2] > closes[i1] &&
      rsiSeries[i2] != null &&
      rsiSeries[i1] != null &&
      rsiSeries[i2] < rsiSeries[i1]
    ) {
      result.bearish = true;
    }
  }
  return result;
}


/**
 * 2026-07-18: 매매시그널 신규 지표군 — MACD, 볼린저밴드, 스토캐스틱, ADX/DMI,
 * 캔들패턴, 갭, 연속 양봉/음봉. 전부 종가/고가/저가/시가 순수 배열 기반 계산이라
 * KIS 일봉 조회 결과(candles)만 있으면 바로 쓸 수 있다.
 */

function computeEmaSeries(closes, period) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let ema = sum / period;
  out[period - 1] = ema;
  for (let i = period; i < n; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function computeMacd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const n = closes.length;
  const emaFast = computeEmaSeries(closes, fastPeriod);
  const emaSlow = computeEmaSeries(closes, slowPeriod);
  const macdLine = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (emaFast[i] != null && emaSlow[i] != null) macdLine[i] = emaFast[i] - emaSlow[i];
  }
  const firstValid = macdLine.findIndex((v) => v != null);
  const signalLine = new Array(n).fill(null);
  if (firstValid >= 0 && n - firstValid >= signalPeriod) {
    const k = 2 / (signalPeriod + 1);
    let sum = 0;
    for (let i = firstValid; i < firstValid + signalPeriod; i++) sum += macdLine[i];
    let sig = sum / signalPeriod;
    signalLine[firstValid + signalPeriod - 1] = sig;
    for (let i = firstValid + signalPeriod; i < n; i++) {
      sig = macdLine[i] * k + sig * (1 - k);
      signalLine[i] = sig;
    }
  }
  const histogram = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (macdLine[i] != null && signalLine[i] != null) histogram[i] = macdLine[i] - signalLine[i];
  }
  return { macdLine, signalLine, histogram };
}

function computeBollinger(closes, period = 20, mult = 2) {
  const n = closes.length;
  const mid = new Array(n).fill(null);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  const width = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mean) * (closes[j] - mean);
    const sd = Math.sqrt(variance / period);
    mid[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
    width[i] = mean ? ((mean + mult * sd - (mean - mult * sd)) / mean) * 100 : null;
  }
  return { mid, upper, lower, width };
}

function smoothSma(series, period) {
  const n = series.length;
  const out = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (series[j] == null) {
        ok = false;
        break;
      }
      sum += series[j];
    }
    out[i] = ok ? sum / period : null;
  }
  return out;
}

function computeStochastic(highs, lows, closes, kPeriod = 14, kSmooth = 3, dPeriod = 3) {
  const n = closes.length;
  const rawK = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    rawK[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
  }
  const k = smoothSma(rawK, kSmooth);
  const d = smoothSma(k, dPeriod);
  return { k, d };
}

function computeADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  function wilderSmooth(arr) {
    const out = new Array(n).fill(null);
    if (n <= period) return out;
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += arr[i];
    out[period] = sum;
    for (let i = period + 1; i < n; i++) {
      out[i] = out[i - 1] - out[i - 1] / period + arr[i];
    }
    return out;
  }
  const trS = wilderSmooth(tr);
  const plusDMS = wilderSmooth(plusDM);
  const minusDMS = wilderSmooth(minusDM);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (trS[i]) {
      plusDI[i] = (plusDMS[i] / trS[i]) * 100;
      minusDI[i] = (minusDMS[i] / trS[i]) * 100;
      const sum = plusDI[i] + minusDI[i];
      dx[i] = sum ? (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100 : 0;
    }
  }
  const adx = new Array(n).fill(null);
  const firstDx = dx.findIndex((v) => v != null);
  if (firstDx >= 0 && n - firstDx >= period) {
    let sum = 0;
    for (let i = firstDx; i < firstDx + period; i++) sum += dx[i];
    adx[firstDx + period - 1] = sum / period;
    for (let i = firstDx + period; i < n; i++) {
      adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
    }
  }
  return { adx, plusDI, minusDI };
}

/** 마지막 봉 기준 캔들패턴 감지 (장악형/망치형/유성형/도지) — 스크리닝 목적의 단순화 버전 */
function detectCandlePatterns(candles) {
  const out = {
    bullishEngulfing: false,
    bearishEngulfing: false,
    hammer: false,
    shootingStar: false,
    doji: false,
  };
  const n = candles.length;
  if (n < 2) return out;
  const cur = candles[n - 1];
  const prev = candles[n - 2];
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low || 1;
  const upperShadow = cur.high - Math.max(cur.open, cur.close);
  const lowerShadow = Math.min(cur.open, cur.close) - cur.low;

  if (range > 0 && body / range < 0.1) out.doji = true;

  if (prev.close < prev.open && cur.close > cur.open && cur.close >= prev.open && cur.open <= prev.close) {
    out.bullishEngulfing = true;
  }
  if (prev.close > prev.open && cur.close < cur.open && cur.open >= prev.close && cur.close <= prev.open) {
    out.bearishEngulfing = true;
  }
  if (body > 0 && lowerShadow >= body * 2 && upperShadow <= body * 0.5) {
    out.hammer = true;
  }
  if (body > 0 && upperShadow >= body * 2 && lowerShadow <= body * 0.5) {
    out.shootingStar = true;
  }
  return out;
}

/** 갭상승/갭하락 — 오늘 시가가 전일 고가/저가를 벗어나서 시작했는지 */
function detectGap(candles) {
  const n = candles.length;
  if (n < 2) return { up: false, down: false };
  const cur = candles[n - 1];
  const prev = candles[n - 2];
  return { up: cur.open > prev.high, down: cur.open < prev.low };
}

/** 연속 양봉/음봉 개수 (오늘부터 거꾸로 셈) */
function consecutiveStreak(candles) {
  let count = 0;
  let dir = null;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    const isUp = c.close > c.open;
    const isDown = c.close < c.open;
    if (dir === null) {
      if (isUp) dir = "up";
      else if (isDown) dir = "down";
      else break;
      count = 1;
    } else if ((dir === "up" && isUp) || (dir === "down" && isDown)) {
      count++;
    } else break;
  }
  return { direction: dir, count };
}


/**
 * 2026-07-19: 매매시그널 스크리닝 조건에 시가총액/거래대금이 빠져 있어(사용자가 "시가총액
 * 1000억이상, 거래대금 50억이상" 같은 조건을 말해도 무시되고 결과에 반영이 안 됨) 종목당
 * 시세 조회(inquire-price, FHKST01010100)를 1회 추가해서 시가총액(hts_avls, 억원 단위)과
 * 당일 누적거래대금(acml_tr_pbmn, 원 단위)을 가져온다. 이 엔드포인트는 api/kis-stock-quote.js의
 * 실시간시세 조회에서 이미 쓰고 있는 것과 동일 — stock-analysis.js의 formatMarketCapPretty가
 * hts_avls를 억원 단위로 그대로 해석하는 것과 동일한 단위 가정을 따른다.
 */
async function fetchMarketSnapshot(code6) {
  try {
    const j = await kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code6,
    });
    const o = (j && j.output) || {};
    const marketCapEok = toNum(o.hts_avls);
    const tradingValueWon = toNum(o.acml_tr_pbmn);
    return {
      marketCapEok: marketCapEok != null ? Math.round(marketCapEok) : null,
      tradingValueEok: tradingValueWon != null ? Math.round((tradingValueWon / 1e8) * 100) / 100 : null,
    };
  } catch {
    return { marketCapEok: null, tradingValueEok: null };
  }
}

module.exports = {
  sanitizeStr,
  toNum,
  normalizeCode6,
  ymdKst,
  subtractCalendarDaysFromYmd,
  requireKisCreds,
  kisBaseUrl,
  kisGetJson,
  mapDailyRow,
  normalizePeriod,
  targetCount,
  fetchChartCandles,
  roundSmart,
  computeMaSeries,
  computeRsi14,
  computeRsiSeries,
  detectDivergence,
  enrichChart,
  computeEmaSeries,
  computeMacd,
  computeBollinger,
  computeStochastic,
  computeADX,
  detectCandlePatterns,
  detectGap,
  consecutiveStreak,
  fetchMarketSnapshot,
};
