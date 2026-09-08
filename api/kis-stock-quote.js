/**
 * KIS 종목 시세(시세1+시세2) 합쳐서 반환
 * GET /api/kis-stock-quote?code=005930
 * GET /api/kis-stock-quote?code=005930&chart=1&period=D|W|M
 */

const DEFAULT_KIS_BASE = "https://openapi.koreainvestment.com:9443";
const { isKisRsymToken, isLikelyUsSectorName, resolveUsDisplayName } = require("../lib/us-stock-display-name");

function json(res, status, body, cacheControl) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  // 2026-09-09: 차트 응답만 엣지 캐시를 허용한다. 시세(현재가) 응답은 그대로 no-store.
  res.setHeader("cache-control", cacheControl || "no-store");
  res.end(JSON.stringify(body));
}

/* 2026-09-09 성능: 차트 로딩이 너무 느리다는 피드백(국내 일봉 실측 2.8~4.0초, 미국 2.4초).
   원인이 두 가지였다.
   (1) 모든 응답이 cache-control: no-store 라 같은 종목을 몇 번을 열어도 매번 KIS를
       다시 다 훑었다. x-vercel-cache 는 항상 MISS.
   (2) 캔들을 100개씩 끊어 받으면서 그걸 순차로 반복했다(국내 일봉 5회, 미국 일봉 최대 12회).
   여기서는 (1)을, 아래 fetch 함수들에서 (2)를 고친다.

   캔들은 이미 확정된 과거 데이터이고, 장중에 움직이는 건 맨 마지막 봉 하나뿐이라
   짧은 s-maxage + 긴 stale-while-revalidate 조합이 안전하다. SWR 구간에서는 캐시를
   즉시 돌려주고 뒤에서 갱신하므로, 두 번째 사용자부터는 체감 대기가 사라진다. */
const CHART_CACHE = {
  // 일봉: 장중 마지막 봉이 움직인다 — 최대 3분 지연 허용
  D: "public, max-age=60, s-maxage=180, stale-while-revalidate=1800",
  // 주봉·월봉: 하루 안에서 의미 있게 바뀌지 않는다
  W: "public, max-age=300, s-maxage=900, stale-while-revalidate=86400",
  M: "public, max-age=300, s-maxage=900, stale-while-revalidate=86400",
  // 암호화폐: 24시간 거래라 조금 더 짧게
  CRYPTO_D: "public, max-age=30, s-maxage=120, stale-while-revalidate=600",
};

function chartCacheControl(period, isCrypto) {
  const p = normalizePeriod(period);
  if (isCrypto) return p === "D" ? CHART_CACHE.CRYPTO_D : CHART_CACHE.W;
  return CHART_CACHE[p] || CHART_CACHE.D;
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNum(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeCode6(raw) {
  // 우선주(예: 02826K) 등 6자리 영숫자 종목코드는 숫자만 남기면 잘못된 코드로 뭉개지므로
  // 이미 6자리 영숫자 형태면 그대로 통과시킨다.
  const up = String(raw || "").trim().toUpperCase();
  if (/^[0-9A-Z]{6}$/.test(up)) return up;
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 6) return digits;
  if (digits.length < 6) return digits.padStart(6, "0");
  return digits.slice(-6);
}

function ymdKst(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d).replace(/-/g, "");
}

function subtractCalendarDaysFromYmd(ymd, days) {
  const s = String(ymd || "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(s)) return s;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6)) - 1;
  const day = Number(s.slice(6, 8));
  const dt = new Date(Date.UTC(y, m, day));
  dt.setUTCDate(dt.getUTCDate() - Number(days || 0));
  return ymdKst(dt);
}

function requireKisCreds() {
  const token = sanitizeStr(process.env.KIS_ACCESS_TOKEN);
  const appkey = sanitizeStr(process.env.KIS_APP_KEY);
  const appsecret = sanitizeStr(process.env.KIS_APP_SECRET);
  if (!token || !appkey || !appsecret) {
    const err = new Error("Missing KIS credentials");
    err.statusCode = 503;
    throw err;
  }
  return { token, appkey, appsecret };
}

function kisBaseUrl() {
  return sanitizeStr(process.env.KIS_BASE_URL || DEFAULT_KIS_BASE).replace(/\/+$/, "");
}

async function kisGetJson(path, trId, params) {
  const { token, appkey, appsecret } = requireKisCreds();
  const url = new URL(path, kisBaseUrl());
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, v == null ? "" : String(v));
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey,
      appsecret,
      tr_id: trId,
    },
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    const err = new Error(`KIS invalid JSON: ${text.slice(0, 200)}`);
    err.statusCode = 502;
    throw err;
  }
  if (!res.ok || (j && j.rt_cd && j.rt_cd !== "0")) {
    const msg = (j && (j.msg1 || j.msg_cd)) || `HTTP ${res.status}`;
    const err = new Error(`KIS error: ${msg}`);
    err.statusCode = 502;
    throw err;
  }
  return j;
}

function mapDailyRow(row) {
  if (!row || typeof row !== "object") return null;
  const dateRaw = sanitizeStr(row.stck_bsop_date || row.STCK_BSOP_DATE);
  if (!/^\d{8}$/.test(dateRaw)) return null;
  const time = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
  const open = toNum(row.stck_oprc || row.STCK_OPRC);
  const high = toNum(row.stck_hgpr || row.STCK_HGPR);
  const low = toNum(row.stck_lwpr || row.STCK_LWPR);
  const close = toNum(row.stck_clpr || row.STCK_CLPR || row.stck_prpr || row.STCK_PRPR);
  if (open == null || high == null || low == null || close == null) return null;
  const volRaw = toNum(row.acml_vol || row.ACML_VOL);
  const volume = volRaw != null && volRaw >= 0 ? volRaw : 0;
  return {
    time,
    open: Math.round(open),
    high: Math.round(high),
    low: Math.round(low),
    close: Math.round(close),
    volume: Math.round(volume),
  };
}

function normalizePeriod(raw) {
  const p = sanitizeStr(raw).toUpperCase();
  if (p === "W" || p === "M") return p;
  return "D";
}

function targetCount(periodDiv) {
  if (periodDiv === "M") return 120;
  if (periodDiv === "W") return 200;
  // 2026-07-11: 일봉은 추세를 보기에 200개(약 10개월)로는 부족하다는 피드백에 따라
  // 약 2년치(거래일 기준 약 500개)를 받아오도록 늘렸다.
  return 500;
}

/** KIS 기간별시세는 한 번에 최대 100개만 돌려준다(국내·해외 공통). */
const KIS_CHART_PAGE_MAX = 100;

/* 2026-09-09 성능: 기존에는 "받고 → 가장 오래된 날짜 다음으로 커서를 옮겨 → 또 받고"를
   순차로 반복해서, 일봉 2년치(500개)를 채우는 데 KIS 왕복이 5번 직렬로 쌓였다(실측 2.8~4.0초).
   구간은 날짜로 미리 계산할 수 있으므로, 창을 먼저 나눠 놓고 병렬로 받는다.
   창 하나가 100개(=1회 상한)로 잘렸을 가능성이 있으면 그 창만 과거 방향으로 이어 받아 메운다.
   창 폭은 "그 안의 거래일 수 < 100"이 되도록 잡아, 정상적인 경우 보충 호출이 아예 안 생긴다.
   (일봉 130일 ≈ 89거래일 / 주봉 640일 ≈ 91주 / 월봉 1200일 ≈ 39개월) */
function chartWindowPlan(period) {
  if (period === "M") return { span: 1200, count: 4 }; // 4800일 ≈ 157개월 ≥ 120
  if (period === "W") return { span: 640, count: 3 }; //  1920일 ≈ 274주  ≥ 200
  return { span: 130, count: 6 }; //                       780일 ≈ 535거래일 ≥ 500
}

function oldestYmdOf(rows) {
  if (!rows || !rows.length) return "";
  const s = String(rows[0].time).replace(/\D/g, "").slice(0, 8);
  return /^\d{8}$/.test(s) ? s : "";
}

async function fetchDomesticChartWindow(code6, period, d1, d2) {
  const j = await kisGetJson(
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    "FHKST03010100",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code6,
      FID_INPUT_DATE_1: d1,
      FID_INPUT_DATE_2: d2,
      FID_PERIOD_DIV_CODE: period,
      FID_ORG_ADJ_PRC: "0",
    }
  );
  let raw = j && j.output2;
  if (raw && !Array.isArray(raw)) raw = [raw];
  if (!Array.isArray(raw)) raw = [];
  const batch = [];
  for (const row of raw) {
    const b = mapDailyRow(row);
    if (b) batch.push(b);
  }
  batch.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return batch;
}

async function fetchChartCandles(code6, periodDiv) {
  const period = normalizePeriod(periodDiv);
  const target = targetCount(period);
  const plan = chartWindowPlan(period);
  const endAll = ymdKst(new Date());

  const windows = [];
  for (let i = 0; i < plan.count; i++) {
    windows.push({
      d1: subtractCalendarDaysFromYmd(endAll, (i + 1) * plan.span),
      d2: i === 0 ? endAll : subtractCalendarDaysFromYmd(endAll, i * plan.span),
    });
  }

  let firstError = null;
  const results = await Promise.all(
    windows.map((w) =>
      fetchDomesticChartWindow(code6, period, w.d1, w.d2).catch((e) => {
        // 창 하나가 실패해도 나머지로 그린다(기존 동작과 동일한 원칙).
        if (!firstError) firstError = e;
        return [];
      })
    )
  );

  const byTime = new Map();
  for (const rows of results) for (const b of rows) byTime.set(b.time, b);

  // 상한(100개)에 걸린 창은 더 과거 구간이 잘렸을 수 있다 — 그 창만 이어 받는다.
  for (let i = 0; i < results.length; i++) {
    if (results[i].length < KIS_CHART_PAGE_MAX) continue;
    let chunkEnd = subtractCalendarDaysFromYmd(oldestYmdOf(results[i]), 1);
    for (let g = 0; g < 3; g++) {
      if (!chunkEnd || chunkEnd <= windows[i].d1) break;
      let rows = [];
      try {
        rows = await fetchDomesticChartWindow(code6, period, windows[i].d1, chunkEnd);
      } catch {
        break;
      }
      if (!rows.length) break;
      for (const b of rows) byTime.set(b.time, b);
      const next = subtractCalendarDaysFromYmd(oldestYmdOf(rows), 1);
      if (!next || next >= chunkEnd) break;
      chunkEnd = next;
      if (rows.length < KIS_CHART_PAGE_MAX) break;
    }
  }

  // 전부 실패했다면 원래 KIS 오류를 그대로 올려 원인을 알 수 있게 한다.
  if (!byTime.size && firstError) throw firstError;

  return [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)).slice(-target);
}

function computeMaSeries(closes, period, smart) {
  const out = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const avg = sum / period;
    // 2026-07-11: 국내주식(원, 정수 단위)은 기존처럼 정수로 반올림하지만, 미국주식/암호화폐는
    // 달러 표시 소수점이 필요하다. 정수로 반올림하면(예: NVDA 이평선을 $1 단위로 반올림) 실제로는
    // 하루하루 완만하게 움직이는 이평선이 며칠씩 같은 값으로 뭉쳤다가 $1씩 점프하는 "계단" 형태로
    // 보이는 버그가 있었다 — roundSmart(가격대별 소수점 자동 조정)로 바꿔서 자연스럽게 이어지게 한다.
    out.push(smart ? roundSmart(avg) : Math.round(avg));
  }
  return out;
}

function computeRsi14(closes) {
  const period = 14;
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function enrichChart(candles, assetType) {
  const closes = candles.map((c) => c.close);
  const smart = assetType === "US" || assetType === "CRYPTO";
  return {
    candles,
    ma20: computeMaSeries(closes, 20, smart),
    ma60: computeMaSeries(closes, 60, smart),
    ma120: computeMaSeries(closes, 120, smart),
    ma200: computeMaSeries(closes, 200, smart),
    rsi14: computeRsi14(closes),
  };
}

async function handleChartRequest(res, code6, period) {
  const candles = await fetchChartCandles(code6, period);
  if (!candles.length) {
    return json(res, 502, { error: "차트 데이터가 없습니다." });
  }
  return json(res, 200, enrichChart(candles), chartCacheControl(period, false));
}

function marketLabelFromRow(row) {
  const hint = sanitizeStr(
    (row && (row.mrkt_div_cls_code || row.MRKT_DIV_CLS_CODE || row.rprs_mrkt_kor_name || row.RPRS_MRKT_KOR_NAME)) ||
      ""
  );
  const blob = String(hint || "").toUpperCase();
  if (/KOSDAQ|KQ|KONEX/.test(blob) || /코스닥/.test(hint)) return "KOSDAQ";
  if (/KOSPI|KS|KRX/.test(blob) || /코스피|유가/.test(hint)) return "KOSPI";
  return hint || "";
}

const OVERSEAS_PRICE_PATH = "/uapi/overseas-price/v1/quotations/price";
const OVERSEAS_PRICE_TR_ID = "HHDFS00000300";
const OVERSEAS_DETAIL_PATH = "/uapi/overseas-price/v1/quotations/price-detail";
const OVERSEAS_DETAIL_TR_ID = "HHDFS76200200";
const US_EXCHANGES = ["NAS", "NYS"];

function pickFirst(row, keys) {
  if (!row || typeof row !== "object") return "";
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim() !== "") return value;
    const upper = String(key).toUpperCase();
    if (row[upper] != null && String(row[upper]).trim() !== "") return row[upper];
  }
  return "";
}

function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function normalizeUsTicker(raw) {
  const s = sanitizeStr(raw).toUpperCase().replace(/[^A-Z0-9.]/g, "");
  if (!s || s.length > 16) return "";
  return s;
}

function usExchangeLabel(excd) {
  const e = sanitizeStr(excd).toUpperCase();
  if (e === "NYS") return "NYSE";
  if (e === "NAS") return "NASDAQ";
  return e || "US";
}

function resolveUsStockName(detail, price, ticker, nameHint) {
  const hint = sanitizeStr(nameHint);
  const goodHint = hint && !isKisRsymToken(hint) && !isLikelyUsSectorName(hint) ? hint : "";
  for (const key of [
    "e_icod",
    "E_ICOD",
    "ovrs_item_name",
    "OVRS_ITEM_NAME",
    "name",
    "NAME",
    "prdt_name",
    "PRDT_NAME",
  ]) {
    const candidate = sanitizeStr(pickFirst(detail, [key]) || pickFirst(price, [key]));
    if (candidate && !isKisRsymToken(candidate) && !isLikelyUsSectorName(candidate)) {
      return resolveUsDisplayName(ticker, candidate);
    }
  }
  return resolveUsDisplayName(ticker, goodHint || ticker);
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

function pickUsVolume(detail, price) {
  const tvol = toNum(pickFirst(detail, ["tvol", "TVOL"]));
  const pvol = toNum(pickFirst(detail, ["pvol", "PVOL"]));
  const priceVol = toNum(pickFirst(price, ["tvol", "TVOL"]));
  const pricePvol = toNum(pickFirst(price, ["pvol", "PVOL"]));
  const tvolMax = Math.max(...[tvol, priceVol].filter((n) => n != null && n > 0), 0) || null;
  const pvolMax = Math.max(...[pvol, pricePvol].filter((n) => n != null && n > 0), 0) || null;
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
  const priceAmt = toNum(pickFirst(price, ["tamt", "TAMT"]));
  const candidates = [tamt, pamt, priceAmt].filter((n) => n != null && n > 0);
  if (candidates.length) return Math.round(Math.max(...candidates));
  if (currentPrice != null && volume != null) return Math.round(currentPrice * volume);
  return null;
}

function resolveUsChangeAmt(row, price, changeRate) {
  const prev = round2(
    toNum(
      pickFirst(row, [
        "base",
        "BASE",
        "prdy_clpr",
        "PRDY_CLPR",
        "ovrs_prdy_clpr",
        "OVRS_PRDY_CLPR",
        "ovrs_stck_prdy_clpr",
        "OVRS_STCK_PRDY_CLPR",
      ])
    )
  );
  if (price != null && prev != null) return round2(price - prev);
  if (price != null && changeRate != null && Number.isFinite(changeRate)) {
    const prevFromPct = price / (1 + changeRate / 100);
    return round2(price - prevFromPct);
  }
  const raw = round2(toNum(pickFirst(row, ["diff", "DIFF", "prdy_vrss", "PRDY_VRSS", "ovrs_stck_prdy_vrss", "OVRS_STCK_PRDY_VRSS"])));
  if (raw == null) return null;
  if (changeRate == null || changeRate === 0) return raw;
  if (changeRate < 0 && raw > 0) return round2(-Math.abs(raw));
  if (changeRate > 0 && raw < 0) return round2(Math.abs(raw));
  return raw;
}

async function fetchUsStockQuote(ticker, nameHint) {
  let lastError = null;
  const symbols = kisSymbolVariants(ticker);
  for (const sym of symbols) {
    for (const exchange of US_EXCHANGES) {
      try {
        const [priceRes, detailRes] = await Promise.all([
          kisGetJson(OVERSEAS_PRICE_PATH, OVERSEAS_PRICE_TR_ID, { AUTH: "", EXCD: exchange, SYMB: sym }),
          kisGetJson(OVERSEAS_DETAIL_PATH, OVERSEAS_DETAIL_TR_ID, { AUTH: "", EXCD: exchange, SYMB: sym }),
        ]);
      const p = (priceRes && priceRes.output) || {};
      const d = (detailRes && detailRes.output) || {};
      const merged = { ...d, ...p };
      const currentPrice = round2(
        toNum(pickFirst(p, ["last", "LAST", "stck_prpr", "STCK_PRPR"])) ||
          toNum(pickFirst(d, ["last", "LAST", "stck_prpr", "STCK_PRPR"]))
      );
      if (currentPrice == null) continue;
      const changeRate = round2(toNum(pickFirst(merged, ["rate", "RATE", "prdy_ctrt", "PRDY_CTRT"])));
      const changeAmt = resolveUsChangeAmt(merged, currentPrice, changeRate);
      const volume = pickUsVolume(d, p);
      const tradingValue = pickUsTradingValue(d, p, currentPrice, volume);
      const marketCap = toNum(pickFirst(d, ["tomv", "TOMV", "mket_avls", "MKET_AVLS", "mcap", "MCAP"])) ||
        toNum(pickFirst(p, ["tomv", "TOMV", "mket_avls", "MKET_AVLS"]));
      const open = round2(toNum(pickFirst(d, ["open", "OPEN", "stck_oprc", "STCK_OPRC"])));
      const high = round2(toNum(pickFirst(d, ["high", "HIGH", "stck_hgpr", "STCK_HGPR"])));
      const low = round2(toNum(pickFirst(d, ["low", "LOW", "stck_lwpr", "STCK_LWPR"])));
      const prevClose = round2(
        toNum(
          pickFirst(merged, [
            "base",
            "BASE",
            "prdy_clpr",
            "PRDY_CLPR",
            "ovrs_prdy_clpr",
            "OVRS_PRDY_CLPR",
            "ovrs_stck_prdy_clpr",
            "OVRS_STCK_PRDY_CLPR",
          ])
        )
      );
      const high52w = round2(toNum(pickFirst(d, ["h52p", "H52P", "w52_hgpr", "W52_HGPR"])));
      const low52w = round2(toNum(pickFirst(d, ["l52p", "L52P", "w52_lwpr", "W52_LWPR"])));
      const per = toNum(pickFirst(d, ["perx", "PERX", "per", "PER"]));
      const eps = toNum(pickFirst(d, ["epsx", "EPSX", "eps", "EPS"]));
      const stockName = resolveUsStockName(d, p, ticker, nameHint);

        return {
          stockCode: ticker,
          stockName,
          market: usExchangeLabel(exchange),
          exchange,
          currentPrice,
          changeAmt,
          changeRate,
          volume,
          tradingValue,
          marketCap: marketCap == null ? null : Math.round(marketCap),
          prevClose,
          open,
          high,
          low,
          high52w,
          low52w,
          financials: { per, eps },
        };
      } catch (e) {
        lastError = e;
      }
    }
  }
  const err = new Error(lastError && lastError.message ? lastError.message : `US quote not found: ${ticker}`);
  err.statusCode = 404;
  throw err;
}

async function handleUsQuoteRequest(res, ticker, nameHint) {
  const quote = await fetchUsStockQuote(ticker, nameHint);
  return json(res, 200, quote);
}

/**
 * 2026-07-10: 미국주식·암호화폐도 국내주식과 동일한 자체 캔들+이동평균선 차트를 쓸 수 있도록
 * 차트 데이터 소스를 추가한다. 미국주식은 기존 시세 조회와 같은 KIS 해외주식 API(기간별시세)를
 * 재사용하고, 암호화폐는 별도 API 키가 필요 없는 Binance 공개 klines 엔드포인트를 사용한다.
 * (KIS/CMC는 암호화폐 일별 OHLC를 무료로 제공하지 않아서 부득이하게 다른 소스를 쓴다.)
 */
const OVERSEAS_DAILY_PATH = "/uapi/overseas-price/v1/quotations/dailyprice";
const OVERSEAS_DAILY_TR_ID = "HHDFS76240000";
const OVERSEAS_GUBN = { D: "0", W: "1", M: "2" };
// 2026-07-11: 미국주식 일봉 캔들이 너무 적다는 피드백 — 약 2년치(거래일 기준 약 500개)로 확대.
const OVERSEAS_CHART_TARGET = { D: 500, W: 200, M: 80 };

function roundSmart(n) {
  if (n == null || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  const decimals = abs < 1 ? 6 : abs < 10 ? 4 : abs < 1000 ? 2 : 0;
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

function mapOverseasDailyCandle(row) {
  if (!row || typeof row !== "object") return null;
  const dateRaw = sanitizeStr(pickFirst(row, ["xymd", "XYMD"]));
  if (!/^\d{8}$/.test(dateRaw)) return null;
  const time = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
  const open = toNum(pickFirst(row, ["open", "OPEN"]));
  const high = toNum(pickFirst(row, ["high", "HIGH"]));
  const low = toNum(pickFirst(row, ["low", "LOW"]));
  const close = toNum(pickFirst(row, ["clos", "CLOS", "close", "CLOSE"]));
  if (open == null || high == null || low == null || close == null) return null;
  const volRaw = toNum(pickFirst(row, ["tvol", "TVOL"]));
  return {
    time,
    open: roundSmart(open),
    high: roundSmart(high),
    low: roundSmart(low),
    close: roundSmart(close),
    volume: volRaw != null && volRaw >= 0 ? Math.round(volRaw) : 0,
  };
}

/** KIS 해외주식 기간별시세는 BYMD를 기준일로 과거 방향 페이지네이션을 지원한다.
 * 국내주식 차트(fetchChartCandles)와 동일한 원칙: 실패해도 지금까지 모은 것만 반환. */
/* 2026-09-09 성능: 해외 기간별시세도 BYMD 커서를 순차로 밀면서 최대 12번 왕복했다(실측 2.4초).
   BYMD는 "그 날짜 기준 과거 100개"를 뜻하므로 커서를 날짜로 미리 계산할 수 있다.
   한 번에 약 100거래일(≈140일)이 오는데 창 간격은 그보다 좁게(115일) 잡아 서로 겹치게 했다 —
   겹치는 만큼 중복은 Map이 걸러내고, 대신 구간이 비는 일이 없다. */
function usWindowPlan(period) {
  if (period === "M") return { step: 2400, count: 2 }; // 월봉 100개/회 — 2회로 충분
  if (period === "W") return { step: 560, count: 3 }; //  주봉 100주/회, 3회 ≈ 300주 ≥ 200
  return { step: 115, count: 8 }; //                      일봉 8회 ≈ 650거래일 ≥ 500
}

async function fetchUsChartWindow(ticker, exchange, gubn, bymd) {
  const j = await kisGetJson(OVERSEAS_DAILY_PATH, OVERSEAS_DAILY_TR_ID, {
    AUTH: "",
    EXCD: exchange,
    SYMB: ticker,
    GUBN: gubn,
    BYMD: bymd,
    MODP: "0",
  });
  let raw = j && j.output2;
  if (raw && !Array.isArray(raw)) raw = [raw];
  if (!Array.isArray(raw)) raw = [];
  const batch = raw.map(mapOverseasDailyCandle).filter(Boolean);
  batch.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return batch;
}

async function fetchUsChartCandles(ticker, exchange, period) {
  const gubn = OVERSEAS_GUBN[period] || "0";
  const target = OVERSEAS_CHART_TARGET[period] || OVERSEAS_CHART_TARGET.D;
  const plan = usWindowPlan(period);
  const endAll = ymdKst(new Date());

  // 첫 창은 BYMD 빈 값(=최신)으로 둔다. KIS가 "오늘"을 어떻게 잡는지에 맡기는 편이
  // 장 시작 직후·서머타임 경계에서 마지막 봉을 놓치지 않는다.
  const cursors = [""];
  for (let i = 1; i < plan.count; i++) {
    cursors.push(subtractCalendarDaysFromYmd(endAll, i * plan.step));
  }

  let firstError = null;
  const results = await Promise.all(
    cursors.map((bymd) =>
      fetchUsChartWindow(ticker, exchange, gubn, bymd).catch((e) => {
        if (!firstError) firstError = e;
        return [];
      })
    )
  );

  const byTime = new Map();
  for (const rows of results) for (const b of rows) byTime.set(b.time, b);

  // 최신 창이 아예 비어 있으면 티커/거래소가 틀린 경우다 — 호출부가 다음 거래소로 넘어가도록
  // 빈 배열을 그대로 돌려준다(기존 동작 유지).
  if (!byTime.size && firstError) throw firstError;

  return [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)).slice(-target);
}

async function handleUsChartRequest(res, ticker, period, exchangeHint) {
  const exchanges = exchangeHint
    ? [exchangeHint, ...US_EXCHANGES.filter((e) => e !== exchangeHint)]
    : US_EXCHANGES;
  let lastErr = null;
  for (const exc of exchanges) {
    try {
      const candles = await fetchUsChartCandles(ticker, exc, period);
      if (candles.length) return json(res, 200, enrichChart(candles, "US"), chartCacheControl(period, false));
    } catch (e) {
      lastErr = e;
    }
  }
  return json(res, 502, { error: (lastErr && lastErr.message) || "차트 데이터가 없습니다." });
}

const CRYPTO_KLINE_INTERVAL = { D: "1d", W: "1w", M: "1M" };
// 2026-07-11: 국내/미국주식과 동일하게 암호화폐도 2년치 캔들을 볼 수 있도록 확대.
// Binance klines limit 최대치는 1000이라 여유 있게 받아온다.
const CRYPTO_KLINE_LIMIT = { D: 730, W: 150, M: 60 };

/** 암호화폐 캔들: Binance 공개 klines 엔드포인트(키 불필요). 스테이블코인(USDT/USDC 등)처럼
 * 자기 자신과의 페어가 없는 심볼은 자연히 실패하며, 그 경우 프런트에서 TradingView로 대체된다. */
const BINANCE_KLINE_HOSTS = [
  // data-api.binance.vision: Binance가 공개 시세 전용으로 제공하는 미러 도메인. api.binance.com은
  // 미국 등 여러 클라우드/데이터센터 IP 대역을 지역 제한(HTTP 451)으로 차단해서, Vercel 서버리스
  // 함수에서 호출하면 종종 막혀 자체 캔들 차트가 TradingView로 폴백되는 원인이었다.
  "https://data-api.binance.vision",
  "https://api.binance.com",
];

async function fetchCryptoChartCandles(symbol, period) {
  const interval = CRYPTO_KLINE_INTERVAL[period] || "1d";
  const limit = CRYPTO_KLINE_LIMIT[period] || CRYPTO_KLINE_LIMIT.D;
  const pair = `${sanitizeStr(symbol).toUpperCase()}USDT`;
  let lastErr = null;
  for (const host of BINANCE_KLINE_HOSTS) {
    try {
      const url = `${host}/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error("Binance klines 응답이 올바르지 않습니다.");
      return mapBinanceKlineRows(rows);
    } catch (e) {
      lastErr = e;
    }
  }
  const err = new Error((lastErr && lastErr.message) || "Binance klines 조회 실패");
  err.statusCode = 502;
  throw err;
}

function mapBinanceKlineRows(rows) {
  return rows
    .map((r) => {
      const openTime = Number(r[0]);
      if (!Number.isFinite(openTime)) return null;
      const time = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date(openTime));
      const open = roundSmart(toNum(r[1]));
      const high = roundSmart(toNum(r[2]));
      const low = roundSmart(toNum(r[3]));
      const close = roundSmart(toNum(r[4]));
      const volume = toNum(r[5]);
      if (open == null || high == null || low == null || close == null) return null;
      return { time, open, high, low, close, volume: volume == null ? 0 : Math.round(volume) };
    })
    .filter(Boolean);
}

async function handleCryptoChartRequest(res, symbol, period) {
  try {
    const candles = await fetchCryptoChartCandles(symbol, period);
    if (!candles.length) return json(res, 502, { error: "차트 데이터가 없습니다." });
    return json(res, 200, enrichChart(candles, "CRYPTO"), chartCacheControl(period, true));
  } catch (e) {
    return json(res, (e && e.statusCode) || 502, { error: (e && e.message) || "차트 데이터가 없습니다." });
  }
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end();
    return;
  }
  if (req.method !== "GET") {
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    const url = new URL(req.url, "http://localhost");
    const market = sanitizeStr(url.searchParams.get("market")).toUpperCase();
    const isChartReq =
      url.searchParams.get("chart") === "1" ||
      url.searchParams.get("mode") === "chart" ||
      /\/kis-chart\/?$/i.test(url.pathname);

    if (market === "CRYPTO") {
      const symbol = sanitizeStr(url.searchParams.get("code") || url.searchParams.get("ticker") || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      if (!symbol) return json(res, 400, { error: "code(심볼)가 필요합니다." });
      const period = normalizePeriod(url.searchParams.get("period") || "D");
      return await handleCryptoChartRequest(res, symbol, period);
    }

    const usTicker = normalizeUsTicker(url.searchParams.get("code") || url.searchParams.get("ticker") || "");
    if (market === "US" || market === "OVERSEAS") {
      if (!usTicker) {
        return json(res, 400, { error: "code(티커)가 필요합니다." });
      }
      if (isChartReq) {
        const period = normalizePeriod(url.searchParams.get("period") || "D");
        const exchangeHint = sanitizeStr(url.searchParams.get("exchange")).toUpperCase();
        return await handleUsChartRequest(res, usTicker, period, exchangeHint);
      }
      const nameHint = sanitizeStr(url.searchParams.get("name"));
      return await handleUsQuoteRequest(res, usTicker, nameHint);
    }

    const code6 = normalizeCode6(url.searchParams.get("code") || "");
    const isChartPath = /\/kis-chart\/?$/i.test(url.pathname);
    const isChart =
      isChartPath || url.searchParams.get("chart") === "1" || url.searchParams.get("mode") === "chart";

    if (!/^[0-9A-Z]{6}$/.test(code6)) {
      return json(res, 400, { error: "code(6자리)가 필요합니다." });
    }

    if (isChart) {
      const period = normalizePeriod(url.searchParams.get("period") || "D");
      return await handleChartRequest(res, code6, period);
    }

    const commonParams = {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code6,
    };

    const [p1, p2] = await Promise.all([
      kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", commonParams),
      kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-price-2", "FHPST01010000", commonParams),
    ]);

    const o1 = (p1 && p1.output) || {};
    const o2 = (p2 && p2.output) || {};

    const currentPrice = toNum(o1.stck_prpr);
    const changeAmt = toNum(o1.prdy_vrss);
    const changeRate = toNum(o1.prdy_ctrt);
    const volume = toNum(o1.acml_vol);
    const tradingValue = toNum(o1.acml_tr_pbmn) || (currentPrice != null && volume != null ? currentPrice * volume : null);
    const mcapRaw = sanitizeStr(o1.hts_avls || o1.stck_avls);

    const prevClose = toNum(o2.stck_prdy_clpr);
    const open = toNum(o2.stck_oprc) ?? toNum(o1.stck_oprc);
    const high = toNum(o2.stck_hgpr) ?? toNum(o1.stck_hgpr);
    const low = toNum(o2.stck_lwpr) ?? toNum(o1.stck_lwpr);
    const prevVolume = toNum(o2.prdy_vol);
    const warn = sanitizeStr(o2.mrkt_warn_cls_name);

    const per = toNum(o1.per);
    const pbr = toNum(o1.pbr);
    const eps = toNum(o1.eps);
    const bps = toNum(o1.bps);

    return json(res, 200, {
      stockCode: code6,
      stockName: sanitizeStr(o1.hts_kor_isnm || o1.prdt_abrv_name || o1.isnm || o2.hts_kor_isnm || ""),
      market: marketLabelFromRow(o1) || marketLabelFromRow(o2),
      currentPrice: currentPrice == null ? null : Math.round(currentPrice),
      changeAmt: changeAmt == null ? null : Math.round(changeAmt),
      changeRate: changeRate == null ? null : Math.round(changeRate * 100) / 100,
      volume: volume == null ? null : Math.round(volume),
      tradingValue: tradingValue == null ? null : Math.round(tradingValue),
      marketCapRaw: mcapRaw || "",
      prevClose: prevClose == null ? null : Math.round(prevClose),
      open: open == null ? null : Math.round(open),
      high: high == null ? null : Math.round(high),
      low: low == null ? null : Math.round(low),
      prevVolume: prevVolume == null ? null : Math.round(prevVolume),
      warn: warn || "",
      financials: {
        per,
        pbr,
        eps,
        bps,
      },
      raw1: o1,
      raw2: o2,
    });
  } catch (e) {
    const status = (e && e.statusCode) || 500;
    return json(res, status, { error: e && e.message ? e.message : String(e) });
  }
};
