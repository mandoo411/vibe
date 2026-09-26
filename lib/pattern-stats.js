/**
 * 과거 유사 국면 통계 (2026-09-26 신설)
 *
 * AI 종목분석의 시나리오 확률(A 35% / B 45% / C 20% 같은 숫자)은 그동안 AI의 정성적 판단뿐이라
 * "근거가 뭐냐"는 지적을 받았다. 그렇다고 AI에게 "과거 5년 N회 중 M회"를 쓰라고 하면 데이터가
 * 없으니 숫자를 지어낸다. 그래서 **코드가 실제 일봉으로 직접 센다**:
 *
 *  1) 오늘의 상태를 세 가지로 정의한다
 *     - 종가가 20일선 위인가 / 아래인가
 *     - 20일선이 60일선 위인가 / 아래인가 (중기 배열)
 *     - RSI(14) 구간: 30 미만 / 30~45 / 45~55 / 55~70 / 70 이상
 *  2) 과거 일봉에서 같은 상태였던 날을 모두 찾는다
 *  3) 그날 이후 5거래일·20거래일 뒤 종가 수익률을 모은다
 *
 * 연속된 날은 사실상 같은 국면이라 표본을 부풀린다 → 한 번 뽑으면 다음 5거래일은 건너뛴다.
 * 수급(외국인·기관)은 과거 일별 이력이 없어 조건에서 뺐다(화면에 그렇게 밝힌다).
 * 표본이 MIN_SAMPLE 미만이면 thin=true — 화면·AI 모두 확률 근거로 쓰지 않는다.
 */

const MIN_SAMPLE = 12;
const SPACING = 5;
const H_SHORT = 5;
const H_LONG = 20;

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Wilder RSI(14) — kis-indicators.computeRsiSeries와 같은 정의 */
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

const RSI_BUCKETS = [
  { max: 30, label: "RSI 30 미만" },
  { max: 45, label: "RSI 30~45" },
  { max: 55, label: "RSI 45~55" },
  { max: 70, label: "RSI 55~70" },
  { max: 101, label: "RSI 70 이상" },
];

function rsiBucket(v) {
  if (v == null || !Number.isFinite(v)) return -1;
  return RSI_BUCKETS.findIndex((b) => v < b.max);
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * @param {{time:string, close:number}[]} candles 오래된 → 최근 순 일봉
 * @returns {null | object}
 */
function computeSimilarPatternStats(candles) {
  if (!Array.isArray(candles) || candles.length < 200) return null;
  const rows = candles.filter((c) => c && Number.isFinite(Number(c.close)) && Number(c.close) > 0);
  if (rows.length < 200) return null;
  const closes = rows.map((c) => Number(c.close));
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const rsi = rsiSeries(closes);
  const n = closes.length;
  const last = n - 1;
  if (ma20[last] == null || ma60[last] == null || rsi[last] == null) return null;

  const stateAt = (i) => {
    if (ma20[i] == null || ma60[i] == null || rsi[i] == null) return null;
    return `${closes[i] > ma20[i] ? 1 : 0}${ma20[i] > ma60[i] ? 1 : 0}${rsiBucket(rsi[i])}`;
  };
  const today = stateAt(last);
  if (!today) return null;

  const f5 = [];
  const f20 = [];
  let lastTaken = -Infinity;
  for (let i = 60; i + H_LONG <= last; i++) {
    if (i - lastTaken < SPACING) continue;
    if (stateAt(i) !== today) continue;
    lastTaken = i;
    f5.push(((closes[i + H_SHORT] - closes[i]) / closes[i]) * 100);
    f20.push(((closes[i + H_LONG] - closes[i]) / closes[i]) * 100);
  }

  const s5 = [...f5].sort((a, b) => a - b);
  const s20 = [...f20].sort((a, b) => a - b);
  const up5 = f5.filter((v) => v > 0).length;
  const up20 = f20.filter((v) => v > 0).length;
  const bucket = RSI_BUCKETS[rsiBucket(rsi[last])];

  return {
    sample: f20.length,
    thin: f20.length < MIN_SAMPLE,
    minSample: MIN_SAMPLE,
    from: rows[0].time || null,
    to: rows[last].time || null,
    years: r1((n - 1) / 245),
    state: {
      aboveMa20: closes[last] > ma20[last],
      ma20AboveMa60: ma20[last] > ma60[last],
      rsi: r1(rsi[last]),
      rsiBand: bucket ? bucket.label : null,
    },
    stateText: [
      closes[last] > ma20[last] ? "주가가 20일선 위" : "주가가 20일선 아래",
      ma20[last] > ma60[last] ? "20일선이 60일선 위(정배열)" : "20일선이 60일선 아래(역배열)",
      bucket ? bucket.label : "",
    ]
      .filter(Boolean)
      .join(" · "),
    d5: { up: up5, upPct: f5.length ? Math.round((up5 / f5.length) * 100) : null, median: r1(quantile(s5, 0.5)) },
    d20: {
      up: up20,
      upPct: f20.length ? Math.round((up20 / f20.length) * 100) : null,
      median: r1(quantile(s20, 0.5)),
      p25: r1(quantile(s20, 0.25)),
      p75: r1(quantile(s20, 0.75)),
    },
  };
}

/** AI 프롬프트 블록 — 숫자는 코드가 센 값이고, AI는 해석만 한다. */
function patternStatsPromptBlock(ps) {
  if (!ps) return "";
  if (ps.thin) {
    return [
      "",
      `[과거 유사 국면 통계 — 코드 계산] 최근 약 ${ps.years}년 일봉에서 오늘과 같은 조건(${ps.stateText})은 ${ps.sample}회뿐이라 표본이 부족하다.`,
      "이 경우 통계를 확률 근거로 인용하지 말고, 시나리오 확률은 추세·수급·재료 근거로만 매긴다. '표본 O회' 같은 숫자를 새로 만들지 않는다.",
    ].join("\n");
  }
  return [
    "",
    `[과거 유사 국면 통계 — 코드가 이 종목의 실제 일봉(${ps.from}~${ps.to}, 약 ${ps.years}년)으로 직접 센 값. 추정이 아니다]`,
    `조건: ${ps.stateText} (수급은 과거 일별 이력이 없어 조건에서 제외)`,
    `같은 조건 ${ps.sample}회(겹치는 날 제외) → 5거래일 뒤 상승 ${ps.d5.up}회(${ps.d5.upPct}%), 중앙값 ${ps.d5.median}%`,
    `20거래일 뒤 상승 ${ps.d20.up}회(${ps.d20.upPct}%), 중앙값 ${ps.d20.median}%, 하위 25% ${ps.d20.p25}% · 상위 25% ${ps.d20.p75}%`,
    `시나리오 확률은 이 통계를 출발점으로 삼는다: 약세(C) 확률이 과거 20거래일 뒤 하락 비율(${100 - ps.d20.upPct}%)과 15%p 이상 차이 나면, 그 이유(수급·재료·밸류에이션)를 약세 시나리오의 확률 근거(basis)에 반드시 적는다.`,
    "확률 근거(basis)에는 이 통계를 '과거 비슷한 국면 N회 중 M회 상승'처럼 한 번 인용한다. 이 통계에 없는 표본 수·적중률을 새로 만들지 않는다. 화면에도 같은 표가 따로 나가니 숫자를 길게 반복하지 않는다.",
  ].join("\n");
}

module.exports = { computeSimilarPatternStats, patternStatsPromptBlock, MIN_SAMPLE };
