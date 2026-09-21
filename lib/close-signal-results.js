/**
 * 종가시그널 성과 기록의 공통 계산 (2026-09-21 신설).
 *
 * 실시간 기록(scripts/close-betting-review.mjs)과 과거 백필(scripts/close-signal-backfill.mjs)이
 * 같은 수식을 써야 달력 위의 숫자가 구간마다 달라지지 않는다. 그래서 수익률·요약 계산을
 * 여기 한 곳에만 둔다.
 *
 * 매수가 = 선정일 종가(그날 15:20 랭킹에 찍힌 close).
 * 익일 시가/고가/저가/종가는 호출하는 쪽이 넣어준다 — 값이 없으면 null로 두고 지어내지 않는다.
 */

const pct = (a, b) => (b ? Math.round(((a - b) / b) * 10000) / 100 : null);
const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * @param {object} pick 1520 랭킹 행
 * @param {object|null} bar 익일 시세 { open, high, low, close } — 없으면 전부 null로 남는다
 * @param {boolean} withDayBar false면 시가만 확정(09:10 phase=open)
 */
function buildPickResult(pick, bar, withDayBar) {
  const buy = num(pick.close);
  const open = bar ? num(bar.open) : null;
  const high = withDayBar && bar ? num(bar.high) : null;
  const low = withDayBar && bar ? num(bar.low) : null;
  const close = withDayBar && bar ? num(bar.close) : null;
  return {
    rank: pick.rank,
    code: pick.code,
    name: pick.name,
    market: pick.market || null,
    score: pick.score,
    consensus: pick.consensus != null ? pick.consensus : null,
    strategies: Array.isArray(pick.strategies) ? pick.strategies.map((s) => (typeof s === "string" ? s : s.label)) : [],
    buyPrice: buy,
    open,
    high,
    low,
    close,
    openReturnPct: open != null ? pct(open, buy) : null,
    highReturnPct: high != null ? pct(high, buy) : null,
    lowReturnPct: low != null ? pct(low, buy) : null,
    closeReturnPct: close != null ? pct(close, buy) : null,
  };
}

function buildSummary(picks) {
  const withOpen = picks.filter((p) => p.openReturnPct != null);
  const withClose = picks.filter((p) => p.closeReturnPct != null);
  const winRate = (arr, key) =>
    arr.length ? Math.round((arr.filter((p) => p[key] > 0).length / arr.length) * 1000) / 10 : null;
  const metric = withClose.length ? "closeReturnPct" : "openReturnPct";
  const sorted = (withClose.length ? withClose : withOpen).slice().sort((a, b) => b[metric] - a[metric]);
  return {
    picks: picks.length,
    measured: withOpen.length,
    avgOpenReturnPct: avg(withOpen.map((p) => p.openReturnPct)),
    openWinRatePct: winRate(withOpen, "openReturnPct"),
    openWins: withOpen.filter((p) => p.openReturnPct > 0).length,
    avgCloseReturnPct: avg(withClose.map((p) => p.closeReturnPct)),
    closeWinRatePct: winRate(withClose, "closeReturnPct"),
    closeWins: withClose.filter((p) => p.closeReturnPct > 0).length,
    avgHighReturnPct: avg(picks.filter((p) => p.highReturnPct != null).map((p) => p.highReturnPct)),
    avgLowReturnPct: avg(picks.filter((p) => p.lowReturnPct != null).map((p) => p.lowReturnPct)),
    best: sorted.length ? { name: sorted[0].name, code: sorted[0].code, returnPct: sorted[0][metric] } : null,
    worst: sorted.length
      ? { name: sorted[sorted.length - 1].name, code: sorted[sorted.length - 1].code, returnPct: sorted[sorted.length - 1][metric] }
      : null,
  };
}

module.exports = { buildPickResult, buildSummary };
