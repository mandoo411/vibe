#!/usr/bin/env node
/**
 * AI 종목분석 예측 자동 채점 — 2026-09-26 신설.
 * analysis_reports(국내 종목)의 기준 계획(진입·목표·손절)을 실제 일봉으로 따라가 결과를 적는다.
 * 규칙은 lib/ai-report-grade.js 한 곳에만 있다(화면 설명과 같다).
 *
 * 대상: outcome이 비었거나 아직 끝나지 않은(open/wait) 국내 리포트, 최근 60일.
 * 필수 env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KIS_ACCESS_TOKEN, KIS_APP_KEY, KIS_APP_SECRET
 * 선택 env: GRADE_DRY_RUN=1 (계산만)
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fetchChartCandles } = require("../lib/kis-indicators.js");
const { gradeReport } = require("../lib/ai-report-grade.js");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY_RUN = process.env.GRADE_DRY_RUN === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seoulYmd = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(d);

async function sb(pathAndQuery, init) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      ...(init && init.headers),
    },
  });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE env 없음");
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const res = await sb(
    `analysis_reports?created_at=gte.${encodeURIComponent(since)}&market=in.(KR,KOSPI,KOSDAQ)` +
      `&or=(outcome.is.null,outcome.in.(open,wait))&order=created_at.asc&limit=500` +
      `&select=id,created_at,stock_code,stock_name,price_at_report,entry_price,target_price,stop_loss`,
    { method: "GET" }
  );
  const rows = await res.json();
  console.log(`[grade] 대상 ${rows.length}건`);
  const byCode = new Map();
  for (const r of rows) {
    const code = String(r.stock_code || "").trim();
    if (!/^[0-9A-Z]{6}$/.test(code)) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({ ...r, report_date: seoulYmd(new Date(r.created_at)) });
  }

  const counts = {};
  for (const [code, list] of byCode) {
    let bars = null;
    try {
      bars = await fetchChartCandles(code, "D", 90);
    } catch (e) {
      console.warn(`[grade] ${code} 일봉 실패: ${e.message}`);
      continue;
    }
    await sleep(120);
    for (const r of list) {
      const g = gradeReport(r, bars);
      counts[g.outcome] = (counts[g.outcome] || 0) + 1;
      const patch = {
        outcome: g.outcome,
        outcome_date: g.outcome_date || null,
        outcome_price: g.outcome_price ?? null,
        outcome_return_pct: g.outcome_return_pct ?? null,
        entry_date: g.entry_date || null,
        ret5_pct: g.ret5_pct,
        ret20_pct: g.ret20_pct,
        bars_after: g.bars_after,
        graded_at: new Date().toISOString(),
      };
      console.log(`[grade] ${r.report_date} ${r.stock_name}(${code}) → ${g.outcome} ${g.outcome_return_pct ?? ""}`);
      if (!DRY_RUN) {
        await sb(`analysis_reports?id=eq.${r.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      }
    }
  }
  console.log("[grade] 결과", JSON.stringify(counts));
}

main().catch((e) => {
  console.error("[grade] 실패", e);
  process.exit(1);
});
