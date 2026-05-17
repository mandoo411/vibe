/**
 * 암호화폐 시장 데이터 프록시 (CoinMarketCap + Alternative.me Fear & Greed)
 * GET ?action=global|listings|fear-greed
 */

const CMC_BASE_URL = "https://pro-api.coinmarketcap.com";
const FEAR_GREED_URL = "https://api.alternative.me/fng/?limit=1";
const CACHE_TTL_MS = 5 * 60 * 1000;

const memoryCache = new Map();

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
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

function requireCmcKey() {
  const key = sanitizeStr(process.env.CMC_API_KEY);
  if (!key) throw new Error("Missing CMC_API_KEY");
  return key;
}

function cmcUrl(path, params = {}) {
  const url = new URL(path, CMC_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
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

async function cmcFetch(path, params) {
  const res = await fetch(cmcUrl(path, params), {
    headers: {
      Accept: "application/json",
      "X-CMC_PRO_API_KEY": requireCmcKey(),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CMC HTTP ${res.status}: ${text.slice(0, 240)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`CMC invalid JSON: ${text.slice(0, 120)}`);
  }
}

async function fetchGlobal() {
  return cached("global", async () => {
    const data = await cmcFetch("/v1/global-metrics/quotes/latest", { convert: "KRW" });
    const d = data && data.data ? data.data : {};
    const quote = d.quote && d.quote.KRW ? d.quote.KRW : {};
    return {
      btcDominance: round2(toNum(d.btc_dominance)),
      totalMarketCap: Math.round(toNum(quote.total_market_cap) || 0) || null,
      volume24h: Math.round(toNum(quote.total_volume_24h) || 0) || null,
      updatedAt: new Date().toISOString(),
    };
  });
}

async function fetchListings() {
  return cached("listings", async () => {
    const data = await cmcFetch("/v1/cryptocurrency/listings/latest", {
      limit: 100,
      convert: "KRW",
    });
    const rows = Array.isArray(data.data) ? data.data : [];
    return {
      coins: rows.map((coin, i) => {
        const quote = coin.quote && coin.quote.KRW ? coin.quote.KRW : {};
        return {
          rank: toNum(coin.cmc_rank) || i + 1,
          id: toNum(coin.id),
          name: sanitizeStr(coin.name),
          symbol: sanitizeStr(coin.symbol),
          price: round2(toNum(quote.price)),
          change1h: round2(toNum(quote.percent_change_1h)),
          change24h: round2(toNum(quote.percent_change_24h)),
          change7d: round2(toNum(quote.percent_change_7d)),
          marketCap: Math.round(toNum(quote.market_cap) || 0) || null,
          volume24h: Math.round(toNum(quote.volume_24h) || 0) || null,
        };
      }),
      updatedAt: new Date().toISOString(),
    };
  });
}

function normalizeFearGreed(data) {
  const source = data && Array.isArray(data.data) ? data.data[0] : null;
  const score = toNum(source && source.value);
  const rating = sanitizeStr(source && source.value_classification);
  return {
    score: score == null ? null : Math.round(score),
    rating,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchFearGreed() {
  return cached("fear-greed", async () => {
    const res = await fetch(FEAR_GREED_URL, { headers: { Accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) throw new Error(`FearGreed HTTP ${res.status}: ${text.slice(0, 240)}`);
    try {
      return normalizeFearGreed(JSON.parse(text));
    } catch {
      throw new Error(`FearGreed invalid JSON: ${text.slice(0, 120)}`);
    }
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

  const action = sanitizeStr(req.query && req.query.action) || "global";
  try {
    if (action === "global") {
      json(res, 200, await fetchGlobal());
      return;
    }
    if (action === "listings") {
      json(res, 200, await fetchListings());
      return;
    }
    if (action === "fear-greed") {
      json(res, 200, await fetchFearGreed());
      return;
    }
    json(res, 400, { error: "Unknown action. Use global, listings, or fear-greed." });
  } catch (e) {
    console.error("[crypto-data]", action, e && e.message, e);
    json(res, 502, { error: e.message || String(e) });
  }
};
