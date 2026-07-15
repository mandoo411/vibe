/**
 * 매매 시그널 — 파싱 + 전략 CRUD 통합 엔드포인트
 *
 * 2026-07-15: 원래 api/trade-signal-parse.js + api/trade-signal-strategies.js
 * 두 파일로 나눠서 만들었다가, Vercel Hobby 플랜의 서버리스 함수 개수 제한(12개)에
 * 걸려서 배포가 실패했다(기존 12개 + 신규 2개 = 14개). vercel.json의 functions 설정이
 * 정확히 12개로 맞춰져 있던 걸 보면 이미 한도까지 다 쓰고 있었던 것 — 두 파일을
 * 하나로 합쳐서 신규 함수 1개만 추가되도록 했다.
 *
 * POST /api/trade-signal?action=parse   자연어 조건 파싱 (저장 안 함)
 *   body: { text: "삼성전자 20일선이 60일선 상향 돌파하면 매수 알려줘" }
 * GET    /api/trade-signal              내 전략 목록 + 최근 시그널 이력(최대 30건)
 * POST   /api/trade-signal              전략 저장 (parse 결과를 그대로 전달)
 * PATCH  /api/trade-signal?id=...       { status: "active"|"paused" }
 * DELETE /api/trade-signal?id=...
 *
 * 전부 로그인 + Pro/Premium 필요.
 */

const {
  bearerToken,
  getUserFromToken,
  getSubscription,
  serviceRequest,
} = require("../lib/supabase-server");

const STOCK_LIST = require("../assets/stock-list.json");

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_ACTIVE_STRATEGIES = 20;
const ALLOWED_CLAUSE_TYPES = [
  "ma_cross",
  "price_cross_ma",
  "rsi",
  "volume_ratio",
  "high52w_breakout",
  "low52w_breakdown",
  "price_change_pct",
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function requireProUser(req) {
  const token = bearerToken(req);
  const user = await getUserFromToken(token);
  if (!user) {
    const err = new Error("로그인이 필요합니다.");
    err.statusCode = 401;
    throw err;
  }
  const sub = await getSubscription(user.id);
  const isPro = sub.status === "active" && (sub.plan === "pro" || sub.plan === "premium");
  if (!isPro) {
    const err = new Error("매매 시그널은 Pro/Premium 전용 기능입니다.");
    err.statusCode = 402;
    throw err;
  }
  return user;
}

/* ───────────────────────── 파싱(자연어 -> 구조화 조건) ───────────────────────── */

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

const STOCK_NAME_ALIASES = {
  네이버: "NAVER",
};

function findStockCandidates(text) {
  const t = sanitizeStr(text);
  if (!t) return [];
  let searchText = t;
  for (const [alias, official] of Object.entries(STOCK_NAME_ALIASES)) {
    if (t.includes(alias)) searchText += ` ${official}`;
  }

  let exact = STOCK_LIST.filter((s) => s.market !== "ETF" && searchText.includes(s.name));
  if (exact.length) {
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

const PARSE_TOOL = {
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

function buildParsePrompt(text, candidates) {
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
  const prompt = buildParsePrompt(text, candidates);
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    tools: [PARSE_TOOL],
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
  const prompt = buildParsePrompt(text, candidates);
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
        { role: "user", content: `${prompt}\n\n다음 JSON 스키마로만 응답하세요: ${JSON.stringify(PARSE_TOOL.input_schema)}` },
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
  if (!ALLOWED_CLAUSE_TYPES.includes(type)) return null;
  const out = { type };
  if (raw.fast != null) out.fast = Number(raw.fast);
  if (raw.slow != null) out.slow = Number(raw.slow);
  if (raw.period != null) out.period = Number(raw.period);
  if (raw.direction) out.direction = sanitizeStr(raw.direction) === "down" ? "down" : "up";
  if (raw.op) out.op = sanitizeStr(raw.op);
  if (raw.value != null) out.value = Number(raw.value);
  return out;
}

function normalizeParseResult(raw, candidates) {
  const matched = raw && raw.matched === true;
  const stockCode = sanitizeStr(raw && raw.stockCode);
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

async function handleParse(req, res, user) {
  const body = await readBody(req);
  const text = sanitizeStr(body.text).slice(0, 300);
  if (!text) return json(res, 400, { error: "조건 문장을 입력해주세요." });

  const candidates = findStockCandidates(text);
  let raw;
  try {
    raw = await parseWithClaude(text, candidates);
  } catch (claudeErr) {
    console.error("[trade-signal parse] Claude 실패, OpenAI로 폴백", claudeErr && claudeErr.message);
    raw = await parseWithOpenAI(text, candidates);
  }
  const result = normalizeParseResult(raw, candidates);
  if (result.matched) result.rawText = text;
  return json(res, 200, result);
}

/* ───────────────────────── 전략 CRUD ───────────────────────── */

function isValidCondition(condition) {
  if (!condition || typeof condition !== "object") return false;
  if (condition.logic !== "AND") return false;
  if (!Array.isArray(condition.clauses) || !condition.clauses.length) return false;
  return condition.clauses.every(
    (c) => c && typeof c === "object" && ALLOWED_CLAUSE_TYPES.includes(sanitizeStr(c.type))
  );
}

async function listStrategies(user, res) {
  const stratRes = await serviceRequest(
    `trade_signal_strategies?user_id=eq.${user.id}&order=created_at.desc&select=*`,
    { method: "GET" }
  );
  if (!stratRes.ok) throw new Error(`전략 목록 조회 실패 (HTTP ${stratRes.status})`);
  const strategies = await stratRes.json();

  const eventsRes = await serviceRequest(
    `trade_signal_events?user_id=eq.${user.id}&order=triggered_at.desc&limit=30&select=*`,
    { method: "GET" }
  );
  const events = eventsRes.ok ? await eventsRes.json() : [];

  return json(res, 200, { strategies, events });
}

async function createStrategy(user, body, res) {
  const stockCode = sanitizeStr(body.stockCode);
  const stockName = sanitizeStr(body.stockName);
  const rawText = sanitizeStr(body.rawText).slice(0, 300);
  const alertType = sanitizeStr(body.alertType) === "sell" ? "sell" : "buy";
  const condition = body.condition;

  if (!stockCode || !stockName || !rawText || !isValidCondition(condition)) {
    return json(res, 400, { error: "전략 정보가 올바르지 않습니다. 조건을 다시 확인해주세요." });
  }

  const countRes = await serviceRequest("rpc/count_active_trade_signal_strategies", {
    method: "POST",
    body: JSON.stringify({ p_user_id: user.id }),
  });
  const activeCount = countRes.ok ? await countRes.json() : 0;
  if (Number(activeCount) >= MAX_ACTIVE_STRATEGIES) {
    return json(res, 400, {
      error: `전략은 최대 ${MAX_ACTIVE_STRATEGIES}개까지 감시할 수 있습니다. 기존 전략을 정리한 뒤 다시 시도해주세요.`,
    });
  }

  const insertRes = await serviceRequest("trade_signal_strategies", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      user_id: user.id,
      market: "KR",
      stock_code: stockCode,
      stock_name: stockName,
      raw_text: rawText,
      alert_type: alertType,
      condition,
      status: "active",
    }),
  });
  if (!insertRes.ok) {
    const errText = await insertRes.text().catch(() => "");
    throw new Error(`전략 저장 실패 (HTTP ${insertRes.status}): ${errText.slice(0, 200)}`);
  }
  const rows = await insertRes.json();
  return json(res, 200, { strategy: rows && rows[0] ? rows[0] : null });
}

async function updateStrategy(user, id, body, res) {
  if (!id) return json(res, 400, { error: "id가 필요합니다." });
  const status = sanitizeStr(body.status);
  if (status !== "active" && status !== "paused") {
    return json(res, 400, { error: "status는 active 또는 paused여야 합니다." });
  }
  const patchRes = await serviceRequest(
    `trade_signal_strategies?id=eq.${encodeURIComponent(id)}&user_id=eq.${user.id}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    }
  );
  if (!patchRes.ok) throw new Error(`전략 수정 실패 (HTTP ${patchRes.status})`);
  const rows = await patchRes.json();
  if (!rows || !rows.length) return json(res, 404, { error: "전략을 찾을 수 없습니다." });
  return json(res, 200, { strategy: rows[0] });
}

async function deleteStrategy(user, id, res) {
  if (!id) return json(res, 400, { error: "id가 필요합니다." });
  const delRes = await serviceRequest(
    `trade_signal_strategies?id=eq.${encodeURIComponent(id)}&user_id=eq.${user.id}`,
    { method: "DELETE", headers: { Prefer: "return=minimal" } }
  );
  if (!delRes.ok) throw new Error(`전략 삭제 실패 (HTTP ${delRes.status})`);
  return json(res, 200, { ok: true });
}

/* ───────────────────────── 라우팅 ───────────────────────── */

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});

  try {
    const user = await requireProUser(req);
    const action = req.query && req.query.action ? String(req.query.action) : "";
    const id = req.query && req.query.id ? String(req.query.id) : "";

    if (req.method === "POST" && action === "parse") return await handleParse(req, res, user);

    if (req.method === "GET") return await listStrategies(user, res);
    if (req.method === "POST") {
      const body = await readBody(req);
      return await createStrategy(user, body, res);
    }
    if (req.method === "PATCH") {
      const body = await readBody(req);
      return await updateStrategy(user, id, body, res);
    }
    if (req.method === "DELETE") return await deleteStrategy(user, id, res);

    return json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error("[trade-signal] 실패", error && error.message);
    return json(res, error.statusCode || 500, { error: error.message || "요청 처리에 실패했습니다." });
  }
};
