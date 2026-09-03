# naver-auth (Supabase Edge Function)

네이버 로그인 콜백. Vercel Hobby 함수 한도(12개)를 쓰지 않기 위해 Supabase에 둔다.

## 배포
```bash
supabase functions deploy naver-auth --no-verify-jwt --project-ref slcplrblmdiydakwzqdc
```
`--no-verify-jwt` 필수 — 네이버가 인증 헤더 없이 브라우저 리다이렉트로 호출한다.

## Secrets (Supabase 대시보드 → Edge Functions → Secrets)
| 이름 | 값 |
|---|---|
| `NAVER_CLIENT_ID` | 네이버 개발자센터 Client ID |
| `NAVER_CLIENT_SECRET` | 네이버 개발자센터 Client Secret (절대 프론트 노출 금지) |
| `TM_SITE_URL` | (선택) 기본 `https://www.totalmoney.kr` |

## 네이버 개발자센터 설정
- 서비스 URL: `https://www.totalmoney.kr`
- Callback URL: `https://slcplrblmdiydakwzqdc.supabase.co/functions/v1/naver-auth`
- 제공 정보: **이메일 주소(필수)**, 별명 — 이메일이 없으면 로그인 불가 처리된다.
