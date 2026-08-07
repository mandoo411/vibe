#!/usr/bin/env node
/**
 * 사이트 정기 자동 점검 (health check).
 *
 * 배경: totalmoney.kr에서 간헐적으로 발생하는 오류(브리핑 지수 왜곡, 실시간시세
 * "시세 조회 실패", 글로벌랭킹 시총 왜곡, 인스타 발행 실패 등)를 사용자가 매번
 * 화면을 눌러보며 수동으로 발견해왔다. 이 스크립트는 그 확인 작업을 대신해서
 * 주요 라이브 엔드포인트/데이터 파일을 점검하고, 이상이 있을 때만 텔레그램
 * 개인 DM(TELEGRAM_ADMIN_CHAT_ID)으로 즉시 알림을 보낸다.
 *
 * 정상일 때는 조용히 넘어간다(장중 1시간 간격 등 자주 도는 점검이라, 매번 알림을
 * 보내면 스팸이 된다). 같은 문제가 계속되면 3시간마다 한 번씩 리마인더를 보낸다
 * (그래야 "알림이 안 오길래 방치됐나" 싶은 걱정 없이, 살아있다는 걸 알 수 있다).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { sendTelegramMessage, seoulYmd } from "./telegram-utils.mjs";

const SITE_URL = String(process.env.SITE_URL || "https://www.totalmoney.kr").replace(/\/+$/, "");
const STATE_PATH = path.resolve("generated/health-check/state.json");
const REALERT_INTERVAL_MS = 3 * 60 * 60 * 1000; // 같은 문제 지속 시 3시간마다 재알림
const FETCH_TIMEOUT_MS = 15000;
const SANITY_PCT_THRESHOLD = 15; // 지수/개별종목 등락률이 이 값을 넘으면 데이터 오류 의심

async function fetchJson(pathname) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${SITE_URL}${pathname}`, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; TotalMoneyHealthCheck/1.0)" },
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // JSON이 아니면 아래에서 별도 처리
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (error) {
    return { ok: false, status: 0, json: null, text: "", error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

const issues = []; // { code, message }
function fail(code, message) {
  issues.push({ code, message });
}

// 1) 글로벌랭킹(시가총액 TOP100) — 응답 자체 + 삼성전자/SK하이닉스 등락률 이상치
async function checkWorldMarket() {
  const r = await fetchJson("/api/world-market?type=marketCap&sparks=0");
  if (!r.ok || !r.json) {
    fail("world-market-down", `글로벌랭킹 API 응답 실패 (status=${r.status}${r.error ? `, ${r.error}` : ""})`);
    return;
  }
  const rows = Array.isArray(r.json.rows) ? r.json.rows : [];
  if (rows.length < 80) {
    fail("world-market-thin", `글로벌랭킹 데이터가 비정상적으로 적음 (${rows.length}개)`);
  }
  for (const row of rows) {
    if (!/삼성|하이닉스/.test(row.name || "")) continue;
    const pct = Number(row.changePct);
    if (Number.isFinite(pct) && Math.abs(pct) > SANITY_PCT_THRESHOLD) {
      fail(
        "world-market-outlier",
        `글로벌랭킹 ${row.name} 등락률 이상치: ${pct}% (±${SANITY_PCT_THRESHOLD}% 초과 — 시총/등락률 계산 오류 의심)`
      );
    }
  }
}

// 2) 실시간시세 개별 종목 조회 (예: 삼성전자) — "시세 조회 실패" 재발 감지
async function checkRealtimeQuote() {
  const r = await fetchJson("/api/stock-analysis?q=005930&quoteOnly=1");
  if (!r.ok || r.json?.error) {
    fail(
      "realtime-quote-down",
      `실시간시세 조회 실패 (종목: 삼성전자, status=${r.status}${r.json?.error ? `, error=${r.json.error}` : ""}) — KIS 토큰/연결 확인 필요`
    );
  }
}

// 3) 모닝브리핑 — 스크립트 자체 sanity check(errors 배열)가 오늘 자 데이터에 뭔가 잡았는지 확인
function checkMorningBriefingErrors() {
  const briefing = readJsonSafe(path.resolve("data/morning-briefing.json"));
  if (!briefing) return; // 파일이 없으면 별도 체크 없이 통과(레포에 항상 있어야 하는 파일은 아님)
  const today = seoulYmd();
  const updatedYmd = String(briefing.updatedAt || "").slice(0, 10);
  if (updatedYmd !== today) return; // 오늘 발행분이 아니면 스킵(어제자 파일에 대해 반복 알림 방지)
  const errors = Array.isArray(briefing.errors) ? briefing.errors : [];
  for (const message of errors) {
    fail("morning-briefing-sanity", `모닝브리핑 데이터 이상: ${message}`);
  }
}

// 4) 마감시황(daily-market.json) — 오늘자 지수 등락률 이상치
function checkDailyMarketIndexes() {
  const daily = readJsonSafe(path.resolve("data/daily-market.json"));
  if (!daily?.days) return;
  const today = seoulYmd();
  const todayEntry = daily.days[today];
  if (!todayEntry?.indexes) return; // 아직 오늘자가 없으면(장중/장전) 스킵
  for (const [key, label] of [["kospi", "코스피"], ["kosdaq", "코스닥"]]) {
    const pct = Number(todayEntry.indexes[key]?.changePercent);
    if (Number.isFinite(pct) && Math.abs(pct) > SANITY_PCT_THRESHOLD) {
      fail("daily-market-outlier", `마감시황 ${label} 등락률 이상치: ${pct}% (±${SANITY_PCT_THRESHOLD}% 초과)`);
    }
  }
}

// 5) 인스타 발행 스탬프 — 평일 발행 시각을 한참 지났는데 오늘 발행 기록이 없으면 경고
function checkInstagramPublishStamps() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const weekday = kst.getUTCDay(); // 0=일 6=토
  const hour = kst.getUTCHours();
  const today = seoulYmd();

  const slots = [
    // { slot, label, publishHourKst, weekdaysOnly }
    { slot: "morning", label: "모닝브리핑", publishHourKst: 8, weekdaysOnly: true },
    { slot: "closing", label: "마감시황", publishHourKst: 17, weekdaysOnly: true },
  ];
  for (const { slot, label, publishHourKst, weekdaysOnly } of slots) {
    if (weekdaysOnly && (weekday === 0 || weekday === 6)) continue;
    if (hour < publishHourKst + 1) continue; // 발행 예정 시각+1시간 전엔 아직 스킵
    const stampPath = path.resolve(`generated/${slot}/last-published-date.txt`);
    if (!existsSync(stampPath)) {
      fail("instagram-stamp-missing", `인스타 ${label} 발행 기록 파일이 없음`);
      continue;
    }
    const stamped = readFileSync(stampPath, "utf8").trim();
    if (stamped !== today) {
      fail(
        "instagram-not-published",
        `인스타 ${label}이(가) 오늘(${today}) 아직 발행되지 않음 (마지막 발행: ${stamped || "기록 없음"})`
      );
    }
  }
}

function loadState() {
  return readJsonSafe(STATE_PATH) || { lastSignature: null, lastAlertAt: null };
}

function saveState(state) {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function signatureOf(issueList) {
  return issueList.map((i) => i.code).sort().join(",");
}

async function main() {
  await Promise.all([checkWorldMarket(), checkRealtimeQuote()]);
  checkMorningBriefingErrors();
  checkDailyMarketIndexes();
  checkInstagramPublishStamps();

  const state = loadState();
  const nowIso = new Date().toISOString();

  if (issues.length === 0) {
    console.log("[health-check] 이상 없음");
    if (state.lastSignature) {
      // 직전엔 문제가 있었는데 이번엔 정상 — 복구 알림
      try {
        await sendTelegramMessage(
          `✅ *TotalMoney 점검 정상화*\n이전에 감지된 문제가 해소됐어요.\n(${nowIso})`,
          { chatId: process.env.TELEGRAM_ADMIN_CHAT_ID }
        );
      } catch (error) {
        console.warn("[health-check] recovery notice failed:", error.message);
      }
    }
    saveState({ lastSignature: null, lastAlertAt: null });
    return;
  }

  const signature = signatureOf(issues);
  const sameAsLast = signature === state.lastSignature;
  const dueForReminder =
    !state.lastAlertAt || Date.now() - new Date(state.lastAlertAt).getTime() >= REALERT_INTERVAL_MS;

  console.log(`[health-check] 이상 ${issues.length}건 감지:`, issues);

  if (!sameAsLast || dueForReminder) {
    const lines = issues.map((i, idx) => `${idx + 1}. ${i.message}`).join("\n");
    const text = `🚨 *TotalMoney 점검 알림*\n\n${lines}\n\n(${nowIso})`;
    try {
      await sendTelegramMessage(text, { chatId: process.env.TELEGRAM_ADMIN_CHAT_ID });
      saveState({ lastSignature: signature, lastAlertAt: nowIso });
    } catch (error) {
      console.error("[health-check] Telegram 알림 발송 실패:", error.message);
      // 발송 실패해도 state는 갱신하지 않아 다음 실행에서 재시도되게 한다.
      process.exitCode = 1;
    }
  } else {
    console.log("[health-check] 동일 문제 지속 중 — 리마인더 주기 전이라 알림 생략");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
