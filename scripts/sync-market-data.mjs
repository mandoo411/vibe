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
];

// kis-realtime-data 액션 → kr-realtime.json 의 탭 키
const KR_TABS = [
  ["market-cap", "cap"],
  ["gainers", "gainers"],
  ["trading-value", "tv"],
];

async function syncUs() {
  for (const [action, file] of US_TABS) {
    try {
      const { status, body } = await callHandler(usHandler, { action });
      const data = JSON.parse(body || "{}");
      if (status !== 200 || !Array.isArray(data.stocks)) {
        throw new Error(`status=${status} ${String(body).slice(0, 200)}`);
      }
      // GOOG(알파벳 C클래스) 중복 제거 — GOOGL(A클래스)만 표시. 방어적 필터(소스에 GOOG가 섞여 와도 제외) 후 순위 재부여.
      const stocks = (data.stocks || [])
        .filter((item) => String(item && item.ticker).toUpperCase() !== "GOOG")
        .map((item, i) => ({ ...item, rank: i + 1 }));
      await writeJson(file, {
        updatedAt: data.updatedAt || new Date().toISOString(),
        source: "kis+yahoo",
        action,
        count: stocks.length,
        stocks,
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
  const total = (tabs.cap || []).length + (tabs.gainers || []).length + (tabs.tv || []).length;
  if (!total) {
    console.error("KR sync produced no rows — skip writing kr-realtime.json");
    return;
  }
  await writeJson("kr-realtime.json", {
    updatedAt: new Date().toISOString(),
    source: "naver+kis",
    counts: { cap: (tabs.cap || []).length, gainers: (tabs.gainers || []).length, tv: (tabs.tv || []).length },
    tabs,
  });
}

const ONLY = (process.env.SYNC_ONLY || "").toLowerCase();
if (ONLY !== "kr") await syncUs();
if (ONLY !== "us") await syncKr();
console.log(`sync-market-data done (files written: ${wrote})`);
if (wrote === 0) process.exit(1);
