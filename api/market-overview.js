/**
 * 시장 지표 종합 — Yahoo + KIS + Alternative.me + CMC
 * GET /api/market-overview
 */

const KIS_BASE_URL = (process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(/\/+$/, "");
const CMC_BASE_URL = "https://pro-api.coinmarketcap.com";
const FEAR_GREED_URL = "https://api.alternative.me/fng/?limit=1";

const MEMORY_TTL_MS = 2 * 60 * 1000;
let memoryCache = { at: 0, data: null, promise: null };

const YAHOO_DEFS = [
  { id: "n225", symbol: "^N225", name: "닛케이 225", bucket: "global", region: "asia" },
  { id: "hsi", symbol: "^HSI", name: "항셍", bucket: "global", region: "asia" },
  { id: "sse", symbol: "000001.SS", name: "상해종합", bucket: "global", region: "asia" },
  { id: "twii", symbol: "^TWII", name: "대만 가권", bucket: "global", region: "asia" },
  { id: "dax", symbol: "^GDAXI", name: "DAX", bucket: "global", region: "europe" },
  { id: "ftse", symbol: "^FTSE", name: "FTSE 100", bucket: "global", region: "europe" },
  { id: "cac", symbol: "^FCHI", name: "CAC 40", bucket: "global", region: "europe" },
  { id: "stoxx50", symbol: "^STOXX50E", name: "유로스톡스 50", bucket: "global", region: "europe" },
  { id: "sp500", symbol: "^GSPC", name: "S&P 500", bucket: "us" },
  { id: "nasdaq", symbol: "^IXIC", name: "나스닥", bucket: "us" },
  { id: "dow", symbol: "^DJI", name: "다우존스", bucket: "us" },
  { id: "us10y", symbol: "^TNX", name: "미국 10년물", bucket: "ratesFx", unit: "%", decimals: 2 },
  { id: "us2y", symbol: "2YY=F", name: "미국 2년물", bucket: "ratesFx", unit: "%", decimals: 2 },
  { id: "dxy", symbol: "DX-Y.NYB", name: "달러인덱스", bucket: "ratesFx", decimals: 2 },
  { id: "usdkrw", symbol: "KRW=X", name: "원/달러", bucket: "ratesFx", decimals: 2 },
  { id: "wti", symbol: "CL=F", name: "WTI 유가", bucket: "commodities", decimals: 2 },
  { id: "gold", symbol: "GC=F", name: "금", bucket: "commodities", decimals: 1 },
  { id: "silver", symbol: "SI=F", name: "은", bucket: "commodities", decimals: 2 },
  { id: "vix", symbol: "^VIX", name: "VIX", bucket: "sentiment", decimals: 2 },
];

const KOREA_SPARK = [
  { code: "0001", sparkSymbol: "^KS11", id: "kospi", name: "코스피" },
  { code: "1001", sparkSymbol: "^KQ11", id: "kosdaq", name: "코스닥" },
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "s-maxage=120, stale-while-revalidate=180");
  res.end(JSON.stringify(body));
}

function toNum(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function roundN(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function kisGet(path, trId, params) {
  const token = process.env.KIS_ACCESS_TOKEN;
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  if (!token || !appkey || !appsecret) throw new Error("Missing KIS env");
  const url = new URL(path, KIS_BASE_URL);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, value == null ? "" : String(value)));
  const res = await fetch(url, {
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
  const body = JSON.parse(text);
  if (!res.ok || (body.rt_cd && body.rt_cd !== "0")) throw new Error(body.msg1 || `KIS HTTP ${res.status}`);
  return body;
}

function firstNumeric(row, keys, { allowZero = true } = {}) {
  for (const key of keys) {
    const value = toNum(row?.[key]);
    if (value == null) continue;
    if (!allowZero && value === 0) continue;
    return value;
  }
  return null;
}

function indexValue(row) {
  return firstNumeric(
    row,
    ["nmix_prpr", "NMIX_PRPR", "nmix_nmix_prpr", "NMIX_NMIX_PRPR", "bstp_nmix_prpr", "BSTP_NMIX_PRPR", "stck_prpr", "STCK_PRPR"],
    { allowZero: false }
  );
}

function indexPlausible(code, value) {
  if (!Number.isFinite(value)) return false;
  if (code === "0001") return value > 500 && value < 20000;
  if (code === "1001") return value > 300 && value < 4000;
  return true;
}

async function fetchKoreaIndex({ code, sparkSymbol, id, name }) {
  let value = null;
  let changePct = null;
  const marketCodes = code === "0001" ? ["U"] : ["J", "U"];
  for (const marketCode of marketCodes) {
    try {
      const body = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-index-price", "FHPUP02100000", {
        fid_cond_mrkt_div_code: marketCode,
        fid_input_iscd: code,
      });
      const o = body.output ?? body.output1 ?? body.output2;
      const out = Array.isArray(o) ? o[0] : o;
      const v = indexValue(out);
      if (indexPlausible(code, v)) {
        value = roundN(v, 2);
        changePct = roundN(firstNumeric(out, ["bstp_nmix_prdy_ctrt", "BSTP_NMIX_PRDY_CTRT", "prdy_ctrt", "nmix_prdy_ctrt"]), 2);
        break;
      }
    } catch {
      /* try next market code */
    }
  }
  let sparkline = [];
  try {
    const y = await fetchYahooChart(sparkSymbol);
    sparkline = y.sparkline;
    if (value == null && y.value != null) {
      value = roundN(y.value, 2);
      changePct = y.changePct;
    }
  } catch {
    /* sparkline optional */
  }
  return { id, symbol: code, name, value, changePct, sparkline, unit: "pt" };
}

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}: ${symbol}`);
  const body = await res.json();
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo empty: ${symbol}`);
  const meta = result.meta || {};
  const closes = (result.indicators?.quote?.[0]?.close || []).filter((v) => v != null).map((v) => roundN(v, 4));
  const price = toNum(meta.regularMarketPrice);
  const previous = toNum(meta.chartPreviousClose ?? meta.previousClose);
  let changePct = null;
  if (price != null && previous) changePct = roundN(((price - previous) / previous) * 100, 2);
  const rmChgPct = toNum(meta.regularMarketChangePercent);
  if (rmChgPct != null && Number.isFinite(rmChgPct)) changePct = roundN(rmChgPct, 2);
  return { value: price != null ? roundN(price, 4) : null, changePct, sparkline: closes };
}

function yahooToItem(def, chart) {
  const digits = def.decimals ?? (def.unit === "%" ? 2 : def.bucket === "global" && def.region === "asia" ? 2 : 2);
  return {
    id: def.id,
    symbol: def.symbol,
    name: def.name,
    region: def.region || null,
    value: chart.value != null ? roundN(chart.value, digits) : null,
    changePct: chart.changePct,
    sparkline: chart.sparkline,
    unit: def.unit || null,
  };
}

async function fetchFearGreed() {
  const res = await fetch(FEAR_GREED_URL, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`FearGreed HTTP ${res.status}`);
  const body = JSON.parse(text);
  const row = body?.data?.[0];
  return {
    id: "fear-greed",
    symbol: "FNG",
    name: "공포·탐욕 지수",
    value: row?.value != null ? Math.round(toNum(row.value)) : null,
    changePct: null,
    rating: row?.value_classification ? String(row.value_classification) : null,
    sparkline: [],
    unit: "pt",
  };
}

async function fetchBtcDominance() {
  const key = String(process.env.CMC_API_KEY || "").trim();
  if (!key) {
    return {
      id: "btc-dominance",
      symbol: "BTC.D",
      name: "BTC 도미넌스",
      value: null,
      changePct: null,
      sparkline: [],
      unit: "%",
    };
  }
  const res = await fetch(`${CMC_BASE_URL}/v1/global-metrics/quotes/latest`, {
    headers: { Accept: "application/json", "X-CMC_PRO_API_KEY": key },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CMC HTTP ${res.status}`);
  const body = JSON.parse(text);
  const dom = roundN(toNum(body?.data?.btc_dominance), 2);
  return {
    id: "btc-dominance",
    symbol: "BTC.D",
    name: "BTC 도미넌스",
    value: dom,
    changePct: null,
    sparkline: [],
    unit: "%",
  };
}

async function buildOverview() {
  const [koreaRows, yahooCharts, fearGreed, btcDominance] = await Promise.all([
    Promise.all(KOREA_SPARK.map(fetchKoreaIndex)),
    Promise.all(
      YAHOO_DEFS.map(async (def) => {
        try {
          const chart = await fetchYahooChart(def.symbol);
          return { def, chart, error: null };
        } catch (e) {
          return { def, chart: { value: null, changePct: null, sparkline: [] }, error: e?.message || String(e) };
        }
      })
    ),
    fetchFearGreed().catch(() => ({
      id: "fear-greed",
      symbol: "FNG",
      name: "공포·탐욕 지수",
      value: null,
      changePct: null,
      rating: null,
      sparkline: [],
      unit: "pt",
    })),
    fetchBtcDominance().catch(() => ({
      id: "btc-dominance",
      symbol: "BTC.D",
      name: "BTC 도미넌스",
      value: null,
      changePct: null,
      sparkline: [],
      unit: "%",
    })),
  ]);

  const byBucket = { us: [], global: [], ratesFx: [], commodities: [], sentiment: [] };
  for (const { def, chart } of yahooCharts) {
    const item = yahooToItem(def, chart);
    if (byBucket[def.bucket]) byBucket[def.bucket].push(item);
  }

  const asiaOrder = ["n225", "hsi", "sse", "twii"];
  const europeOrder = ["dax", "ftse", "cac", "stoxx50"];
  const sortBy = (order) => (a, b) => order.indexOf(a.id) - order.indexOf(b.id);
  byBucket.global.sort((a, b) => {
    const ai = asiaOrder.indexOf(a.id);
    const bi = asiaOrder.indexOf(b.id);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return europeOrder.indexOf(a.id) - europeOrder.indexOf(b.id);
  });
  byBucket.us.sort(sortBy(["sp500", "nasdaq", "dow"]));
  byBucket.sentiment.push(fearGreed, btcDominance);

  return {
    updatedAt: new Date().toISOString(),
    sections: {
      korea: koreaRows,
      us: byBucket.us,
      global: byBucket.global,
      ratesFx: byBucket.ratesFx,
      commodities: byBucket.commodities,
      sentiment: byBucket.sentiment,
    },
  };
}

async function getOverview() {
  const now = Date.now();
  if (memoryCache.data && now - memoryCache.at < MEMORY_TTL_MS) return memoryCache.data;
  if (memoryCache.promise) return memoryCache.promise;
  memoryCache.promise = buildOverview()
    .then((data) => {
      memoryCache = { at: Date.now(), data, promise: null };
      return data;
    })
    .catch((e) => {
      memoryCache.promise = null;
      throw e;
    });
  return memoryCache.promise;
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
  try {
    json(res, 200, await getOverview());
  } catch (e) {
    console.error("[market-overview]", e?.message || e);
    json(res, 500, { error: e?.message || "Internal error" });
  }
};
