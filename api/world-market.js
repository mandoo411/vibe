const fs = require("fs");
const path = require("path");
const FMP_BASE = "https://financialmodelingprep.com/api/v3";
const FMP_STABLE_BASE = "https://financialmodelingprep.com/stable";
const RANKED_COMPANIES = require("./world-market-ranked.js");

const CACHE_PATH = path.join(__dirname, "..", "data", "world-market-cache.json");
let fileCache = { at: 0, data: null };

const FMP_TIMEOUT_MS = Math.max(3000, Number(process.env.FMP_TIMEOUT_MS) || 10000);
const QUOTE_CONCURRENCY = 5;
const QUOTE_CACHE_MS = 10 * 60 * 1000;
let quoteCache = { at: 0, map: null };

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("cache-control", "s-maxage=600, stale-while-revalidate=900");
  res.end(JSON.stringify(body));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPremiumError(text) {
  return /premium|subscription|not available under your current/i.test(String(text || ""));
}

async function fmp(path, params = {}) {
  return fmpGet(`${FMP_BASE}${path}`, params);
}

async function fmpStable(path, params = {}) {
  return fmpGet(`${FMP_STABLE_BASE}${path}`, params);
}

async function fmpGet(base, params = {}) {
  const key = String(
    process.env.FMP_API_KEY ||
    process.env.FINANCIAL_MODELING_PREP_API_KEY ||
    process.env.FINANCIALMODELINGPREP_API_KEY ||
    process.env.FMP_KEY ||
    ""
  ).trim();
  if (!key) {
    const error = new Error("Missing FMP API key. Set FMP_API_KEY in Vercel environment variables.");
    error.statusCode = 503;
    throw error;
  }
  const url = new URL(base);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  url.searchParams.set("apikey", key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FMP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error(`FMP timeout ${base}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (isPremiumError(text)) {
    const error = new Error(`FMP premium: ${text.slice(0, 120)}`);
    error.statusCode = 402;
    throw error;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`FMP invalid JSON: ${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    const error = new Error(`FMP HTTP ${res.status}: ${text.slice(0, 180)}`);
    error.statusCode = res.status;
    throw error;
  }
  if (body && typeof body === "object" && !Array.isArray(body) && body["Error Message"]) {
    throw new Error(String(body["Error Message"]).slice(0, 180));
  }
  return Array.isArray(body) ? body : body ? [body] : [];
}

function toNum(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[,$%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function countryFlag(country) {
  const text = String(country || "").toLowerCase();
  if (/united states|usa|us/.test(text)) return "🇺🇸";
  if (/china|hong kong/.test(text)) return "🇨🇳";
  if (/taiwan/.test(text)) return "🇹🇼";
  if (/japan/.test(text)) return "🇯🇵";
  if (/korea/.test(text)) return "🇰🇷";
  if (/saudi/.test(text)) return "🇸🇦";
  if (/netherlands/.test(text)) return "🇳🇱";
  if (/france/.test(text)) return "🇫🇷";
  if (/germany/.test(text)) return "🇩🇪";
  if (/united kingdom|uk|ireland/.test(text)) return "🇬🇧";
  if (/canada/.test(text)) return "🇨🇦";
  if (/switzerland/.test(text)) return "🇨🇭";
  if (/denmark/.test(text)) return "🇩🇰";
  return "🌐";
}

function countryShort(country) {
  const text = String(country || "");
  if (/united states/i.test(text)) return "USA";
  if (/south korea/i.test(text)) return "S. Korea";
  if (/saudi/i.test(text)) return "S. Arabia";
  if (/taiwan/i.test(text)) return "Taiwan";
  if (/china/i.test(text)) return "China";
  if (/japan/i.test(text)) return "Japan";
  if (/netherlands/i.test(text)) return "Netherlands";
  if (/germany/i.test(text)) return "Germany";
  if (/france/i.test(text)) return "France";
  if (/denmark/i.test(text)) return "Denmark";
  if (/ireland/i.test(text)) return "Ireland";
  if (/united kingdom/i.test(text)) return "UK";
  if (/switzerland/i.test(text)) return "Switzerland";
  if (/canada/i.test(text)) return "Canada";
  return text || "—";
}

function quoteSymbolFor(meta) {
  return String(meta.symbol || meta.yahooSymbol || "").trim().toUpperCase();
}

function chartSymbolFor(meta) {
  return String(meta.yahooSymbol || meta.symbol || "").trim().toUpperCase();
}

function isKrwStock(meta) {
  return /\.KS$/i.test(chartSymbolFor(meta));
}

function mergeQuotesForMeta(meta, quoteMap) {
  const qSym = quoteSymbolFor(meta).toUpperCase();
  const chartSym = chartSymbolFor(meta).toUpperCase();
  const primary = qSym ? quoteMap.get(qSym) : null;
  const chart = chartSym && chartSym !== qSym ? quoteMap.get(chartSym) : null;
  if (!primary && !chart) return null;
  const merged = { ...(primary || {}), ...(chart || {}) };
  if (isKrwStock(meta) && chart?.price != null) {
    merged.price = chart.price;
    merged.priceCurrency = "KRW";
    if (chart.changesPercentage != null) merged.changesPercentage = chart.changesPercentage;
    if (chart.sparkline) merged.sparkline = chart.sparkline;
    if (chart.sparkUp != null) merged.sparkUp = chart.sparkUp;
  }
  return merged;
}

function pickSymbol(row) {
  return String(row?.symbol || row?.ticker || "").trim().toUpperCase();
}

function companyLogoUrls(meta, symbol) {
  if (symbol) {
    const fmp = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`;
    return { logo: fmp, logoFallback: "" };
  }
  const yahoo = String(meta.yahooSymbol || "").trim();
  if (yahoo) {
    const cmc = `https://companiesmarketcap.com/img/company-logos/64/${encodeURIComponent(yahoo)}.png`;
    return { logo: cmc, logoFallback: "" };
  }
  return { logo: "", logoFallback: "" };
}

function loadMarketCache() {
  if (fileCache.data && Date.now() - fileCache.at < 60_000) return fileCache.data;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    fileCache = { at: Date.now(), data: raw };
    return raw;
  } catch {
    fileCache = { at: Date.now(), data: { entries: {} } };
    return fileCache.data;
  }
}

function cacheKeyFor(meta, rank) {
  const symbol = String(meta.symbol || "").trim().toUpperCase();
  return symbol || `rank:${rank}`;
}

function cacheEntryFor(meta, rank) {
  return loadMarketCache().entries?.[cacheKeyFor(meta, rank)] || null;
}

function mergeWithCache(meta, quote, rank) {
  const entry = cacheEntryFor(meta, rank);
  const merged = { ...(quote || {}) };
  if (!entry && !quote) return null;
  if (entry?.marketCap != null) merged.marketCap = entry.marketCap;
  if (entry?.netIncome != null) merged.netIncome = entry.netIncome;
  if (entry?.revenue != null) merged.revenue = entry.revenue;
  const livePrice = toNum(merged.price);
  const cachePrice = toNum(entry?.price);
  if (cachePrice != null && (livePrice == null || livePrice === 0) && !isKrwStock(meta)) {
    merged.price = cachePrice;
  }
  const liveChg = toNum(merged.changesPercentage ?? merged.changePercentage);
  const cacheChg = toNum(entry?.changePct);
  const liveChgMissing = liveChg == null || (liveChg === 0 && cacheChg != null && cacheChg !== 0);
  if (cacheChg != null && (liveChgMissing || Math.abs(liveChg) > 25)) {
    merged.changesPercentage = cacheChg;
  }
  return Object.keys(merged).length ? merged : null;
}

function yahooSymbol(symbol) {
  const s = String(symbol || "").trim().toUpperCase();
  if (!s) return s;
  if (/\.(KS|KQ|SR|HK|TW|T|SS|SZ|L|PA|DE|TO|AX|MI|SW|HE|AS|OL|ST|CO|MX|SA|BA|SN|JK|KL|IS|AT|VI|WA|F|BR|MC|LS|AT|VI)$/i.test(s)) {
    return s;
  }
  return s.replace(/\./g, "-");
}

function changePctFromChart(body) {
  const result = body?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta || {};
  const direct = toNum(meta.regularMarketChangePercent);
  if (direct != null) return direct;
  const closes = (result.indicators?.quote?.[0]?.close || []).filter((v) => v != null && Number.isFinite(v));
  if (closes.length >= 2) {
    const prev = closes[closes.length - 2];
    const last = closes[closes.length - 1];
    if (prev > 0) return ((last - prev) / prev) * 100;
  }
  const price = toNum(meta.regularMarketPrice);
  const previous = toNum(meta.previousClose ?? meta.regularMarketPreviousClose);
  if (price != null && previous != null && previous > 0) {
    return ((price - previous) / previous) * 100;
  }
  return null;
}

function sparklineFromChart(body) {
  const result = body?.chart?.result?.[0];
  const closes = (result?.indicators?.quote?.[0]?.close || []).filter((v) => v != null && Number.isFinite(v));
  const points = closes.slice(-30);
  if (points.length < 2) return null;
  return { points, up: points[points.length - 1] >= points[0] };
}

async function fetchYahooChartQuote(symbol) {
  const ySym = yahooSymbol(symbol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FMP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1d&range=1mo`,
      { signal: controller.signal, headers: { "user-agent": "TotalMoneyAI/1.0" } }
    );
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  const meta = body?.chart?.result?.[0]?.meta || {};
  const price = toNum(meta.regularMarketPrice);
  if (price == null) return null;
  const changePct = changePctFromChart(body);
  const spark = sparklineFromChart(body);
  return {
    symbol,
    price,
    changesPercentage: changePct,
    marketCap: toNum(meta.marketCap ?? meta.regularMarketMarketCap),
    name: meta.longName || meta.shortName || symbol,
    sparkline: spark?.points || null,
    sparkUp: spark?.up ?? null,
  };
}

async function fetchYahooSparklineOnly(symbol) {
  const ySym = yahooSymbol(symbol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FMP_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1d&range=1mo`,
      { signal: controller.signal, headers: { "user-agent": "TotalMoneyAI/1.0" } }
    );
    const body = await res.json().catch(() => ({}));
    return sparklineFromChart(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function attachSparklinesForCompanies(quoteMap, companies) {
  const SPARK_CONCURRENCY = 8;
  for (let i = 0; i < companies.length; i += SPARK_CONCURRENCY) {
    const chunk = companies.slice(i, i + SPARK_CONCURRENCY);
    const sparks = await Promise.all(
      chunk.map((meta) => {
        const chartSym = chartSymbolFor(meta);
        return chartSym ? fetchYahooSparklineOnly(chartSym) : Promise.resolve(null);
      })
    );
    chunk.forEach((meta, idx) => {
      const quoteKey = quoteSymbolFor(meta).toUpperCase();
      if (!quoteKey) return;
      const row = quoteMap.get(quoteKey);
      const spark = sparks[idx];
      if (!spark) return;
      if (row) {
        row.sparkline = spark.points;
        row.sparkUp = spark.up;
      } else {
        quoteMap.set(quoteKey, { sparkline: spark.points, sparkUp: spark.up });
      }
    });
    if (i + SPARK_CONCURRENCY < companies.length) await sleep(60);
  }
}

function mapYahooRow(symbol, q) {
  if (!q) return null;
  const price = toNum(q.regularMarketPrice);
  if (price == null) return null;
  return {
    symbol,
    price,
    changesPercentage: toNum(q.regularMarketChangePercent),
    marketCap: toNum(q.marketCap ?? q.regularMarketMarketCap),
    name: q.longName || q.shortName || symbol,
  };
}

async function fetchYahooQuotesBatch(symbols) {
  const out = new Map();
  const CHUNK = 25;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    const listed = chunk.map(yahooSymbol).join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(listed)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FMP_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "TotalMoneyAI/1.0" } });
    } finally {
      clearTimeout(timer);
    }
    const body = await res.json().catch(() => ({}));
    const results = body?.quoteResponse?.result || [];
    const byYahoo = new Map(results.map((q) => [String(q.symbol || "").toUpperCase(), q]));
    for (const symbol of chunk) {
      const row = mapYahooRow(symbol, byYahoo.get(yahooSymbol(symbol)));
      if (row) out.set(symbol.toUpperCase(), row);
    }
    if (i + CHUNK < symbols.length) await sleep(80);
  }
  return out;
}

function hasFmpKey() {
  return Boolean(
    process.env.FMP_API_KEY ||
      process.env.FINANCIAL_MODELING_PREP_API_KEY ||
      process.env.FINANCIALMODELINGPREP_API_KEY ||
      process.env.FMP_KEY
  );
}

async function fetchQuoteOne(symbol) {
  if (!symbol) return null;
  if (hasFmpKey()) {
    const attempts = [
      () => fmp(`/quote/${encodeURIComponent(symbol)}`, {}),
      () => fmpStable("/quote", { symbol }),
    ];
    for (const attempt of attempts) {
      try {
        const rows = await attempt();
        if (rows.length) return rows[0];
      } catch (error) {
        if (!/premium|403|429|402|timeout|missing fmp/i.test(error.message || "")) throw error;
      }
    }
  }
  try {
    return await fetchYahooChartQuote(symbol);
  } catch {
    return null;
  }
}

async function fetchQuotes(symbols) {
  const unique = [...new Set(symbols.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))];
  if (quoteCache.map && Date.now() - quoteCache.at < QUOTE_CACHE_MS) {
    return quoteCache.map;
  }
  const out = new Map();
  for (let i = 0; i < unique.length; i += QUOTE_CONCURRENCY) {
    const chunk = unique.slice(i, i + QUOTE_CONCURRENCY);
    const rows = await Promise.all(chunk.map((symbol) => fetchQuoteOne(symbol)));
    chunk.forEach((symbol, index) => {
      const row = rows[index];
      if (row) out.set(symbol, row);
    });
    if (i + QUOTE_CONCURRENCY < unique.length) await sleep(120);
  }
  try {
    const caps = await fetchYahooQuotesBatch(unique);
    for (const symbol of unique) {
      const row = out.get(symbol);
      const cap = caps.get(symbol);
      if (row && cap) {
        if (cap.marketCap) row.marketCap = cap.marketCap;
        if (cap.changesPercentage != null) row.changesPercentage = cap.changesPercentage;
        if (cap.price != null) row.price = cap.price;
      } else if (!row && cap) {
        out.set(symbol, cap);
      }
    }
  } catch {}
  await attachSparklinesForCompanies(out, RANKED_COMPANIES);
  quoteCache = { at: Date.now(), map: out };
  return out;
}

function marketCapFromQuote(row) {
  const direct = toNum(row.marketCap ?? row.mktCap ?? row.marketCapitalization);
  if (direct != null && direct > 0) return direct;
  if (direct === 0) return null;
  const price = toNum(row.price);
  const shares = toNum(row.sharesOutstanding);
  if (price != null && shares != null && shares > 0) return price * shares;
  return null;
}

function valueFor(type, row) {
  if (type === "marketCap") return marketCapFromQuote(row);
  if (type === "netIncome") {
    const eps = toNum(row.eps);
    const shares = toNum(row.sharesOutstanding);
    if (eps != null && shares != null) return eps * shares;
    const marketCap = toNum(row.marketCap);
    const price = toNum(row.price);
    if (eps != null && marketCap != null && price) return eps * (marketCap / price);
    return toNum(row.netIncome);
  }
  return toNum(row.revenue || row.marketCap);
}

function buildRow(meta, quote, type, rank) {
  const symbol = String(meta.symbol || "").trim().toUpperCase();
  const q = mergeWithCache(meta, quote, rank) || {};
  if (isKrwStock(meta)) q.priceCurrency = "KRW";
  const entry = cacheEntryFor(meta, rank);
  const marketCap = toNum(q.marketCap) ?? toNum(entry?.marketCap);
  const netIncome = toNum(q.netIncome) ?? toNum(entry?.netIncome);
  const revenue = toNum(q.revenue) ?? toNum(entry?.revenue);
  const value =
    type === "marketCap"
      ? marketCap
      : type === "netIncome"
        ? netIncome ?? valueFor(type, q)
        : revenue ?? valueFor(type, q);
  const price = toNum(q.price);
  const changePct = toNum(q.changesPercentage || q.changePercentage);
  const hasLiveOrCache = Boolean(
    (symbol && quote) ||
      price != null ||
      (marketCap != null && marketCap > 0) ||
      (netIncome != null && netIncome > 0) ||
      (revenue != null && revenue > 0)
  );
  return {
    rank,
    symbol: symbol || String(meta.yahooSymbol || "").trim(),
    name: meta.name || q.name || q.companyName || symbol,
    value,
    marketCap,
    netIncome,
    revenue,
    price,
    priceCurrency: q.priceCurrency || (isKrwStock(meta) ? "KRW" : "USD"),
    changePct,
    sparkline: Array.isArray(q.sparkline) ? q.sparkline : null,
    sparkUp: q.sparkUp === true || q.sparkUp === false ? q.sparkUp : null,
    country: meta.country || q.country || "",
    countryLabel: countryShort(meta.country || q.country || ""),
    flag: countryFlag(meta.country || q.country || ""),
    ...companyLogoUrls(meta, symbol),
    hasQuote: hasLiveOrCache,
  };
}

async function rowsFor(type) {
  if (!Array.isArray(RANKED_COMPANIES) || RANKED_COMPANIES.length < 1) {
    throw new Error("world-market-ranked 목록을 불러오지 못했습니다.");
  }
  const fetchSymbols = [
    ...new Set(
      RANKED_COMPANIES.flatMap((c) => [quoteSymbolFor(c), chartSymbolFor(c)].filter(Boolean))
    ),
  ];
  const quoteMap = await fetchQuotes(fetchSymbols);

  let rows = RANKED_COMPANIES.map((meta, index) => {
    const quote = mergeQuotesForMeta(meta, quoteMap);
    return buildRow(meta, quote, type, index + 1);
  });

  rows = sortRowsByValue(rows, type);
  return rows;
}

function sortFieldFor(type) {
  if (type === "netIncome") return "netIncome";
  if (type === "revenue") return "revenue";
  return "marketCap";
}

function metricSortValue(row, field) {
  const primary = row[field];
  if (primary != null && primary > 0) return primary;
  if (field === "marketCap" && row.value != null && row.value > 0) return row.value;
  return 0;
}

function sortRowsByValue(rows, type) {
  const field = sortFieldFor(type);
  return rows
    .sort((a, b) => {
      const av = metricSortValue(a, field);
      const bv = metricSortValue(b, field);
      if (bv !== av) return bv - av;
      return (a.name || "").localeCompare(b.name || "");
    })
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
  const type = ["marketCap", "netIncome", "revenue"].includes(req.query?.type) ? req.query.type : "marketCap";
  try {
    const rows = await rowsFor(type);
    const fetchSymbols = RANKED_COMPANIES.map((c) => c.symbol).filter(Boolean);
    const withQuote = rows.filter((row) => row.hasQuote).length;
    const withData = rows.filter((row) => row.hasQuote && row.value != null && row.value > 0).length;
    const warning =
      withQuote < 5
        ? `FMP quote 일부만 조회됨 (${withQuote}/${rows.length}, 요청 ${fetchSymbols.length}개). 잠시 후 다시 시도하세요.`
        : null;
    const cacheMeta = loadMarketCache();
    send(res, 200, {
      type,
      order: "value",
      total: rows.length,
      withQuote,
      withData,
      warning,
      cacheUpdatedAt: cacheMeta.updatedAt || null,
      updatedAt: new Date().toISOString(),
      rows,
    });
  } catch (error) {
    send(res, error.statusCode || 500, { error: error.message || String(error), rows: [] });
  }
};
