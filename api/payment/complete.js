/**
 * POST /api/payment/complete
 * body: { paymentId: string, plan: "pro" | "premium" }
 * header: Authorization: Bearer <supabase access_token>
 *
 * 클라이언트(pricing.html)에서 포트원 결제창 승인 콜백을 받은 직후 호출한다.
 * 서버가 다시 포트원 REST API로 결제건을 조회해 "진짜 결제완료"인지 재검증한 뒤에만
 * Supabase subscriptions/orders 테이블을 갱신한다. (클라이언트 값만 믿지 않음)
 *
 * Required env:
 * - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * - PORTONE_API_SECRET
 */

const { bearerToken, getUserFromToken, serviceRequest, isConfigured: supabaseConfigured } = require("../../lib/supabase-server");
const { verifyPaidPayment, isConfigured: portoneConfigured } = require("../../lib/portone-server");

const PLAN_AMOUNTS = { pro: 9900, premium: 19900 };

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  if (!supabaseConfigured() || !portoneConfigured()) {
    return json(res, 503, { ok: false, error: "결제/인증 서버 환경변수가 아직 설정되지 않았습니다." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
  }
  body = body || {};

  const paymentId = String(body.paymentId || "").trim();
  const plan = String(body.plan || "").trim();
  if (!paymentId || !PLAN_AMOUNTS[plan]) {
    return json(res, 400, { ok: false, error: "paymentId/plan 값이 올바르지 않습니다." });
  }

  const token = bearerToken(req);
  const user = await getUserFromToken(token);
  if (!user) return json(res, 401, { ok: false, error: "로그인이 필요합니다." });

  let verify;
  try {
    verify = await verifyPaidPayment(paymentId, PLAN_AMOUNTS[plan]);
  } catch (e) {
    console.error("[payment/complete] 포트원 검증 실패", e && e.message);
    return json(res, 502, { ok: false, error: "결제 검증 중 오류가 발생했습니다." });
  }

  // 주문 기록은 성공/실패 모두 남긴다 (중복 paymentId는 무시)
  await serviceRequest("orders", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify({
      user_id: user.id,
      payment_id: paymentId,
      order_name: `TotalMoney AI ${plan} 구독`,
      plan,
      amount: PLAN_AMOUNTS[plan],
      status: verify.ok ? "paid" : "failed",
      raw_response: verify.payment || null,
    }),
  }).catch((e) => console.error("[payment/complete] orders insert 실패", e && e.message));

  if (!verify.ok) {
    return json(res, 402, { ok: false, error: `결제 상태 확인 실패 (status=${verify.status})` });
  }

  const now = new Date();
  const periodEnd = new Date(now.getTime());
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  const subRes = await serviceRequest(`subscriptions?user_id=eq.${user.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      plan,
      status: "active",
      started_at: now.toISOString(),
      current_period_end: periodEnd.toISOString(),
    }),
  });

  if (!subRes.ok) {
    // 행이 아직 없다면 upsert 형태로 insert 시도 (신규가입 트리거가 이미 만들어두지만 방어적으로)
    await serviceRequest("subscriptions", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        user_id: user.id,
        plan,
        status: "active",
        started_at: now.toISOString(),
        current_period_end: periodEnd.toISOString(),
      }),
    }).catch((e) => console.error("[payment/complete] subscriptions upsert 실패", e && e.message));
  }

  return json(res, 200, { ok: true, plan, currentPeriodEnd: periodEnd.toISOString() });
};
