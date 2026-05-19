const FMP_BASE = "https://financialmodelingprep.com/api/v3";
const FMP_STABLE_BASE = "https://financialmodelingprep.com/stable";
const TOP_SYMBOLS = [
  "NVDA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "BRK-B",
  "JPM", "V", "JNJ", "WMT", "XOM", "MA", "PG", "HD", "CVX", "MRK",
  "ABBV", "BAC", "KO", "PEP", "AVGO", "COST", "TMO", "MCD", "CSCO",
  "ACN", "LIN", "DHR", "TXN", "NEE", "PM", "UNH", "RTX", "HON",
  "QCOM", "IBM", "AMGN", "LOW", "INTU", "SBUX", "GE", "CAT", "BA",
  "AMD", "INTC", "CRM", "NOW", "PLTR", "TSMC", "TSM", "ASML", "SAP",
  "005930.KS", "000660.KS", "035420.KS",
];

const FMP_TIMEOUT_MS = Math.max(3000, Number(process.env.FMP_TIMEOUT_MS) || 12000);

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("cache-control", "s-maxage=300, stale-while-revalidate=600");
  res.end(JSON.stringify(body));
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
    if (error && error.name === "AbortError") throw new Error(`FMP timeout ${path}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
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
  return Array.isArray(body) ? body : [];
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
  if (/netherlands/.test(text)) return "🇳🇱";
  if (/france/.test(text)) return "🇫🇷";
  if (/germany/.test(text)) return "🇩🇪";
  if (/united kingdom|uk/.test(text)) return "🇬🇧";
  if (/canada/.test(text)) return "🇨🇦";
  if (/switzerland/.test(text)) return "🇨🇭";
  return "🌐";
}

function pickSymbol(row) {
  return String(row?.symbol || row?.ticker || "").trim().toUpperCase();
}

function uniqueSymbols(symbols) {
  return [...new Set(symbols.map((symbol) => String(symbol || "").trim().toUpperCase()).filter(Boolean))];
}

async function fetchQuotes(symbols) {
  const out = [];
  const unique = uniqueSymbols(symbols);
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    if (!chunk.length) continue;
    try {
      out.push(...(await fmpStable("/quote", { symbol: chunk.join(",") })));
    } catch (error) {
      if (!/FMP HTTP 403|FMP HTTP 429/.test(error.message || "")) throw error;
      for (const symbol of chunk) {
        try {
          out.push(...(await fmpStable("/quote", { symbol })));
        } catch (_) {
          // 무료 플랜에서 막히는 심볼은 건너뛰고 가능한 종목만 표시한다.
        }
      }
    }
  }
  return out;
}

function valueFor(type, row) {
  if (type === "marketCap") return toNum(row.marketCap);
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

function normalize(type, rows) {
  return rows
    .map((row) => {
      const symbol = pickSymbol(row);
      return {
        symbol,
        name: row.name || row.companyName || row.company || symbol,
        value: valueFor(type, row),
        price: toNum(row.price),
        changePct: toNum(row.changesPercentage || row.changePercentage),
        country: row.country || "",
        flag: countryFlag(row.country),
        logo: `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`,
      };
    })
    .filter((row) => row.symbol && row.value != null)
    .sort((a, b) => (b.value || 0) - (a.value || 0))
    .slice(0, 100)
    .map((row, index) => ({ rank: index + 1, ...row }));
}

async function rowsFor(type) {
  const quoteRows = await fetchQuotes(TOP_SYMBOLS);
  const bySymbol = new Map();
  for (const row of quoteRows) {
    const symbol = pickSymbol(row);
    if (!symbol) continue;
    bySymbol.set(symbol, { ...(bySymbol.get(symbol) || {}), ...row, symbol });
  }
  return normalize(type, [...bySymbol.values()]);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
  const type = ["marketCap", "netIncome", "revenue"].includes(req.query?.type) ? req.query.type : "marketCap";
  try {
    const rows = await rowsFor(type);
    send(res, 200, { type, updatedAt: new Date().toISOString(), rows });
  } catch (error) {
    send(res, error.statusCode || 500, { error: error.message || String(error), rows: [] });
  }
};
