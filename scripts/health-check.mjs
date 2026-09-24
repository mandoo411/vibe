#!/usr/bin/env node
/**
 * 운영 점검봇 (매시 5분) — 이상이 있을 때만 운영자 텔레그램 DM으로 알린다.
 *
 * 2026-09-24 전면 재정리. 이전 버전은 2026-08부터 사고가 날 때마다 점검을 하나씩 덧붙여서
 *  - 휴장일을 몰라 추석에 "마감시황 미발행" 알림을 계속 보냈고(주말만 걸렀다),
 *  - 마감 리포트 누락을 워치독(daily-report-watchdog)과 이 스크립트가 둘 다 알렸고,
 *  - 이미 GitHub Actions로 옮긴 마감 리포트를 "Cowork 예약작업 확인"이라고 안내했고,
 *  - 새로 생긴 종가시그널(스캔·성과 기록)은 아무도 지켜보지 않았다.
 *
 * 원칙
 *  1. "오늘 무엇이 있어야 하는가"는 아래 CHECKS 표 한 곳에 적는다. 날짜 판단은 lib/krx-calendar.js.
 *     - always  : 매시간 (서비스가 살아 있나)
 *     - weekday : 평일(미국장 기반 — 한국 휴장일에도 나간다: 아침 브리핑·아침 카드)
 *     - trading : 한국 증시 거래일만 (마감 카드·종가시그널)
 *     - saturday: 토요일만 (주간 랭킹 카드)
 *  2. 한 가지 문제는 한 곳에서만 알린다. 마감 리포트 누락 = 워치독 담당(16:40 1차 / 19:00 최종).
 *     여기서는 마감 카드가 "리포트는 있는데 발행이 안 된" 경우만 본다.
 *  3. 같은 문제가 계속되면 3시간마다 한 번 다시 알린다. 해소되면 "정상화" 한 번.
 *
 * 전체 점검 시퀀스(시간표)는 docs/운영점검_시퀀스.md 참고.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { sendTelegramMessage } from "./telegram-utils.mjs";

const require = createRequire(import.meta.url);
const krx = require("../lib/krx-calendar.js");

const SITE_URL = String(process.env.SITE_URL || "https://www.totalmoney.kr").replace(/\/+$/, "");
const STATE_PATH = path.resolve("generated/health-check/state.json");
const REALERT_INTERVAL_MS = 3 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const SANITY_PCT_THRESHOLD = 15; // 지수/개별종목 등락률이 이 값을 넘으면 데이터 오류 의심

/* ───────── 시각 ───────── */
function kstNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  const hm = Number(parts.hour) * 60 + Number(parts.minute);
  return { ymd, hm, label: `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`, dow: new Date(`${ymd}T12:00:00Z`).getUTCDay() };
}
const NOW = kstNow();
const at = (h, m = 0) => NOW.hm >= h * 60 + m;

/* ───────── 공통 도구 ───────── */
async function fetchJson(pathname) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${SITE_URL}${pathname}`, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; TotalMoneyHealthCheck/2.0)" },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json };
  } catch (error) {
    return { ok: false, status: 0, json: null, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}
function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(path.resolve(p), "utf8")); } catch { return null; }
}
function readStamp(folder) {
  const p = path.resolve(`generated/${folder}/last-published-date.txt`);
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

const issues = []; // { code, area, message }
const fail = (code, area, message) => issues.push({ code, area, message });

/* ───────── 점검 항목 ─────────
 * when: always | weekday | trading | saturday
 * from: 이 시각(KST, [시,분]) 이후에만 본다 — 예정 시각 + 여유
 */
const CHECKS = [
  {
    code: "world-market", area: "사이트", when: "always",
    desc: "글로벌랭킹 API 응답 · 종목 수 · 삼성/하이닉스 등락률 이상치",
    async run() {
      const r = await fetchJson("/api/world-market?type=marketCap&sparks=0");
      if (!r.ok || !r.json) return fail("world-market-down", "사이트", `글로벌랭킹 API 응답 실패 (status=${r.status}${r.error ? `, ${r.error}` : ""})`);
      const rows = Array.isArray(r.json.rows) ? r.json.rows : [];
      if (rows.length < 80) fail("world-market-thin", "사이트", `글로벌랭킹 종목 수가 비정상적으로 적음 (${rows.length}개)`);
      for (const row of rows) {
        if (!/삼성|하이닉스/.test(row.name || "")) continue;
        const pct = Number(row.changePct);
        if (Number.isFinite(pct) && Math.abs(pct) > SANITY_PCT_THRESHOLD) {
          fail("world-market-outlier", "사이트", `글로벌랭킹 ${row.name} 등락률 ${pct}% — 계산 오류 의심`);
        }
      }
    },
  },
  {
    code: "realtime-quote", area: "사이트", when: "always",
    desc: "실시간시세 개별 종목 조회(삼성전자) — KIS 토큰·연결",
    async run() {
      const r = await fetchJson("/api/stock-analysis?q=005930&quoteOnly=1");
      if (!r.ok || r.json?.error) {
        fail("realtime-quote-down", "사이트", `실시간시세 조회 실패 (status=${r.status}${r.json?.error ? `, ${r.json.error}` : ""}) — KIS 토큰/연결 확인 필요`);
      }
    },
  },
  {
    code: "package-json", area: "인프라", when: "always",
    desc: "package.json 문법 — 깨지면 npm ci 쓰는 워크플로 전부 실패",
    run() {
      try { JSON.parse(readFileSync(path.resolve("package.json"), "utf8")); }
      catch (e) { fail("package-json-invalid", "인프라", `package.json이 깨졌습니다 — 자동화 워크플로 대부분이 실패 중일 수 있음: ${e.message}`); }
    },
  },
  {
    code: "krx-calendar", area: "인프라", when: "always", from: [9, 0], until: [9, 59],
    desc: "휴장일 달력 유지보수(11월부터 내년 달력 확인) — 하루 한 번 09시대에만",
    run() {
      const w = krx.calendarWarning(NOW.ymd);
      if (w) fail("krx-calendar", "인프라", w);
    },
  },
  {
    code: "morning-data", area: "아침", when: "weekday", from: [8, 30],
    desc: "아침 브리핑 수치 수집 자체 점검(errors 배열)",
    run() {
      const b = readJsonSafe("data/morning-briefing.json");
      if (!b || String(b.updatedAt || "").slice(0, 10) !== NOW.ymd) return;
      for (const m of Array.isArray(b.errors) ? b.errors : []) fail("morning-briefing-sanity", "아침", `아침 브리핑 데이터 이상: ${m}`);
    },
  },
  {
    code: "morning-ai", area: "아침", when: "weekday", from: [9, 0],
    desc: "아침 브리핑 AI 분석 발행(08:03 Cowork 예약작업) — 발행 기록 파일",
    run() {
      const s = readStamp("morning-briefing");
      if (s !== NOW.ymd) fail("morning-briefing-not-published", "아침", `아침 브리핑 AI 분석 미발행 (마지막: ${s || "기록 없음"}) — PC의 Cowork 예약작업(totalmoney-morning-briefing)이 안 돈 것으로 보임`);
    },
  },
  {
    code: "morning-carousel", area: "아침", when: "weekday", from: [9, 0],
    desc: "인스타 아침 카드(08:03) 발행 기록",
    run() {
      const s = readStamp("carousel-morning");
      if (s !== NOW.ymd) fail("instagram-morning-not-published", "아침", `인스타 아침 카드 미발행 (마지막: ${s || "없음"})`);
    },
  },
  {
    code: "close-signal-review", area: "종가시그널", when: "trading", from: [9, 40],
    desc: "직전 거래일 선정 5종목의 결과 기록(09:10 시가 → 15:45 종가 확정)",
    async run() {
      const r = await fetchJson("/api/analyze?feature=close-betting");
      if (!r.ok || !r.json) return fail("close-signal-api-down", "종가시그널", `종가시그널 API 응답 실패 (status=${r.status})`);
      const prev = krx.prevTradingDay(NOW.ymd);
      const y = r.json.yesterday;
      if (!y || y.asOfDate !== prev) {
        fail("close-signal-review-missing", "종가시그널", `${prev} 선정분 결과가 기록되지 않음 (마지막 기록: ${y ? y.asOfDate : "없음"}) — Close Betting Review 실행 확인 필요`);
      } else if (at(16, 10) && y.phase !== "close") {
        fail("close-signal-review-open-only", "종가시그널", `${prev} 선정분이 시가만 기록되고 15:45 종가 확정이 안 됨`);
      }
    },
  },
  {
    code: "close-signal-scan", area: "종가시그널", when: "trading", from: [15, 40],
    desc: "오늘 15:20 종가시그널 랭킹 생성",
    async run() {
      const r = await fetchJson("/api/analyze?feature=close-betting");
      if (!r.ok || !r.json) return; // API 장애는 위 항목이 알린다
      if (!r.json.ready || r.json.asOfDate !== NOW.ymd) {
        fail("close-signal-scan-missing", "종가시그널", `오늘(${NOW.ymd}) 15:20 종가시그널 랭킹이 없음 — Intraday Close Scan 실행 확인 필요`);
      }
    },
  },
  {
    code: "closing-data", area: "마감", when: "trading", from: [16, 0],
    desc: "마감시황 지수 등락률 이상치(±15%)",
    run() {
      const day = readJsonSafe("data/daily-market.json")?.days?.[NOW.ymd];
      if (!day?.indexes) return; // 리포트 누락은 워치독 담당
      for (const [k, label] of [["kospi", "코스피"], ["kosdaq", "코스닥"]]) {
        const pct = Number(day.indexes[k]?.changePercent);
        if (Number.isFinite(pct) && Math.abs(pct) > SANITY_PCT_THRESHOLD) fail("daily-market-outlier", "마감", `마감시황 ${label} 등락률 ${pct}% — 데이터 오류 의심`);
      }
    },
  },
  {
    code: "closing-carousel", area: "마감", when: "trading", from: [18, 30],
    desc: "인스타 마감 카드(17:30) 발행 — 리포트는 있는데 발행이 안 된 경우만",
    run() {
      const day = readJsonSafe("data/daily-market.json")?.days?.[NOW.ymd];
      const reportOk = String(day?.analysis || "").trim().length > 50 && Number.isFinite(Number(day?.indexes?.kospi?.close));
      if (!reportOk) return; // 리포트 자체가 없으면 워치독이 이미 알렸다
      const s = readStamp("carousel-v2");
      if (s !== NOW.ymd) fail("instagram-closing-not-published", "마감", `마감 리포트는 정상인데 인스타 마감 카드 미발행 (마지막: ${s || "없음"}) — Instagram Carousel v2 실행 확인 필요`);
    },
  },
  {
    code: "ranking-carousel", area: "주간", when: "saturday", from: [11, 30],
    desc: "인스타 주간 글로벌 랭킹 카드(토 10:30)",
    run() {
      const s = readStamp("carousel-ranking");
      if (s !== NOW.ymd) fail("instagram-ranking-not-published", "주간", `인스타 주간 랭킹 카드 미발행 (마지막: ${s || "없음"})`);
    },
  },
];

function applies(c) {
  const isWeekday = NOW.dow >= 1 && NOW.dow <= 5;
  if (c.when === "weekday" && !isWeekday) return false;
  if (c.when === "trading" && !krx.isTradingDay(NOW.ymd)) return false;
  if (c.when === "saturday" && NOW.dow !== 6) return false;
  if (c.from && !at(c.from[0], c.from[1])) return false;
  if (c.until && at(c.until[0], c.until[1] + 1)) return false;
  return true;
}

/* ───────── 알림 상태 ───────── */
function loadState() { return readJsonSafe(STATE_PATH) || { lastSignature: null, lastAlertAt: null }; }
function saveState(state) {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}
const signatureOf = (list) => list.map((i) => i.code).sort().join(",");

async function main() {
  if (process.argv.includes("--list")) {
    for (const c of CHECKS) console.log(`${c.when.padEnd(8)} ${c.from ? `${String(c.from[0]).padStart(2, "0")}:${String(c.from[1]).padStart(2, "0")}~` : "매시간"}  [${c.area}] ${c.desc}`);
    return;
  }
  const closed = krx.closedReason(NOW.ymd);
  const active = CHECKS.filter(applies);
  console.log(`[health-check] ${NOW.label} KST · ${closed ? `한국 증시 휴장(${closed})` : "거래일"} · 점검 ${active.length}/${CHECKS.length}개: ${active.map((c) => c.code).join(", ")}`);
  for (const c of active) {
    try { await c.run(); } catch (e) { console.warn(`[health-check] ${c.code} 점검 중 오류:`, e.message); }
  }

  if (process.env.HEALTH_CHECK_TEST_ALERT === "true") {
    fail("test-alert", "테스트", "헬스체크 텔레그램 알림 연결 테스트입니다 — 도착했으면 무시하세요.");
  }

  const state = loadState();
  const nowIso = new Date().toISOString();

  if (issues.length === 0) {
    console.log("[health-check] 이상 없음");
    if (state.lastSignature) {
      try {
        await sendTelegramMessage(`✅ *TotalMoney 점검 정상화*\n이전에 감지된 문제가 해소됐어요. (${NOW.label} KST)`, { chatId: process.env.TELEGRAM_ADMIN_CHAT_ID });
      } catch (e) { console.warn("[health-check] 정상화 알림 실패:", e.message); }
    }
    saveState({ lastSignature: null, lastAlertAt: null });
    return;
  }

  const signature = signatureOf(issues);
  const dueForReminder = !state.lastAlertAt || Date.now() - new Date(state.lastAlertAt).getTime() >= REALERT_INTERVAL_MS;
  console.log(`[health-check] 이상 ${issues.length}건:`, issues);
  if (signature === state.lastSignature && !dueForReminder) {
    console.log("[health-check] 같은 문제 지속 — 리마인더 주기 전이라 알림 생략");
    return;
  }
  const lines = issues.map((i) => `• [${i.area}] ${i.message}`).join("\n");
  const text = `🚨 *TotalMoney 점검 알림* (${NOW.label} KST${closed ? ` · 휴장일: ${closed}` : ""})\n\n${lines}`;
  try {
    await sendTelegramMessage(text, { chatId: process.env.TELEGRAM_ADMIN_CHAT_ID });
    saveState({ lastSignature: signature, lastAlertAt: nowIso });
  } catch (e) {
    console.error("[health-check] 텔레그램 발송 실패:", e.message);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
