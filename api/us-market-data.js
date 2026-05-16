/**
 * 미국 주식 시장 데이터 프록시 (Yahoo Finance)
 * GET ?action=indices|sectors|gainers|volume|candle
 */

const YAHOO_BASE_URL = "https://query2.finance.yahoo.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

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

const NASDAQ_EXCHANGES = new Set(["NMS", "NGM", "NCM", "NASDAQ", "Nasdaq", "NasdaqGS", "NasdaqGM"]);

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

async function yahooFetch(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      Cookie: "B=1",
      Referer: "https://finance.yahoo.com",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}: ${text.slice(0, 240)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Yahoo invalid JSON: ${text.slice(0, 120)}`);
  }
}

/** v8 chart — 현재가·전일·등락률·등락포인트 */
async function fetchChartQuote(symbol) {
  const url = `${YAHOO_BASE_URL}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const data = await yahooFetch(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Empty chart: ${symbol}`);

  const meta = result.meta || {};
  let price = toNum(meta.regularMarketPrice);
  let prev = toNum(meta.chartPreviousClose ?? meta.previousClose);

  const closes = result.indicators?.quote?.[0]?.close;
  if (Array.isArray(closes) && closes.length) {
    const valid = closes.filter((c) => c != null && Number.isFinite(c));
    if (valid.length >= 1 && price == null) price = valid[valid.length - 1];
    if (valid.length >= 2 && prev == null) prev = valid[valid.length - 2];
  }

  let changePct = null;
  let changePoints = null;
  if (price != null && prev != null && prev !== 0) {
    changePoints = round2(price - prev);
    changePct = round2(((price - prev) / prev) * 100);
  }

  return {
    symbol,
    price: price != null ? round2(price) : null,
    previousClose: prev != null ? round2(prev) : null,
    changePct,
    changePoints,
  };
}

/** v7 quote — 배치 심볼 */
async function fetchQuoteBatch(symbols) {
  if (!symbols.length) return new Map();
  const url = `${YAHOO_BASE_URL}/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`;
  const data = await yahooFetch(url);
  const list = data?.quoteResponse?.result || [];
  const map = new Map();
  for (const q of list) {
    const sym = sanitizeStr(q.symbol);
    if (!sym) continue;
    const price = toNum(q.regularMarketPrice);
    const prev = toNum(q.regularMarketPreviousClose ?? q.previousClose);
    let changePct = toNum(q.regularMarketChangePercent);
    if (changePct == null && price != null && prev != null && prev !== 0) {
      changePct = round2(((price - prev) / prev) * 100);
    }
    let changePoints = toNum(q.regularMarketChange);
    if (changePoints == null && price != null && prev != null) changePoints = round2(price - prev);
    map.set(sym, {
      symbol: sym,
      price: price != null ? round2(price) : null,
      previousClose: prev != null ? round2(prev) : null,
      changePct,
      changePoints,
    });
  }
  return map;
}

function isNasdaqQuote(q) {
  const ex = sanitizeStr(q.exchange);
  const full = sanitizeStr(q.fullExchangeName);
  if (NASDAQ_EXCHANGES.has(ex)) return true;
  return /nasdaq/i.test(full);
}

function pickDollarVolume(q) {
  const price = toNum(q.regularMarketPrice);
  const vol = toNum(q.regularMarketVolume);
  if (price != null && vol != null) return price * vol;
  return toNum(q.marketCap) || null;
}

async function fetchScreener(scrIds, count = 60) {
  const url = `${YAHOO_BASE_URL}/v1/finance/screener/predefined/saved?scrIds=${encodeURIComponent(scrIds)}&count=${count}`;
  const data = await yahooFetch(url);
  return data?.finance?.result?.[0]?.quotes || [];
}

function mapScreenerRow(q, rank) {
  const ticker = sanitizeStr(q.symbol);
  const name = sanitizeStr(q.shortName || q.longName || ticker);
  const price = round2(toNum(q.regularMarketPrice));
  const changePct = round2(toNum(q.regularMarketChangePercent));
  const dollarVol = pickDollarVolume(q);
  return {
    rank,
    ticker,
    name,
    price,
    changePct,
    tradingValue: dollarVol != null ? Math.round(dollarVol) : null,
  };
}

async function fetchNasdaqGainersTop20() {
  const quotes = await fetchScreener("day_gainers", 80);
  let nasdaq = quotes
    .filter((q) => q && isNasdaqQuote(q))
    .filter((q) => toNum(q.regularMarketChangePercent) != null)
    .sort(
      (a, b) =>
        (toNum(b.regularMarketChangePercent) || 0) - (toNum(a.regularMarketChangePercent) || 0)
    );
  if (nasdaq.length < 10) {
    nasdaq = [...quotes]
      .filter((q) => toNum(q.regularMarketChangePercent) != null)
      .sort(
        (a, b) =>
          (toNum(b.regularMarketChangePercent) || 0) - (toNum(a.regularMarketChangePercent) || 0)
      );
  }
  return nasdaq.slice(0, 20).map((q, i) => mapScreenerRow(q, i + 1));
}

async function fetchNasdaqVolumeTop20() {
  const quotes = await fetchScreener("most_actives", 80);
  let nasdaq = quotes
    .filter((q) => q && isNasdaqQuote(q))
    .sort((a, b) => (pickDollarVolume(b) || 0) - (pickDollarVolume(a) || 0));
  if (nasdaq.length < 10) {
    nasdaq = [...quotes].sort((a, b) => (pickDollarVolume(b) || 0) - (pickDollarVolume(a) || 0));
  }
  return nasdaq.slice(0, 20).map((q, i) => mapScreenerRow(q, i + 1));
}

async function fetchIndices() {
  const items = [];
  for (const idx of US_INDICES) {
    const q = await fetchChartQuote(idx.symbol);
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

function normalizeCandlePeriod(raw) {
  const u = sanitizeStr(raw).toUpperCase();
  if (u === "W" || u === "M") return u;
  return "D";
}

async function fetchYahooCandles(symbol, periodDiv) {
  const p = normalizeCandlePeriod(periodDiv);
  let interval = "1d";
  let range = "2y";
  if (p === "W") {
    interval = "1wk";
    range = "5y";
  } else if (p === "M") {
    interval = "1mo";
    range = "max";
  }
  const url = `${YAHOO_BASE_URL}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const data = await yahooFetch(url);
  const result = data?.chart?.result?.[0];
  if (!result) return [];

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const opens = q.open || [];
  const highs = q.high || [];
  const lows = q.low || [];
  const closes = q.close || [];
  const vols = q.volume || [];

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
      const candles = await fetchYahooCandles(ticker, period);
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
