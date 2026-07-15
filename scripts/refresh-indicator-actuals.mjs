#!/usr/bin/env node
/**
 * 오늘 날짜의 HIGH 등급 경제지표 중 발표시간이 5분 이상 지났는데 아직 실제수치(actual)가
 * 비어있는 항목을 찾아, investing.com/forexfactory에서 재수집해 채워 넣는다.
 * 채워진 항목이 있으면 data/weekly-schedule.json에 반영(커밋은 워크플로우 쪽에서 처리)하고,
 * 그 항목들만 텔레그램 속보로 발송한다(이미 이전 실행에서 보낸 항목은 다시 보내지 않음 —
 * "이번 실행에서 새로 채워진 것"만 골라내는 방식이라 자체적으로 중복 발송이 안 된다).
 *
 * 5분 이상 지나도 estimate/previous가 둘 다 비어있는 항목(코스피200 옵션 만기일 같은 날짜성
 * 이벤트, Fed 의장 증언/연설처럼 애초에 숫자 실제치가 없는 이벤트)은 "채울 실제수치 자체가
 * 없는" 항목이라 폴링 대상에서 자동으로 제외된다.
 */
import { createRequire } from "node:module";
import {
  countryFlag,
  isHighImpact,
  mdText,
  readJson,
  sendTelegramMessage,
  seoulYmd,
} from "./telegram-utils.mjs";
import { normalizeCountryCode } from "./economic-calendar-util.mjs";
import { fetchEconomicCalendar } from "./investing-calendar.mjs";
import fs from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { tmEventLabelText } = require("../assets/indicator-ko.js");

const DATA_PATH = process.env.WEEKLY_SCHEDULE_PATH || "data/weekly-schedule.json";
const MIN_MINUTES_AFTER_RELEASE = 5;

function seoulNowMinutes() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const mm = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return hh * 60 + mm;
}

function rowMinutes(time) {
  const m = String(time || "").match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function isEligibleForActualCheck(row, today, nowMin) {
  if (!row || row.date !== today) return false;
  if (!isHighImpact(row)) return false;
  const cc = normalizeCountryCode(row.country);
  if (cc !== "US" && cc !== "KR") return false;
  if (row.actual != null && String(row.actual).trim() !== "") return false;
  // 숫자 실제치 자체가 없는 이벤트(만기일, 연설/증언 등)는 estimate/previous가 둘 다 비어있다.
  const hasNumericTarget = String(row.estimate || "").trim() !== "" || String(row.previous || "").trim() !== "";
  if (!hasNumericTarget) return false;
  const rm = rowMinutes(row.time);
  if (rm == null) return false;
  return nowMin - rm >= MIN_MINUTES_AFTER_RELEASE;
}

function normalizeEventKey(row) {
  return `${row.date}|${normalizeCountryCode(row.country)}|${String(row.event || "").trim().toLowerCase()}`;
}

function surpriseLabel(actual, estimate) {
  const a = Number(String(actual).replace(/[^0-9.-]/g, ""));
  const e = Number(String(estimate).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(a) || !Number.isFinite(e)) return "";
  if (a > e) return "⬆️ (예측 상회)";
  if (a < e) return "⬇️ (예측 하회)";
  return "(예측 부합)";
}

function translatedTitle(row) {
  try {
    return tmEventLabelText(row);
  } catch {
    return row?.event || "경제지표";
  }
}

async function sendBreakingAlert(row) {
  const flag = countryFlag(row.country);
  const title = mdText(translatedTitle(row));
  const label = surpriseLabel(row.actual, row.estimate);
  const message = [
    "🚨 *속보 - 경제지표 발표*",
    `${flag} ${title}`,
    `- 예측: ${row.estimate || "-"}`,
    `- 실제: ${row.actual}${label ? ` ${label}` : ""}`,
  ].join("\n");
  await sendTelegramMessage(message);
}

async function main() {
  const today = seoulYmd();
  const nowMin = seoulNowMinutes();
  const raw = await fs.readFile(path.resolve(DATA_PATH), "utf8");
  const data = JSON.parse(raw);
  const rows = Array.isArray(data.economicCalendar) ? data.economicCalendar : [];

  const pending = rows.filter((row) => isEligibleForActualCheck(row, today, nowMin));
  if (!pending.length) {
    console.log("대기 중인 지표 없음(오늘 발표 예정 HIGH 지표가 없거나 이미 모두 채워짐) — 종료.");
    return;
  }
  console.log(`실제수치 확인 대상 ${pending.length}건: ${pending.map((r) => r.event).join(", ")}`);

  const fresh = await fetchEconomicCalendar(today, today);
  if (!fresh.length) {
    console.log("재수집 실패 또는 0건 — 이번 실행에서는 업데이트 없이 종료.");
    return;
  }
  const freshByKey = new Map(fresh.map((r) => [normalizeEventKey(r), r]));

  const updated = [];
  for (const row of pending) {
    const match = freshByKey.get(normalizeEventKey(row));
    if (!match) continue;
    const actual = String(match.actual || "").trim();
    if (!actual) continue;
    row.actual = actual;
    if (!String(row.previous || "").trim() && String(match.previous || "").trim()) {
      row.previous = match.previous;
    }
    updated.push(row);
  }

  if (!updated.length) {
    console.log("재수집은 성공했지만 아직 실제수치가 반영되지 않음 — 다음 실행에서 재시도.");
    return;
  }

  await fs.writeFile(path.resolve(DATA_PATH), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`실제수치 ${updated.length}건 갱신: ${updated.map((r) => `${r.event}=${r.actual}`).join(", ")}`);

  for (const row of updated) {
    try {
      await sendBreakingAlert(row);
      console.log(`텔레그램 속보 발송: ${row.event}`);
    } catch (error) {
      console.log(`❌ 텔레그램 속보 발송 실패(${row.event}): ${error instanceof Error ? error.message : error}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
