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

const CIRCLED = ["①", "②", "③", "④", "⑤"];

function stockChange(row) {
  return toNum(row?.change ?? row?.change_pct ?? row?.changePct);
}

function stockType(row) {
  const t = String(row?.type || "").trim();
  if (t) return t;
  const c = stockChange(row);
  return c != null && c < 0 ? "급락" : "급등";
}

function stockReason(row) {
  return row?.reason || row?.entryReason || row?.background || row?.note || "";
}

// 특징주: 급등 상위 3개 (issueStocks → 없으면 topGainers 폴백)
function formatFeatured(day) {
  const issues = Array.isArray(day.issueStocks) ? day.issueStocks : [];
  let pool = issues.filter((r) => r && r.name && stockType(r) === "급등");
  if (!pool.length) {
    pool = (Array.isArray(day.topGainers) ? day.topGainers : []).filter((r) => r && r.name);
  }
  const top = pool
    .slice()
    .sort((a, b) => (stockChange(b) ?? 0) - (stockChange(a) ?? 0))
    .slice(0, 3);
  if (!top.length) return "특징주 데이터 준비 중";
  return top
    .map((r, i) => {
      const reason = stockReason(r);
      return `${CIRCLED[i]} ${mdText(r.name)} ${fmtPct(stockChange(r), 2)}${reason ? ` (${mdText(reason)})` : ""}`;
    })
    .join("\n");
}

// 급락: 시총 100위 이내 급락 종목 최대 2개 (type=급락 우선)
function formatDecliners(day) {
  const issues = Array.isArray(day.issueStocks) ? day.issueStocks : [];
  const losers = issues
    .filter((r) => r && r.name && stockType(r) === "급락")
    .sort((a, b) => (stockChange(a) ?? 0) - (stockChange(b) ?? 0))
    .slice(0, 2);
  if (!losers.length) return "";
  return losers.map((r) => `${mdText(r.name)} ${fmtPct(stockChange(r), 2)}`).join(" | ");
}

function buildMessage(data) {
  const { ymd, day } = pickTargetDay(data);
  const indexes = Array.isArray(day.indexes) ? day.indexes : [];
  const kospi = indexes.find((r) => r && r.name === "코스피") || indexes[0];
  const kosdaq = indexes.find((r) => r && r.name === "코스닥") || indexes[1];
  const idxLine =
    [kospi, kosdaq].filter(Boolean).map(formatIndexLine).join(" | ") || "지수 데이터 준비 중";

  const lines = [`[${mdText(formatDateKo(ymd))} 마감시황]`, idxLine];

  const analysis = day.analysis || day.summary || day.marketSummary || "";
  if (analysis) {
    lines.push("", "📊 *종합분석*", mdText(analysis));
  }

  const supplyLine = formatSupplyLine(day.supply || []);
  if (supplyLine && supplyLine !== "수급 데이터 준비 중") {
    lines.push("", "💰 *수급 (코스피)*", supplyLine);
  }

  lines.push("", "🔥 *특징주*", formatFeatured(day));

  const decliners = formatDecliners(day);
  if (decliners) {
    lines.push("", "⚠️ *급락*", decliners);
  }

  lines.push("", "👉 *전체 분석*", `${SITE_URL}/daily-market.html`);
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
