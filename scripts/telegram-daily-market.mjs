#!/usr/bin/env node

import {
  bold,
  fmtPct,
  formatDateKo,
  htmlText,
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
  return `${htmlText(name)} ${bold(value)} ${htmlText(change)}`;
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

// 분석 텍스트 맨 앞 "제목 블록"(구분선 ──── 이전 줄들)과 본문을 분리.
// 구분선이 없으면 첫 줄만 제목으로 취급.
function splitAnalysisTitle(analysis) {
  const text = String(analysis || "").trim();
  if (!text) return { title: "", body: "" };
  const lines = text.split("\n");
  const sepIdx = lines.findIndex((l) => /^[─━_=]{4,}$/.test(l.trim()));
  if (sepIdx > 0) {
    return {
      title: lines.slice(0, sepIdx).join("\n").trim(),
      body: lines.slice(sepIdx + 1).join("\n").trim(),
    };
  }
  return { title: lines[0] || "", body: lines.slice(1).join("\n").trim() };
}

function stockChange(row) {
  return toNum(row?.change ?? row?.change_pct ?? row?.changePct);
}

function stockType(row) {
  const t = String(row?.type || "").trim();
  if (t) return t;
  const c = stockChange(row);
  return c != null && c < 0 ? "급락" : "급등";
}

// 급락: 시총 100위 이내 급락 종목 최대 2개 (type=급락 우선)
function formatDecliners(day) {
  const issues = Array.isArray(day.issueStocks) ? day.issueStocks : [];
  const losers = issues
    .filter((r) => r && r.name && stockType(r) === "급락")
    .sort((a, b) => (stockChange(a) ?? 0) - (stockChange(b) ?? 0))
    .slice(0, 2);
  if (!losers.length) return "";
  return losers.map((r) => `${htmlText(r.name)} ${fmtPct(stockChange(r), 2)}`).join(" | ");
}

// Telegram은 임의의 글자색(빨강/파랑)을 지원하지 않는다(HTML/Markdown 모두 색상 태그 없음).
// 대신 제목·종목 줄은 <b> 굵게 처리해 본문과 시각적 위계를 구분한다.
const HEADER_LINE_RE = /^(📌|📈|🔄|💰|🎯|🔭|◆)/;
const ITEM_LINE_RE = /^\d+\)\s/;
const LABEL_LINE_RE = /^(재료|포인트)\s*-\s*(.*)$/;

function formatAnalysisBodyHtml(body) {
  const lines = String(body || "").split("\n");
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (HEADER_LINE_RE.test(trimmed) || ITEM_LINE_RE.test(trimmed)) {
        return bold(line);
      }
      const m = line.match(LABEL_LINE_RE);
      if (m) {
        return `${bold(m[1])} - ${htmlText(m[2])}`;
      }
      return htmlText(line);
    })
    .join("\n");
}

function buildMessage(data) {
  const { ymd, day } = pickTargetDay(data);
  const indexes = Array.isArray(day.indexes) ? day.indexes : [];
  const kospi = indexes.find((r) => r && r.name === "코스피") || indexes[0];
  const kosdaq = indexes.find((r) => r && r.name === "코스닥") || indexes[1];
  const idxLine =
    [kospi, kosdaq].filter(Boolean).map(formatIndexLine).join(" | ") || "지수 데이터 준비 중";

  const lines = [bold(`[${formatDateKo(ymd)} 마감시황]`), idxLine];

  const analysis = day.analysis || day.summary || day.marketSummary || "";
  if (analysis) {
    const { title, body } = splitAnalysisTitle(analysis);
    lines.push("", "━━━━━━━━━━━━━━━━━━", bold("📊 종합분석"));
    if (title) {
      const boldTitle = title
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => bold(l))
        .join("\n");
      lines.push(boldTitle);
    }
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push(formatAnalysisBodyHtml(body || analysis));
  }

  const supplyLine = formatSupplyLine(day.supply || []);
  if (supplyLine && supplyLine !== "수급 데이터 준비 중") {
    lines.push("", bold("💰 수급 (코스피)"), htmlText(supplyLine));
  }

  const decliners = formatDecliners(day);
  if (decliners) {
    lines.push("", bold("⚠️ 급락"), decliners);
  }

  lines.push("", bold("👉 전체 분석"), `${SITE_URL}/daily-market.html`);
  return lines.join("\n");
}

async function main() {
  const data = await readJson(DATA_PATH);
  const message = buildMessage(data);
  await sendTelegramMessage(message, { parseMode: "HTML" });
  console.log("Sent daily market Telegram message.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
