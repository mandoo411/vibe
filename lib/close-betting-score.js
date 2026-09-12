/**
 * 종가베팅 점수 — 2026-09-11 신설.
 *
 * 전제: **정규장 종가(15:20~15:30) 매수 → 익일 시가(09:00~09:10) 매도.**
 * 보유 기간이 하룻밤이라, 며칠~몇 주 단위 지표(RSI·MACD·볼린저·PER 등)는 예측력이
 * 사실상 없어서 일부러 넣지 않았다. lib/intraday-snapshot.js의 INTRADAY_STALE 목록에
 * 든 지표는 장중 스냅샷에서 전일 값이 그대로 남기 때문에 쓰면 안 되기도 한다.
 * → **여기서 쓰는 값은 전부 INTRADAY_UPDATED 안에 있는 것들이다.**
 *
 * 설계 근거(2종을 합침):
 *  · 오버나이트 수익률 편향 — 개인 관심이 쏠린 종목일수록 종가~익일 시가 구간 수익률이
 *    높다(Lou·Polk·Skouras "A Tug of War"). → 거래대금 회전율·거래량비율이 "관심도" 프록시.
 *  · 장 막판 모멘텀 — 마지막 구간 수익률이 다음 구간을 예측한다(Gao 외, JFE 2018).
 *    → 14:30 대비 종가 상승분(lateStrengthPct).
 *  · 과열 역전 — 급등폭이 임계치를 넘으면 익일 시가 갭 후 즉시 되돌린다.
 *    → 등락률 상단 컷(+25%)과 +20% 초과 감점. 상한가는 하드필터에서 아예 빠진다.
 *
 * ⚠️ 배점은 위 근거로 세운 **출발점이지 검증된 값이 아니다.** 매일 상위 종목의 익일 시가
 * 수익률을 라벨로 쌓아 팩터별 적중률을 재고 배점을 고치는 루프가 전제다.
 *
 * 점수는 "받을 수 있었던 만점" 대비 비율로 100점 환산한다. 데이터가 없는 팩터(예: 시가를
 * 아직 안 받아오는 구버전 스냅샷, 14:30 슬롯이 없는 첫 스캔)는 **분모에서도 빠진다** —
 * 없는 값을 0점으로 깔면 그 종목만 부당하게 밀리기 때문이다.
 */

/* ── 하드필터 기준값 ────────────────────────────────────────────────────── */
const MIN_TRADING_VALUE_EOK = 100;      // 거래대금 100억 미만은 익일 시가에 못 판다
const MIN_MARKET_CAP_EOK = 1000;        // 시총 1,000억 미만은 조작·품절주 리스크
const MAX_MARKET_CAP_EOK = 200000;      // 20조 초과 대형주는 오버나이트 수익률이 안 나온다
const MIN_CHANGE_PCT = 2;               // 당일 +2% 미만은 "오늘 강했던 종목"이 아니다
const MAX_CHANGE_PCT = 25;              // 상한가·과열 제외
const MIN_CLOSE_POSITION = 0.6;         // 윗꼬리가 길면 위에서 물량이 나온 것

/** 우선주(삼성전자우, 현대차2우B …) — 종가베팅 대상이 아니다 */
const PREFERRED_RE = /\d?우[BC]?$/;
const SPAC_RE = /스팩/;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

/* ── 하드필터 ───────────────────────────────────────────────────────────── */

/**
 * @returns {{passed: boolean, rejectedBy: string|null, reason: string|null}}
 */
function applyHardFilters(row) {
  const snap = row.snapshot || {};
  const name = String(row.name || "");
  const tv = num(row.tradingValueEok != null ? row.tradingValueEok : snap.tradingValueEok);
  const mc = num(row.marketCapEok != null ? row.marketCapEok : snap.marketCapEok);
  const changePct = num(row.changePct);
  const close = num(snap.closeCur != null ? snap.closeCur : row.close);

  if (snap.tempStopYn) return rej("F6", "거래정지·임시정지");
  if (snap.settlementTradeYn) return rej("F6", "정리매매");
  if (SPAC_RE.test(name)) return rej("F7", "스팩");
  if (PREFERRED_RE.test(name)) return rej("F7", "우선주");
  if (tv == null || tv < MIN_TRADING_VALUE_EOK) return rej("F1", `거래대금 ${MIN_TRADING_VALUE_EOK}억 미만`);
  if (mc == null || mc < MIN_MARKET_CAP_EOK) return rej("F2", `시총 ${MIN_MARKET_CAP_EOK}억 미만`);
  if (mc > MAX_MARKET_CAP_EOK) return rej("F2", "시총 20조 초과");
  if (changePct == null || changePct < MIN_CHANGE_PCT) return rej("F3", `당일 +${MIN_CHANGE_PCT}% 미만`);
  if (changePct > MAX_CHANGE_PCT) return rej("F3", `당일 +${MAX_CHANGE_PCT}% 초과(과열)`);

  const cp = closePosition(snap);
  if (cp != null && cp < MIN_CLOSE_POSITION) return rej("F4", "종가가 고점 대비 낮음(윗꼬리)");

  const ma20 = num(snap.ma20Cur);
  if (close == null || ma20 == null || close <= ma20) return rej("F5", "20일선 아래");

  return { passed: true, rejectedBy: null, reason: null };
}

function rej(code, reason) {
  return { passed: false, rejectedBy: code, reason };
}

/** 종가위치 = (종가-저가)/(고가-저가). 고가=저가(상한가 점상 등)면 1로 본다. */
function closePosition(snap) {
  const high = num(snap.highCur);
  const low = num(snap.lowCur);
  const close = num(snap.closeCur);
  if (high == null || low == null || close == null) return null;
  if (high <= low) return 1;
  return clamp((close - low) / (high - low), 0, 1);
}

/* ── 개별 팩터 ──────────────────────────────────────────────────────────── */
/* 각 함수는 {score, max, value, note} 또는 데이터가 없으면 null을 돌려준다.
 * null이면 분모(max)에서도 빠진다. */

/** A1. 거래대금 회전율 = 거래대금/시총. 절대 거래대금보다 예측력이 높다 —
 * 절대값만 쓰면 대형주가 매일 상위권인데 대형주는 오버나이트 수익률이 구조적으로 낮다. */
function factorTurnover(row, snap) {
  const tv = num(row.tradingValueEok != null ? row.tradingValueEok : snap.tradingValueEok);
  const mc = num(row.marketCapEok != null ? row.marketCapEok : snap.marketCapEok);
  if (tv == null || mc == null || mc <= 0) return null;
  const pct = (tv / mc) * 100;
  /* 만점 기준 30%: 2026-09-11 실측(통과 78종목) 분포가 p50 2.1% · p75 10.6% · p90 34.8%라
   * 처음 잡았던 15%로는 상위 23%가 전부 만점이라 변별력이 없었다. */
  return {
    score: clamp((pct / 30) * 12, 0, 12),
    max: 12,
    value: `${round1(pct)}%`,
    note: "시총 대비 거래대금(30% = 만점)",
  };
}

/** A2. 거래대금 절대값 — 로그 스케일(100억=0점, 1,000억=8점). */
function factorTradingValue(row, snap) {
  const tv = num(row.tradingValueEok != null ? row.tradingValueEok : snap.tradingValueEok);
  if (tv == null || tv <= 0) return null;
  return {
    score: clamp(Math.log10(tv / MIN_TRADING_VALUE_EOK) * 8, 0, 8),
    max: 8,
    value: `${Math.round(tv).toLocaleString("ko-KR")}억`,
    note: "1,000억 = 만점",
  };
}

/** A3. 거래량비율(20일 평균 대비). 평소의 3배면 만점. */
function factorVolumeRatio(_row, snap) {
  const vr = num(snap.volumeRatio);
  if (vr == null) return null;
  /* 만점 기준 500%: 실측 분포가 p75 400% · p90 1465%로, 통설의 "2~3배"는 종가베팅
   * 후보군 안에서는 하위권이다. 통과 종목의 1/3이 만점을 받던 300% 기준을 올렸다. */
  return {
    score: clamp(((vr - 100) / 400) * 8, 0, 8),
    max: 8,
    value: `${Math.round(vr)}%`,
    note: "20일 평균 대비(500% = 만점)",
  };
}

/** A4. 외국인·기관 수급. 양매수가 가장 강하다. */
function factorInvestorFlow(_row, snap) {
  const f = snap.foreignNetBuy;
  const i = snap.institutionNetBuy;
  if (f == null && i == null) return null;
  const both = !!f && !!i;
  const one = !!f || !!i;
  return {
    score: both ? 7 : one ? 4 : 0,
    max: 7,
    value: both ? "외국인·기관 양매수" : f ? "외국인 순매수" : i ? "기관 순매수" : "없음",
    note: "양매수 = 만점",
  };
}

/** B1. 종가위치 — 고점 부근에서 끝났는가. 0.95 이상이면 만점. */
function factorClosePosition(_row, snap) {
  const cp = closePosition(snap);
  if (cp == null) return null;
  return {
    score: clamp(((cp - MIN_CLOSE_POSITION) / (0.95 - MIN_CLOSE_POSITION)) * 10, 0, 10),
    max: 10,
    value: `${Math.round(cp * 100)}%`,
    note: "당일 고저 범위 내 종가 위치(95% = 만점)",
  };
}

/** B2. 당일 등락률 구간 — **클수록 좋은 게 아니다.** +5~12%가 스위트스팟이고,
 * 그 위는 익일 갭 후 되돌림이 잦아 점수가 오히려 내려간다. */
function factorChangeBand(row) {
  const c = num(row.changePct);
  if (c == null) return null;
  /* 2026-09-11 재조정: 8 → 10점. 수급 축(28점)에 비해 등락률이 약해서, 당일 +0.7%짜리
   * 종목이 회전율만으로 상위권에 올라오는 일이 있었다. 종가베팅의 전제는
   * "오늘 강했던 종목이 내일 아침에도 강하다"이므로 강세 자체에 무게를 더 준다. */
  let score;
  if (c >= 5 && c < 12) score = 10;
  else if ((c >= 3 && c < 5) || (c >= 12 && c < 18)) score = 6;
  else if (c >= 2 && c < 3) score = 2;
  else score = 2; // 18~25%: 갭 후 되돌림이 잦아 낮게 준다
  return { score, max: 10, value: `+${round1(c)}%`, note: "+5~12%가 최적 구간" };
}

/** B3. 양봉 + 윗꼬리 — 시가보다 높게 끝났고 위쪽에 매물 흔적이 없어야 한다. */
function factorCandleShape(_row, snap) {
  const open = num(snap.openCur);
  const high = num(snap.highCur);
  const close = num(snap.closeCur);
  if (open == null || high == null || close == null) return null;
  if (close <= open) return { score: 0, max: 4, value: "음봉", note: "종가 < 시가" };
  const body = close - open;
  const upperTail = Math.max(0, high - close);
  const ratio = body > 0 ? upperTail / body : 1;
  const score = ratio <= 0.2 ? 4 : ratio <= 0.5 ? 3 : ratio <= 1 ? 2 : 1;
  return { score, max: 4, value: `양봉·윗꼬리 ${Math.round(ratio * 100)}%`, note: "윗꼬리 ≤ 몸통 20% = 만점" };
}

/** B4. 막판 강도 — 14:30 대비 종가 상승분. 14:30 슬롯 스냅샷이 없으면 채점하지 않는다. */
function factorLateStrength(row) {
  const pct = num(row.lateStrengthPct);
  if (pct == null) return null;
  const score = pct >= 1 ? 3 : pct >= 0.3 ? 2 : pct >= 0 ? 1 : 0;
  return { score, max: 3, value: `${pct >= 0 ? "+" : ""}${round1(pct)}%`, note: "14:30 → 종가" };
}

/** C1. 이평선 정배열. */
function factorMaAlignment(_row, snap) {
  const [m5, m10, m20, m60] = [snap.ma5Cur, snap.ma10Cur, snap.ma20Cur, snap.ma60Cur].map(num);
  if (m5 == null || m10 == null || m20 == null) return null;
  let score;
  let value;
  if (m60 != null && m5 > m10 && m10 > m20 && m20 > m60) {
    score = 6;
    value = "완전 정배열";
  } else if (m5 > m10 && m10 > m20) {
    score = 4;
    value = "단기 정배열";
  } else {
    score = 1;
    value = "정배열 아님";
  }
  return { score, max: 6, value, note: "5>10>20>60 = 만점" };
}

/** C2. 신고가 돌파 — 위쪽에 매물대가 없을수록 익일 갭이 살아남는다. */
function factorBreakout(_row, snap) {
  const w = snap.highBreakoutByWindow || {};
  if (!snap.high52wBreakout && !Object.keys(w).length) return null;
  let score = 0;
  let value = "없음";
  if (snap.high52wBreakout) [score, value] = [7, "52주 신고가"];
  else if (w[240]) [score, value] = [6, "240일 신고가"];
  else if (w[120]) [score, value] = [5, "120일 신고가"];
  else if (w[60]) [score, value] = [4, "60일 신고가"];
  else if (w[20]) [score, value] = [2, "20일 신고가"];
  return { score, max: 7, value, note: "기간이 길수록 고점" };
}

/** C3. 5일선 이격도 — 너무 벌어지면 하루짜리 과열이다. */
function factorDisparity(_row, snap) {
  const close = num(snap.closeCur);
  const ma5 = num(snap.ma5Cur);
  if (close == null || ma5 == null || ma5 <= 0) return null;
  const d = (close / ma5) * 100;
  const score = d >= 100 && d < 108 ? 4 : d >= 108 && d < 115 ? 2 : d < 100 ? 1 : 0;
  return { score, max: 4, value: `${round1(d)}`, note: "100~108 = 만점" };
}

/** C4. 최근 5일 누적 상승률 — 이미 많이 올랐으면 남은 여력이 적다. */
function factorRecentRun(_row, snap) {
  const r = num((snap.periodReturns || {})[5]);
  if (r == null) return null;
  const score = r < 10 ? 3 : r < 25 ? 1 : 0;
  return { score, max: 3, value: `${r >= 0 ? "+" : ""}${round1(r)}%`, note: "5일 누적(+10% 미만 = 만점)" };
}

/** D. 재료 — 2차 버전에서 DART 공시 + 뉴스 + AI 분류로 채운다.
 * row.catalyst = { present: bool, grade: string, score: 0~20, summary: string }
 * ⚠️ 붙일 때는 **후보 전원에게** 붙여야 한다(재료 없으면 {present:false,score:0}).
 * 일부 종목만 catalyst가 있으면 종목마다 분모(max)가 달라져 순위가 왜곡된다. */
function factorCatalyst(row) {
  const c = row.catalyst;
  if (!c || typeof c !== "object") return null;
  return {
    score: clamp(num(c.score) || 0, 0, 20),
    max: 20,
    value: c.summary || (c.present ? c.grade || "재료 있음" : "재료 없음"),
    note: "당일 공시·뉴스",
  };
}

const FACTORS = [
  { key: "turnover", group: "수급", label: "거래대금 회전율", fn: factorTurnover },
  { key: "tradingValue", group: "수급", label: "거래대금", fn: factorTradingValue },
  { key: "volumeRatio", group: "수급", label: "거래량 급증", fn: factorVolumeRatio },
  { key: "investorFlow", group: "수급", label: "외국인·기관", fn: factorInvestorFlow },
  { key: "closePosition", group: "종가", label: "종가 위치", fn: factorClosePosition },
  { key: "changeBand", group: "종가", label: "등락률 구간", fn: factorChangeBand },
  { key: "candleShape", group: "종가", label: "캔들 모양", fn: factorCandleShape },
  { key: "lateStrength", group: "종가", label: "막판 강도", fn: factorLateStrength },
  { key: "maAlignment", group: "차트", label: "이평 정배열", fn: factorMaAlignment },
  { key: "breakout", group: "차트", label: "신고가", fn: factorBreakout },
  { key: "disparity", group: "차트", label: "5일 이격도", fn: factorDisparity },
  { key: "recentRun", group: "차트", label: "최근 5일", fn: factorRecentRun },
  { key: "catalyst", group: "재료", label: "재료", fn: factorCatalyst },
];

/* ── 감점 ───────────────────────────────────────────────────────────────── */
function computePenalties(row, snap) {
  const out = [];
  const c = num(row.changePct);
  const vr = num(snap.volumeRatio);
  const close = num(snap.closeCur);
  const ma5 = num(snap.ma5Cur);

  if (c != null && c > 20) out.push({ key: "overheated", label: "당일 +20% 초과", points: 5 });
  if (vr != null && vr < 100) out.push({ key: "thinVolume", label: "거래량 평소 이하", points: 4 });
  /* 2026-09-11 실측 보정: 5일 누적 +48.6%·5일선 이격도 118인 종목이 수급 만점만으로
   * 1위에 올라왔다. 차트 축(20점)이 과열을 눌러줄 만큼 무겁지 않아서, 과열은 배점이 아니라
   * 감점으로 처리한다 — 파라볼릭 구간은 익일 갭 후 되돌림이 가장 잦은 자리다. */
  if (close != null && ma5 && (close / ma5) * 100 > 115) {
    out.push({ key: "farFromMa5", label: "5일선 이격 115 초과", points: 4 });
  }
  const run5 = num((snap.periodReturns || {})[5]);
  if (run5 != null && run5 > 30) out.push({ key: "parabolic", label: `5일 누적 +${Math.round(run5)}%`, points: 6 });
  const streak = num(snap.streakCount);
  if (snap.streakDirection === "up" && streak != null && streak >= 4) {
    out.push({ key: "longStreak", label: `${streak}일 연속 상승`, points: 3 });
  }
  return out;
}

/* ── 메인 ───────────────────────────────────────────────────────────────── */

/**
 * 종목 하나를 채점한다.
 * @param {object} row 스캔 결과 행 {code,name,market,close,changePct,tradingValueEok,
 *                     marketCapEok,snapshot, lateStrengthPct?, catalyst?}
 * @returns {object} 채점 결과. passed=false면 score는 null.
 */
function scoreCloseBetting(row) {
  const snap = (row && row.snapshot) || {};
  const filter = applyHardFilters(row || {});
  if (!filter.passed) {
    return {
      code: row && row.code,
      name: row && row.name,
      passed: false,
      rejectedBy: filter.rejectedBy,
      reason: filter.reason,
      score: null,
      factors: [],
      penalties: [],
    };
  }

  const factors = [];
  let raw = 0;
  let max = 0;
  for (const f of FACTORS) {
    const r = f.fn(row, snap);
    if (!r) continue;
    const score = Math.round(r.score * 10) / 10;
    raw += score;
    max += r.max;
    factors.push({ key: f.key, group: f.group, label: f.label, score, max: r.max, value: r.value, note: r.note });
  }
  if (max <= 0) {
    return { code: row.code, name: row.name, passed: false, rejectedBy: "DATA", reason: "채점 가능한 데이터 없음", score: null, factors: [], penalties: [] };
  }

  const penalties = computePenalties(row, snap);
  const penaltyTotal = penalties.reduce((a, p) => a + p.points, 0);
  const score = clamp(Math.round(((raw - penaltyTotal) / max) * 1000) / 10, 0, 100);

  return {
    code: row.code,
    name: row.name,
    market: row.market,
    close: num(snap.closeCur != null ? snap.closeCur : row.close),
    changePct: num(row.changePct),
    tradingValueEok: num(row.tradingValueEok),
    marketCapEok: num(row.marketCapEok),
    sector: snap.sector || null,
    passed: true,
    rejectedBy: null,
    reason: null,
    score,
    rawScore: Math.round(raw * 10) / 10,
    maxScore: max,
    penaltyTotal,
    factors,
    penalties,
    /** 채점에서 빠진 팩터 — 화면에 "미반영"으로 표시해 없는 값을 있는 척하지 않는다 */
    missing: FACTORS.filter((f) => !factors.some((x) => x.key === f.key)).map((f) => f.label),
  };
}

/**
 * 후보 전체를 채점해 상위 N개를 돌려준다.
 * @returns {{ranked: object[], rejected: object[], stats: object}}
 */
function rankCloseBetting(rows, limit = 10) {
  const scored = [];
  const rejected = [];
  for (const row of rows || []) {
    const r = scoreCloseBetting(row);
    if (r.passed) scored.push(r);
    else rejected.push(r);
  }
  scored.sort((a, b) => b.score - a.score || (b.tradingValueEok || 0) - (a.tradingValueEok || 0));
  const ranked = scored.slice(0, limit).map((r, i) => Object.assign({ rank: i + 1 }, r));

  const byFilter = {};
  for (const r of rejected) byFilter[r.rejectedBy] = (byFilter[r.rejectedBy] || 0) + 1;
  return {
    ranked,
    rejected,
    stats: { total: (rows || []).length, passed: scored.length, rejectedByFilter: byFilter },
  };
}

module.exports = {
  scoreCloseBetting,
  rankCloseBetting,
  applyHardFilters,
  closePosition,
  FACTORS,
  THRESHOLDS: {
    MIN_TRADING_VALUE_EOK,
    MIN_MARKET_CAP_EOK,
    MAX_MARKET_CAP_EOK,
    MIN_CHANGE_PCT,
    MAX_CHANGE_PCT,
    MIN_CLOSE_POSITION,
  },
};
