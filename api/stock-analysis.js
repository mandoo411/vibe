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

function parseFinancials(row) {
  const per = toNum(pickFirstStr(row, ["per", "PER", "stck_per", "STCK_PER"]));
  const eps = toNum(pickFirstStr(row, ["eps", "EPS", "stck_eps", "STCK_EPS"]));
  const pbr = toNum(pickFirstStr(row, ["pbr", "PBR", "stck_pbr", "STCK_PBR"]));
  const bps = toNum(pickFirstStr(row, ["bps", "BPS", "stck_bps", "STCK_BPS"]));
  const roe = toNum(pickFirstStr(row, ["roe", "ROE"]));
  const debtRatio = toNum(pickFirstStr(row, ["debt_rt", "DEBT_RT", "debt_ratio", "DEBT_RATIO", "bt_rt"]));
  const dividendYield = toNum(pickFirstStr(row, ["div_yld", "DIV_YLD", "dividend_yield", "dvd_yld"]));
  const foreignHoldRate = toNum(pickFirstStr(row, ["frgn_hldn_rt", "FRGN_HLDN_RT", "foreign_rate"]));
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

function resolveStock(queryRaw) {
  const q = sanitizeStr(queryRaw);
  const code6 = normalizeCode6(q);
  if (/^\d{6}$/.test(code6)) return { stockName: q, stockCode: code6, resolvedBy: "code" };

  const key = normalizeNameKey(q);
  if (!key) return null;
  const hit = STOCK_MAP.get(key);
  if (hit) return { stockName: hit.stockName, stockCode: hit.stockCode, resolvedBy: "map" };

  // 약한 보조: "삼성전자 005930" 같은 입력에서 6자리만 추출
  const embedded = (q.match(/\b\d{6}\b/) || [])[0];
  if (embedded) return { stockName: q, stockCode: embedded, resolvedBy: "embedded" };

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
  const tradingValue = toNum(row.acml_tr_pbmn || row.acml_tr_pbmn_krw || row.acml_tr_pbmn_won);
  const prevClose = toNum(row.stck_sdpr || row.prdy_clpr || row.prdy_clpr_prpr || row.stck_prpr);
  const high = toNum(row.stck_hgpr);
  const low = toNum(row.stck_lwpr);
  const open = toNum(row.stck_oprc);
  const high52w = toNum(row.w52_hgpr);
  const low52w = toNum(row.w52_lwpr);
  const market = marketLabelFromRow(row);
  const mcap = parseMarketCapLike(row);
  const financials = parseFinancials(row);

  return {
    raw: row,
    currentPrice: currentPrice == null ? 0 : Math.round(currentPrice),
    change: change == null ? 0 : Math.round(change),
    changeRate: changeRate == null ? 0 : Math.round(changeRate * 100) / 100,
    volume: volume == null ? 0 : Math.round(volume),
    tradingValue: tradingValue == null ? null : Math.round(tradingValue),
    prevClose: prevClose == null ? null : Math.round(prevClose),
    high: high == null ? 0 : Math.round(high),
    low: low == null ? 0 : Math.round(low),
    open: open == null ? 0 : Math.round(open),
    high52w: high52w == null ? 0 : Math.round(high52w),
    low52w: low52w == null ? 0 : Math.round(low52w),
    market,
    marketCap: mcap.value,
    marketCapRaw: mcap.raw,
    per: financials.per,
    financials,
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

  return { institution, foreigner, individual, raw: row };
}

async function kisIncomeStatement(stockCode6) {
  try {
    // Income statement TR_ID: FHKST66430200 (66430100은 대차대조표로 알려짐)
    const json = await kisGetJson("/uapi/domestic-stock/v1/finance/income-statement", "FHKST66430200", {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: stockCode6,
    });
    let out = json.output ?? json.output1 ?? json.output2;
    if (out && !Array.isArray(out)) out = [out];
    const row = Array.isArray(out) && out.length ? out[0] : null;
    if (!row || typeof row !== "object") return null;
    const revenue =
      toNum(row.sale_amt ?? row.sales ?? row.revenue) ?? pickAnyNumberByRegex(row, [/sale|sales|revenue/i]);
    const op =
      toNum(row.oprt_prfi ?? row.operating_income ?? row.op_profit) ??
      pickAnyNumberByRegex(row, [/op.*prfi|oper.*income|op.*profit/i]);
    const net =
      toNum(row.thtr_ntin ?? row.net_income ?? row.net_profit) ??
      pickAnyNumberByRegex(row, [/ntin|net.*income|net.*profit/i]);
    const baseDate = pickFirstStr(row, ["stac_yymm", "STAC_YYMM", "base_date", "BASE_DATE", "date"]);
    return { revenue, operatingProfit: op, netIncome: net, baseDate, raw: row };
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

async function claudeAnalyze(input) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: requireAnthropicKey() });
  const model = sanitizeStr(process.env.ANTHROPIC_MODEL) || "claude-sonnet-4-5";

  const user = [
    "너는 한국 주식 단기 트레이딩 보조 애널리스트다.",
    "아래 시세 데이터를 기반으로만 판단하고, 모르는 정보는 추측하지 마라.",
    "",
    "반드시 다음 JSON 형식으로만 답하라. 코드블록(``` ) 금지, 설명 문장 금지, JSON 외 문자 금지.",
    '{ "summary": "...", "technicalAnalysis": "...", "buyZone": "...", "stopLoss": "...", "targetPrice": "...", "opinion": "강력매수/매수/중립/매도/강력매도", "reason": "..." }',
    "",
    "입력 데이터:",
    JSON.stringify(input),
  ].join("\n");

  const msg = await client.messages.create({
    model,
    max_tokens: 700,
    temperature: 0.2,
    messages: [{ role: "user", content: user }],
  });

  const text =
    msg && Array.isArray(msg.content)
      ? msg.content
          .filter((c) => c && c.type === "text")
          .map((c) => c.text)
          .join("\n")
      : "";
  return safeParseJsonOnly(text);
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
  try {
    quote = await kisInquirePrice(resolved.stockCode);
  } catch (e) {
    console.error("[stock-analysis] KIS error", resolved.stockCode, e && e.message, e);
    json(res, 502, { error: "시세 조회 실패" });
    return;
  }

  let analysis;
  try {
    analysis = await claudeAnalyze({
      stockName: resolved.stockName,
      stockCode: resolved.stockCode,
      currentPrice: quote.currentPrice,
      change: quote.change,
      changeRate: quote.changeRate,
      volume: quote.volume,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      high52w: quote.high52w,
      low52w: quote.low52w,
    });
  } catch (e) {
    console.error("[stock-analysis] Claude error", e && e.message, e);
    analysis = {
      summary: "현재 분석을 생성할 수 없습니다.",
      technicalAnalysis: "현재 분석을 생성할 수 없습니다.",
      buyZone: "",
      stopLoss: "",
      targetPrice: "",
      opinion: "중립",
      reason: "Claude 응답 오류로 분석을 생성하지 못했습니다.",
    };
  }

  let supply = null;
  let profit = null;
  try {
    supply = await kisInquireInvestor(resolved.stockCode);
  } catch (e) {
    console.warn("[stock-analysis] investor failed", e && e.message);
  }
  try {
    profit = await kisIncomeStatement(resolved.stockCode);
  } catch (e) {
    console.warn("[stock-analysis] income failed", e && e.message);
  }

  json(res, 200, {
  // 네이버(모바일) 값이 있는 경우 UI 표시값은 네이버 우선 (스크린샷 기준)
    ...(await (async () => {
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
        const prevClose =
          currentPrice != null && change != null ? currentPrice - change : quote.prevClose ?? null;
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
    })()),
    tradingValue: quote.tradingValue == null ? null : quote.tradingValue,
    marketCap: quote.marketCap == null ? null : quote.marketCap,
    marketCapRaw: quote.marketCapRaw || "",
    per: quote.per == null ? null : quote.per,
    financials: quote.financials || null,
    supply,
    profit,
    high52w: quote.high52w,
    low52w: quote.low52w,
    analysis,
  });
};

