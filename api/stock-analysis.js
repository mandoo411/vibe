/**
 * AI 종목분석 API (KIS 개별종목 현재가 + Claude 분석)
 * GET /api/stock-analysis?q=삼성전자
 *
 * Required env:
 * - KIS_ACCESS_TOKEN, KIS_APP_KEY, KIS_APP_SECRET
 * - ANTHROPIC_API_KEY (optional: ANTHROPIC_MODEL)
 */

const DEFAULT_KIS_BASE = "https://openapi.koreainvestment.com:9443";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNum(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function pickFirstStr(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const k of keys) {
    if (obj[k] == null) continue;
    const s = sanitizeStr(obj[k]);
    if (s) return s;
  }
  return "";
}

function marketLabelFromRow(row) {
  const hint = pickFirstStr(row, [
    "mrkt_div_cls_code",
    "MRKT_DIV_CLS_CODE",
    "rprs_mrkt_kor_name",
    "RPRS_MRKT_KOR_NAME",
    "rprs_mrkt_name",
    "RPRS_MRKT_NAME",
    "mket_id",
    "MKET_ID",
  ]);
  const blob = String(hint || "").toUpperCase();
  if (/KOSDAQ|KQ|KONEX/.test(blob) || /코스닥/.test(hint)) return "KOSDAQ";
  if (/KOSPI|KS|KRX/.test(blob) || /코스피|유가/.test(hint)) return "KOSPI";
  return hint || "";
}

function parseMarketCapLike(row) {
  const raw = pickFirstStr(row, [
    "hts_avls",
    "HTS_AVLS",
    "stck_avls",
    "STCK_AVLS",
    "mrkt_tot_amt",
    "MRKT_TOT_AMT",
  ]);
  return { raw, value: toNum(raw) };
}

/** KIS 외국인 보유·한도 비율(%) — 0~1 소수·0~100 퍼센트 모두 허용 */
function parseForeignPctField(v) {
  const n = toNum(v);
  if (n == null || !Number.isFinite(n)) return null;
  const x = Math.abs(n) > 0 && Math.abs(n) <= 1 ? n * 100 : n;
  if (!Number.isFinite(x) || x < 0 || x > 100) return null;
  return Math.round(x * 100) / 100;
}

function parseForeignFields(row) {
  const hold = parseForeignPctField(
    pickFirstStr(row, [
      "frgn_hldn_qty_rt",
      "FRGN_HLDN_QTY_RT",
      "hts_frgn_ehrt",
      "HTS_FRGN_EHRT",
      "frgn_hldn_rt",
      "FRGN_HLDN_RT",
      "foreign_rate",
    ])
  );
  let limit = parseForeignPctField(
    pickFirstStr(row, ["frgn_oder_lmt_qty", "FRGN_ODER_LMT_QTY", "hts_frgn_oder_lmt_rt", "HTS_FRGN_ODER_LMT_RT"])
  );
  if (limit == null && hold != null) {
    limit = Math.round((100 - hold) * 100) / 100;
  }
  return { foreignHoldRate: hold, foreignLimitRate: limit };
}

const CREDIT_LOAN_RATE_PRIORITY = [
  "loan_rmnd_ratem",
  "itewhol_loan_rmnd_ratem",
  "crd_rsrv_rate",
  "whol_loan_rmnd_rate",
];

/** 0~1 소수 또는 0~100 퍼센트 → 표시용 % */
function normalizePctRate(n) {
  if (n == null || !Number.isFinite(n)) return null;
  let x = Number(n);
  // KIS whol_loan_rmnd_rate는 0.36 = 0.36% 형태. 0.01 미만만 비율(0.0036→0.36%)로 간주.
  if (Math.abs(x) > 0 && Math.abs(x) < 0.01) x *= 100;
  if (!Number.isFinite(x) || x <= 0 || x > 100) return null;
  return Math.round(x * 100) / 100;
}

function isCreditLoanRatePlausible(n) {
  return n != null && Number.isFinite(n) && n > 0 && n < 15;
}

function creditLoanKeyScore(key) {
  if (key === "loan_rmnd_ratem") return 0;
  if (key === "itewhol_loan_rmnd_ratem") return 1;
  if (key === "crd_rsrv_rate") return 2;
  if (key === "whol_loan_rmnd_rate") return 3;
  if (/loan_rmnd_ratem$/i.test(key)) return 4;
  if (/loan.*rmnd.*rate/i.test(key)) return 5;
  return 9;
}

/** FHKST01010100 output — 신용융자잔고율(약 0.01~10%) 후보 스캔 */
function extractCreditLoanRmndRate(row, stockCode6) {
  const candidates = [];
  for (const [key, raw] of Object.entries(row || {})) {
    if (!/loan|crdt|rmnd|rsrv/i.test(key)) continue;
    const norm = normalizePctRate(toNum(raw));
    if (norm != null) candidates.push({ key, raw, norm });
  }
  console.log(
    "[stock-analysis] FHKST01010100 credit-loan fields",
    stockCode6,
    JSON.stringify(candidates)
  );

  for (const k of CREDIT_LOAN_RATE_PRIORITY) {
    const norm = normalizePctRate(toNum(row[k]));
    if (isCreditLoanRatePlausible(norm)) {
      console.log("[stock-analysis] credit-loan picked", k, norm);
      return norm;
    }
  }

  const plausible = candidates
    .filter((c) => isCreditLoanRatePlausible(c.norm))
    .sort((a, b) => creditLoanKeyScore(a.key) - creditLoanKeyScore(b.key) || a.norm - b.norm);
  if (plausible.length) {
    console.log("[stock-analysis] credit-loan picked (scan)", plausible[0].key, plausible[0].norm);
    return plausible[0].norm;
  }
  return null;
}

function seoulYmd(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function addDaysYmd(ymd, n) {
  const t = new Date(`${ymd}T12:00:00+09:00`).getTime() + n * 86400000;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
}

/** FHKST03010100 output1 — itewhol_loan_rmnd_ratem fallback */
async function kisCreditLoanRateFromDailyChart(stockCode6) {
  const { token, appkey, appsecret } = requireKisCreds();
  const d2 = seoulYmd();
  const d1 = addDaysYmd(d2, -7);
  const url = new URL(
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    kisBaseUrl()
  );
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", stockCode6);
  url.searchParams.set("FID_INPUT_DATE_1", d1.replace(/-/g, ""));
  url.searchParams.set("FID_INPUT_DATE_2", d2.replace(/-/g, ""));
  url.searchParams.set("FID_PERIOD_DIV_CODE", "D");
  url.searchParams.set("FID_ORG_ADJ_PRC", "0");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey,
      appsecret,
      tr_id: "FHKST03010100",
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!res.ok || (data && data.rt_cd && data.rt_cd !== "0")) return null;

  const o1 = (data && data.output1) || {};
  const chartCandidates = Object.entries(o1)
    .filter(([k]) => /loan|crdt|rmnd|rsrv/i.test(k))
    .map(([k, v]) => ({ key: k, raw: v, norm: normalizePctRate(toNum(v)) }))
    .filter((c) => c.norm != null);
  console.log(
    "[stock-analysis] FHKST03010100 credit-loan fields",
    stockCode6,
    JSON.stringify(chartCandidates)
  );

  const norm = normalizePctRate(toNum(o1.itewhol_loan_rmnd_ratem));
  if (isCreditLoanRatePlausible(norm)) {
    console.log("[stock-analysis] credit-loan picked itewhol_loan_rmnd_ratem", norm);
    return norm;
  }
  const plausible = chartCandidates
    .filter((c) => isCreditLoanRatePlausible(c.norm))
    .sort((a, b) => creditLoanKeyScore(a.key) - creditLoanKeyScore(b.key) || a.norm - b.norm);
  if (plausible.length) {
    console.log("[stock-analysis] credit-loan picked (chart scan)", plausible[0].key, plausible[0].norm);
    return plausible[0].norm;
  }
  return null;
}

function parseFinancials(row) {
  const per = toNum(pickFirstStr(row, ["per", "PER", "stck_per", "STCK_PER"]));
  const eps = toNum(pickFirstStr(row, ["eps", "EPS", "stck_eps", "STCK_EPS"]));
  const pbr = toNum(pickFirstStr(row, ["pbr", "PBR", "stck_pbr", "STCK_PBR"]));
  const bps = toNum(pickFirstStr(row, ["bps", "BPS", "stck_bps", "STCK_BPS"]));
  const roe = toNum(pickFirstStr(row, ["roe", "ROE"]));
  const debtRatio = toNum(pickFirstStr(row, ["debt_rt", "DEBT_RT", "debt_ratio", "DEBT_RATIO", "bt_rt"]));
  const dividendYield = toNum(pickFirstStr(row, ["div_yld", "DIV_YLD", "dividend_yield", "dvd_yld"]));
  const { foreignHoldRate, foreignLimitRate } = parseForeignFields(row);
  const listedShares = toNum(pickFirstStr(row, ["lstn_stcn", "LSTN_STCN", "listed_shares"]));
  const parValue = toNum(pickFirstStr(row, ["par", "PAR", "par_value", "stck_par_pric"]));

  return {
    per,
    eps,
    pbr,
    bps,
    roe,
    debtRatio,
    dividendYield,
    foreignHoldRate,
    foreignLimitRate,
    listedShares,
    parValue,
  };
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

function requireAnthropicKey() {
  const k = sanitizeStr(process.env.ANTHROPIC_API_KEY);
  if (!k) {
    const err = new Error("Missing ANTHROPIC_API_KEY");
    err.statusCode = 503;
    throw err;
  }
  return k;
}

function kisBaseUrl() {
  return sanitizeStr(process.env.KIS_BASE_URL || DEFAULT_KIS_BASE).replace(/\/+$/, "");
}

function normalizeNameKey(name) {
  return sanitizeStr(name)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()·•.,/\\'"]/g, "")
    .replace(/주식회사|㈜/g, "");
}

function normalizeCode6(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 6) return digits;
  if (digits.length < 6) return digits.padStart(6, "0");
  return digits.slice(-6);
}

/**
 * 주요 종목 매핑(50개+) — 종목명(한글) 중심 + 일부 영문/별칭 포함
 * 키는 normalizeNameKey 기준
 */
const STOCK_MAP = (() => {
  const rows = [
    ["삼성전자", "005930"],
    ["삼성전자우", "005935"],
    ["SK하이닉스", "000660"],
    ["네이버", "035420"],
    ["NAVER", "035420"],
    ["카카오", "035720"],
    ["현대차", "005380"],
    ["현대자동차", "005380"],
    ["기아", "000270"],
    ["LG에너지솔루션", "373220"],
    ["삼성바이오로직스", "207940"],
    ["셀트리온", "068270"],
    ["삼성SDI", "006400"],
    ["LG화학", "051910"],
    ["POSCO홀딩스", "005490"],
    ["포스코홀딩스", "005490"],
    ["KB금융", "105560"],
    ["신한지주", "055550"],
    ["하나금융지주", "086790"],
    ["현대모비스", "012330"],
    ["삼성물산", "028260"],
    ["삼성생명", "032830"],
    ["삼성화재", "000810"],
    ["삼성전자우선주", "005935"],
    ["삼성전기", "009150"],
    ["SK이노베이션", "096770"],
    ["SK", "034730"],
    ["SK텔레콤", "017670"],
    ["KT", "030200"],
    ["LG전자", "066570"],
    ["LG", "003550"],
    ["두산에너빌리티", "034020"],
    ["한화에어로스페이스", "012450"],
    ["한화솔루션", "009830"],
    ["한화오션", "042660"],
    ["HD현대", "267250"],
    ["HD현대중공업", "329180"],
    ["HD한국조선해양", "009540"],
    ["현대건설", "000720"],
    ["현대글로비스", "086280"],
    ["대한항공", "003490"],
    ["아시아나항공", "020560"],
    ["포스코퓨처엠", "003670"],
    ["LG이노텍", "011070"],
    ["삼성에스디에스", "018260"],
    ["삼성SDS", "018260"],
    ["카카오뱅크", "323410"],
    ["카카오페이", "377300"],
    ["크래프톤", "259960"],
    ["엔씨소프트", "036570"],
    ["넷마블", "251270"],
    ["하이브", "352820"],
    ["아모레퍼시픽", "090430"],
    ["LG생활건강", "051900"],
    ["오리온", "271560"],
    ["CJ제일제당", "097950"],
    ["CJ", "001040"],
    ["대한전선", "001440"],
    ["한국전력", "015760"],
    ["KT&G", "033780"],
    ["SK바이오사이언스", "302440"],
    ["삼성중공업", "010140"],
    ["한화시스템", "272210"],
    ["한국항공우주", "047810"],
    ["KAI", "047810"],
    ["NAVER웹툰", "035420"],
  ];
  const map = new Map();
  for (const [name, code] of rows) {
    map.set(normalizeNameKey(name), { stockName: name, stockCode: code });
  }
  return map;
})();

let STOCK_LIST_CACHE = null;

function getStockList() {
  if (STOCK_LIST_CACHE) return STOCK_LIST_CACHE;
  try {
    STOCK_LIST_CACHE = require("../assets/stock-list.json");
  } catch {
    STOCK_LIST_CACHE = [];
  }
  if (!Array.isArray(STOCK_LIST_CACHE)) STOCK_LIST_CACHE = [];
  return STOCK_LIST_CACHE;
}

function findNameByCode(code6) {
  const hit = getStockList().find((x) => x && normalizeCode6(x.code) === code6);
  return hit ? sanitizeStr(hit.name) : "";
}

function resolveStock(queryRaw) {
  const q = sanitizeStr(queryRaw);
  const code6 = normalizeCode6(q);
  if (/^\d{6}$/.test(code6)) {
    const name = findNameByCode(code6) || q;
    return { stockName: name, stockCode: code6, resolvedBy: "code" };
  }

  const key = normalizeNameKey(q);
  if (!key) return null;
  const hit = STOCK_MAP.get(key);
  if (hit) return { stockName: hit.stockName, stockCode: hit.stockCode, resolvedBy: "map" };

  const list = getStockList();
  const exact = list.find((x) => x && normalizeNameKey(x.name) === key);
  if (exact) {
    return {
      stockName: sanitizeStr(exact.name),
      stockCode: normalizeCode6(exact.code),
      resolvedBy: "list",
    };
  }

  const partial = list.filter((x) => {
    if (!x || !x.name) return false;
    const nk = normalizeNameKey(x.name);
    return nk.includes(key) || key.includes(nk);
  });
  if (partial.length === 1) {
    return {
      stockName: sanitizeStr(partial[0].name),
      stockCode: normalizeCode6(partial[0].code),
      resolvedBy: "list-partial",
    };
  }

  const embedded = (q.match(/\b\d{6}\b/) || [])[0];
  if (embedded) {
    const name = findNameByCode(embedded) || q;
    return { stockName: name, stockCode: embedded, resolvedBy: "embedded" };
  }

  return null;
}

async function kisInquirePrice(stockCode6) {
  const { token, appkey, appsecret } = requireKisCreds();
  const url = new URL(
    "/uapi/domestic-stock/v1/quotations/inquire-price",
    kisBaseUrl()
  );
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", stockCode6);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey,
      appsecret,
      tr_id: "FHKST01010100",
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`KIS invalid JSON: ${text.slice(0, 200)}`);
    err.statusCode = 502;
    throw err;
  }
  if (!res.ok || (data && data.rt_cd && data.rt_cd !== "0")) {
    const msg = (data && (data.msg1 || data.msg_cd)) || `HTTP ${res.status}`;
    const err = new Error(`KIS error: ${msg}`);
    err.statusCode = 502;
    throw err;
  }

  const row = data && data.output ? data.output : {};
  const currentPrice = toNum(row.stck_prpr);
  const change = toNum(row.prdy_vrss);
  const changeRate = toNum(row.prdy_ctrt);
  const volume = toNum(row.acml_vol);
  const volTurnoverRate = toNum(row.vol_tnrt);
  let creditLoanRmndRate = extractCreditLoanRmndRate(row, stockCode6);
  if (creditLoanRmndRate == null) {
    try {
      creditLoanRmndRate = await kisCreditLoanRateFromDailyChart(stockCode6);
    } catch (e) {
      console.warn("[stock-analysis] chart credit-loan fallback failed", stockCode6, e && e.message);
    }
  }
  console.log("[stock-analysis] price1", stockCode6, "vol_tnrt=", row.vol_tnrt, "creditLoanRmndRate=", creditLoanRmndRate);
  const tradingValue =
    currentPrice != null && volume != null && currentPrice > 0 && volume > 0
      ? Math.round(currentPrice * volume)
      : null;
  const prevClose = toNum(row.stck_sdpr || row.prdy_clpr || row.prdy_clpr_prpr || row.stck_prpr);
  const high = toNum(row.stck_hgpr);
  const low = toNum(row.stck_lwpr);
  const open = toNum(row.stck_oprc);
  const high52w = toNum(row.w52_hgpr);
  const low52w = toNum(row.w52_lwpr);
  const upperLimit = toNum(row.stck_mxpr);
  const lowerLimit = toNum(row.stck_llam);
  const market = marketLabelFromRow(row);
  const mcap = parseMarketCapLike(row);
  const financials = parseFinancials(row);

  return {
    raw: row,
    currentPrice: currentPrice == null ? 0 : Math.round(currentPrice),
    change: change == null ? 0 : Math.round(change),
    changeRate: changeRate == null ? 0 : Math.round(changeRate * 100) / 100,
    volume: volume == null ? 0 : Math.round(volume),
    volTurnoverRate: volTurnoverRate == null ? null : Math.round(volTurnoverRate * 100) / 100,
    creditLoanRmndRate: creditLoanRmndRate == null ? null : creditLoanRmndRate,
    wholLoanRmndRate: creditLoanRmndRate == null ? null : creditLoanRmndRate,
    tradingValue: tradingValue == null ? null : Math.round(tradingValue),
    prevClose: prevClose == null ? null : Math.round(prevClose),
    high: high == null ? 0 : Math.round(high),
    low: low == null ? 0 : Math.round(low),
    open: open == null ? 0 : Math.round(open),
    high52w: high52w == null ? 0 : Math.round(high52w),
    low52w: low52w == null ? 0 : Math.round(low52w),
    upperLimit: upperLimit == null ? null : Math.round(upperLimit),
    lowerLimit: lowerLimit == null ? null : Math.round(lowerLimit),
    market,
    marketCap: mcap.value,
    marketCapRaw: mcap.raw,
    per: financials.per,
    financials,
  };
}

async function kisInquirePrice2(stockCode6) {
  const { token, appkey, appsecret } = requireKisCreds();
  const url = new URL(
    "/uapi/domestic-stock/v1/quotations/inquire-price-2",
    kisBaseUrl()
  );
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", stockCode6);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey,
      appsecret,
      tr_id: "FHPST01010000",
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`KIS invalid JSON: ${text.slice(0, 200)}`);
    err.statusCode = 502;
    throw err;
  }
  if (!res.ok || (data && data.rt_cd && data.rt_cd !== "0")) {
    const msg = (data && (data.msg1 || data.msg_cd)) || `HTTP ${res.status}`;
    const err = new Error(`KIS error: ${msg}`);
    err.statusCode = 502;
    throw err;
  }

  const row = data && data.output ? data.output : {};
  const creditRate = toNum(row.crdt_rate);
  const creditLoanBalance = toNum(
    pickFirstStr(row, [
      "crdt_loan_rmnd",
      "crdt_loan_bal",
      "crdt_loan_blce",
      "crdt_loan_amt",
      "crdt_loan",
      "crdt_blce",
      "crdt_rmnd",
    ])
  );
  console.log("[stock-analysis] price2", stockCode6, "crdt_rate=", row.crdt_rate, "credit_loan=", creditLoanBalance);
  try {
    const keys = Object.keys(row || {}).filter((k) => /crdt|loan|rmnd/i.test(k)).slice(0, 30);
    if (keys.length) console.log("[stock-analysis] price2 keys", stockCode6, keys);
  } catch (_) {}
  return {
    raw2: row,
    creditRate: creditRate == null ? null : Math.round(creditRate * 100) / 100,
    creditLoanBalance: creditLoanBalance == null ? null : Math.round(creditLoanBalance),
  };
}

async function naverGetJson(path) {
  const url = `https://m.stock.naver.com${path}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`NAVER HTTP ${res.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

async function fetchNaverStockBasic(code6) {
  const b = await naverGetJson(`/api/stock/${encodeURIComponent(code6)}/basic`);
  return b && typeof b === "object" ? b : null;
}

async function fetchNaverStockPrice(code6) {
  const arr = await naverGetJson(`/api/stock/${encodeURIComponent(code6)}/price?pageSize=1&page=1`);
  const row = Array.isArray(arr) ? arr[0] : null;
  return row && typeof row === "object" ? row : null;
}

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNaverFinanceNumber(cellText) {
  const s = sanitizeStr(cellText)
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 네이버 금융(PC) 종목 메인에서 최근 분기 실적(매출/영업이익/당기순이익) 추출.
 * - 반환 단위: 네이버 표기(억) 그대로 숫자
 * - 구조 변경에 대비해 HTML 전체에서 행 단위로 방어적 파싱
 */
async function fetchNaverQuarterProfit(code6) {
  const url = `https://finance.naver.com/item/main.nhn?code=${encodeURIComponent(code6)}`;
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });
  const html = await res.text();
  if (!res.ok || !html) return null;

  // cop_analysis 구간을 우선적으로 좁히되, 실패 시 전체에서 검색
  let scope = html;
  const m = html.match(/<div class="section cop_analysis"[\s\S]*?<\/div>\s*<!--\s*\/\/\s*section cop_analysis\s*-->/i);
  if (m && m[0]) scope = m[0];

  // 분기 컬럼 라벨(YYYY.MM) 후보를 뽑아 마지막 값을 baseDate로 사용
  const cols = [];
  const thRe = /<th[^>]*scope=["']col["'][^>]*>([\s\S]*?)<\/th>/gi;
  let th;
  while ((th = thRe.exec(scope))) {
    const t = stripTags(th[1]);
    if (/^\d{4}\.\d{2}$/.test(t)) cols.push(t);
  }
  const baseDate = cols.length ? cols[cols.length - 1] : "";

  function pickLatestFromRow(labelKorean) {
    // labelKorean이 들어간 th를 찾고, 같은 tr의 td들을 전부 긁는다.
    const rowRe = new RegExp(
      `<tr[^>]*>[\\s\\S]*?<th[^>]*>[\\s\\S]*?${labelKorean}[\\s\\S]*?<\\/th>([\\s\\S]*?)<\\/tr>`,
      "i"
    );
    const rm = scope.match(rowRe) || html.match(rowRe);
    if (!rm || !rm[1]) return null;
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let td;
    while ((td = tdRe.exec(rm[1]))) {
      const txt = stripTags(td[1]);
      tds.push(txt);
    }
    // 오른쪽(최근)부터 숫자 찾기 (빈칸/추정(E) 등 제외)
    for (let i = tds.length - 1; i >= 0; i--) {
      const n = parseNaverFinanceNumber(tds[i]);
      if (n != null) return n;
    }
    return null;
  }

  const revenue = pickLatestFromRow("매출액");
  const operatingProfit = pickLatestFromRow("영업이익");
  const netIncome = pickLatestFromRow("당기순이익");

  if (revenue == null && operatingProfit == null && netIncome == null) return null;
  return {
    revenue,
    operatingProfit,
    netIncome,
    baseDate,
    source: "naver",
  };
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
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`KIS invalid JSON (${path}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || (json && json.rt_cd && json.rt_cd !== "0")) {
    throw new Error(`KIS error (${path})`);
  }
  return json;
}

function pickAnyNumberByRegex(row, reList) {
  if (!row || typeof row !== "object") return null;
  for (const [k, v] of Object.entries(row)) {
    for (const re of reList) {
      if (!re.test(k)) continue;
      const n = toNum(v);
      if (n != null) return n;
    }
  }
  return null;
}

function yyyymmddKST(daysBack = 0) {
  // Vercel 런타임이 UTC일 수 있으므로 Asia/Seoul 기준으로 날짜를 만든다.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const d = new Date();
  if (daysBack > 0) d.setDate(d.getDate() - daysBack);
  const s = fmt.format(d);
  return s.replace(/-/g, "");
}

function parseSignedQty(v) {
  const s = sanitizeStr(v).replace(/,/g, "").replace(/^\+/, "");
  if (!s) return null;
  return toNum(s);
}

/** NAVER trend — 순매수 수량 × 종가로 거래대금(억원) 추정 (KIS 수급 TR 실패 시 fallback) */
async function fetchNaverStockSupply(code6) {
  const rows = await naverGetJson(`/api/stock/${encodeURIComponent(code6)}/trend?pageSize=1&page=1`);
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!row || typeof row !== "object") return null;
  const price = toNum(String(row.closePrice || "").replace(/,/g, ""));
  if (price == null || price <= 0) return null;

  function qtyToEok(qty) {
    if (qty == null || !Number.isFinite(qty)) return null;
    return Math.round((qty * price) / 1e8);
  }

  const institution = qtyToEok(parseSignedQty(row.organPureBuyQuant));
  const individual = qtyToEok(parseSignedQty(row.individualPureBuyQuant));
  const foreigner = qtyToEok(parseSignedQty(row.foreignerPureBuyQuant));
  const baseDate = sanitizeStr(row.bizdate);
  if (institution == null && individual == null && foreigner == null) return null;

  return {
    institution,
    individual,
    foreigner,
    baseDate,
    unit: "eok",
    source: "naver-trend",
  };
}

/**
 * 종목별 투자자 매매동향(일별) — 문서 기준 TR
 * - TR_ID: FHPTJ04160001
 * - URL: /uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily
 * - 핵심 필드: prsn_ntby_qty / frgn_ntby_qty / orgn_ntby_qty
 */
async function kisInvestorTradeByStockDaily(stockCode6) {
  for (let daysBack = 0; daysBack < 7; daysBack++) {
    let json;
    try {
      json = await kisGetJson("/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily", "FHPTJ04160001", {
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: stockCode6,
        FID_INPUT_DATE_1: yyyymmddKST(daysBack),
        FID_ORG_ADJ_PRC: "",
        FID_ETC_CLS_CODE: "1",
      });
    } catch {
      continue;
    }
    // 문서: output1(object), output2(array)
    const rows = Array.isArray(json.output2) ? json.output2 : Array.isArray(json.output) ? json.output : null;
    const row =
      Array.isArray(rows) && rows.length
        ? rows
            .slice()
            .map((r) => ({ r, d: sanitizeStr(r?.stck_bsop_date || r?.STCK_BSOP_DATE || r?.bsop_date || r?.date) }))
            .sort((a, b) => Number(b.d || 0) - Number(a.d || 0))[0]?.r
        : null;
    if (!row || typeof row !== "object") continue;

    const institution =
      toNum(row.orgn_ntby_qty ?? row.orgn_ntby_vol ?? row.orgn_ntby) ??
      pickAnyNumberByRegex(row, [/orgn.*ntby/i, /orgn.*net/i, /inst.*net/i]);
    const foreigner =
      toNum(row.frgn_ntby_qty ?? row.frgn_ntby_vol ?? row.frgn_ntby) ??
      pickAnyNumberByRegex(row, [/frgn.*ntby/i, /frgn.*net/i, /foreign.*net/i]);
    const individual =
      toNum(row.prsn_ntby_qty ?? row.prsn_ntby_vol ?? row.prsn_ntby) ??
      pickAnyNumberByRegex(row, [/prsn.*ntby/i, /prsn.*net/i, /indv.*net/i]);
    const baseDate = pickFirstStr(row, ["stck_bsop_date", "STCK_BSOP_DATE", "bsop_date", "date"]);
    const instPbmn = toNum(row.orgn_ntby_tr_pbmn ?? row.orgn_ntby_pbmn ?? row.orgn_ntby_tr_amt ?? row.orgn_ntby_amt);
    const frgnPbmn = toNum(row.frgn_ntby_tr_pbmn ?? row.frgn_ntby_pbmn ?? row.frgn_ntby_tr_amt ?? row.frgn_ntby_amt);
    const prsnPbmn = toNum(row.prsn_ntby_tr_pbmn ?? row.prsn_ntby_pbmn ?? row.prsn_ntby_tr_amt ?? row.prsn_ntby_amt);

    // tr_pbmn: 백만원 단위 → 억원 (pbmn / 100)
    const instEokFromPbmn = instPbmn == null ? null : Math.round(instPbmn / 100);
    const frgnEokFromPbmn = frgnPbmn == null ? null : Math.round(frgnPbmn / 100);
    const prsnEokFromPbmn = prsnPbmn == null ? null : Math.round(prsnPbmn / 100);

    const hasPbmn = instEokFromPbmn != null || frgnEokFromPbmn != null || prsnEokFromPbmn != null;
    if (!hasPbmn && institution == null && foreigner == null && individual == null) continue;

    return {
      institution: instEokFromPbmn != null ? instEokFromPbmn : institution,
      foreigner: frgnEokFromPbmn != null ? frgnEokFromPbmn : foreigner,
      individual: prsnEokFromPbmn != null ? prsnEokFromPbmn : individual,
      baseDate,
      unit: hasPbmn ? "eok" : "qty",
      source: "FHPTJ04160001",
      raw: row,
    };
  }
  return null;
}

async function kisInquireInvestor(stockCode6) {
  const json = await kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-investor", "FHKST01010900", {
    FID_COND_MRKT_DIV_CODE: "J",
    FID_INPUT_ISCD: stockCode6,
  });
  const o = json.output ?? json.output1 ?? json.output2;
  const pickLatest = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return null;
    const withDate = arr
      .map((r) => {
        const d = sanitizeStr(r && (r.stck_bsop_date || r.bsop_date || r.date || r.STCK_BSOP_DATE));
        const n = d && /^\d{8}$/.test(d) ? Number(d) : null;
        return { r, n };
      })
      .filter((x) => x && x.r && typeof x.r === "object");
    if (!withDate.length) return arr[0];
    withDate.sort((a, b) => (b.n || 0) - (a.n || 0));
    return withDate[0].r;
  };
  const row = Array.isArray(o) ? pickLatest(o) : o;
  if (!row || typeof row !== "object") return null;

  const institution =
    toNum(row.orgn_ntby_qty ?? row.orgn_ntby_vol ?? row.orgn_ntby) ??
    pickAnyNumberByRegex(row, [/orgn.*ntby/i, /orgn.*net/i, /inst.*net/i]);
  const foreigner =
    toNum(row.frgn_ntby_qty ?? row.frgn_ntby_vol ?? row.frgn_ntby) ??
    pickAnyNumberByRegex(row, [/frgn.*ntby/i, /frgn.*net/i, /foreign.*net/i]);
  const individual =
    toNum(row.prsn_ntby_qty ?? row.prsn_ntby_vol ?? row.prsn_ntby) ??
    pickAnyNumberByRegex(row, [/prsn.*ntby/i, /prsn.*net/i, /indv.*net/i]);

  // 일부 응답은 문자열에 +, 공백, 콤마가 섞일 수 있음 → toNum에서 정규화됨
  // 최신일자를 함께 내려서 UI에서 기준을 표시할 수 있게 함
  const baseDate = pickFirstStr(row, ["stck_bsop_date", "STCK_BSOP_DATE", "bsop_date", "date"]);
  return { institution, foreigner, individual, baseDate, raw: row };
}

/** 수급 값이 수량(qty)이면 현재가로 거래대금(억원) 환산 */
function normalizeSupplyToEok(supply, currentPrice) {
  if (!supply || typeof supply !== "object") return supply;
  if (supply.unit === "eok") return supply;
  const price = toNum(currentPrice);
  if (price == null || price <= 0) return supply;
  const toEok = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round((Number(v) * price) / 1e8));
  return {
    ...supply,
    institution: toEok(supply.institution),
    individual: toEok(supply.individual),
    foreigner: toEok(supply.foreigner),
    unit: "eok",
  };
}

async function kisIncomeStatement(stockCode6) {
  try {
    // Income statement TR_ID: FHKST66430200
    // 환경에 따라 파라미터 키가 대소문자에 민감한 케이스가 있어 2번 시도
    const tryOnce = async (params) =>
      kisGetJson("/uapi/domestic-stock/v1/finance/income-statement", "FHKST66430200", params);
    let json;
    try {
      // 문서(v1_국내주식-079): FID_DIV_CLS_CODE 필수 (0:년, 1:분기)
      json = await tryOnce({ FID_DIV_CLS_CODE: "1", FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: stockCode6 });
    } catch {
      json = await tryOnce({ FID_DIV_CLS_CODE: "1", fid_cond_mrkt_div_code: "J", fid_input_iscd: stockCode6 });
    }
    let out = json.output ?? json.output1 ?? json.output2;
    if (out && !Array.isArray(out)) out = [out];
    const row =
      Array.isArray(out) && out.length
        ? out
            .slice()
            .map((r) => ({
              r,
              y: sanitizeStr(r?.stac_yymm || r?.STAC_YYMM || r?.stacYm || r?.date),
            }))
            .sort((a, b) => Number(b.y || 0) - Number(a.y || 0))[0]?.r
        : null;
    if (!row || typeof row !== "object") return null;
    const revenue =
      // 문서(v1_국내주식-079): sale_account = 매출액
      toNum(row.sale_account ?? row.sale_amt ?? row.sales ?? row.revenue) ??
      pickAnyNumberByRegex(row, [/sale_account/i, /sale_amt/i, /sale|sales|revenue/i]);
    const op =
      // income-statement에는 영업이익이 여러 형태로 있을 수 있어 후보 확장
      // 문서(v1_국내주식-079): bsop_prti = 영업이익
      toNum(row.bsop_prti ?? row.bsop_prfi ?? row.oprt_prfi ?? row.operating_income ?? row.op_profit) ??
      pickAnyNumberByRegex(row, [/bsop.*prt[i1]|bsop.*prfi|op.*prfi|oper.*income|op.*profit/i]);
    const net =
      toNum(row.thtr_ntin ?? row.net_income ?? row.net_profit) ??
      pickAnyNumberByRegex(row, [/ntin|net.*income|net.*profit/i]);
    const baseDate = pickFirstStr(row, ["stac_yymm", "STAC_YYMM", "base_date", "BASE_DATE", "date"]);
    if (revenue == null && op == null && net == null) return null;
    return { revenue, operatingProfit: op, netIncome: net, baseDate, source: "kis", raw: row };
  } catch {
    return null;
  }
}

function stripCodeFences(text) {
  let t = String(text || "").trim();
  // ```json ... ``` or ``` ... ```
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return t;
}

function safeParseJsonOnly(text) {
  const t = stripCodeFences(text);
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) throw new Error("Claude returned non-JSON");
  const sliced = t.slice(first, last + 1);
  return JSON.parse(sliced);
}

const CLAUDE_SYSTEM_PROMPT =
  "당신은 한국 주식 전문 애널리스트입니다.\n" +
  "제공된 데이터를 기반으로 분석하되\n" +
  "일반 투자자도 이해할 수 있는 언어로 작성하세요.\n" +
  "반드시 JSON 형식으로만 응답하고\n" +
  "다른 텍스트는 절대 포함하지 마세요.";

const CLAUDE_RESPONSE_SCHEMA = `{
  "summary": {
    "signal": "매수|관망|회피",
    "probability": 75,
    "description": "3줄 이내 핵심 요약 (일반인 언어)"
  },
  "story": "왜 지금 이 가격인가 - 최근 상승/하락 이유, 테마/섹터 흐름 스토리텔링",
  "supply": "수급 분석 - 외국인/기관 동향, 거래량 변화 직관적으로",
  "events": [
    {"type": "호재|악재", "content": "이벤트 내용", "date": "날짜 또는 예정"}
  ],
  "chart": "차트 흐름 - 지지/저항, 이평선 배열, 현재 위치",
  "opinion": {
    "short": "단기 시나리오",
    "mid": "중기 시나리오",
    "long": "장기 시나리오",
    "entry": 0,
    "stop": 0,
    "target": 0,
    "comment": "저라면 이렇게 접근하겠다"
  },
  "signals": {
    "up": 6,
    "down": 2
  }
}`;

function normalizeSignal(v) {
  const s = sanitizeStr(v);
  if (s === "매수" || s === "관망" || s === "회피") return s;
  return "관망";
}

function normalizeAnalysis(raw, quote) {
  const price = toNum(quote && quote.currentPrice) || 0;
  if (!raw || typeof raw !== "object") {
    return {
      summary: {
        signal: "관망",
        probability: 50,
        description: "분석을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      },
      story: "",
      supply: "",
      events: [],
      chart: "",
      opinion: {
        short: "",
        mid: "",
        long: "",
        entry: price,
        stop: 0,
        target: 0,
        comment: "",
      },
      signals: { up: 0, down: 0 },
      _error: true,
    };
  }

  const summary = raw.summary && typeof raw.summary === "object" ? raw.summary : {};
  const probRaw = toNum(summary.probability);
  const probability =
    probRaw == null ? 50 : Math.max(0, Math.min(100, Math.round(probRaw)));

  const events = Array.isArray(raw.events)
    ? raw.events
        .filter((e) => e && typeof e === "object")
        .map((e) => ({
          type: sanitizeStr(e.type) === "악재" ? "악재" : "호재",
          content: sanitizeStr(e.content),
          date: sanitizeStr(e.date),
        }))
        .filter((e) => e.content)
    : [];

  const opinion = raw.opinion && typeof raw.opinion === "object" ? raw.opinion : {};
  const signals = raw.signals && typeof raw.signals === "object" ? raw.signals : {};
  const up = toNum(signals.up);
  const down = toNum(signals.down);

  return {
    summary: {
      signal: normalizeSignal(summary.signal),
      probability,
      description: sanitizeStr(summary.description) || "요약 정보가 없습니다.",
    },
    story: sanitizeStr(raw.story),
    supply: sanitizeStr(raw.supply),
    events,
    chart: sanitizeStr(raw.chart),
    opinion: {
      short: sanitizeStr(opinion.short),
      mid: sanitizeStr(opinion.mid),
      long: sanitizeStr(opinion.long),
      entry: toNum(opinion.entry) ?? price,
      stop: toNum(opinion.stop) ?? 0,
      target: toNum(opinion.target) ?? 0,
      comment: sanitizeStr(opinion.comment),
    },
    signals: {
      up: up == null ? 0 : Math.max(0, Math.round(up)),
      down: down == null ? 0 : Math.max(0, Math.round(down)),
    },
  };
}

async function claudeAnalyze(input) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: requireAnthropicKey() });
  const model = sanitizeStr(process.env.ANTHROPIC_MODEL) || "claude-sonnet-4-20250514";

  const user = [
    "아래 데이터를 받아서 반드시 JSON 형식으로만 응답하세요.",
    "코드블록(```) 금지, 설명 문장 금지, JSON 외 문자 금지.",
    "",
    CLAUDE_RESPONSE_SCHEMA,
    "",
    "입력 데이터:",
    JSON.stringify(input),
  ].join("\n");

  const msg = await client.messages.create({
    model,
    max_tokens: 2200,
    temperature: 0.25,
    system: CLAUDE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: user }],
  });

  const text =
    msg && Array.isArray(msg.content)
      ? msg.content
          .filter((c) => c && c.type === "text")
          .map((c) => c.text)
          .join("\n")
      : "";
  const parsed = safeParseJsonOnly(text);
  return normalizeAnalysis(parsed, input);
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

  const q =
    sanitizeStr(req.query && (req.query.q || req.query.query || req.query.name || req.query.code)) ||
    "";

  const resolved = resolveStock(q);
  if (!resolved) {
    json(res, 200, { error: "종목을 찾을 수 없습니다" });
    return;
  }

  let quote;
  let supply = null;
  try {
    const [q1, q2, supplyRaw] = await Promise.all([
      kisInquirePrice(resolved.stockCode),
      kisInquirePrice2(resolved.stockCode),
      kisInvestorTradeByStockDaily(resolved.stockCode).catch(() => null),
    ]);
    quote = { ...q1, creditRate: q2.creditRate, creditLoanBalance: q2.creditLoanBalance };
    supply = supplyRaw;
    if (!supply) {
      try {
        supply = await kisInquireInvestor(resolved.stockCode);
      } catch (e) {
        console.warn("[stock-analysis] investor failed", e && e.message);
      }
    }
    if (!supply) {
      try {
        supply = await fetchNaverStockSupply(resolved.stockCode);
      } catch (e2) {
        console.warn("[stock-analysis] naver supply failed", e2 && e2.message);
      }
    }
  } catch (e) {
    console.error("[stock-analysis] KIS error", resolved.stockCode, e && e.message, e);
    json(res, 502, { error: "시세 조회 실패" });
    return;
  }

  const supplyForAi = normalizeSupplyToEok(supply, quote.currentPrice);

  let analysis;
  try {
    analysis = await claudeAnalyze({
      stockName: resolved.stockName,
      stockCode: resolved.stockCode,
      market: quote.market || "",
      currentPrice: quote.currentPrice,
      change: quote.change,
      changeRate: quote.changeRate,
      volume: quote.volume,
      volTurnoverRate: quote.volTurnoverRate,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      prevClose: quote.prevClose,
      high52w: quote.high52w,
      low52w: quote.low52w,
      creditRate: quote.creditRate,
      creditLoanBalance: quote.creditLoanBalance,
      creditLoanRmndRate: quote.creditLoanRmndRate,
      marketCap: quote.marketCap,
      per: quote.per,
      financials: quote.financials,
      supply: supplyForAi,
    });
  } catch (e) {
    console.error("[stock-analysis] Claude error", e && e.message, e);
    analysis = normalizeAnalysis(null, quote);
  }

  let profit = null;
  try {
    profit = await kisIncomeStatement(resolved.stockCode);
  } catch (e) {
    console.warn("[stock-analysis] income failed", e && e.message);
  }
  // 실적: KIS가 비거나 제한되면 네이버(PC) 분기 실적을 fallback으로 채움
  if (!profit) {
    try {
      profit = await fetchNaverQuarterProfit(resolved.stockCode);
    } catch (e) {
      console.warn("[stock-analysis] naver profit failed", e && e.message);
    }
  }

  const quoteFields = await (async () => {
    try {
      const [nb, np] = await Promise.all([
        fetchNaverStockBasic(resolved.stockCode),
        fetchNaverStockPrice(resolved.stockCode),
      ]);
      const stockName = sanitizeStr(nb && nb.stockName) || resolved.stockName;
      const market = sanitizeStr(nb && (nb.stockExchangeName || nb.stockExchangeType?.nameEng)) || quote.market || "";
      const currentPrice = toNum(np && np.closePrice) ?? quote.currentPrice;
      const change = toNum(np && np.compareToPreviousClosePrice) ?? quote.change;
      const changeRate = toNum(np && np.fluctuationsRatio) ?? quote.changeRate;
      const open = toNum(np && np.openPrice) ?? quote.open;
      const high = toNum(np && np.highPrice) ?? quote.high;
      const low = toNum(np && np.lowPrice) ?? quote.low;
      const volume = toNum(np && np.accumulatedTradingVolume) ?? quote.volume;
      const prevClose = currentPrice != null && change != null ? currentPrice - change : quote.prevClose ?? null;
      return {
        stockName,
        stockCode: resolved.stockCode,
        market,
        prevClose,
        currentPrice,
        change,
        changeRate,
        open,
        high,
        low,
        volume,
      };
    } catch {
      return {
        stockName: resolved.stockName,
        stockCode: resolved.stockCode,
        market: quote.market || "",
        prevClose: quote.prevClose,
        currentPrice: quote.currentPrice,
        change: quote.change,
        changeRate: quote.changeRate,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        volume: quote.volume,
      };
    }
  })();

  const tradingValueNxt =
    quoteFields.currentPrice != null &&
    quoteFields.volume != null &&
    Number(quoteFields.currentPrice) > 0 &&
    Number(quoteFields.volume) > 0
      ? Math.round(Number(quoteFields.currentPrice) * Number(quoteFields.volume))
      : quote.tradingValue == null
        ? null
        : quote.tradingValue;

  json(res, 200, {
    ...quoteFields,
    volTurnoverRate: quote.volTurnoverRate == null ? null : quote.volTurnoverRate,
    creditRate: quote.creditRate == null ? null : quote.creditRate,
    creditLoanBalance: quote.creditLoanBalance == null ? null : quote.creditLoanBalance,
    creditLoanRmndRate: quote.creditLoanRmndRate == null ? null : quote.creditLoanRmndRate,
    wholLoanRmndRate: quote.creditLoanRmndRate == null ? null : quote.creditLoanRmndRate,
    whol_loan_rmnd_rate: quote.creditLoanRmndRate == null ? null : quote.creditLoanRmndRate,
    tradingValue: tradingValueNxt,
    foreignHoldRate: quote.financials?.foreignHoldRate ?? null,
    foreignLimitRate: quote.financials?.foreignLimitRate ?? null,
    marketCap: quote.marketCap == null ? null : quote.marketCap,
    marketCapRaw: quote.marketCapRaw || "",
    per: quote.per == null ? null : quote.per,
    financials: quote.financials || null,
    supply: normalizeSupplyToEok(supply, quoteFields.currentPrice),
    profit,
    high52w: quote.high52w,
    low52w: quote.low52w,
    analysis,
  });
};

