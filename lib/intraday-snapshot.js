/**
 * 장중(장 막판) 종가 스캔용 스냅샷 갱신 — 2026-09-08 신설.
 *
 * 왜 필요한가: 즉시검색이 읽는 data/kr-screener-cache.json은 전종목 일봉을 새로 받아
 * 만드는 데 80분이 걸려 하루 1회(그것도 밤늦게)밖에 못 돈다. 그래서 15:30 장마감 직후
 * NXT 시간외 매수를 노리는 "종가매매"에는 쓸 수 없었다 — 장중에 검색하면 전날 데이터가
 * 나온다.
 *
 * 이 모듈은 그 캐시의 전일 스냅샷에 **오늘 봉 하나(종가·고가·거래량)만 얹어서** 지표를
 * 다시 계산한다. 필요한 접힌 값(snap.next)은 밤 캐시 빌드가 이미 계산해 두므로
 * 종목당 KIS 호출은 시세 1회 + 수급 1회, 총 2회면 된다(400종목 ≈ 4~5분).
 *
 * ⚠️ 전부 갱신되는 건 아니다. 오늘 봉 하나로 정확히 다시 구할 수 있는 지표만 갱신하고,
 * 나머지(RSI·MACD·볼린저·스토캐스틱·ADX·캔들패턴·다이버전스 등 시계열 전체가 필요한 것)는
 * 전일 값을 그대로 둔다. 어떤 게 갱신됐는지는 결과의 intraday.updated / intraday.stale에
 * 담아 두고, 화면에서 "장중 기준으로 판정되는 조건"을 그 목록으로 판단한다.
 * 사실과 다른 값을 최신인 척 보여주지 않기 위한 장치다.
 */

const MA_PERIODS = [5, 10, 20, 60, 120, 200, 240];
const PERIOD_DAYS = [5, 21, 63, 126, 252];
const WINDOW_BARS = [20, 60, 120, 240];

/** 오늘 봉으로 다시 계산되는 지표 — 화면·문구에서 "장중 반영됨"으로 취급할 것 */
const INTRADAY_UPDATED = [
  "price",
  "price_change_pct",
  "trading_value",
  "market_cap",
  "volume_ratio",
  "volume_record_high_n",
  "ma_cross",
  "price_cross_ma",
  "ma_alignment",
  "disparity",
  "high52w_breakout",
  "high52w_near",
  "high_breakout_n",
  "period_return",
  "foreign_net_buy",
  "institution_net_buy",
  "foreign_net_buy_amount",
  "institution_net_buy_amount",
  "foreign_net_buy_streak",
  "institution_net_buy_streak",
  "major_net_buy_streak",
  "per",
  "pbr",
  "eps",
  "foreign_hold_rate",
  "volume_turnover_rate",
];

/** 전일 종가 기준 값이 그대로 남는 지표 — 장중 스냅샷에서 신뢰하면 안 되는 것들 */
const INTRADAY_STALE = [
  "rsi",
  "rsi_divergence",
  "macd_cross",
  "macd_histogram_turn",
  "bollinger",
  "stochastic",
  "stochastic_cross",
  "adx",
  "di_cross",
  "candle_pattern",
  "gap",
  "consecutive_candles",
  "low52w_breakdown",
  "low_breakdown_n",
  "debt_ratio",
  "operating_margin",
  "net_margin",
  "roe",
  "current_ratio",
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} prev  전일 스냅샷(캐시의 row.snapshot). snap.next가 없으면 갱신 불가라 null 반환.
 * @param {object} today { close, high, low, volume, tradingValueEok, marketCapEok, per, pbr, eps,
 *                         foreignHoldRate, volTurnoverRate, tempStopYn, settlementTradeYn, sector }
 * @param {object} flow  lib/kis-indicators.js fetchInvestorFlow 결과
 * @returns {object|null} 장중 스냅샷
 */
function buildIntradaySnapshot(prev, today, flow) {
  if (!prev || typeof prev !== "object") return null;
  const next = prev.next;
  const close = num(today && today.close);
  // next(접힌 값)가 없는 구버전 캐시이거나 종가가 없으면 지어내지 않고 포기한다.
  if (!next || close == null) return null;

  const high = num(today.high) != null ? num(today.high) : close;
  const volume = num(today.volume);
  const snap = Object.assign({}, prev);

  snap.closeCur = close;
  snap.closePrev = prev.closeCur != null ? prev.closeCur : null;

  for (const p of MA_PERIODS) {
    const prevMa = num(prev[`ma${p}Cur`]);
    const drop = num(next.maTailDrop ? next.maTailDrop[p] : null);
    snap[`ma${p}Prev`] = prevMa;
    snap[`ma${p}Cur`] = prevMa != null && drop != null ? (prevMa * p - drop + close) / p : null;
  }

  const avgVol20 = num(next.avgVol20);
  snap.volumeRatio = avgVol20 && volume != null ? (volume / avgVol20) * 100 : null;

  const high252 = num(next.high252);
  snap.high52wBreakout = high252 != null ? close > high252 : false;
  snap.high52wHigh = high252 != null ? Math.max(high252, high) : high;

  snap.highBreakoutByWindow = {};
  snap.volumeRecordHighByWindow = {};
  for (const w of WINDOW_BARS) {
    const hw = num(next.highWindow ? next.highWindow[w] : null);
    snap.highBreakoutByWindow[w] = hw != null ? close > hw : false;
    const vw = num(next.volWindow ? next.volWindow[w] : null);
    snap.volumeRecordHighByWindow[w] = vw != null && volume != null ? volume > vw : false;
  }

  // 기간수익률: 전일 값이 null이면(감자·병합으로 시계열이 끊긴 종목) 오늘도 null로 둔다 —
  // 캐시 빌더의 ANOMALY 가드를 장중에도 그대로 승계하기 위한 것.
  const prevReturns = prev.periodReturns || {};
  snap.periodReturns = {};
  for (const d of PERIOD_DAYS) {
    const base = num(next.periodBase ? next.periodBase[d] : null);
    snap.periodReturns[d] =
      prevReturns[d] == null || base == null || base === 0
        ? null
        : Math.round(((close - base) / base) * 10000) / 100;
  }

  const carry = (key, val) => {
    if (val !== undefined) snap[key] = val;
  };
  carry("marketCapEok", num(today.marketCapEok));
  carry("tradingValueEok", num(today.tradingValueEok));
  carry("per", today.per !== undefined ? today.per : prev.per);
  carry("pbr", today.pbr !== undefined ? today.pbr : prev.pbr);
  carry("eps", today.eps !== undefined ? today.eps : prev.eps);
  carry("foreignHoldRate", num(today.foreignHoldRate));
  carry("volTurnoverRate", num(today.volTurnoverRate));
  snap.tempStopYn = today.tempStopYn === true;
  snap.settlementTradeYn = today.settlementTradeYn === true;
  if (today.sector) snap.sector = today.sector;

  const f = flow || {};
  snap.foreignNetBuy = f.foreignNetBuy != null ? f.foreignNetBuy : null;
  snap.institutionNetBuy = f.institutionNetBuy != null ? f.institutionNetBuy : null;
  snap.foreignNetBuyEok = f.foreignNetBuyEok != null ? f.foreignNetBuyEok : null;
  snap.institutionNetBuyEok = f.institutionNetBuyEok != null ? f.institutionNetBuyEok : null;
  snap.foreignNetBuyStreak = f.foreignNetBuyStreak != null ? f.foreignNetBuyStreak : null;
  snap.institutionNetBuyStreak = f.institutionNetBuyStreak != null ? f.institutionNetBuyStreak : null;
  snap.majorNetBuyStreak = f.majorNetBuyStreak != null ? f.majorNetBuyStreak : null;

  // 장중 스냅샷에는 next를 다시 담지 않는다(오늘 봉 기준으로 접으려면 시계열이 필요하고,
  // 어차피 이 스냅샷 위에 또 봉을 얹을 일이 없다). 남겨두면 다음 날 잘못 쓰일 소지가 있다.
  delete snap.next;

  snap.intraday = { updated: INTRADAY_UPDATED, stale: INTRADAY_STALE };
  return snap;
}

module.exports = {
  buildIntradaySnapshot,
  INTRADAY_UPDATED,
  INTRADAY_STALE,
};
