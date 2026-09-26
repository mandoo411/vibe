/**
 * AI 종목분석 예측 채점 규칙 (2026-09-26 신설) — scripts/ai-report-grade.mjs와 화면 설명이 같은 규칙을 쓴다.
 *
 * 리포트의 "기준 계획"(진입가·목표가·손절가)을 리포트 다음 거래일부터 최대 20거래일 동안 실제 일봉으로 따라간다.
 *
 * 진입
 *  - 진입가가 리포트 시점 가격의 ±1% 안: 다음 거래일 시가에 진입
 *  - 진입가가 더 낮음(눌림목): 저가가 진입가에 닿은 날 진입(시가가 이미 더 낮으면 시가)
 *  - 진입가가 더 높음(돌파): 고가가 진입가에 닿은 날 진입(시가가 이미 더 높으면 시가)
 * 청산
 *  - 시가가 손절가 이하 / 목표가 이상이면 그 시가로 청산
 *  - 하루 안에 손절가와 목표가를 둘 다 건드렸으면 보수적으로 "손절"
 *  - 진입한 날은 진입 이후만 보장할 수 없어, 그날 손절선 이탈만 반영하고 목표 도달은 다음 날부터 본다
 * 결과
 *  target(목표 도달) · stop(손절) · expired(20거래일 경과 — 20번째 날 종가로 평가) ·
 *  no_entry(20거래일 동안 진입가 미도달) · open(진입 후 진행 중) · wait(진입 대기)
 */

const HORIZON = 20;

const pct = (a, b) => (a != null && b ? Math.round(((a - b) / b) * 10000) / 100 : null);

function gradeReport(report, bars) {
  const p0 = Number(report.price_at_report);
  const entry = Number(report.entry_price);
  const target = Number(report.target_price);
  const stop = Number(report.stop_loss);
  const after = (bars || []).filter((b) => b && b.time > report.report_date).slice(0, HORIZON);
  const base = {
    bars_after: after.length,
    ret5_pct: after.length >= 5 ? pct(after[4].close, p0) : null,
    ret20_pct: after.length >= HORIZON ? pct(after[HORIZON - 1].close, p0) : null,
  };
  if (!(p0 > 0 && entry > 0 && target > entry && stop > 0 && stop < entry)) {
    return { ...base, outcome: "invalid" };
  }

  const mode = Math.abs(entry - p0) / p0 <= 0.01 ? "market" : entry < p0 ? "dip" : "breakout";
  let fill = null;
  let fillIdx = -1;
  for (let i = 0; i < after.length; i++) {
    const b = after[i];
    if (mode === "market") fill = b.open;
    else if (mode === "dip" && b.low <= entry) fill = Math.min(b.open, entry);
    else if (mode === "breakout" && b.high >= entry) fill = Math.max(b.open, entry);
    if (fill != null) {
      fillIdx = i;
      break;
    }
  }
  if (fillIdx < 0) {
    return { ...base, outcome: after.length >= HORIZON ? "no_entry" : "wait" };
  }

  const entryDate = after[fillIdx].time;
  const done = (outcome, price, date) => ({
    ...base,
    outcome,
    entry_date: entryDate,
    outcome_price: price,
    outcome_date: date,
    outcome_return_pct: pct(price, fill),
  });

  // 진입한 날: 손절선 이탈만 본다
  const fb = after[fillIdx];
  if (fb.low <= stop) return done("stop", Math.min(stop, fill), fb.time);

  for (let i = fillIdx + 1; i < after.length; i++) {
    const b = after[i];
    if (b.open <= stop) return done("stop", b.open, b.time);
    if (b.open >= target) return done("target", b.open, b.time);
    if (b.low <= stop) return done("stop", stop, b.time);
    if (b.high >= target) return done("target", target, b.time);
  }
  if (after.length >= HORIZON) {
    const last = after[HORIZON - 1];
    return done("expired", last.close, last.time);
  }
  return { ...base, outcome: "open", entry_date: entryDate, outcome_return_pct: pct(after[after.length - 1].close, fill) };
}

module.exports = { gradeReport, HORIZON };
