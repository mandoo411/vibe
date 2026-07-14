# 인스타그램 카드뉴스 · X 자동 트윗 — 작업 노트

이 브랜치(`promo/instagram-x-cardnews`)가 추가하는 것과, 왜 이런 구조로 짰는지 정리.

## 왜 새 파일만 추가했나

이 repo에는 이미 텔레그램 5종·KIS 연동·모닝브리핑 자동화가 실제로 돌고 있다(`.github/workflows/`의 `morning-briefing.yml`, `telegram-schedule.yml` 등, `scripts/`의 `claude-utils.mjs`, `kis-daily-top30.mjs` 등). 이번 작업은 그 위에 인스타그램 카드뉴스 캐러셀 자동 포스팅과 X 자동 트윗만 새로 얹었다. 기존 파일은 하나도 건드리지 않았다.

## 데이터 소스 — KIS를 새로 호출하지 않는다

`scripts/promo-market-copy.mjs`는 KIS API를 직접 부르지 않고 `data/daily-market.json`(기존 `kis-daily-top30.mjs`·`daily-market-ai.mjs`가 이미 채워둔 파일)을 읽기만 한다. 인스타/X 콘텐츠도 결국 이 데이터 기준이라 굳이 새 KIS 토큰 관리 로직을 또 만들 이유가 없었다.

카드 문구(헤드라인/AI 코멘트)는 `data/daily-market.json`의 `analysis` 필드(이미 Claude가 만들어둔 장문 리포트)를 Haiku로 한 번 더 압축해서 만든다. `ANTHROPIC_API_KEY`는 이미 repo secret에 등록돼 있어서 새로 발급받을 필요 없음. Claude 호출이 실패하면(크레딧 소진 등) `analysis` 원문에서 정규식으로 직접 문장을 뽑아 쓰는 폴백이 있다 — `daily-market-ai.mjs`의 폴백 철학과 동일.

## 새로 필요한 것 (Secrets)

- `META_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID` — 인스타그램 비즈니스 계정 + Meta 개발자 앱 필요
- `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_SECRET` — X 개발자 계정 필요

`KIS_*`, `ANTHROPIC_API_KEY`, `TELEGRAM_*`는 이미 등록돼 있어 그대로 재사용.

## 인스타 이미지 공개 URL 문제

Meta Graph API는 로컬 PNG를 못 받고 공개 URL만 받는다. 그래서 `instagram-card-post.mjs --render`가 만든 5장을 `generated/`에 저장 → 워크플로우가 git commit·push → `raw.githubusercontent.com/mandoo411/vibe/main/generated/slide-N.png` 공개 URL로 Graph API에 넘기는 2단계 구조다. **이 repo가 public이어야 이 방식이 성립한다** (지금은 public 확인됨).

## X 트윗 중복 방지

원래 계획은 30분 간격으로 무조건 트윗이었는데, `market-data-sync.yml`이 30분마다 도는 것과 실제 지수 변화가 없을 때(장 마감 후 등)까지 매번 트윗하면 스팸처럼 보일 위험이 있어서, `data/.last-tweet-hash.json`에 마지막으로 트윗한 데이터의 해시를 저장해두고 값이 같으면 건너뛰도록 했다.

## 다크/라이트 두 테마

`templates/`에 다크(`card-*.html`, 골드+네이비)와 라이트(`card-*-light.html`, 사이트 기본 테마인 틸+네이비) 둘 다 넣어뒀다. 지금은 `instagram-card-post.mjs`가 다크를 기본으로 쓴다(`PROMO_CARD_THEME=light` 환경변수로 전환 가능). 색상/폰트 값은 이 repo의 `theme.css`에서 실측한 값 그대로.

## 실제 실행 확인

`data/daily-market.json`의 오늘자(2026-07-14) 실데이터로 5장 전부 렌더링해서 확인함(코스피 6,856.83 ▲0.73%, 코스닥 783.98 ▼1.92%, TOP3 한탑/에넥스/엑사이엔씨). Meta Graph API·X API 실제 발행은 계정/토큰이 없어서 이 세션에선 테스트하지 못했다 — 시크릿 등록 후 `workflow_dispatch`로 먼저 1회 수동 실행해서 확인 권장.

## 법적 리스크 (참고, 법률 자문 아님)

캡션에 "투자 참고용 정보이며, 투자 판단 및 그 결과에 대한 책임은 투자자 본인에게 있습니다" 문구를 기본으로 넣어뒀다. 유료 구독으로 확장할 계획이라면 유사투자자문업 신고 여부를 관련 기관/전문가한테 한 번 확인해보는 걸 권한다.
