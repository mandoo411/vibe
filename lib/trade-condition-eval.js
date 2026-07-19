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
  "macd_cross",
  "macd_histogram_turn",
  "bollinger",
  "stochastic",
  "stochastic_cross",
  "ma_alignment",
  "disparity",
  "adx",
  "di_cross",
  "candle_pattern",
  "gap",
  "consecutive_candles",
  "high52w_near",
  "market_cap",
  "trading_value",
  "period_return",
];

const MA_PERIODS = [5, 10, 20, 60, 120, 200];

const CONDITION_GUIDE = `condition.clauses[].type로 쓸 수 있는 값과 필드 (이 목록 밖의 type은 절대 쓰지 말 것):
- ma_cross: {fast:5|10|20|60|120, slow:10|20|60|120|200, direction:"up"|"down"} — 이동평균선끼리
  골든/데드크로스 (fast는 반드시 slow보다 짧은 기간이어야 함. "5일선 20일선 골든크로스"→fast:5,slow:20)
- price_cross_ma: {period:5|10|20|60|120|200, direction:"up"|"down"} — 현재가가 이동평균선을 돌파
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
- macd_cross: {direction:"up"|"down"} — MACD(12,26,9)선이 시그널선을 골든(up)/데드(down) 크로스
- macd_histogram_turn: {direction:"up"|"down"} — MACD 히스토그램이 음수→양수(up, 매수 전환) 또는
  양수→음수(down, 매도 전환)로 막 바뀐 시점
- bollinger: {position:"upper_break"|"lower_break"|"upper_touch"|"lower_touch"} — 볼린저밴드(20,2)
  상단/하단을 종가가 돌파(break)했거나 근접 터치(touch)했는지
- stochastic: {line:"k"|"d", op:"lt"|"lte"|"gt"|"gte", value:0~100} — 스토캐스틱 슬로우 %K 또는 %D 값 조건
  (line 생략 시 k). 과매도는 보통 20 이하, 과매수는 80 이상
- stochastic_cross: {direction:"up"|"down"} — 스토캐스틱 %K가 %D를 상향(up)/하향(down) 교차
- ma_alignment: {direction:"bullish"|"bearish"} — 이동평균 정배열(20>60>120>200, bullish) 또는
  역배열(20<60<120<200, bearish)
- disparity: {period:5|10|20|60|120|200, op:"lt"|"lte"|"gt"|"gte", value:숫자(%)} — 이격도
  (현재가 ÷ N일 이동평균 × 100). 보통 105 이상이면 단기 과열, 95 이하면 단기 침체로 해석
- adx: {op:"gt"|"gte", value:0~100} — ADX(14) 추세 강도. 25 이상이면 뚜렷한 추세로 해석
- di_cross: {direction:"up"|"down"} — +DI가 -DI를 상향(up, 상승추세 전환)/하향(down, 하락추세 전환) 교차
- candle_pattern: {pattern:"bullish_engulfing"|"bearish_engulfing"|"hammer"|"shooting_star"|"doji"} —
  최근 봉의 캔들패턴. bullish_engulfing(상승장악형), bearish_engulfing(하락장악형), hammer(망치형,
  바닥권 반등 신호), shooting_star(유성형, 천장권 하락 신호), doji(도지, 방향성 미결정)
- gap: {direction:"up"|"down"} — 갭상승(up)/갭하락(down) — 오늘 시가가 전일 고가 위 또는 저가 아래로 출발
- consecutive_candles: {direction:"up"|"down", count:숫자} — N일 연속 양봉(up)/음봉(down).
  "3일 연속 상승"처럼 숫자가 있으면 그대로 count에 쓰고, 없으면 count:3 기본값
- high52w_near: {withinPct:숫자} — 52주 신고가 대비 withinPct% 이내로 근접(신고가 돌파 직전 눌림목/
  코일링 구간). "신고가 근접"처럼 숫자가 없으면 withinPct:5 기본값
- market_cap: {op:"lt"|"lte"|"gt"|"gte", value:숫자(억원)} — 시가총액. "시가총액 1000억 이상"이면
  value:1000, op:"gte" (단위는 항상 억원으로 환산 — "1조"는 value:10000, "500억"은 value:500)
- trading_value: {op:"lt"|"lte"|"gt"|"gte", value:숫자(억원)} — 당일 누적 거래대금. "거래대금 50억
  이상"이면 value:50, op:"gte" (단위는 항상 억원으로 환산). 사용자가 "거래량"이라고 말해도 억/원
  단위를 언급했다면(예: "거래량 50억") 실제로는 거래대금을 의미하는 것이므로 trading_value로 처리할 것
  ("거래량"이 진짜 주식 수를 의미하는 경우는 이 시스템에서 지원하지 않음 — 그런 경우 이해 못한 것으로 처리)
- period_return: {days:5|21|63|126|252, op:"lt"|"lte"|"gt"|"gte", value:숫자(%)} — N거래일 전 종가
  대비 현재 종가의 누적 등락률(구간 내 어느 시점의 고점/저점이 아니라 "그날 종가 → 오늘 종가"만 비교).
  기간 표현은 영업일 기준으로 환산: 1주≈5, 1개월≈21, 3개월≈63, 6개월≈126, 1년≈252. "최근 3달 안에
  20% 이상 상승"이면 days:63, op:"gte", value:20
여러 조건을 언급했으면 clauses 배열에 여러 개 넣고 logic은 기본 "AND". 조건 개수에는 정해진 상한이
없으니 사용자가 여러 개를 나열하면 전부 clauses에 담을 것.

중요: 사용자가 언급한 조건 중 위 목록의 type으로 표현할 수 없는 게 하나라도 있으면(예: 위 목록에 없는
지표/필터), 그 조건만 조용히 빼고 나머지 조건만으로 검색 결과를 만들면 절대 안 된다. 이 경우
전체를 이해하지 못한 것으로 처리하고(understood=false 또는 matched=false), 어떤 부분을 아직
지원하지 않는지 clarifyMessage에 명확히 설명할 것. 사용자가 요청한 조건 중 일부만 반영된 결과를
"이해했다"고 보여주는 것은 사용자에게 잘못된 정보를 주는 것이므로 절대 금지.`;

/** 풀 시계열 -> 압축 snapshot 변환.
 * series: {closes,highs,lows,volumes,ma,rsiSeries,divergence,candles,macd,bollinger,stochastic,adx}
 * candles/macd/bollinger/stochastic/adx는 2026-07-18 신규 지표군 — 옵션이라 없어도(구버전 캐시)
 * 안전하게 null/false로 빠진다.
 */
function buildSnapshotFromSeries(series) {
  const { closes, highs, lows, volumes, ma, rsiSeries, divergence, candles, macd, bollinger, stochastic, adx, marketCapEok, tradingValueEok, periodReturns } = series;
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
  snap.high52wHigh = windowHighs.length ? Math.max(...windowHighs, highs[i]) : (highs ? highs[i] : null);

  const windowLows = (lows || []).slice(Math.max(0, i - 252), i);
  snap.low52wBreakdown = windowLows.length ? closes[i] < Math.min(...windowLows) : false;

  snap.divergenceBullish = !!(divergence && divergence.bullish);
  snap.divergenceBearish = !!(divergence && divergence.bearish);

  if (macd) {
    snap.macdCur = macd.macdLine ? macd.macdLine[i] : null;
    snap.macdPrev = macd.macdLine && prevI >= 0 ? macd.macdLine[prevI] : null;
    snap.macdSignalCur = macd.signalLine ? macd.signalLine[i] : null;
    snap.macdSignalPrev = macd.signalLine && prevI >= 0 ? macd.signalLine[prevI] : null;
    snap.macdHistCur = macd.histogram ? macd.histogram[i] : null;
    snap.macdHistPrev = macd.histogram && prevI >= 0 ? macd.histogram[prevI] : null;
  }

  if (bollinger) {
    snap.bbUpperCur = bollinger.upper ? bollinger.upper[i] : null;
    snap.bbLowerCur = bollinger.lower ? bollinger.lower[i] : null;
    snap.bbMidCur = bollinger.mid ? bollinger.mid[i] : null;
    snap.bbWidthCur = bollinger.width ? bollinger.width[i] : null;
  }

  if (stochastic) {
    snap.stochKCur = stochastic.k ? stochastic.k[i] : null;
    snap.stochKPrev = stochastic.k && prevI >= 0 ? stochastic.k[prevI] : null;
    snap.stochDCur = stochastic.d ? stochastic.d[i] : null;
    snap.stochDPrev = stochastic.d && prevI >= 0 ? stochastic.d[prevI] : null;
  }

  if (adx) {
    snap.adxCur = adx.adx ? adx.adx[i] : null;
    snap.plusDICur = adx.plusDI ? adx.plusDI[i] : null;
    snap.plusDIPrev = adx.plusDI && prevI >= 0 ? adx.plusDI[prevI] : null;
    snap.minusDICur = adx.minusDI ? adx.minusDI[i] : null;
    snap.minusDIPrev = adx.minusDI && prevI >= 0 ? adx.minusDI[prevI] : null;
  }

  if (candles && candles.length) {
    const kis = require("./kis-indicators.js");
    const patterns = kis.detectCandlePatterns(candles);
    snap.candleBullishEngulfing = !!patterns.bullishEngulfing;
    snap.candleBearishEngulfing = !!patterns.bearishEngulfing;
    snap.candleHammer = !!patterns.hammer;
    snap.candleShootingStar = !!patterns.shootingStar;
    snap.candleDoji = !!patterns.doji;

    const gap = kis.detectGap(candles);
    snap.gapUp = !!gap.up;
    snap.gapDown = !!gap.down;

    const streak = kis.consecutiveStreak(candles);
    snap.streakDirection = streak.direction;
    snap.streakCount = streak.count;
  }

  if (marketCapEok != null) snap.marketCapEok = marketCapEok;
  if (tradingValueEok != null) snap.tradingValueEok = tradingValueEok;
  if (periodReturns) snap.periodReturns = periodReturns;

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

  if (clause.type === "macd_cross") {
    const m0 = snap.macdPrev;
    const s0 = snap.macdSignalPrev;
    const m1 = snap.macdCur;
    const s1 = snap.macdSignalCur;
    if ([m0, s0, m1, s1].some((v) => v == null)) return false;
    return clause.direction === "down" ? m0 >= s0 && m1 < s1 : m0 <= s0 && m1 > s1;
  }

  if (clause.type === "macd_histogram_turn") {
    const h0 = snap.macdHistPrev;
    const h1 = snap.macdHistCur;
    if (h0 == null || h1 == null) return false;
    return clause.direction === "down" ? h0 >= 0 && h1 < 0 : h0 <= 0 && h1 > 0;
  }

  if (clause.type === "bollinger") {
    const c = snap.closeCur;
    const up = snap.bbUpperCur;
    const lo = snap.bbLowerCur;
    if (c == null || up == null || lo == null) return false;
    if (clause.position === "upper_break") return c > up;
    if (clause.position === "lower_break") return c < lo;
    if (clause.position === "upper_touch") return c >= up * 0.99 && c <= up * 1.02;
    if (clause.position === "lower_touch") return c <= lo * 1.01 && c >= lo * 0.98;
    return false;
  }

  if (clause.type === "stochastic") {
    const line = clause.line === "d" ? snap.stochDCur : snap.stochKCur;
    if (line == null) return false;
    if (clause.op === "lt") return line < clause.value;
    if (clause.op === "lte") return line <= clause.value;
    if (clause.op === "gt") return line > clause.value;
    if (clause.op === "gte") return line >= clause.value;
    return false;
  }

  if (clause.type === "stochastic_cross") {
    const k0 = snap.stochKPrev;
    const d0 = snap.stochDPrev;
    const k1 = snap.stochKCur;
    const d1 = snap.stochDCur;
    if ([k0, d0, k1, d1].some((v) => v == null)) return false;
    return clause.direction === "down" ? k0 >= d0 && k1 < d1 : k0 <= d0 && k1 > d1;
  }

  if (clause.type === "ma_alignment") {
    const a = snap.ma20Cur;
    const b = snap.ma60Cur;
    const c = snap.ma120Cur;
    const d = snap.ma200Cur;
    if ([a, b, c, d].some((v) => v == null)) return false;
    return clause.direction === "bearish" ? a < b && b < c && c < d : a > b && b > c && c > d;
  }

  if (clause.type === "disparity") {
    const c = snap.closeCur;
    const ma = snap[`ma${clause.period}Cur`];
    if (c == null || !ma) return false;
    const val = (c / ma) * 100;
    if (clause.op === "lt") return val < clause.value;
    if (clause.op === "lte") return val <= clause.value;
    if (clause.op === "gt") return val > clause.value;
    if (clause.op === "gte") return val >= clause.value;
    return false;
  }

  if (clause.type === "adx") {
    if (snap.adxCur == null) return false;
    return clause.op === "gt" ? snap.adxCur > clause.value : snap.adxCur >= clause.value;
  }

  if (clause.type === "di_cross") {
    const p0 = snap.plusDIPrev;
    const m0 = snap.minusDIPrev;
    const p1 = snap.plusDICur;
    const m1 = snap.minusDICur;
    if ([p0, m0, p1, m1].some((v) => v == null)) return false;
    return clause.direction === "down" ? p0 >= m0 && p1 < m1 : p0 <= m0 && p1 > m1;
  }

  if (clause.type === "candle_pattern") {
    const map = {
      bullish_engulfing: "candleBullishEngulfing",
      bearish_engulfing: "candleBearishEngulfing",
      hammer: "candleHammer",
      shooting_star: "candleShootingStar",
      doji: "candleDoji",
    };
    const key = map[clause.pattern];
    return key ? !!snap[key] : false;
  }

  if (clause.type === "gap") {
    return clause.direction === "down" ? !!snap.gapDown : !!snap.gapUp;
  }

  if (clause.type === "consecutive_candles") {
    const dir = clause.direction === "down" ? "down" : "up";
    const count = Number(clause.count) || 3;
    return snap.streakDirection === dir && (snap.streakCount || 0) >= count;
  }

  if (clause.type === "high52w_near") {
    if (snap.closeCur == null || !snap.high52wHigh) return false;
    const pct = Number(clause.withinPct) || 5;
    const diff = ((snap.high52wHigh - snap.closeCur) / snap.high52wHigh) * 100;
    return diff >= 0 && diff <= pct;
  }

  if (clause.type === "market_cap") {
    if (snap.marketCapEok == null) return false;
    if (clause.op === "lt") return snap.marketCapEok < clause.value;
    if (clause.op === "lte") return snap.marketCapEok <= clause.value;
    if (clause.op === "gt") return snap.marketCapEok > clause.value;
    if (clause.op === "gte") return snap.marketCapEok >= clause.value;
    return false;
  }

  if (clause.type === "trading_value") {
    if (snap.tradingValueEok == null) return false;
    if (clause.op === "lt") return snap.tradingValueEok < clause.value;
    if (clause.op === "lte") return snap.tradingValueEok <= clause.value;
    if (clause.op === "gt") return snap.tradingValueEok > clause.value;
    if (clause.op === "gte") return snap.tradingValueEok >= clause.value;
    return false;
  }

  if (clause.type === "period_return") {
    const days = Number(clause.days);
    const pct = snap.periodReturns && snap.periodReturns[days] != null ? snap.periodReturns[days] : null;
    if (pct == null) return false;
    if (clause.op === "lt") return pct < clause.value;
    if (clause.op === "lte") return pct <= clause.value;
    if (clause.op === "gt") return pct > clause.value;
    if (clause.op === "gte") return pct >= clause.value;
    return false;
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
