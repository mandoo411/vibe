const FMP_BASE = "https://financialmodelingprep.com/api/v3";

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
  const key =
    process.env.FMP_API_KEY ||
    process.env.FINANCIAL_MODELING_PREP_API_KEY ||
    process.env.FINANCIALMODELINGPREP_API_KEY ||
    process.env.FMP_KEY;
  if (!key) {
    const error = new Error("Missing FMP API key. Set FMP_API_KEY in Vercel environment variables.");
    error.statusCode = 503;
    throw error;
  }
  const url = new URL(`${FMP_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  url.searchParams.set("apikey", key);
  const res = await fetch(url);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`FMP invalid JSON: ${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    const error = new Error(`FMP HTTP ${res.status}`);
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

async function quoteMap(symbols) {
  if (!symbols.length) return new Map();
  const rows = await fmp(`/quote/${symbols.slice(0, 100).join(",")}`);
  return new Map(rows.map((row) => [pickSymbol(row), row]));
}

async function profileMap(symbols) {
  if (!symbols.length) return new Map();
  const rows = await fmp(`/profile/${symbols.slice(0, 100).join(",")}`);
  return new Map(rows.map((row) => [pickSymbol(row), row]));
}

function valueFor(type, row, quote) {
  if (type === "marketCap") return toNum(row.marketCap || row.marketCapTTM || quote?.marketCap);
  if (type === "netIncome") return toNum(row.netIncome || row.netIncomeTTM || row.growthNetIncome);
  return toNum(row.revenue || row.revenueTTM || row.growthRevenue || row.growthRevenuePerShare);
}

function normalize(type, rows, quotes, profiles) {
  return rows
    .map((row) => {
      const symbol = pickSymbol(row);
      const quote = quotes.get(symbol) || {};
      const profile = profiles.get(symbol) || {};
      return {
        symbol,
        name: row.companyName || row.company || quote.name || profile.companyName || symbol,
        value: valueFor(type, row, quote),
        price: toNum(row.price || quote.price),
        changePct: toNum(row.changesPercentage || row.changePercentage || quote.changesPercentage),
        country: profile.country || row.country || "",
        flag: countryFlag(profile.country || row.country),
        logo: `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`,
      };
    })
    .filter((row) => row.symbol && row.value != null)
    .sort((a, b) => (b.value || 0) - (a.value || 0))
    .slice(0, 100)
    .map((row, index) => ({ rank: index + 1, ...row }));
}

async function rowsFor(type) {
  if (type === "marketCap") {
    const rows = await fmp("/stock-screener", { marketCapMoreThan: "100000000000", limit: "100" });
    const symbols = rows.map(pickSymbol).filter(Boolean);
    const [quotes, profiles] = await Promise.all([quoteMap(symbols), profileMap(symbols)]);
    return normalize(type, rows, quotes, profiles);
  }
  const path = type === "netIncome" ? "/income-statement-growth" : "/financial-growth";
  const rows = await fmp(path, { limit: "100" });
  const symbols = rows.map(pickSymbol).filter(Boolean);
  const [quotes, profiles] = await Promise.all([quoteMap(symbols), profileMap(symbols)]);
  return normalize(type, rows, quotes, profiles);
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
