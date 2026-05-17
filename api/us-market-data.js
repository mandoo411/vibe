/**
 * 미국 주식 시장 데이터 프록시 (KIS Open API)
 * GET ?action=indices|sectors|market-cap|gainers|volume|candle
 */

const KIS_BASE_URL = (process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(
  /\/+$/,
  ""
);
const CACHE_TTL_MS = 5 * 60 * 1000;

const OVERSEAS_PRICE_PATH = "/uapi/overseas-price/v1/quotations/price";
const OVERSEAS_PRICE_TR_ID = "HHDFS00000300";
const OVERSEAS_INDEX_PRICE_PATH = "/uapi/overseas-price/v1/quotations/price-detail";
const OVERSEAS_INDEX_PRICE_TR_ID = "HHDFS76200200";
const MARKET_CAP_PATH = "/uapi/overseas-stock/v1/ranking/market-cap";
const MARKET_CAP_TR_ID = "HHDFS76350100";
const UPDOWN_RATE_PATH = "/uapi/overseas-stock/v1/ranking/updown-rate";
const UPDOWN_RATE_TR_ID = "HHDFS76290000";
const TRADE_PBMN_PATH = "/uapi/overseas-stock/v1/ranking/trade-pbmn";
const TRADE_PBMN_TR_ID = "HHDFS76320010";
const US_RANKING_CURRENCY = "0";

const US_INDICES = [
  { id: "nasdaq", name: "나스닥", symbol: "NDX", cnbcSymbol: ".NDX", source: "cnbc" },
  { id: "sp500", name: "S&P 500", symbol: "SPX", exchange: "NYS", cnbcSymbol: ".SPX" },
  { id: "nasdaq-futures", name: "나스닥 선물", symbol: "NQ", cnbcSymbol: "@ND.1", source: "cnbc" },
];

const US_SECTORS = [
  { symbol: "XLK", exchange: "AMS", name: "기술", label: "XLK" },
  { symbol: "XLF", exchange: "AMS", name: "금융", label: "XLF" },
  { symbol: "XLE", exchange: "AMS", name: "에너지", label: "XLE" },
  { symbol: "XLV", exchange: "AMS", name: "바이오/헬스", label: "XLV" },
  { symbol: "XLI", exchange: "AMS", name: "산업재", label: "XLI" },
  { symbol: "XLP", exchange: "AMS", name: "소비재", label: "XLP" },
  { symbol: "XLB", exchange: "AMS", name: "소재", label: "XLB" },
  { symbol: "XLU", exchange: "AMS", name: "유틸리티", label: "XLU" },
];

const EXCHANGES = ["NAS", "NYS"];
const memoryCache = new Map();

function isKisTokenError(body) {
  if (!body || typeof body !== "object") return false;
  if (body.msg_cd === "EGW00121") return true;
  const blob = `${body.msg1 || ""} ${body.message || ""} ${body.msg_cd || ""}`;
  return /EGW00121|기간이 만료|기간 만료|토큰|token/i.test(String(blob));
}

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

function requireKisAuth() {
  const token = sanitizeStr(process.env.KIS_ACCESS_TOKEN);
  const appkey = sanitizeStr(process.env.KIS_APP_KEY);
  const appsecret = sanitizeStr(process.env.KIS_APP_SECRET);
  if (!token) throw new Error("Missing KIS_ACCESS_TOKEN");
  if (!appkey || !appsecret) throw new Error("Missing KIS_APP_KEY or KIS_APP_SECRET");
  return { token, appkey, appsecret };
}

function pickFirst(row, keys) {
  if (!row || typeof row !== "object") return "";
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim() !== "") return value;
  }
  return "";
}

function pickNumberByPattern(row, pattern, excludePattern) {
  if (!row || typeof row !== "object") return null;
  for (const key of Object.keys(row)) {
    if (!pattern.test(key)) continue;
    if (excludePattern && excludePattern.test(key)) continue;
    const value = toNum(row[key]);
    if (value != null) return value;
  }
  return null;
}

function outputRows(body, preferred) {
  if (!body || typeof body !== "object") return [];
  if (preferred && Array.isArray(body[preferred])) return body[preferred];
  for (const key of ["output", "output1", "output2", "OUTPUT", "Output"]) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

function outputObject(body, preferred) {
  if (!body || typeof body !== "object") return {};
  const value = preferred ? body[preferred] : null;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  for (const key of ["output", "output1", "output2", "OUTPUT", "Output"]) {
    const v = body[key];
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
    if (Array.isArray(v) && v[0] && typeof v[0] === "object") return v[0];
  }
  return {};
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
  if (isKisTokenError(body)) {
    throw new Error("KIS_ACCESS_TOKEN expired or invalid (EGW00121). Refresh the deployed KIS_ACCESS_TOKEN value.");
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

function normalizeTicker(raw) {
  const s = sanitizeStr(raw).toUpperCase();
  if (!s || s.length > 16) return "";
  return s.replace(/[^A-Z0-9.^-]/g, "");
}

function normalizePeriod(raw) {
  const p = sanitizeStr(raw).toUpperCase();
  return p === "W" || p === "M" ? p : "D";
}

function mapRankRow(row, rank) {
  const ticker = sanitizeStr(pickFirst(row, ["symb", "SYMB", "ovrs_pdno", "OVRS_PDNO", "rsym", "RSYM"]));
  const name = sanitizeStr(pickFirst(row, ["name", "NAME", "ovrs_item_name", "OVRS_ITEM_NAME"])) || ticker;
  const price = round2(toNum(pickFirst(row, ["last", "LAST", "ovrs_nmix_prpr", "OVRS_NMIX_PRPR", "stck_prpr", "STCK_PRPR"])));
  const changePct = round2(toNum(pickFirst(row, ["rate", "RATE", "prdy_ctrt", "PRDY_CTRT"])));
  const volume = toNum(pickFirst(row, ["tvol", "TVOL", "acml_vol", "ACML_VOL", "volume", "VOLUME"]));
  const marketCap = toNum(pickFirst(row, ["tomv", "TOMV", "mket_avls", "MKET_AVLS"]));
  const directTradingValue = toNum(
    pickFirst(row, [
      "tamt",
      "TAMT",
      "tr_pbmn",
      "TR_PBMN",
      "acml_tr_pbmn",
      "ACML_TR_PBMN",
      "hts_acml_tr_pbmn",
      "HTS_ACML_TR_PBMN",
      "ovrs_stck_tr_pbmn",
      "OVRS_STCK_TR_PBMN",
      "tradingValue",
      "TRADING_VALUE",
    ])
  );
  const patternTradingValue =
    directTradingValue ??
    pickNumberByPattern(row, /pbmn|tamt|trading.*value|trade.*value|amount/i, /tomv|mket|market|cap|avls/i);
  const tradingValue =
    patternTradingValue != null ? patternTradingValue : price != null && volume != null ? price * volume : null;
  const rawRank = toNum(pickFirst(row, ["rank", "RANK"]));
  return {
    rank: rawRank != null ? Math.round(rawRank) : rank,
    ticker,
    name,
    price,
    changePct,
    volume: volume != null ? Math.round(volume) : null,
    marketCap: marketCap != null ? Math.round(marketCap) : null,
    tradingValue: tradingValue != null ? Math.round(tradingValue) : null,
  };
}

async function fetchOverseasQuote({ symbol, exchange }) {
  const body = await kisGet(OVERSEAS_PRICE_PATH, OVERSEAS_PRICE_TR_ID, {
    AUTH: "",
    EXCD: exchange,
    SYMB: symbol,
  });
  const out = outputObject(body);
  return {
    symbol,
    exchange,
    price: round2(toNum(pickFirst(out, ["last", "LAST", "ovrs_nmix_prpr", "OVRS_NMIX_PRPR", "stck_prpr", "STCK_PRPR"]))),
    changePct: round2(toNum(pickFirst(out, ["rate", "RATE", "prdy_ctrt", "PRDY_CTRT"]))),
    changePoints: round2(toNum(pickFirst(out, ["diff", "DIFF", "prdy_vrss", "PRDY_VRSS"]))),
  };
}

async function fetchOverseasIndexQuote({ symbol, exchange }) {
  const body = await kisGet(OVERSEAS_INDEX_PRICE_PATH, OVERSEAS_INDEX_PRICE_TR_ID, {
    AUTH: "",
    EXCD: exchange,
    SYMB: symbol,
  });
  const out = outputObject(body);
  return {
    symbol,
    exchange,
    price: round2(toNum(pickFirst(out, ["ovrs_nmix_prpr", "OVRS_NMIX_PRPR", "stck_prpr", "STCK_PRPR", "bstp_nmix_prpr", "BSTP_NMIX_PRPR", "last", "LAST"]))),
    changePct: round2(toNum(pickFirst(out, ["prdy_ctrt", "PRDY_CTRT", "ovrs_nmix_prdy_ctrt", "OVRS_NMIX_PRDY_CTRT", "bstp_nmix_prdy_ctrt", "BSTP_NMIX_PRDY_CTRT", "rate", "RATE"]))),
    changePoints: round2(toNum(pickFirst(out, ["ovrs_nmix_prdy_vrss", "OVRS_NMIX_PRDY_VRSS", "prdy_vrss", "PRDY_VRSS", "bstp_nmix_prdy_vrss", "BSTP_NMIX_PRDY_VRSS", "diff", "DIFF"]))),
  };
}

async function fetchCnbcIndexQuotes() {
  const symbols = US_INDICES.map((idx) => idx.cnbcSymbol).filter(Boolean).join("|");
  const url = `https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols=${encodeURIComponent(symbols)}&output=json`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`CNBC HTTP ${res.status}`);
  const body = await res.json();
  const quotes = body && body.QuickQuoteResult && body.QuickQuoteResult.QuickQuote;
  const rows = Array.isArray(quotes) ? quotes : quotes ? [quotes] : [];
  const map = new Map();
  for (const row of rows) {
    const symbol = sanitizeStr(row.symbol);
    const price = round2(toNum(row.last));
    if (!symbol || price == null) continue;
    map.set(symbol, {
      price,
      changePct: round2(toNum(row.change_pct)),
      changePoints: round2(toNum(row.change)),
    });
  }
  return map;
}

async function fetchIndices() {
  return cached("indices", async () => {
    const items = [];
    let cnbcQuotes = null;
    for (const idx of US_INDICES) {
      const quote =
        idx.source === "cnbc"
          ? { price: null, changePct: null, changePoints: null }
          : await fetchOverseasIndexQuote(idx);
      if (quote.price == null || idx.source === "cnbc") {
        cnbcQuotes = cnbcQuotes || (await fetchCnbcIndexQuotes());
      }
      const fallback = cnbcQuotes ? cnbcQuotes.get(idx.cnbcSymbol) : null;
      items.push({
        id: idx.id,
        name: idx.name,
        symbol: idx.symbol,
        price: quote.price ?? (fallback && fallback.price) ?? null,
        changePct: quote.changePct ?? (fallback && fallback.changePct) ?? null,
        changePoints: quote.changePoints ?? (fallback && fallback.changePoints) ?? null,
      });
    }
    return items;
  });
}

async function fetchSectors() {
  return cached("sectors", async () => {
    const sectors = [];
    for (const sector of US_SECTORS) {
      const quote = await fetchOverseasQuote(sector);
      sectors.push({
        symbol: sector.symbol,
        name: sector.name,
        label: sector.label,
        changePct: quote.changePct,
        price: quote.price,
      });
    }
    return sectors;
  });
}

async function fetchMergedRanking(cacheKey, path, trId, params, sortKey) {
  return cached(cacheKey, async () => {
    const all = [];
    for (const exchange of EXCHANGES) {
      const body = await kisGet(path, trId, params(exchange));
      const rows = outputRows(body, "output2").map((row, i) => ({
        ...mapRankRow(row, all.length + i + 1),
        exchange,
      }));
      all.push(...rows);
    }
    return all
      .filter((row) => row.ticker && row.price != null && row[sortKey] != null)
      .sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0))
      .slice(0, 50)
      .map((row, i) => ({ ...row, rank: i + 1 }));
  });
}

function fetchMarketCapTop50() {
  return fetchMergedRanking(
    "ranking:market-cap",
    MARKET_CAP_PATH,
    MARKET_CAP_TR_ID,
    (exchange) => ({
      AUTH: "",
      CURR_GB: US_RANKING_CURRENCY,
      EXCD: exchange,
      KEYB: "",
      VOL_RANG: "0",
    }),
    "marketCap"
  );
}

function fetchGainersTop50() {
  return fetchMergedRanking(
    "ranking:gainers",
    UPDOWN_RATE_PATH,
    UPDOWN_RATE_TR_ID,
    (exchange) => ({
      AUTH: "",
      CURR_GB: US_RANKING_CURRENCY,
      EXCD: exchange,
      GUBN: "1",
      KEYB: "",
      NDAY: "0",
      VOL_RANG: "0",
    }),
    "changePct"
  );
}

function fetchTradeValueTop50() {
  return fetchMergedRanking(
    "ranking:trade-value",
    TRADE_PBMN_PATH,
    TRADE_PBMN_TR_ID,
    (exchange) => ({
      AUTH: "",
      CURR_GB: US_RANKING_CURRENCY,
      EXCD: exchange,
      KEYB: "",
      NDAY: "0",
      PRC1: "",
      PRC2: "",
      VOL_RANG: "0",
    }),
    "tradingValue"
  );
}

function findCachedRankRow(ticker) {
  const keys = ["ranking:market-cap", "ranking:gainers", "ranking:trade-value"];
  for (const key of keys) {
    const hit = memoryCache.get(key);
    if (!hit || !Array.isArray(hit.value) || hit.expiresAt <= Date.now()) continue;
    const row = hit.value.find((r) => r.ticker === ticker);
    if (row) return row;
  }
  return null;
}

function fetchPseudoCandles(ticker) {
  const row = findCachedRankRow(ticker);
  if (!row || row.price == null) return [];
  const price = row.price;
  const change = row.changePct == null ? 0 : row.changePct / 100;
  const prev = change === -1 ? price : price / (1 + change);
  const high = Math.max(price, prev);
  const low = Math.min(price, prev);
  const today = new Date();
  return [
    {
      time: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`,
      open: round2(prev),
      high: round2(high),
      low: round2(low),
      close: round2(price),
      volume: row.volume || 0,
    },
  ];
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
    if (action === "market-cap") {
      const payload = await cachedPayload("market-cap", async () => ({ stocks: await fetchMarketCapTop50() }));
      json(res, 200, payload);
      return;
    }
    if (action === "gainers") {
      const payload = await cachedPayload("gainers", async () => ({ stocks: await fetchGainersTop50() }));
      json(res, 200, payload);
      return;
    }
    if (action === "volume") {
      const payload = await cachedPayload("volume", async () => ({ stocks: await fetchTradeValueTop50() }));
      json(res, 200, payload);
      return;
    }
    if (action === "candle") {
      const ticker = normalizeTicker(req.query && req.query.ticker);
      if (!ticker) {
        json(res, 400, { error: "Missing or invalid ticker" });
        return;
      }
      const period = normalizePeriod(req.query && req.query.period);
      const payload = await cachedPayload(`candle:${ticker}:${period}`, async () => ({
        ticker,
        period,
        candles: await fetchPseudoCandles(ticker),
      }));
      json(res, 200, payload);
      return;
    }

    json(res, 400, {
      error: "Unknown action. Use indices, sectors, market-cap, gainers, volume, or candle.",
    });
  } catch (e) {
    console.error("[us-market-data]", action, e && e.message, e);
    json(res, 502, { error: e.message || String(e) });
  }
};
