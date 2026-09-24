#!/usr/bin/env node
/**
 * 종가시그널 성과 추적 — 2026-09-11 신설, 2026-09-21 전면 개편.
 * (파일명·워크플로명은 일부러 close-betting 그대로 둔다. pg_cron job과 edge function
 *  ALLOWED_WORKFLOWS가 이 이름에 묶여 있어, 바꾸면 400으로 조용히 끊긴다. 5장 개명 규칙.)
 *
 * 하는 일: 직전 거래일 15:20 슬롯에서 선정된 상위 종목을, **선정일 종가에 샀다고 가정**하고
 * 다음 거래일에 실제로 어떻게 됐는지 기록한다.
 *
 *   매수가 = 선정일 종가
 *   시가 수익률 = (익일 시가 − 매수가) / 매수가      ← 09:00 시초가에 팔았을 때
 *   종가 수익률 = (익일 종가 − 매수가) / 매수가      ← 하루 들고 마감에 팔았을 때
 *   최고/최저   = 익일 고가·저가 기준                ← 하루 동안 어디까지 갔는지
 *
 * 2단계로 돈다(같은 워크플로, inputs.phase로 구분):
 *   phase=open  (09:10 KST) — 시가만 확정. 화면에 "오늘 시초가 기준"으로 바로 보여주기 위함.
 *   phase=close (15:45 KST) — 장 마감 후 시가·고가·저가·종가까지 확정. 이게 최종 기록이다.
 *
 * 저장: 전용 테이블 `close_signal_results` (as_of_date = 선정일, 하루 한 행 upsert).
 * v1은 trade_signal_intraday에 slot="review" 행으로 넣었는데, 달력·누적 통계를 만들려면
 * 날짜별로 바로 긁을 수 있어야 해서 전용 테이블로 옮겼다.
 *
 * 필수 env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KIS_ACCESS_TOKEN, KIS_APP_KEY, KIS_APP_SECRET
 * 선택 env: REVIEW_PHASE(open|close|auto, 기본 auto) · REVIEW_TARGET_DATE(YYYY-MM-DD) · REVIEW_DRY_RUN=1
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fetchMarketSnapshot } = require("../lib/kis-indicators.js");
const { buildPickResult, buildSummary } = require("../lib/close-signal-results.js");
const krx = require("../lib/krx-calendar.js");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY_RUN = process.env.REVIEW_DRY_RUN === "1";
const TARGET_DATE = String(process.env.REVIEW_TARGET_DATE || "").trim();
const PHASE_ENV = String(process.env.REVIEW_PHASE || "auto").trim().toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seoulYmd = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
const seoulHour = () =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false }).format(new Date()));

function resolvePhase() {
  if (PHASE_ENV === "open" || PHASE_ENV === "close") return PHASE_ENV;
  return seoulHour() < 12 ? "open" : "close";
}

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

/** 채점 대상 랭킹. 오늘 날짜 랭킹은 아직 결과가 없으므로 제외한다.
 *  2026-09-24: 최신 1행만 보던 것을 "종목이 들어 있는 가장 최근 행"으로 바꿨다 — 비어 있는 행
 *  (휴장일 헛스캔 등)이 맨 위에 있으면 진짜 대상 랭킹을 못 찾고 통째로 건너뛰었다. */
async function loadRanking(today) {
  const filter = TARGET_DATE ? `as_of_date=eq.${TARGET_DATE}` : `as_of_date=lt.${today}`;
  const res = await sb(
    `trade_signal_intraday?slot=eq.1520&${filter}&order=as_of_date.desc&limit=5&select=as_of_date,payload`,
    { method: "GET" }
  );
  const rows = await res.json();
  for (const row of Array.isArray(rows) ? rows : []) {
    const ranked = row && row.payload && row.payload.closeBetting && row.payload.closeBetting.ranked;
    if (Array.isArray(ranked) && ranked.length) return { asOfDate: row.as_of_date, ranked };
  }
  return null;
}

/** 종목 하나의 익일 시세. 못 받으면 지어내지 않고 null을 남긴다. */
async function fetchDayBar(code) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const m = await fetchMarketSnapshot(code);
    if (m && m.open != null) return m;
    await sleep(500 * (attempt + 1));
  }
  return null;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음");
  const today = seoulYmd();
  const phase = resolvePhase();

  // 2026-09-24 사고: 추석(휴장)에 돌아서 KIS가 돌려준 9/23 시세를 "9/24 결과"로 저장했다.
  // 휴장일엔 익일 시세가 존재하지 않는다 — 워크플로 가드와 별개로 여기서도 막는다.
  const closed = krx.closedReason(today);
  if (closed) {
    console.log(`::notice::${today}는 휴장(${closed}) — 결과는 다음 거래일 ${krx.nextTradingDay(today)}에 기록됩니다.`);
    return;
  }

  const target = await loadRanking(today);
  if (!target) {
    console.log("::notice::채점할 종가시그널 랭킹이 없습니다 — 건너뜁니다.");
    return;
  }
  if (target.asOfDate === today) {
    console.log(`::notice::${today} 랭킹은 아직 결과가 나오지 않았습니다 — 건너뜁니다.`);
    return;
  }
  // 결과일은 반드시 "선정일 다음 거래일"이어야 한다. 그 사이 거래일이 끼어 있으면(스캔 실패 등)
  // 오늘 시세는 그 랭킹의 익일 결과가 아니다 — 지어내지 않고 건너뛴다.
  const expected = krx.nextTradingDay(target.asOfDate);
  if (expected !== today) {
    console.log(`::warning::${target.asOfDate} 선정분의 결과일은 ${expected}인데 오늘은 ${today} — 기록하지 않습니다.`);
    return;
  }
  console.log(`[review] phase=${phase} · ${target.asOfDate} 선정 ${target.ranked.length}종목 → ${today} 결과 측정`);

  const picks = [];
  for (const r of target.ranked) {
    if (!r.code || r.close == null) continue;
    const m = await fetchDayBar(r.code);
    await sleep(150);
    picks.push(buildPickResult(r, m, phase === "close"));
  }

  const summary = buildSummary(picks);
  console.log(
    `[review] 시가 평균 ${summary.avgOpenReturnPct ?? "-"}% (승률 ${summary.openWinRatePct ?? "-"}%) · ` +
      `종가 평균 ${summary.avgCloseReturnPct ?? "-"}% (승률 ${summary.closeWinRatePct ?? "-"}%)`
  );
  for (const p of picks) {
    const o = p.openReturnPct == null ? "-" : `${p.openReturnPct > 0 ? "+" : ""}${p.openReturnPct}%`;
    const c = p.closeReturnPct == null ? "-" : `${p.closeReturnPct > 0 ? "+" : ""}${p.closeReturnPct}%`;
    console.log(`  ${String(p.rank).padStart(2)}. ${p.name} ${p.score}점 → 시가 ${o} / 종가 ${c}`);
  }

  if (DRY_RUN) {
    console.log("[review] DRY_RUN — 저장 생략");
    return;
  }
  await sb("close_signal_results?on_conflict=as_of_date", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      {
        as_of_date: target.asOfDate,
        review_date: today,
        phase,
        source: "live",
        pick_count: picks.length,
        picks,
        summary,
        updated_at: new Date().toISOString(),
      },
    ]),
  });
  console.log(`[review] close_signal_results 저장 완료 (${target.asOfDate}, phase=${phase})`);
}

main().catch((error) => {
  console.error("[review] 실패", error);
  process.exit(1);
});
