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
    const [krwData, usdData] = await Promise.all([
      cmcFetch("/v1/global-metrics/quotes/latest", { convert: "KRW" }),
      cmcFetch("/v1/global-metrics/quotes/latest", { convert: "USD" }),
    ]);
    const d = krwData && krwData.data ? krwData.data : {};
    const usdSource = usdData && usdData.data ? usdData.data : {};
    const krw = d.quote && d.quote.KRW ? d.quote.KRW : {};
    const usd = usdSource.quote && usdSource.quote.USD ? usdSource.quote.USD : {};
    const totalMarketCapKrw = Math.round(toNum(krw.total_market_cap) || 0) || null;
    const volume24hKrw = Math.round(toNum(krw.total_volume_24h) || 0) || null;
    const totalMarketCapUsd = Math.round(toNum(usd.total_market_cap) || 0) || null;
    const volume24hUsd = Math.round(toNum(usd.total_volume_24h) || 0) || null;
    return {
      btcDominance: round2(toNum(d.btc_dominance)),
      totalMarketCap: totalMarketCapKrw,
      volume24h: volume24hKrw,
      totalMarketCapKrw,
      volume24hKrw,
      totalMarketCapUsd,
      volume24hUsd,
      updatedAt: new Date().toISOString(),
    };
  });
}

function pickSparkline(coin, quote) {
  const candidates = [
    coin && coin.sparkline_7d,
    coin && coin.sparkline,
    quote && quote.sparkline_7d,
    quote && quote.sparkline,
  ];
  for (const raw of candidates) {
    if (Array.isArray(raw) && raw.length >= 2) {
      return raw.map((v) => toNum(v)).filter((v) => v != null && Number.isFinite(v));
    }
    if (raw && typeof raw === "object" && Array.isArray(raw.price)) {
      return raw.price.map((v) => toNum(v)).filter((v) => v != null && Number.isFinite(v));
    }
  }
  return null;
}

function syntheticSparkline(price, change1h, change24h, change7d) {
  if (price == null || !Number.isFinite(price)) return null;
  const now = price;
  const p7 = change7d != null ? price / (1 + change7d / 100) : null;
  const p24 = change24h != null ? price / (1 + change24h / 100) : null;
  const p1h = change1h != null ? price / (1 + change1h / 100) : null;
  const anchors = [
    { i: 0, v: p7 },
    { i: 3, v: p24 ?? p7 },
    { i: 5, v: p1h ?? p24 ?? p7 },
    { i: 6, v: now },
  ].filter((a) => a.v != null && Number.isFinite(a.v));
  if (anchors.length < 2) return null;
  const out = new Array(7).fill(null);
  for (let a = 0; a < anchors.length; a++) {
    const cur = anchors[a];
    const next = anchors[a + 1];
    out[cur.i] = cur.v;
    if (!next) continue;
    const span = next.i - cur.i;
    for (let k = 1; k < span; k++) {
      const t = k / span;
      out[cur.i + k] = cur.v + (next.v - cur.v) * t;
    }
  }
  if (out[6] == null) out[6] = now;
  return out.every((v) => v != null) ? out : null;
}

async function fetchListings() {
  return cached("listings", async () => {
    const params = {
      limit: 100,
      aux: "cmc_rank,max_supply,circulating_supply,total_supply",
    };
    const [krwData, usdData] = await Promise.all([
      cmcFetch("/v1/cryptocurrency/listings/latest", { ...params, convert: "KRW" }),
      cmcFetch("/v1/cryptocurrency/listings/latest", { ...params, convert: "USD" }),
    ]);
    const rows = Array.isArray(krwData.data) ? krwData.data : [];
    const usdById = new Map(
      (Array.isArray(usdData.data) ? usdData.data : []).map((coin) => [String(coin.id), coin])
    );
    return {
      coins: rows.map((coin, i) => {
        const krw = coin.quote && coin.quote.KRW ? coin.quote.KRW : {};
        const usdCoin = usdById.get(String(coin.id)) || {};
        const usd = usdCoin.quote && usdCoin.quote.USD ? usdCoin.quote.USD : {};
        const priceKrw = round2(toNum(krw.price));
        const priceUsd = toNum(usd.price);
        const marketCapKrw = Math.round(toNum(krw.market_cap) || 0) || null;
        const marketCapUsd = Math.round(toNum(usd.market_cap) || 0) || null;
        const volume24hKrw = Math.round(toNum(krw.volume_24h) || 0) || null;
        const maxSupply = toNum(coin.max_supply);
        let fdvKrw = Math.round(toNum(krw.fully_diluted_market_cap) || 0) || null;
        let fdvUsd =
          Math.round(toNum(usd.fully_diluted_market_cap) || toNum(coin.fully_diluted_market_cap) || 0) || null;
        if (!fdvUsd && maxSupply != null && priceUsd != null) fdvUsd = Math.round(maxSupply * priceUsd);
        if (!fdvKrw && maxSupply != null && priceKrw != null) fdvKrw = Math.round(maxSupply * priceKrw);
        const sparkline =
          pickSparkline(coin, usd) ||
          pickSparkline(coin, krw) ||
          syntheticSparkline(priceUsd ?? priceKrw, toNum(usd.percent_change_1h ?? krw.percent_change_1h), toNum(usd.percent_change_24h ?? krw.percent_change_24h), toNum(usd.percent_change_7d ?? krw.percent_change_7d));
        return {
          rank: toNum(coin.cmc_rank) || i + 1,
          id: toNum(coin.id),
          name: sanitizeStr(coin.name),
          symbol: sanitizeStr(coin.symbol),
          price: priceKrw,
          priceKrw,
          priceUsd,
          change1h: round2(toNum(krw.percent_change_1h ?? usd.percent_change_1h)),
          change24h: round2(toNum(krw.percent_change_24h ?? usd.percent_change_24h)),
          change7d: round2(toNum(krw.percent_change_7d ?? usd.percent_change_7d)),
          marketCap: marketCapKrw,
          marketCapKrw,
          marketCapUsd,
          fullyDilutedMarketCap: fdvKrw,
          fullyDilutedMarketCapKrw: fdvKrw,
          fullyDilutedMarketCapUsd: fdvUsd,
          fdv: fdvKrw,
          fdvKrw,
          fdvUsd,
          maxSupply,
          volume24h: volume24hKrw,
          volume24hKrw,
          volume24hUsd: Math.round(toNum(usd.volume_24h) || 0) || null,
          sparkline_7d: sparkline,
          priceHistory7d: sparkline,
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
