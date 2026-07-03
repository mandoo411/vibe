#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  economicRowsFromResponse,
  enrichEconomicPrevious,
  isUsKrEconomicRow,
  mapEconomicRow,
} from "./economic-calendar-util.mjs";
import { fetchEconomicCalendar } from "./investing-calendar.mjs";
import { collectEarningsCalendar, writeEarningsCalendar } from "./earnings-calendar.mjs";
const OUTPUT_PATH = path.resolve(process.env.OUTPUT_PATH || "data/weekly-schedule.json");
const MANUAL_KR_EARNINGS_PATH = path.resolve("data/kr-earnings-manual.json");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const KR_BLUECHIP = {
  반도체: ["삼성전자", "SK하이닉스", "한미반도체", "HPSP"],
  "2차전지": ["LG에너지솔루션", "삼성SDI", "에코프로비엠", "포스코퓨처엠"],
  바이오: ["삼성바이오로직스", "셀트리온", "유한양행", "한미약품"],
  자동차: ["현대차", "기아", "현대모비스"],
  "IT/플랫폼": ["카카오", "네이버", "크래프톤"],
  조선: ["HD현대중공업", "삼성중공업", "한화오션"],
  방산: ["한화에어로스페이스", "LIG넥스원", "현대로템"],
  금융: ["KB금융", "신한지주", "하나금융", "우리금융"],
  "에너지/화학": ["LG화학", "롯데케미칼", "한화솔루션"],
  "유통/소비": ["LG생활건강", "아모레퍼시픽", "CJ제일제당"],
};
const KR_BLUECHIP_CODES = {
  삼성전자: "005930",
  SK하이닉스: "000660",
  한미반도체: "042700",
  HPSP: "403870",
  LG에너지솔루션: "373220",
  삼성SDI: "006400",
  에코프로비엠: "247540",
  포스코퓨처엠: "003670",
  삼성바이오로직스: "207940",
  셀트리온: "068270",
  유한양행: "000100",
  한미약품: "128940",
  현대차: "005380",
  기아: "000270",
  현대모비스: "012330",
  카카오: "035720",
  네이버: "035420",
  크래프톤: "259960",
  HD현대중공업: "329180",
  삼성중공업: "010140",
  한화오션: "042660",
  한화에어로스페이스: "012450",
  LIG넥스원: "079550",
  현대로템: "064350",
  KB금융: "105560",
  신한지주: "055550",
  하나금융: "086790",
  우리금융: "316140",
  LG화학: "051910",
  롯데케미칼: "011170",
  한화솔루션: "009830",
  LG생활건강: "051900",
  아모레퍼시픽: "090430",
  CJ제일제당: "097950",
};
const KR_BLUECHIP_SECTOR = Object.fromEntries(
  Object.entries(KR_BLUECHIP).flatMap(([sector, names]) => names.map((name) => [name, sector]))
);

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }
  return value;
}

function seoulYmd(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function seoulStamp(date = new Date()) {
  const ymd = seoulYmd(date);
  const time = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${ymd} ${time} KST`;
}

function addDaysYmd(ymd, days) {
  const date = new Date(`${ymd}T12:00:00+09:00`);
  date.setDate(date.getDate() + days);
  return seoulYmd(date);
}

function ymdCompact(ymd) {
  return String(ymd || "").replace(/-/g, "");
}

function isYmdInRange(ymd, from, to) {
  return ymd && ymd >= from && ymd <= to;
}

function isMediumOrHighImpact(row) {
  const impact = row && row.impact;
  const importance = Number(row && row.importance);
  if (impact === 3 || impact === "3") return true;
  if (String(impact || "").toLowerCase() === "high") return true;
  if (String(impact || "").toLowerCase() === "medium") return true;
  return Number.isFinite(importance) && importance >= 2;
}
// Keep alias for backward compat
const isHighImpact = isMediumOrHighImpact;

function decodeXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function stripHtml(value) {
  return decodeXml(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseHtmlRows(html) {
  const rows = [];
  const trMatches = String(html || "").match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trMatches) {
    const cells = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let match;
    while ((match = cellRe.exec(tr)) !== null) {
      const cell = stripHtml(match[1]);
      if (cell) cells.push(cell);
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function parseKoreanScheduleDate(value, from, to) {
  const text = String(value || "");
  const full = text.match(/(20\d{2})[.\-/년\s]*(\d{1,2})[.\-/월\s]*(\d{1,2})/);
  if (full) {
    const ymd = `${full[1]}-${String(full[2]).padStart(2, "0")}-${String(full[3]).padStart(2, "0")}`;
    return isYmdInRange(ymd, from, to) ? ymd : "";
  }
  const short = text.match(/(?:^|[^\d])(\d{1,2})[.\-/월\s]+(\d{1,2})(?:일)?/);
  if (short) {
    const year = from.slice(0, 4);
    const ymd = `${year}-${String(short[1]).padStart(2, "0")}-${String(short[2]).padStart(2, "0")}`;
    return isYmdInRange(ymd, from, to) ? ymd : "";
  }
  return "";
}

function parseWonNumber(value) {
  const text = String(value || "");
  const labeled = text.match(/공모가\s*[:：]?\s*([\d,]+)/i);
  const won = text.match(/([\d,]{2,})\s*원\b/i);
  const raw = (labeled || won || [])[1];
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n) || (n >= 2000 && n <= 2100)) return null;
  if (n < 500 || n > 500000) return null;
  return n;
}

function inferMarket(text) {
  if (/코스피|유가|KOSPI/i.test(text)) return "코스피";
  if (/코스닥|KOSDAQ|스팩/i.test(text)) return "코스닥";
  if (/코넥스|KONEX/i.test(text)) return "코넥스";
  return "";
}

function cleanIpoName(name) {
  return decodeXml(String(name || ""))
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/\(구\.[^)]+\)/g, "")
    .trim();
}

function isReadableKoreanName(name) {
  const text = cleanIpoName(name);
  if (!text || text.length > 40) return false;
  if (text.includes("\uFFFD")) return false;
  const hangul = (text.match(/[가-힣]/g) || []).length;
  return hangul >= 2;
}

const IPO_DETAIL_SLEEP_MS = 220;
const IPO_LIST_INDEX_URLS = [
  "https://www.38.co.kr/html/fund/?o=r",
  "https://www.38.co.kr/html/fund/?o=k",
  "https://www.38.co.kr/html/ipo/ipo.htm",
];

function to38Url(href) {
  const path = String(href || "").replace(/&amp;/g, "&").trim();
  if (!path) return "https://www.38.co.kr/html/fund/?o=r";
  if (/^https?:\/\//i.test(path)) return path;
  return `https://www.38.co.kr${path.startsWith("/") ? path : `/${path}`}`;
}

function extract38FundNos(html) {
  const decoded = String(html || "").replace(/&amp;/g, "&");
  const nos = new Set();
  for (const match of decoded.matchAll(/fund\/\?o=v&no=(\d+)/gi)) {
    nos.add(match[1]);
  }
  return [...nos];
}

function normalizeIpoNameKey(name) {
  return cleanIpoName(name)
    .replace(/\(구\.[^)]+\)/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function ymdFromDotDate(match) {
  return `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
}

function parse38DetailTableFields(html) {
  let listingDate = "";
  let market = "";
  const trs = String(html || "").match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trs) {
    const cells = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let match;
    while ((match = cellRe.exec(tr)) !== null) {
      cells.push(stripHtml(match[1]));
    }
    if (!cells.length) continue;

    for (let i = 0; i < cells.length - 1; i++) {
      const label = cells[i].replace(/\s+/g, "");
      const value = cells[i + 1] || "";
      if (label === "상장일" || label === "신규상장일") {
        const dm = value.match(/(20\d{2})\.(\d{1,2})\.(\d{1,2})/);
        if (dm) listingDate = ymdFromDotDate(dm);
      }
      if (label === "시장구분") {
        if (/코스닥/.test(value)) market = "코스닥";
        else if (/코스피|유가증권/.test(value)) market = "코스피";
      }
    }

    const listingIdx = cells.findIndex((c) => c.replace(/\s+/g, "") === "신규상장일");
    if (listingIdx >= 0 && !listingDate) {
      for (let j = listingIdx + 1; j < cells.length; j++) {
        const dm = cells[j].match(/^(20\d{2})\.(\d{1,2})\.(\d{1,2})$/);
        if (dm) {
          listingDate = ymdFromDotDate(dm);
          break;
        }
      }
    }
  }
  return { listingDate, market };
}

function parse38ConfirmedPrice(html) {
  const text = String(html || "");
  const patterns = [
    /확정공모가\s*(?:&nbsp;|\s)*([\d,]+)/i,
    /공모가\s*(?:&nbsp;|\s)*([\d,]+)\s*~\s*[\d,]+\s*원/i,
    /공모가\s*(?:&nbsp;|\s)*([\d,]+)\s*원/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (!match) continue;
    const n = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 500 && n <= 500_000) return n;
  }
  return null;
}

function parse38DetailName(html) {
  const title = decodeXml((String(html || "").match(/<title>([^<]+)/i) || [])[1] || "");
  const fromTitle = title.match(/IPO공모\s*>\s*([^공모주청약\-]+)/i);
  if (fromTitle) return cleanIpoName(fromTitle[1]);
  const h1 = stripHtml((String(html || "").match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "");
  return cleanIpoName(h1.replace(/공모주.*/i, ""));
}

function parse38DetailPage(html, no, from, to) {
  const name = parse38DetailName(html);
  if (!isReadableKoreanName(name)) return null;

  const { listingDate: date, market } = parse38DetailTableFields(html);
  if (!date || !isYmdInRange(date, from, to)) return null;
  if (market !== "코스피" && market !== "코스닥") return null;

  return {
    date,
    name,
    market,
    sector: "",
    offeringPrice: parse38ConfirmedPrice(html),
    url: `https://www.38.co.kr/html/fund/?o=v&no=${no}`,
    code: "",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectHtmlCharset(contentType, htmlSnippet) {
  const fromHeader = String(contentType || "").match(/charset=([^;]+)/i);
  if (fromHeader) return fromHeader[1].trim().toLowerCase();
  const fromMeta = String(htmlSnippet || "").match(/charset\s*=\s*["']?([\w-]+)/i);
  return fromMeta ? fromMeta[1].trim().toLowerCase() : "utf-8";
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      accept: "*/*",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ...headers,
    },
  });
  const buffer = await res.arrayBuffer();
  const sniff = new TextDecoder("utf-8").decode(buffer.slice(0, 4096));
  const charset = detectHtmlCharset(res.headers.get("content-type"), sniff);
  const decoder =
    charset === "euc-kr" || charset === "euc_kr" || charset === "ks_c_5601-1987"
      ? new TextDecoder("euc-kr")
      : new TextDecoder("utf-8");
  const text = decoder.decode(buffer);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

function economicRowKey(row) {
  const date = String(row.date || row.time || "").slice(0, 10);
  return `${date}|${row.country || ""}|${row.event || ""}`;
}

// 네이버/KIND 스크레이핑 결과와 DART 기반 결과를 하나로 합침(둘 중 하나만 쓰면
// 나머지 소스에서만 발견된 실적이 조용히 누락됨 — 예: 삼성전자 7/7 잠정실적).
// 같은 종목(code, 없으면 name) 기준 date가 더 이른(먼저 확정된) 쪽을 우선한다.
function mergeKrEarningsSources(...sourceLists) {
  const byKey = new Map();
  for (const rows of sourceLists) {
    for (const row of rows || []) {
      const key = `${row.code || row.name}`;
      const existing = byKey.get(key);
      if (!existing || row.date < existing.date) {
        byKey.set(key, row);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// 아직 DART/네이버/KIND 어디에도 실제 공시로 안 잡히는 "예상" 실적 발표일을
// data/kr-earnings-manual.json에서 읽어온다. 자동 소스가 같은 종목을 찾으면
// 자동 소스가 우선하고, 못 찾으면 이 수동 항목이 살아남는다.
async function loadManualKrEarnings(from, to) {
  try {
    const raw = await fs.readFile(MANUAL_KR_EARNINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return entries.filter((e) => e && e.date >= from && e.date <= to);
  } catch {
    return [];
  }
}

function mergeEconomicResponses(...sources) {
  const byKey = new Map();
  for (const source of sources) {
    for (const row of economicRowsFromResponse(source)) {
      byKey.set(economicRowKey(row), row);
    }
  }
  return [...byKey.values()];
}

function normalizeEconomic(data, { minDate } = {}) {
  const rawRows = economicRowsFromResponse(data);
  const mapped = rawRows.map(mapEconomicRow);
  const highKeys = new Set();
  for (let i = 0; i < rawRows.length; i += 1) {
    if (isHighImpact(rawRows[i])) highKeys.add(economicRowKey(mapped[i]));
  }
  const enriched = enrichEconomicPrevious(mapped);
  const min = minDate || "";
  return enriched
    .filter((row) => (!min || row.date >= min) && highKeys.has(economicRowKey(row)) && isUsKrEconomicRow(row))
    .map((row) => ({ ...row, impact: "high", importance: 3 }));
}

async function fetchKRIPO(from, to) {
  const fundNos = new Set();
  for (const url of IPO_LIST_INDEX_URLS) {
    try {
      const html = await fetchText(url);
      for (const no of extract38FundNos(html)) fundNos.add(no);
      console.log(`✅ 38 IPO 목록 ${url.split("?")[1] || url} — fund no ${extract38FundNos(html).length}개`);
    } catch (error) {
      console.log(`❌ 38 IPO 목록 실패: ${error instanceof Error ? error.message : error}`);
    }
  }

  const byName = new Map();
  const nos = [...fundNos].sort((a, b) => Number(a) - Number(b));
  for (const no of nos) {
    try {
      const html = await fetchText(`https://www.38.co.kr/html/fund/?o=v&no=${no}`);
      const row = parse38DetailPage(html, no, from, to);
      if (!row) continue;
      const key = normalizeIpoNameKey(row.name);
      const prev = byName.get(key);
      if (!prev || (row.offeringPrice && !prev.offeringPrice)) {
        byName.set(key, row);
      }
    } catch (error) {
      console.log(`❌ 38 상세 no=${no} 실패: ${error instanceof Error ? error.message : error}`);
    }
    await sleep(IPO_DETAIL_SLEEP_MS);
  }

  const rows = [...byName.values()].sort((a, b) => a.date.localeCompare(b.date));
  console.log(`✅ 신규상장(확정) ${rows.length}건 — 코스피·코스닥 상장일만`);
  return rows;
}

function normalizeKrEarningRows(rows, from, to) {
  const seen = new Set();
  const out = [];
  for (const cells of rows) {
    const text = cells.join(" ");
    const date = parseKoreanScheduleDate(text, from, to);
    if (!date) continue;
    for (const [name, sector] of Object.entries(KR_BLUECHIP_SECTOR)) {
      if (!text.includes(name)) continue;
      const key = `${date}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        date,
        name,
        sector,
        code: KR_BLUECHIP_CODES[name] || "",
        epsEstimate: cells.find((cell) => /EPS|예상/.test(cell)) || "",
        previousQuarter: cells.find((cell) => /전분기|직전|QoQ/.test(cell)) || "",
      });
    }
  }
  return out;
}

async function fetchKREarnings(from, to) {
  const sources = [
    { name: "네이버 금융 실적 캘린더", url: "https://finance.naver.com/research/earning_list.naver" },
    { name: "KIND 공시", url: "https://kind.krx.co.kr" },
  ];
  const rows = [];
  for (const source of sources) {
    try {
      const html = await fetchText(source.url, { "User-Agent": "Mozilla/5.0" });
      const parsed = normalizeKrEarningRows(parseHtmlRows(html), from, to);
      rows.push(...parsed);
      console.log(`✅ ${source.name} 성공 (${parsed.length}건)`);
    } catch (error) {
      console.log(`❌ ${source.name} 실패: ${error instanceof Error ? error.message : error}`);
    }
  }
  const seen = new Set();
  return rows
    .filter((row) => {
      const key = `${row.date}:${row.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function parseClaudeJson(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("Claude response did not contain JSON");
  }
  return JSON.parse(body.slice(start, end + 1));
}

async function fetchEconomicCalendarMerged(from, to) {
  const rows = await fetchEconomicCalendar(from, to);
  return mergeEconomicResponses({ economicCalendar: rows });
}

async function analyzeWithClaude({ economicCalendar, krIPO, krEarnings }) {
  const anthropic = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });

  // 오늘~+14일 범위 핵심 이벤트만 추출
  const today = seoulYmd();
  const twoWeeksLater = addDaysYmd(today, 14);

  const upcomingMacro = economicCalendar
    .filter((r) => r.date >= today && r.date <= twoWeeksLater)
    .filter((r) => {
      const impact = r.impact;
      return impact === 3 || impact === "3" || String(impact || "").toLowerCase() === "high";
    })
    .filter((r) => {
      const cc = String(r.country || "").toUpperCase();
      return cc === "US" || cc === "KR" || cc === "미국" || cc === "한국";
    })
    .slice(0, 8);

  const upcomingEarnings = [...krEarnings]
    .filter((r) => r.date >= today && r.date <= twoWeeksLater)
    .slice(0, 6);

  const payload = { upcomingMacro, upcomingEarnings };

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2400,
    temperature: 0.3,
    messages: [
      {
        role: "user",
        content: `아래 이번 주~다음 주 핵심 경제지표와 실적 발표 일정을 분석해서 한국어 JSON만 반환해줘.

각 이벤트에 대해 투자자에게 유용한 시나리오 분석을 작성해줘:
- 매크로 지표: 예상치 대비 결과가 높을 때/낮을 때 증시·환율 영향을 구체적으로 설명
- 실적 발표: 시장 컨센서스와 업종 내 파급 효과를 설명

스키마:
{
  "eventAnalysis": [
    {
      "type": "macro",
      "date": "YYYY-MM-DD",
      "title": "지표명 (약어)",
      "expected": "예측 X / 이전 Y (단위 포함)",
      "analysis": "예상 상회 시 [증시/환율 영향]. 예상 하회 시 [증시/환율 영향]. 2~3문장."
    },
    {
      "type": "earnings",
      "date": "YYYY-MM-DD",
      "title": "회사명 실적발표",
      "expected": "컨센서스 영업이익 X조원 / 전년동기 대비 Y%",
      "analysis": "예상 상회 시 [섹터 파급]. 예상 하회 시 [섹터 파급]. 관련 종목 언급. 2~3문장."
    }
  ]
}

주의: eventAnalysis 배열만 반환. 총 항목 최대 6개. 날짜 오름차순 정렬.

데이터:
${JSON.stringify(payload).slice(0, 40000)}`,
      },
    ],
  });

  const text = msg.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const parsed = parseClaudeJson(text);
  return Array.isArray(parsed.eventAnalysis) ? parsed.eventAnalysis.slice(0, 6) : [];
}

async function main() {
  const today = seoulYmd();
  const to = addDaysYmd(today, 14);
  const historyFrom = addDaysYmd(today, -90);

  // 과거 90일 + 미래 14일 범위로 경제지표 수집 (달력 이전달 조회 지원)
  const [economicMerged, krIPO, krEarnings] = await Promise.all([
    fetchEconomicCalendarMerged(historyFrom, to),
    fetchKRIPO(today, to),
    fetchKREarnings(today, to),
  ]);

  let earningsKrFallback = [];
  try {
    const earningsData = await collectEarningsCalendar({ today });
    console.log(
      `실적 캘린더: US ${earningsData.us.length}건, KR ${earningsData.kr.length}건` +
        (process.env.DART_API_KEY ? " (DART 연동)" : " (DART 미설정)")
    );
    await writeEarningsCalendar(earningsData);
    earningsKrFallback = earningsData.kr.map((r) => ({
      date: r.date,
      name: r.name,
      sector: "",
      code: r.code || r.symbol || "",
      epsEstimate: r.epsEstimate ?? "",
      previousQuarter: "",
      reportName: r.reportName || "",
    }));
  } catch (error) {
    console.log(`❌ 실적 캘린더 저장 실패: ${error instanceof Error ? error.message : error}`);
  }

  // minDate를 historyFrom으로 설정해 과거 90일 고영향 지표도 포함
  let economicCalendar = normalizeEconomic({ economicCalendar: economicMerged }, { minDate: historyFrom });
  console.log(`경제지표 ${economicCalendar.length}건 (병합 ${economicMerged.length}건)`);

  let priorData = null;
  if (!economicCalendar.length) {
    try {
      priorData = JSON.parse(await fs.readFile(OUTPUT_PATH, "utf8"));
      if (Array.isArray(priorData?.economicCalendar) && priorData.economicCalendar.length) {
        economicCalendar = priorData.economicCalendar;
        console.log(`⚠️ 경제지표 수집 실패 — 기존 ${economicCalendar.length}건 유지`);
      }
    } catch {
      /* no prior file */
    }
  }

  // 네이버+KIND 스크레이핑과 DART 결과를 합쳐서 사용 (한쪽에만 있던 실적이
  // 조용히 누락되는 것을 방지 — 삼성전자 7/7 잠정실적 미표시 버그의 원인이었음)
  const krEarningsAuto = mergeKrEarningsSources(krEarnings, earningsKrFallback);
  // 수동 항목은 자동 소스 어디에도 없는 종목일 때만 보충(자동 데이터가 항상 우선)
  const manualKrEarnings = await loadManualKrEarnings(today, to);
  const autoCodes = new Set(krEarningsAuto.map((r) => r.code || r.name));
  const manualToAdd = manualKrEarnings.filter((r) => !autoCodes.has(r.code || r.name));
  const krEarningsMerged = [...krEarningsAuto, ...manualToAdd].sort((a, b) => a.date.localeCompare(b.date));
  console.log(
    `실적 병합: 네이버/KIND ${krEarnings.length}건 + DART ${earningsKrFallback.length}건 + 수동보충 ${manualToAdd.length}건 → 최종 ${krEarningsMerged.length}건`
  );

  let eventAnalysis = [];
  try {
    eventAnalysis = await analyzeWithClaude({ economicCalendar, krIPO, krEarnings: krEarningsMerged });
    console.log(`일정 분석 ${eventAnalysis.length}건 생성`);
  } catch (error) {
    console.log(`❌ Claude 분석 실패: ${error instanceof Error ? error.message : error}`);
  }

  const data = {
    meta: {
      title: "매일 증시 일정",
      lastUpdatedKst: seoulStamp(),
      from: today,
      to,
      historyFrom,
      source: "investing+forexfactory+38-detail+claude",
    },
    economicCalendar,
    krIPO,
    krEarnings: krEarningsMerged,
    eventAnalysis,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

export { fetchKRIPO, seoulYmd, addDaysYmd };

const __weeklyScheduleMain = fileURLToPath(import.meta.url);
const isCliEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__weeklyScheduleMain);

if (isCliEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
