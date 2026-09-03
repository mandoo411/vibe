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
 *
 * 2026-08-26: 키움 HTS급 조건검색을 목표로 대폭 확장.
 *  1) Boolean 트리 지원 — condition은 여전히 {logic, clauses} 최상위 형태지만, clauses 배열의
 *     각 원소가 이제 "leaf 조건" 뿐 아니라 {type:"group", logic:"AND"|"OR", clauses:[...]} 형태의
 *     중첩 그룹도 될 수 있다. 모든 leaf/group에는 선택적으로 negate:true를 붙일 수 있어
 *     "!F"(NOT F) 같은 키움식 부정 조건을 그대로 표현한다. 기존에 DB에 저장된 전략은
 *     {logic:"AND", clauses:[순수 leaf...]} 형태 그대로이므로 100% 하위호환된다(그룹/negate가
 *     없으면 예전과 완전히 동일하게 평가됨).
 *  2) 신규 leaf 타입 — price(현재가), per/pbr/eps(밸류에이션), foreign_hold_rate/volume_turnover_rate
 *     (KIS inquire-price에 이미 포함된 필드, 추가 API 호출 없음), foreign_net_buy/institution_net_buy
 *     (KIS inquire-investor 신규 호출), high_breakout_n/low_breakdown_n/volume_record_high_n
 *     (커스텀 봉수 신고가·신저가·신고거래량 — 52주 고정값 대신 20/60/120/240봉 중 선택).
 *  3) disparity/ma_cross/price_cross_ma는 MA_PERIODS에 240을 추가해 "이격도 240일선" 같은
 *     조건도 자동으로 커버된다(로직 변경 없이 스냅샷 필드만 추가하면 기존 코드가 그대로 동작).
 *  4) within(최근 N봉 이내 1회 이상 발생) — 크로스/갭류 이벤트 타입에 한해 clause에
 *     within:{bars:N}을 추가하면, "가장 최근 발생이 오늘"이 아니라 "최근 N봉 안에 한 번이라도
 *     발생"으로 판정한다. 스냅샷에 미리 계산해 둔 daysSince 맵을 참조한다. within이 없으면
 *     기존과 완전히 동일하게 "직전 봉→오늘 봉" 전환만 확인한다(하위호환 유지).
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
  // 2026-08-26 신규
  "price",
  "per",
  "pbr",
  "eps",
  "foreign_hold_rate",
  "volume_turnover_rate",
  "foreign_net_buy",
  "institution_net_buy",
  // 2026-09-03: 재무비율(DART 사업보고서 최근 결산 기준). data/dart-financial-ratios.json을
  // 검색 시 스냅샷에 조인해서 쓴다 — KIS 시세 캐시엔 재무 항목이 없기 때문이다.
  "debt_ratio",
  "operating_margin",
  "net_margin",
  "roe",
  "current_ratio",
  "high_breakout_n",
  "low_breakdown_n",
  "volume_record_high_n",
];

const MA_PERIODS = [5, 10, 20, 60, 120, 200, 240];
const WINDOW_BAR_OPTIONS = [20, 60, 120, 240];
/** ma_cross에서 실제로 의미 있는(fast<slow) 조합만 사전 계산 대상으로 삼는다. */
const MA_CROSS_PAIRS = [];
for (const fast of MA_PERIODS) {
  for (const slow of MA_PERIODS) {
    if (fast < slow) MA_CROSS_PAIRS.push([fast, slow]);
  }
}

const CONDITION_GUIDE = `condition.clauses[].type로 쓸 수 있는 값과 필드 (이 목록 밖의 type은 절대 쓰지 말 것):
- ma_cross: {fast:5|10|20|60|120|200|240, slow:5|10|20|60|120|200|240, direction:"up"|"down"} — 이동평균선끼리
  골든/데드크로스 (fast는 반드시 slow보다 짧은 기간이어야 함. "5일선 20일선 골든크로스"→fast:5,slow:20)
- price_cross_ma: {period:5|10|20|60|120|200|240, direction:"up"|"down"} — 현재가가 이동평균선을 돌파
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
- disparity: {period:5|10|20|60|120|200|240, op:"lt"|"lte"|"gt"|"gte", value:숫자(%)} — 이격도
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
  ⚠️ 환산표를 그대로 따를 것. 1조=10000, 1000억=1000, **"십억"=10** (HTS 조건식은 십억 단위를
  자주 쓴다 — "시가총액 500십억 원 이상"은 5,000억이므로 value:5000이지 500이 아니다),
  1억=1, "100만 달러" 같은 외화 단위는 환산 불가이므로 조건 전체를 understood=false로 거절할 것
- trading_value: {op:"lt"|"lte"|"gt"|"gte", value:숫자(억원)} — 당일 누적 거래대금. "거래대금 50억
  이상"이면 value:50, op:"gte" (단위는 항상 억원으로 환산). 사용자가 "거래량"이라고 말해도 억/원
  단위를 언급했다면(예: "거래량 50억") 실제로는 거래대금을 의미하는 것이므로 trading_value로 처리할 것
- period_return: {days:5|21|63|126|252, op:"lt"|"lte"|"gt"|"gte", value:숫자(%)} — N거래일 전 종가
  대비 현재 종가의 누적 등락률. 기간 표현은 영업일 기준으로 환산: 1주≈5, 1개월≈21, 3개월≈63,
  6개월≈126, 1년≈252. "최근 3달 안에 20% 이상 상승"이면 days:63, op:"gte", value:20
- price: {op:"lt"|"lte"|"gt"|"gte", value:숫자(원)} — 현재가(종가) 자체를 원 단위로 비교. "주가
  1000원 이상"이면 op:"gte", value:1000. "주가범위 2000~50000"처럼 범위면 clauses에 gte/lte
  두 개를 나눠 넣을 것
- per: {op:"lt"|"lte"|"gt"|"gte", value:숫자} — PER(주가수익비율)
- pbr: {op:"lt"|"lte"|"gt"|"gte", value:숫자} — PBR(주가순자산비율)
- eps: {op:"lt"|"lte"|"gt"|"gte", value:숫자(원)} — EPS(주당순이익)
- foreign_hold_rate: {op:"lt"|"lte"|"gt"|"gte", value:숫자(%)} — 외국인 보유율
- volume_turnover_rate: {op:"lt"|"lte"|"gt"|"gte", value:숫자(%)} — 거래량 회전율(상장주식수 대비
  당일 거래량 비율)
- foreign_net_buy: {op:"lt"|"lte"|"gt"|"gte", value:숫자(주)} — 외국인 당일(직전 영업일) 순매수
  수량. 음수면 순매도. "외국인 순매수"라고만 하면 op:"gt", value:0
- institution_net_buy: {op:"lt"|"lte"|"gt"|"gte", value:숫자(주)} — 기관 당일(직전 영업일) 순매수
  수량. "기관 순매수"라고만 하면 op:"gt", value:0
- high_breakout_n: {windowBars:20|60|120|240} — 최근 windowBars봉 중 신고가 갱신(52주 고정이 아닌
  커스텀 기간). "120봉중 신고가"면 windowBars:120
- low_breakdown_n: {windowBars:20|60|120|240} — 최근 windowBars봉 중 신저가 갱신
- volume_record_high_n: {windowBars:60|120|240} — 최근 windowBars봉 중 거래량 최고치(신고거래량)

재무비율(DART 사업보고서 "최근 결산" 기준 — 시세가 아니라 연 1회 갱신되는 값이다):
- debt_ratio: {op, value} — 부채비율(%) = 부채총계/자본총계×100. "부채비율 150% 이하"
- operating_margin: {op, value} — 영업이익률(%) = 영업이익/매출액×100. "영업이익률 7% 이상"
- net_margin: {op, value} — 순이익률(%) = 당기순이익/매출액×100
- roe: {op, value} — ROE(%) = 당기순이익/자본총계×100. "자기자본이익률"도 같은 뜻
- current_ratio: {op, value} — 유동비율(%) = 유동자산/유동부채×100
  ※ "최근 결산", "전년도 기준" 같은 수식어는 이 값들이 이미 최근 결산 기준이므로 무시하면 된다.
  ※ **이자보상배율은 아직 지원하지 않는다**(이자비용 데이터가 없음). 요청받으면 위의
     "표현할 수 없는 조건" 규칙대로 understood=false로 거절할 것 — 임의로 다른 지표로
     바꿔치기하면 절대 안 된다.

부정(NOT): 어떤 조건 앞에도 negate:true를 붙이면 그 조건의 반대를 의미한다("!F"처럼 특정 조건이
"발생하지 않았음"을 원하면 그 clause에 negate:true 추가).

중첩 그룹(괄호/OR): clauses 배열의 원소는 leaf 조건 대신 {type:"group", logic:"AND"|"OR",
clauses:[...], negate?:true} 형태의 그룹일 수도 있다. "(RSI 30 이하 또는 볼린저 하단 터치) 그리고
거래대금 50억 이상"처럼 괄호로 묶인 OR 조건이 있으면 group으로 표현할 것. 최상위 condition.logic도
"AND" 또는 "OR" 둘 다 가능하다(기본은 AND).

최근 N봉 이내 발생(within): ma_cross, price_cross_ma, macd_cross, di_cross, stochastic_cross,
gap 타입에 한해 within:{bars:숫자}를 추가할 수 있다. within이 있으면 "오늘 막 발생"이 아니라
"최근 bars봉 이내에 한 번이라도 발생"으로 판정한다("30봉이내 데드크로스 1회이상"→ma_cross(또는
price_cross_ma) clause에 within:{bars:30} 추가). within을 안 쓰면 항상 "가장 최근 봉에서 방금
발생"만 확인한다.

여러 조건을 언급했으면 clauses 배열에 여러 개 넣고 logic은 기본 "AND". 조건 개수에는 정해진 상한이
없으니 사용자가 여러 개를 나열하면 전부 clauses에 담을 것.

키움 HTS 조건검색식을 표(지표코드: 설명) + 수식(예: "A and B and C and !F and !G") 형태로 그대로
붙여넣는 경우: 표의 각 행(A, B, C...)을 위 목록의 clause 하나로 매핑하고, 수식의 and/or/! 그대로
논리 구조(logic, negate, group)로 옮길 것. 예를 들어 "이평이격도[일]0봉전(종가1,종가240):10%이상
130%이하"는 disparity{period:240,op:"gte",value:10}과 disparity{period:240,op:"lte",value:130}
두 clause의 AND로, "상세이평돌파:...단순(종가1)이평이 단순(종가240)이평을 30봉이내 데드크로스
1회이상"은 ma_cross{fast:1은 종가 자체이므로 price_cross_ma{period:240,direction:"down",
within:{bars:30}}로, "신고가:0봉전 고가가 120봉중 신고가"는 high_breakout_n{windowBars:120}으로,
"신고거래량:0봉전 240봉중 신고거래량"은 volume_record_high_n{windowBars:240}으로, "주가범위:종가가
2000이상 50000이하"는 price{op:"gte",value:2000}과 price{op:"lte",value:50000}의 AND로 옮길 것.
수식의 "!F"는 F에 해당하는 clause(또는 group)에 negate:true를 붙이는 것으로 표현할 것.

중요: 사용자가 언급한 조건 중 위 목록의 type으로 표현할 수 없는 게 하나라도 있으면(예: 위 목록에 없는
지표/필터), 그 조건만 조용히 빼고 나머지 조건만으로 검색 결과를 만들면 절대 안 된다. 이 경우
전체를 이해하지 못한 것으로 처리하고(understood=false 또는 matched=false), 어떤 부분을 아직
지원하지 않는지 clarifyMessage에 명확히 설명할 것. 사용자가 요청한 조건 중 일부만 반영된 결과를
"이해했다"고 보여주는 것은 사용자에게 잘못된 정보를 주는 것이므로 절대 금지.`;

/** 특정 시점(i)까지의 시계열에서 direction 방향의 fast/slow 크로스가 가장 최근에 발생한 게
 * 며칠 전(0=바로 이번 봉)인지 찾는다. 못 찾으면 null. */
function findLastCrossDaysAgo(fastArr, slowArr, i, direction) {
  if (!fastArr || !slowArr) return null;
  for (let k = i; k >= 1; k--) {
    const f0 = fastArr[k - 1];
    const s0 = slowArr[k - 1];
    const f1 = fastArr[k];
    const s1 = slowArr[k];
    if (f0 == null || s0 == null || f1 == null || s1 == null) continue;
    const crossed = direction === "down" ? f0 >= s0 && f1 < s1 : f0 <= s0 && f1 > s1;
    if (crossed) return i - k;
  }
  return null;
}

/** 단일 boolean 시계열(eventAt[k]===해당 봉에서 이벤트 발생)에서 i까지 가장 최근 발생이
 * 며칠 전인지. */
function findLastEventDaysAgo(eventAt, i) {
  if (!eventAt) return null;
  for (let k = i; k >= 0; k--) {
    if (eventAt[k]) return i - k;
  }
  return null;
}

/** 풀 시계열 -> 압축 snapshot 변환.
 * series: {closes,highs,lows,volumes,ma,rsiSeries,divergence,candles,macd,bollinger,stochastic,adx}
 * candles/macd/bollinger/stochastic/adx는 2026-07-18 신규 지표군 — 옵션이라 없어도(구버전 캐시)
 * 안전하게 null/false로 빠진다.
 * 2026-08-26: per/pbr/eps/foreignHoldRate/volTurnoverRate/foreignNetBuy/institutionNetBuy도
 * 옵션으로 받아 있으면 스냅샷에 그대로 싣는다(없으면 null — 조건 판정 시 자동으로 false 처리).
 */
function buildSnapshotFromSeries(series) {
  const {
    closes, highs, lows, volumes, ma, rsiSeries, divergence, candles, macd, bollinger, stochastic, adx,
    marketCapEok, tradingValueEok, periodReturns,
    per, pbr, eps, foreignHoldRate, volTurnoverRate, foreignNetBuy, institutionNetBuy,
    tempStopYn, settlementTradeYn, sector,
  } = series;
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

  // 2026-08-26: 52주 고정 윈도우 외에 20/60/120/240봉 커스텀 신고가·신저가·신고거래량.
  snap.highBreakoutByWindow = {};
  snap.lowBreakdownByWindow = {};
  snap.volumeRecordHighByWindow = {};
  for (const w of WINDOW_BAR_OPTIONS) {
    const hs = (highs || []).slice(Math.max(0, i - w), i);
    snap.highBreakoutByWindow[w] = hs.length ? closes[i] > Math.max(...hs) : false;
    const ls = (lows || []).slice(Math.max(0, i - w), i);
    snap.lowBreakdownByWindow[w] = ls.length ? closes[i] < Math.min(...ls) : false;
    const vs = (volumes || []).slice(Math.max(0, i - w), i);
    snap.volumeRecordHighByWindow[w] = vs.length && volumes ? volumes[i] > Math.max(...vs) : false;
  }

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

  // 2026-08-26: 밸류에이션/수급 필드 (KIS inquire-price·inquire-investor에서 옴, 없으면 null 그대로).
  snap.per = per != null ? per : null;
  snap.pbr = pbr != null ? pbr : null;
  snap.eps = eps != null ? eps : null;
  snap.foreignHoldRate = foreignHoldRate != null ? foreignHoldRate : null;
  snap.volTurnoverRate = volTurnoverRate != null ? volTurnoverRate : null;
  snap.foreignNetBuy = foreignNetBuy != null ? foreignNetBuy : null;
  snap.institutionNetBuy = institutionNetBuy != null ? institutionNetBuy : null;

  // 2026-08-26: 거래중지/정리매매 여부 — 즉시검색 결과에서 매매 불가능한 종목을 걸러내는 데 씀
  // (사용자 제보: "거래중지 종목도 나오는데 안 나오게 해줘"). 값이 없으면(구버전 캐시 등)
  // 안전하게 false로 취급해 기존 동작을 유지한다.
  snap.tempStopYn = tempStopYn === true;
  snap.settlementTradeYn = settlementTradeYn === true;
  // 2026-09-03: AI 종목분석의 "동종업계 대비 위치" 계산용 업종명(KIS bstp_kor_isnm).
  // 조건검색 평가에는 쓰이지 않고 캐시에 실려 나가기만 한다.
  snap.sector = typeof sector === "string" && sector ? sector : null;

  // 2026-08-26: within(최근 N봉 이내 1회 이상 발생) 판정용 daysSince 사전계산.
  const daysSince = {};
  for (const [fast, slow] of MA_CROSS_PAIRS) {
    const fastArr = ma && ma[fast];
    const slowArr = ma && ma[slow];
    daysSince[`ma_${fast}_${slow}_up`] = findLastCrossDaysAgo(fastArr, slowArr, i, "up");
    daysSince[`ma_${fast}_${slow}_down`] = findLastCrossDaysAgo(fastArr, slowArr, i, "down");
  }
  for (const p of MA_PERIODS) {
    const arr = ma && ma[p];
    daysSince[`price_${p}_up`] = findLastCrossDaysAgo(closes, arr, i, "up");
    daysSince[`price_${p}_down`] = findLastCrossDaysAgo(closes, arr, i, "down");
  }
  if (macd && macd.macdLine && macd.signalLine) {
    daysSince.macd_up = findLastCrossDaysAgo(macd.macdLine, macd.signalLine, i, "up");
    daysSince.macd_down = findLastCrossDaysAgo(macd.macdLine, macd.signalLine, i, "down");
  }
  if (adx && adx.plusDI && adx.minusDI) {
    daysSince.di_up = findLastCrossDaysAgo(adx.plusDI, adx.minusDI, i, "up");
    daysSince.di_down = findLastCrossDaysAgo(adx.plusDI, adx.minusDI, i, "down");
  }
  if (stochastic && stochastic.k && stochastic.d) {
    daysSince.stoch_up = findLastCrossDaysAgo(stochastic.k, stochastic.d, i, "up");
    daysSince.stoch_down = findLastCrossDaysAgo(stochastic.k, stochastic.d, i, "down");
  }
  if (highs && lows) {
    // 2026-09-03: 갭 판정 기준 불일치 수정. "오늘 갭상승"(snap.gapUp)은 kis.detectGap이
    // **시가 > 전일 고가**로 판정하는데, 여기 daysSince용 시계열은 **저가 > 전일 고가**로
    // 계산하고 있었다 — 같은 "갭상승" 조건이 within 유무에 따라 다른 종목을 내고 있었다는
    // 뜻이다(중앙에너비스: 오늘 갭상승으로는 걸리는데 "최근 30봉 이내"로는 27일 전 것만
    // 잡힘). 캔들(시가 보유)이 있으면 detectGap과 같은 시가 기준으로 통일하고, 없으면
    // 기존 저가 기준으로 폴백한다(구버전 캐시 안전).
    const gapUpAt = [];
    const gapDownAt = [];
    const cs = Array.isArray(candles) ? candles : null;
    for (let k = 1; k < n; k++) {
      const openK = cs && cs[k] ? cs[k].open : null;
      const prevHigh = cs && cs[k - 1] ? cs[k - 1].high : highs[k - 1];
      const prevLow = cs && cs[k - 1] ? cs[k - 1].low : lows[k - 1];
      if (openK != null && prevHigh != null && prevLow != null) {
        gapUpAt[k] = openK > prevHigh;
        gapDownAt[k] = openK < prevLow;
      } else {
        gapUpAt[k] = highs[k - 1] != null && lows[k] != null ? lows[k] > highs[k - 1] : false;
        gapDownAt[k] = lows[k - 1] != null && highs[k] != null ? highs[k] < lows[k - 1] : false;
      }
    }
    daysSince.gap_up = findLastEventDaysAgo(gapUpAt, i);
    daysSince.gap_down = findLastEventDaysAgo(gapDownAt, i);
  }
  snap.daysSince = daysSince;

  return snap;
}

function evaluateClauseOnSnapshot(clause, snap) {
  if (!clause || !snap) return false;

  // 2026-08-26: within(최근 N봉 이내 1회 이상 발생)이 지정된 이벤트류 조건은 daysSince 맵을
  // 먼저 확인한다. within이 없으면(기존 저장 전략 포함) 아래의 기존 로직으로 그대로 진행한다.
  if (clause.within && Number(clause.within.bars) > 0) {
    const bars = Number(clause.within.bars);
    const ds = snap.daysSince || {};
    let key = null;
    if (clause.type === "ma_cross") key = `ma_${clause.fast}_${clause.slow}_${clause.direction === "down" ? "down" : "up"}`;
    else if (clause.type === "price_cross_ma") key = `price_${clause.period}_${clause.direction === "down" ? "down" : "up"}`;
    else if (clause.type === "macd_cross") key = `macd_${clause.direction === "down" ? "down" : "up"}`;
    else if (clause.type === "di_cross") key = `di_${clause.direction === "down" ? "down" : "up"}`;
    else if (clause.type === "stochastic_cross") key = `stoch_${clause.direction === "down" ? "down" : "up"}`;
    else if (clause.type === "gap") key = `gap_${clause.direction === "down" ? "down" : "up"}`;
    if (key) {
      const days = ds[key];
      return days != null && days < bars;
    }
    // within을 지원하지 않는 타입에 실수로 붙었으면 무시하고 기존 로직으로 폴백.
  }

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

  // 2026-08-26 신규 타입 -------------------------------------------------

  function cmp(v, op, target) {
    if (v == null) return false;
    if (op === "lt") return v < target;
    if (op === "lte") return v <= target;
    if (op === "gt") return v > target;
    if (op === "gte") return v >= target;
    return false;
  }

  if (clause.type === "price") return cmp(snap.closeCur, clause.op, clause.value);
  // 2026-09-03: 구버전 캐시(9/3 이전 빌드)는 값이 없는 PER/PBR/EPS를 0으로 저장한다 —
  // 0을 그대로 비교하면 "PBR 0.5 미만" 같은 저평가 검색이 데이터 없는 종목 292개를
  // 전부 잡아버린다(리노공업이 실제로 걸렸다). 수집 단계(lib/kis-indicators.js의
  // toValuation)에서 이미 null로 고쳤지만, 캐시가 다시 만들어지기 전과 과거 캐시로
  // 재현할 때를 위해 판정 쪽에도 같은 가드를 둔다.
  // 2026-09-03: "PER 15배 이하"에 적자기업(PER 음수)이 걸리던 문제. PER/PBR은 배수라
  // 음수가 "더 싸다"는 뜻이 전혀 아닌데, 단순 대소비교로는 -49가 15보다 작아서 통과한다
  // (실제로 "시가총액 5000억 이상 + PER 15배 이하" 검색 상위가 전부 적자기업이었다).
  // 사용자가 저평가 조건(lt/lte)을 걸었을 때만 음수를 제외한다 — "PER 30배 이상"처럼
  // 고평가를 찾는 조건(gt/gte)은 원래 음수가 안 걸리므로 손대지 않는다.
  // EPS는 배수가 아니라 금액이라 음수(주당 손실)도 의미가 분명하므로 그대로 둔다.
  if (clause.type === "per") return cmp(evPositiveMultiple(snap.per, clause.op), clause.op, clause.value);
  if (clause.type === "pbr") return cmp(evPositiveMultiple(snap.pbr, clause.op), clause.op, clause.value);
  if (clause.type === "eps") return cmp(evValuation(snap.eps), clause.op, clause.value);
  if (clause.type === "foreign_hold_rate") return cmp(snap.foreignHoldRate, clause.op, clause.value);
  if (clause.type === "volume_turnover_rate") return cmp(snap.volTurnoverRate, clause.op, clause.value);
  if (clause.type === "foreign_net_buy") return cmp(snap.foreignNetBuy, clause.op, clause.value);
  if (clause.type === "institution_net_buy") return cmp(snap.institutionNetBuy, clause.op, clause.value);

  // 2026-09-03 재무비율 ---------------------------------------------------
  // 값이 없는 종목(사업보고서 미제출·신규상장·분모 0 이하)은 snapshot에 필드 자체가
  // 없으므로 cmp가 null을 받아 자연히 false가 된다 — 0으로 취급해 "부채비율 0%"처럼
  // 잘못 걸리는 일이 없다.
  if (clause.type === "debt_ratio") return cmp(snap.debtRatio, clause.op, clause.value);
  if (clause.type === "operating_margin") return cmp(snap.operatingMargin, clause.op, clause.value);
  if (clause.type === "net_margin") return cmp(snap.netMargin, clause.op, clause.value);
  if (clause.type === "roe") return cmp(snap.roe, clause.op, clause.value);
  if (clause.type === "current_ratio") return cmp(snap.currentRatio, clause.op, clause.value);

  if (clause.type === "high_breakout_n") {
    const w = Number(clause.windowBars);
    return !!(snap.highBreakoutByWindow && snap.highBreakoutByWindow[w]);
  }
  if (clause.type === "low_breakdown_n") {
    const w = Number(clause.windowBars);
    return !!(snap.lowBreakdownByWindow && snap.lowBreakdownByWindow[w]);
  }
  if (clause.type === "volume_record_high_n") {
    const w = Number(clause.windowBars);
    return !!(snap.volumeRecordHighByWindow && snap.volumeRecordHighByWindow[w]);
  }

  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-03: "왜 걸렸는지" 근거 표시 (매매시그널 로드맵 F 선행)
 *
 * 지금까지 검색 결과는 종목명·가격·등락률만 보여줘서, 사용자는 "이 종목이 내 조건 중
 * 어느 부분에 어떤 값으로 걸린 건지"를 전혀 알 수 없었다. 무료 시세 사이트와 구분되는
 * 유료 가치는 "걸렀다"가 아니라 "이 값이라서 걸렀다"를 보여주는 데서 나온다.
 *
 * 원칙 3가지:
 *  1) 실측값이 없으면 지어내지 않고 항목 자체를 생략한다(프로젝트 공통 "없으면 빈 칸" 원칙).
 *  2) OR 그룹은 실제로 통과한 가지만 근거로 남긴다 — 통과하지 않은 가지를 근거처럼
 *     보여주면 그 자체가 거짓말이 된다.
 *  3) negate(NOT) 노드는 "그 값이 아니어서 통과"한 것이라 보여줄 실측값이 없다 → 생략.
 *
 * 새 API 호출은 0이다. 이미 캐시에 들어 있는 snapshot 값을 읽어 문자열로 만들 뿐이다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** PER/PBR/EPS의 "값 없음"(0) 가드. 위 evaluateClauseOnSnapshot 주석 참고. */
function evValuation(v) {
  return v === 0 ? null : v;
}

/** PER/PBR 저평가 조건(lt/lte)에서 음수를 제외한다. 위 evaluateClauseOnSnapshot 주석 참고. */
function evPositiveMultiple(v, op) {
  const x = evValuation(v);
  if (x == null) return null;
  if ((op === "lt" || op === "lte") && x < 0) return null;
  return x;
}

function evNum(v, digits) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  return Number(v).toLocaleString("ko-KR", { maximumFractionDigits: digits == null ? 1 : digits });
}

/** 등락률·순매수처럼 부호가 의미를 갖는 값은 +를 붙여 방향을 즉시 읽히게 한다. */
function evSigned(v, digits, suffix) {
  const t = evNum(v, digits);
  if (t == null) return null;
  return `${Number(v) > 0 ? "+" : ""}${t}${suffix || ""}`;
}

/** daysSince(마지막 발생 며칠 전)를 사람 말로. 0이면 "오늘". */
function evWhen(days) {
  if (days == null || !Number.isFinite(Number(days))) return null;
  const d = Number(days);
  return d <= 0 ? "오늘" : `${d}일 전`;
}

/** 크로스/갭류 이벤트의 daysSince 키. evaluateClauseOnSnapshot의 within 처리와 같은 규칙. */
function evEventKey(clause) {
  const down = clause.direction === "down";
  if (clause.type === "ma_cross") return `ma_${clause.fast}_${clause.slow}_${down ? "down" : "up"}`;
  if (clause.type === "price_cross_ma") return `price_${clause.period}_${down ? "down" : "up"}`;
  if (clause.type === "macd_cross") return `macd_${down ? "down" : "up"}`;
  if (clause.type === "di_cross") return `di_${down ? "down" : "up"}`;
  if (clause.type === "stochastic_cross") return `stoch_${down ? "down" : "up"}`;
  if (clause.type === "gap") return `gap_${down ? "down" : "up"}`;
  return null;
}

/** 크로스/갭류 조건이 "언제 발생해서 통과했는지".
 * within이 없는 조건은 판정 자체가 "직전 봉 → 오늘 봉 전환"이므로 언제나 오늘이다.
 * daysSince(마지막 발생일)를 그대로 쓰면 오늘 갭상승으로 통과한 종목에 "27일 전"이라고
 * 적히는 모순이 생긴다(2026-09-03 오프라인 검증에서 실제로 발견). daysSince는 within이
 * 지정된 조건 — 즉 판정이 실제로 daysSince를 본 경우 — 에만 쓴다. */
function evEventWhen(clause, snap) {
  if (!clause.within || !(Number(clause.within.bars) > 0)) return "오늘";
  const key = evEventKey(clause);
  if (!key) return "오늘";
  const ds = snap.daysSince || {};
  return evWhen(ds[key]) || "오늘";
}

const EV_PERIOD_LABEL = { 5: "1주", 21: "1개월", 63: "3개월", 126: "6개월", 252: "1년" };

/** leaf 조건 하나가 "실제로 어떤 값으로 통과했는지"를 {label, value}로 만든다.
 * value가 null이면 화면은 라벨만 칩으로 그린다(신호 발생형 조건 — 보여줄 숫자가 없는 게 정상).
 * 숫자를 보여줘야 하는 조건인데 실측값이 없으면 null을 돌려 항목 자체를 생략한다. */
function clauseEvidence(clause, snap) {
  if (!clause || !snap) return null;
  const t = String(clause.type || "");
  const down = clause.direction === "down";

  if (t === "ma_cross") {
    return { label: `${clause.fast}/${clause.slow}일선 ${down ? "데드" : "골든"}크로스`, value: evEventWhen(clause, snap) };
  }
  if (t === "price_cross_ma") {
    return { label: `현재가 ${clause.period}일선 ${down ? "하향" : "상향"}돌파`, value: evEventWhen(clause, snap) };
  }
  if (t === "rsi") {
    const v = evNum(snap.rsiCur, 1);
    return v == null ? null : { label: "RSI", value: v };
  }
  if (t === "volume_ratio") {
    const v = evNum(snap.volumeRatio, 0);
    return v == null ? null : { label: "거래량(20일평균비)", value: `${v}%` };
  }
  if (t === "high52w_breakout") return { label: "52주 신고가 갱신", value: null };
  if (t === "low52w_breakdown") return { label: "52주 신저가 갱신", value: null };
  if (t === "price_change_pct") {
    if (snap.closePrev == null || snap.closeCur == null || !snap.closePrev) return null;
    const pct = ((snap.closeCur - snap.closePrev) / snap.closePrev) * 100;
    return { label: "당일 등락률", value: evSigned(pct, 2, "%") };
  }
  if (t === "rsi_divergence") {
    const v = evNum(snap.rsiCur, 1);
    return { label: `RSI ${clause.direction === "bearish" ? "약세" : "강세"} 다이버전스`, value: v == null ? null : `RSI ${v}` };
  }
  if (t === "macd_cross") {
    return { label: `MACD ${down ? "데드" : "골든"}크로스`, value: evEventWhen(clause, snap) };
  }
  if (t === "macd_histogram_turn") {
    // 히스토그램 절대값(예: 43.308)은 사용자에게 아무 의미가 없어 숫자를 붙이지 않는다.
    return { label: `MACD 히스토그램 ${down ? "매도" : "매수"} 전환`, value: null };
  }
  if (t === "bollinger") {
    const map = {
      upper_break: "볼린저 상단 돌파",
      lower_break: "볼린저 하단 이탈",
      upper_touch: "볼린저 상단 터치",
      lower_touch: "볼린저 하단 터치",
    };
    const label = map[clause.position];
    if (!label) return null;
    const v = evNum(snap.closeCur, 0);
    return { label, value: v == null ? null : `${v}원` };
  }
  if (t === "stochastic") {
    const line = clause.line === "d" ? snap.stochDCur : snap.stochKCur;
    const v = evNum(line, 1);
    return v == null ? null : { label: `스토캐스틱 %${(clause.line || "k").toUpperCase()}`, value: v };
  }
  if (t === "stochastic_cross") {
    return { label: `스토캐스틱 %K가 %D ${down ? "하향" : "상향"} 교차`, value: evEventWhen(clause, snap) };
  }
  if (t === "ma_alignment") {
    return { label: clause.direction === "bearish" ? "이동평균 역배열" : "이동평균 정배열", value: null };
  }
  if (t === "disparity") {
    const ma = snap[`ma${clause.period}Cur`];
    if (snap.closeCur == null || !ma) return null;
    return { label: `${clause.period}일 이격도`, value: `${evNum((snap.closeCur / ma) * 100, 1)}%` };
  }
  if (t === "adx") {
    const v = evNum(snap.adxCur, 1);
    return v == null ? null : { label: "ADX", value: v };
  }
  if (t === "di_cross") {
    return { label: `+DI가 -DI ${down ? "하향" : "상향"} 교차`, value: evEventWhen(clause, snap) };
  }
  if (t === "candle_pattern") {
    const map = {
      bullish_engulfing: "상승장악형",
      bearish_engulfing: "하락장악형",
      hammer: "망치형",
      shooting_star: "유성형",
      doji: "도지",
    };
    const label = map[clause.pattern];
    return label ? { label: `${label} 캔들`, value: null } : null;
  }
  if (t === "gap") {
    return { label: down ? "갭하락" : "갭상승", value: evEventWhen(clause, snap) };
  }
  if (t === "consecutive_candles") {
    const n = snap.streakCount;
    if (n == null) return null;
    return { label: `연속 ${snap.streakDirection === "down" ? "음봉" : "양봉"}`, value: `${n}일` };
  }
  if (t === "high52w_near") {
    if (snap.closeCur == null || !snap.high52wHigh) return null;
    const diff = ((snap.high52wHigh - snap.closeCur) / snap.high52wHigh) * 100;
    return { label: "52주 신고가 대비", value: `${evNum(diff, 1)}% 아래` };
  }
  if (t === "market_cap") {
    const v = evNum(snap.marketCapEok, 0);
    return v == null ? null : { label: "시가총액", value: `${v}억` };
  }
  if (t === "trading_value") {
    const v = evNum(snap.tradingValueEok, 0);
    return v == null ? null : { label: "거래대금", value: `${v}억` };
  }
  if (t === "period_return") {
    const days = Number(clause.days);
    const pct = snap.periodReturns && snap.periodReturns[days] != null ? snap.periodReturns[days] : null;
    if (pct == null) return null;
    return { label: `${EV_PERIOD_LABEL[days] || `${days}거래일`} 수익률`, value: evSigned(pct, 1, "%") };
  }
  if (t === "price") {
    const v = evNum(snap.closeCur, 0);
    return v == null ? null : { label: "현재가", value: `${v}원` };
  }
  if (t === "per") {
    const v = evNum(evValuation(snap.per), 2);
    return v == null ? null : { label: "PER", value: v };
  }
  if (t === "pbr") {
    const v = evNum(evValuation(snap.pbr), 2);
    return v == null ? null : { label: "PBR", value: v };
  }
  if (t === "eps") {
    const v = evNum(evValuation(snap.eps), 0);
    return v == null ? null : { label: "EPS", value: `${v}원` };
  }
  if (t === "foreign_hold_rate") {
    const v = evNum(snap.foreignHoldRate, 2);
    return v == null ? null : { label: "외국인 보유율", value: `${v}%` };
  }
  if (t === "volume_turnover_rate") {
    const v = evNum(snap.volTurnoverRate, 2);
    return v == null ? null : { label: "거래량 회전율", value: `${v}%` };
  }
  if (t === "foreign_net_buy") {
    const v = evSigned(snap.foreignNetBuy, 0, "주");
    return v == null ? null : { label: "외국인 순매수", value: v };
  }
  if (t === "institution_net_buy") {
    const v = evSigned(snap.institutionNetBuy, 0, "주");
    return v == null ? null : { label: "기관 순매수", value: v };
  }
  if (t === "debt_ratio") {
    const v = evNum(snap.debtRatio, 1);
    return v == null ? null : { label: "부채비율", value: `${v}%` };
  }
  if (t === "operating_margin") {
    const v = evNum(snap.operatingMargin, 2);
    return v == null ? null : { label: "영업이익률", value: `${v}%` };
  }
  if (t === "net_margin") {
    const v = evNum(snap.netMargin, 2);
    return v == null ? null : { label: "순이익률", value: `${v}%` };
  }
  if (t === "roe") {
    const v = evNum(snap.roe, 2);
    return v == null ? null : { label: "ROE", value: `${v}%` };
  }
  if (t === "current_ratio") {
    const v = evNum(snap.currentRatio, 1);
    return v == null ? null : { label: "유동비율", value: `${v}%` };
  }
  if (t === "high_breakout_n") {
    const v = evNum(snap.closeCur, 0);
    return { label: `${clause.windowBars}봉중 신고가`, value: v == null ? null : `${v}원` };
  }
  if (t === "low_breakdown_n") {
    const v = evNum(snap.closeCur, 0);
    return { label: `${clause.windowBars}봉중 신저가`, value: v == null ? null : `${v}원` };
  }
  if (t === "volume_record_high_n") {
    return { label: `${clause.windowBars}봉중 신고거래량`, value: null };
  }
  return null;
}

function collectEvidence(node, snap, out, limit) {
  if (!node || typeof node !== "object" || out.length >= limit) return;
  if (node.negate) return; // NOT 조건은 "그 값이 아니어서" 통과한 것이라 보여줄 실측값이 없다
  if (node.type === "group") {
    const children = Array.isArray(node.clauses) ? node.clauses : [];
    for (const child of children) {
      if (out.length >= limit) break;
      // OR 그룹은 실제로 통과한 가지만 근거로 남긴다(AND는 전부 통과했으므로 그대로 내려간다)
      if (node.logic === "OR" && !evaluateNode(child, snap)) continue;
      collectEvidence(child, snap, out, limit);
    }
    return;
  }
  const ev = clauseEvidence(node, snap);
  if (!ev || !ev.label) return;
  if (out.some((x) => x.label === ev.label)) return; // 같은 라벨 중복 방지
  out.push(ev);
}

/** condition을 통과한 종목의 snapshot에서 "왜 걸렸는지" 근거 목록을 만든다.
 * @returns {{label:string, value:(string|null)}[]} 최대 limit개(기본 4). 없으면 빈 배열. */
function describeMatch(condition, snap, options) {
  const limit = Number(options && options.limit) > 0 ? Number(options.limit) : 4;
  const out = [];
  if (!condition || !Array.isArray(condition.clauses) || !condition.clauses.length) return out;
  if (!snap) return out;
  try {
    collectEvidence(
      { type: "group", logic: condition.logic === "OR" ? "OR" : "AND", clauses: condition.clauses },
      snap,
      out,
      limit
    );
  } catch {
    return [];
  }
  return out;
}

/** 2026-08-26: leaf 조건 또는 중첩 group을 재귀 평가. negate 지원.
 * node.type === "group"이면 node.clauses를 node.logic(AND|OR)으로 묶어 재귀 평가하고,
 * 그 외에는 leaf 조건으로 evaluateClauseOnSnapshot에 위임한다. 어느 쪽이든 node.negate가
 * true면 결과를 뒤집는다. */
function evaluateNode(node, snap) {
  if (!node || typeof node !== "object") return false;
  let base;
  if (node.type === "group") {
    const children = Array.isArray(node.clauses) ? node.clauses : [];
    const results = children.map((c) => evaluateNode(c, snap));
    base = node.logic === "OR" ? results.some(Boolean) : results.every(Boolean);
  } else {
    base = evaluateClauseOnSnapshot(node, snap);
  }
  return node.negate ? !base : base;
}

function evaluateCondition(condition, snap) {
  if (!condition || !Array.isArray(condition.clauses) || !condition.clauses.length) return false;
  return evaluateNode({ type: "group", logic: condition.logic === "OR" ? "OR" : "AND", clauses: condition.clauses }, snap);
}

/** 2026-08-26: leaf/group 노드 하나를 재귀 검증. group은 logic이 AND|OR이고 자식이 1개 이상
 * 있으며 모든 자식이 재귀적으로 유효해야 한다. leaf는 type이 ALLOWED_CLAUSE_TYPES 안에 있어야
 * 한다. within은 있어도 되고 없어도 된다(형식만 객체면 통과 — 세부 값 검증은 평가 시 자연히
 * 처리됨: bars가 숫자가 아니면 그냥 무시되고 기존 로직으로 폴백). */
function isValidNode(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "group") {
    if (node.logic !== "AND" && node.logic !== "OR") return false;
    if (!Array.isArray(node.clauses) || !node.clauses.length) return false;
    return node.clauses.every(isValidNode);
  }
  return ALLOWED_CLAUSE_TYPES.includes(String(node.type || ""));
}

function isValidCondition(condition) {
  if (!condition || typeof condition !== "object") return false;
  if (condition.logic !== "AND" && condition.logic !== "OR") return false;
  if (!Array.isArray(condition.clauses) || !condition.clauses.length) return false;
  return condition.clauses.every(isValidNode);
}

module.exports = {
  ALLOWED_CLAUSE_TYPES,
  MA_PERIODS,
  WINDOW_BAR_OPTIONS,
  CONDITION_GUIDE,
  buildSnapshotFromSeries,
  evaluateClauseOnSnapshot,
  evaluateNode,
  evaluateCondition,
  isValidCondition,
  describeMatch,
};
