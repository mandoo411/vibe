/**
 * 2026-09-25 시우: 사이트 비공개(회원 승인제) 문지기 — Vercel Routing Middleware(엣지).
 * 승인 회원의 출입증 쿠키(tm_pass)가 없으면 페이지는 로그인으로, 데이터·API는 401.
 * 서명 규칙은 lib/site-pass.js와 반드시 같아야 한다.
 * 되돌리려면(사이트 공개) 이 파일을 지우면 된다. 서버 함수 개수(12개 한도)에는 포함되지 않는다.
 */
export const config = { matcher: "/((?!_vercel).*)" };

// 로그인 없이 열려야 하는 곳(로그인·가입·약관 화면, 그 화면들이 쓰는 스크립트·스타일·아이콘)
const PUBLIC_PAGES = new Set([
  "/login.html",
  "/signup.html",
  "/auth-callback.html",
  "/reset-password.html",
  "/consent.html",
  "/terms.html",
  "/privacy.html",
  "/robots.txt",
  "/site.webmanifest",
  "/favicon.ico",
]);
const PUBLIC_EXT = /\.(css|js|mjs|map|woff2?|ttf|otf|svg|png|jpe?g|webp|gif|ico)$/i;

function b64url(buf) {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let keyPromise = null;
function hmacKey() {
  if (keyPromise) return keyPromise;
  const secret = (typeof process !== "undefined" && process.env && process.env.SUPABASE_SERVICE_ROLE_KEY) || "";
  if (!secret) return Promise.resolve(null);
  keyPromise = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode("tm-site-pass-v1:" + secret))
    .then((raw) => crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
  return keyPromise;
}

async function sign(key, text) {
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  const m = raw.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

async function hasValidPass(req, key) {
  const v = readCookie(req, "tm_pass");
  const parts = v.split(".");
  if (parts.length !== 3) return false;
  const [exp, uid, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return (await sign(key, `v1.${exp}.${uid}`)) === sig;
}

function pass() {
  return new Response(null, { headers: { "x-middleware-next": "1" } });
}

export default async function middleware(req) {
  const url = new URL(req.url);
  const path = url.pathname;

  if (PUBLIC_PAGES.has(path)) return pass();
  if (path.startsWith("/icon-") || path.startsWith("/apple-touch-icon")) return pass();
  // 화면 코드(스크립트·스타일·폰트·이미지)는 공개 — 데이터(json·API)와 페이지(html)만 막는다
  if (!path.startsWith("/api/") && !path.startsWith("/data/") && PUBLIC_EXT.test(path)) return pass();
  // 출입증 발급 창구, 결제 웹훅(결제 비활성이지만 외부 호출 경로는 열어 둔다)
  if (path === "/api/analyze" && url.searchParams.get("feature") === "site-pass") return pass();
  if (path.startsWith("/api/payment/")) return pass();

  const key = await hmacKey();
  if (!key) return pass(); // 서버 비밀이 없으면(설정 오류) 사이트가 통째로 막히지 않게 연다

  const machine = req.headers.get("x-tm-machine");
  if (machine && machine === (await sign(key, "tm-machine-v1"))) return pass();

  if (await hasValidPass(req, key)) return pass();

  const isPage = path === "/" || path.endsWith(".html") || !/\.[a-z0-9]+$/i.test(path);
  if (isPage && !path.startsWith("/api/") && !path.startsWith("/data/")) {
    const next = path + url.search;
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/login.html?next=" + encodeURIComponent(next),
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }
  return new Response(JSON.stringify({ error: "members_only" }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
