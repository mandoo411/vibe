const FMP_BASE = "https://financialmodelingprep.com/api/v3";
const FMP_STABLE_BASE = "https://financialmodelingprep.com/stable";
const RANKED_COMPANIES = require("./world-market-ranked.js");

const FMP_TIMEOUT_MS = Math.max(3000, Number(process.env.FMP_TIMEOUT_MS) || 10000);
const QUOTE_CONCURRENCY = 5;

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
  if (/saudi/i.test(text)) return "Saudi Arabia";
  if (/taiwan/i.test(text)) return "Taiwan";
  if (/china/i.test(text)) return "China";
  if (/netherlands/i.test(text)) return "Netherlands";
  if (/germany/i.test(text)) return "Germany";
  if (/denmark/i.test(text)) return "Denmark";
  if (/ireland/i.test(text)) return "Ireland";
  if (/united kingdom/i.test(text)) return "UK";
  return text || "—";
}

function pickSymbol(row) {
  return String(row?.symbol || row?.ticker || "").trim().toUpperCase();
}

async function fetchQuoteOne(symbol) {
  if (!symbol) return null;
  try {
    const rows = await fmpStable("/quote", { symbol });
    if (rows.length) return rows[0];
  } catch (error) {
    if (!/premium|403|429|402/i.test(error.message || "")) throw error;
  }
  try {
    const rows = await fmp(`/quote/${encodeURIComponent(symbol)}`, {});
    if (rows.length) return rows[0];
  } catch (error) {
    if (!/premium|403|429|402/i.test(error.message || "")) throw error;
  }
  return null;
}

async function fetchQuotes(symbols) {
  const unique = [...new Set(symbols.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < unique.length; i += QUOTE_CONCURRENCY) {
    const chunk = unique.slice(i, i + QUOTE_CONCURRENCY);
    const rows = await Promise.all(chunk.map((symbol) => fetchQuoteOne(symbol)));
    chunk.forEach((symbol, index) => {
      const row = rows[index];
      if (row) out.set(symbol, row);
    });
    if (i + QUOTE_CONCURRENCY < unique.length) await sleep(150);
  }
  return out;
}

function marketCapFromQuote(row) {
  const direct = toNum(row.marketCap ?? row.mktCap ?? row.marketCapitalization);
  if (direct != null && direct > 0) return direct;
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
  const q = quote || {};
  const value = symbol ? valueFor(type, q) : null;
  return {
    rank,
    symbol: symbol || "—",
    name: meta.name || q.name || q.companyName || symbol,
    value,
    price: symbol ? toNum(q.price) : null,
    changePct: symbol ? toNum(q.changesPercentage || q.changePercentage) : null,
    country: meta.country || q.country || "",
    countryLabel: countryShort(meta.country || q.country || ""),
    flag: countryFlag(meta.country || q.country || ""),
    logo: symbol ? `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png` : "",
    hasQuote: Boolean(symbol && quote),
  };
}

async function rowsFor(type) {
  const fetchSymbols = RANKED_COMPANIES.map((c) => c.symbol).filter(Boolean);
  const quoteMap = await fetchQuotes(fetchSymbols);

  let rows = RANKED_COMPANIES.map((meta, index) => {
    const symbol = String(meta.symbol || "").trim().toUpperCase();
    const quote = symbol ? quoteMap.get(symbol) : null;
    return buildRow(meta, quote, type, index + 1);
  });

  if (type === "marketCap") {
    return rows;
  }

  rows = rows
    .filter((row) => row.value != null && row.value > 0)
    .sort((a, b) => (b.value || 0) - (a.value || 0))
    .slice(0, 100)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return rows;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
  const type = ["marketCap", "netIncome", "revenue"].includes(req.query?.type) ? req.query.type : "marketCap";
  try {
    const rows = await rowsFor(type);
    const withQuote = rows.filter((row) => row.hasQuote).length;
    const withData = rows.filter((row) => row.hasQuote && row.value != null && row.value > 0).length;
    if (withQuote < 5) {
      throw new Error(`FMP quote 데이터 부족 (${withQuote}건). API 키·플랜을 확인하세요.`);
    }
    send(res, 200, {
      type,
      order: type === "marketCap" ? "ranked" : "value",
      total: rows.length,
      withQuote,
      withData,
      updatedAt: new Date().toISOString(),
      rows,
    });
  } catch (error) {
    send(res, error.statusCode || 500, { error: error.message || String(error), rows: [] });
  }
};
