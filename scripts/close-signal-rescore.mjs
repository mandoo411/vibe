#!/usr/bin/env node
/**
 * 종가시그널 "옛 채점이었다면?" 비교 — 2026-10-07 신설(시우: "예전처럼 했으면 어제 어떤 종목이 나왔지?").
 *
 * 저장된 1520 스냅샷(Supabase trade_signal_intraday, 후보 400종목)을 **지금 채점**과 **옛 채점(git ref)**으로
 * 각각 다시 돌려 상위 N을 나란히 보여 주고, KIS 일봉으로 선정일 종가 → 다음 날 시가/종가 수익률을 붙인다.
 * 읽기 전용 — 아무것도 저장하지 않는다. 결과는 Actions 로그(그리고 Job Summary 표)로만 본다.
 *
 * 옛 채점 코드는 워크플로가 `git archive <ref> lib`로 RESCORE_OLD_DIRS에 풀어 준다(ref마다 한 폴더).
 * 자기학습 가중치(data/close-signal-weights.json)는 지금 것을 같이 복사해 쓴다.
 *
 * env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KIS_*,
 *      RESCORE_DATE(YYYY-MM-DD, 비우면 직전 거래일), RESCORE_LIMIT(기본 5),
 *      RESCORE_OLD_DIRS="라벨=경로,라벨=경로"
 */
import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const cal = require("../lib/krx-calendar.js");
const { fetchChartCandles } = require("../lib/kis-indicators.js");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const LIMIT = Number(process.env.RESCORE_LIMIT || 5);
const DATE = process.env.RESCORE_DATE || cal.prevTradingDay(cal.seoulYmd());
const NEXT = cal.nextTradingDay(DATE);

const variants = [{ label: "현재 채점", dir: path.resolve("lib") }];
for (const part of String(process.env.RESCORE_OLD_DIRS || "").split(",").filter(Boolean)) {
  const [label, dir] = part.split("=");
  variants.push({ label, dir: path.resolve(dir) });
}

const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? ((a / b - 1) * 100) : null);
const fmt = (v) => (v == null ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

const bars = new Map();
async function barsOf(code) {
  if (bars.has(code)) return bars.get(code);
  let m = new Map();
  try { m = new Map(((await fetchChartCandles(code, "D", 10)) || []).map((c) => [c.time, c])); }
  catch (e) { console.warn(`[rescore] ${code} 일봉 실패: ${e.message}`); }
  bars.set(code, m);
  await new Promise((r) => setTimeout(r, 120));
  return m;
}

async function main() {
  const q = `trade_signal_intraday?as_of_date=eq.${DATE}&slot=eq.1520&select=payload`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
  const rows = await res.json();
  const payload = rows[0] && rows[0].payload;
  if (!payload || !Array.isArray(payload.stocks)) throw new Error(`${DATE} 1520 스냅샷 없음`);
  console.log(`[rescore] ${DATE} 1520 스냅샷 ${payload.stocks.length}종목 · 결과일 ${NEXT}`);

  const md = [`## 종가시그널 채점 비교 — 선정일 ${DATE} → 결과일 ${NEXT}`, ""];
  const live = (payload.closeBetting && (payload.closeBetting.ranked || payload.closeBetting.picks)) || [];
  if (live.length) md.push(`실제 화면에 나간 5종목: ${live.slice(0, 5).map((r) => r.name).join(", ")}`, "");

  for (const v of variants) {
    const { rankCloseBetting } = require(path.join(v.dir, "close-betting-score.js"));
    const { ranked } = rankCloseBetting(JSON.parse(JSON.stringify(payload.stocks)), LIMIT);
    md.push(`### ${v.label}`, "", "| 순위 | 종목 | 선정일 등락 | 점수 | 기법 | 다음날 시가 | 다음날 종가(장중이면 현재가) |", "|---|---|---|---|---|---|---|");
    const opens = [];
    const closes = [];
    for (const r of ranked) {
      const b = await barsOf(r.code);
      const d0 = b.get(DATE);
      const d1 = b.get(NEXT);
      const o = d0 && d1 ? pct(d1.open, d0.close) : null;
      const c = d0 && d1 ? pct(d1.close, d0.close) : null;
      if (o != null) opens.push(o);
      if (c != null) closes.push(c);
      const strat = (r.strategies || r.matched || []).map((s) => (typeof s === "string" ? s : s.name || s.id)).join("·");
      md.push(`| ${r.rank} | ${r.name}(${r.code}) | ${fmt(r.changePct)} | ${Number(r.score).toFixed(1)} | ${strat || "-"} | ${fmt(o)} | ${fmt(c)} |`);
    }
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    md.push("", `평균: 다음날 시가 ${fmt(avg(opens))} · 종가 ${fmt(avg(closes))}`, "");
  }
  const out = md.join("\n");
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
