import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const SITE_URL = String(process.env.SITE_URL || "https://www.totalmoney.kr").replace(/\/+$/, "");
export const WD_KO = ["일", "월", "화", "수", "목", "금", "토"];

export function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing env: ${name}`);
  }
  return String(value).trim();
}

export async function readJson(filePath) {
  const raw = await fs.readFile(path.resolve(filePath), "utf8");
  return JSON.parse(raw);
}

export function seoulYmd(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addDaysYmd(ymd, days) {
  const time = new Date(`${ymd}T12:00:00+09:00`).getTime() + days * 86400000;
  return seoulYmd(new Date(time));
}

export function mondayYmdFor(ymd) {
  const date = new Date(`${ymd}T12:00:00+09:00`);
  const jsDay = date.getUTCDay();
  const diffToMon = jsDay === 0 ? -6 : 1 - jsDay;
  return addDaysYmd(ymd, diffToMon);
}

export function formatDateKo(ymd, { year = true, compact = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return String(ymd || "-");
  const date = new Date(`${ymd}T12:00:00+09:00`);
  const [y, m, d] = ymd.split("-");
  const wd = WD_KO[date.getUTCDay()];
  if (compact) return year ? `${y}.${m}.${d}(${wd})` : `${Number(m)}.${Number(d)}(${wd})`;
  return year ? `${y}.${m}.${d} (${wd})` : `${Number(m)}.${Number(d)} (${wd})`;
}

export function dayKo(ymd) {
  const date = new Date(`${ymd}T12:00:00+09:00`);
  return WD_KO[date.getUTCDay()];
}

export function toNum(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").replace(/%/g, "").replace(/^\+/, "").trim();
    if (!normalized || normalized === "-") return null;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function fmtNumber(value, digits = 0) {
  const n = toNum(value);
  if (n == null) return "-";
  return n.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(value, digits = 1) {
  const n = toNum(value);
  if (n == null) return "-";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function fmtDelta(value, digits = 1) {
  const n = toNum(value);
  if (n == null) return "";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}`;
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    if (value != null && String(value).trim() !== "") return value;
  }
  return "";
}

export function mdText(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

// Telegram HTML parse_mode escaping — only &, <, > need escaping (much safer
// for Korean report text full of punctuation than legacy Markdown mode).
export function htmlText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function bold(value) {
  return `<b>${htmlText(value)}</b>`;
}

export function isHighImpact(row) {
  const impact = String(row?.impact || "").toLowerCase();
  return impact === "high" || Number(row?.importance) >= 3;
}

export function countryFlag(country) {
  const map = {
    AU: "🇦🇺",
    CA: "🇨🇦",
    CN: "🇨🇳",
    DE: "🇩🇪",
    EU: "🇪🇺",
    GB: "🇬🇧",
    JP: "🇯🇵",
    KR: "🇰🇷",
    US: "🇺🇸",
  };
  return map[String(country || "").toUpperCase()] || "🌐";
}

export function eventTitle(row) {
  return firstNonEmpty(row?.title, row?.event, row?.name, row?.indicator, "경제지표");
}

export function companyName(row) {
  return firstNonEmpty(row?.company, row?.name, row?.symbol, "");
}

// Telegram sendMessage 하드 한도: 4096 UTF-16 코드유닛. 개별 발송 스크립트가 이 한도를
// 놓치면 API가 통째로 거부해 발송 자체가 조용히 실패한다(과거 마감시황 발송 장애의 원인).
// 여기서 최종 안전망으로 한 번 더 자른다 — 줄바꿈 경계에서만 자르므로 각 줄이
// 자기완결적인 <b>...</b>/마크다운 태그를 쓰는 한 태그가 중간에서 끊기지 않는다.
const TELEGRAM_HARD_LIMIT = 4096;
const TELEGRAM_SAFETY_MARGIN = 100;

function truncateToTelegramLimit(text) {
  const max = TELEGRAM_HARD_LIMIT - TELEGRAM_SAFETY_MARGIN;
  if (text.length <= max) return text;
  const notice = "\n…(하략 — 메시지 길이 제한으로 일부 생략)";
  const budget = max - notice.length;
  let cut = text.slice(0, budget);
  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline > 0) cut = cut.slice(0, lastNewline);
  return cut + notice;
}

export async function sendTelegramMessage(text, { parseMode = "Markdown" } = {}) {
  const token = requireEnv("TELEGRAM_TOKEN");
  const chatId = requireEnv("TELEGRAM_CHANNEL_ID");
  const safeText = truncateToTelegramLimit(String(text || ""));
  if (safeText.length !== String(text || "").length) {
    console.warn(
      `[telegram] message length ${String(text || "").length} exceeded safe limit, truncated to ${safeText.length}.`
    );
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: safeText,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram sendMessage failed: ${data.description || res.statusText}`);
  }
  return data.result;
}
