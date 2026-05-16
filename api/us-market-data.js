/**
 * 미국 주식 시장 데이터 프록시 (Finnhub + KIS)
 * GET ?action=indices|sectors|gainers|volume|candle
 */

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const KIS_BASE_URL = (process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(
  /\/+$/,
  ""
);
const FINNHUB_TOKEN = process.env.FINNHUB_API_KEY;
const CACHE_TTL_MS = 5 * 60 * 1000;
const FINNHUB_CALL_GAP_MS = 100;
const KIS_TRADE_PBMN_PATH = "/uapi/overseas-stock/v1/ranking/trade-pbmn";
const KIS_TRADE_PBMN_TR_ID = "HHDFS76320010";

const US_INDICES = [
  { id: "nasdaq", name: "나스닥", symbol: "^IXIC" },
  { id: "sp500", name: "S&P 500", symbol: "^GSPC" },
  { id: "dow", name: "다우", symbol: "^DJI" },
];

const SECTOR_ETFS = [
  { symbol: "SOXX", name: "반도체", label: "SOXX" },
  { symbol: "XLK", name: "기술", label: "XLK" },
  { symbol: "XLV", name: "바이오", label: "XLV" },
  { symbol: "XLE", name: "에너지", label: "XLE" },
  { symbol: "XLF", name: "금융", label: "XLF" },
  { symbol: "XLY", name: "소비재", label: "XLY" },
  { symbol: "XLI", name: "산업재", label: "XLI" },
  { symbol: "XLU", name: "유틸리티", label: "XLU" },
];

const memoryCache = new Map();
let lastFinnhubCallAt = 0;
let finnhubQueue = Promise.resolve();

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNum(v) {
  if (v === "" || v == null) return null;
  if (typeof v === "string") {
    const s = v.trim().replace(/%/g, "").replace(/,/g, "").replace(/\s/g, "").replace(/^\+/, "");
    if (s === "" || s === "-" || s === ".") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function requireFinnhubToken() {
  if (!FINNHUB_TOKEN) throw new Error("Missing FINNHUB_API_KEY");
  return FINNHUB_TOKEN;
}

function requireKisAuth() {
  const token = sanitizeStr(process.env.KIS_ACCESS_TOKEN);
  const appkey = sanitizeStr(process.env.KIS_APP_KEY);
  const appsecret = sanitizeStr(process.env.KIS_APP_SECRET);
  if (!token) throw new Error("Missing KIS_ACCESS_TOKEN");
  if (!appkey || !appsecret) throw new Error("Missing KIS_APP_KEY or KIS_APP_SECRET");
  return { token, appkey, appsecret };
}

function finnhubUrl(path, params = {}) {
  const url = new URL(`${FINNHUB_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  url.searchParams.set("token", requireFinnhubToken());
  return url.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFinnhubRequest(task) {
  const run = finnhubQueue.then(async () => {
    const elapsed = Date.now() - lastFinnhubCallAt;
    if (elapsed < FINNHUB_CALL_GAP_MS) await sleep(FINNHUB_CALL_GAP_MS - elapsed);
    const result = await task();
    lastFinnhubCallAt = Date.now();
    return result;
  });
  finnhubQueue = run.catch(() => {});
  return run;
}

function kisOutputRows(body) {
  if (!body || typeof body !== "object") return [];
  for (const key of ["output", "output1", "output2", "OUTPUT", "Output"]) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

function pickFirst(row, keys) {
  if (!row || typeof row !== "object") return "";
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim() !== "") return value;
  }
  return "";
}

async function finnhubFetch(path, params) {
  return runFinnhubRequest(async () => {
    const res = await fetch(finnhubUrl(path, params), {
      headers: { Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}: ${text.slice(0, 240)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Finnhub invalid JSON: ${text.slice(0, 120)}`);
    }
  });
}

async function kisGet(path, trId, params) {
  const { token, appkey, appsecret } = requireKisAuth();
  const url = new URL(path, KIS_BASE_URL);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value == null ? "" : String(value));
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey,
      appsecret,
      tr_id: trId,
      custtype: "P",
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`KIS invalid JSON HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  if (!res.ok) throw new Error(`KIS HTTP ${res.status}: ${text.slice(0, 240)}`);
  if (body.rt_cd && body.rt_cd !== "0") {
    throw new Error(`KIS rt_cd=${body.rt_cd} msg=${body.msg1 || body.msg_cd || ""}`);
  }
  return body;
}

async function cached(key, loader, ttlMs = CACHE_TTL_MS) {
  const now = Date.now();
  const hit = memoryCache.get(key);
  if (hit && hit.value !== undefined && hit.expiresAt > now) return hit.value;
  if (hit && hit.promise) return hit.promise;

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      memoryCache.set(key, { value, expiresAt: now + ttlMs });
      return value;
    })
    .catch((e) => {
      memoryCache.delete(key);
      throw e;
    });
  memoryCache.set(key, { promise, expiresAt: now + ttlMs });
  return promise;
}

async function mapSequential(items, mapper) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    out.push(await mapper(items[i], i));
  }
  return out;
}

/** Finnhub quote — 현재가·등락률·등락포인트 */
async function fetchQuote(symbol) {
  return cached(`quote:${symbol}`, async () => {
    const q = await finnhubFetch("/quote", { symbol });
    const price = toNum(q.c);
    const changePoints = round2(toNum(q.d));
    const changePct = round2(toNum(q.dp));
    const previousClose = round2(toNum(q.pc));
    return {
      symbol,
      price: price != null ? round2(price) : null,
      previousClose,
      changePct,
      changePoints,
    };
  });
}

async function fetchQuoteBatch(symbols) {
  const quotes = await mapSequential(symbols, (symbol) => fetchQuote(symbol));
  const map = new Map();
  for (const q of quotes) {
    if (q && q.symbol) map.set(q.symbol, q);
  }
  return map;
}

function mapKisTradeRow(row, rank) {
  const ticker = sanitizeStr(
    pickFirst(row, ["symb", "SYMB", "ovrs_pdno", "OVRS_PDNO", "rsym", "RSYM", "ticker", "TICKER"])
  );
  const name = sanitizeStr(pickFirst(row, ["name", "NAME", "ovrs_item_name", "OVRS_ITEM_NAME"])) || ticker;
  const price = round2(toNum(pickFirst(row, ["last", "LAST"])));
  const changePct = round2(toNum(pickFirst(row, ["rate", "RATE"])));
  const volume = toNum(pickFirst(row, ["tvol", "TVOL"]));
  const amount = toNum(pickFirst(row, ["tamt", "TAMT"]));
  return {
    rank,
    ticker,
    name,
    price,
    changePct,
    volume: volume != null ? Math.round(volume) : null,
    tradingValue: amount != null ? Math.round(amount) : null,
  };
}

async function fetchKisNasdaqTradeRankingRows() {
  return cached("kis:nasdaq:trade-pbmn", async () => {
    const body = await kisGet(KIS_TRADE_PBMN_PATH, KIS_TRADE_PBMN_TR_ID, {
      KEYB: "",
      AUTH: "",
      EXCD: "NAS",
      NDAY: "0",
      VOL_RANG: "0",
      PRC1: "",
      PRC2: "",
    });
    return kisOutputRows(body).map((row, i) => mapKisTradeRow(row, i + 1));
  });
}

async function fetchNasdaqGainersTop20() {
  const rows = await fetchKisNasdaqTradeRankingRows();
  return rows
    .filter((row) => row.ticker && row.price != null && row.changePct != null)
    .sort((a, b) => (b.changePct || 0) - (a.changePct || 0))
    .slice(0, 20)
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

async function fetchNasdaqVolumeTop20() {
  const rows = await fetchKisNasdaqTradeRankingRows();
  return rows
    .filter((row) => row.ticker && row.price != null && row.tradingValue != null)
    .sort((a, b) => (b.tradingValue || 0) - (a.tradingValue || 0))
    .slice(0, 20)
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

async function fetchIndices() {
  const items = [];
  for (const idx of US_INDICES) {
    const q = await fetchQuote(idx.symbol);
    items.push({
      id: idx.id,
      name: idx.name,
      symbol: idx.symbol,
      price: q.price,
      changePct: q.changePct,
      changePoints: q.changePoints,
    });
  }
  return items;
}

async function fetchSectors() {
  const symbols = SECTOR_ETFS.map((s) => s.symbol);
  const batch = await fetchQuoteBatch(symbols);
  return SECTOR_ETFS.map((s) => {
    const q = batch.get(s.symbol) || {};
    return {
      symbol: s.symbol,
      name: s.name,
      label: s.label,
      price: q.price ?? null,
      changePct: q.changePct ?? null,
    };
  });
}

function normalizeCandlePeriod(raw) {
  const u = sanitizeStr(raw).toUpperCase();
  if (u === "W" || u === "M") return u;
  return "D";
}

function normalizeTicker(raw) {
  const s = sanitizeStr(raw).toUpperCase();
  if (!s || s.length > 12) return "";
  return s.replace(/[^A-Z0-9.^\-]/g, "");
}

function cachedPayload(key, loader) {
  return cached(`payload:${key}`, async () => {
    const payload = await loader();
    return { ...payload, updatedAt: new Date().toISOString() };
  });
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  const action = sanitizeStr(req.query && req.query.action) || "indices";

  try {
    if (action === "indices") {
      const payload = await cachedPayload("indices", async () => ({ indices: await fetchIndices() }));
      json(res, 200, payload);
      return;
    }

    if (action === "sectors") {
      const payload = await cachedPayload("sectors", async () => ({ sectors: await fetchSectors() }));
      json(res, 200, payload);
      return;
    }

    if (action === "gainers") {
      const payload = await cachedPayload("gainers", async () => ({ stocks: await fetchNasdaqGainersTop20() }));
      json(res, 200, payload);
      return;
    }

    if (action === "volume") {
      const payload = await cachedPayload("volume", async () => ({ stocks: await fetchNasdaqVolumeTop20() }));
      json(res, 200, payload);
      return;
    }

    if (action === "candle") {
      const ticker = normalizeTicker(req.query && req.query.ticker);
      if (!ticker) {
        json(res, 400, { error: "Missing or invalid ticker" });
        return;
      }
      const period = normalizeCandlePeriod(req.query && req.query.period);
      const payload = await cachedPayload(`candle:${ticker}:${period}`, async () => ({
        ticker,
        period,
        candles: [],
      }));
      json(res, 200, payload);
      return;
    }

    json(res, 400, {
      error: "Unknown action. Use indices, sectors, gainers, volume, or candle.",
    });
  } catch (e) {
    console.error("[us-market-data]", action, e && e.message, e);
    json(res, 502, { error: e.message || String(e) });
  }
};
