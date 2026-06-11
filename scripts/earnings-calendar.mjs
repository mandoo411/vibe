/** FMP + DART 실적 캘린더 → data/earnings-calendar.json */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const OUTPUT_PATH = path.resolve(process.env.EARNINGS_OUTPUT_PATH || "data/earnings-calendar.json");

const US_TICKERS = new Set([
  "NVDA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA",
  "TSM", "AVGO", "AMD", "MU", "INTC", "QCOM", "ARM",
  "JPM", "GS", "BAC", "WMT", "COST", "LLY", "UNH", "ORCL", "ADBE",
]);

const US_CORE_TICKERS = new Set([
  "NVDA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA",
]);

const KR_CODES = {
  "005930": "삼성전자",
  "000660": "SK하이닉스",
  "207940": "삼성바이오로직스",
  "373220": "LG에너지솔루션",
  "005380": "현대차",
  "000270": "기아",
  "005490": "POSCO홀딩스",
  "068270": "셀트리온",
  "105560": "KB금융",
  "055550": "신한지주",
  "035720": "카카오",
  "035420": "NAVER",
  "006400": "삼성SDI",
  "051910": "LG화학",
  "012450": "한화에어로스페이스",
};

const KR_CODE_SET = new Set(Object.keys(KR_CODES));

export function seoulYmd(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addDaysYmd(ymd, days) {
  const date = new Date(`${ymd}T12:00:00+09:00`);
  date.setDate(date.getDate() + days);
  return seoulYmd(date);
}

export function seoulStamp(date = new Date()) {
  const ymd = seoulYmd(date);
  const time = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${ymd} ${time} KST`;
}

function kstDayOfWeek(ymd) {
  return new Date(`${ymd}T12:00:00+09:00`).getUTCDay();
}

/** 이번주 월요일 ~ 다음주 일요일 (KST) */
export function biWeekRangeFrom(today = seoulYmd()) {
  const day = kstDayOfWeek(today);
  let monday = today;
  if (day === 0) monday = addDaysYmd(today, 1);
  else if (day === 6) monday = addDaysYmd(today, 2);
  else monday = addDaysYmd(today, 1 - day);
  const end = addDaysYmd(monday, 13);
  return { from: monday, to: end, monday };
}

function ymdCompact(ymd) {
  return String(ymd || "").replace(/-/g, "");
}

function normalizeHour(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "bmo" || v === "amc" || v === "dmh") return v;
  if (/before/i.test(v)) return "bmo";
  if (/after/i.test(v)) return "amc";
  return "";
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchFmpUsEarnings(from, to) {
  const apiKey = String(process.env.FMP_API_KEY || "").trim();
  if (!apiKey) {
    console.log("⚠️ FMP_API_KEY 없음 — 미국 실적 skip");
    return [];
  }
  const url = new URL("https://financialmodelingprep.com/api/v3/earning_calendar");
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("apikey", apiKey);
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "TotalMoneyAI/1.0" },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FMP HTTP ${res.status}: ${text.slice(0, 200)}`);
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) return [];
  const out = rows
    .filter((row) => US_TICKERS.has(String(row.symbol || "").trim().toUpperCase()))
    .map((row) => {
      const symbol = String(row.symbol || "").trim().toUpperCase();
      return {
        date: String(row.date || "").slice(0, 10),
        symbol,
        name: String(row.name || row.company || symbol).trim(),
        hour: normalizeHour(row.time),
        epsEstimate: numOrNull(row.epsEstimated),
        epsActual: numOrNull(row.eps),
        revenueEstimate: numOrNull(row.revenueEstimated),
        revenueActual: numOrNull(row.revenue),
        core: US_CORE_TICKERS.has(symbol),
        market: "US",
      };
    })
    .filter((row) => row.date);
  console.log(`✅ FMP 미국 실적 ${from}~${to} (${out.length}건)`);
  return out;
}

async function fetchDartKrEarnings(from, to) {
  const apiKey = String(process.env.DART_API_KEY || "").trim();
  if (!apiKey) {
    console.log("⚠️ DART_API_KEY 없음 — 한국 실적 skip");
    return [];
  }
  const url = new URL("https://opendart.fss.or.kr/api/list.json");
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("bgn_de", ymdCompact(from));
  url.searchParams.set("end_de", ymdCompact(to));
  url.searchParams.set("pblntf_ty", "A");
  url.searchParams.set("page_count", "100");
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "TotalMoneyAI/1.0" },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DART HTTP ${res.status}: ${text.slice(0, 200)}`);
  const payload = JSON.parse(text);
  if (payload.status !== "000") {
    throw new Error(`DART API ${payload.status}: ${payload.message || "error"}`);
  }
  const list = Array.isArray(payload.list) ? payload.list : [];
  const out = list
    .map((row) => {
      const code = String(row.stock_code || "").trim();
      if (!KR_CODE_SET.has(code)) return null;
      const rcept = String(row.rcept_dt || "");
      const date = rcept.length === 8
        ? `${rcept.slice(0, 4)}-${rcept.slice(4, 6)}-${rcept.slice(6, 8)}`
        : "";
      if (!date) return null;
      return {
        date,
        code,
        name: KR_CODES[code] || String(row.corp_name || "").trim(),
        reportName: String(row.report_nm || "").trim(),
        hour: "",
        epsEstimate: null,
        epsActual: null,
        revenueEstimate: null,
        revenueActual: null,
        core: true,
        market: "KR",
      };
    })
    .filter(Boolean);
  console.log(`✅ DART 한국 실적 ${from}~${to} (${out.length}건)`);
  return out;
}

export async function collectEarningsCalendar({ today } = {}) {
  const base = today || seoulYmd();
  const { from, to, monday } = biWeekRangeFrom(base);
  let us = [];
  let kr = [];
  try {
    us = await fetchFmpUsEarnings(from, to);
  } catch (error) {
    console.log(`❌ FMP 실적 실패: ${error instanceof Error ? error.message : error}`);
  }
  try {
    kr = await fetchDartKrEarnings(from, to);
  } catch (error) {
    console.log(`❌ DART 실적 실패: ${error instanceof Error ? error.message : error}`);
  }
  return {
    meta: {
      lastUpdatedKst: seoulStamp(),
      from,
      to,
      weekMonday: monday,
      source: "fmp+dart",
    },
    us: us.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol)),
    kr: kr.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code)),
  };
}

export async function writeEarningsCalendar(data) {
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
}
