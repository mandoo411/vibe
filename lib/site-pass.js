/**
 * 2026-09-25 사이트 비공개(회원 승인제) — 출입증 쿠키 서명/검증 (Node 쪽).
 * middleware.js(엣지)에 같은 규칙이 Web Crypto로 다시 구현돼 있다. 둘을 반드시 같이 고칠 것.
 *   키   = SHA-256("tm-site-pass-v1:" + SUPABASE_SERVICE_ROLE_KEY)   ← 새 비밀값 없이 기존 서버 비밀에서 파생
 *   쿠키 = tm_pass=<exp>.<uid>.<base64url(HMAC(키, "v1.<exp>.<uid>"))>
 *   기계 = x-tm-machine: base64url(HMAC(키, "tm-machine-v1"))   (점검봇 등 GitHub Actions용)
 */
const crypto = require("crypto");

const PASS_COOKIE = "tm_pass";
const PASS_EXP_COOKIE = "tm_pass_exp"; // 화면(JS)이 만료 시각만 읽는 용도 — 서명 없음, 권한 없음
const PASS_TTL_SEC = 7 * 24 * 3600;

function passKey() {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!secret) return null;
  return crypto.createHash("sha256").update("tm-site-pass-v1:" + secret).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signPass(uid, ttlSec = PASS_TTL_SEC) {
  const key = passKey();
  if (!key) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = b64url(crypto.createHmac("sha256", key).update(`v1.${exp}.${uid}`).digest());
  return { value: `${exp}.${uid}.${sig}`, exp };
}

function machineToken() {
  const key = passKey();
  if (!key) return null;
  return b64url(crypto.createHmac("sha256", key).update("tm-machine-v1").digest());
}

function passCookies(pass) {
  const common = "Path=/; Secure; SameSite=Lax";
  return [
    `${PASS_COOKIE}=${pass.value}; ${common}; HttpOnly; Max-Age=${PASS_TTL_SEC}`,
    `${PASS_EXP_COOKIE}=${pass.exp}; ${common}; Max-Age=${PASS_TTL_SEC}`,
  ];
}

function clearPassCookies() {
  const common = "Path=/; Secure; SameSite=Lax; Max-Age=0";
  return [`${PASS_COOKIE}=; ${common}; HttpOnly`, `${PASS_EXP_COOKIE}=; ${common}`];
}

/* 2026-10-02 시우: 초대코드 출입 — 회원 가입·승인 없이 코드를 아는 사람에게 출입증을 준다(uid = "invite").
 * 코드 원문은 저장소에 두지 않고 해시만 둔다. 바꾸려면 Vercel 환경변수 SITE_INVITE_HASH에
 * sha256("tm-invite-v1:" + 새코드) 16진수를 넣으면 이 기본값을 덮어쓴다. */
const DEFAULT_INVITE_HASH = "4cf19303d98989517a1594fd6257bb1b0ac59a319c9b988f3eed431266857b1a";
const INVITE_UID = "invite";
const INVITE_TTL_SEC = 30 * 24 * 3600;

function checkInviteCode(code) {
  const c = String(code || "").trim();
  if (!c || c.length > 64) return false;
  const want = Buffer.from(String(process.env.SITE_INVITE_HASH || DEFAULT_INVITE_HASH).trim().toLowerCase(), "hex");
  const got = crypto.createHash("sha256").update("tm-invite-v1:" + c).digest();
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function invitePassCookies(pass) {
  const common = "Path=/; Secure; SameSite=Lax";
  return [
    `${PASS_COOKIE}=${pass.value}; ${common}; HttpOnly; Max-Age=${INVITE_TTL_SEC}`,
    `${PASS_EXP_COOKIE}=${pass.exp}; ${common}; Max-Age=${INVITE_TTL_SEC}`,
  ];
}

/** 요청 쿠키의 출입증을 검증해 uid를 돌려준다(없거나 위조·만료면 null). middleware.js와 같은 규칙. */
function readPassUid(req) {
  try {
    const key = passKey();
    if (!key) return null;
    const raw = (req && req.headers && req.headers.cookie) || "";
    const m = raw.match(/(?:^|;\s*)tm_pass=([^;]*)/);
    if (!m) return null;
    const parts = decodeURIComponent(m[1]).split(".");
    if (parts.length !== 3) return null;
    const [exp, uid, sig] = parts;
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return null;
    const want = b64url(crypto.createHmac("sha256", key).update(`v1.${exp}.${uid}`).digest());
    if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
    return uid || null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  signPass,
  machineToken,
  passCookies,
  clearPassCookies,
  PASS_TTL_SEC,
  checkInviteCode,
  invitePassCookies,
  readPassUid,
  INVITE_UID,
  INVITE_TTL_SEC,
};
