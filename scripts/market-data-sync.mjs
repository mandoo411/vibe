#!/usr/bin/env node
/**
 * 미국시장 / 국내 실시간 랭킹 데이터를 미리 생성해 data/*.json 으로 저장.
 * - 기존 api/ 핸들러 로직을 그대로 재사용(가짜 req/res 로 호출)하여 중복 구현 없음.
 * - GitHub Actions(market-data-sync.yml)에서 30분마다 실행 → 커밋.
 * - 프런트(us-market.html / realtime.html)는 /api/repo-data(=tmFetchJson)로 이 파일들을 읽음.
 *
 * 출력:
 *   data/us-market-cap.json     (미국 시가총액 TOP50)
 *   data/us-market-gainers.json (미국 상승률 TOP50)
 *   data/us-market-volume.json  (미국 거래대금 TOP50)
 *   data/kr-realtime-cap.json   (코스피/코스닥 시가총액 TOP100)
 *   data/kr-realtime-gainers.json (상승률 TOP100)
 *   data/kr-realtime-tv.json    (거래대금 TOP100)
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

async function writeJson(file, payload) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const out = path.join(DATA_DIR, file);
  await fs.writeFile(out, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`wrote ${file} (stocks=${(payload.stocks || []).length})`);
}

const usHandler = require("../api/us-market-data.js");
const krHandler = require("../api/kis-realtime-data.js");

const US_TABS = [
  ["market-cap", "us-market-cap.json"],
  ["gainers", "us-market-gainers.json"],
  ["volume", "us-market-volume.json"],
];

const KR_TABS = [
  ["market-cap", "kr-realtime-cap.json"],
  ["gainers", "kr-realtime-gainers.json"],
  ["trading-value", "kr-realtime-tv.json"],
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
      process.exitCode = 1;
    }
  }
}

async function syncKr() {
  for (const [action, file] of KR_TABS) {
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
      if (!all.length) throw new Error("empty result");
      await writeJson(file, {
        updatedAt: new Date().toISOString(),
        source: "naver+kis",
        action,
        count: all.length,
        stocks: all,
      });
    } catch (e) {
      console.error(`KR sync failed (${action}): ${e.message}`);
      process.exitCode = 1;
    }
  }
}

const ONLY = (process.env.SYNC_ONLY || "").toLowerCase();
if (ONLY !== "kr") await syncUs();
if (ONLY !== "us") await syncKr();
console.log("market-data-sync done");
