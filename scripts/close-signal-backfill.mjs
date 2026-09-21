#!/usr/bin/env node
/**
 * 종가시그널 성과 기록 백필 — 2026-09-21 신설.
 *
 * 왜: 성과 달력을 만들었는데 첫날은 칸이 전부 비어 있다. Supabase `trade_signal_intraday`의
 * 1520 슬롯에는 지난 거래일의 후보 400종목 스냅샷이 그대로 남아 있으므로, 같은 채점 로직으로
 * 그날의 상위 5종목을 다시 뽑고 **KIS 일봉으로 실제 익일 시가·고가·저가·종가**를 받아
 * 결과를 채울 수 있다.
 *
 * ⚠️ 이렇게 채운 행은 `source='backfill'`로 남긴다. 그날 실제로 화면에 나갔던 선정이 아니라
 * 저장된 스냅샷으로 사후 재구성한 검증 결과이기 때문이다. 화면도 이 둘을 구분해 표시한다.
 * 이미 `source='live'`로 기록된 날짜는 건드리지 않는다.
 *
 * 필수 env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KIS_ACCESS_TOKEN, KIS_APP_KEY, KIS_APP_SECRET
 * 선택 env: BACKFILL_DRY_RUN=1, BACKFILL_LIMIT_DAYS(기본 40)
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fetchChartCandles } = require("../lib/kis-indicators.js");
const { buildPickResult, buildSummary } = require("../lib/close-signal-results.js");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY_RUN = process.env.BACKFILL_DRY_RUN === "1";
const LIMIT_DAYS = Number(process.env.BACKFILL_LIMIT_DAYS || 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 종목 일봉을 한 번만 받아 날짜별로 꽂아 쓴다(종목이 여러 날에 걸쳐 재등장하므로). */
const barCache = new Map();
async function loadBars(code) {
  if (barCache.has(code)) return barCache.get(code);
  let map = new Map();
  try {
    const candles = await fetchChartCandles(code, "D", 60);
    map = new Map((candles || []).map((c) => [c.time, c]));
  } catch (error) {
    console.warn(`[backfill] ${code} 일봉 조회 실패: ${error.message}`);
  }
  barCache.set(code, map);
  await sleep(150);
  return map;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음");

  const scanRes = await sb(
    `trade_signal_intraday?slot=eq.1520&order=as_of_date.asc&limit=${LIMIT_DAYS}&select=as_of_date,payload`,
    { method: "GET" }
  );
  const scans = await scanRes.json();
  if (!Array.isArray(scans) || scans.length < 2) {
    console.log("::notice::백필할 스캔이 부족합니다(2거래일 이상 필요).");
    return;
  }

  const existRes = await sb("close_signal_results?select=as_of_date,source,phase", { method: "GET" });
  const exist = new Map((await existRes.json()).map((r) => [r.as_of_date, r]));

  const written = [];
  for (let i = 0; i < scans.length - 1; i++) {
    const day = scans[i];
    const nextDate = scans[i + 1].as_of_date; // 실제 다음 거래일(스캔이 돈 날) — 휴장일을 자동으로 건너뛴다
    const prev = exist.get(day.as_of_date);
    if (prev && prev.source === "live" && prev.phase === "close") {
      console.log(`[backfill] ${day.as_of_date} — 실기록이 이미 있어 건너뜀`);
      continue;
    }
    const ranked = ((day.payload || {}).closeBetting || {}).ranked || [];
    if (!ranked.length) {
      console.log(`[backfill] ${day.as_of_date} — 랭킹 없음, 건너뜀`);
      continue;
    }

    const picks = [];
    for (const r of ranked) {
      if (!r.code || r.close == null) continue;
      const bars = await loadBars(r.code);
      picks.push(buildPickResult(r, bars.get(nextDate) || null, true));
    }
    const summary = buildSummary(picks);
    console.log(
      `[backfill] ${day.as_of_date} → ${nextDate} · ${picks.length}종목 · ` +
        `시가 ${summary.avgOpenReturnPct ?? "-"}%(승 ${summary.openWinRatePct ?? "-"}%) ` +
        `종가 ${summary.avgCloseReturnPct ?? "-"}%(승 ${summary.closeWinRatePct ?? "-"}%)`
    );
    picks.forEach((p) =>
      console.log(`    ${p.rank}. ${p.name} 매수 ${p.buyPrice} → 시 ${p.openReturnPct ?? "-"}% / 종 ${p.closeReturnPct ?? "-"}%`)
    );

    if (!DRY_RUN) {
      await sb("close_signal_results?on_conflict=as_of_date", {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([
          {
            as_of_date: day.as_of_date,
            review_date: nextDate,
            phase: "close",
            source: "backfill",
            pick_count: picks.length,
            picks,
            summary,
            updated_at: new Date().toISOString(),
          },
        ]),
      });
    }
    written.push(day.as_of_date);
  }
  console.log(`[backfill] 완료 — ${written.length}일 기록${DRY_RUN ? " (DRY_RUN, 저장 생략)" : ""}`);
}

main().catch((error) => {
  console.error("[backfill] 실패", error);
  process.exit(1);
});
