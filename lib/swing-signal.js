/**
 * 1주 스윙 시그널 — 2026-10-02 신설 (시우 요청: "1주 사이 투자해볼 만한 스윙 종목").
 *
 * 전제: **선정일 15:20 가격에 매수 → 5거래일 뒤 종가에 매도.** (금요일 선정 → 다음 주 금요일 종가)
 * 종가시그널(익일 매도)과 같은 1520 스캔 결과(400종목 스냅샷)를 그대로 재사용한다 — KIS 추가 호출 없음.
 *
 * 왜 종가시그널과 모델을 따로 두나: 하루 보유는 "내일 아침 갭"이 거의 전부라 당일 수급·갭이 핵심이지만,
 * 5거래일 보유는 **추세의 질(이평 배열·기울기), 눌림 위치, 며칠에 걸친 수급 누적**이 결과를 가른다.
 * 같은 점수로 두 기간을 고르면 어느 쪽에도 맞지 않는다.
 *
 * 구조는 종가시그널 v2와 같다 — 성격이 다른 스윙 기법(현재 10종)을 독립적으로 판정하고, 몇 개가 같은 종목을
 * 가리키는지(합의도)를 가장 큰 배점 축으로 둔다. 단일 지표의 우연을 줄이기 위함이다.
 *
 * 기법 출처(널리 알려진 스윙 매매 정석): 20일선 눌림목, 정배열 단기 눌림, 박스(60·120일) 돌파,
 * 52주 고점 근접 추세(조지·황 2004 '52주 신고가 효과'), 볼린저 밴드 수축 후 확장, MACD 상승 전환,
 * 이평 골든크로스 초기, 기관·외국인 연속 매집, 상대강도(1개월 모멘텀 + ADX), 상승 추세 속 과매도 반등,
 * 지지선 반전 캔들, 거래량 동반 첫 장대양봉.
 *
 * ⚠️ 장중(15:20) 스냅샷에서 RSI·MACD·볼린저·스토캐스틱·ADX·캔들패턴은 **전일 마감 기준 값**이다
 * (lib/intraday-snapshot.js INTRADAY_STALE). 5거래일 보유에서는 하루 늦은 지표도 쓸 만해서 쓰되,
 * 기법 설명(why)에 "전일 기준"을 밝힌다. 이동평균·수급·등락률·거래량은 당일 값이다.
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

const PREFERRED_RE = /\d?우[BC]?$/;
const SPAC_RE = /스팩/;

/* 하드필터 — 5일 보유라 종가시그널보다 유동성 기준은 낮추고, 추세 조건은 더 엄격하게 */
const MIN_TRADING_VALUE_EOK = 50;
const MIN_MARKET_CAP_EOK = 1000;
const MIN_CHANGE_PCT = -5;
const MAX_CHANGE_PCT = 15;

function swingFeatures(row) {
  const s = (row && row.snapshot) || {};
  const f = {};
  f.name = String((row && row.name) || "");
  f.market = (row && row.market) || null;
  f.close = num(s.closeCur != null ? s.closeCur : row && row.close);
  f.open = num(s.openCur);
  f.high = num(s.highCur);
  f.low = num(s.lowCur);
  f.closePrev = num(s.closePrev);
  f.changePct = num(row && row.changePct);
  f.tradingValueEok = num(row && row.tradingValueEok != null ? row.tradingValueEok : s.tradingValueEok);
  f.marketCapEok = num(row && row.marketCapEok != null ? row.marketCapEok : s.marketCapEok);
  f.volumeRatio = num(s.volumeRatio);
  if (f.high != null && f.low != null && f.close != null) {
    f.closePosition = f.high <= f.low ? 1 : clamp((f.close - f.low) / (f.high - f.low), 0, 1);
  } else f.closePosition = null;

  f.ma5 = num(s.ma5Cur);
  f.ma10 = num(s.ma10Cur);
  f.ma20 = num(s.ma20Cur);
  f.ma60 = num(s.ma60Cur);
  f.ma120 = num(s.ma120Cur);
  f.ma20Prev = num(s.ma20Prev);
  f.ma60Prev = num(s.ma60Prev);
  f.ma20Rising = f.ma20 != null && f.ma20Prev != null ? f.ma20 > f.ma20Prev : null;
  f.ma60Rising = f.ma60 != null && f.ma60Prev != null ? f.ma60 > f.ma60Prev : null;
  f.dist20 = f.close != null && f.ma20 ? (f.close / f.ma20 - 1) * 100 : null; // 20일선 이격(%)
  f.dist60 = f.close != null && f.ma60 ? (f.close / f.ma60 - 1) * 100 : null;
  f.lowDist20 = f.low != null && f.ma20 ? (f.low / f.ma20 - 1) * 100 : null;
  f.distMa5 = f.close != null && f.ma5 ? (f.close / f.ma5 - 1) * 100 : null;
  f.aligned = [f.ma5, f.ma10, f.ma20, f.ma60].every((v) => v != null) && f.ma5 > f.ma10 && f.ma10 > f.ma20 && f.ma20 > f.ma60;
  f.midTrendUp = f.ma20 != null && f.ma60 != null && f.ma20 > f.ma60;

  const pr = s.periodReturns || {};
  f.r5 = num(pr[5]);
  f.r21 = num(pr[21]);
  f.r63 = num(pr[63]);
  f.r252 = num(pr[252]);

  // 전일 기준 지표(장중 갱신 안 됨)
  f.rsi = num(s.rsiCur);
  f.macdHist = num(s.macdHistCur);
  f.macdHistPrev = num(s.macdHistPrev);
  f.bbWidth = num(s.bbWidthCur);
  f.bbUpper = num(s.bbUpperCur);
  f.bbMid = num(s.bbMidCur);
  f.adx = num(s.adxCur);
  f.plusDI = num(s.plusDICur);
  f.minusDI = num(s.minusDICur);
  f.stochK = num(s.stochKCur);
  f.candleBull = s.candleBullishEngulfing === true || s.candleHammer === true;

  const ds = s.daysSince || {};
  f.dMacdUp = num(ds.macd_up);
  f.dMa5_20Up = num(ds.ma_5_20_up);
  f.dMa20_60Up = num(ds.ma_20_60_up);
  f.dStochUp = num(ds.stoch_up);

  const w = s.highBreakoutByWindow || {};
  f.breakout60 = !!w[60];
  f.breakout120 = !!(w[120] || w[240] || s.high52wBreakout);
  f.high52 = num(s.high52wHigh);
  f.nearHigh52 = f.high52 && f.close != null ? (f.close / f.high52) * 100 : null;

  f.foreignNetBuy = num(s.foreignNetBuy);
  f.institutionNetBuy = num(s.institutionNetBuy);
  f.foreignNetBuyEok = num(s.foreignNetBuyEok);
  f.institutionNetBuyEok = num(s.institutionNetBuyEok);
  f.foreignStreak = num(s.foreignNetBuyStreak) || 0;
  f.institutionStreak = num(s.institutionNetBuyStreak) || 0;
  f.majorStreak = num(s.majorNetBuyStreak) || 0;
  f.bothNetBuy = f.foreignNetBuy > 0 && f.institutionNetBuy > 0;

  f.tempStopYn = s.tempStopYn === true;
  f.settlementTradeYn = s.settlementTradeYn === true;
  return f;
}

/* 스윙 기법 10종. label은 화면에 그대로 나가므로 조건의 이름으로만 쓴다(추천 표현 금지).
 *
 * v2(2026-10-02 같은 날 재설계) — v1 12종을 저장 스냅샷 9/14~9/22 선정분(필터 통과 1,180건, 5거래일 결과)으로
 * 되짚어 보니 "눌림목·정배열 조정·밴드 수축·ADX 상대강도·장대양봉(거래량 200%↑)" 다섯은 통과 전체 평균(+1.59%)보다
 * 1.5~1.9%p 나빴고(수익 비율 34~39%), v1 상위 5종목은 -0.70%(수익 비율 26%)로 전체보다 못했다.
 * 같은 표본에서 전체보다 나았던 것: 박스권 돌파 +3.18 · 52주 고점권 +2.73 · MACD 전환 +3.00 ·
 * 골든크로스 초기 +2.98 · 반전 캔들 +2.64. 그리고 기법이 아닌 "자리" 쪽에서
 *   시총 3천억~1조 +4.97%(63%) > 1~5조 +2.21 > 5조↑ -0.28 · 3천억↓ -1.20 / 코스닥 +4.00 vs 코스피 -0.66 /
 *   5일 +5~25% 구간 > 0% 미만 / 20일선 이격 3% 이상 > 3% 미만 / RSI 60~70 +2.50 / 거래량비 300%↑ -0.03 /
 *   외국인 연속 매수 3일↑ +2.67(53%) vs 기관 연속 3일↑ +1.09(41%).
 * → 눌림 계열은 뺐고, 단기 모멘텀이 이어지는 중형주 쪽으로 기법과 배점을 옮겼다.
 * ⚠️ 7거래일·한 장세(중소형 강세)의 표본이다. 기록이 20주 이상 쌓이면 다시 되짚을 것.
 */
const SWING_STRATEGIES = [
  {
    key: "boxBreakout",
    label: "박스권 돌파",
    desc: "60·120일 고점을 거래량과 함께 넘어선 종목",
    why: "60일 이상 고점 돌파 + 거래량 평소 130~300% + 종가가 하루 범위 위쪽",
    test: (f) => (f.breakout60 || f.breakout120) && f.volumeRatio >= 130 && f.volumeRatio < 300 && f.closePosition >= 0.6 && f.changePct > 0,
  },
  {
    key: "high52Trend",
    label: "52주 고점권 추세",
    desc: "1년 고점 부근에서 버티는 강한 추세주",
    why: "52주 최고가의 90% 이상 + 20일선 위 + 3개월 수익률 플러스",
    test: (f) => f.nearHigh52 >= 90 && f.dist20 > 0 && f.r63 > 0,
  },
  {
    key: "macdTurn",
    label: "MACD 상승 전환",
    desc: "MACD가 시그널선을 상향 돌파한 초기",
    why: "MACD 골든크로스 3일 이내(전일 기준) + 히스토그램 증가 + 20일선 위",
    test: (f) => f.dMacdUp != null && f.dMacdUp <= 3 && f.macdHist > f.macdHistPrev && f.dist20 > 0,
  },
  {
    key: "goldenCross",
    label: "이평 골든크로스 초기",
    desc: "단기선이 중기선을 막 뚫고 올라선 직후",
    why: "5일선이 20일선을 3일 내 상향 돌파 또는 20일선이 60일선을 5일 내 상향 돌파",
    test: (f) => ((f.dMa5_20Up != null && f.dMa5_20Up <= 3) || (f.dMa20_60Up != null && f.dMa20_60Up <= 5)) && f.dist20 > 0,
  },
  {
    key: "momentumRun",
    label: "단기 모멘텀 지속",
    desc: "최근 5일 오름세가 과열 전 구간에서 이어지는 종목",
    why: "5일 +5~25% + 20일선 3~15% 위 + 종가가 하루 범위 절반 위",
    test: (f) => f.r5 >= 5 && f.r5 <= 25 && f.dist20 >= 3 && f.dist20 <= 15 && f.closePosition >= 0.5,
  },
  {
    key: "foreignAccum",
    label: "외국인 연속 매수",
    desc: "외국인이 며칠째 이어서 사들이는 종목",
    why: "외국인 3거래일 이상 연속 순매수 + 20일선 위",
    test: (f) => f.foreignStreak >= 3 && f.dist20 > 0,
  },
  {
    key: "healthyRsi",
    label: "추세 강도 적정권",
    desc: "RSI가 강세권이지만 과열 전인 종목",
    why: "RSI 58~72(전일) + 20일선 위 + 거래량 과열(300%↑) 아님",
    test: (f) => f.rsi >= 58 && f.rsi <= 72 && f.dist20 > 0 && (f.volumeRatio == null || f.volumeRatio < 300),
  },
  {
    key: "oversoldBounce",
    label: "추세 속 과매도 반등",
    desc: "장기 상승 추세에서 단기 과매도 후 반등 시작",
    why: "120일선 위 + RSI 30~45(전일) + 스토캐스틱 상향 2일 내 + 당일 상승",
    test: (f) => f.ma120 != null && f.close > f.ma120 && f.rsi >= 30 && f.rsi <= 45 && f.dStochUp != null && f.dStochUp <= 2 && f.changePct > 0,
  },
  {
    key: "reversalCandle",
    label: "지지 반전 캔들",
    desc: "지지선 부근 반전형 캔들 뒤 양봉으로 확인",
    why: "전일 망치형·상승장악형 + 당일 상승 + 60일선 위",
    test: (f) => f.candleBull && f.changePct > 0 && f.dist60 > 0,
  },
  {
    key: "volumeIgnite",
    label: "거래량 점화",
    desc: "평소보다 거래가 붙으며 강하게 마감한 날(과열 전)",
    why: "거래량 평소 150~300% + 당일 +3~15% + 종가 하루 범위 60% 위",
    test: (f) => f.volumeRatio >= 150 && f.volumeRatio < 300 && f.changePct >= 3 && f.changePct <= 15 && f.closePosition >= 0.6,
  },
];

function matchSwing(f) {
  const hits = [];
  for (const s of SWING_STRATEGIES) {
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

function swingHardFilter(f) {
  if (f.tempStopYn || f.settlementTradeYn) return "거래정지·정리매매";
  if (SPAC_RE.test(f.name) || PREFERRED_RE.test(f.name)) return "스팩·우선주";
  if (f.tradingValueEok == null || f.tradingValueEok < MIN_TRADING_VALUE_EOK) return "거래대금 50억 미만";
  if (f.marketCapEok == null || f.marketCapEok < MIN_MARKET_CAP_EOK) return "시총 1,000억 미만";
  if (f.changePct == null || f.changePct < MIN_CHANGE_PCT || f.changePct > MAX_CHANGE_PCT) return "당일 등락 범위 밖";
  if (f.close == null || f.ma60 == null || f.close <= f.ma60) return "60일선 아래(하락 추세)";
  return null;
}

/* 배점 v2: 기법 합의 40 · 모멘텀 자리 25 · 체급·시장 20 · 수급 15 = 100. 감점 별도. (근거는 위 SWING_STRATEGIES 주석) */
const W = { consensus: 40, momentum: 25, size: 20, flow: 15 };

function scoreSwing(row) {
  const f = swingFeatures(row);
  const rejected = swingHardFilter(f);
  if (rejected) return { passed: false, reason: rejected, features: f };
  const hits = matchSwing(f);
  const consensus = hits.length;

  const parts = {};
  parts.consensus = (W.consensus * Math.min(consensus, 5)) / 5;

  let m = 0;
  if (f.r5 != null) m += f.r5 >= 5 && f.r5 <= 25 ? 10 : f.r5 > 0 && f.r5 < 5 ? 4 : 0;
  if (f.dist20 != null) m += f.dist20 >= 3 && f.dist20 <= 15 ? 8 : f.dist20 > 15 && f.dist20 <= 25 ? 4 : 0;
  if (f.rsi != null) m += f.rsi >= 55 && f.rsi <= 72 ? 7 : f.rsi >= 45 && f.rsi < 55 ? 3 : 0;
  parts.momentum = Math.min(W.momentum, m);

  let z = 0;
  const cap = f.marketCapEok;
  if (cap != null) z += cap >= 3000 && cap < 10000 ? 12 : cap >= 10000 && cap < 30000 ? 8 : cap >= 30000 && cap < 50000 ? 4 : 1;
  if (f.market === "KOSDAQ") z += 8;
  parts.size = Math.min(W.size, z);

  let fl = 0;
  if (f.foreignStreak >= 3) fl += 8;
  else if (f.foreignStreak >= 1) fl += 4;
  if (f.bothNetBuy) fl += 4;
  else if (f.foreignNetBuy > 0) fl += 3;
  if (f.majorStreak >= 2) fl += 3;
  parts.flow = Math.min(W.flow, fl);

  const penalties = [];
  if (f.volumeRatio != null && f.volumeRatio >= 300) penalties.push({ label: "거래량 과열(300%↑)", pts: 6 });
  if (f.r5 != null && f.r5 > 30) penalties.push({ label: "5일 +30% 넘는 급등 후", pts: 8 });
  if (f.rsi != null && f.rsi > 78) penalties.push({ label: "RSI 과열(전일)", pts: 6 });
  if (f.dist20 != null && f.dist20 > 25) penalties.push({ label: "20일선 이격 과다", pts: 6 });
  const penalty = penalties.reduce((a, b) => a + b.pts, 0);

  const raw = parts.consensus + parts.momentum + parts.size + parts.flow - penalty;
  return {
    passed: true,
    score: round1(clamp(raw, 0, 100)),
    consensus,
    strategies: hits,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round1(v)])),
    penalties,
    features: f,
  };
}

/**
 * 상위 N종목. 기법이 2개 미만인 종목은 상위에 올리지 않는다(자리가 안 차면 점수순으로 채움).
 * @returns {{ranked: object[], stats: object}}
 */
function rankSwing(stocks, n = 5) {
  const scored = [];
  let passed = 0;
  for (const row of stocks || []) {
    const r = scoreSwing(row);
    if (!r.passed) continue;
    passed += 1;
    scored.push({ row, r });
  }
  scored.sort((a, b) => b.r.score - a.r.score || b.r.consensus - a.r.consensus);
  const strong = scored.filter((x) => x.r.consensus >= 2);
  const pick = strong.slice(0, n);
  if (pick.length < n) for (const x of scored) if (pick.length < n && !pick.includes(x)) pick.push(x);
  const ranked = pick.map((x, i) => {
    const f = x.r.features;
    return {
      rank: i + 1,
      code: x.row.code,
      name: x.row.name,
      market: x.row.market || null,
      close: f.close,
      changePct: f.changePct,
      score: x.r.score,
      consensus: x.r.consensus,
      strategies: x.r.strategies,
      parts: x.r.parts,
      penalties: x.r.penalties,
      facts: {
        dist20: f.dist20 != null ? round1(f.dist20) : null,
        r5: f.r5,
        r21: f.r21,
        rsi: f.rsi != null ? round1(f.rsi) : null,
        institutionStreak: f.institutionStreak,
        foreignStreak: f.foreignStreak,
        marketCapEok: f.marketCapEok != null ? Math.round(f.marketCapEok) : null,
      },
    };
  });
  return { ranked, stats: { total: (stocks || []).length, passed, withStrategy: strong.length } };
}

module.exports = { SWING_STRATEGIES, swingFeatures, matchSwing, scoreSwing, rankSwing, swingHardFilter };
