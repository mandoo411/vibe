#!/usr/bin/env node
/**
 * 종가베팅 랭킹 사후 기록 — 2026-09-11 신설.
 *
 * 왜 이게 랭킹 자체보다 중요한가: lib/close-betting-score.js의 배점은 공개 연구와 실전
 * 통설로 세운 **추정치**다. 실제로 익일 시가가 어떻게 됐는지를 매일 남겨야 팩터별
 * 적중률을 재고 배점을 고칠 수 있다. 이 기록이 없으면 그냥 또 하나의 조건검색기다.
 *
 * 하는 일: 직전 거래일 1520 슬롯의 상위 10종목을 읽어, 오늘 시가·현재가로
 *   시가수익률 = (오늘 시가 − 어제 종가) / 어제 종가
 * 를 계산해 Supabase에 남긴다. 전략의 실제 청산가가 시가라 이게 주 지표다.
 *
 * 저장 위치: 새 테이블을 만들지 않고 `trade_signal_intraday`에 slot="review" 행으로
 * 넣는다. as_of_date는 **랭킹이 나온 날**이라 원본 행과 같은 날짜로 짝이 맞는다.
 * (DDL 없이 굴러가는 게 우선이다. 건수가 쌓이면 전용 테이블로 옮기면 된다.)
 *
 * 실행: 거래일 09:10 KST. 필수 env는 intraday-close-scan.mjs와 같다.
 * 선택 env: REVIEW_TARGET_DATE(YYYY-MM-DD, 특정 날짜 랭킹을 다시 채점), REVIEW_DRY_RUN=1
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fetchMarketSnapshot } = require("../lib/kis-indicators.js");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY_RUN = process.env.REVIEW_DRY_RUN === "1";
const TARGET_DATE = String(process.env.REVIEW_TARGET_DATE || "").trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seoulYmd = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 10000) / 100 : null);

function requireEnv() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음");
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

/** 채점 대상 랭킹을 찾는다. 오늘 날짜 랭킹은 아직 결과가 없으므로 제외한다. */
async function loadRanking(today) {
  const filter = TARGET_DATE
    ? `as_of_date=eq.${TARGET_DATE}`
    : `as_of_date=lt.${today}`;
  const res = await sb(
    `trade_signal_intraday?slot=eq.1520&${filter}&order=as_of_date.desc&limit=1&select=as_of_date,payload`,
    { method: "GET" }
  );
  const rows = await res.json();
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  const ranked = row && row.payload && row.payload.closeBetting && row.payload.closeBetting.ranked;
  if (!Array.isArray(ranked) || !ranked.length) return null;
  return { asOfDate: row.as_of_date, ranked };
}

async function main() {
  requireEnv();
  const today = seoulYmd();
  const target = await loadRanking(today);
  if (!target) {
    console.log("::notice::채점할 종가베팅 랭킹이 없습니다 — 건너뜁니다.");
    return;
  }
  if (target.asOfDate === today) {
    console.log(`::notice::${today} 랭킹은 아직 결과가 나오지 않았습니다 — 건너뜁니다.`);
    return;
  }
  console.log(`[review] ${target.asOfDate} 랭킹 ${target.ranked.length}종목 → ${today} 시가 기준 채점`);

  const results = [];
  for (const r of target.ranked) {
    if (!r.code || r.close == null) continue;
    let m = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      m = await fetchMarketSnapshot(r.code);
      if (m && m.open != null) break;
      await sleep(500 * (attempt + 1));
    }
    await sleep(150);
    // 시가를 못 받으면 지어내지 않고 null로 남긴다 — 빈 값이 잘못된 값보다 낫다.
    results.push({
      rank: r.rank,
      code: r.code,
      name: r.name,
      score: r.score,
      prevClose: r.close,
      open: m ? m.open : null,
      openReturnPct: m && m.open != null ? pct(m.open, r.close) : null,
      priceAtReview: m ? m.close : null,
      reviewReturnPct: m && m.close != null ? pct(m.close, r.close) : null,
    });
  }

  const filled = results.filter((x) => x.openReturnPct != null);
  const avg = filled.length
    ? Math.round((filled.reduce((a, x) => a + x.openReturnPct, 0) / filled.length) * 100) / 100
    : null;
  const winRate = filled.length
    ? Math.round((filled.filter((x) => x.openReturnPct > 0).length / filled.length) * 1000) / 10
    : null;
  const top3 = filled.filter((x) => x.rank <= 3);
  const avgTop3 = top3.length
    ? Math.round((top3.reduce((a, x) => a + x.openReturnPct, 0) / top3.length) * 100) / 100
    : null;

  const summary = { measured: filled.length, avgOpenReturnPct: avg, winRatePct: winRate, avgTop3OpenReturnPct: avgTop3 };
  console.log(
    `[review] 시가 평균 ${avg == null ? "-" : avg + "%"} · 승률 ${winRate == null ? "-" : winRate + "%"} · ` +
      `상위3 평균 ${avgTop3 == null ? "-" : avgTop3 + "%"} (${filled.length}/${results.length}종목 측정)`
  );
  for (const x of results) {
    console.log(`  ${String(x.rank).padStart(2)}. ${x.name} ${x.score}점 → 시가 ${x.openReturnPct == null ? "-" : (x.openReturnPct > 0 ? "+" : "") + x.openReturnPct + "%"}`);
  }

  if (DRY_RUN) {
    console.log("[review] DRY_RUN — 저장 생략");
    return;
  }
  await sb("trade_signal_intraday", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      {
        as_of_date: target.asOfDate,
        slot: "review",
        scanned_at: new Date().toISOString(),
        count: results.length,
        payload: { reviewDate: today, summary, results },
      },
    ]),
  });
  console.log("[review] Supabase 저장 완료");
}

main().catch((error) => {
  console.error("[review] 실패", error);
  process.exit(1);
});
