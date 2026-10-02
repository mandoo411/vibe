#!/usr/bin/env node
/**
 * 1주 스윙 시그널 추적 — 2026-10-02 신설.
 *
 * 규칙: 선정일 15:20 가격에 샀다고 가정 → **5거래일 뒤 종가**가 결과(예: 금요일 선정 → 다음 주 금요일 종가).
 * 그 사이 매 거래일 종가를 track에 쌓아 화면이 "지금 몇 % 인지"를 보여줄 수 있게 한다.
 *
 * 매 거래일 15:45(close-betting-review.yml의 phase=close 단계 뒤)에 돈다. 하는 일:
 *   1) 1520 스캔 중 swing_signal_results에 아직 행이 없는 날을 찾아 행을 만든다.
 *      스캔 payload에 swing 랭킹이 있으면 그대로(live), 없으면(9/14~10/1, 기능 신설 전)
 *      저장된 400종목 스냅샷을 lib/swing-signal.js로 다시 채점해 만든다(backfill — 화면에 표시).
 *   2) status=tracking인 행마다 KIS 일봉으로 선정 다음 날부터 오늘(또는 목표일)까지 종가를 채우고,
 *      목표일 종가가 확정되면 status=done.
 * 값이 없으면 지어내지 않는다(그날 칸은 비워 둔다).
 *
 * env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KIS_* · SWING_FROM(기본 2026-09-14) · SWING_DRY_RUN=1
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fetchChartCandles } = require("../lib/kis-indicators.js");
const { rankSwing } = require("../lib/swing-signal.js");
const krx = require("../lib/krx-calendar.js");
const { extRanks } = require("../lib/rank-ext.js");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const FROM = process.env.SWING_FROM || "2026-09-14";
const DRY = process.env.SWING_DRY_RUN === "1";
const HOLD = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 10000) / 100 : null);
const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null);

async function sb(q, init) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", ...(init && init.headers) },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

function tradingDaysAfter(ymd, n) {
  const out = [];
  let d = ymd;
  for (let i = 0; i < n; i++) {
    d = krx.nextTradingDay(d);
    out.push(d);
  }
  return out;
}

function hmNow() {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false })
      .format(new Date())
      .replace(":", "")
  );
}

const barCache = new Map();
async function bars(code) {
  if (barCache.has(code)) return barCache.get(code);
  let m = new Map();
  for (let a = 0; a < 3; a++) {
    try {
      const c = await fetchChartCandles(code, "D", 30);
      m = new Map((c || []).map((b) => [String(b.time).slice(0, 10), b]));
      break;
    } catch (e) {
      await sleep(700 * (a + 1));
    }
  }
  barCache.set(code, m);
  await sleep(110);
  return m;
}

function pickRow(p) {
  return {
    rank: p.rank,
    code: p.code,
    name: p.name,
    market: p.market || null,
    score: p.score,
    consensus: p.consensus,
    strategies: (p.strategies || []).map((s) => (typeof s === "string" ? s : s.label)),
    buyPrice: p.close,
    track: [],
    lastClose: null,
    lastReturnPct: null,
    maxHighPct: null,
    minLowPct: null,
    finalClose: null,
    finalReturnPct: null,
  };
}

function summarize(picks, done) {
  const key = done ? "finalReturnPct" : "lastReturnPct";
  const vals = picks.filter((p) => p[key] != null);
  const sorted = vals.slice().sort((a, b) => b[key] - a[key]);
  return {
    picks: picks.length,
    measured: vals.length,
    avgReturnPct: avg(vals.map((p) => p[key])),
    wins: vals.filter((p) => p[key] > 0).length,
    avgMaxHighPct: avg(picks.filter((p) => p.maxHighPct != null).map((p) => p.maxHighPct)),
    avgMinLowPct: avg(picks.filter((p) => p.minLowPct != null).map((p) => p.minLowPct)),
    daysElapsed: picks.reduce((m, p) => Math.max(m, (p.track || []).length), 0),
    best: sorted.length ? { name: sorted[0].name, code: sorted[0].code, returnPct: sorted[0][key] } : null,
    worst: sorted.length ? { name: sorted[sorted.length - 1].name, code: sorted[sorted.length - 1].code, returnPct: sorted[sorted.length - 1][key] } : null,
  };
}

/** 한 종목의 5거래일 추적 — 공개 5종목·관리자용 6~20위 공용 */
async function trackPick(p0, days, target, lastBarDay) {
  const p = { ...p0 };
  const m = await bars(p.code);
  const track = [];
  let hi = null;
  let lo = null;
  for (const d of days) {
    if (d > lastBarDay) break;
    const b = m.get(d);
    if (!b) continue;
    track.push({ date: d, close: b.close, returnPct: pct(b.close, p.buyPrice) });
    hi = hi == null ? b.high : Math.max(hi, b.high);
    lo = lo == null ? b.low : Math.min(lo, b.low);
  }
  p.track = track;
  const last = track[track.length - 1];
  p.lastClose = last ? last.close : null;
  p.lastReturnPct = last ? last.returnPct : null;
  p.maxHighPct = hi != null ? pct(hi, p.buyPrice) : null;
  p.minLowPct = lo != null ? pct(lo, p.buyPrice) : null;
  const fin = track.find((t) => t.date === target);
  p.finalClose = fin ? fin.close : null;
  p.finalReturnPct = fin ? fin.returnPct : null;
  return p;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE env 없음");
  const phase = String(process.env.REVIEW_PHASE || "auto").toLowerCase();
  if (phase === "open" || (phase === "auto" && hmNow() < 1200)) {
    console.log("[swing] 아침(시가) 단계 — 스윙 추적은 15:45 마감 단계에서만 돈다");
    return;
  }
  const today = krx.seoulYmd();
  const closeConfirmed = krx.isTradingDay(today) ? hmNow() >= 1540 : true;
  // 오늘 종가를 쓸 수 있는 마지막 날짜
  const lastBarDay = closeConfirmed && krx.isTradingDay(today) ? today : krx.prevTradingDay(today);

  const existing = await (await sb("swing_signal_results?select=as_of_date,status,source,target_date,picks,summary,extra_picks&order=as_of_date.asc")).json();
  const have = new Map(existing.map((r) => [r.as_of_date, r]));

  // 1) 새 선정일 행 만들기
  const scans = await (
    await sb(`trade_signal_intraday?slot=eq.1520&as_of_date=gte.${FROM}&as_of_date=lte.${today}&order=as_of_date.asc&select=as_of_date,payload`)
  ).json();
  const toWrite = [];
  // 관리자 전용 6~20위 (2026-10-02): 스캔이 저장한 rankedExt, 없으면 저장된 후보 스냅샷으로 다시 채점
  const extOf = (payload, ranked) => {
    const sw = payload.swing || {};
    if (Array.isArray(sw.rankedExt)) return sw.rankedExt;
    try {
      return extRanks(rankSwing(payload.stocks || [], 20).ranked, ranked);
    } catch (e) {
      console.log(`::warning::스윙 6~20위 재채점 실패: ${e && e.message}`);
      return [];
    }
  };
  for (const scan of scans) {
    const asOf = scan.as_of_date;
    const old = have.get(asOf);
    if (old && !Array.isArray(old.extra_picks) && (old.picks || []).length) {
      old.extra_picks = extOf(scan.payload || {}, old.picks).map(pickRow);
      old._extNew = true;
    }
    if (have.has(asOf) || !krx.isTradingDay(asOf)) continue;
    const payload = scan.payload || {};
    let ranked = payload.swing && Array.isArray(payload.swing.ranked) ? payload.swing.ranked : null;
    let source = "live";
    if (!ranked || !ranked.length) {
      if (asOf >= today) continue; // 오늘 스캔인데 swing이 없으면 스캔 쪽 실패 — 지어내지 않는다
      ranked = rankSwing(payload.stocks || [], 5).ranked;
      source = "backfill";
    }
    if (!ranked.length) continue;
    const target = tradingDaysAfter(asOf, HOLD)[HOLD - 1];
    const row = { as_of_date: asOf, target_date: target, status: "tracking", source, pick_count: ranked.length, picks: ranked.map(pickRow), summary: {}, extra_picks: extOf(payload, ranked).map(pickRow) };
    have.set(asOf, row);
    console.log(`[swing] 새 선정 ${asOf} (${source}) → 목표일 ${target}: ${ranked.map((p) => p.name).join(", ")}`);
  }

  // 2) 추적 갱신
  const allFinal = (arr) => Array.isArray(arr) && arr.every((p) => p.finalReturnPct != null);
  for (const [asOf, row] of have) {
    const extTodo = Array.isArray(row.extra_picks) && row.extra_picks.length && !allFinal(row.extra_picks);
    if (row.status === "done") {
      // 공개 5종목은 확정 — 관리자용 6~20위만 아직 덜 채워졌으면 그것만 추적
      if (!extTodo && !row._extNew) continue;
      const days = tradingDaysAfter(asOf, HOLD);
      const target = days[HOLD - 1];
      const extra = [];
      for (const p0 of row.extra_picks || []) extra.push(await trackPick(p0, days, target, lastBarDay));
      toWrite.push({ ...row, extra_picks: extra });
      console.log(`[swing] ${asOf} 관리자용 6~20위 ${extra.length}종목 갱신`);
      continue;
    }
    if (asOf >= lastBarDay && asOf === today) {
      // 오늘 선정분 — 아직 다음 날이 없다. 행만 저장.
      toWrite.push(row);
      continue;
    }
    const days = tradingDaysAfter(asOf, HOLD);
    const target = days[HOLD - 1];
    const picks = [];
    for (const p0 of row.picks || []) picks.push(await trackPick(p0, days, target, lastBarDay));
    const extra = [];
    for (const p0 of row.extra_picks || []) extra.push(await trackPick(p0, days, target, lastBarDay));
    const done = target <= lastBarDay && picks.every((p) => p.finalReturnPct != null);
    const next = { ...row, target_date: target, picks, extra_picks: extra, status: done ? "done" : "tracking", summary: summarize(picks, done) };
    toWrite.push(next);
    const s = next.summary;
    console.log(`[swing] ${asOf} → ${target} ${done ? "확정" : `추적 ${s.daysElapsed}/${HOLD}일`} 평균 ${s.avgReturnPct ?? "-"}% (${s.wins}/${s.measured} 수익)`);
  }

  if (DRY) {
    console.log(`[swing] DRY_RUN — ${toWrite.length}행 저장 생략`);
    return;
  }
  if (!toWrite.length) {
    console.log("[swing] 갱신할 행 없음");
    return;
  }
  const now = new Date().toISOString();
  await sb("swing_signal_results?on_conflict=as_of_date", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(
      toWrite.map((r) => ({
        as_of_date: r.as_of_date,
        target_date: r.target_date,
        status: r.status,
        source: r.source,
        pick_count: (r.picks || []).length,
        picks: r.picks,
        summary: r.summary || {},
        extra_picks: Array.isArray(r.extra_picks) ? r.extra_picks : null,
        updated_at: now,
      }))
    ),
  });
  console.log(`[swing] ${toWrite.length}행 저장 완료`);
}

main().catch((e) => {
  console.error("[swing] 실패", e);
  process.exit(1);
});
