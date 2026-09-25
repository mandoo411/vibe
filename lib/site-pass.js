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

module.exports = { signPass, machineToken, passCookies, clearPassCookies, PASS_TTL_SEC };
