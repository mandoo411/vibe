#!/usr/bin/env node
/**
 * 매매시그널 '즉시검색' — 국내주식 전종목(KOSPI+KOSDAQ, ETF 제외) 일봉 지표 캐시 빌더.
 *
 * 즉시검색 API(/api/analyze?feature=trade-signal&action=screen)는 요청마다 KIS를 호출하지
 * 않고 이 스크립트가 미리 계산해 둔 data/kr-screener-cache.json을 읽어 즉시 필터링한다.
 * RSI/이동평균/다이버전스는 일봉 기준이라 장중에는 어차피 값이 바뀌지 않으므로(당일 캔들이
 * 확정되기 전까지) 장마감 후 하루 1회 실행으로 충분하다.
 *
 * 종목당 3~4회의 KIS 일봉 조회(inquire-daily-itemchartprice)가 필요해서(약 260봉을
 * ~100봉씩 페이지네이션) 전종목(~2,650개) 기준 총 8,000~10,000회 가까운 API 호출이
 * 발생한다 — 이 프로젝트 sandbox에는 실제 KIS 자격증명이 없어 실행 시간/성공률을 직접
 * 검증하지 못했다. GAP_MS/재시도 파라미터는 실제 GitHub Actions 실행 로그를 보고
 * 조정이 필요할 수 있다.
 *
 * 필수 env: KIS_ACCESS_TOKEN, KIS_APP_KEY, KIS_APP_SECRET (KIS_BASE_URL 선택)
 * 선택 env: SCREENER_GAP_MS(종목간 호출 간격 ms, 기본 220), SCREENER_TARGET_BARS(종목당 확보할
 *           일봉 개수, 기본 260 — MA200 + 52주 고저 계산에 필요한 최소치보다 여유있게)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  fetchChartCandles,
  computeMaSeries,
  computeRsiSeries,
  detectDivergence,
  computeMacd,
  computeBollinger,
  computeStochastic,
  computeADX,
} = require("../lib/kis-indicators.js");
const { buildSnapshotFromSeries } = require("../lib/trade-condition-eval.js");
const STOCK_LIST = require("../assets/stock-list.json");

const GAP_MS = Number(process.env.SCREENER_GAP_MS || 220);
const TARGET_BARS = Number(process.env.SCREENER_TARGET_BARS || 260);
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1500;
const PROGRESS_EVERY = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seoulYmd(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(date);
}

async function buildOne(stock) {
  let attempt = 0;
  for (;;) {
    try {
      const candles = await fetchChartCandles(stock.code, "D", TARGET_BARS);
      if (!candles.length) return null;
      const closes = candles.map((c) => c.close);
      const highs = candles.map((c) => c.high);
      const lows = candles.map((c) => c.low);
      const volumes = candles.map((c) => c.volume);

      const ma = {
        20: computeMaSeries(closes, 20, false),
        60: computeMaSeries(closes, 60, false),
        120: computeMaSeries(closes, 120, false),
        200: computeMaSeries(closes, 200, false),
      };
      const rsiSeries = computeRsiSeries(closes);
      const divergence = detectDivergence(closes, rsiSeries);
      const macd = computeMacd(closes);
      const bollinger = computeBollinger(closes);
      const stochastic = computeStochastic(highs, lows, closes);
      const adx = computeADX(highs, lows, closes);
      const snapshot = buildSnapshotFromSeries({
        closes,
        highs,
        lows,
        volumes,
        ma,
        rsiSeries,
        divergence,
        candles,
        macd,
        bollinger,
        stochastic,
        adx,
      });

      const n = closes.length;
      const close = closes[n - 1];
      const prevClose = n >= 2 ? closes[n - 2] : null;
      const changePct = prevClose ? Math.round(((close - prevClose) / prevClose) * 10000) / 100 : 0;
      const volume = volumes[n - 1] || 0;

      return {
        code: stock.code,
        name: stock.name,
        market: stock.market,
        close,
        changePct,
        tradingValue: Math.round(close * volume),
        snapshot,
      };
    } catch (error) {
      attempt += 1;
      if (attempt > MAX_RETRIES) {
        console.warn(`[screener-cache] ${stock.code} ${stock.name} 실패(재시도 초과): ${error.message}`);
        return null;
      }
      await sleep(RETRY_BASE_MS * attempt);
    }
  }
}

async function main() {
  const universe = STOCK_LIST.filter((s) => s.market === "KOSPI" || s.market === "KOSDAQ");
  console.log(`[screener-cache] 대상 ${universe.length}개 종목 스캔 시작 (GAP_MS=${GAP_MS}, TARGET_BARS=${TARGET_BARS})`);

  const startedAt = Date.now();
  const results = [];
  let done = 0;
  let failed = 0;

  for (const stock of universe) {
    const row = await buildOne(stock);
    if (row) results.push(row);
    else failed += 1;
    done += 1;

    if (done % PROGRESS_EVERY === 0) {
      const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
      console.log(`[screener-cache] 진행 ${done}/${universe.length} (실패 ${failed}) - ${elapsedMin}분 경과`);
    }
    await sleep(GAP_MS);
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    asOfDate: seoulYmd(),
    count: results.length,
    failedCount: failed,
    stocks: results,
  };

  const outPath = path.resolve("data/kr-screener-cache.json");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(payload), "utf8");

  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`[screener-cache] 완료 — ${results.length}개 저장, 실패 ${failed}개, 총 ${elapsedMin}분 → ${outPath}`);
}

main().catch((error) => {
  console.error("[screener-cache] 치명적 오류", error);
  process.exit(1);
});
