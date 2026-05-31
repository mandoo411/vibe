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
  if (code === "0001") return value > 500 && value < 20000;
  if (code === "1001") return value > 300 && value < 4000;
  return true;
}

async function domesticIndex(code, label) {
  let lastError;
  const marketCodes = code === "0001" ? ["U"] : ["J", "U"];
  for (const marketCode of marketCodes) {
    try {
      const body = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-index-price", "FHPUP02100000", {
        fid_cond_mrkt_div_code: marketCode,
        fid_input_iscd: code,
      });
      const o = body.output ?? body.output1 ?? body.output2;
      const out = Array.isArray(o) ? o[0] : o;
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
  return { id: "usdkrw", label: "원/달러", value: toNum(body?.rates?.KRW), changePct: null };
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
  return { id: symbol, label, value: price, changePct };
}

async function yahooQuote(symbol, label) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`);
  const body = await res.json();
  const meta = body?.chart?.result?.[0]?.meta || {};
  const price = toNum(meta.regularMarketPrice);
  const previous = toNum(meta.chartPreviousClose || meta.previousClose);
  const changePct = price != null && previous ? ((price - previous) / previous) * 100 : null;
  return { id: symbol, label, value: price, changePct };
}

async function commodityQuote(finnhubSymbol, yahooSymbol, label) {
  try {
    const quote = await finnhubQuote(finnhubSymbol, label);
    if (quote.value != null && quote.value !== 0) return quote;
  } catch {}
  return yahooQuote(yahooSymbol, label);
}

async function geckoQuote(geckoId, label) {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(geckoId)}&vs_currencies=usd&include_24hr_change=true`
  );
  if (!res.ok) throw new Error(`Gecko HTTP ${res.status}`);
  const body = await res.json();
  const row = body?.[geckoId] || {};
  return { label, value: toNum(row.usd), changePct: toNum(row.usd_24h_change) };
}

async function cryptoUsdQuote(geckoId, yahooSymbol, label) {
  try {
    const q = await geckoQuote(geckoId, label);
    if (q.value != null) return q;
  } catch (_) {}
  try {
    return await yahooQuote(yahooSymbol, label);
  } catch (_) {}
  return { label, value: null, changePct: null };
}

async function btc() {
  return cryptoUsdQuote("bitcoin", "BTC-USD", "비트코인");
}

async function naverStockBasic(code6, label) {
  const code = String(code6 || "").replace(/\D/g, "").padStart(6, "0");
  const res = await fetch(`https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/basic`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`NAVER stock HTTP ${res.status}`);
  const body = await res.json();
  const price = toNum(body?.closePrice ?? body?.overMarketPriceInfo?.overPrice);
  return {
    id: code,
    label: label || body?.stockName || code,
    value: price,
    changePct: toNum(body?.fluctuationsRatio),
  };
}

function settledValue(result) {
  if (result.status === "fulfilled") return result.value;
  return { value: null, changePct: null, error: result.reason?.message || String(result.reason) };
}

function quoteItem(result, fallbackLabel) {
  if (result.status === "fulfilled") return result.value;
  return { label: fallbackLabel, value: null, changePct: null, error: result.reason?.message || String(result.reason) };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });

  const tasks = [
    domesticIndex("0001", "코스피"),
    domesticIndex("1001", "코스닥"),
    yahooQuote("NQ=F", "나스닥선물"),
    erUsdKrw(),
    commodityQuote("OANDA:WTI_USD", "CL=F", "WTI유가"),
    commodityQuote("OANDA:XAU_USD", "GC=F", "금시세"),
    btc(),
    yahooQuote("^GSPC", "S&P500"),
    yahooQuote("^IXIC", "NASDAQ"),
    naverStockBasic("005930", "삼성전자"),
    naverStockBasic("000660", "SK하이닉스"),
    naverStockBasic("005380", "현대차"),
    yahooQuote("NVDA", "NVDA"),
    yahooQuote("AAPL", "AAPL"),
    yahooQuote("GOOG", "GOOG"),
    cryptoUsdQuote("ethereum", "ETH-USD", "Ethereum"),
    cryptoUsdQuote("ripple", "XRP-USD", "XRP"),
  ];

  const settled = await Promise.allSettled(tasks);
  const tickerLabels = ["코스피", "코스닥", "나스닥선물", "원/달러", "WTI유가", "금시세", "비트코인"];
  const items = settled.slice(0, 7).map((result, index) => {
    const row = quoteItem(result, tickerLabels[index]);
    return { ...row, label: tickerLabels[index] };
  });

  const kospi = settledValue(settled[0]);
  const kosdaq = settledValue(settled[1]);
  const nqFut = settledValue(settled[2]);
  const btcItem = settledValue(settled[6]);
  const sp500 = settledValue(settled[7]);
  const nasdaq = settledValue(settled[8]);
  const samsung = settledValue(settled[9]);
  const skhynix = settledValue(settled[10]);
  const hyundai = settledValue(settled[11]);
  const nvda = settledValue(settled[12]);
  const aapl = settledValue(settled[13]);
  const goog = settledValue(settled[14]);
  const eth = settledValue(settled[15]);
  const xrp = settledValue(settled[16]);

  json(res, 200, {
    updatedAt: new Date().toISOString(),
    items,
    hub: {
      kospi: { label: "코스피", value: kospi.value, changePct: kospi.changePct },
      kosdaq: { label: "코스닥", value: kosdaq.value, changePct: kosdaq.changePct },
      nasdaqFutures: { label: "나스닥선물", value: nqFut.value, changePct: nqFut.changePct },
      sp500: { label: "S&P500", value: sp500.value, changePct: sp500.changePct },
      nasdaq: { label: "NASDAQ", value: nasdaq.value, changePct: nasdaq.changePct },
      samsung: { label: "삼성전자", value: samsung.value, changePct: samsung.changePct },
      skhynix: { label: "SK하이닉스", value: skhynix.value, changePct: skhynix.changePct },
      hyundai: { label: "현대차", value: hyundai.value, changePct: hyundai.changePct },
      nvda: { label: "NVDA", value: nvda.value, changePct: nvda.changePct },
      aapl: { label: "AAPL", value: aapl.value, changePct: aapl.changePct },
      goog: { label: "GOOG", value: goog.value, changePct: goog.changePct },
      btc: { label: "BTC", value: btcItem.value, changePct: btcItem.changePct },
      eth: { label: "ETH", value: eth.value, changePct: eth.changePct },
      xrp: { label: "XRP", value: xrp.value, changePct: xrp.changePct },
    },
  });
};
