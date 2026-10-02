/**
 * 급락장 백테스트 (2026-10-02 신설) — 시우 질문: "코스피가 3% 넘게 빠진 날, 그 전날 고른 종목은 어땠나?"
 *
 * 실기록(close_signal_results)은 2026-09-14부터라 급락일 표본이 없다. 그래서 과거 일봉·수급으로
 * 매 거래일 15:20 스캔을 **근사 재현**하고, 지금 쓰는 채점 코드(rankCloseBetting / rankSwing)를
 * 그대로 돌려 5종목을 뽑은 뒤 다음 날(종가시그널)·5거래일 뒤(스윙) 결과를 잰다.
 *
 * 재현 방식 — 실서비스 파이프라인과 같은 함수를 같은 순서로 쓴다:
 *   D-1까지 일봉 270개 → buildSnapshotFromSeries (밤 캐시와 동일)
 *   → buildIntradaySnapshot(전일 스냅샷, D일 봉, D-1 수급) (15:20 스캔과 동일: RSI·MACD 등은 전일 값)
 *
 * 실서비스와 다른 점(결과 해석 때 반드시 같이 적을 것):
 *   - D일 봉은 15:20 값이 아니라 최종 종가(동시호가 포함). 매수가도 D일 종가.
 *   - 후보 400 = D일 거래대금 상위 400(실서비스는 장중 순위 API + 전일 거래대금 보충).
 *   - 거래대금 ≈ 거래량 × (시+고+저+종)/4, 시총 ≈ 현재 상장주식수 × D일 종가(유상증자 등은 오차).
 *   - 수급은 수량만 있어 금액 = 수량 × 그날 종가로 환산.
 *   - 재료(DART 공시) 가산점·기법 없음. 학습 가중치(data/close-signal-weights.json)는 현재값 그대로.
 *   - 현재 상장 종목만 대상(그 사이 상장폐지된 종목 빠짐 = 생존 편향, 결과가 약간 좋게 나올 수 있음).
 *
 * 데이터: 네이버 금융 일봉·투자자별 매매동향(내부 검증용으로만 사용, 원본 재배포 금지).
 * 입력: BT_DIR(기본 /tmp/claude-0/bt)의 candles.json / flows.json / idx_KOSPI.json / idx_KOSDAQ.json
 * 출력: BT_DIR/daily.json (거래일별 5종목·결과)
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const K = require("../lib/kis-indicators.js");
const { buildSnapshotFromSeries } = require("../lib/trade-condition-eval.js");
const { buildIntradaySnapshot } = require("../lib/intraday-snapshot.js");
const { rankCloseBetting } = require("../lib/close-betting-score.js");
const { rankSwing } = require("../lib/swing-signal.js");

const DIR = process.env.BT_DIR || "/tmp/claude-0/bt";
const FROM = process.env.BT_FROM || "2024-06-03";
const TO = process.env.BT_TO || "2026-10-01";
const BARS = 270;
const CAND = 400;
const SWING_HOLD = 5;

const rd = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
const ymd = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 10000) / 100 : null);

const list = require("../assets/stock-list.json").filter((s) => s.market === "KOSPI" || s.market === "KOSDAQ");
const meta = new Map(list.map((s) => [s.code, s]));
const cache = require("../data/kr-screener-cache.json");
const shares = new Map();
for (const r of cache.stocks || []) if (r.marketCapEok && r.close) shares.set(r.code, (r.marketCapEok * 1e8) / r.close);

const rawCandles = rd("candles.json");
const rawFlows = rd("flows.json");
const idx = { KOSPI: rd("idx_KOSPI.json"), KOSDAQ: rd("idx_KOSDAQ.json") };

// 종목별 일봉 → {times, o,h,l,c,v, pos: Map(date→i)}
const S = new Map();
for (const [code, rows] of Object.entries(rawCandles)) {
  if (!meta.has(code) || !rows || rows.length < 80) continue;
  const c = rows.filter((r) => r[4] > 0 && r[1] > 0).map((r) => ({ time: ymd(r[0]), open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] || 0 }));
  const pos = new Map(c.map((b, i) => [b.time, i]));
  S.set(code, { c, pos });
}
// 종목별 수급 → 날짜 오름차순 [{d,f,o}]
const F = new Map();
for (const [code, rows] of Object.entries(rawFlows)) {
  if (!rows) continue;
  const arr = rows.map((r) => ({ d: ymd(r[0]), f: r[1], o: r[2] })).sort((a, b) => (a.d < b.d ? -1 : 1));
  F.set(code, arr);
}

const days = idx.KOSPI.map((r) => ymd(r.localDate));
const idxRet = {};
for (const k of ["KOSPI", "KOSDAQ"]) {
  idxRet[k] = {};
  const a = idx[k];
  for (let i = 0; i < a.length; i++) {
    const d = ymd(a[i].localDate);
    idxRet[k][d] = {
      close: a[i].closePrice,
      chg: i ? pct(a[i].closePrice, a[i - 1].closePrice) : null,
      openChg: i ? pct(a[i].openPrice, a[i - 1].closePrice) : null,
    };
  }
}

function flowAt(code, d) {
  // D-1 확정 수급(15:20 스캔이 받는 값과 같은 기준). d = 기준일(D-1)
  const arr = F.get(code);
  const s = S.get(code);
  if (!arr || !arr.length) return {};
  let k = -1;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i].d <= d) { k = i; break; }
  if (k < 0) return {};
  const latest = arr[k];
  const streak = (pick) => {
    let n = 0;
    for (let i = k; i >= 0 && n < 30; i--) {
      const v = pick(arr[i]);
      if (v == null || !(v > 0)) break;
      n++;
    }
    return n;
  };
  const pi = s && s.pos.get(latest.d);
  const px = pi != null ? s.c[pi].close : null;
  const eok = (q) => (q == null || px == null ? null : Math.round(((q * px) / 1e8) * 10) / 10);
  return {
    flowAsOfDate: latest.d.replace(/-/g, ""),
    foreignNetBuy: latest.f,
    institutionNetBuy: latest.o,
    foreignNetBuyEok: eok(latest.f),
    institutionNetBuyEok: eok(latest.o),
    foreignNetBuyStreak: streak((r) => r.f),
    institutionNetBuyStreak: streak((r) => r.o),
    majorNetBuyStreak: streak((r) => (r.f == null || r.o == null ? null : r.f > 0 && r.o > 0 ? 1 : 0)),
  };
}

function prevSnapshot(s, iPrev) {
  const candles = s.c.slice(Math.max(0, iPrev - BARS + 1), iPrev + 1);
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const opens = candles.map((c) => c.open);
  const volumes = candles.map((c) => c.volume);
  const ma = {};
  for (const p of [5, 10, 20, 60, 120, 200, 240]) ma[p] = K.computeMaSeries(closes, p, false);
  const rsiSeries = K.computeRsiSeries(closes);
  return buildSnapshotFromSeries({
    closes, highs, lows, opens, volumes, ma, rsiSeries,
    divergence: K.detectDivergence(closes, rsiSeries),
    candles,
    macd: K.computeMacd(closes),
    bollinger: K.computeBollinger(closes),
    stochastic: K.computeStochastic(highs, lows, closes),
    adx: K.computeADX(highs, lows, closes),
    periodReturns: K.computePeriodReturns(closes, candles.map((c) => c.time)),
  });
}

function rowFor(code, D, dPrev) {
  const s = S.get(code);
  const i = s.pos.get(D);
  const iPrev = s.pos.get(dPrev);
  if (i == null || iPrev == null || iPrev < 60) return null;
  const bar = s.c[i];
  if (!bar.volume) return null;
  const prev = prevSnapshot(s, iPrev);
  const sh = shares.get(code);
  const tvEok = Math.round(((bar.volume * (bar.open + bar.high + bar.low + bar.close)) / 4 / 1e8) * 100) / 100;
  const mcEok = sh ? Math.round((sh * bar.close) / 1e8) : null;
  const flow = flowAt(code, dPrev);
  const snap = buildIntradaySnapshot(prev, {
    open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
    tradingValueEok: tvEok, marketCapEok: mcEok,
  }, flow);
  if (!snap) return null;
  const m = meta.get(code);
  return {
    code, name: m.name, market: m.market, close: bar.close,
    changePct: pct(bar.close, s.c[iPrev].close),
    tradingValueEok: tvEok, marketCapEok: mcEok, snapshot: snap,
  };
}

function nextBars(code, D, n) {
  const s = S.get(code);
  const i = s.pos.get(D);
  return i == null ? [] : s.c.slice(i + 1, i + 1 + n);
}

const out = [];
const start = Date.now();
const testDays = days.filter((d) => d >= FROM && d <= TO);
for (const D of testDays) {
  const di = days.indexOf(D);
  const dPrev = days[di - 1];
  const dNext = days[di + 1] || null;
  // 후보: D일 거래대금 상위 400
  const pool = [];
  for (const [code, s] of S) {
    const i = s.pos.get(D);
    if (i == null) continue;
    const b = s.c[i];
    pool.push([code, b.volume * (b.open + b.high + b.low + b.close) / 4]);
  }
  pool.sort((a, b) => b[1] - a[1]);
  const rows = [];
  for (const [code] of pool.slice(0, CAND)) {
    const r = rowFor(code, D, dPrev);
    if (r) rows.push(r);
  }
  const cb = rankCloseBetting(rows, 5).ranked;
  const sw = rankSwing(rows, 5).ranked;

  const closePicks = cb.map((p) => {
    const nb = nextBars(p.code, D, 1)[0];
    return {
      code: p.code, name: p.name, score: p.score, consensus: p.consensus, buy: p.close,
      openRet: nb && nb.time === dNext ? pct(nb.open, p.close) : null,
      closeRet: nb && nb.time === dNext ? pct(nb.close, p.close) : null,
      lowRet: nb && nb.time === dNext ? pct(nb.low, p.close) : null,
    };
  });
  const swingPicks = sw.map((p) => {
    const nb = nextBars(p.code, D, SWING_HOLD);
    const done = nb.length === SWING_HOLD;
    return {
      code: p.code, name: p.name, score: p.score, buy: p.close,
      day1Ret: nb[0] ? pct(nb[0].close, p.close) : null,
      finalRet: done ? pct(nb[SWING_HOLD - 1].close, p.close) : null,
      maxHigh: done ? pct(Math.max(...nb.map((b) => b.high)), p.close) : null,
      minLow: done ? pct(Math.min(...nb.map((b) => b.low)), p.close) : null,
      endDate: done ? nb[SWING_HOLD - 1].time : null,
    };
  });
  const swEnd = days[di + SWING_HOLD] || null;
  const idxSpan = (k) => (swEnd ? pct(idxRet[k][swEnd].close, idxRet[k][D].close) : null);
  const winDays = days.slice(di + 1, di + 1 + SWING_HOLD);
  out.push({
    date: D,
    next: dNext,
    candidates: rows.length,
    kospiDay: idxRet.KOSPI[D].chg,
    kospiNext: dNext ? idxRet.KOSPI[dNext].chg : null,
    kospiNextOpen: dNext ? idxRet.KOSPI[dNext].openChg : null,
    kosdaqNext: dNext ? idxRet.KOSDAQ[dNext].chg : null,
    kosdaqNextOpen: dNext ? idxRet.KOSDAQ[dNext].openChg : null,
    kospiSwing: idxSpan("KOSPI"),
    kosdaqSwing: idxSpan("KOSDAQ"),
    swingWorstKospiDay: winDays.length === SWING_HOLD ? Math.min(...winDays.map((d) => idxRet.KOSPI[d].chg)) : null,
    close: closePicks,
    swing: swingPicks,
  });
  if (out.length % 20 === 0) console.log(`${D} ${out.length}/${testDays.length} ${((Date.now() - start) / 1000).toFixed(0)}s`);
}
fs.writeFileSync(path.join(DIR, process.env.BT_OUT || "daily.json"), JSON.stringify(out));
console.log("done", out.length);
