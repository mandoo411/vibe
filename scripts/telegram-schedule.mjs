#!/usr/bin/env node

import {
  companyName,
  countryFlag,
  eventTitle,
  fmtNumber,
  formatDateKo,
  isHighImpact,
  mdText,
  readJson,
  sendTelegramMessage,
  seoulYmd,
  SITE_URL,
} from "./telegram-utils.mjs";

const DATA_PATH = process.env.WEEKLY_SCHEDULE_PATH || "data/weekly-schedule.json";

function targetYmd() {
  return process.env.TARGET_DATE && /^\d{4}-\d{2}-\d{2}$/.test(process.env.TARGET_DATE)
    ? process.env.TARGET_DATE
    : seoulYmd();
}

function eventsForToday(data, ymd) {
  return (Array.isArray(data?.economicCalendar) ? data.economicCalendar : [])
    .filter((row) => row?.date === ymd && isHighImpact(row))
    .sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
}

function earningsForToday(data, ymd) {
  // 2026-07-10: data/weekly-schedule.json에는 "earningsCalendar" 필드가 존재한 적이
  // 없다(실제 필드명은 krEarnings) — 이 버그 때문에 실적발표가 있는 날에도 텔레그램
  // 일간 메시지에는 항상 "오늘 예정된 주요 실적발표 없음"만 나갔었다.
  return (Array.isArray(data?.krEarnings) ? data.krEarnings : [])
    .filter((row) => row?.date === ymd)
    .slice(0, 8);
}

function formatEstimate(value) {
  if (value == null || value === "") return "-";
  return fmtNumber(value, Number(value) % 1 === 0 ? 0 : 1);
}

function formatEvent(row) {
  const time = row?.time ? `${row.time} ` : "";
  const flag = countryFlag(row?.country);
  const estimate = formatEstimate(row?.estimate);
  return `- ${time}${flag} ${mdText(eventTitle(row))} 예측: ${estimate}`;
}

function buildDailyMessage(data, ymd) {
  const events = eventsForToday(data, ymd);
  const earnings = earningsForToday(data, ymd);
  const lines = [
    "📅 *TotalMoney AI - 오늘 경제일정*",
    formatDateKo(ymd),
    "",
    "⚠️ *주요 지표 (HIGH)*",
  ];

  lines.push(...(events.length ? events.map(formatEvent) : ["- 오늘 예정된 HIGH 지표 없음"]));
  lines.push("", "📊 *실적발표*");
  if (earnings.length) {
    earnings.forEach((row) => {
      const symbol = row?.symbol ? `${row.symbol} ` : "";
      lines.push(`- ${mdText(symbol + companyName(row))}`);
    });
  } else {
    lines.push("- 오늘 예정된 주요 실적발표 없음");
  }
  lines.push("", `🔗 전체보기: ${SITE_URL}/weekly-market.html`);
  return lines.join("\n");
}

function surpriseLabel(actual, estimate) {
  const a = Number(actual);
  const e = Number(estimate);
  if (!Number.isFinite(a) || !Number.isFinite(e)) return "";
  if (a > e) return "⬆️ (예측 상회)";
  if (a < e) return "⬇️ (예측 하회)";
  return "(예측 부합)";
}

function buildBreakingMessages(data, ymd) {
  return eventsForToday(data, ymd)
    .filter((row) => row.actual !== "" && row.actual != null)
    .map((row) => {
      const flag = countryFlag(row.country);
      const title = mdText(eventTitle(row));
      const estimate = formatEstimate(row.estimate);
      const actual = formatEstimate(row.actual);
      const label = surpriseLabel(row.actual, row.estimate);
      return [
        "🚨 *속보 - 경제지표 발표*",
        `${flag} ${title}`,
        `- 예측: ${estimate}`,
        `- 실제: ${actual}${label ? ` ${label}` : ""}`,
      ].join("\n");
    });
}

async function main() {
  const data = await readJson(DATA_PATH);
  const ymd = targetYmd();
  const mode = process.env.TELEGRAM_SCHEDULE_MODE || process.argv[2] || "daily";
  if (mode === "breaking") {
    const messages = buildBreakingMessages(data, ymd);
    if (!messages.length) {
      console.log("No breaking HIGH indicator result to send.");
      return;
    }
    for (const message of messages) await sendTelegramMessage(message);
    console.log(`Sent ${messages.length} breaking schedule Telegram message(s).`);
    return;
  }

  await sendTelegramMessage(buildDailyMessage(data, ymd));
  console.log("Sent daily schedule Telegram message.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
