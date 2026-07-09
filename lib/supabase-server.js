/**
 * 서버 전용 Supabase 헬퍼 — service_role 키를 사용해 RLS를 우회한다.
 * 절대 클라이언트에 노출하지 말 것. Vercel 환경변수(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)에서만 읽는다.
 */

function supabaseUrl() {
  return (process.env.SUPABASE_URL || "").replace(/\/$/, "");
}

function serviceRoleKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

function isConfigured() {
  return !!(supabaseUrl() && serviceRoleKey());
}

/** Authorization: Bearer <access_token> 헤더에서 토큰을 꺼낸다. */
function bearerToken(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h) return "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : "";
}

/** access_token으로 Supabase Auth에서 사용자 정보를 검증/조회한다. */
async function getUserFromToken(accessToken) {
  if (!accessToken || !isConfigured()) return null;
  try {
    const res = await fetch(`${supabaseUrl()}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: serviceRoleKey(),
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (e) {
    console.error("[supabase-server] getUserFromToken 실패", e && e.message);
    return null;
  }
}

/** 사용자의 현재 구독(plan/status) 행을 가져온다. 없으면 free/active 취급. */
async function getSubscription(userId) {
  if (!userId || !isConfigured()) return { plan: "free", status: "active" };
  try {
    const url = `${supabaseUrl()}/rest/v1/subscriptions?user_id=eq.${userId}&select=plan,status,current_period_end`;
    const res = await fetch(url, {
      headers: {
        apikey: serviceRoleKey(),
        Authorization: `Bearer ${serviceRoleKey()}`,
      },
    });
    if (!res.ok) return { plan: "free", status: "active" };
    const rows = await res.json();
    return rows && rows[0] ? rows[0] : { plan: "free", status: "active" };
  } catch (e) {
    console.error("[supabase-server] getSubscription 실패", e && e.message);
    return { plan: "free", status: "active" };
  }
}

/** 무료 플랜 월간 사용횟수 증가 시도 (RPC, race-safe). true=허용됨, false=한도초과 */
async function tryIncrementFreeUsage(userId, monthKey, limit) {
  if (!userId || !isConfigured()) return false;
  try {
    const res = await fetch(`${supabaseUrl()}/rest/v1/rpc/increment_analysis_usage`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey(),
        Authorization: `Bearer ${serviceRoleKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_user_id: userId, p_month: monthKey, p_limit: limit }),
    });
    if (!res.ok) return false;
    const allowed = await res.json();
    return allowed === true;
  } catch (e) {
    console.error("[supabase-server] tryIncrementFreeUsage 실패", e && e.message);
    return false;
  }
}

/** 서비스키로 RLS 우회 upsert/insert (결제 확정, 구독 반영 등에 사용) */
async function serviceRequest(path, options) {
  const url = `${supabaseUrl()}/rest/v1/${path.replace(/^\//, "")}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: serviceRoleKey(),
      Authorization: `Bearer ${serviceRoleKey()}`,
      "content-type": "application/json",
      ...(options && options.headers),
    },
  });
  return res;
}

function currentMonthKeySeoul() {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}`;
}

module.exports = {
  isConfigured,
  bearerToken,
  getUserFromToken,
  getSubscription,
  tryIncrementFreeUsage,
  serviceRequest,
  currentMonthKeySeoul,
};
