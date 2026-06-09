/**
 * 미국 주식 시장 데이터 프록시 (KIS Open API)
 * GET ?action=indices|sectors|market-cap|gainers|volume|candle
 */

const KIS_BASE_URL = (process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(
  /\/+$/,
  ""
);
const CACHE_TTL_MS = 5 * 60 * 1000;

const OVERSEAS_PRICE_PATH = "/uapi/overseas-price/v1/quotations/price";
const OVERSEAS_PRICE_TR_ID = "HHDFS00000300";
const OVERSEAS_INDEX_PRICE_PATH = "/uapi/overseas-price/v1/quotations/price-detail";
const OVERSEAS_INDEX_PRICE_TR_ID = "HHDFS76200200";
const OVERSEAS_DETAIL_PATH = OVERSEAS_INDEX_PRICE_PATH;
const OVERSEAS_DETAIL_TR_ID = OVERSEAS_INDEX_PRICE_TR_ID;
const MARKET_CAP_PATH = "/uapi/overseas-stock/v1/ranking/market-cap";
const MARKET_CAP_TR_ID = "HHDFS76350100";
const UPDOWN_RATE_PATH = "/uapi/overseas-stock/v1/ranking/updown-rate";
const UPDOWN_RATE_TR_ID = "HHDFS76290000";
const TRADE_PBMN_PATH = "/uapi/overseas-stock/v1/ranking/trade-pbmn";
const TRADE_PBMN_TR_ID = "HHDFS76320010";
const US_RANKING_CURRENCY = "0";

const US_INDICES = [
  { id: "nasdaq", name: "나스닥", symbol: "NDX", yahoo: "^NDX", cnbcSymbol: ".NDX", source: "cnbc" },
  { id: "sp500", name: "S&P 500", symbol: "SPX", exchange: "NYS", yahoo: "^GSPC", cnbcSymbol: ".SPX", source: "kis" },
  { id: "nasdaq-futures", name: "나스닥 선물", symbol: "NQ", yahoo: "NQ=F", cnbcSymbol: "@ND.1", source: "cnbc" },
];

const US_SECTORS = [
  { symbol: "XLK", exchange: "AMS", name: "기술", label: "XLK", yahoo: "XLK" },
  { symbol: "XLF", exchange: "AMS", name: "금융", label: "XLF", yahoo: "XLF" },
  { symbol: "XLE", exchange: "AMS", name: "에너지", label: "XLE", yahoo: "XLE" },
  { symbol: "XLV", exchange: "AMS", name: "바이오/헬스", label: "XLV", yahoo: "XLV" },
  { symbol: "XLI", exchange: "AMS", name: "산업재", label: "XLI", yahoo: "XLI" },
  { symbol: "XLP", exchange: "AMS", name: "소비재", label: "XLP", yahoo: "XLP" },
  { symbol: "XLB", exchange: "AMS", name: "소재", label: "XLB", yahoo: "XLB" },
  { symbol: "XLU", exchange: "AMS", name: "유틸리티", label: "XLU", yahoo: "XLU" },
];

const EXCHANGES = ["NAS", "NYS"];
const memoryCache = new Map();

const KO_SEARCH_ALIASES = new Map([
  ["리게티", "Rigetti"],
  ["리게티컴퓨팅", "Rigetti"],
  ["리게티 컴퓨팅", "Rigetti"],
  ["아이온큐", "IonQ"],
  ["아이온 큐", "IonQ"],
  ["엔비디아", "NVIDIA"],
  ["애플", "Apple"],
  ["마이크로소프트", "Microsoft"],
  ["아마존", "Amazon"],
  ["구글", "Alphabet"],
  ["알파벳", "Alphabet"],
  ["메타", "Meta"],
  ["테슬라", "Tesla"],
  ["팔란티어", "Palantir"],
  ["코인베이스", "Coinbase"],
]);

function isKisTokenError(body) {
  if (!body || typeof body !== "object") return false;
  if (body.msg_cd === "EGW00121") return true;
  const blob = `${body.msg1 || ""} ${body.message || ""} ${body.msg_cd || ""}`;
  return /EGW00121|기간이 만료|기간 만료|토큰|token/i.test(String(blob));
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNum(v) {
  if (v === "" || v == null) return null;
  if (typeof v === "string") {
    const s = v.trim().replace(/%/g, "").replace(/,/g, "").replace(/\s/g, "").replace(/^\+/, "");
    if (s === "" || s === "-" || s === ".") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
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

function requireKisAuth() {
  const token = sanitizeStr(process.env.KIS_ACCESS_TOKEN);
  const appkey = sanitizeStr(process.env.KIS_APP_KEY);
  const appsecret = sanitizeStr(process.env.KIS_APP_SECRET);
  if (!token) throw new Error("Missing KIS_ACCESS_TOKEN");
  if (!appkey || !appsecret) throw new Error("Missing KIS_APP_KEY or KIS_APP_SECRET");
  return { token, appkey, appsecret };
}

function pickFirst(row, keys) {
  if (!row || typeof row !== "object") return "";
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim() !== "") return value;
  }
  return "";
}

function pickNumberByPattern(row, pattern, excludePattern) {
  if (!row || typeof row !== "object") return null;
  for (const key of Object.keys(row)) {
    if (!pattern.test(key)) continue;
    if (excludePattern && excludePattern.test(key)) continue;
    const value = toNum(row[key]);
    if (value != null) return value;
  }
  return null;
}

function outputRows(body, preferred) {
  if (!body || typeof body !== "object") return [];
  if (preferred && Array.isArray(body[preferred])) return body[preferred];
  for (const key of ["output", "output1", "output2", "OUTPUT", "Output"]) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

function outputObject(body, preferred) {
  if (!body || typeof body !== "object") return {};
  const value = preferred ? body[preferred] : null;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  for (const key of ["output", "output1", "output2", "OUTPUT", "Output"]) {
    const v = body[key];
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
    if (Array.isArray(v) && v[0] && typeof v[0] === "object") return v[0];
  }
  return {};
}

async function kisGet(path, trId, params) {
  const { token, appkey, appsecret } = requireKisAuth();
  const url = new URL(path, KIS_BASE_URL);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value == null ? "" : String(value));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
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
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`KIS invalid JSON HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  if (isKisTokenError(body)) {
    throw new Error("KIS_ACCESS_TOKEN expired or invalid (EGW00121). Refresh the deployed KIS_ACCESS_TOKEN value.");
  }
  if (!res.ok) throw new Error(`KIS HTTP ${res.status}: ${text.slice(0, 240)}`);
  if (body.rt_cd && body.rt_cd !== "0") {
    throw new Error(`KIS rt_cd=${body.rt_cd} msg=${body.msg1 || body.msg_cd || ""}`);
  }
  return body;
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

function normalizeTicker(raw) {
  const s = sanitizeStr(raw).toUpperCase();
  if (!s || s.length > 16) return "";
  return s.replace(/[^A-Z0-9.^-]/g, "");
}

function normalizePeriod(raw) {
  const p = sanitizeStr(raw).toUpperCase();
  return p === "W" || p === "M" ? p : "D";
}

function normalizeUsTickerFromRow(row) {
  let ticker = sanitizeStr(pickFirst(row, ["symb", "SYMB", "ovrs_pdno", "OVRS_PDNO"]));
  if (ticker) return ticker;
  const rsym = sanitizeStr(pickFirst(row, ["rsym", "RSYM"]));
  if (!rsym) return "";
  const stripped = rsym.replace(/^D(NYS|NAS|AMS)/i, "");
  return stripped || rsym;
}

function applyUsRateSign(rate, row) {
  if (rate == null || !Number.isFinite(rate)) return null;
  const sign = sanitizeStr(pickFirst(row, ["sign", "SIGN"]));
  // KIS: 1=상한 2=상승 3=보합 4=하한 5=하락
  if (sign === "4" || sign === "5") return round2(-Math.abs(rate));
  if (sign === "1" || sign === "2") return round2(Math.abs(rate));
  if (sign === "3") return 0;
  return rate;
}

function parseRankingChangePct(row, price) {
  const direct = applyUsRateSign(
    round2(toNum(pickFirst(row, ["rate", "RATE", "prdy_ctrt", "PRDY_CTRT"]))),
    row
  );
  if (direct != null) return direct;

  const prev = round2(
    toNum(pickFirst(row, ["base", "BASE", "prdy_clpr", "PRDY_CLPR", "ovrs_prdy_clpr", "OVRS_PRDY_CLPR"]))
  );
  if (price != null && prev != null && prev !== 0) {
    return round2(((price - prev) / prev) * 100);
  }

  const diff = round2(toNum(pickFirst(row, ["diff", "DIFF", "prdy_vrss", "PRDY_VRSS"])));
  if (price != null && diff != null) {
    const prevFromDiff = price - diff;
    if (prevFromDiff !== 0) return round2((diff / prevFromDiff) * 100);
  }
  return null;
}

function computeTradingValue(price, volume) {
  if (price == null || volume == null || !Number.isFinite(price) || !Number.isFinite(volume)) return null;
  return Math.round(price * volume);
}

function resolveChangePoints(row, price, changePct) {
  const prev = round2(
    toNum(
      pickFirst(row, [
        "prdy_clpr",
        "PRDY_CLPR",
        "ovrs_prdy_clpr",
        "OVRS_PRDY_CLPR",
        "base",
        "BASE",
        "ovrs_stck_prdy_clpr",
        "OVRS_STCK_PRDY_CLPR",
      ])
    )
  );
  if (price != null && prev != null) {
    return round2(price - prev);
  }
  if (price != null && changePct != null && Number.isFinite(changePct)) {
    const prevFromPct = price / (1 + changePct / 100);
    return round2(price - prevFromPct);
  }
  const raw = round2(
    toNum(
      pickFirst(row, [
        "diff",
        "DIFF",
        "prdy_vrss",
        "PRDY_VRSS",
        "ovrs_stck_prdy_vrss",
        "OVRS_STCK_PRDY_VRSS",
        "change",
        "CHANGE",
      ])
    )
  );
  if (raw == null) return null;
  if (changePct == null || changePct === 0) return raw;
  if (changePct < 0 && raw > 0) return round2(-Math.abs(raw));
  if (changePct > 0 && raw < 0) return round2(Math.abs(raw));
  return raw;
}

function pickUsVolume(detail, price) {
  const tvol = toNum(pickFirst(detail, ["tvol", "TVOL", "acml_vol", "ACML_VOL", "volume", "VOLUME"]));
  const pvol = toNum(pickFirst(detail, ["pvol", "PVOL"]));
  const priceVol = price ? toNum(pickFirst(price, ["tvol", "TVOL", "acml_vol", "ACML_VOL", "volume", "VOLUME"])) : null;
  const pricePvol = price ? toNum(pickFirst(price, ["pvol", "PVOL"])) : null;
  const tvolMax = Math.max(...[tvol, priceVol].filter((n) => n != null && n > 0), 0) || null;
  const pvolMax = Math.max(...[pvol, pricePvol].filter((n) => n != null && n > 0), 0) || null;
  // 장 시작·프리마켓 직후 tvol은 당일 누적만 반영되어 전일 pvol 대비 극소일 수 있음
  if (tvolMax != null && pvolMax != null && tvolMax < pvolMax * 0.05) {
    return Math.round(pvolMax);
  }
  const candidates = [tvolMax, pvolMax].filter((n) => n != null && n > 0);
  if (!candidates.length) return null;
  return Math.round(Math.max(...candidates));
}

function pickUsTradingValue(detail, price, currentPrice, volume) {
  const tamt = toNum(pickFirst(detail, ["tamt", "TAMT"]));
  const pamt = toNum(pickFirst(detail, ["pamt", "PAMT"]));
  const priceAmt = price ? toNum(pickFirst(price, ["tamt", "TAMT"])) : null;
  const candidates = [tamt, pamt, priceAmt].filter((n) => n != null && n > 0);
  if (candidates.length) return Math.round(Math.max(...candidates));
  if (currentPrice != null && volume != null) return Math.round(currentPrice * volume);
  return null;
}

function kisSymbolVariants(ticker) {
  const t = sanitizeStr(ticker).toUpperCase();
  if (!t) return [];
  const variants = new Set([t]);
  for (const v of [...variants]) {
    if (v.includes("/")) {
      variants.add(v.replace(/\//g, "."));
      variants.add(v.replace(/\//g, "-"));
    }
    if (v.includes(".")) {
      variants.add(v.replace(/\./g, "/"));
      variants.add(v.replace(/\./g, "-"));
    }
    if (v.includes("-")) {
      variants.add(v.replace(/-/g, "/"));
      variants.add(v.replace(/-/g, "."));
    }
  }
  const classShare = t.match(/^([A-Z]{2,})([AB])$/);
  if (classShare) {
    const base = classShare[1];
    const cls = classShare[2];
    variants.add(`${base}/${cls}`);
    variants.add(`${base}.${cls}`);
    variants.add(`${base}-${cls}`);
  }
  return [...variants];
}

async function fetchUsPriceDetail(exchange, symb) {
  const [priceBody, detailBody] = await Promise.all([
    kisGet(OVERSEAS_PRICE_PATH, OVERSEAS_PRICE_TR_ID, { AUTH: "", EXCD: exchange, SYMB: symb }),
    kisGet(OVERSEAS_DETAIL_PATH, OVERSEAS_DETAIL_TR_ID, { AUTH: "", EXCD: exchange, SYMB: symb }),
  ]);
  const p = outputObject(priceBody);
  const d = outputObject(detailBody);
  const price = round2(
    toNum(pickFirst(p, ["last", "LAST", "stck_prpr", "STCK_PRPR"])) ||
      toNum(pickFirst(d, ["last", "LAST", "ovrs_nmix_prpr", "OVRS_NMIX_PRPR", "stck_prpr", "STCK_PRPR"]))
  );
  if (price == null) return null;
  return { p, d, price, exchange };
}

function mapRankRow(row, rank) {
  const ticker = normalizeUsTickerFromRow(row);
  const name = sanitizeStr(pickFirst(row, ["name", "NAME", "ovrs_item_name", "OVRS_ITEM_NAME"])) || ticker;
  const price = round2(toNum(pickFirst(row, ["last", "LAST", "ovrs_nmix_prpr", "OVRS_NMIX_PRPR", "stck_prpr", "STCK_PRPR"])));
  const changePct = parseRankingChangePct(row, price);
  const changePoints = resolveChangePoints(row, price, changePct);
  const volume = pickUsVolume(row, null);
  const marketCap = toNum(pickFirst(row, ["tomv", "TOMV", "mket_avls", "MKET_AVLS"]));
  const tradingValue = pickUsTradingValue(row, null, price, volume) ?? computeTradingValue(price, volume);
  const rawRank = toNum(pickFirst(row, ["rank", "RANK"]));
  return {
    rank: rawRank != null ? Math.round(rawRank) : rank,
    ticker,
    name,
    price,
    changePct,
    changePoints,
    volume: volume != null ? Math.round(volume) : null,
    marketCap: marketCap != null ? Math.round(marketCap) : null,
    tradingValue: tradingValue != null ? Math.round(tradingValue) : null,
  };
}

function parseOverseasChangePct(out) {
  if (!out || typeof out !== "object") return null;
  const fromField = round2(
    toNum(
      pickFirst(out, [
        "rate",
        "RATE",
        "prdy_ctrt",
        "PRDY_CTRT",
        "ovrs_prdy_ctrt",
        "OVRS_PRDY_CTRT",
        "ovrs_stck_prdy_ctrt",
        "OVRS_STCK_PRDY_CTRT",
        "fltt_rt",
        "FLTT_RT",
        "chgrate",
        "CHGRATE",
      ])
    )
  );
  if (fromField != null && fromField !== 0) return fromField;

  const fromPattern = round2(
    pickNumberByPattern(out, /prdy_ctrt|ctrt|chgrate|change.*pct|rate/i, /prpr|last|vol|amt|diff/i)
  );
  if (fromPattern != null && fromPattern !== 0) return fromPattern;

  const price = round2(
    toNum(pickFirst(out, ["last", "LAST", "ovrs_nmix_prpr", "OVRS_NMIX_PRPR", "stck_prpr", "STCK_PRPR"]))
  );
  const prev = round2(
    toNum(
      pickFirst(out, [
        "prdy_clpr",
        "PRDY_CLPR",
        "ovrs_prdy_clpr",
        "OVRS_PRDY_CLPR",
        "base",
        "BASE",
        "ovrs_stck_prdy_clpr",
        "OVRS_STCK_PRDY_CLPR",
      ])
    )
  );
  if (price != null && prev != null && prev !== 0) {
    return round2(((price - prev) / prev) * 100);
  }
  return fromField === 0 ? null : fromField;
}

async function fetchOverseasQuote({ symbol, exchange, yahoo }) {
  const body = await kisGet(OVERSEAS_PRICE_PATH, OVERSEAS_PRICE_TR_ID, {
    AUTH: "",
    EXCD: exchange,
    SYMB: symbol,
  });
  const out = outputObject(body);
  let price = round2(
    toNum(pickFirst(out, ["last", "LAST", "ovrs_nmix_prpr", "OVRS_NMIX_PRPR", "stck_prpr", "STCK_PRPR"]))
  );
  let changePct = parseOverseasChangePct(out);
  let changePoints = resolveChangePoints(out, price, changePct);

  if (changePct == null && yahoo) {
    try {
      const yq = await fetchYahooIndexQuote(yahoo);
      if (yq.changePct != null) {
        changePct = yq.changePct;
        if (price == null) price = yq.price;
        if (changePoints == null) changePoints = yq.changePoints;
        console.log("[us-market-data] Yahoo ETF fallback", symbol, { changePct, price });
      }
    } catch (e) {
      console.warn("[us-market-data] Yahoo ETF", symbol, e && e.message);
    }
  }

  if (changePct == null) {
    console.log(
      "[us-market-data] overseas quote missing changePct",
      symbol,
      exchange,
      JSON.stringify(out).slice(0, 600)
    );
  }

  return {
    symbol,
    exchange,
    price,
    changePct,
    changePoints,
  };
}

async function fetchOverseasIndexQuote({ symbol, exchange }) {
  const body = await kisGet(OVERSEAS_INDEX_PRICE_PATH, OVERSEAS_INDEX_PRICE_TR_ID, {
    AUTH: "",
    EXCD: exchange,
    SYMB: symbol,
  });
  const out = outputObject(body);
  return {
    symbol,
    exchange,
    price: round2(toNum(pickFirst(out, ["ovrs_nmix_prpr", "OVRS_NMIX_PRPR", "stck_prpr", "STCK_PRPR", "bstp_nmix_prpr", "BSTP_NMIX_PRPR", "last", "LAST"]))),
    changePct: round2(toNum(pickFirst(out, ["prdy_ctrt", "PRDY_CTRT", "ovrs_nmix_prdy_ctrt", "OVRS_NMIX_PRDY_CTRT", "bstp_nmix_prdy_ctrt", "BSTP_NMIX_PRDY_CTRT", "rate", "RATE"]))),
    changePoints: round2(toNum(pickFirst(out, ["ovrs_nmix_prdy_vrss", "OVRS_NMIX_PRDY_VRSS", "prdy_vrss", "PRDY_VRSS", "bstp_nmix_prdy_vrss", "BSTP_NMIX_PRDY_VRSS", "diff", "DIFF"]))),
  };
}

async function fetchCnbcIndexQuotes() {
  const symbols = US_INDICES.map((idx) => idx.cnbcSymbol).filter(Boolean).join("|");
  const url = `https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols=${encodeURIComponent(symbols)}&output=json`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`CNBC HTTP ${res.status}`);
  const body = await res.json();
  const quotes = body && body.QuickQuoteResult && body.QuickQuoteResult.QuickQuote;
  const rows = Array.isArray(quotes) ? quotes : quotes ? [quotes] : [];
  const map = new Map();
  for (const row of rows) {
    const symbol = sanitizeStr(row.symbol);
    const price = round2(toNum(row.last));
    if (!symbol || price == null) continue;
    map.set(symbol, {
      price,
      changePct: round2(toNum(row.change_pct)),
      changePoints: round2(toNum(row.change)),
    });
  }
  return map;
}

async function fetchYahooIndexQuote(yahooSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const body = await res.json();
  const meta = body?.chart?.result?.[0]?.meta;
  const price = round2(toNum(meta?.regularMarketPrice));
  const previousClose = round2(toNum(meta?.chartPreviousClose ?? meta?.previousClose));
  if (price == null) throw new Error(`Yahoo empty: ${yahooSymbol}`);
  const changePoints = price != null && previousClose != null ? round2(price - previousClose) : null;
  const changePct =
    price != null && previousClose ? round2((changePoints / previousClose) * 100) : null;
  return { price, changePct, changePoints };
}

async function fetchCnbcIndexQuote(symbol) {
  const url = `https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols=${symbol}&output=json`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`CNBC HTTP ${res.status}`);
  const body = await res.json();
  const quote = Array.isArray(body?.QuickQuoteResult?.QuickQuote)
    ? body.QuickQuoteResult.QuickQuote[0]
    : body?.QuickQuoteResult?.QuickQuote;
  const price = round2(toNum(quote && quote.last));
  if (!quote || price == null) return null;
  return {
    price,
    changePct: round2(toNum(quote.change_pct)),
    changePoints: round2(toNum(quote.change)),
  };
}

async function fetchIndices() {
  return cached("indices", async () => {
    const items = [];
    let cnbcQuotes = null;
    for (const idx of US_INDICES) {
      let quote = { price: null, changePct: null, changePoints: null };
      if (idx.source !== "cnbc" && idx.exchange) {
        try {
          quote = await fetchOverseasIndexQuote(idx);
        } catch (e) {
          console.warn("[us-market-data] KIS index", idx.symbol, e && e.message);
        }
      }
      if (quote.price == null) {
        cnbcQuotes = cnbcQuotes || (await fetchCnbcIndexQuotes());
      }
      let fallback = cnbcQuotes ? cnbcQuotes.get(idx.cnbcSymbol) : null;
      if (!fallback && idx.cnbcSymbol) {
        fallback = await fetchCnbcIndexQuote(idx.cnbcSymbol);
      }
      let price = quote.price ?? (fallback && fallback.price) ?? null;
      let changePct = quote.changePct ?? (fallback && fallback.changePct) ?? null;
      let changePoints = quote.changePoints ?? (fallback && fallback.changePoints) ?? null;
      if (price == null && idx.yahoo) {
        try {
          const yahoo = await fetchYahooIndexQuote(idx.yahoo);
          price = yahoo.price;
          changePct = yahoo.changePct;
          changePoints = yahoo.changePoints;
        } catch (e) {
          console.warn("[us-market-data] Yahoo", idx.yahoo, e && e.message);
        }
      }
      items.push({
        id: idx.id,
        name: idx.name,
        symbol: idx.symbol,
        price,
        changePct,
        changePoints,
        live: idx.id === "nasdaq-futures",
      });
    }
    return items;
  });
}

async function fetchSectors() {
  return cached("sectors", async () => {
    const sectors = [];
    for (const sector of US_SECTORS) {
      const quote = await fetchOverseasQuote(sector);
      sectors.push({
        symbol: sector.symbol,
        name: sector.name,
        label: sector.label,
        changePct: quote.changePct,
        price: quote.price,
      });
      console.log("[us-market-data] sector", sector.symbol, {
        changePct: quote.changePct,
        price: quote.price,
      });
    }
    return sectors;
  });
}

async function fetchMarketCapLookup() {
  return cached("ranking:market-cap:lookup", async () => {
    const all = [];
    for (const exchange of EXCHANGES) {
      const body = await kisGet(MARKET_CAP_PATH, MARKET_CAP_TR_ID, {
        AUTH: "",
        CURR_GB: US_RANKING_CURRENCY,
        EXCD: exchange,
        KEYB: "",
        VOL_RANG: "0",
      });
      const rows = outputRows(body, "output2").map((row, i) => ({
        ...mapRankRow(row, all.length + i + 1),
        exchange,
      }));
      all.push(...rows);
    }
    return all
      .filter((row) => row.ticker && row.price != null && row.marketCap != null)
      .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))
      .slice(0, 50)
      .map((row, i) => ({ ...row, rank: i + 1 }));
  });
}

async function getMarketCapRowsCached() {
  return fetchMarketCapLookup();
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

async function enrichRowFromUsDetail(row) {
  if (!row || !row.ticker) return row;
  const exchanges = [row.exchange || "NAS", "NYS"].filter((e, i, a) => a.indexOf(e) === i);
  const symbols = kisSymbolVariants(row.ticker);
  let lastErr = null;
  for (const sym of symbols) {
    for (const exchange of exchanges) {
      try {
        const hit = await fetchUsPriceDetail(exchange, sym);
        if (!hit) continue;
        const { p, d, price: detailPrice } = hit;
        const price = row.price ?? detailPrice;
        const merged = { ...d, ...p };
        const volume = pickUsVolume(d, p) ?? row.volume;
        const changePct = parseRankingChangePct(merged, price) ?? row.changePct;
        const changePoints = resolveChangePoints(merged, price, changePct);
        const tradingValue =
          pickUsTradingValue(d, p, price, volume) ?? computeTradingValue(price, volume);
        const detailName = sanitizeStr(pickFirst(d, ["e_icod", "E_ICOD", "ovrs_item_name", "OVRS_ITEM_NAME"]));
        const name =
          row.name && row.name !== row.ticker
            ? row.name
            : detailName && !/^D(NYS|NAS|AMS)[A-Z0-9]/i.test(detailName)
              ? detailName
              : row.name;
        return { ...row, exchange, name, price, volume, changePct, changePoints, tradingValue };
      } catch (e) {
        lastErr = e;
      }
    }
  }
  console.warn("[us-market-data] detail enrich", row.ticker, lastErr && lastErr.message);
  const tradingValue =
    pickUsTradingValue(row, null, row.price, row.volume) ?? computeTradingValue(row.price, row.volume);
  return tradingValue != null ? { ...row, tradingValue } : row;
}

async function enrichRankRows(rows) {
  let capByTicker = new Map();
  try {
    const caps = await getMarketCapRowsCached();
    for (const row of caps) {
      if (row && row.ticker) capByTicker.set(row.ticker, row);
    }
  } catch (e) {
    console.warn("[us-market-data] enrich market cap", e && e.message);
  }
  const detailed = await mapPool(rows, 10, enrichRowFromUsDetail);
  return detailed.map((row) => {
    const cap = capByTicker.get(row.ticker);
    const tradingValue =
      row.tradingValue ??
      pickUsTradingValue(row, null, row.price, row.volume) ??
      computeTradingValue(row.price, row.volume);
    return {
      ...row,
      marketCap: row.marketCap != null ? row.marketCap : cap && cap.marketCap != null ? cap.marketCap : null,
      tradingValue,
      changePoints:
        row.changePoints != null ? row.changePoints : resolveChangePoints(row, row.price, row.changePct),
    };
  });
}

async function fetchMergedRanking(
  cacheKey,
  path,
  trId,
  params,
  sortKey,
  { enrich = true, resort = false, pickCount = 50 } = {}
) {
  return cached(cacheKey, async () => {
    const all = [];
    for (const exchange of EXCHANGES) {
      const body = await kisGet(path, trId, params(exchange));
      const rows = outputRows(body, "output2").map((row, i) => ({
        ...mapRankRow(row, all.length + i + 1),
        exchange,
      }));
      all.push(...rows);
    }
    let ranked = all
      .filter((row) => row.ticker && row.price != null && row[sortKey] != null)
      .sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0))
      .slice(0, pickCount);
    if (enrich) ranked = await enrichRankRows(ranked);
    if (resort) {
      ranked = ranked.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0)).slice(0, 50);
    } else if (ranked.length > 50) {
      ranked = ranked.slice(0, 50);
    }
    return ranked.map((row, i) => ({ ...row, rank: i + 1 }));
  });
}

function fetchMarketCapTop50() {
  return cached("ranking:market-cap:v4", async () => {
    const ranked = await fetchMarketCapLookup();
    return enrichRankRows(ranked);
  });
}

function fetchGainersTop50() {
  return fetchMergedRanking(
    "ranking:gainers:v4",
    UPDOWN_RATE_PATH,
    UPDOWN_RATE_TR_ID,
    (exchange) => ({
      AUTH: "",
      CURR_GB: US_RANKING_CURRENCY,
      EXCD: exchange,
      GUBN: "1",
      KEYB: "",
      NDAY: "0",
      VOL_RANG: "0",
    }),
    "changePct",
    { enrich: true }
  );
}

function fetchTradeValueTop50() {
  return fetchMergedRanking(
    "ranking:trade-value:v4",
    TRADE_PBMN_PATH,
    TRADE_PBMN_TR_ID,
    (exchange) => ({
      AUTH: "",
      CURR_GB: US_RANKING_CURRENCY,
      EXCD: exchange,
      KEYB: "",
      NDAY: "0",
      PRC1: "",
      PRC2: "",
      VOL_RANG: "0",
    }),
    "tradingValue",
    { enrich: true, resort: true, pickCount: 60 }
  );
}

function findCachedRankRow(ticker) {
  const keys = [
    "ranking:market-cap:v4",
    "ranking:gainers:v4",
    "ranking:trade-value:v4",
    "ranking:market-cap",
    "ranking:gainers:v2",
    "ranking:trade-value:v2",
    "ranking:gainers",
    "ranking:trade-value",
  ];
  for (const key of keys) {
    const hit = memoryCache.get(key);
    if (!hit || !Array.isArray(hit.value) || hit.expiresAt <= Date.now()) continue;
    const row = hit.value.find((r) => r.ticker === ticker);
    if (row) return row;
  }
  return null;
}

function yahooExchangeToKis(exch) {
  const e = sanitizeStr(exch).toUpperCase();
  if (e.includes("NMS") || e.includes("NGM") || e.includes("NAS")) return "NAS";
  if (e.includes("NYS") || e.includes("NYQ")) return "NYS";
  return "NAS";
}

async function fetchYahooEquityQuote(symbol) {
  const sym = normalizeTicker(symbol);
  if (!sym) return null;
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo quote HTTP ${res.status}`);
  const body = await res.json();
  const q = body?.quoteResponse?.result?.[0];
  if (!q || q.regularMarketPrice == null) return null;
  const price = round2(toNum(q.regularMarketPrice));
  const changePct = round2(toNum(q.regularMarketChangePercent));
  const changePoints = round2(toNum(q.regularMarketChange));
  const volume = toNum(q.regularMarketVolume);
  const marketCap = toNum(q.marketCap);
  const tradingValue =
    price != null && volume != null ? Math.round(price * volume) : null;
  return {
    ticker: sanitizeStr(q.symbol) || sym,
    name: sanitizeStr(q.longName || q.shortName) || sym,
    exchange: yahooExchangeToKis(q.exchange),
    price,
    changePct,
    changePoints:
      changePoints != null
        ? changePoints
        : resolveChangePoints({}, price, changePct),
    volume: volume != null ? Math.round(volume) : null,
    marketCap: marketCap != null ? Math.round(marketCap) : null,
    tradingValue,
  };
}

async function fetchYahooSymbolSearch(query) {
  const q = sanitizeStr(query);
  if (!q || q.length < 1) return [];
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&listsCount=0`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo search HTTP ${res.status}`);
  const body = await res.json();
  const quotes = Array.isArray(body?.quotes) ? body.quotes : [];
  const seen = new Set();
  const results = [];
  for (const item of quotes) {
    const quoteType = sanitizeStr(item.quoteType).toUpperCase();
    if (quoteType && quoteType !== "EQUITY") continue;
    const ticker = normalizeTicker(item.symbol);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    results.push({
      ticker,
      name: sanitizeStr(item.longname || item.shortname || item.symbol) || ticker,
      exchange: yahooExchangeToKis(item.exchange),
    });
    if (results.length >= 12) break;
  }
  return results;
}

async function fetchStockQuote(ticker) {
  const sym = normalizeTicker(ticker);
  if (!sym) throw new Error("Missing or invalid ticker");

  const cached = findCachedRankRow(sym);
  if (cached && cached.price != null) {
    return {
      ...cached,
      changePoints: resolveChangePoints(cached, cached.price, cached.changePct),
    };
  }

  for (const exchange of EXCHANGES) {
    try {
      const body = await kisGet(OVERSEAS_PRICE_PATH, OVERSEAS_PRICE_TR_ID, {
        AUTH: "",
        EXCD: exchange,
        SYMB: sym,
      });
      const out = outputObject(body);
      const price = round2(
        toNum(pickFirst(out, ["last", "LAST", "ovrs_nmix_prpr", "OVRS_NMIX_PRPR", "stck_prpr", "STCK_PRPR"]))
      );
      if (price == null) continue;
      const changePct = parseOverseasChangePct(out);
      const volume = toNum(pickFirst(out, ["tvol", "TVOL", "acml_vol", "ACML_VOL", "volume", "VOLUME"]));
      const name =
        sanitizeStr(pickFirst(out, ["name", "NAME", "ovrs_item_name", "OVRS_ITEM_NAME", "prdt_name", "PRDT_NAME"])) ||
        sym;
      const tradingValue =
        price != null && volume != null ? Math.round(price * volume) : null;
      let marketCap = null;
      try {
        const caps = await getMarketCapRowsCached();
        const hit = caps.find((row) => row.ticker === sym);
        if (hit) marketCap = hit.marketCap;
      } catch (e) {
        /* optional */
      }
      return {
        ticker: sym,
        name,
        exchange,
        price,
        changePct,
        changePoints: resolveChangePoints(out, price, changePct),
        volume: volume != null ? Math.round(volume) : null,
        marketCap,
        tradingValue,
      };
    } catch (e) {
      console.warn("[us-market-data] quote", sym, exchange, e && e.message);
    }
  }

  const yahoo = await fetchYahooEquityQuote(sym);
  if (yahoo) return yahoo;
  throw new Error(`Quote not found: ${sym}`);
}

async function searchUsSymbols(query) {
  const q = sanitizeStr(query);
  if (!q) return [];
  const upper = q.toUpperCase();
  const local = [];
  const keys = [
    "ranking:market-cap:v4",
    "ranking:gainers:v4",
    "ranking:trade-value:v4",
    "ranking:market-cap",
    "ranking:gainers:v2",
    "ranking:trade-value:v2",
    "ranking:gainers",
    "ranking:trade-value",
  ];
  const seen = new Set();
  for (const key of keys) {
    const hit = memoryCache.get(key);
    if (!hit || !Array.isArray(hit.value) || hit.expiresAt <= Date.now()) continue;
    for (const row of hit.value) {
      if (!row || !row.ticker || seen.has(row.ticker)) continue;
      const ticker = String(row.ticker).toUpperCase();
      const name = String(row.name || "").toLowerCase();
      if (ticker.includes(upper) || name.includes(q.toLowerCase())) {
        seen.add(row.ticker);
        local.push({ ticker: row.ticker, name: row.name || row.ticker, exchange: row.exchange || "NAS" });
      }
    }
  }
  const compact = q.replace(/\s+/g, "").toLowerCase();
  const alias = KO_SEARCH_ALIASES.get(compact) || KO_SEARCH_ALIASES.get(q.toLowerCase());
  const remoteQueries = alias ? [q, alias] : [q];
  let remote = [];
  for (const term of remoteQueries) {
    try {
      const hits = await fetchYahooSymbolSearch(term);
      remote.push(...hits);
    } catch (e) {
      console.warn("[us-market-data] search", term, e && e.message);
    }
  }
  const merged = [];
  const mergedSeen = new Set();
  for (const row of [...local, ...remote]) {
    const t = normalizeTicker(row.ticker);
    if (!t || mergedSeen.has(t)) continue;
    mergedSeen.add(t);
    merged.push({ ...row, ticker: t });
  }
  return merged.slice(0, 12);
}

function fetchPseudoCandles(ticker) {
  const row = findCachedRankRow(ticker);
  if (!row || row.price == null) return [];
  const price = row.price;
  const change = row.changePct == null ? 0 : row.changePct / 100;
  const prev = change === -1 ? price : price / (1 + change);
  const high = Math.max(price, prev);
  const low = Math.min(price, prev);
  const today = new Date();
  return [
    {
      time: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`,
      open: round2(prev),
      high: round2(high),
      low: round2(low),
      close: round2(price),
      volume: row.volume || 0,
    },
  ];
}

function cachedPayload(key, loader) {
  return cached(`payload:${key}`, async () => {
    const payload = await loader();
    return { ...payload, updatedAt: new Date().toISOString() };
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

  const action = sanitizeStr(req.query && req.query.action) || "indices";

  try {
    if (action === "indices") {
      const payload = await cachedPayload("indices", async () => ({ indices: await fetchIndices() }));
      json(res, 200, payload);
      return;
    }
    if (action === "sectors") {
      const payload = await cachedPayload("sectors", async () => ({ sectors: await fetchSectors() }));
      json(res, 200, payload);
      return;
    }
    if (action === "market-cap") {
      const payload = await cachedPayload("market-cap:v4", async () => ({ stocks: await fetchMarketCapTop50() }));
      json(res, 200, payload);
      return;
    }
    if (action === "gainers") {
      const payload = await cachedPayload("gainers:v4", async () => ({ stocks: await fetchGainersTop50() }));
      json(res, 200, payload);
      return;
    }
    if (action === "volume") {
      const payload = await cachedPayload("volume:v4", async () => ({ stocks: await fetchTradeValueTop50() }));
      json(res, 200, payload);
      return;
    }
    if (action === "candle") {
      const ticker = normalizeTicker(req.query && req.query.ticker);
      if (!ticker) {
        json(res, 400, { error: "Missing or invalid ticker" });
        return;
      }
      const period = normalizePeriod(req.query && req.query.period);
      const payload = await cachedPayload(`candle:${ticker}:${period}`, async () => ({
        ticker,
        period,
        candles: await fetchPseudoCandles(ticker),
      }));
      json(res, 200, payload);
      return;
    }
    if (action === "quote") {
      const ticker = normalizeTicker(req.query && req.query.ticker);
      if (!ticker) {
        json(res, 400, { error: "Missing or invalid ticker" });
        return;
      }
      const payload = await cachedPayload(`quote:${ticker}`, async () => ({
        stock: await fetchStockQuote(ticker),
      }));
      json(res, 200, payload);
      return;
    }
    if (action === "search") {
      const q = sanitizeStr(req.query && (req.query.q || req.query.query));
      if (!q) {
        json(res, 400, { error: "Missing search query" });
        return;
      }
      const payload = await cachedPayload(`search:${q.toLowerCase()}`, async () => ({
        results: await searchUsSymbols(q),
      }));
      json(res, 200, payload);
      return;
    }

    json(res, 400, {
      error: "Unknown action. Use indices, sectors, market-cap, gainers, volume, candle, quote, or search.",
    });
  } catch (e) {
    console.error("[us-market-data]", action, e && e.message, e);
    json(res, 502, { error: e.message || String(e) });
  }
};
