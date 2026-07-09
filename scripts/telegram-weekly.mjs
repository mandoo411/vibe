#!/usr/bin/env node

import {
  addDaysYmd,
  companyName,
  dayKo,
  eventTitle,
  formatDateKo,
  isHighImpact,
  mdText,
  mondayYmdFor,
  readJson,
  sendTelegramMessage,
  seoulYmd,
  SITE_URL,
} from "./telegram-utils.mjs";

const DATA_PATH = process.env.WEEKLY_SCHEDULE_PATH || "data/weekly-schedule.json";

function targetMonday() {
  if (process.env.WEEK_MONDAY && /^\d{4}-\d{2}-\d{2}$/.test(process.env.WEEK_MONDAY)) {
    return mondayYmdFor(process.env.WEEK_MONDAY);
  }
  return mondayYmdFor(seoulYmd());
}

function rowsThisWeek(rows, monday, friday) {
  return rows.filter((row) => row?.date >= monday && row?.date <= friday);
}

function formatEventLine(row) {
  const [, , day] = row.date.split("-");
  const label = `${dayKo(row.date)} ${Number(day)}일`;
  return `- ${label}: ${mdText(eventTitle(row))}`;
}

function formatEarningLine(row) {
  const [, , day] = row.date.split("-");
  const label = `${dayKo(row.date)} ${Number(day)}일`;
  const name = mdText(`${row.symbol || ""}${companyName(row) && row.symbol !== companyName(row) ? ` ${companyName(row)}` : ""}`.trim());
  return `- ${label}: ${name} 실적발표`;
}

function buildMessage(data) {
  const monday = targetMonday();
  const friday = addDaysYmd(monday, 4);
  const highEvents = rowsThisWeek(Array.isArray(data?.economicCalendar) ? data.economicCalendar : [], monday, friday)
    .filter(isHighImpact)
    .sort((a, b) => `${a.date} ${a.time || ""}`.localeCompare(`${b.date} ${b.time || ""}`))
    .slice(0, 8);
  // 2026-07-10: "earningsCalendar"는 weekly-schedule.json에 존재한 적 없는 필드명 — 실제
  // 필드는 krEarnings. 이 오타 때문에 주간 텔레그램 메시지에서 실적 일정이 항상 빠졌었다.
  const earnings = rowsThisWeek(Array.isArray(data?.krEarnings) ? data.krEarnings : [], monday, friday)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(0, 5);

  const lines = [
    "📋 *TotalMoney AI - 이번주 주요 일정*",
    `${formatDateKo(monday, { compact: true })} ~ ${formatDateKo(friday, { year: false, compact: true })}`,
    "",
    "📌 *핵심 이벤트*",
  ];

  const eventLines = [...earnings.map(formatEarningLine), ...highEvents.map(formatEventLine)].slice(0, 10);
  lines.push(...(eventLines.length ? eventLines : ["- 이번주 주요 일정 준비 중"]));
  lines.push("", `🔗 전체보기: ${SITE_URL}/weekly-market.html`);
  return lines.join("\n");
}

async function main() {
  const data = await readJson(DATA_PATH);
  const message = buildMessage(data);
  await sendTelegramMessage(message);
  console.log("Sent weekly schedule Telegram message.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
