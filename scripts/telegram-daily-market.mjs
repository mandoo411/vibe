#!/usr/bin/env node

import {
  fmtDelta,
  fmtNumber,
  fmtPct,
  formatDateKo,
  mdText,
  readJson,
  sendTelegramMessage,
  seoulYmd,
  SITE_URL,
  toNum,
} from "./telegram-utils.mjs";
import { collectTelegramMessages, telegramRowsForData } from "./telegram-channel-news.mjs";

const DATA_PATH = process.env.DAILY_MARKET_PATH || "data/daily-market.json";

function pickTargetDay(data) {
  const days = data?.days && typeof data.days === "object" ? data.days : {};
  const requested = process.env.TARGET_DATE;
  if (requested && days[requested]) return { ymd: requested, day: days[requested] };

  const today = seoulYmd();
  if (days[today]) return { ymd: today, day: days[today] };

  const keys = Object.keys(days)
    .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .sort()
    .reverse();
  const key = keys.find((k) => {
    const day = days[k];
    return day && (Array.isArray(day.indexes) || Array.isArray(day.topGainers) || day.summary);
  });
  return key ? { ymd: key, day: days[key] } : { ymd: today, day: {} };
}

function formatIndex(row) {
  const name = mdText(row?.name || "-");
  const value = row?.value != null ? String(row.value) : fmtNumber(row?.close ?? row?.price, 0);
  const change = fmtPct(row?.change ?? row?.changePct, 1);
  const points = fmtDelta(row?.changePoints ?? row?.prevDelta, 1);
  return `- ${name}: ${mdText(value)} ${change}${points ? ` (${points})` : ""}`;
}

function topGainers(day) {
  const rows = Array.isArray(day?.topGainers) && day.topGainers.length
    ? day.topGainers
    : Array.isArray(day?.notableStocks)
      ? day.notableStocks
      : [];
  return rows
    .filter((row) => row && row.name)
    .sort((a, b) => (toNum(b.change) ?? -Infinity) - (toNum(a.change) ?? -Infinity))
    .slice(0, 5);
}

function buildMessage(data) {
  const { ymd, day } = pickTargetDay(data);
  const indexes = Array.isArray(day.indexes) ? day.indexes.slice(0, 2) : [];
  const gainers = topGainers(day);

  const lines = [
    "📊 *TotalMoney AI - 장마감 리포트*",
    `📅 ${formatDateKo(ymd)}`,
    "",
    "📈 *오늘 증시*",
  ];

  if (indexes.length) {
    lines.push(...indexes.map(formatIndex));
  } else {
    lines.push("- 지수 데이터 준비 중");
  }

  lines.push("", "🔥 *상승률 TOP5*");
  if (gainers.length) {
    gainers.forEach((row, i) => {
      lines.push(`${i + 1}. ${mdText(row.name)} ${fmtPct(row.change, 1)}`);
    });
  } else {
    lines.push("상승률 데이터 준비 중");
  }

  lines.push("", `🔗 전체보기: ${SITE_URL}/daily-market.html`);
  return lines.join("\n");
}

async function main() {
  const data = await readJson(DATA_PATH);
  const message = buildMessage(data);
  const telegramRows = telegramRowsForData(await collectTelegramMessages({ hours: 3, channelLimit: 60 }), 5);
  if (telegramRows.length) {
    console.log(`Daily market Telegram context collected: ${telegramRows.length}`);
  }
  await sendTelegramMessage(message);
  console.log("Sent daily market Telegram message.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
