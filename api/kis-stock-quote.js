/**
 * KIS 종목 시세(시세1+시세2) 합쳐서 반환
 * GET /api/kis-stock-quote?code=005930
 * GET /api/kis-stock-quote?code=005930&chart=1&period=D|W|M
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

async function handleChartRequest(res, code6, period) {
  const candles = await fetchChartCandles(code6, period);
  if (!candles.length) {
    return json(res, 502, { error: "차트 데이터가 없습니다." });
  }
  return json(res, 200, enrichChart(candles));
}

function marketLabelFromRow(row) {
  const hint = sanitizeStr(
    (row && (row.mrkt_div_cls_code || row.MRKT_DIV_CLS_CODE || row.rprs_mrkt_kor_name || row.RPRS_MRKT_KOR_NAME)) ||
      ""
  );
  const blob = String(hint || "").toUpperCase();
  if (/KOSDAQ|KQ|KONEX/.test(blob) || /코스닥/.test(hint)) return "KOSDAQ";
  if (/KOSPI|KS|KRX/.test(blob) || /코스피|유가/.test(hint)) return "KOSPI";
  return hint || "";
}

const OVERSEAS_PRICE_PATH = "/uapi/overseas-price/v1/quotations/price";
const OVERSEAS_PRICE_TR_ID = "HHDFS00000300";
const OVERSEAS_DETAIL_PATH = "/uapi/overseas-price/v1/quotations/price-detail";
const OVERSEAS_DETAIL_TR_ID = "HHDFS76200200";
const US_EXCHANGES = ["NAS", "NYS"];

function pickFirst(row, keys) {
  if (!row || typeof row !== "object") return "";
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim() !== "") return value;
    const upper = String(key).toUpperCase();
    if (row[upper] != null && String(row[upper]).trim() !== "") return row[upper];
  }
  return "";
}

function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function normalizeUsTicker(raw) {
  const s = sanitizeStr(raw).toUpperCase().replace(/[^A-Z0-9.]/g, "");
  if (!s || s.length > 16) return "";
  return s;
}

function usExchangeLabel(excd) {
  const e = sanitizeStr(excd).toUpperCase();
  if (e === "NYS") return "NYSE";
  if (e === "NAS") return "NASDAQ";
  return e || "US";
}

function isKisRsymToken(value) {
  return /^D(NYS|NAS|AMS)[A-Z0-9.]{1,12}$/i.test(sanitizeStr(value));
}

function resolveUsStockName(detail, price, ticker, nameHint) {
  const hint = sanitizeStr(nameHint);
  if (hint && !isKisRsymToken(hint)) return hint;
  for (const key of [
    "e_icod",
    "E_ICOD",
    "ovrs_item_name",
    "OVRS_ITEM_NAME",
    "name",
    "NAME",
    "prdt_name",
    "PRDT_NAME",
  ]) {
    const candidate = sanitizeStr(pickFirst(detail, [key]) || pickFirst(price, [key]));
    if (candidate && !isKisRsymToken(candidate)) return candidate;
  }
  return ticker;
}

function pickUsVolume(detail, price) {
  const tvol = toNum(pickFirst(detail, ["tvol", "TVOL"]));
  const pvol = toNum(pickFirst(detail, ["pvol", "PVOL"]));
  const priceVol = toNum(pickFirst(price, ["tvol", "TVOL"]));
  const candidates = [tvol, pvol, priceVol].filter((n) => n != null && n > 0);
  if (!candidates.length) return null;
  return Math.round(Math.max(...candidates));
}

function pickUsTradingValue(detail, price, currentPrice, volume) {
  const tamt = toNum(pickFirst(detail, ["tamt", "TAMT"]));
  const pamt = toNum(pickFirst(detail, ["pamt", "PAMT"]));
  const priceAmt = toNum(pickFirst(price, ["tamt", "TAMT"]));
  const candidates = [tamt, pamt, priceAmt].filter((n) => n != null && n > 0);
  if (candidates.length) return Math.round(Math.max(...candidates));
  if (currentPrice != null && volume != null) return Math.round(currentPrice * volume);
  return null;
}

function resolveUsChangeAmt(row, price, changeRate) {
  const prev = round2(
    toNum(
      pickFirst(row, [
        "base",
        "BASE",
        "prdy_clpr",
        "PRDY_CLPR",
        "ovrs_prdy_clpr",
        "OVRS_PRDY_CLPR",
        "ovrs_stck_prdy_clpr",
        "OVRS_STCK_PRDY_CLPR",
      ])
    )
  );
  if (price != null && prev != null) return round2(price - prev);
  if (price != null && changeRate != null && Number.isFinite(changeRate)) {
    const prevFromPct = price / (1 + changeRate / 100);
    return round2(price - prevFromPct);
  }
  const raw = round2(toNum(pickFirst(row, ["diff", "DIFF", "prdy_vrss", "PRDY_VRSS", "ovrs_stck_prdy_vrss", "OVRS_STCK_PRDY_VRSS"])));
  if (raw == null) return null;
  if (changeRate == null || changeRate === 0) return raw;
  if (changeRate < 0 && raw > 0) return round2(-Math.abs(raw));
  if (changeRate > 0 && raw < 0) return round2(Math.abs(raw));
  return raw;
}

async function fetchUsStockQuote(ticker, nameHint) {
  let lastError = null;
  for (const exchange of US_EXCHANGES) {
    try {
      const [priceRes, detailRes] = await Promise.all([
        kisGetJson(OVERSEAS_PRICE_PATH, OVERSEAS_PRICE_TR_ID, { AUTH: "", EXCD: exchange, SYMB: ticker }),
        kisGetJson(OVERSEAS_DETAIL_PATH, OVERSEAS_DETAIL_TR_ID, { AUTH: "", EXCD: exchange, SYMB: ticker }),
      ]);
      const p = (priceRes && priceRes.output) || {};
      const d = (detailRes && detailRes.output) || {};
      const merged = { ...d, ...p };
      const currentPrice = round2(
        toNum(pickFirst(p, ["last", "LAST", "stck_prpr", "STCK_PRPR"])) ||
          toNum(pickFirst(d, ["last", "LAST", "stck_prpr", "STCK_PRPR"]))
      );
      if (currentPrice == null) continue;
      const changeRate = round2(toNum(pickFirst(merged, ["rate", "RATE", "prdy_ctrt", "PRDY_CTRT"])));
      const changeAmt = resolveUsChangeAmt(merged, currentPrice, changeRate);
      const volume = pickUsVolume(d, p);
      const tradingValue = pickUsTradingValue(d, p, currentPrice, volume);
      const marketCap = toNum(pickFirst(d, ["tomv", "TOMV", "mket_avls", "MKET_AVLS", "mcap", "MCAP"])) ||
        toNum(pickFirst(p, ["tomv", "TOMV", "mket_avls", "MKET_AVLS"]));
      const open = round2(toNum(pickFirst(d, ["open", "OPEN", "stck_oprc", "STCK_OPRC"])));
      const high = round2(toNum(pickFirst(d, ["high", "HIGH", "stck_hgpr", "STCK_HGPR"])));
      const low = round2(toNum(pickFirst(d, ["low", "LOW", "stck_lwpr", "STCK_LWPR"])));
      const prevClose = round2(
        toNum(
          pickFirst(merged, [
            "base",
            "BASE",
            "prdy_clpr",
            "PRDY_CLPR",
            "ovrs_prdy_clpr",
            "OVRS_PRDY_CLPR",
            "ovrs_stck_prdy_clpr",
            "OVRS_STCK_PRDY_CLPR",
          ])
        )
      );
      const high52w = round2(toNum(pickFirst(d, ["h52p", "H52P", "w52_hgpr", "W52_HGPR"])));
      const low52w = round2(toNum(pickFirst(d, ["l52p", "L52P", "w52_lwpr", "W52_LWPR"])));
      const per = toNum(pickFirst(d, ["perx", "PERX", "per", "PER"]));
      const eps = toNum(pickFirst(d, ["epsx", "EPSX", "eps", "EPS"]));
      const stockName = resolveUsStockName(d, p, ticker, nameHint);

      return {
        stockCode: ticker,
        stockName,
        market: usExchangeLabel(exchange),
        exchange,
        currentPrice,
        changeAmt,
        changeRate,
        volume,
        tradingValue,
        marketCap: marketCap == null ? null : Math.round(marketCap),
        prevClose,
        open,
        high,
        low,
        high52w,
        low52w,
        financials: { per, eps },
      };
    } catch (e) {
      lastError = e;
    }
  }
  const err = new Error(lastError && lastError.message ? lastError.message : `US quote not found: ${ticker}`);
  err.statusCode = 404;
  throw err;
}

async function handleUsQuoteRequest(res, ticker, nameHint) {
  const quote = await fetchUsStockQuote(ticker, nameHint);
  return json(res, 200, quote);
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
    const market = sanitizeStr(url.searchParams.get("market")).toUpperCase();
    const usTicker = normalizeUsTicker(url.searchParams.get("code") || url.searchParams.get("ticker") || "");
    if (market === "US" || market === "OVERSEAS") {
      if (!usTicker) {
        return json(res, 400, { error: "code(티커)가 필요합니다." });
      }
      const nameHint = sanitizeStr(url.searchParams.get("name"));
      return await handleUsQuoteRequest(res, usTicker, nameHint);
    }

    const code6 = normalizeCode6(url.searchParams.get("code") || "");
    const isChartPath = /\/kis-chart\/?$/i.test(url.pathname);
    const isChart =
      isChartPath || url.searchParams.get("chart") === "1" || url.searchParams.get("mode") === "chart";

    if (!/^\d{6}$/.test(code6)) {
      return json(res, 400, { error: "code(6자리)가 필요합니다." });
    }

    if (isChart) {
      const period = normalizePeriod(url.searchParams.get("period") || "D");
      return await handleChartRequest(res, code6, period);
    }

    const commonParams = {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code6,
    };

    const [p1, p2] = await Promise.all([
      kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", commonParams),
      kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-price-2", "FHPST01010000", commonParams),
    ]);

    const o1 = (p1 && p1.output) || {};
    const o2 = (p2 && p2.output) || {};

    const currentPrice = toNum(o1.stck_prpr);
    const changeAmt = toNum(o1.prdy_vrss);
    const changeRate = toNum(o1.prdy_ctrt);
    const volume = toNum(o1.acml_vol);
    const tradingValue = toNum(o1.acml_tr_pbmn) || (currentPrice != null && volume != null ? currentPrice * volume : null);
    const mcapRaw = sanitizeStr(o1.hts_avls || o1.stck_avls);

    const prevClose = toNum(o2.stck_prdy_clpr);
    const open = toNum(o2.stck_oprc) ?? toNum(o1.stck_oprc);
    const high = toNum(o2.stck_hgpr) ?? toNum(o1.stck_hgpr);
    const low = toNum(o2.stck_lwpr) ?? toNum(o1.stck_lwpr);
    const prevVolume = toNum(o2.prdy_vol);
    const warn = sanitizeStr(o2.mrkt_warn_cls_name);

    const per = toNum(o1.per);
    const pbr = toNum(o1.pbr);
    const eps = toNum(o1.eps);
    const bps = toNum(o1.bps);

    return json(res, 200, {
      stockCode: code6,
      stockName: sanitizeStr(o1.hts_kor_isnm || o1.prdt_abrv_name || o1.isnm || o2.hts_kor_isnm || ""),
      market: marketLabelFromRow(o1) || marketLabelFromRow(o2),
      currentPrice: currentPrice == null ? null : Math.round(currentPrice),
      changeAmt: changeAmt == null ? null : Math.round(changeAmt),
      changeRate: changeRate == null ? null : Math.round(changeRate * 100) / 100,
      volume: volume == null ? null : Math.round(volume),
      tradingValue: tradingValue == null ? null : Math.round(tradingValue),
      marketCapRaw: mcapRaw || "",
      prevClose: prevClose == null ? null : Math.round(prevClose),
      open: open == null ? null : Math.round(open),
      high: high == null ? null : Math.round(high),
      low: low == null ? null : Math.round(low),
      prevVolume: prevVolume == null ? null : Math.round(prevVolume),
      warn: warn || "",
      financials: {
        per,
        pbr,
        eps,
        bps,
      },
      raw1: o1,
      raw2: o2,
    });
  } catch (e) {
    const status = (e && e.statusCode) || 500;
    return json(res, status, { error: e && e.message ? e.message : String(e) });
  }
};

