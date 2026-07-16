/**
 * 매매시그널 — 구조화 조건(condition) 판정 공용 모듈.
 *
 * 2026-07-17: 원래 scripts/trade-signal-scan.mjs 안에만 있던 evaluateClause/evaluateCondition을
 * 여기로 빼서 "저장해서 감시(알림)"와 "즉시검색(스크리너)" 두 기능이 완전히 동일한 조건
 * 판정 로직을 공유하게 했다 — 둘이 로직이 미묘하게 달라지면 사용자가 검색한 조건과
 * 실제로 알림이 오는 조건이 어긋나는 신뢰 문제가 생기기 때문에 반드시 하나로 유지할 것.
 *
 * 이 모듈은 "풀 시계열 배열"이 아니라 종목당 1개의 압축된 snapshot 객체를 대상으로 동작한다
 * (buildSnapshotFromSeries로 변환). 이유: 즉시검색은 국내 전종목(~2600개)을 매 요청마다
 * 필터링해야 해서, 캐시 파일에 종목당 원본 배열 전체를 들고 있으면 파일이 너무 커진다.
 * snapshot에는 각 조건 타입이 실제로 참조하는 값(직전/최신 이동평균, 최신 RSI, 거래량비율,
 * 52주 신고가/신저가 여부, 다이버전스 여부)만 압축해서 담는다.
 */

const ALLOWED_CLAUSE_TYPES = [
  "ma_cross",
  "price_cross_ma",
  "rsi",
  "volume_ratio",
  "high52w_breakout",
  "low52w_breakdown",
  "price_change_pct",
  "rsi_divergence",
];

const MA_PERIODS = [20, 60, 120, 200];

const CONDITION_GUIDE = `condition.clauses[].type로 쓸 수 있는 값과 필드 (이 목록 밖의 type은 절대 쓰지 말 것):
- ma_cross: {fast:20|60|120, slow:60|120|200, direction:"up"|"down"} — 이동평균선끼리 골든/데드크로스
- price_cross_ma: {period:20|60|120|200, direction:"up"|"down"} — 현재가가 이동평균선을 돌파
- rsi: {op:"lt"|"lte"|"gt"|"gte", value:0~100} — RSI(14) 값 조건
- volume_ratio: {op:"gte"|"gt", value: 숫자(%)} — 20일 평균 거래량 대비 당일 거래량 비율(%)
- high52w_breakout: {} — 52주 신고가 갱신
- low52w_breakdown: {} — 52주 신저가 갱신
- price_change_pct: {op:"gte"|"lte", value: 숫자(%, 부호 포함)} — 당일 등락률 조건
- rsi_divergence: {direction:"bullish"|"bearish"} — RSI 다이버전스. bullish(강세 다이버전스)=가격은
  더 낮은 저점을 만들었는데 RSI는 더 높은 저점(하락 모멘텀 약화, 반등 가능성). bearish(약세
  다이버전스)=가격은 더 높은 고점을 만들었는데 RSI는 더 낮은 고점(상승 모멘텀 약화). "다이버전스"
  라고만 말하고 방향이 불명확하면 문맥상 RSI 30 이하/과매도 언급이 있으면 bullish로, 과매수/신고가
  언급이 있으면 bearish로 추론할 것.
여러 조건을 언급했으면 clauses 배열에 여러 개 넣고 logic은 기본 "AND".`;

/** 풀 시계열({closes,highs,lows,volumes,ma,rsiSeries,divergence}) -> 압축 snapshot 변환 */
function buildSnapshotFromSeries(series) {
  const { closes, highs, lows, volumes, ma, rsiSeries, divergence } = series;
  const n = closes.length;
  const i = n - 1;
  const prevI = n - 2;

  const snap = {
    closeCur: closes[i],
    closePrev: prevI >= 0 ? closes[prevI] : null,
    rsiCur: rsiSeries && rsiSeries[i] != null ? rsiSeries[i] : null,
  };

  for (const p of MA_PERIODS) {
    const arr = ma && ma[p];
    snap[`ma${p}Cur`] = arr ? arr[i] : null;
    snap[`ma${p}Prev`] = arr && prevI >= 0 ? arr[prevI] : null;
  }

  const windowVol = (volumes || []).slice(Math.max(0, i - 20), i);
  const avgVol = windowVol.length ? windowVol.reduce((a, b) => a + b, 0) / windowVol.length : 0;
  snap.volumeRatio = avgVol ? (volumes[i] / avgVol) * 100 : null;

  const windowHighs = (highs || []).slice(Math.max(0, i - 252), i);
  snap.high52wBreakout = windowHighs.length ? closes[i] > Math.max(...windowHighs) : false;

  const windowLows = (lows || []).slice(Math.max(0, i - 252), i);
  snap.low52wBreakdown = windowLows.length ? closes[i] < Math.min(...windowLows) : false;

  snap.divergenceBullish = !!(divergence && divergence.bullish);
  snap.divergenceBearish = !!(divergence && divergence.bearish);

  return snap;
}

function evaluateClauseOnSnapshot(clause, snap) {
  if (!clause || !snap) return false;

  if (clause.type === "ma_cross") {
    const f0 = snap[`ma${clause.fast}Prev`];
    const s0 = snap[`ma${clause.slow}Prev`];
    const f1 = snap[`ma${clause.fast}Cur`];
    const s1 = snap[`ma${clause.slow}Cur`];
    if ([f0, s0, f1, s1].some((v) => v == null)) return false;
    return clause.direction === "down" ? f0 >= s0 && f1 < s1 : f0 <= s0 && f1 > s1;
  }

  if (clause.type === "price_cross_ma") {
    const m0 = snap[`ma${clause.period}Prev`];
    const m1 = snap[`ma${clause.period}Cur`];
    const c0 = snap.closePrev;
    const c1 = snap.closeCur;
    if (m0 == null || m1 == null || c0 == null || c1 == null) return false;
    return clause.direction === "down" ? c0 >= m0 && c1 < m1 : c0 <= m0 && c1 > m1;
  }

  if (clause.type === "rsi") {
    const r = snap.rsiCur;
    if (r == null) return false;
    if (clause.op === "lt") return r < clause.value;
    if (clause.op === "lte") return r <= clause.value;
    if (clause.op === "gt") return r > clause.value;
    if (clause.op === "gte") return r >= clause.value;
    return false;
  }

  if (clause.type === "volume_ratio") {
    if (snap.volumeRatio == null) return false;
    return clause.op === "gt" ? snap.volumeRatio > clause.value : snap.volumeRatio >= clause.value;
  }

  if (clause.type === "high52w_breakout") return !!snap.high52wBreakout;
  if (clause.type === "low52w_breakdown") return !!snap.low52wBreakdown;

  if (clause.type === "price_change_pct") {
    if (!snap.closePrev) return false;
    const pct = ((snap.closeCur - snap.closePrev) / snap.closePrev) * 100;
    return clause.op === "lte" ? pct <= clause.value : pct >= clause.value;
  }

  if (clause.type === "rsi_divergence") {
    return clause.direction === "bearish" ? !!snap.divergenceBearish : !!snap.divergenceBullish;
  }

  return false;
}

function evaluateCondition(condition, snap) {
  if (!condition || !Array.isArray(condition.clauses) || !condition.clauses.length) return false;
  return condition.clauses.every((clause) => evaluateClauseOnSnapshot(clause, snap));
}

function isValidCondition(condition) {
  if (!condition || typeof condition !== "object") return false;
  if (condition.logic !== "AND") return false;
  if (!Array.isArray(condition.clauses) || !condition.clauses.length) return false;
  return condition.clauses.every(
    (c) => c && typeof c === "object" && ALLOWED_CLAUSE_TYPES.includes(String(c.type || ""))
  );
}

module.exports = {
  ALLOWED_CLAUSE_TYPES,
  MA_PERIODS,
  CONDITION_GUIDE,
  buildSnapshotFromSeries,
  evaluateClauseOnSnapshot,
  evaluateCondition,
  isValidCondition,
};
