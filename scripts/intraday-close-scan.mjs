#!/usr/bin/env node
/**
 * 장중(장 막판) 종가 스캔 — 2026-09-08 신설.
 *
 * 왜: 즉시검색이 읽는 전종목 캐시는 만드는 데 80분이 걸려 하루 1회밖에 못 돈다. 그래서
 * 장중에 검색하면 전날 종가가 나오고, 15:30 마감 직후 NXT 시간외로 종가매수를 하려는
 * "종가매매"에는 쓸 수 없었다. 이 스크립트는 전종목을 다시 계산하는 대신
 *   ① 거래대금 상위 후보만 추리고 ② 종목당 시세 1회 + 수급 1회만 호출해서
 *   ③ 전일 스냅샷에 오늘 봉 하나를 얹는(lib/intraday-snapshot.js) 방식으로
 * 400종목을 4~5분에 끝낸다.
 *
 * 결과는 git이 아니라 Supabase(trade_signal_intraday)에 넣는다. data/ 커밋은 Vercel
 * ignoreCommand 때문에 별도 배포가 필요해 2분이 더 들고 Hobby 배포 한도까지 깎는데,
 * 이 작업은 하루 2번 도는 데다 몇 분 안에 화면에 떠야 하기 때문이다.
 *
 * 필수 env: KIS_ACCESS_TOKEN, KIS_APP_KEY, KIS_APP_SECRET, SUPABASE_URL,
 *           SUPABASE_SERVICE_ROLE_KEY (KIS_BASE_URL 선택)
 * 선택 env: INTRADAY_SLOT(기본 자동판정), INTRADAY_LIMIT(후보 수, 기본 400),
 *           INTRADAY_GAP_MS(호출 간격, 기본 120), INTRADAY_DRY_RUN=1(Supabase 저장 생략)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fetchMarketSnapshot, fetchInvestorFlow } = require("../lib/kis-indicators.js");
const { buildIntradaySnapshot } = require("../lib/intraday-snapshot.js");
const { rankCloseBetting } = require("../lib/close-betting-score.js");

const LIMIT = Number(process.env.INTRADAY_LIMIT || 400);
/* 2026-09-09: 120 → 80ms. 400종목이면 종목당 sleep이 2회씩 들어가 순수 대기만 96초였다.
 * 실측(2026-09-09 새벽, 400종목) dispatch→Supabase 저장까지 4분 19초로 15:36 목표까지
 * 여유가 40초뿐이었는데, 그 측정은 KIS API가 한가한 새벽이라 장 마감 직후엔 더 느려진다.
 * 80ms면 대기가 64초로 줄어 32초를 벌고, 호출 속도는 초당 12.5회로 KIS 한도(20회) 안이다.
 * 후보 수를 줄이는 대신 이걸 먼저 조인 이유는 종목 커버리지를 깎지 않기 때문. */
const GAP_MS = Number(process.env.INTRADAY_GAP_MS || 80);
const DRY_RUN = process.env.INTRADAY_DRY_RUN === "1";
const MAX_RETRIES = 2;

const BASE_URL = (process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(/\/+$/, "");
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seoulYmd = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
const seoulHm = () =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

/* 슬롯 판정.
 *   "1430" — 15:00 이전. 진입 검토용 예비 스캔.
 *   "1520" — 15:00~15:29. **정규장 종가 매수를 위한 확정 스캔**(2026-09-11 신설).
 *   "1531" — 15:30 이후. 장 마감 후 확정치(시간외·복기용).
 * 1520을 새로 판 이유: 기존 1531은 이미 정규장이 끝난 뒤라 종가 매수를 할 수 없었다.
 * 종가베팅 랭킹은 이 1520 슬롯에서만 계산한다. */
function resolveSlot() {
  const explicit = String(process.env.INTRADAY_SLOT || "").trim();
  if (explicit) return explicit;
  const [h, m] = seoulHm().split(":").map(Number);
  const mins = h * 60 + m;
  if (mins < 15 * 60) return "1430";
  if (mins < 15 * 60 + 30) return "1520";
  return "1531";
}

/** 같은 날 앞선 슬롯의 종목별 종가 — 막판 강도(14:30 → 종가) 계산에 쓴다. */
async function fetchSlotCloses(asOfDate, slot) {
  if (!SUPABASE_URL || !SERVICE_KEY) return new Map();
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/trade_signal_intraday` +
      `?as_of_date=eq.${asOfDate}&slot=eq.${slot}&select=payload&limit=1`;
    const res = await fetch(url, { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } });
    if (!res.ok) return new Map();
    const rows = await res.json();
    const stocks = (rows && rows[0] && rows[0].payload && rows[0].payload.stocks) || [];
    return new Map(stocks.filter((r) => r && r.code && r.close != null).map((r) => [r.code, r.close]));
  } catch (error) {
    // 막판 강도는 있으면 좋은 보조 팩터다. 못 받아도 스캔 자체를 실패시키지 않는다
    // (close-betting-score가 값 없는 팩터를 분모에서 빼도록 만들어져 있다).
    console.warn(`[intraday] ${slot} 슬롯 조회 실패 — 막판 강도는 채점에서 제외: ${error.message}`);
    return new Map();
  }
}

/* ── KIS 거래대금 순위 ────────────────────────────────────────────────────────
 * FHPST01710000(volume-rank). fid_blng_cls_code=3이 거래금액순이다.
 * 한 번에 30건 안팎만 내려오므로 시장별로 호출해 합치고, 모자라는 만큼은 전일 캐시의
 * 거래대금 상위로 채운다(전일 상위권은 오늘도 상위권일 확률이 높아 보충용으로 충분하고,
 * 오늘 새로 터진 종목은 순위 API 쪽이 잡아준다). */
async function fetchTurnoverRank(marketCode, marketLabel, blngClsCode) {
  const url = new URL(`${BASE_URL}/uapi/domestic-stock/v1/quotations/volume-rank`);
  const params = {
    fid_cond_mrkt_div_code: "J",
    fid_cond_scr_div_code: "20171",
    fid_input_iscd: marketCode,
    fid_div_cls_code: "0",
    fid_blng_cls_code: String(blngClsCode), // 0=평균거래량 1=거래증가율 3=거래금액순
    fid_trgt_cls_code: "111111111",
    fid_trgt_exls_cls_code: "0000000000",
    fid_input_price_1: "",
    fid_input_price_2: "",
    fid_vol_cnt: "",
    fid_input_date_1: "",
  };
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${process.env.KIS_ACCESS_TOKEN}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: "FHPST01710000",
      custtype: "P",
    },
  });
  if (!res.ok) throw new Error(`volume-rank HTTP ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json.output) ? json.output : [];
  return list
    .map((row) => ({
      code: String(row.mksc_shrn_iscd || row.stck_shrn_iscd || "").trim(),
      name: String(row.hts_kor_isnm || "").trim(),
      market: marketLabel,
    }))
    .filter((r) => /^\d{6}$/.test(r.code));
}

/* 순위 API는 한 번에 30건 안팎만 내려준다(2026-09-08 실측: 코스피+코스닥 합쳐 59건).
 * 그래서 정렬 기준을 바꿔가며 여러 번 부른다 — 거래금액순만 보면 오늘 처음 터진 중소형주가
 * 상위 30위 밖에 있어 통째로 빠지는데, 거래증가율순이 바로 그런 종목을 잡아준다.
 * 호출 6회(3기준 × 2시장)면 후보가 150건 안팎으로 늘고 소요는 1초 남짓이다. */
const RANK_MODES = [
  ["3", "거래금액순"],
  ["1", "거래증가율순"],
  ["0", "평균거래량순"],
];

async function buildCandidates(cache) {
  const seen = new Map();
  for (const [blng, modeLabel] of RANK_MODES) {
    for (const [code, label] of [["0001", "KOSPI"], ["1001", "KOSDAQ"]]) {
      try {
        for (const r of await fetchTurnoverRank(code, label, blng)) {
          if (!seen.has(r.code)) seen.set(r.code, r);
        }
      } catch (e) {
        console.warn(`[intraday] 순위 조회 실패(${modeLabel}/${label}): ${e.message}`);
      }
      await sleep(GAP_MS);
    }
  }
  const fromRank = seen.size;

  const byValue = (cache.stocks || [])
    .slice()
    .sort((a, b) => (b.tradingValue || 0) - (a.tradingValue || 0));
  for (const row of byValue) {
    if (seen.size >= LIMIT) break;
    if (!seen.has(row.code)) seen.set(row.code, { code: row.code, name: row.name, market: row.market });
  }
  console.log(`[intraday] 후보 ${seen.size}개 (순위API ${fromRank}개 + 전일 거래대금 상위 보충)`);
  return [...seen.values()].slice(0, LIMIT);
}

async function scanOne(cand, prevSnapshot) {
  for (let attempt = 0; ; attempt++) {
    try {
      const market = await fetchMarketSnapshot(cand.code);
      await sleep(GAP_MS);
      const flow = await fetchInvestorFlow(cand.code);
      if (market.close == null) return null;
      const snapshot = buildIntradaySnapshot(prevSnapshot, market, flow);
      if (!snapshot) return null;
      const prevClose = prevSnapshot.closeCur;
      return {
        code: cand.code,
        name: cand.name,
        market: cand.market,
        close: market.close,
        changePct: prevClose ? Math.round(((market.close - prevClose) / prevClose) * 10000) / 100 : 0,
        tradingValue: market.tradingValueEok != null ? Math.round(market.tradingValueEok * 1e8) : null,
        marketCapEok: market.marketCapEok,
        tradingValueEok: market.tradingValueEok,
        snapshot,
      };
    } catch (error) {
      if (attempt >= MAX_RETRIES) {
        console.warn(`[intraday] ${cand.code} ${cand.name} 실패: ${error.message}`);
        return null;
      }
      await sleep(800 * (attempt + 1));
    }
  }
}

async function saveToSupabase(payload) {
  if (DRY_RUN) {
    console.log("[intraday] DRY_RUN — Supabase 저장 생략");
    return;
  }
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/trade_signal_intraday`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([payload]),
  });
  if (!res.ok) throw new Error(`Supabase 저장 실패 HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function main() {
  const slot = resolveSlot();
  const asOfDate = seoulYmd();
  const startedAt = Date.now();
  console.log(`[intraday] 시작 ${asOfDate} ${seoulHm()} KST · slot=${slot} · 목표 ${LIMIT}종목`);

  const cachePath = path.resolve("data/kr-screener-cache.json");
  const cache = JSON.parse(await fs.readFile(cachePath, "utf8"));
  const prevByCode = new Map((cache.stocks || []).map((r) => [r.code, r]));
  console.log(`[intraday] 전일 캐시 ${cache.asOfDate} · ${(cache.stocks || []).length}종목`);

  const candidates = await buildCandidates(cache);
  const stocks = [];
  let skippedNoBase = 0;
  let failed = 0;

  for (let idx = 0; idx < candidates.length; idx++) {
    const cand = candidates[idx];
    const prevRow = prevByCode.get(cand.code);
    // 전일 스냅샷이 없거나(신규 상장) 접힌 값(next)이 없는 구버전 캐시면 지어내지 않고 건너뛴다.
    if (!prevRow || !prevRow.snapshot || !prevRow.snapshot.next) {
      skippedNoBase += 1;
      continue;
    }
    if (!cand.name) cand.name = prevRow.name;
    if (!cand.market) cand.market = prevRow.market;
    const row = await scanOne(cand, prevRow.snapshot);
    if (row) stocks.push(row);
    else failed += 1;
    if ((idx + 1) % 100 === 0) {
      console.log(`[intraday] 진행 ${idx + 1}/${candidates.length} · 성공 ${stocks.length} · ${((Date.now() - startedAt) / 1000).toFixed(0)}초`);
    }
    await sleep(GAP_MS);
  }

  // 2026-09-09: 수급이 어느 영업일 확정치인지 요약해 둔다. 장중/마감 직후에는 KIS가 당일
  // 수급을 아직 집계하지 않아 직전 영업일 값이 오므로, 화면이 "수급은 N일 기준"이라고
  // 정확히 표기할 수 있어야 한다(신규 컬럼 없이 payload jsonb 안에 담는다).
  const flowDates = new Map();
  for (const row of stocks) {
    const d = row.snapshot && row.snapshot.flowAsOfDate;
    if (d) flowDates.set(d, (flowDates.get(d) || 0) + 1);
  }
  const flowAsOfDate =
    [...flowDates.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d)[0] || null;

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  /* ── 종가베팅 랭킹 (2026-09-11 신설) ────────────────────────────────────
   * 1520 슬롯(정규장 종가 매수 시점)에서만 계산한다. 1430은 후보가 아직 안 굳었고,
   * 1531은 이미 정규장이 끝나 매수를 못 하므로 랭킹을 내면 오해를 준다. */
  let closeBetting = null;
  if (slot === "1520") {
    /* try/catch가 반드시 있어야 한다: 이 시점에 이미 400종목을 4~5분간 긁어온 뒤라,
     * 채점에서 예외가 나면 payload 저장까지 통째로 날아가 그날 1520 슬롯 자체가 사라진다.
     * 랭킹은 스캔의 부가 산출물이지 스캔의 전제가 아니므로, 실패해도 스캔 결과는 저장한다.
     * (화면은 closeBetting이 없으면 "집계 전"으로 표시하니 빈 랭킹이 노출되지도 않는다.) */
    try {
      const earlyCloses = await fetchSlotCloses(asOfDate, "1430");
      for (const row of stocks) {
        const early = earlyCloses.get(row.code);
        row.lateStrengthPct =
          early && row.close != null ? Math.round(((row.close - early) / early) * 10000) / 100 : null;
      }
      const { ranked, stats } = rankCloseBetting(stocks, 10);
      closeBetting = {
        ranked,
        stats,
        lateStrengthBase: earlyCloses.size ? "1430" : null,
        scoredAt: new Date().toISOString(),
      };
      console.log(
        `[intraday] 종가베팅 랭킹 — 후보 ${stats.total} → 필터통과 ${stats.passed} → 상위 ${ranked.length}\n` +
          ranked.map((r) => `  ${r.rank}. ${r.name}(${r.code}) ${r.score}점 +${r.changePct}%`).join("\n")
      );
    } catch (error) {
      closeBetting = null;
      console.log(`::warning::종가베팅 채점 실패 — 스캔 결과는 그대로 저장합니다: ${error && error.message}`);
      console.error(error);
    }
  }

  const payload = {
    as_of_date: asOfDate,
    slot,
    scanned_at: new Date().toISOString(),
    base_as_of_date: cache.asOfDate || null,
    count: stocks.length,
    elapsed_sec: elapsedSec,
    payload: { stocks, flowAsOfDate, closeBetting },
  };
  console.log(
    `[intraday] 완료 — ${stocks.length}종목 (기준없음 ${skippedNoBase}, 실패 ${failed}) · ${elapsedSec}초 · ` +
      `수급기준 ${flowAsOfDate || "없음"} · 종료 ${seoulHm()} KST`
  );
  if (!stocks.length) {
    // 배포 첫날처럼 전종목 캐시가 아직 "접힌 값(snapshot.next)" 없이 만들어진 상태면
    // 기준 스냅샷이 없어 한 종목도 갱신할 수 없다. 이건 고장이 아니라 다음 밤 캐시
    // 빌드까지 기다리면 풀리는 상황이라, 빨간 실패로 알림을 울리는 대신 안내만 남긴다.
    if (skippedNoBase >= candidates.length * 0.9) {
      console.log(
        `::notice::전일 캐시에 장중 갱신용 기준값이 아직 없습니다(${skippedNoBase}/${candidates.length}). ` +
          "다음 kr-screener-cache 빌드 이후부터 정상 동작합니다."
      );
      return;
    }
    throw new Error("스캔 결과가 0종목 — 저장하지 않는다(빈 결과를 화면에 내보내지 않기 위함)");
  }
  await saveToSupabase(payload);
  if (!DRY_RUN) console.log("[intraday] Supabase 저장 완료");
}

main().catch((error) => {
  console.error("[intraday] 치명적 오류", error);
  process.exit(1);
});
