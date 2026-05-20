#!/usr/bin/env node

import {
  fmtPct,
  formatDateKo,
  mdText,
  readJson,
  sendTelegramMessage,
  seoulYmd,
  SITE_URL,
  toNum,
} from "./telegram-utils.mjs";

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

function formatIndexLine(row) {
  const name = row?.name === "코스피" ? "코스피" : row?.name === "코스닥" ? "코스닥" : row?.name || "-";
  const value = row?.value != null ? String(row.value).replace(/,/g, "") : "—";
  const change = fmtPct(row?.change ?? row?.changePct, 2);
  return `${name} *${mdText(value)}* ${change}`;
}

function formatSupplyLine(supply) {
  if (!Array.isArray(supply) || !supply.length) return "수급 데이터 준비 중";
  const kospi = supply.find((r) => r.market === "코스피") || supply[0];
  const fmt = (n) => {
    if (n == null || !Number.isFinite(Number(n))) return "—";
    const v = Number(n);
    const sign = v > 0 ? "+" : "";
    if (Math.abs(v) >= 10000) return `${sign}${(v / 10000).toFixed(1)}조`;
    return `${sign}${Math.round(v).toLocaleString("ko-KR")}억`;
  };
  return `외국인 ${fmt(kospi.foreign)} | 기관 ${fmt(kospi.institution)} | 개인 ${fmt(kospi.retail)}`;
}

function formatSectorBlock(sectorFlow) {
  if (!sectorFlow || typeof sectorFlow !== "object") return "섹터 데이터 준비 중";
  const strong = (sectorFlow.strong || [])
    .slice(0, 3)
    .map((s) => `${s.name}(${fmtPct(s.changePct, 2)})`)
    .join(", ");
  const weak = (sectorFlow.weak || [])
    .slice(0, 3)
    .map((s) => `${s.name}(${fmtPct(s.changePct, 2)})`)
    .join(", ");
  const parts = [];
  if (strong) parts.push(`강세: ${strong}`);
  if (weak) parts.push(`약세: ${weak}`);
  return parts.length ? parts.join("\n") : "섹터 데이터 준비 중";
}

function formatIssueStocks(issueStocks, topGainers) {
  const rows = Array.isArray(issueStocks) && issueStocks.length ? issueStocks : [];
  if (rows.length) {
    return rows
      .slice(0, 5)
      .map((row) => {
        const reason = row.entryReason || row.background || row.reason || "";
        return `${mdText(row.name)} ${fmtPct(row.change, 2)} - ${mdText(reason)}`;
      })
      .join("\n");
  }
  const gainers = (Array.isArray(topGainers) ? topGainers : [])
    .filter((r) => r && r.name)
    .sort((a, b) => (toNum(b.change) ?? 0) - (toNum(a.change) ?? 0))
    .slice(0, 5);
  return gainers.length
    ? gainers.map((r) => `${mdText(r.name)} ${fmtPct(r.change, 2)}`).join("\n")
    : "이슈 종목 데이터 준비 중";
}

function buildMessage(data) {
  const { ymd, day } = pickTargetDay(data);
  const indexes = Array.isArray(day.indexes) ? day.indexes.slice(0, 2) : [];
  const headline = day.headlineIssue || day.summary || "시장 요약 준비 중";
  const supplyLine = formatSupplyLine(day.supply);
  const sectorBlock = formatSectorBlock(day.sectorFlow);
  const checkpoints = Array.isArray(day.tomorrowCheckpoints) ? day.tomorrowCheckpoints.slice(0, 3) : [];

  const lines = [
    "📊 *TotalMoney AI - 장마감 리포트*",
    `📅 ${formatDateKo(ymd)}`,
    "",
    "💡 *핵심 이슈*",
    mdText(headline),
    "",
    "📈 " + (indexes.length ? indexes.map(formatIndexLine).join(" | ") : "지수 데이터 준비 중"),
    "",
    "💰 *수급*",
    supplyLine,
    "",
    "🔥 *이슈 종목*",
    formatIssueStocks(day.issueStocks, day.topGainers),
    "",
    "📊 *섹터*",
    sectorBlock,
    "",
    "🎯 *내일 체크포인트*",
  ];

  if (checkpoints.length) {
    checkpoints.forEach((p, i) => lines.push(`${i + 1}. ${mdText(p)}`));
  } else {
    lines.push("1. 수급 흐름", "2. 미국 증시 영향", "3. 주요 이벤트·지표");
  }

  if (day.oneLineVerdict) {
    lines.push("", `📝 ${mdText(day.oneLineVerdict)}`);
  }

  lines.push("", `🔗 ${SITE_URL}/daily-market.html`);
  return lines.join("\n");
}

async function main() {
  const data = await readJson(DATA_PATH);
  const message = buildMessage(data);
  await sendTelegramMessage(message);
  console.log("Sent daily market Telegram message.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
