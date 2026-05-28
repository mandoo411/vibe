const KIS_BASE_URL = (process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(/\/+$/, "");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "s-maxage=120, stale-while-revalidate=180");
  res.end(JSON.stringify(body));
}

function toNum(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
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
  return firstNumeric(row, ["nmix_prpr", "NMIX_PRPR", "nmix_nmix_prpr", "NMIX_NMIX_PRPR", "bstp_nmix_prpr", "BSTP_NMIX_PRPR", "stck_prpr", "STCK_PRPR", "prpr_nmix", "prpr"], { allowZero: false });
}

function indexPlausible(code, value) {
  if (!Number.isFinite(value)) return false;
  // 코스피는 환경/지수 기준에 따라 8,000을 초과할 수 있음
  if (code === "0001") return value > 500 && value < 20000;
  if (code === "1001") return value > 300 && value < 4000;
  return true;
}

async function domesticIndex(code, label) {
  let lastError;
  for (const marketCode of ["J", "U"]) {
    try {
      const body = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-index-price", "FHPUP02100000", {
        fid_cond_mrkt_div_code: marketCode,
        fid_input_iscd: code,
      });
      const out = Array.isArray(body.output) ? body.output[0] : body.output;
      const value = indexValue(out);
      if (indexPlausible(code, value)) {
        return {
          id: code,
          label,
          value,
          changePct: firstNumeric(out, ["bstp_nmix_prdy_ctrt", "BSTP_NMIX_PRDY_CTRT", "prdy_ctrt", "nmix_prdy_ctrt"]),
        };
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return { id: code, label, value: null, changePct: null };
}

async function erUsdKrw() {
  const res = await fetch("https://open.er-api.com/v6/latest/USD");
  const body = await res.json();
  return { label: "원/달러", value: toNum(body?.rates?.KRW), changePct: null };
}

async function finnhubQuote(symbol, label) {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) throw new Error("Missing FINNHUB_API_KEY");
  const url = new URL("https://finnhub.io/api/v1/quote");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("token", token);
  const res = await fetch(url);
  const body = await res.json();
  const price = toNum(body?.c);
  const previous = toNum(body?.pc);
  const changePct = price != null && previous ? ((price - previous) / previous) * 100 : null;
  return { label, value: price, changePct };
}

async function yahooQuote(symbol, label) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`);
  const body = await res.json();
  const meta = body?.chart?.result?.[0]?.meta || {};
  const price = toNum(meta.regularMarketPrice);
  const previous = toNum(meta.chartPreviousClose || meta.previousClose);
  const changePct = price != null && previous ? ((price - previous) / previous) * 100 : null;
  return { label, value: price, changePct };
}

async function commodityQuote(finnhubSymbol, yahooSymbol, label) {
  try {
    const quote = await finnhubQuote(finnhubSymbol, label);
    if (quote.value != null && quote.value !== 0) return quote;
  } catch {}
  return yahooQuote(yahooSymbol, label);
}

async function btc() {
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true");
  const body = await res.json();
  return { label: "BTC", value: toNum(body?.bitcoin?.usd), changePct: toNum(body?.bitcoin?.usd_24h_change) };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  const tasks = [
    domesticIndex("0001", "코스피"),
    domesticIndex("1001", "코스닥"),
    erUsdKrw(),
    commodityQuote("OANDA:WTI_USD", "CL=F", "WTI유가"),
    commodityQuote("OANDA:XAU_USD", "GC=F", "금시세"),
    btc(),
  ];
  const settled = await Promise.allSettled(tasks);
  const items = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const labels = ["코스피", "코스닥", "원/달러", "WTI유가", "금시세", "BTC"];
    return { label: labels[index], value: null, changePct: null, error: result.reason?.message || String(result.reason) };
  });
  json(res, 200, { updatedAt: new Date().toISOString(), items });
};
