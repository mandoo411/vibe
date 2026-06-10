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
  { id: "kospi200", symbol: "^KS200", name: "코스피 200", bucket: "korea" },
  { id: "ewy", symbol: "EWY", name: "한국 ETF (EWY)", bucket: "korea", hint: "미국상장·야간 한국 방향성" },
  { id: "sp500", symbol: "^GSPC", name: "S&P 500", bucket: "us" },
  { id: "nasdaq", symbol: "^IXIC", name: "나스닥", bucket: "us" },
  { id: "dow", symbol: "^DJI", name: "다우존스", bucket: "us" },
  { id: "russell", symbol: "^RUT", name: "러셀 2000", bucket: "us" },
  { id: "nasdaq-futures", symbol: "NQ=F", name: "나스닥 선물", bucket: "us" },
  { id: "n225", symbol: "^N225", name: "닛케이 225", bucket: "global", region: "asia" },
  { id: "hsi", symbol: "^HSI", name: "항셍", bucket: "global", region: "asia" },
  { id: "sse", symbol: "000001.SS", name: "상해종합", bucket: "global", region: "asia" },
  { id: "twii", symbol: "^TWII", name: "대만 가권", bucket: "global", region: "asia" },
  { id: "dax", symbol: "^GDAXI", name: "DAX", bucket: "global", region: "europe" },
  { id: "ftse", symbol: "^FTSE", name: "FTSE 100", bucket: "global", region: "europe" },
  { id: "cac", symbol: "^FCHI", name: "CAC 40", bucket: "global", region: "europe" },
  { id: "stoxx50", symbol: "^STOXX50E", name: "유로스톡스 50", bucket: "global", region: "europe" },
  { id: "us10y", symbol: "^TNX", name: "미국 10년물", bucket: "ratesFx", unit: "%", decimals: 2 },
  { id: "us2y", symbol: "2YY=F", name: "미국 2년물", bucket: "ratesFx", unit: "%", decimals: 2 },
  { id: "dxy", symbol: "DX-Y.NYB", name: "달러인덱스", bucket: "ratesFx", decimals: 2 },
  { id: "usdkrw", symbol: "KRW=X", name: "원/달러", bucket: "ratesFx", decimals: 2 },
  { id: "wti", symbol: "CL=F", name: "WTI 원유", bucket: "commodities", commodityGroup: "energy", currency: "USD", decimals: 2 },
  { id: "brent", symbol: "BZ=F", name: "브렌트유", bucket: "commodities", commodityGroup: "energy", currency: "USD", decimals: 2 },
  { id: "natgas", symbol: "NG=F", name: "천연가스", bucket: "commodities", commodityGroup: "energy", currency: "USD", decimals: 3 },
  { id: "gold", symbol: "GC=F", name: "금", bucket: "commodities", commodityGroup: "precious", currency: "USD", decimals: 1 },
  { id: "silver", symbol: "SI=F", name: "은", bucket: "commodities", commodityGroup: "precious", currency: "USD", decimals: 2 },
  { id: "platinum", symbol: "PL=F", name: "백금", bucket: "commodities", commodityGroup: "precious", currency: "USD", decimals: 1 },
  { id: "copper", symbol: "HG=F", name: "구리", bucket: "commodities", commodityGroup: "precious", currency: "USD", decimals: 3, hint: "경기 선행지표" },
  { id: "wheat", symbol: "ZW=F", name: "밀", bucket: "commodities", commodityGroup: "agri", currency: "cents", decimals: 2 },
  { id: "corn", symbol: "ZC=F", name: "옥수수", bucket: "commodities", commodityGroup: "agri", currency: "cents", decimals: 2 },
  { id: "soy", symbol: "ZS=F", name: "대두", bucket: "commodities", commodityGroup: "agri", currency: "cents", decimals: 2 },
  { id: "vix", symbol: "^VIX", name: "VIX", bucket: "sentiment", decimals: 2 },
];

const COMMODITY_VALUE_BANDS = {
  wti: [15, 250],
  brent: [15, 250],
  natgas: [0.5, 30],
  gold: [800, 6000],
  silver: [8, 120],
  platinum: [400, 4000],
  copper: [1.5, 12],
  wheat: [200, 2500],
  corn: [200, 2500],
  soy: [400, 2500],
};

const KOREA_SPARK = [
  { code: "0001", sparkSymbol: "^KS11", id: "kospi", name: "코스피" },
  { code: "1001", sparkSymbol: "^KQ11", id: "kosdaq", name: "코스닥" },
];

const ORDER = {
  korea: ["kospi", "kosdaq", "kospi200", "ewy"],
  us: ["sp500", "nasdaq", "dow", "russell", "nasdaq-futures"],
  asia: ["n225", "hsi", "sse", "twii"],
  europe: ["dax", "ftse", "cac", "stoxx50"],
  ratesFx: ["us10y", "us2y", "dxy", "usdkrw"],
  commodities: ["wti", "brent", "natgas", "gold", "silver", "platinum", "copper", "wheat", "corn", "soy"],
  sentiment: ["vix", "fear-greed", "btc-dominance"],
};

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

function sortBy(order) {
  return (a, b) => order.indexOf(a.id) - order.indexOf(b.id);
}

function compact(items) {
  return (items || []).filter((item) => item && item.value != null);
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
      /* try next */
    }
  }
  let sparkline = [];
  try {
    sparkline = await fetchYahooSparkline(sparkSymbol);
    if (value == null) {
      const q = await fetchYahooQuote(sparkSymbol);
      if (q.value != null) {
        value = roundN(q.value, 2);
        changePct = q.changePct;
      }
    }
  } catch (e) {
    console.warn("[market-overview] korea spark failed", id, sparkSymbol, e?.message || e);
  }
  if (value == null) {
    console.warn("[market-overview] korea index empty", id, code);
    return null;
  }
  return { id, symbol: code, name, value, changePct, sparkline, unit: "pt" };
}

/** 전일 종가 대비 — market-ticker 와 동일 (range=2d, previousClose 우선) */
async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}: ${symbol}`);
  const body = await res.json();
  const meta = body?.chart?.result?.[0]?.meta || {};
  const price = toNum(meta.regularMarketPrice);
  const previous = toNum(meta.previousClose ?? meta.chartPreviousClose);
  let changePct = null;
  if (price != null && previous) changePct = roundN(((price - previous) / previous) * 100, 2);
  else {
    const rmChgPct = toNum(meta.regularMarketChangePercent);
    if (rmChgPct != null && Number.isFinite(rmChgPct)) changePct = roundN(rmChgPct, 2);
  }
  if (symbol === "KRW=X" && changePct != null && Math.abs(changePct) < 0.0001) changePct = null;
  return { value: price != null ? roundN(price, 4) : null, changePct };
}

async function fetchYahooSparkline(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}: ${symbol}`);
  const body = await res.json();
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo empty: ${symbol}`);
  return (result.indicators?.quote?.[0]?.close || []).filter((v) => v != null).map((v) => roundN(v, 4));
}

async function fetchYahooFull(symbol) {
  const [quote, sparkline] = await Promise.all([fetchYahooQuote(symbol), fetchYahooSparkline(symbol)]);
  return { ...quote, sparkline };
}

function yahooToItem(def, chart) {
  const digits = def.decimals ?? (def.unit === "%" ? 2 : 2);
  const value = chart.value != null ? roundN(chart.value, digits) : null;
  if (def.bucket === "commodities" && value != null) {
    const band = COMMODITY_VALUE_BANDS[def.id];
    if (band && (value < band[0] || value > band[1])) {
      console.warn("[market-overview] suspicious commodity value", { id: def.id, symbol: def.symbol, value, expected: band });
    }
  }
  return {
    id: def.id,
    symbol: def.symbol,
    name: def.name,
    region: def.region || null,
    group: def.commodityGroup || null,
    hint: def.hint || null,
    currency: def.currency || null,
    value,
    changePct: chart.changePct,
    sparkline: chart.sparkline,
    unit: def.unit || null,
  };
}

async function fetchYahooDef(def) {
  try {
    const chart = await fetchYahooFull(def.symbol);
    const item = yahooToItem(def, chart);
    if (item.value == null) {
      console.warn("[market-overview] empty quote", def.symbol, def.id);
      return null;
    }
    return item;
  } catch (e) {
    console.warn("[market-overview] fetch failed", def.symbol, def.id, e?.message || e);
    return null;
  }
}

async function fetchFearGreed() {
  const res = await fetch(FEAR_GREED_URL, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`FearGreed HTTP ${res.status}`);
  const body = JSON.parse(text);
  const row = body?.data?.[0];
  const value = row?.value != null ? Math.round(toNum(row.value)) : null;
  if (value == null) return null;
  return {
    id: "fear-greed",
    symbol: "FNG",
    name: "공포·탐욕 지수",
    value,
    changePct: null,
    rating: row?.value_classification ? String(row.value_classification) : null,
    sparkline: [],
    unit: "gauge",
  };
}

async function fetchBtcDominance() {
  const key = String(process.env.CMC_API_KEY || "").trim();
  if (!key) {
    console.warn("[market-overview] missing CMC_API_KEY for btc dominance");
    return null;
  }
  const res = await fetch(`${CMC_BASE_URL}/v1/global-metrics/quotes/latest`, {
    headers: { Accept: "application/json", "X-CMC_PRO_API_KEY": key },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CMC HTTP ${res.status}`);
  const body = JSON.parse(text);
  const dom = roundN(toNum(body?.data?.btc_dominance), 2);
  if (dom == null) return null;
  return {
    id: "btc-dominance",
    symbol: "BTC.D",
    name: "BTC 도미넌스",
    value: dom,
    changePct: null,
    sparkline: [],
    unit: "gauge",
  };
}

async function buildOverview() {
  const yahooResults = await Promise.all(YAHOO_DEFS.map(fetchYahooDef));
  const yahooById = new Map(yahooResults.filter(Boolean).map((item) => [item.id, item]));

  const [koreaKis, fearGreed, btcDominance] = await Promise.all([
    Promise.all(KOREA_SPARK.map(fetchKoreaIndex)),
    fetchFearGreed().catch((e) => {
      console.warn("[market-overview] fear-greed failed", e?.message || e);
      return null;
    }),
    fetchBtcDominance().catch((e) => {
      console.warn("[market-overview] btc dominance failed", e?.message || e);
      return null;
    }),
  ]);

  const korea = compact([...koreaKis, yahooById.get("kospi200"), yahooById.get("ewy")]).sort(sortBy(ORDER.korea));
  const us = compact(ORDER.us.map((id) => yahooById.get(id))).sort(sortBy(ORDER.us));
  const asia = compact(ORDER.asia.map((id) => yahooById.get(id))).sort(sortBy(ORDER.asia));
  const europe = compact(ORDER.europe.map((id) => yahooById.get(id))).sort(sortBy(ORDER.europe));
  const ratesFx = compact(ORDER.ratesFx.map((id) => yahooById.get(id))).sort(sortBy(ORDER.ratesFx));
  const commodities = compact(ORDER.commodities.map((id) => yahooById.get(id))).sort(sortBy(ORDER.commodities));
  const sentiment = compact([yahooById.get("vix"), fearGreed, btcDominance]).sort(sortBy(ORDER.sentiment));

  return {
    updatedAt: new Date().toISOString(),
    sections: { korea, us, global: { asia, europe }, ratesFx, commodities, sentiment },
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
