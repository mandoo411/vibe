#!/usr/bin/env node
/**
 * 미국시장 / 국내 실시간 랭킹 데이터를 미리 생성해 data/*.json 으로 저장.
 * - 기존 api/ 핸들러 로직을 그대로 재사용(가짜 req/res 로 호출)하여 중복 구현 없음.
 * - GitHub Actions(market-data-sync.yml)에서 30분마다 실행 → 커밋.
 * - 프런트(us-market.html / realtime.html)는 /api/repo-data(또는 ./data)로 이 파일을 읽고,
 *   파일이 없으면 기존 API(/api/us-market-data, /api/kis-realtime-data)로 폴백.
 *
 * 출력:
 *   data/us-market-cap.json     (미국 시가총액 TOP50)
 *   data/us-market-gainers.json (미국 상승률 TOP50)
 *   data/us-market-volume.json  (미국 거래대금 TOP50)
 *   data/kr-realtime.json       (국내 실시간: { tabs: { cap, gainers, tv } } TOP100)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DATA_DIR = path.resolve("data");

/** CJS 핸들러를 가짜 req/res 로 호출해 JSON 본문을 회수 */
function callHandler(handler, query) {
  return new Promise((resolve, reject) => {
    const req = { method: "GET", query };
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body) {
        resolve({ status: this.statusCode, body: typeof body === "string" ? body : String(body) });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

let wrote = 0;
async function writeJson(file, payload) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const out = path.join(DATA_DIR, file);
  await fs.writeFile(out, JSON.stringify(payload, null, 2) + "\n", "utf8");
  wrote += 1;
  console.log(`wrote ${file}`);
}

const usHandler = require("../api/us-market-data.js");
const krHandler = require("../api/kis-realtime-data.js");

const US_TABS = [
  ["market-cap", "us-market-cap.json"],
  ["gainers", "us-market-gainers.json"],
  ["volume", "us-market-volume.json"],
  // 2026-09-25 6탭
  ["losers", "us-market-losers.json"],
  ["trade-vol", "us-market-tradevol.json"],
  ["trade-growth", "us-market-volsurge.json"],
];

// kis-realtime-data 액션 → kr-realtime.json 의 탭 키
const KR_TABS = [
  ["market-cap", "cap"],
  ["gainers", "gainers"],
  ["trading-value", "tv"],
  // 2026-09-25 6탭: 하락률·거래량·거래량 급증(전일 대비)
  ["losers", "losers"],
  ["volume", "vol"],
  ["volume-surge", "surge"],
];

async function syncUs() {
  for (const [action, file] of US_TABS) {
    try {
      const { status, body } = await callHandler(usHandler, { action });
      const data = JSON.parse(body || "{}");
      if (status !== 200 || !Array.isArray(data.stocks)) {
        throw new Error(`status=${status} ${String(body).slice(0, 200)}`);
      }
      await writeJson(file, {
        updatedAt: data.updatedAt || new Date().toISOString(),
        source: "kis+yahoo",
        action,
        count: data.stocks.length,
        stocks: data.stocks,
      });
    } catch (e) {
      console.error(`US sync failed (${action}): ${e.message}`);
    }
  }
}

async function syncKr() {
  const tabs = {};
  for (const [action, key] of KR_TABS) {
    try {
      const all = [];
      // TOP100 = 25행 × 4페이지
      for (let page = 1; page <= 4; page++) {
        const { status, body } = await callHandler(krHandler, {
          action,
          page: String(page),
          pageSize: "25",
        });
        const data = JSON.parse(body || "{}");
        if (status !== 200) throw new Error(`p${page} status=${status}`);
        for (const s of data.stocks || []) all.push(s);
      }
      tabs[key] = all;
    } catch (e) {
      console.error(`KR sync failed (${action}): ${e.message}`);
      tabs[key] = tabs[key] || [];
    }
  }
  const total = Object.values(tabs).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  if (!total) {
    console.error("KR sync produced no rows — skip writing kr-realtime.json");
    return;
  }
  await writeJson("kr-realtime.json", {
    updatedAt: new Date().toISOString(),
    source: "naver+kis",
    counts: Object.fromEntries(Object.entries(tabs).map(([k, v]) => [k, (v || []).length])),
    tabs,
  });
}

/**
 * 2026-09-24 국내 전 종목(코스피+코스닥, 약 2,700개) — 리뉴얼 실시간 랭킹 프로토타입(lab-realtime.html)용.
 * 네이버 모바일 시가총액 목록을 시장별로 끝까지 넘겨 받는다(페이지당 100, 시장당 ~10~19쪽).
 * 용량을 줄이려고 행을 배열로 저장한다:
 *   [code, name, mkt("P"|"Q"), price, chgAmt(부호 포함), pct, volume, tradingValue(백만원), marketCap(억원), kind("S"주식|"F"ETF|"N"ETN)]
 * 네이버 코스피 목록에는 ETF·ETN이 섞여 있다(코스피 2,484개 중 상당수). 화면은 kind로 나눠 쓴다.
 * 정렬(시총/상승/하락/거래대금/거래량)과 시장 필터·검색은 브라우저가 한다 → AI·토큰 사용 없음.
 */
async function syncKrAll() {
  const toNum = (v) => {
    const n = Number(String(v == null ? "" : v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const rows = [];
  let asOf = null;
  for (const [mkt, tag] of [["KOSPI", "P"], ["KOSDAQ", "Q"]]) {
    let total = Infinity;
    for (let page = 1; (page - 1) * 100 < total && page <= 40; page++) {
      const url = `https://m.stock.naver.com/api/stocks/marketValue/${mkt}?pageSize=100&page=${page}`;
      let data = null;
      for (let attempt = 0; attempt < 3 && !data; attempt++) {
        try {
          const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json" } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          data = await r.json();
        } catch (e) {
          if (attempt === 2) throw new Error(`${mkt} p${page}: ${e.message}`);
          await new Promise((res) => setTimeout(res, 800));
        }
      }
      total = Number(data.totalCount) || 0;
      for (const st of data.stocks || []) {
        const code = String(st.itemCode || "");
        if (!/^[0-9A-Z]{6}$/.test(code)) continue;
        const dir = st.compareToPreviousPrice && st.compareToPreviousPrice.name;
        const sign = dir === "FALLING" || dir === "LOWER_LIMIT" ? -1 : 1;
        const amt = toNum(st.compareToPreviousClosePrice);
        const pct = toNum(st.fluctuationsRatio);
        rows.push([
          code, String(st.stockName || ""), tag,
          toNum(st.closePrice),
          amt == null ? null : sign * Math.abs(amt),
          pct,
          toNum(st.accumulatedTradingVolume),
          toNum(st.accumulatedTradingValue),
          toNum(st.marketValue),
          st.stockEndType === "etf" ? "F" : st.stockEndType === "etn" ? "N" : "S",
        ]);
        if (!asOf && st.localTradedAt) asOf = st.localTradedAt;
      }
      await new Promise((res) => setTimeout(res, 150));
    }
  }
  if (rows.length < 1000) throw new Error(`too few rows (${rows.length})`);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    tradedAt: asOf,
    source: "naver",
    fields: ["code", "name", "mkt", "price", "chgAmt", "pct", "volume", "tvMillion", "mcapEok", "kind"],
    count: rows.length,
    rows,
  };
  await fs.writeFile(path.join(DATA_DIR, "kr-all.json"), JSON.stringify(payload) + "\n", "utf8");
  wrote += 1;
  console.log(`wrote kr-all.json (${rows.length} rows)`);
}

const ONLY = (process.env.SYNC_ONLY || "").toLowerCase();
if (ONLY !== "kr") await syncUs();
if (ONLY !== "us") await syncKr();
// 2026-09-25: 국내 전 종목 시세(kr-all.json)는 공개 저장소에 두지 않는다.
// 개인 도구 전용으로 Supabase Edge Function personal-kr-collector가 1분마다 수집해
// public.personal_snapshots(운영자만 읽기)에 넣는다. syncKrAll()은 참고용으로만 남겨 둔다.
// 2026-09-25: 홈 섹터 히트맵용 종목→섹터(WICS) 매핑 — 7일 넘게 묵었을 때만 새로 받는다.
try {
  const { ensureFreshSectorMap } = await import("./build-sector-map.mjs");
  if (await ensureFreshSectorMap(7)) console.log("rebuilt kr-sector-map.json");
} catch (e) {
  console.error(`sector map refresh failed: ${e.message}`);
}
console.log(`sync-market-data done (files written: ${wrote})`);
if (wrote === 0) process.exit(1);
