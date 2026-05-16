/**
 * 미국 주식 시장 데이터 프록시 (Finnhub)
 * GET ?action=indices|sectors|gainers|volume|candle
 */

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const FINNHUB_TOKEN = process.env.FINNHUB_API_KEY;
const CACHE_TTL_MS = 4 * 60 * 1000;

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

const NASDAQ_UNIVERSE = [
  { ticker: "AAPL", name: "Apple" },
  { ticker: "MSFT", name: "Microsoft" },
  { ticker: "NVDA", name: "NVIDIA" },
  { ticker: "AMZN", name: "Amazon" },
  { ticker: "META", name: "Meta Platforms" },
  { ticker: "GOOGL", name: "Alphabet A" },
  { ticker: "GOOG", name: "Alphabet C" },
  { ticker: "TSLA", name: "Tesla" },
  { ticker: "AVGO", name: "Broadcom" },
  { ticker: "COST", name: "Costco" },
  { ticker: "NFLX", name: "Netflix" },
  { ticker: "AMD", name: "AMD" },
  { ticker: "ADBE", name: "Adobe" },
  { ticker: "CSCO", name: "Cisco" },
  { ticker: "PEP", name: "PepsiCo" },
  { ticker: "QCOM", name: "Qualcomm" },
  { ticker: "TXN", name: "Texas Instruments" },
  { ticker: "AMGN", name: "Amgen" },
  { ticker: "INTU", name: "Intuit" },
  { ticker: "ISRG", name: "Intuitive Surgical" },
  { ticker: "BKNG", name: "Booking Holdings" },
  { ticker: "HON", name: "Honeywell" },
  { ticker: "AMAT", name: "Applied Materials" },
  { ticker: "PANW", name: "Palo Alto Networks" },
];

const memoryCache = new Map();

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

function finnhubUrl(path, params = {}) {
  const url = new URL(`${FINNHUB_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  url.searchParams.set("token", requireFinnhubToken());
  return url.toString();
}

async function finnhubFetch(path, params) {
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

async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await mapper(items[idx], idx);
    }
  });
  await Promise.all(workers);
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
  const quotes = await mapWithConcurrency(symbols, 6, (symbol) => fetchQuote(symbol));
  const map = new Map();
  for (const q of quotes) {
    if (q && q.symbol) map.set(q.symbol, q);
  }
  return map;
}

function mapUniverseRow(stock, quote, tradingValue, rank) {
  const ticker = stock.ticker;
  return {
    rank,
    ticker,
    name: stock.name,
    price: quote.price,
    changePct: quote.changePct,
    tradingValue: tradingValue != null ? Math.round(tradingValue) : null,
  };
}

async function fetchNasdaqGainersTop20() {
  const rows = await mapWithConcurrency(NASDAQ_UNIVERSE, 6, async (stock) => {
    const quote = await fetchQuote(stock.ticker);
    return mapUniverseRow(stock, quote, null, null);
  });
  return rows
    .filter((row) => row.price != null && row.changePct != null)
    .sort((a, b) => (b.changePct || 0) - (a.changePct || 0))
    .slice(0, 20)
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

async function fetchNasdaqVolumeTop20() {
  const rows = await mapWithConcurrency(NASDAQ_UNIVERSE, 4, async (stock) => {
    const [quote, volume] = await Promise.all([fetchQuote(stock.ticker), fetchLatestDailyVolume(stock.ticker)]);
    const tradingValue = quote.price != null && volume != null ? quote.price * volume : null;
    return mapUniverseRow(stock, quote, tradingValue, null);
  });
  return rows
    .filter((row) => row.price != null && row.tradingValue != null)
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

function ymdFromUnix(ts) {
  const d = new Date(ts * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function normalizeCandlePeriod(raw) {
  const u = sanitizeStr(raw).toUpperCase();
  if (u === "W" || u === "M") return u;
  return "D";
}

function candleRangeForPeriod(period) {
  const to = unixNow();
  const day = 24 * 60 * 60;
  if (period === "W") return { resolution: "W", from: to - 5 * 365 * day, to };
  if (period === "M") return { resolution: "M", from: to - 15 * 365 * day, to };
  return { resolution: "D", from: to - 2 * 365 * day, to };
}

async function fetchFinnhubCandles(symbol, periodDiv) {
  const p = normalizeCandlePeriod(periodDiv);
  const range = candleRangeForPeriod(p);
  const data = await cached(`candle:${symbol}:${p}`, () =>
    finnhubFetch("/stock/candle", { symbol, ...range })
  );
  if (data?.s && data.s !== "ok") return [];

  const ts = data.t || [];
  const opens = data.o || [];
  const highs = data.h || [];
  const lows = data.l || [];
  const closes = data.c || [];
  const vols = data.v || [];

  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const open = toNum(opens[i]);
    const high = toNum(highs[i]);
    const low = toNum(lows[i]);
    const close = toNum(closes[i]);
    if (open == null || high == null || low == null || close == null) continue;
    const vol = toNum(vols[i]);
    bars.push({
      time: ymdFromUnix(ts[i]),
      open,
      high,
      low,
      close,
      volume: vol != null && vol >= 0 ? vol : 0,
    });
  }
  bars.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return bars.slice(-200);
}

async function fetchLatestDailyVolume(symbol) {
  return cached(`volume:${symbol}`, async () => {
    const candles = await fetchFinnhubCandles(symbol, "D");
    for (let i = candles.length - 1; i >= 0; i--) {
      const vol = toNum(candles[i].volume);
      if (vol != null && vol > 0) return vol;
    }
    return null;
  });
}

function normalizeTicker(raw) {
  const s = sanitizeStr(raw).toUpperCase();
  if (!s || s.length > 12) return "";
  return s.replace(/[^A-Z0-9.^\-]/g, "");
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
      const indices = await fetchIndices();
      json(res, 200, { indices, updatedAt: new Date().toISOString() });
      return;
    }

    if (action === "sectors") {
      const sectors = await fetchSectors();
      json(res, 200, { sectors, updatedAt: new Date().toISOString() });
      return;
    }

    if (action === "gainers") {
      const stocks = await fetchNasdaqGainersTop20();
      json(res, 200, { stocks, updatedAt: new Date().toISOString() });
      return;
    }

    if (action === "volume") {
      const stocks = await fetchNasdaqVolumeTop20();
      json(res, 200, { stocks, updatedAt: new Date().toISOString() });
      return;
    }

    if (action === "candle") {
      const ticker = normalizeTicker(req.query && req.query.ticker);
      if (!ticker) {
        json(res, 400, { error: "Missing or invalid ticker" });
        return;
      }
      const period = normalizeCandlePeriod(req.query && req.query.period);
      const candles = await fetchFinnhubCandles(ticker, period);
      json(res, 200, { ticker, period, candles });
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
