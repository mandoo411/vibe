#!/usr/bin/env node
/**
 * 종가시그널 자기학습 — 2026-09-24 신설. (내부용: 결과는 사이트에 노출하지 않는다 — 시우 결정)
 *
 * 목표: "다음날 실제로 잘 된 종목의 특성"을 쌓아서 기법별 가중치를 자동으로 조정하고,
 *       새 기법 후보를 찾아 주간 텔레그램으로 보고한다.
 *
 * 왜 상위 5종목이 아니라 "필터 통과 후보 전원"을 기록하나:
 *   뽑힌 5종목만 보면 "안 뽑은 종목이 더 좋았는지"를 영원히 모른다(선택 편향).
 *   매일 30~40종목이 필터를 통과하므로 하루 표본이 5 → 35로 늘고, 기법 하나당 비교군이 생긴다.
 *
 * 모드
 *   --mode=collect  (거래일 16:05) 결과가 아직 없는 스캔일의 통과 후보 전원에 대해
 *                    다음 거래일 시가·종가·고가·저가를 KIS 일봉으로 받아 close_signal_outcomes에 저장.
 *                    첫 실행 땐 쌓여 있는 과거 스캔(9/14~)도 한꺼번에 채운다.
 *   --mode=learn    (토 09:00) 최근 60거래일 기록으로 기법별 성적 → 가중치 조정 →
 *                    data/close-signal-weights.json 갱신 → 텔레그램 주간 보고.
 *
 * 목적 지표: 시가 매도와 종가 매도 수익률의 평균(시우: "시가·종가 매도 손익이 제일 중요").
 *
 * 가중치 안전장치
 *   - 표본 30건 미만이거나 걸린 날이 20거래일 미만인 기법은 가중치를 움직이지 않는다(판단 보류)
 *   - 적은 표본의 우연을 줄이려고 차이를 n/(n+30)만큼만 믿는다(수축 추정)
 *   - 범위 0.5~1.5, 한 주에 최대 ±0.2만 움직인다(한 주 운에 휘둘리지 않게)
 *
 * env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KIS_*, (learn) TELEGRAM_TOKEN, TELEGRAM_ADMIN_CHAT_ID
 *      LEARN_DRY_RUN=1 이면 저장·커밋·발송 없이 결과만 출력
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fetchChartCandles } = require("../lib/kis-indicators.js");
const { scoreCloseBetting } = require("../lib/close-betting-score.js");
const { STRATEGIES, extractFeatures } = require("../lib/close-signal-strategies.js");
const krx = require("../lib/krx-calendar.js");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.LEARN_DRY_RUN === "1";
const MODE = (process.argv.find((a) => a.startsWith("--mode=")) || "--mode=collect").split("=")[1];
const WEIGHTS_PATH = "data/close-signal-weights.json";

const MIN_N = 30;          // 이 표본 미만이면 판단 보류
const MIN_DAYS = 20;       // 서로 다른 거래일 수 — 같은 날 종목들은 함께 움직여서 표본 수만으론 과신하게 된다
const SHRINK_K = 30;       // 수축 강도
const STEP = 0.2;          // 주당 최대 변화
const W_MIN = 0.5, W_MAX = 1.5;
const LIFT_TO_WEIGHT = 0.5; // 평균 대비 +1%p 우위 → 가중치 +0.5
const WINDOW_DAYS = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const pct = (a, b) => (a != null && b ? ((a - b) / b) * 100 : null);

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

/* ═════════════ collect ═════════════ */

const barCache = new Map();
async function loadBars(code) {
  if (barCache.has(code)) return barCache.get(code);
  let map = new Map();
  try {
    const candles = await fetchChartCandles(code, "D", 60);
    map = new Map((candles || []).map((c) => [String(c.time).slice(0, 10), c]));
  } catch (e) {
    console.warn(`[learn] ${code} 일봉 실패: ${e.message}`);
  }
  barCache.set(code, map);
  await sleep(120);
  return map;
}

/** 학습에 쓸 특성만 숫자로 추린다(원본 스냅샷은 너무 크다) */
function compactFeatures(f) {
  const keep = ["changePct", "gapPct", "bodyPct", "closePosition", "tradingValueEok", "marketCapEok", "turnoverPct",
    "volumeRatio", "disparity5", "r5", "r21", "r252", "breakoutLevel", "foreignNetBuyEok", "institutionNetBuyEok",
    "majorNetBuyEok", "foreignStreak", "institutionStreak", "lateStrengthPct", "catalystScore"];
  const o = {};
  for (const k of keep) if (f[k] != null && Number.isFinite(Number(f[k]))) o[k] = Math.round(Number(f[k]) * 1000) / 1000;
  o.market = f.market || null;
  o.aligned = f.aligned;
  o.bothNetBuy = !!f.bothNetBuy;
  return o;
}

async function collect() {
  const today = krx.seoulYmd();
  // 결과가 이미 들어간 가장 최근 스캔일
  const doneRes = await sb("close_signal_outcomes?select=as_of_date&order=as_of_date.desc&limit=1");
  const done = (await doneRes.json())[0]?.as_of_date || "0000-00-00";

  const scansRes = await sb(`trade_signal_intraday?slot=eq.1520&as_of_date=gt.${done}&as_of_date=lt.${today}&order=as_of_date.asc&select=as_of_date,payload`);
  const scans = await scansRes.json();
  let saved = 0;
  for (const scan of scans) {
    const day = scan.as_of_date;
    const resultDate = krx.nextTradingDay(day);
    // 결과일 종가가 확정된 뒤에만(결과일 < 오늘, 또는 결과일 == 오늘이면 15:40 이후)
    const hm = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(":", ""));
    if (resultDate > today || (resultDate === today && hm < 1540)) { console.log(`[learn] ${day} → 결과일 ${resultDate} 아직 미확정, 대기`); continue; }

    const stocks = (scan.payload && scan.payload.stocks) || [];
    const ranked = (scan.payload && scan.payload.closeBetting && scan.payload.closeBetting.ranked) || [];
    const rankOf = new Map(ranked.map((r) => [r.code, r.rank]));
    const rows = [];
    for (const st of stocks) {
      const sc = scoreCloseBetting(st);
      if (!sc.passed) continue;
      const f = extractFeatures(st);
      const buy = f.close;
      const bars = await loadBars(st.code);
      const bar = bars.get(resultDate);
      if (!bar || !buy) continue; // 못 받으면 지어내지 않는다
      rows.push({
        as_of_date: day, code: st.code, name: st.name, result_date: resultDate,
        score: sc.score, rank: rankOf.get(st.code) || null,
        strategies: (sc.strategies || []).map((s) => s.key),
        features: compactFeatures(f),
        buy_price: buy,
        open_ret: r2(pct(Number(bar.open), buy)), close_ret: r2(pct(Number(bar.close), buy)),
        high_ret: r2(pct(Number(bar.high), buy)), low_ret: r2(pct(Number(bar.low), buy)),
      });
    }
    console.log(`[learn] ${day} → ${resultDate}: 통과 후보 ${rows.length}종목 결과 수집`);
    if (!DRY && rows.length) {
      await sb("close_signal_outcomes?on_conflict=as_of_date,code", {
        method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows),
      });
    }
    saved += rows.length;
  }
  console.log(`[learn] collect 완료 · 저장 ${saved}행${DRY ? " (DRY)" : ""}`);
}

/* ═════════════ learn ═════════════ */

const obj = (r) => (r.open_ret != null && r.close_ret != null ? (Number(r.open_ret) + Number(r.close_ret)) / 2 : null);
function stats(rows) {
  const v = rows.map(obj).filter((x) => x != null);
  const o = rows.map((r) => Number(r.open_ret)).filter(Number.isFinite);
  const c = rows.map((r) => Number(r.close_ret)).filter(Number.isFinite);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const win = (a) => (a.length ? (a.filter((x) => x > 0).length / a.length) * 100 : null);
  return { n: v.length, days: new Set(rows.map((r) => r.as_of_date)).size, avg: mean(v), open: mean(o), close: mean(c), openWin: win(o), closeWin: win(c) };
}

/** 특성 구간 — 새 기법 후보를 찾는 데 쓴다 */
const BUCKETS = [
  { key: "gapPct", label: "시가 갭", cuts: [-1, 0, 1, 3, 6] , unit: "%" },
  { key: "closePosition", label: "종가위치", cuts: [0.6, 0.75, 0.9], unit: "" },
  { key: "changePct", label: "당일 등락", cuts: [3, 5, 8, 12], unit: "%" },
  { key: "volumeRatio", label: "거래량비", cuts: [100, 150, 200, 300], unit: "%" },
  { key: "marketCapEok", label: "시총", cuts: [3000, 10000, 30000, 100000], unit: "억" },
  { key: "turnoverPct", label: "회전율", cuts: [2, 5, 10], unit: "%" },
  { key: "r5", label: "5일 수익", cuts: [0, 10, 20, 40], unit: "%" },
  { key: "majorNetBuyEok", label: "외인+기관 순매수", cuts: [0, 20, 100], unit: "억" },
  { key: "disparity5", label: "5일선 이격", cuts: [100, 103, 106, 110], unit: "" },
];
function bucketLabel(b, i) {
  const c = b.cuts;
  if (i === 0) return `${b.label} ${c[0]}${b.unit} 미만`;
  if (i === c.length) return `${b.label} ${c[c.length - 1]}${b.unit} 이상`;
  return `${b.label} ${c[i - 1]}~${c[i]}${b.unit}`;
}

async function learn() {
  const since = (() => { let d = krx.seoulYmd(); for (let i = 0; i < WINDOW_DAYS; i++) d = krx.prevTradingDay(d); return d; })();
  const res = await sb(`close_signal_outcomes?as_of_date=gte.${since}&select=as_of_date,code,name,rank,strategies,features,open_ret,close_ret&limit=20000`);
  const rows = await res.json();
  const days = new Set(rows.map((r) => r.as_of_date)).size;
  const base = stats(rows);
  console.log(`[learn] 표본 ${rows.length}건 · ${days}거래일 · 기준 평균 ${r2(base.avg)}%`);

  const prev = existsSync(WEIGHTS_PATH) ? JSON.parse(readFileSync(WEIGHTS_PATH, "utf8")) : { weights: {} };
  const weights = {};
  const table = [];
  for (const s of STRATEGIES) {
    const hit = rows.filter((r) => (r.strategies || []).includes(s.key));
    const st = stats(hit);
    const old = Number(prev.weights?.[s.key] ?? 1);
    const enough = st.n >= MIN_N && st.days >= MIN_DAYS;
    let target = 1, note = "표본 부족 — 유지";
    if (enough && base.avg != null) {
      const lift = st.avg - base.avg;
      const shrunk = lift * (st.n / (st.n + SHRINK_K));
      target = Math.min(W_MAX, Math.max(W_MIN, 1 + LIFT_TO_WEIGHT * shrunk));
      note = `평균 대비 ${lift >= 0 ? "+" : ""}${r2(lift)}%p`;
    }
    const next = enough ? Math.min(old + STEP, Math.max(old - STEP, target)) : old;
    weights[s.key] = Math.round(next * 100) / 100;
    table.push({ key: s.key, label: s.label, ...st, old, next: weights[s.key], note, enough });
  }

  // 새 기법 후보: 특성 구간 중 표본이 충분하고 평균보다 확실히 나은 곳
  const cands = [];
  for (const b of BUCKETS) {
    const groups = Array.from({ length: b.cuts.length + 1 }, () => []);
    for (const r of rows) {
      const v = r.features && r.features[b.key];
      if (v == null) continue;
      let i = b.cuts.findIndex((c) => v < c);
      if (i < 0) i = b.cuts.length;
      groups[i].push(r);
    }
    groups.forEach((g, i) => {
      const st = stats(g);
      if (st.n >= MIN_N && st.days >= Math.min(MIN_DAYS, days) && base.avg != null) cands.push({ label: bucketLabel(b, i), ...st, lift: st.avg - base.avg });
    });
  }
  cands.sort((a, b) => b.lift - a.lift);
  const good = cands.filter((c) => c.lift >= 0.5).slice(0, 5);
  const bad = cands.filter((c) => c.lift <= -0.5).sort((a, b) => a.lift - b.lift).slice(0, 3);

  const top5 = stats(rows.filter((r) => r.rank != null));

  const out = {
    updatedAt: new Date().toISOString(),
    window: { since, days, samples: rows.length },
    objective: "익일 (시가 매도 + 종가 매도) / 2",
    rules: { MIN_N, MIN_DAYS, SHRINK_K, STEP, W_MIN, W_MAX, LIFT_TO_WEIGHT },
    baseline: { avg: r2(base.avg), open: r2(base.open), close: r2(base.close) },
    weights,
    detail: table.map((t) => ({ key: t.key, n: t.n, avg: r2(t.avg), open: r2(t.open), close: r2(t.close), openWin: r2(t.openWin), closeWin: r2(t.closeWin), weight: t.next })),
  };

  const fmt = (v) => (v == null ? "-" : `${v > 0 ? "+" : ""}${r2(v)}%`);
  const lines = [
    `🧠 *종가시그널 주간 학습 보고* (${krx.seoulYmd()})`,
    `표본 ${rows.length}건 · ${days}거래일 · 필터 통과 후보 전체 기준`,
    ...(days < MIN_DAYS ? [`⏳ 기록 ${days}/${MIN_DAYS}거래일 — 가중치 자동 조정은 ${MIN_DAYS}거래일부터 시작합니다(지금은 관찰만).`] : []),
    `후보 평균: 시가 ${fmt(base.open)} / 종가 ${fmt(base.close)}`,
    `실제 선정 5종목: 시가 ${fmt(top5.open)} / 종가 ${fmt(top5.close)} (${top5.n}건)`,
    "",
    "*기법별 성적 → 가중치*",
    ...table.sort((a, b) => (b.avg ?? -99) - (a.avg ?? -99)).map((t) =>
      `• ${t.label}: ${t.n}건 · 시가 ${fmt(t.open)}(승 ${t.openWin == null ? "-" : Math.round(t.openWin)}%) · 종가 ${fmt(t.close)} → ${t.old === t.next ? `${t.next} 유지` : `${t.old}→*${t.next}*`}${t.enough ? "" : ` (판단 보류: ${t.days}/${MIN_DAYS}일)`}`),
    "",
    good.length ? "*새 기법 후보 (평균보다 +0.5%p 이상)*" : "*새 기법 후보*: 아직 뚜렷한 구간 없음",
    ...good.map((c) => `• ${c.label}: ${c.n}건 · 시가 ${fmt(c.open)} / 종가 ${fmt(c.close)} (평균 대비 ${fmt(c.lift)}p)`),
    ...(bad.length ? ["", "*피해야 할 구간*", ...bad.map((c) => `• ${c.label}: ${c.n}건 · 평균 대비 ${fmt(c.lift)}p`)] : []),
    "",
    "가중치는 다음 스캔부터 자동 적용됩니다. 새 기법 후보를 정식 기법으로 넣으려면 Claude에게 \"후보 기법 추가해줘\"라고 요청하세요.",
  ];
  const text = lines.join("\n");
  console.log(text);

  if (DRY) return;
  writeFileSync(WEIGHTS_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  const token = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (token && chat) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), parse_mode: "Markdown", disable_web_page_preview: true }),
    });
    if (!r.ok) console.warn("[learn] 텔레그램 실패", r.status, (await r.text()).slice(0, 200));
  }
}

if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음");
(MODE === "learn" ? learn() : collect()).catch((e) => { console.error("[learn] 실패", e); process.exit(1); });
