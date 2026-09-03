# data-archive

매매시그널 백테스트용 **일자별 전종목 지표 스냅샷** 보관 브랜치입니다.
`main`과는 커밋 히스토리가 분리되어 있고 Vercel 배포 대상이 아닙니다.

- `screener/index.json` — 보유 날짜 목록 + 열 스키마
- `screener/<YYYY-MM>/<YYYY-MM-DD>.csv.gz` — 그날 종가 기준 전종목 지표

생성: `.github/workflows/screener-snapshot.yml` (main 브랜치)
