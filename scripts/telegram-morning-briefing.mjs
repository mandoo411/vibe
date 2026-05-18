#!/usr/bin/env node

import {
  fmtNumber,
  fmtPct,
  formatDateKo,
  mdText,
  readJson,
  sendTelegramMessage,
  seoulYmd,
  SITE_URL,
} from "./telegram-utils.mjs";

const DATA_PATH = process.env.MORNING_BRIEFING_PATH || "data/morning-briefing.json";

function dataYmd(data) {
  const iso = data?.updatedAt;
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return seoulYmd(new Date(parsed));
  }
  return process.env.TARGET_DATE || seoulYmd();
}

function formatIndex(row) {
  const name = mdText(row?.name || row?.symbol || "-");
  const value = fmtNumber(row?.close ?? row?.price, 0);
  return `- ${name}: ${value} ${fmtPct(row?.changePct, 1)}`;
}

function formatNews(news) {
  const rows = Array.isArray(news) ? news.slice(0, 3) : [];
  if (!rows.length) return ["주요 뉴스 준비 중"];
  return rows.map((item, index) => `${index + 1}. ${mdText(item?.title || "뉴스 제목 없음")}`);
}

function buildMessage(data) {
  const indices = Array.isArray(data?.usMarket?.indices) ? data.usMarket.indices.slice(0, 3) : [];
  const usdKrw = data?.forex?.rates?.["USD/KRW"];
  const btc = Array.isArray(data?.crypto?.assets)
    ? data.crypto.assets.find((asset) => String(asset?.symbol).toUpperCase() === "BTC")
    : null;

  const lines = [
    "📊 *TotalMoney AI - 장전 브리핑*",
    `📅 ${formatDateKo(dataYmd(data))}`,
    "",
    "🇺🇸 *간밤 미국시장*",
  ];

  lines.push(...(indices.length ? indices.map(formatIndex) : ["- 미국시장 데이터 준비 중"]));
  lines.push("", "💱 *환율*");
  lines.push(`- USD/KRW: ${fmtNumber(usdKrw, 0)}원`);
  lines.push(`- BTC: $${fmtNumber(btc?.priceUsd, 0)} ${fmtPct(btc?.changePct24h, 1)}`);
  lines.push("", "📰 *주요뉴스 TOP3*");
  lines.push(...formatNews(data?.news));
  lines.push("", `🔗 전체보기: ${SITE_URL}/briefing.html`);
  return lines.join("\n");
}

async function main() {
  const data = await readJson(DATA_PATH);
  const message = buildMessage(data);
  await sendTelegramMessage(message);
  console.log("Sent morning briefing Telegram message.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
