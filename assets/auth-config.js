/**
 * TotalMoney AI — Supabase / 포트원(PortOne) 공개 설정
 * ------------------------------------------------------------
 * 이 파일의 값들은 "공개되어도 되는" 값들만 넣습니다.
 *  - SUPABASE_ANON_KEY 는 Supabase가 브라우저 노출용으로 설계한 키입니다
 *    (실제 데이터 보호는 DB의 Row Level Security가 담당합니다).
 *  - PORTONE_STORE_ID / PORTONE_CHANNEL_KEY 도 결제창을 여는 데 필요한
 *    공개 식별자로, 결제 서비스사(포트원)가 공개 사용을 전제로 발급합니다.
 *
 *  ⚠️ 절대 이 파일에 넣으면 안 되는 것:
 *   - Supabase "service_role" 키
 *   - 포트원 "API Secret"
 *  → 위 두 개는 서버(Vercel 환경변수)에만 저장합니다. (docs/회원가입_결제_셋업_가이드.md 참고)
 * ------------------------------------------------------------
 * 아래 값은 아직 발급 전 placeholder 입니다. Supabase / 포트원 콘솔에서
 * 값을 발급받은 뒤 이 파일만 수정하면 전체 사이트에 반영됩니다.
 */
window.TM_AUTH_CONFIG = {
  // Supabase 프로젝트 설정 (Project Settings → API)
  SUPABASE_URL: "https://slcplrblmdiydakwzqdc.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_mgAp6BgpvW5McvwR4D5Xjg_Sg9F20VU",

  // 포트원(PortOne) 콘솔 → 결제연동 → 연동 정보
  PORTONE_STORE_ID: "store-2e346cca-6d0b-48ae-a853-887f6214fa93",
  PORTONE_CHANNEL_KEY: "channel-key-95945b22-b915-4a56-bf4b-3dea660f5efc",

  // ---- 네이버 로그인 (2026-09-03 추가) ----
  // 구글/카카오는 Supabase 대시보드에만 등록하면 되므로 여기에 값이 필요 없습니다.
  // 네이버는 Supabase가 기본 지원하지 않아 Supabase Edge Function(naver-auth)을 경유합니다.
  //   NAVER_CLIENT_ID      : 네이버 개발자센터 → 내 애플리케이션 → Client ID (공개값)
  //   NAVER_AUTH_ENDPOINT  : 배포된 Edge Function URL. 네이버 콘솔의 "Callback URL"과 동일해야 함
  //                          예) https://slcplrblmdiydakwzqdc.supabase.co/functions/v1/naver-auth
  // ⚠️ 네이버 Client Secret 은 절대 여기 넣지 말 것 (Supabase Edge Function Secrets 에만 저장)
  // 두 값이 비어 있으면 네이버 버튼은 자동으로 숨겨집니다.
  NAVER_CLIENT_ID: "",
  NAVER_AUTH_ENDPOINT: "https://slcplrblmdiydakwzqdc.supabase.co/functions/v1/naver-auth",

  // 약관/개인정보 동의 버전. 약관을 개정하면 이 값을 올리세요(재동의 유도에 사용).
  CONSENT_VERSION: "2026-09-03",

  // true 로 두면 아직 Supabase/포트원 설정 전이라도 사이트가 깨지지 않고
  // 로그인/결제 버튼이 "준비 중" 안내만 표시합니다. 값 채운 뒤 false로 변경.
  SETUP_PENDING: false,
};
