# TotalMoney AI

한국주식·미국주식·암호화폐 통합 대시보드 + AI 종목분석 + 매매시그널 스크리너 + 인스타그램/텔레그램 자동 콘텐츠 발행 서비스입니다.

- 서비스: https://www.totalmoney.kr
- 텔레그램: [@totalmoney_ai](https://t.me/totalmoney_ai)
- 인스타그램: [@totalmoney_ai](https://instagram.com/totalmoney_ai)

## 개요

정적 HTML/CSS/JS 프론트엔드와 Vercel 서버리스 함수(`api/*.js`)로 구성된 실서비스입니다. 실시간 시세, AI 종목분석, 매매 시그널 스크리너, 증시 캘린더 등을 제공하며, 모닝 브리핑·마감 시황·주간 일정을 인스타그램/텔레그램으로 자동 발행합니다.

## 기술 스택

- **프론트엔드**: 정적 HTML/CSS/JS (프레임워크 없음)
- **차트**: TradingView Lightweight Charts 기반 자체 구현
- **백엔드**: Vercel 서버리스 함수 (`api/`)
- **인증/DB**: Supabase (Auth + Postgres)
- **결제**: 포트원(PortOne) — 현재 비활성 상태
- **시세 데이터**: KIS Open API(국내·미국), CoinMarketCap Pro, Binance
- **AI**: Anthropic Claude (주력), OpenAI GPT-4o-mini (폴백)
- **발행**: Meta Graph API(인스타그램), 텔레그램 Bot API
- **자동화**: GitHub Actions + Cowork(Claude Desktop) 예약작업

## 로컬 미리보기

```bash
npm run preview
```

또는 Vercel CLI로:

```bash
npm run dev
```

## 배포

Vercel 프로젝트(`bori-cal`)에 연결되어 있으며, `main` 브랜치에 push하면 자동 배포됩니다.

```bash
npm run deploy
```

## 폴더 구성

- `index.html`, `*.html`: 페이지별 화면
- `api/`: Vercel 서버리스 함수
- `assets/`, `lib/`, `scripts/`: 공용 스크립트·유틸리티
- `data/`: 시세/시황 캐시 데이터 (자동 동기화)
- `templates/`, `generated/`: 인스타그램 카드뉴스/릴스 템플릿 및 산출물
- `vercel.json`: 배포/라우팅/헤더 설정

## 주의사항

- 시크릿(PAT, API 키 등)은 저장소에 커밋되지 않으며 `.env`, `.kis-token.json` 등은 `.gitignore`에 포함되어 있습니다.
- 결제는 현재 비활성 상태입니다(사업자등록 완료 후 정식 오픈 예정).

---

내부 운영 현황 및 이슈 트래킹은 `TOTALMONEY_STATUS.md`를 참고하세요.
