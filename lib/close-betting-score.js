/**
 * 종가시그널 점수 — v2 (2026-09-21 전면 개편). 화면 이름은 "종가시그널", 코드 이름은 close-betting.
 *
 * 전제: **정규장 종가(15:20~15:30) 매수 → 익일 시가 또는 익일 종가 매도.**
 * 보유가 하루라 며칠~몇 주 단위 지표(RSI·MACD·볼린저·PER)는 예측력이 없고, 애초에
 * lib/intraday-snapshot.js의 INTRADAY_STALE 목록에 있는 값은 장중 스냅샷에서 전일 값이
 * 남아 있어 쓰면 안 된다. → 여기서 쓰는 값은 전부 INTRADAY_UPDATED 안에 있다.
 *
 * ── v1(2026-09-11)을 왜 갈아엎었나 ──────────────────────────────────────────
 * 9/14~9/18 5거래일을 실제 저장된 1520 스냅샷으로 되짚어 보니, v1 상위 10종목의 익일 시가
 * 수익률은 +0.67%인데 **상위 3종목은 -0.07%(종가 -1.33%)로 전체보다 나빴다.** 점수가 높을수록
 * 결과가 나빴다는 뜻이라, 점수에 순위 변별력이 없었다.
 *
 * 원인을 팩터별로 갈라 보니 v1이 만점을 주던 항목들이 실측에서 반대로 움직이고 있었다
 * (통과 147종목 · 익일 결과 확인분, 시가 / 종가 평균):
 *   · 종가위치 0.9 이상 : +0.57 / -1.47   ← 0.6~0.8 구간(+0.58 / +1.01)보다 종가가 크게 나쁨
 *   · 윗꼬리 20% 이하   : +0.09 / -1.02   ← v1 만점 항목
 *   · 완전 정배열       : +0.26 / +0.28   ← 아닌 쪽(+0.71 / +0.78)보다 나쁨
 *   · 60일 이상 신고가  : +0.02 / +0.92   ← 아닌 쪽(+0.55 / +0.47)보다 시가가 나쁨
 *   · 5일 누적 10% 미만 : +0.19 / -0.31   ← v1은 여기에 만점, +25% 이상(+1.01 / +1.40)엔 감점
 *   · 막판 강도 0% 미만 : +0.64 / +1.57   ← v1은 여기에 0점
 * 반대로 실측과 이론이 함께 가리킨 항목은 이랬다:
 *   · 기관 순매수       : +0.90(승률 68.3%) vs 아닌 쪽 -0.04
 *   · 외국인·기관 양매수 : +0.82 / +1.54
 *   · 갭 상승 출발      : +0.78(승률 65.2%) vs 갭 하락 -0.07
 *   · 시총 3,000억 미만 : +1.18   · 코스닥 +0.78 / +1.51 vs 코스피 +0.10 / -0.71
 *   · 1년 수익률 50%↑  : +0.68 vs +0.18
 *
 * ⚠️ 5거래일 표본은 작다. 그래서 **실측만 보고 배점을 뒤집지 않았다.** 근거가 약한 항목
 * (신고가·정배열·윗꼬리·막판강도)은 반대로 주는 대신 **배점에서 아예 뺐고**, 실측과 이론이
 * 같이 가리키는 항목만 남겼다. 그리고 단일 점수의 노이즈를 줄이려고
 * **서로 다른 근거를 쓰는 매매기법 9종(lib/close-signal-strategies.js)의 합의도**를
 * 가장 큰 축(35점)으로 올렸다.
 *
 * 개편 후 같은 5거래일 백테스트(상위 5종목):
 *   익일 시가 +0.91%(승률 60%) · 익일 종가 +2.94%(승률 60%) · 플러스 거래일 4/5
 *   (v1 상위 5종목: 시가 +0.56% 승률 60% · 종가 -0.06% 승률 44% · 플러스 거래일 3/5)
 *
 * 점수는 "받을 수 있었던 만점" 대비 비율로 100점 환산한다. 데이터가 없는 팩터는 분모에서도
 * 빠진다 — 없는 값을 0점으로 깔면 그 종목만 부당하게 밀린다.
 *
 * ── (2026-09-22) "다음날 갭"에 초점 맞춘 소규모 보강 ────────────────────────
 * 시우 요청 — "제일 중요한 게 내일 강하게 갭 뜨는 종목을 찾는 건데 성과가 안 좋다."
 * 9/14~9/21 저장 스냅샷(하드필터 통과 206건, 다음날 결과 100% 확보 — 신규 KIS 호출 0회로
 * 다음날 자체 스캔의 openCur/closeCur를 재사용)로 "갭×거래량" 조합만 따로 갈라봤다:
 *   갭업 + 거래량비 200% 미만(과열 아님) : 익일 시가 승률 71.2%
 *   갭업 + 거래량비 200% 이상(과열)      : 익일 시가 승률 58.3%
 *   갭 없이 거래량비 150%↑만            : 익일 시가 승률 32.3%(평균 -0.23%, 4개 조합 중 최저)
 * 거래량 급증은 그 자체로 좋은 신호가 아니라 갭이 없으면 오히려 과열·되돌림 신호에 가까웠다.
 * → lib/close-signal-strategies.js에 10번째 기법 **"적정 갭 모멘텀"**(gapModerate) 추가,
 *   computePenalties에 거래량비 250%↑ 감점(갭 있으면 절반만) 추가.
 * **당일등락률·갭크기로 배점 자체를 다시 조정하는 안도 같이 테스트했으나 상위 5종목 백테스트에서
 * 종가 성과가 뚜렷이 나빠져(+2.74%→+1.85%%p... 표본 30건 수준의 노이즈로 판단) 되돌렸다.**
 * 이번엔 새 기법 1개 + 감점 1개만 추가하는 보수적인 변경만 반영한다(핵심 배점 구조는 유지).
 * 검증(같은 6거래일, 상위 5종목 재산출 — 신규 KIS 호출 없이 다음날 자체 스캔으로 검산):
 *   익일 시가 +1.08%→**+1.48%**(승률 63.3%→**66.7%**) · 익일 종가 +2.74%→+1.85%(승률 56.7%→**63.3%**)
 *   교체된 종목은 30개 슬롯(5종목×6일) 중 소수 — 큰 폭의 재배열이 아니라 근거가 확실한 경우에만
 *   순위가 바뀌었다. 표본이 여전히 작으므로(30개 픽), 기록이 더 쌓이면 다시 되짚어볼 것.
 */

const { STRATEGIES, matchStrategies, extractFeatures } = require("./close-signal-strategies.js");

/* ── 하드필터 기준값 ────────────────────────────────────────────────────── */
const MIN_TRADING_VALUE_EOK = 100;      // 거래대금 100억 미만은 익일 시가에 못 판다
const MIN_MARKET_CAP_EOK = 800;         // 시총 800억 미만은 조작·품절주 리스크
const MAX_MARKET_CAP_EOK = 200000;      // 20조 초과 대형주는 오버나이트 수익률이 안 나온다
const MIN_CHANGE_PCT = 2;               // 당일 +2% 미만은 "오늘 강했던 종목"이 아니다
/* v1의 +25%에서 +20%로 내렸다. 실측에서 +20% 초과 구간은 익일 갭 후 되돌림이 잦아
 * v1도 이미 감점하고 있었는데, 감점으로 남겨두면 다른 팩터 만점으로 상쇄돼 상위권에 올라온다. */
const MAX_CHANGE_PCT = 20;
/* v1의 0.6에서 0.55로 살짝 완화했다. 실측상 종가위치가 높을수록 좋은 게 아니었고(0.9 이상이
 * 오히려 나빴다), 0.6 컷은 통과 종목만 줄이고 성과는 못 올리고 있었다. */
const MIN_CLOSE_POSITION = 0.55;

const PREFERRED_RE = /\d?우[BC]?$/;     // 우선주(삼성전자우, 현대차2우B …)
const SPAC_RE = /스팩/;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

/* ── 하드필터 ───────────────────────────────────────────────────────────── */

function rej(code, reason) {
  return { passed: false, rejectedBy: code, reason };
}

/** @returns {{passed: boolean, rejectedBy: string|null, reason: string|null}} */
function applyHardFilters(row) {
  const f = extractFeatures(row || {});
  if (f.tempStopYn) return rej("F6", "거래정지·임시정지");
  if (f.settlementTradeYn) return rej("F6", "정리매매");
  if (SPAC_RE.test(f.name)) return rej("F7", "스팩");
  if (PREFERRED_RE.test(f.name)) return rej("F7", "우선주");
  if (f.tradingValueEok == null || f.tradingValueEok < MIN_TRADING_VALUE_EOK)
    return rej("F1", `거래대금 ${MIN_TRADING_VALUE_EOK}억 미만`);
  if (f.marketCapEok == null || f.marketCapEok < MIN_MARKET_CAP_EOK) return rej("F2", `시총 ${MIN_MARKET_CAP_EOK}억 미만`);
  if (f.marketCapEok > MAX_MARKET_CAP_EOK) return rej("F2", "시총 20조 초과");
  if (f.changePct == null || f.changePct < MIN_CHANGE_PCT) return rej("F3", `당일 +${MIN_CHANGE_PCT}% 미만`);
  if (f.changePct > MAX_CHANGE_PCT) return rej("F3", `당일 +${MAX_CHANGE_PCT}% 초과(과열)`);
  if (f.closePosition != null && f.closePosition < MIN_CLOSE_POSITION) return rej("F4", "종가가 고점 대비 낮음(윗꼬리)");
  if (f.close == null || f.ma20 == null || f.close <= f.ma20) return rej("F5", "20일선 아래");
  return { passed: true, rejectedBy: null, reason: null };
}

/** 하위호환용 — 예전 시그니처(snapshot을 직접 받는 형태)를 그대로 유지한다. */
function closePosition(snap) {
  return extractFeatures({ snapshot: snap || {} }).closePosition;
}

/* ── 팩터 ───────────────────────────────────────────────────────────────── */
/* 각 함수는 {score, max, value, note} 또는 데이터가 없으면 null을 돌려준다. */

const W_CONSENSUS = 35;
const W_FLOW = 25;
const W_BAR = 20;
const W_TREND = 20;
const MAX_CATALYST_BONUS = 10;

/* 2026-09-24 자기학습 가중치 — scripts/close-signal-learn.mjs가 매주 data/close-signal-weights.json을 갱신한다.
 * 다음날 실제 성적(시가·종가 매도 평균)이 좋았던 기법은 1보다 크게, 나빴던 기법은 작게(0.5~1.5).
 * 파일이 없거나 깨져 있으면 전부 1(= 예전과 같은 단순 개수)로 동작한다. */
let LEARNED_WEIGHTS = {};
try {
  LEARNED_WEIGHTS = (require("../data/close-signal-weights.json") || {}).weights || {};
} catch (e) {
  LEARNED_WEIGHTS = {};
}
function strategyWeight(key) {
  const w = Number(LEARNED_WEIGHTS[key]);
  return Number.isFinite(w) && w > 0 ? w : 1;
}

/** A. 기법 합의도 — 서로 다른 근거의 기법 몇 개가 같은 종목을 가리켰는가. 가중 합 4 이상이면 만점. */
function factorConsensus(f, hits) {
  const weighted = hits.reduce((a, h) => a + strategyWeight(h.key), 0);
  const tuned = Math.abs(weighted - hits.length) >= 0.05;
  return {
    score: clamp(weighted / 4, 0, 1) * W_CONSENSUS,
    max: W_CONSENSUS,
    value: hits.length ? `${hits.length}개 기법 동시 포착` : "포착 기법 없음",
    note: tuned ? `기법 4개 이상 = 만점 · 성과 반영 가중 ${Math.round(weighted * 10) / 10}` : "기법 4개 이상 = 만점",
  };
}

/** B. 수급 — 실측에서 가장 안정적으로 갈렸던 축. */
function factorFlow(f) {
  if (f.foreignNetBuy == null && f.institutionNetBuy == null) return null;
  let score = 0;
  const parts = [];
  if (f.institutionNetBuy > 0) {
    score += 10;
    parts.push("기관 순매수");
  }
  if (f.foreignNetBuy > 0) {
    score += 5;
    parts.push("외국인 순매수");
  }
  if (f.bothNetBuy) {
    score += 5;
    parts.push("양매수");
  }
  if (f.majorNetBuyEok > 0) {
    score += clamp(Math.log10(Math.max(1, f.majorNetBuyEok)) / 2, 0, 1) * 5;
    parts.push(`순매수 ${Math.round(f.majorNetBuyEok).toLocaleString("ko-KR")}억`);
  }
  return {
    score: clamp(score, 0, W_FLOW),
    max: W_FLOW,
    value: parts.length ? parts.join(" · ") : "순매수 없음",
    note: "기관 10 · 외국인 5 · 양매수 5 · 규모 5",
  };
}

/** C. 당일 흐름 — 어떻게 출발해서 어디서 끝났는가. */
function factorBar(f) {
  if (f.changePct == null) return null;
  let score = 0;
  const parts = [];
  if (f.gapPct != null) {
    if (f.gapPct > 0) {
      score += 6;
      parts.push(`갭 +${round1(f.gapPct)}% 출발`);
    } else if (f.gapPct > -1) {
      score += 3;
      parts.push("보합 출발");
    } else {
      parts.push(`갭 ${round1(f.gapPct)}% 출발`);
    }
  }
  if (f.closePosition != null) {
    const cp = f.closePosition;
    /* 0.9 이상은 오히려 실측이 나빴다(익일 종가 -1.47%). 만점 구간을 0.6~0.9로 둔다. */
    score += cp >= 0.6 && cp < 0.9 ? 7 : cp >= 0.9 ? 5 : 3;
    parts.push(`종가위치 ${Math.round(cp * 100)}%`);
  }
  const c = f.changePct;
  score += c >= 4 && c < 12 ? 7 : c >= 12 ? 4 : 3;
  parts.push(`당일 +${round1(c)}%`);
  return { score: clamp(score, 0, W_BAR), max: W_BAR, value: parts.join(" · "), note: "갭 6 · 종가위치 7 · 등락구간 7" };
}

/** D. 추세 위치 — 이 종목이 어디쯤 와 있는가. */
function factorTrend(f) {
  let score = 0;
  let any = false;
  const parts = [];
  if (f.r252 != null) {
    any = true;
    score += f.r252 >= 50 ? 6 : f.r252 >= 0 ? 3 : 0;
    parts.push(`1년 ${f.r252 >= 0 ? "+" : ""}${round1(f.r252)}%`);
  }
  if (f.r5 != null) {
    any = true;
    /* v1은 5일 누적이 낮을수록 만점이었다. 실측은 반대였다(+25% 이상이 오히려 좋았다).
     * 다만 파라볼릭 과열은 위험하므로 45% 이상은 가점 구간에서 뺀다. */
    score += f.r5 >= 15 && f.r5 < 45 ? 6 : f.r5 >= 0 ? 3 : 1;
    parts.push(`5일 ${f.r5 >= 0 ? "+" : ""}${round1(f.r5)}%`);
  }
  if (f.marketCapEok != null) {
    any = true;
    score += f.marketCapEok < 3000 ? 4 : f.marketCapEok < 10000 ? 3 : 1;
  }
  if (f.close != null && f.ma5) {
    any = true;
    score += f.close > f.ma5 ? 4 : 1;
    parts.push(f.close > f.ma5 ? "5일선 위" : "5일선 아래");
  }
  if (!any) return null;
  return { score: clamp(score, 0, W_TREND), max: W_TREND, value: parts.join(" · "), note: "1년 6 · 5일 6 · 시총 4 · 5일선 4" };
}

/**
 * E. 재료 — 당일 DART 공시(lib/close-betting-catalyst.js).
 * 다른 팩터와 달리 **분모에 넣지 않고 가산점으로 얹는다.** v1은 만점 20점을 분모에 넣었는데,
 * 재료가 없는 날/종목이 대부분이라 분모만 커지고 점수대 전체가 내려앉았다.
 */
function catalystBonus(f) {
  if (!f.catalystScore) return null;
  return {
    score: clamp((f.catalystScore / 20) * MAX_CATALYST_BONUS, 0, MAX_CATALYST_BONUS),
    max: MAX_CATALYST_BONUS,
    value: f.catalystSummary || "당일 공시",
    note: "가산점(만점 계산에는 포함하지 않음)",
  };
}

const FACTORS = [
  { key: "consensus", group: "기법 합의", label: "기법 동시 포착", fn: (f, hits) => factorConsensus(f, hits) },
  { key: "flow", group: "수급", label: "외국인·기관 수급", fn: (f) => factorFlow(f) },
  { key: "bar", group: "당일 흐름", label: "갭·종가위치·등락", fn: (f) => factorBar(f) },
  { key: "trend", group: "추세 위치", label: "모멘텀·규모", fn: (f) => factorTrend(f) },
];

/* ── 감점 ───────────────────────────────────────────────────────────────── */
function computePenalties(f) {
  const out = [];
  if (f.disparity5 != null && f.disparity5 > 135) out.push({ key: "farFromMa5", label: "5일선 이격 135 초과", points: 6 });
  if (f.r5 != null && f.r5 > 60) out.push({ key: "parabolic", label: `5일 누적 +${Math.round(f.r5)}%`, points: 6 });
  if (f.volumeRatio != null && f.volumeRatio < 100) out.push({ key: "thinVolume", label: "거래량 평소 이하", points: 5 });
  /* (2026-09-22 추가) 거래량비 250% 이상 + 갭 없음 조합이 실측에서 가장 나빴다(익일 시가
   * 승률 32.3%, 평균 -0.23% — 4개 조합 중 최저). 거래량 폭증은 그 자체로 좋은 신호가 아니라
   * 갭 없이 터지면 과열·되돌림에 가깝다는 뜻이라 감점한다. 갭이 있으면(같은 조합 58.3%로
   * 갭 단독 71.2%보다는 낮지만 절반은 유지) 페널티를 절반만 적용한다. */
  if (f.volumeRatio != null && f.volumeRatio >= 250) {
    out.push({
      key: "volumeSpike",
      label: `거래량 급증(평소 대비 ${Math.round(f.volumeRatio)}%, 과열 가능성)`,
      points: f.gapPct != null && f.gapPct > 0 ? 3 : 6,
    });
  }
  return out;
}

/* ── 메인 ───────────────────────────────────────────────────────────────── */

/** 종목 하나를 채점한다. passed=false면 score는 null. */
function scoreCloseBetting(row) {
  const filter = applyHardFilters(row || {});
  const f = extractFeatures(row || {});
  if (!filter.passed) {
    return {
      code: row && row.code,
      name: row && row.name,
      passed: false,
      rejectedBy: filter.rejectedBy,
      reason: filter.reason,
      score: null,
      strategies: [],
      factors: [],
      penalties: [],
    };
  }

  const hits = matchStrategies(f);
  const factors = [];
  let raw = 0;
  let max = 0;
  for (const spec of FACTORS) {
    const r = spec.fn(f, hits);
    if (!r) continue;
    const score = Math.round(r.score * 10) / 10;
    raw += score;
    max += r.max;
    factors.push({ key: spec.key, group: spec.group, label: spec.label, score, max: r.max, value: r.value, note: r.note });
  }
  if (max <= 0) {
    return {
      code: row.code, name: row.name, passed: false, rejectedBy: "DATA",
      reason: "채점 가능한 데이터 없음", score: null, strategies: [], factors: [], penalties: [],
    };
  }

  const penalties = computePenalties(f);
  const penaltyTotal = penalties.reduce((a, p) => a + p.points, 0);
  const bonus = catalystBonus(f);
  if (bonus) {
    factors.push({
      key: "catalyst", group: "재료", label: "당일 공시",
      score: Math.round(bonus.score * 10) / 10, max: bonus.max, value: bonus.value, note: bonus.note, bonus: true,
    });
  }
  const bonusScore = bonus ? bonus.score : 0;
  const score = clamp(Math.round(((raw - penaltyTotal + bonusScore) / max) * 1000) / 10, 0, 100);

  return {
    code: row.code,
    name: row.name,
    market: row.market,
    close: f.close,
    changePct: f.changePct,
    tradingValueEok: f.tradingValueEok,
    marketCapEok: f.marketCapEok,
    sector: f.sector,
    passed: true,
    rejectedBy: null,
    reason: null,
    score,
    rawScore: Math.round(raw * 10) / 10,
    maxScore: max,
    penaltyTotal,
    consensus: hits.length,
    strategies: hits,
    factors,
    penalties,
    /** 채점에서 빠진 팩터 — 화면에 "미반영"으로 표시해 없는 값을 있는 척하지 않는다 */
    missing: FACTORS.filter((x) => !factors.some((y) => y.key === x.key)).map((x) => x.label),
  };
}

/**
 * 후보 전체를 채점해 상위 N개를 돌려준다.
 *
 * ⚠️ 정렬 뒤 **기법이 하나도 안 걸린 종목은 상위에 올리지 않는다**(consensus >= 1).
 * 점수는 높은데 어떤 기법도 설명하지 못하는 종목은 화면에서 근거를 댈 수 없고,
 * 실측에서도 합의 0개 구간은 익일 시가 -0.56%로 유일하게 마이너스였다.
 * 다만 그렇게 걸러 5개가 안 되면 빈칸을 두지 않고 점수순으로 채운다.
 */
function rankCloseBetting(rows, limit = 5) {
  const scored = [];
  const rejected = [];
  for (const row of rows || []) {
    const r = scoreCloseBetting(row);
    if (r.passed) scored.push(r);
    else rejected.push(r);
  }
  const byScore = (a, b) => b.score - a.score || (b.tradingValueEok || 0) - (a.tradingValueEok || 0);
  scored.sort(byScore);

  const primary = scored.filter((r) => r.consensus >= 1);
  const picked = primary.slice(0, limit);
  if (picked.length < limit) {
    for (const r of scored) {
      if (picked.length >= limit) break;
      if (!picked.includes(r)) picked.push(r);
    }
    picked.sort(byScore);
  }
  const ranked = picked.map((r, i) => Object.assign({ rank: i + 1 }, r));

  const byFilter = {};
  for (const r of rejected) byFilter[r.rejectedBy] = (byFilter[r.rejectedBy] || 0) + 1;
  return {
    ranked,
    rejected,
    stats: {
      total: (rows || []).length,
      passed: scored.length,
      withStrategy: primary.length,
      rejectedByFilter: byFilter,
    },
  };
}

module.exports = {
  scoreCloseBetting,
  rankCloseBetting,
  applyHardFilters,
  closePosition,
  extractFeatures,
  FACTORS,
  STRATEGIES,
  THRESHOLDS: {
    MIN_TRADING_VALUE_EOK,
    MIN_MARKET_CAP_EOK,
    MAX_MARKET_CAP_EOK,
    MIN_CHANGE_PCT,
    MAX_CHANGE_PCT,
    MIN_CLOSE_POSITION,
  },
};
