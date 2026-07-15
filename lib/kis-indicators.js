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

async function fetchChartCandles(code6, periodDiv) {
  const period = normalizePeriod(periodDiv);
  const target = targetCount(period);
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
  enrichChart,
};
