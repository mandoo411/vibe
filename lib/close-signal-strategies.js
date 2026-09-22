/**
 * 종가시그널 — 매매기법 카탈로그 (2026-09-21 신설)
 *
 * 왜 기법을 여러 개 두는가: 2026-09-14~09-18 5거래일 실측에서 단일 점수 모델의 상위 3종목이
 * 오히려 전체 후보 평균보다 나빴다(시가 -0.07% / 종가 -1.33%). 팩터 하나하나는 표본이 작아
 * 노이즈에 쉽게 휘둘리는데, 점수를 한 줄로 합치면 그 노이즈가 그대로 순위가 된다.
 *
 * 그래서 **서로 다른 근거를 쓰는 기법 8종을 독립적으로 돌리고, 몇 개 기법에 동시에 걸렸는지
 * (합의도)를 점수의 가장 큰 축으로 삼는다.** 한 기법만 잡은 종목은 그 기법의 오차일 수 있지만,
 * 성격이 다른 기법 다섯이 같은 종목을 가리키면 우연일 확률이 그만큼 줄어든다.
 *
 * 실측(2026-09-14~09-18, 하드필터 통과 147종목, 익일 결과 확인분):
 *   합의 0개 → 익일 시가 -0.56% / 종가 -0.98%
 *   합의 3개 이상 → 시가 +0.87% / 종가 +1.39%
 *   합의 4개 이상 → 시가 +0.91% / 종가 +1.92%
 *
 * ⚠️ 여기 쓰는 지표는 전부 lib/intraday-snapshot.js의 INTRADAY_UPDATED 안에 있는 것들이다.
 * RSI·MACD·볼린저·스토캐스틱은 장중 스냅샷에서 전일 값이 그대로 남아 있어 쓰면 안 된다.
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * 채점·기법 판정에 쓰는 값들을 스캔 행 하나에서 뽑아 평평하게 만든다.
 * 스냅샷 구조를 아는 곳을 여기 한 곳으로 모아, 기법을 추가할 때 스냅샷 내부를 몰라도 되게 한다.
 */
function extractFeatures(row) {
  const s = (row && row.snapshot) || {};
  const f = {};
  f.name = String((row && row.name) || "");
  f.market = (row && row.market) || null;
  f.sector = s.sector || null;

  f.close = num(s.closeCur != null ? s.closeCur : row && row.close);
  f.closePrev = num(s.closePrev);
  f.open = num(s.openCur);
  f.high = num(s.highCur);
  f.low = num(s.lowCur);
  f.changePct = num(row && row.changePct);

  f.tradingValueEok = num(row && row.tradingValueEok != null ? row.tradingValueEok : s.tradingValueEok);
  f.marketCapEok = num(row && row.marketCapEok != null ? row.marketCapEok : s.marketCapEok);
  f.turnoverPct =
    f.tradingValueEok != null && f.marketCapEok ? (f.tradingValueEok / f.marketCapEok) * 100 : null;
  f.volumeRatio = num(s.volumeRatio);

  /* 종가위치 = (종가-저가)/(고가-저가). 고가=저가(점상한가 등)는 1로 본다. */
  if (f.high != null && f.low != null && f.close != null) {
    f.closePosition = f.high <= f.low ? 1 : Math.min(1, Math.max(0, (f.close - f.low) / (f.high - f.low)));
  } else {
    f.closePosition = null;
  }
  /* 갭 = 시가가 전일 종가보다 위에서 출발했는가. 2026-09 실측에서 익일 시가수익률을
   * 가장 깔끔하게 갈랐던 값이다(갭업 +0.78% vs 갭다운 -0.07%). */
  f.gapPct = f.open != null && f.closePrev ? ((f.open - f.closePrev) / f.closePrev) * 100 : null;
  f.bodyPct = f.open && f.close != null ? ((f.close - f.open) / f.open) * 100 : null;

  f.ma5 = num(s.ma5Cur);
  f.ma10 = num(s.ma10Cur);
  f.ma20 = num(s.ma20Cur);
  f.ma60 = num(s.ma60Cur);
  f.disparity5 = f.close != null && f.ma5 ? (f.close / f.ma5) * 100 : null;
  f.aligned = f.ma5 != null && f.ma10 != null && f.ma20 != null ? f.ma5 > f.ma10 && f.ma10 > f.ma20 : null;

  const pr = s.periodReturns || {};
  f.r5 = num(pr[5]);
  f.r21 = num(pr[21]);
  f.r252 = num(pr[252]);

  const w = s.highBreakoutByWindow || {};
  f.breakoutLevel = s.high52wBreakout ? 5 : w[240] ? 4 : w[120] ? 3 : w[60] ? 2 : w[20] ? 1 : 0;

  f.foreignNetBuy = num(s.foreignNetBuy);
  f.institutionNetBuy = num(s.institutionNetBuy);
  f.foreignNetBuyEok = num(s.foreignNetBuyEok);
  f.institutionNetBuyEok = num(s.institutionNetBuyEok);
  f.bothNetBuy = f.foreignNetBuy > 0 && f.institutionNetBuy > 0;
  f.majorNetBuyEok = (f.foreignNetBuyEok || 0) + (f.institutionNetBuyEok || 0);
  f.foreignStreak = num(s.foreignNetBuyStreak);
  f.institutionStreak = num(s.institutionNetBuyStreak);

  f.lateStrengthPct = num(row && row.lateStrengthPct);

  const cat = row && row.catalyst;
  f.catalystScore = cat && Number.isFinite(Number(cat.score)) ? Number(cat.score) : 0;
  f.catalystSummary = cat && cat.summary ? String(cat.summary) : null;
  f.catalystPresent = !!(cat && cat.present);

  f.tempStopYn = s.tempStopYn === true;
  f.settlementTradeYn = s.settlementTradeYn === true;
  return f;
}

/**
 * 매매기법 9종 + 재료 1종.
 * label은 화면에 그대로 나가므로 "추천"이 아니라 조건의 이름으로만 쓴다.
 * why는 종목 상세에서 "왜 이 기법에 걸렸는가"를 한 줄로 설명하는 데 쓴다.
 *
 * (2026-09-22 추가) gapModerate — 저장된 1520 스냅샷 9/14~9/21로 "갭+거래량" 조합을 되짚어본 결과:
 *   갭업 출발 + 거래량비 200% 미만(과열 아님) → 익일 시가 승률 71.2%
 *   갭업 출발 + 거래량비 200% 이상(과열)     → 익일 시가 승률 58.3%
 *   거래량비 150% 이상인데 갭은 없음          → 익일 시가 승률 32.3%(가장 나쁨, 평균 -0.23%)
 * 거래량 급증은 그 자체로 좋은 신호가 아니라 갭이 없으면 오히려 과열/되돌림 경고에 가까웠다.
 * 그래서 "갭업만"이 "갭업+거래량폭증"보다 좋은 조합을 별도 기법으로 명시한다.
 */
const STRATEGIES = [
  {
    key: "institution",
    label: "기관 동반 강세",
    desc: "기관이 순매수한 날의 강세 마감",
    why: "기관 순매수 + 당일 강세 마감",
    test: (f) => f.institutionNetBuy > 0 && f.changePct >= 2 && f.closePosition != null && f.closePosition >= 0.6,
  },
  {
    key: "bothFlow",
    label: "외국인·기관 양매수",
    desc: "두 주체가 같은 날 함께 사들인 종목",
    why: "외국인·기관 동시 순매수",
    test: (f) => f.bothNetBuy,
  },
  {
    key: "gapHold",
    label: "갭업 지속",
    desc: "위에서 출발해 시가보다 높게 마감",
    why: "갭 상승 출발 후 시가 위에서 마감",
    test: (f) => f.gapPct > 0 && f.open != null && f.close > f.open && f.changePct >= 3,
  },
  {
    key: "gapModerate",
    label: "적정 갭 모멘텀",
    desc: "갭으로 출발해 거래량 과열 없이 강세로 마감",
    why: "갭 상승 출발 + 거래량 과열 아님(평소 대비 200% 미만) + 당일 +2~10%",
    test: (f) =>
      f.gapPct > 0 && (f.volumeRatio == null || f.volumeRatio < 200) &&
      f.changePct >= 2 && f.changePct < 10 &&
      f.closePosition != null && f.closePosition >= 0.55,
  },
  {
    key: "smallTurnover",
    label: "중소형 회전 집중",
    desc: "시총 대비 거래대금이 크게 몰린 중소형주",
    why: "시총 1조 미만 + 회전율 8% 이상",
    test: (f) => f.marketCapEok != null && f.marketCapEok < 10000 && f.turnoverPct >= 8 && f.changePct >= 3,
  },
  {
    key: "momentum",
    label: "모멘텀 연장",
    desc: "최근 5일 상승 흐름을 이어가는 자리",
    why: "5일 누적 +15% 이상 + 5일선 위",
    test: (f) => f.r5 >= 15 && f.changePct >= 3 && f.ma5 != null && f.close > f.ma5,
  },
  {
    key: "kosdaqLead",
    label: "코스닥 주도 강세",
    desc: "20일선 위에서 힘있게 마감한 코스닥 종목",
    why: "코스닥 + 20일선 위 강세 마감",
    test: (f) =>
      f.market === "KOSDAQ" && f.changePct >= 3 && f.closePosition != null && f.closePosition >= 0.6 &&
      f.ma20 != null && f.close > f.ma20,
  },
  {
    key: "longTrend",
    label: "장기 추세 상위",
    desc: "1년 수익률이 높은 추세주의 강세일",
    why: "1년 수익률 +50% 이상 + 거래대금 200억 이상",
    test: (f) => f.r252 >= 50 && f.tradingValueEok >= 200 && f.changePct >= 2,
  },
  {
    key: "liquidity",
    label: "대금 집중",
    desc: "거래대금과 회전율이 함께 큰 종목",
    why: "거래대금 300억 이상 + 회전율 5% 이상",
    test: (f) => f.tradingValueEok >= 300 && f.turnoverPct >= 5 && f.changePct >= 2,
  },
  {
    key: "catalyst",
    label: "재료 동반",
    desc: "당일 호재성 공시가 확인된 종목",
    why: "당일 DART 공시(공급계약·무상증자·기술이전 등)",
    test: (f) => f.catalystScore >= 10,
  },
];

/** 이 종목을 잡아낸 기법들을 돌려준다. */
function matchStrategies(f) {
  const hits = [];
  for (const s of STRATEGIES) {
    let ok = false;
    try {
      ok = !!s.test(f);
    } catch (e) {
      ok = false;
    }
    if (ok) hits.push({ key: s.key, label: s.label, why: s.why });
  }
  return hits;
}

module.exports = { STRATEGIES, matchStrategies, extractFeatures };
