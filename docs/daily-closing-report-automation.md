# 마감시황 자동 발행 — daily-closing-report (Cowork 예약작업)

> 2026-06-19 최초 설정, 2026-06-20 1차 수정. Cowork(Claude) 앱의 **Scheduled** 작업으로 등록되어 있으며,
> 작업 본문은 `C:\Users\oem\Claude\Scheduled\daily-closing-report\SKILL.md` 에 저장됨.
> 이 문서는 다른 대화/세션에서도 맥락을 다시 설명할 필요 없이 참고할 수 있도록 만든 요약본.
> **새 채팅방에서 이어가려면 이 파일을 첨부**하면 됨.

## 목적

totalmoney.kr(저장소 `D:\vibe`, GitHub `mandoo411/vibe`, Vercel 프로젝트 `bori-cal`)의
**마감시황** 리포트를 평일 장마감 후 **무인으로** 작성·배포·텔레그램 발송까지 끝낸다.
사용자가 컴퓨터 앞에 없어도 동작해야 하며, 실패 시 알림 없이 조용히 스킵한다.

## 스케줄

- **cron**: `15 16 * * 1-5` (월~금 **16:15 KST**, PC 로컬시간 = KST 기준)
- 다음 실행 시각·이력은 Cowork 사이드바 **Scheduled** 탭에서 확인/수정 가능
- 일정·프롬프트 수정은 `mcp__scheduled-tasks__update_scheduled_task`, 목록은 `list_scheduled_tasks`
- taskId: `daily-closing-report` — **Cowork 앱 Scheduled에서 16:15 KST로 맞출 것** (이전 17:00)

## 전체 파이프라인

```
[15:40 KST] GitHub Actions: daily-market-sync.yml (+ save-prev-top50 동시 슬롯)
   → KIS API 상승·하락·거래대금 TOP30만 수집 → data/daily-market.json 커밋 → Vercel 배포
   (뉴스·수급·지수·RSS 등 AI 입력용 수집은 Cowork가 담당 — 워크플로우와 중복 제거)
   (외부 cron-job.org 06:40 UTC 트리거 권장 — GitHub schedule 지연 대비)

[16:15 KST] Cowork 예약작업: daily-closing-report
   1. bash로 D:\vibe 마운트 경로 확인 → git pull
   2. 오늘이 알려진 휴장일이거나 데이터가 비어있으면(더미 0%) 조용히 스킵
   3. scripts/daily-market-ai.mjs를 "규칙 문서"로 읽어 7단계 구조·JSON 필드명·특징주 선정 규칙·제목 형식 파악
      → 별도 Anthropic API 호출 없이, Cowork 안에서 Claude가 직접 한국어 분석 작성
        (추가 API 비용 발생 안 함 — 기존 Cowork 사용량 안에서 처리)
   4. data/daily-market.json의 오늘 항목에 분석 필드 병합
   5. git add/commit/push → Vercel MCP로 배포 확인(READY)
   6. npm run sync:daily 실행 → 텔레그램 채널 https://t.me/totalmoney_ai 로 발송
   7. 어느 단계든 실패하면 사용자에게 알리지 않고 조용히 종료
```

## 관련 파일

| 파일 | 역할 |
|---|---|
| `.github/workflows/daily-market-sync.yml` | 평일 **15:40 KST** (06:40 UTC), KIS TOP30(상승·하락·거래대금) 수집 |
| `scripts/daily-market-ai.mjs` | AI 분석 규칙/JSON 스키마의 **원본 정의** (스케줄 작업은 이 파일을 실행하지 않고 읽기만 함). 특징주 그룹A/B 선정 규칙, 제목 형식 규칙도 여기 있음 |
| `scripts/report-example.md` | Claude에게 보여주는 "이런 수준·구조로 작성하라"는 출력 예시 |
| `scripts/telegram-utils.mjs`, `scripts/telegram-daily-market.mjs` | `npm run sync:daily` — 텔레그램 발송 스크립트. 제목 블록 추출·볼드 강조 로직 포함 |
| `data/daily-market.json` | 일별 데이터 저장소 (`days["YYYY-MM-DD"]`) |
| `daily-market.js`의 `isDayEmpty()` | "오늘 데이터가 진짜인지 더미인지" 판별 로직 — 예약작업의 휴장일 판단 기준 |

## 2026년 알려진 평일 휴장 예상일 (1차 필터용, 100% 확정 아님)

2026-01-01, 02-16, 02-17, 02-18, 03-02, 05-01, 05-05, 05-25, 08-17,
09-24, 09-25, 10-05, 10-09, 12-25, 12-31

→ 실제 휴장 여부는 매번 `data/daily-market.json`의 실데이터 유무로 최종 확인함
(지방선거일 등 애매한 날도 이 방식으로 자동 처리됨).

## 2026-06-20 변경 이력 (이번 세션)

사용자 요청: 특징주(오늘의 특징주 10종목) 선정 조건 보강 + 텔레그램 리포트 제목 가독성 개선.

### 1) 특징주 10종목 선정 규칙 — 그룹A/B 교차보충 방식

- **그룹A** (기본 할당 5종목): 시가총액 100위 이내 종목 중 **+5% 이상 상승**, 상승 이유가 뉴스로 **명확히 확인되는 종목만**. 이유 불명확하면 제외하고 같은 조건의 다른 종목으로 대체(할루시네이션 절대 금지).
- **그룹B** (기본 할당 5종목): 코스피+코스닥 전체 종목 중 **+20% 이상 상승**(기존 +15%→ +20%로 상향), 상승 이유가 뚜렷한 종목만. 마찬가지로 이유 없으면 다른 종목으로 대체.
- **교차 보충**: 한쪽 그룹의 조건 충족 종목이 기본 할당(5개)보다 적으면, 부족분만큼 **다른 그룹의 조건충족 풀에서 추가로 채워 총 10개**를 맞춘다.
  예) 그룹A 조건충족 3개뿐 → 그룹A 3개 + 그룹B 7개(그룹B 충족 풀이 7개 이상 있으면).
- 두 그룹을 합쳐도 10개 미만이면 충족하는 만큼만 나열, 억지로 채우지 않음.
- 적용 위치: `scripts/daily-market-ai.mjs`의 `buildUserPrompt()` 지시문 + `buildSystemPrompt()` 5번 섹션.

### 2) 리포트 제목 형식 표준화 + 텔레그램 강조

- 분석 본문 맨 앞에 항상 아래 2줄을 고정 형식으로 출력하도록 규칙 추가:
  ```
  📊 TOTAL MONEY AI · 마감 리포트
  {YYYY}년 {M}월 {D}일 ({요일})
  ```
  그다음 빈 줄 + 구분선(`────────────────`) 후 7개 섹션 본문 시작.
- **텔레그램은 폰트 크기를 지원하지 않음** (Markdown parse_mode 한계: bold/italic/code/link만 가능). "크게"는 **볼드 처리 + 위아래 구분선(`━━━━━━━━━━━━━━━━━━`)**으로 구현 — 제목 2줄과 "📊 *종합분석*" 라벨을 본문과 시각적으로 분리.
- 적용 위치:
  - `scripts/daily-market-ai.mjs`: `buildSystemPrompt()`에 `[제목 형식]` 블록 추가
  - `scripts/report-example.md`: 예시 첫 줄을 새 제목 형식으로 동기화
  - `scripts/telegram-daily-market.mjs`: `splitAnalysisTitle()` 함수 추가(구분선 기준 제목/본문 분리) + `buildMessage()`에서 제목 볼드 처리·구분선 삽입

### 3) Git 반영 완료

- 수정 파일 3개: `scripts/daily-market-ai.mjs`, `scripts/telegram-daily-market.mjs`, `scripts/report-example.md`
- 커밋: `dbdee35` "feat: 특징주 그룹A/B 교차보충 + 텔레그램 제목 강조"
- 푸시 완료: `7c3a49a..4b482e0  main -> main`
- **참고**: Cowork bash 샌드박스가 `rootfs.vhdx` 오류로 시작이 안 돼서, 사용자가 직접 Windows 명령 프롬프트에서 커밋/푸시함. 명령 프롬프트에서 `cd D:\vibe`만 치면 드라이브가 안 바뀌는 cmd 특성 때문에 처음엔 "not a git repository" 오류가 났음 → **`cd /d D:\vibe`**로 해결.
- 다음 평일(2026-06-22, 월) 17시 예약 실행부터 새 규칙 적용됨.

## 2026-06-22 변경 이력 (이번 세션) — 수동 실행 + 그룹A 판정 오류 수정

### 1) 상황: 예약작업·bash 샌드박스 모두 불가 → 전 과정 수동 진행

- 이날 17:00 예약작업(`daily-closing-report`)이 자동 실행되지 않았고, GitHub Actions 데이터 수집(`daily-market-sync.yml`)도 자동으로 돌지 않음.
- Cowork bash 샌드박스가 이번 세션 내내 완전히 죽어있었음 (`Workspace unavailable. The isolated Linux environment failed to start.` — 6-20 세션의 `rootfs.vhdx`/`EXDEV` 오류와 동일 계열, 재시작으로도 해결 안 됨. **반복 발생 이슈로 계속 모니터링 필요**).
- 사용자가 직접 ① GitHub Actions 워크플로우 수동 트리거, ② 로컬 `git pull`로 최신 데이터 확보.
- Claude는 bash 없이 **Read/Grep/Edit 같은 파일 도구만으로** `data/daily-market.json`을 직접 편집해 리포트를 작성함 (JSON 유효성은 bash로 검증 못 해서 Edit 전후 `Read`로 괄호/중괄호 경계를 눈으로 확인하는 방식으로 대체).

### 2) 그룹A/B 특징주 선정 — 1차 결론이 틀렸던 사례

- **1차 결론(오류)**: `topGainers` 배열(상승률 상위 30개, 이날 컷오프 14.76%)에 시총100위 종목이 하나도 없다는 이유로 "그룹A 후보 0개"라고 단정 → 보고서에 그렇게 적었음.
- **사용자가 지적**: SK하이닉스·SK스퀘어 등 다른 대형주들이 분명히 움직였는데 빠졌다, 이건 할루시네이션이라는 피드백.
- **재검증 결과**: `topGainers`는 상승률 상위 30개만 잘라서 저장하는 구조라, 소형주들이 그 30자리를 다 채우면 **대형주가 5~14% 올랐어도 배열 자체에서 빠질 수 있음** (배열 부재 ≠ 실제로 안 올랐음). 뉴스 헤드라인 전체를 다시 훑어보니 SK스퀘어가 독립된 뉴스 3건("SK하이닉스 최대주주 SK스퀘어 주가 10%대 올라", "SK하이닉스 시총1위... SK스퀘어도 신고가 돌파", "반도체 랠리에 SK하이닉스·SK스퀘어 강세")에서 명확히 종목명+사유로 확인됨. 코드(402340)도 시총100위 폴백 리스트에 포함.
- **수정**: SK스퀘어를 그룹A에 추가(최종 그룹A 1 + 그룹B 5 = 특징주 6개). 단, 정확한 종가 등락률은 구조화 데이터에 없어서 뉴스의 "10%대" 표현을 근거로 `change_pct: 10`(하한 추정치)로 표기하고, reason/point에 "정확한 등락률은 구조화 데이터 미확인, 뉴스 기준 추정"이라고 명시 — 가짜 정밀 수치를 만들지 않으면서도 종목 자체는 정당하게 포함.
- **교훈(다음 세션에 적용할 규칙)**: 그룹A 판정 시 `topGainers`/`notableStocks` 배열에 없다고 바로 "후보 없음"으로 단정하지 말 것. 시총100위 종목명 전체를 뉴스 헤드라인 텍스트에서 별도로 grep해서, 헤드라인이 그 종목을 명시적 인과 주체로 다루는지 교차 확인하는 단계를 반드시 거칠 것. 정확한 %가 구조화 데이터에 없어도, 뉴스에 "OO%대"처럼 범위로 명시돼 있고 종목명이 명확히 인과 주체로 등장하면 그 범위의 하한값으로 보수적으로 기입(가짜 정밀 소수점 금지) 가능.

### 3) 발행 단계 — 사용자가 직접 git/npm 실행 필요

- bash 불가로 Claude가 직접 push/배포를 못 함. 사용자가 Windows 명령 프롬프트에서 다음을 실행해야 발행 완료:
  ```
  cd /d D:\vibe
  git add .
  git commit -m "chore(report): 2026-06-22 마감 리포트 수동 작성 (SK스퀘어 그룹A 보완)"
  git push
  npm run sync:daily
  ```
- 이 세션 종료 시점 기준, **위 명령이 아직 실행되었는지 미확인** — 새 대화에서 이어갈 경우 가장 먼저 사용자에게 실행 여부를 확인할 것.

## 알려진 제약/주의사항

- **Cowork 앱이 켜져 있어야 함**: PC가 켜져 있어도 Cowork 앱이 종료된 상태면 16:15 KST 예약 시각에 실행되지 않고, 앱을 다시 열 때 실행됨.
- **bash 가상환경(sandbox) 불안정 이력 — 반복 발생 중**: 2026-06-19 설정 당시, 그리고 2026-06-20 수정 작업 중에도 `rootfs.vhdx` 관련 오류로 bash 시작이 여러 차례 실패함. Cowork 앱을 완전히 종료 후 재시작하면 보통 풀림. 예약작업 당일에도 같은 문제가 발생하면 해당 날짜는 조용히 스킵됨 → 계속 모니터링 필요.
- **Windows cmd에서 드라이브 이동 시 `/d` 옵션 필수**: `cd D:\vibe`만 입력하면 드라이브가 안 바뀜(현재 드라이브 유지). 반드시 `cd /d D:\vibe` 사용.
- **첫 실행은 "지금 실행"으로 한 번 테스트 권장**: Vercel MCP 등 도구 권한을 미리 승인해 두면 이후 무인 실행이 권한 프롬프트에서 멈추지 않음.
- 실패 알림을 보내지 않으므로, 발행이 안 됐는지는 https://www.totalmoney.kr/daily-market.html 또는 텔레그램 채널을 직접 확인해야 함.

## 비용

- GitHub Actions 데이터 수집: 무료(기존 워크플로 그대로)
- AI 분석 작성: Cowork 안에서 Claude가 직접 수행 → **별도 Anthropic API 토큰 비용 없음**
  (스크립트 방식(`daily-market-ai.mjs` 실행)으로 했다면 월 약 $10~20 별도 과금 — 이 비용을 피하기 위해 PC 예약작업 방식을 선택함)
