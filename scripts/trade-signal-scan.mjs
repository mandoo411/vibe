#!/usr/bin/env node
/**
 * 매매 시그널 스캔 — 활성 전략(trade_signal_strategies, status=active)을 모두 읽어서
 * KIS 일봉 지표로 조건을 판정하고, 충족되면 trade_signal_events에 기록한다.
 *
 * V1: 알림 채널은 사이트 내 "발견된 시그널" 목록뿐이다(텔레그램 개인 발송은 사용자별
 * chat_id 연결이 아직 없어서 다음 단계로 미룸 — scripts/telegram-utils.mjs의
 * sendTelegramMessage()는 사이트 전체용 고정 채널(TELEGRAM_CHANNEL_ID)이라 개인화된
 * 알림에는 그대로 못 씀).
 *
 * 같은 종목을 감시하는 전략이 여러 명이어도 KIS 조회는 종목당 1번만 한다.
 * 하루 1번만 알림이 나가도록(같은 조건이 계속 참이어도 스팸 방지) last_triggered_at을
 * Asia/Seoul 날짜 기준으로 비교해서 오늘 이미 발송했으면 건너뛴다.
 *
 * 필수 env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KIS_ACCESS_TOKEN, KIS_APP_KEY, KIS_APP_SECRET
 */

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
  fetchMarketSnapshot,
  computePeriodReturns,
} = require("../lib/kis-indicators.js");
const { buildSnapshotFromSeries, evaluateCondition } = require("../lib/trade-condition-eval.js");

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return String(v).trim();
}

const SUPABASE_URL = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
const SERVICE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

function supaHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function supaGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: supaHeaders() });
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: HTTP ${res.status}`);
  return res.json();
}

async function supaPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: supaHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase POST ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

async function supaPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: supaHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase PATCH ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

function seoulYmd(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function alreadyTriggeredToday(lastTriggeredAt) {
  if (!lastTriggeredAt) return false;
  return seoulYmd(new Date(lastTriggeredAt)) === seoulYmd(new Date());
}

async function buildSeriesForStock(stockCode) {
  const candles = await fetchChartCandles(stockCode, "D");
  if (!candles.length) return null;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const ma = {
    5: computeMaSeries(closes, 5, false),
    10: computeMaSeries(closes, 10, false),
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
  const market = await fetchMarketSnapshot(stockCode);
  const periodReturns = computePeriodReturns(closes);
  return {
    closes, highs, lows, volumes, ma, rsiSeries, divergence, candles, macd, bollinger, stochastic, adx,
    marketCapEok: market.marketCapEok,
    tradingValueEok: market.tradingValueEok,
    periodReturns,
  };
}

function messageFor(strategy) {
  const action = strategy.alert_type === "buy" ? "매수" : "매도";
  return `${strategy.stock_name} · ${action} 조건 충족 (${strategy.raw_text})`;
}

async function main() {
  const strategies = await supaGet("trade_signal_strategies?status=eq.active&select=*");
  if (!strategies.length) {
    console.log("[trade-signal-scan] 활성 전략 없음, 종료");
    return;
  }
  console.log(`[trade-signal-scan] 활성 전략 ${strategies.length}건, 대상 종목 ${new Set(strategies.map((s) => s.stock_code)).size}개`);

  const seriesCache = new Map();
  let triggeredCount = 0;
  let errorCount = 0;

  for (const strategy of strategies) {
    if (alreadyTriggeredToday(strategy.last_triggered_at)) continue;

    let series = seriesCache.get(strategy.stock_code);
    if (series === undefined) {
      try {
        series = await buildSeriesForStock(strategy.stock_code);
      } catch (error) {
        console.warn(`[trade-signal-scan] ${strategy.stock_code} 조회 실패: ${error.message}`);
        series = null;
        errorCount += 1;
      }
      seriesCache.set(strategy.stock_code, series);
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!series) continue;

    let matched = false;
    try {
      matched = evaluateCondition(strategy.condition, buildSnapshotFromSeries(series));
    } catch (error) {
      console.warn(`[trade-signal-scan] ${strategy.id} 조건 판정 실패: ${error.message}`);
      continue;
    }
    if (!matched) continue;

    const message = messageFor(strategy);
    try {
      await supaPost("trade_signal_events", {
        strategy_id: strategy.id,
        user_id: strategy.user_id,
        message,
      });
      await supaPatch(`trade_signal_strategies?id=eq.${strategy.id}`, {
        last_triggered_at: new Date().toISOString(),
      });
      triggeredCount += 1;
      console.log(`[trade-signal-scan] 시그널 발생: ${message}`);
    } catch (error) {
      console.warn(`[trade-signal-scan] ${strategy.id} 이벤트 기록 실패: ${error.message}`);
    }
  }

  console.log(`[trade-signal-scan] 완료 — 시그널 ${triggeredCount}건 기록, 조회 실패 ${errorCount}건`);
}

main().catch((error) => {
  console.error("[trade-signal-scan] 치명적 오류", error);
  process.exit(1);
});
