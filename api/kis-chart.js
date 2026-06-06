/**
 * KIS 일/주/월봉 + MA/RSI
 * GET /api/kis-chart?code=005930&period=D|W|M
 */

const DEFAULT_KIS_BASE = "https://openapi.koreainvestment.com:9443";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

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
  return 200;
}

function firstWindowDays(periodDiv) {
  if (periodDiv === "M") return 3650;
  if (periodDiv === "W") return 1460;
  return 200;
}

function backwardChunkDays(periodDiv) {
  if (periodDiv === "M") return 4000;
  if (periodDiv === "W") return 1000;
  return 250;
}

async function fetchCandles(code6, periodDiv) {
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

function computeMaSeries(closes, period) {
  const out = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    out.push(Math.round(sum / period));
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

function enrichChart(candles) {
  const closes = candles.map((c) => c.close);
  return {
    candles,
    ma20: computeMaSeries(closes, 20),
    ma60: computeMaSeries(closes, 60),
    ma120: computeMaSeries(closes, 120),
    ma200: computeMaSeries(closes, 200),
    rsi14: computeRsi14(closes),
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end();
    return;
  }
  if (req.method !== "GET") {
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    const url = new URL(req.url, "http://localhost");
    const code6 = normalizeCode6(url.searchParams.get("code") || "");
    const period = normalizePeriod(url.searchParams.get("period") || "D");

    if (!/^\d{6}$/.test(code6)) {
      return json(res, 400, { error: "code(6자리)가 필요합니다." });
    }

    const candles = await fetchCandles(code6, period);
    if (!candles.length) {
      return json(res, 502, { error: "차트 데이터가 없습니다." });
    }

    return json(res, 200, enrichChart(candles));
  } catch (e) {
    const status = (e && e.statusCode) || 500;
    return json(res, status, { error: e && e.message ? e.message : String(e) });
  }
};
