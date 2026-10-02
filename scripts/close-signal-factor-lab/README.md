# 종가시그널 요인 실험실 (2026-10-02)

현재 채점(rankCloseBetting)이 비용을 못 넘는 이유를 찾고, 새 채점 후보를 **2024-06~2025-12로 만들고 2026으로만 검증**하는 스크립트.
결과 정리: 프로젝트 문서 `CRASH_BACKTEST.md` 7~8장.

순서 (BT_DIR 기본 /tmp/claude-0/bt, 컨테이너에선 `NODE_USE_ENV_PROXY=1`)
1. `node 0-fetch.mjs idx` → `candles` → (flowcodes.json 생성 후) `flows` — 네이버 일봉·수급 재수집(약 11분). 원자료는 내부 검증용, 저장소에 올리지 않는다.
2. `node 1-universe.cjs` — 후보군(거래대금 상위 400 중 +2~20%, 시총 500억~20조, 스팩·우선주 제외)과 요인 계산
3. `node 2-factor-ic.cjs` — 요인별 일별 순위상관(IC)·5분위 결과, 학습/검증 분리
4. `node 3-new-score-test.cjs` — 새 채점 후보 비교(현행 비교에는 crash-backtest.mjs의 daily10.json 필요)
