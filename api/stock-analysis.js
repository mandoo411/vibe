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
  const high = toNum(row.stck_hgpr);
  const low = toNum(row.stck_lwpr);
  const open = toNum(row.stck_oprc);
  const high52w = toNum(row.w52_hgpr);
  const low52w = toNum(row.w52_lwpr);

  return {
    raw: row,
    currentPrice: currentPrice == null ? 0 : Math.round(currentPrice),
    change: change == null ? 0 : Math.round(change),
    changeRate: changeRate == null ? 0 : Math.round(changeRate * 100) / 100,
    volume: volume == null ? 0 : Math.round(volume),
    high: high == null ? 0 : Math.round(high),
    low: low == null ? 0 : Math.round(low),
    open: open == null ? 0 : Math.round(open),
    high52w: high52w == null ? 0 : Math.round(high52w),
    low52w: low52w == null ? 0 : Math.round(low52w),
  };
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

  json(res, 200, {
    stockName: resolved.stockName,
    stockCode: resolved.stockCode,
    currentPrice: quote.currentPrice,
    change: quote.change,
    changeRate: quote.changeRate,
    volume: quote.volume,
    high: quote.high,
    low: quote.low,
    open: quote.open,
    high52w: quote.high52w,
    low52w: quote.low52w,
    analysis,
  });
};

