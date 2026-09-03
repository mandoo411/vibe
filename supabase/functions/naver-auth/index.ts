/**
 * TotalMoney AI — 네이버 로그인 콜백 (Supabase Edge Function)
 * ---------------------------------------------------------------------------
 * 왜 Vercel이 아니라 Supabase에 있나?
 *   Vercel Hobby 플랜은 배포당 서버리스 함수가 12개로 제한되는데 이미 12/12로 꽉 차 있다.
 *   네이버는 Supabase가 기본 지원하는 provider가 아니라 서버 코드가 반드시 필요하므로,
 *   Vercel 함수 슬롯을 쓰지 않는 Supabase Edge Function으로 뺐다.
 *
 * 흐름
 *   1) 브라우저: nid.naver.com/oauth2.0/authorize 로 이동 (redirect_uri = 이 함수의 URL)
 *   2) 네이버가 ?code=&state= 를 달고 이 함수로 되돌려 보냄
 *   3) 이 함수: code → 네이버 access_token → 프로필(이메일/닉네임) 조회
 *   4) 이 함수: 해당 이메일의 Supabase 계정을 찾거나 새로 만들고,
 *              1회용 magiclink 토큰(hashed_token)을 발급
 *   5) 사이트의 /auth-callback.html#naver=<토큰>&state=<state> 로 302 리다이렉트
 *   6) 브라우저: verifyOtp(token_hash) 로 세션 개시
 *
 * 필요한 Secrets (Supabase 대시보드 → Edge Functions → Secrets)
 *   NAVER_CLIENT_ID      네이버 개발자센터 Client ID
 *   NAVER_CLIENT_SECRET  네이버 개발자센터 Client Secret   ← 절대 프론트에 두지 말 것
 *   TM_SITE_URL          (선택) 기본값 https://www.totalmoney.kr
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 자동 주입한다.
 *
 * ⚠️ 이 함수는 인증 헤더 없이 네이버가 브라우저를 통해 호출하므로
 *    반드시 verify_jwt = false 로 배포해야 한다.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const NAVER_CLIENT_ID = Deno.env.get("NAVER_CLIENT_ID") ?? "";
const NAVER_CLIENT_SECRET = Deno.env.get("NAVER_CLIENT_SECRET") ?? "";
const SITE_URL = (Deno.env.get("TM_SITE_URL") ?? "https://www.totalmoney.kr").replace(/\/+$/, "");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

/**
 * 서버 전용 키를 읽는다.
 * Supabase가 SUPABASE_SERVICE_ROLE_KEY 를 deprecated 처리하고
 * SUPABASE_SECRET_KEYS(JSON 사전) 로 옮겨가는 중이라 둘 다 지원한다.
 * 신규 방식을 먼저 보고, 없으면 기존 키로 폴백한다.
 */
function readServiceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const dict = JSON.parse(raw);
      // 형태가 { "sb_secret_...": "..." } 인지 { "secret": "..." } 인지 보장되지 않으므로
      // sb_secret_ 로 시작하거나 JWT 처럼 생긴 첫 값을 고른다.
      const values = Object.values(dict).filter((v) => typeof v === "string") as string[];
      const picked = values.find((v) => v.startsWith("sb_secret_") || v.split(".").length === 3);
      if (picked) return picked;
      const keys = Object.keys(dict).filter((k) => k.startsWith("sb_secret_"));
      if (keys.length) return keys[0];
    } catch (_e) {
      // JSON이 아니면 키 문자열 그 자체로 본다
      if (raw.startsWith("sb_secret_") || raw.split(".").length === 3) return raw;
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

const SERVICE_ROLE_KEY = readServiceKey();

function redirect(hashOrQuery: string) {
  return new Response(null, {
    status: 302,
    headers: { Location: `${SITE_URL}/auth-callback.html${hashOrQuery}`, "Cache-Control": "no-store" },
  });
}

function fail(message: string) {
  // 사용자에게 보여줄 짧은 안내만 전달한다(내부 사정·스택은 노출하지 않음)
  return redirect(`?error_description=${encodeURIComponent(message)}`);
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    const naverError = url.searchParams.get("error");

    if (naverError) return fail("네이버 로그인이 취소되었습니다.");
    if (!code) return fail("잘못된 접근입니다.");
    if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET || !SERVICE_ROLE_KEY) {
      // 어느 값이 비었는지만 남긴다 (값 자체는 절대 로그에 남기지 않는다)
      console.error(
        "[naver-auth] 필수 환경변수 누락 " +
          JSON.stringify({
            NAVER_CLIENT_ID: !!NAVER_CLIENT_ID,
            NAVER_CLIENT_SECRET: !!NAVER_CLIENT_SECRET,
            SERVICE_KEY: !!SERVICE_ROLE_KEY,
            has_SECRET_KEYS: !!Deno.env.get("SUPABASE_SECRET_KEYS"),
            has_SERVICE_ROLE_KEY: !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
            secretKeysShape: (() => {
              const r = Deno.env.get("SUPABASE_SECRET_KEYS");
              if (!r) return "none";
              try {
                const d = JSON.parse(r);
                return Array.isArray(d) ? "array:" + d.length : "object:" + Object.keys(d).join(",");
              } catch {
                return "raw:" + r.slice(0, 10);
              }
            })(),
          }),
      );
      return fail("네이버 로그인이 아직 설정되지 않았습니다.");
    }

    /* 1) code → access_token */
    const tokenUrl =
      "https://nid.naver.com/oauth2.0/token?grant_type=authorization_code" +
      `&client_id=${encodeURIComponent(NAVER_CLIENT_ID)}` +
      `&client_secret=${encodeURIComponent(NAVER_CLIENT_SECRET)}` +
      `&code=${encodeURIComponent(code)}` +
      `&state=${encodeURIComponent(state)}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson.access_token) {
      console.error("[naver-auth] 토큰 교환 실패", tokenRes.status, tokenJson?.error);
      return fail("네이버 인증에 실패했습니다. 다시 시도해주세요.");
    }

    /* 2) 프로필 조회 */
    const meRes = await fetch("https://openapi.naver.com/v1/nid/me", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const meJson = await meRes.json().catch(() => ({}));
    const profile = meJson?.response;
    if (!meRes.ok || meJson?.resultcode !== "00" || !profile) {
      console.error("[naver-auth] 프로필 조회 실패", meRes.status, meJson?.message);
      return fail("네이버 프로필을 가져오지 못했습니다.");
    }

    const email = String(profile.email ?? "").trim().toLowerCase();
    if (!email) {
      return fail("네이버 계정의 이메일 제공에 동의해주셔야 로그인할 수 있습니다.");
    }
    const displayName = String(profile.nickname ?? profile.name ?? "").trim();

    /* 3) Supabase 계정 확보 */
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true, // 네이버가 확인한 이메일이므로 별도 인증 메일 불필요
      user_metadata: {
        display_name: displayName,
        tm_provider: "naver",
        naver_id: String(profile.id ?? ""),
      },
    });
    if (createErr) {
      const m = String(createErr.message || "");
      const alreadyExists = /already been registered|already registered|already exists|duplicate/i.test(m);
      if (!alreadyExists) {
        console.error("[naver-auth] 계정 생성 실패", m);
        return fail("계정 생성에 실패했습니다. 잠시 후 다시 시도해주세요.");
      }
      // 이미 있는 계정 → 기존 계정으로 로그인시킨다(네이버가 확인한 이메일 기준 연결)
    }

    /* 4) 1회용 magiclink 토큰 발급 */
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkErr || !linkData?.properties?.hashed_token) {
      console.error("[naver-auth] 링크 발급 실패", linkErr?.message);
      return fail("로그인 처리에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }

    /* 5) 사이트로 복귀 */
    return redirect(
      `#naver=${encodeURIComponent(linkData.properties.hashed_token)}&state=${encodeURIComponent(state)}`,
    );
  } catch (e) {
    console.error("[naver-auth] 예외", e);
    return fail("로그인 처리 중 오류가 발생했습니다.");
  }
});
