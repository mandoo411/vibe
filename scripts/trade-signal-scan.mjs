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
const { fetchChartCandles, computeMaSeries, computeRsiSeries } = require("../lib/kis-indicators.js");

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

function evaluateClause(clause, series) {
  const { closes, ma, rsiSeries, volumes, highs, lows } = series;
  const n = closes.length;
  if (n < 2) return false;
  const i = n - 1;
  const prevI = n - 2;

  if (clause.type === "ma_cross") {
    const fastArr = ma[clause.fast];
    const slowArr = ma[clause.slow];
    if (!fastArr || !slowArr) return false;
    const f0 = fastArr[prevI], s0 = slowArr[prevI], f1 = fastArr[i], s1 = slowArr[i];
    if ([f0, s0, f1, s1].some((v) => v == null)) return false;
    return clause.direction === "down" ? f0 >= s0 && f1 < s1 : f0 <= s0 && f1 > s1;
  }
  if (clause.type === "price_cross_ma") {
    const maArr = ma[clause.period];
    if (!maArr) return false;
    const m0 = maArr[prevI], m1 = maArr[i];
    const c0 = closes[prevI], c1 = closes[i];
    if (m0 == null || m1 == null) return false;
    return clause.direction === "down" ? c0 >= m0 && c1 < m1 : c0 <= m0 && c1 > m1;
  }
  if (clause.type === "rsi") {
    const r = rsiSeries[i];
    if (r == null) return false;
    if (clause.op === "lt") return r < clause.value;
    if (clause.op === "lte") return r <= clause.value;
    if (clause.op === "gt") return r > clause.value;
    if (clause.op === "gte") return r >= clause.value;
    return false;
  }
  if (clause.type === "volume_ratio") {
    const windowVol = volumes.slice(Math.max(0, i - 20), i);
    if (!windowVol.length) return false;
    const avg = windowVol.reduce((a, b) => a + b, 0) / windowVol.length;
    if (!avg) return false;
    const ratio = (volumes[i] / avg) * 100;
    return clause.op === "gt" ? ratio > clause.value : ratio >= clause.value;
  }
  if (clause.type === "high52w_breakout") {
    const windowHighs = highs.slice(Math.max(0, i - 252), i);
    if (!windowHighs.length) return false;
    return closes[i] > Math.max(...windowHighs);
  }
  if (clause.type === "low52w_breakdown") {
    const windowLows = lows.slice(Math.max(0, i - 252), i);
    if (!windowLows.length) return false;
    return closes[i] < Math.min(...windowLows);
  }
  if (clause.type === "price_change_pct") {
    const c0 = closes[prevI], c1 = closes[i];
    if (!c0) return false;
    const pct = ((c1 - c0) / c0) * 100;
    return clause.op === "lte" ? pct <= clause.value : pct >= clause.value;
  }
  return false;
}

function evaluateCondition(condition, series) {
  if (!condition || !Array.isArray(condition.clauses) || !condition.clauses.length) return false;
  return condition.clauses.every((clause) => evaluateClause(clause, series));
}

async function buildSeriesForStock(stockCode) {
  const candles = await fetchChartCandles(stockCode, "D");
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
  return { closes, highs, lows, volumes, ma, rsiSeries };
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
      matched = evaluateCondition(strategy.condition, series);
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
