/**
 * 매매 시그널 — 전략 CRUD
 * GET    /api/trade-signal-strategies         내 전략 목록 + 최근 시그널 이력(최대 30건)
 * POST   /api/trade-signal-strategies         전략 저장 (api/trade-signal-parse.js 결과를 그대로 전달)
 * PATCH  /api/trade-signal-strategies?id=...  { status: "active"|"paused" }
 * DELETE /api/trade-signal-strategies?id=...
 *
 * 전부 로그인 + Pro/Premium 필요. 쓰기는 SUPABASE_SERVICE_ROLE_KEY로만 수행하고
 * (RLS를 우회하므로) 모든 쿼리에 user_id=eq.<본인> 필터를 직접 붙여서 본인 데이터만
 * 접근하도록 강제한다 — subscriptions/orders와 같은 서버 전용 쓰기 패턴.
 */

const {
  bearerToken,
  getUserFromToken,
  getSubscription,
  serviceRequest,
} = require("../lib/supabase-server");

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

function isValidCondition(condition) {
  if (!condition || typeof condition !== "object") return false;
  if (condition.logic !== "AND") return false;
  if (!Array.isArray(condition.clauses) || !condition.clauses.length) return false;
  return condition.clauses.every(
    (c) => c && typeof c === "object" && ALLOWED_CLAUSE_TYPES.includes(sanitizeStr(c.type))
  );
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

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});

  try {
    const user = await requireProUser(req);
    const id = req.query && req.query.id ? String(req.query.id) : "";

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
    console.error("[trade-signal-strategies] 실패", error && error.message);
    return json(res, error.statusCode || 500, { error: error.message || "요청 처리에 실패했습니다." });
  }
};
