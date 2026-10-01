#!/usr/bin/env node
/**
 * 1주 스윙 시그널 백테스트 랩 — 2026-10-02 신설. 저장도 커밋도 하지 않고 로그만 남긴다.
 *
 * 저장된 1520 스냅샷(trade_signal_intraday, 9/14~)을 lib/swing-signal.js로 그날그날 다시 채점하고,
 * KIS 일봉으로 "선정일 15:20 가격 매수 → 5거래일 뒤 종가 매도" 결과를 계산해
 *   ① 기법별 성과(걸린 종목 vs 필터 통과 전체)  ② 합의도 구간별 성과  ③ 상위 5종목 일별·누적
 * 을 출력한다. 채점 모델을 고칠 때마다 이걸 먼저 돌린다(repository_dispatch trigger-swing-lab).
 *
 * env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KIS_*  · LAB_FROM(기본 2026-09-14)
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fetchChartCandles } = require("../lib/kis-indicators.js");
const { scoreSwing, rankSwing, SWING_STRATEGIES } = require("../lib/swing-signal.js");
const krx = require("../lib/krx-calendar.js");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const FROM = process.env.LAB_FROM || "2026-09-14";
const HOLD = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, b) => (b ? ((a - b) / b) * 100 : null);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const f2 = (v) => (v == null ? "  -  " : (v > 0 ? "+" : "") + v.toFixed(2));

function nthTradingDay(ymd, n) {
  let d = ymd;
  for (let i = 0; i < n; i++) d = krx.nextTradingDay(d);
  return d;
}

async function sb(q) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

const barCache = new Map();
async function bars(code) {
  if (barCache.has(code)) return barCache.get(code);
  let m = new Map();
  for (let a = 0; a < 3; a++) {
    try {
      const c = await fetchChartCandles(code, "D", 45);
      m = new Map((c || []).map((b) => [String(b.time).slice(0, 10), b]));
      break;
    } catch (e) {
      await sleep(600 * (a + 1));
    }
  }
  barCache.set(code, m);
  await sleep(90);
  return m;
}

/** 선정일 다음 거래일부터 5거래일 — 마지막 날 종가, 기간 최고·최저 */
async function outcome(code, asOf, buy) {
  const m = await bars(code);
  const days = [];
  let d = asOf;
  for (let i = 0; i < HOLD; i++) {
    d = krx.nextTradingDay(d);
    days.push(d);
  }
  const bs = days.map((x) => m.get(x)).filter(Boolean);
  if (bs.length < HOLD) return null;
  return {
    ret: pct(bs[HOLD - 1].close, buy),
    max: pct(Math.max(...bs.map((b) => b.high)), buy),
    min: pct(Math.min(...bs.map((b) => b.low)), buy),
    d1: pct(bs[0].close, buy),
  };
}

async function main() {
  const today = krx.seoulYmd();
  const lastAsOf = (() => {
    // 결과(5거래일 뒤 종가)가 이미 확정된 마지막 선정일
    let d = krx.prevTradingDay(today);
    const hm = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(":", ""));
    let target = today;
    if (!krx.isTradingDay(today) || hm < 1540) target = krx.prevTradingDay(today);
    let a = target;
    for (let i = 0; i < HOLD; i++) a = krx.prevTradingDay(a);
    return a;
  })();
  console.log(`[lab] 기간 ${FROM} ~ ${lastAsOf} 선정분 (5거래일 결과 확정분만)`);

  const rows = await sb(`trade_signal_intraday?slot=eq.1520&as_of_date=gte.${FROM}&as_of_date=lte.${lastAsOf}&order=as_of_date.asc&select=as_of_date,payload`);
  const byStrat = new Map(SWING_STRATEGIES.map((s) => [s.key, []]));
  const all = [];
  const byCons = new Map();
  const top = [];
  const daily = [];

  for (const row of rows) {
    const stocks = (row.payload && row.payload.stocks) || [];
    const asOf = row.as_of_date;
    const { ranked, stats } = rankSwing(stocks, 5);
    const passing = [];
    for (const st of stocks) {
      const r = scoreSwing(st);
      if (r.passed) passing.push({ st, r });
    }
    let dayTop = [];
    for (const { st, r } of passing) {
      const o = await outcome(st.code, asOf, r.features.close);
      if (!o) continue;
      all.push(o.ret);
      for (const h of r.strategies) byStrat.get(h.key).push(o.ret);
      const c = Math.min(r.consensus, 5);
      if (!byCons.has(c)) byCons.set(c, []);
      byCons.get(c).push(o.ret);
    }
    for (const p of ranked) {
      const o = await outcome(p.code, asOf, p.close);
      if (!o) continue;
      top.push({ asOf, ...p, ...o });
      dayTop.push(o.ret);
    }
    daily.push({ asOf, passed: stats.passed, strong: stats.withStrategy, avg: avg(dayTop), n: dayTop.length });
    console.log(`\n[${asOf}] 통과 ${stats.passed} · 기법2+ ${stats.withStrategy} · 상위5 평균 ${f2(avg(dayTop))}%`);
    for (const p of top.filter((t) => t.asOf === asOf)) {
      console.log(`  ${p.rank}. ${p.name} ${p.score}점 합의${p.consensus} [${p.strategies.map((s) => s.label).join(",")}] → 5일 ${f2(p.ret)}% (최고 ${f2(p.max)} 최저 ${f2(p.min)}, 1일 ${f2(p.d1)})`);
    }
  }

  const base = avg(all);
  const win = (a) => (a.length ? (a.filter((v) => v > 0).length / a.length) * 100 : null);
  console.log(`\n===== 필터 통과 전체: n=${all.length} 평균 ${f2(base)}% 수익비율 ${win(all)?.toFixed(1)}%`);
  console.log("===== 기법별 (5거래일 종가 수익률)");
  for (const s of SWING_STRATEGIES) {
    const a = byStrat.get(s.key);
    console.log(`  ${s.label.padEnd(14)} n=${String(a.length).padStart(4)} 평균 ${f2(avg(a))}% 수익비율 ${a.length ? win(a).toFixed(1) : "-"}% (전체 대비 ${f2(a.length && base != null ? avg(a) - base : null)})`);
  }
  console.log("===== 합의도별");
  for (const c of [...byCons.keys()].sort()) {
    const a = byCons.get(c);
    console.log(`  ${c}개${c === 5 ? "+" : ""}: n=${a.length} 평균 ${f2(avg(a))}% 수익비율 ${win(a).toFixed(1)}%`);
  }
  const tr = top.map((t) => t.ret);
  console.log(`===== 상위 5 종합: n=${tr.length} 평균 ${f2(avg(tr))}% 수익비율 ${win(tr)?.toFixed(1)}% · 평균 최고 ${f2(avg(top.map((t) => t.max)))} 최저 ${f2(avg(top.map((t) => t.min)))}`);
  console.log(`===== 상위 5 거래일 평균이 플러스인 날: ${daily.filter((d) => d.avg > 0).length}/${daily.filter((d) => d.avg != null).length}`);
}

main().catch((e) => {
  console.error("[lab] 실패", e);
  process.exit(1);
});
