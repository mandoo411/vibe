/**
 * 매매 시그널 — 자연어 조건 → 구조화 조건(jsonb) 파싱
 * POST /api/trade-signal-parse
 * body: { text: "삼성전자 20일선이 60일선 상향 돌파하면 매수 알려줘" }
 *
 * 저장은 하지 않는다 — 사용자가 확인/수정 후 /api/trade-signal-strategies POST로 별도 저장.
 * Pro/Premium 전용 기능(무료 체험 없음).
 *
 * 종목 매칭은 AI에게 통째로 맡기지 않고 assets/stock-list.json에서 먼저 후보를 찾아
 * 프롬프트에 넣어준다 — AI가 존재하지 않는 종목코드를 지어내는 걸 막기 위함(그라운딩).
 * 조건 판정(스캔)은 이 결과의 condition(jsonb)만 보고 도니까, AI 호출은 전략을
 * 만들 때 딱 한 번만 발생한다.
 */

const {
  bearerToken,
  getUserFromToken,
  getSubscription,
} = require("../lib/supabase-server");

const STOCK_LIST = require("../assets/stock-list.json");

const CLAUDE_MODEL = "claude-sonnet-4-6";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
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

function requireOpenAIKey() {
  const k = sanitizeStr(process.env.OPENAI_API_KEY);
  if (!k) {
    const err = new Error("Missing OPENAI_API_KEY");
    err.statusCode = 503;
    throw err;
  }
  return k;
}

// 일부 종목은 공식 상장명이 영문이라(NAVER 등) 사용자가 흔히 쓰는 한글 표기와 다르다.
// 이런 경우 exact-match가 아예 실패해서 부정확한 부분일치로 새는 걸 막기 위해
// 알려진 만큼만 별칭을 붙여서 텍스트에 보강해준다.
const STOCK_NAME_ALIASES = {
  네이버: "NAVER",
};

/** 입력 문장에서 언급된 종목 후보를 찾는다 — 정확히 일치하는 종목명을 최우선으로,
 * 없으면 ETF를 제외한 KOSPI/KOSDAQ 종목명 부분일치로 최대 8개까지 후보를 준다.
 * 부분일치는 오탐(예: "네이버"가 무관한 종목 "네이블"과 매칭)을 줄이기 위해
 * 이름이 충분히 긴 종목에만, 그것도 끝 1글자만 빠진 수준으로만 허용한다. */
function findStockCandidates(text) {
  const t = sanitizeStr(text);
  if (!t) return [];
  let searchText = t;
  for (const [alias, official] of Object.entries(STOCK_NAME_ALIASES)) {
    if (t.includes(alias)) searchText += ` ${official}`;
  }

  let exact = STOCK_LIST.filter((s) => s.market !== "ETF" && searchText.includes(s.name));
  if (exact.length) {
    // 짧은 이름이 더 긴 이름의 부분 문자열이라 같이 걸린 경우(예: "SK"가 "SK하이닉스"에 포함)
    // 더 긴 쪽만 남긴다.
    exact = exact.filter(
      (s) => !exact.some((other) => other !== s && other.name.length > s.name.length && other.name.includes(s.name))
    );
    return exact.sort((a, b) => b.name.length - a.name.length).slice(0, 8);
  }

  const partial = STOCK_LIST.filter(
    (s) => s.market !== "ETF" && s.name.length >= 4 && searchText.includes(s.name.slice(0, s.name.length - 1))
  );
  return partial.slice(0, 8);
}

const CONDITION_GUIDE = `condition.clauses[].type로 쓸 수 있는 값과 필드 (이 목록 밖의 type은 절대 쓰지 말 것):
- ma_cross: {fast:20|60|120, slow:60|120|200, direction:"up"|"down"} — 이동평균선끼리 골든/데드크로스
- price_cross_ma: {period:20|60|120|200, direction:"up"|"down"} — 현재가가 이동평균선을 돌파
- rsi: {op:"lt"|"lte"|"gt"|"gte", value:0~100} — RSI(14) 값 조건
- volume_ratio: {op:"gte"|"gt", value: 숫자(%)} — 20일 평균 거래량 대비 당일 거래량 비율(%)
- high52w_breakout: {} — 52주 신고가 갱신
- low52w_breakdown: {} — 52주 신저가 갱신
- price_change_pct: {op:"gte"|"lte", value: 숫자(%, 부호 포함)} — 당일 등락률 조건
여러 조건을 언급했으면 clauses 배열에 여러 개 넣고 logic은 기본 "AND".`;

const TOOL = {
  name: "parse_trade_condition",
  description: "자연어 매매 조건을 종목 + 구조화 조건으로 변환",
  input_schema: {
    type: "object",
    required: ["matched", "alertType", "condition", "summary"],
    properties: {
      matched: { type: "boolean", description: "후보 목록에서 종목을 확정할 수 있었는지" },
      stockCode: { type: "string", description: "확정된 종목코드(6자리), matched=false면 빈 문자열" },
      stockName: { type: "string", description: "확정된 종목명, matched=false면 빈 문자열" },
      alertType: { type: "string", enum: ["buy", "sell"], description: "매수/매도 중 어떤 알림인지" },
      condition: {
        type: "object",
        required: ["logic", "clauses"],
        properties: {
          logic: { type: "string", enum: ["AND"] },
          clauses: {
            type: "array",
            items: {
              type: "object",
              required: ["type"],
              properties: {
                type: { type: "string" },
                fast: { type: "number" },
                slow: { type: "number" },
                period: { type: "number" },
                direction: { type: "string" },
                op: { type: "string" },
                value: { type: "number" },
              },
            },
          },
        },
      },
      summary: { type: "string", description: "사용자에게 보여줄 한 줄 요약 (예: '20일선이 60일선을 상향 돌파하면')" },
      clarifyMessage: { type: "string", description: "matched=false이거나 조건을 이해 못했을 때 사용자에게 보여줄 안내 문구" },
    },
  },
};

function buildPrompt(text, candidates) {
  const candidateLines = candidates.length
    ? candidates.map((c) => `- ${c.name} (${c.code}, ${c.market})`).join("\n")
    : "(문장에서 종목명을 찾지 못함)";
  return [
    "당신은 한국 주식 매매 조건을 구조화하는 파서입니다.",
    "사용자 입력 문장을 읽고 parse_trade_condition 도구를 반드시 호출해서 결과를 반환하세요.",
    "",
    `사용자 입력: "${text}"`,
    "",
    "종목 후보 (이 목록에 있는 종목코드/종목명만 사용할 것 — 목록에 없는 종목코드를 새로 만들어내지 말 것):",
    candidateLines,
    "",
    "후보 목록의 종목명이 사용자가 실제로 언급한 종목과 일치하는지 먼저 확인할 것 (예: 사용자가 '네이버'라고 썼는데 후보가 전혀 다른 회사면 matched=false).",
    "후보가 여러 개이거나 없거나, 후보가 사용자 언급과 명백히 다르면 matched=false로 반환하고 clarifyMessage에 '어떤 종목인지 정확히 말씀해주세요' 같은 안내를 담을 것.",
    "후보가 정확히 하나이고 사용자 언급과 실제로 일치하면 matched=true.",
    "",
    CONDITION_GUIDE,
    "",
    "조건을 전혀 파악할 수 없으면(예: 기술적 조건이 아닌 요청) matched=false, clarifyMessage에 이유를 설명할 것.",
  ].join("\n");
}

async function parseWithClaude(text, candidates) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: requireAnthropicKey() });
  const prompt = buildPrompt(text, candidates);
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "parse_trade_condition" },
    messages: [{ role: "user", content: prompt }],
  });
  const block = (res.content || []).find((b) => b && b.type === "tool_use" && b.name === "parse_trade_condition");
  if (!block) throw new Error("Claude가 parse_trade_condition을 호출하지 않았습니다.");
  return block.input;
}

async function parseWithOpenAI(text, candidates) {
  const apiKey = requireOpenAIKey();
  const model = sanitizeStr(process.env.OPENAI_MODEL) || "gpt-5.4-mini";
  const prompt = buildPrompt(text, candidates);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "JSON만 반환하세요. 다른 설명 텍스트 금지." },
        { role: "user", content: `${prompt}\n\n다음 JSON 스키마로만 응답하세요: ${JSON.stringify(TOOL.input_schema)}` },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const body = await res.json();
  const text2 = body?.choices?.[0]?.message?.content;
  if (!text2) throw new Error("OpenAI 응답에 내용이 없습니다.");
  return JSON.parse(text2);
}

function normalizeClause(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = sanitizeStr(raw.type);
  const allowed = [
    "ma_cross",
    "price_cross_ma",
    "rsi",
    "volume_ratio",
    "high52w_breakout",
    "low52w_breakdown",
    "price_change_pct",
  ];
  if (!allowed.includes(type)) return null;
  const out = { type };
  if (raw.fast != null) out.fast = Number(raw.fast);
  if (raw.slow != null) out.slow = Number(raw.slow);
  if (raw.period != null) out.period = Number(raw.period);
  if (raw.direction) out.direction = sanitizeStr(raw.direction) === "down" ? "down" : "up";
  if (raw.op) out.op = sanitizeStr(raw.op);
  if (raw.value != null) out.value = Number(raw.value);
  return out;
}

function normalizeResult(raw, candidates) {
  const matched = raw && raw.matched === true;
  const stockCode = sanitizeStr(raw && raw.stockCode);
  const stockName = sanitizeStr(raw && raw.stockName);
  const validCandidate = candidates.find((c) => c.code === stockCode);
  const clauses = Array.isArray(raw?.condition?.clauses)
    ? raw.condition.clauses.map(normalizeClause).filter(Boolean)
    : [];

  if (!matched || !validCandidate || !clauses.length) {
    return {
      matched: false,
      clarifyMessage:
        sanitizeStr(raw && raw.clarifyMessage) ||
        (candidates.length > 1
          ? "어떤 종목인지 정확히 말씀해주세요 (예: 삼성전자, SK하이닉스)."
          : "조건을 이해하지 못했어요. 예: '삼성전자 20일선이 60일선 상향 돌파하면 매수 알려줘'"),
    };
  }

  const alertType = sanitizeStr(raw.alertType) === "sell" ? "sell" : "buy";
  return {
    matched: true,
    stockCode: validCandidate.code,
    stockName: validCandidate.name,
    alertType,
    condition: { logic: "AND", clauses },
    summary: sanitizeStr(raw.summary) || `${validCandidate.name} 조건 충족 시 ${alertType === "buy" ? "매수" : "매도"} 알림`,
    rawText: "",
  };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return json(res, 400, { error: "잘못된 요청 본문입니다." });
  }

  const text = sanitizeStr(body.text).slice(0, 300);
  if (!text) return json(res, 400, { error: "조건 문장을 입력해주세요." });

  const token = bearerToken(req);
  const user = await getUserFromToken(token);
  if (!user) return json(res, 401, { error: "로그인이 필요합니다." });

  const sub = await getSubscription(user.id);
  const isPro = sub.status === "active" && (sub.plan === "pro" || sub.plan === "premium");
  if (!isPro) {
    return json(res, 402, {
      error: "매매 시그널은 Pro/Premium 전용 기능입니다. 요금제 페이지에서 업그레이드해주세요.",
    });
  }

  const candidates = findStockCandidates(text);

  try {
    let raw;
    try {
      raw = await parseWithClaude(text, candidates);
    } catch (claudeErr) {
      console.error("[trade-signal-parse] Claude 실패, OpenAI로 폴백", claudeErr && claudeErr.message);
      raw = await parseWithOpenAI(text, candidates);
    }
    const result = normalizeResult(raw, candidates);
    if (result.matched) result.rawText = text;
    return json(res, 200, result);
  } catch (error) {
    console.error("[trade-signal-parse] 실패", error && error.message);
    return json(res, error.statusCode || 500, {
      error: error.message || "조건 해석에 실패했습니다. 다시 시도해주세요.",
    });
  }
};
