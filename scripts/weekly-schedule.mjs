#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { collectTelegramMessages, telegramRowsForData } from "./telegram-channel-news.mjs";

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const RSS_SOURCES = [
  { url: "https://www.mk.co.kr/rss/30100041/", name: "매일경제" },
  { url: "https://www.yna.co.kr/rss/economy.xml", name: "연합뉴스" },
  { url: "https://rss.yna.co.kr/economy/rss.xml", name: "연합뉴스 경제" },
  { url: "https://rss.hankyung.com/stock.xml", name: "한국경제 증권" },
  { url: "https://rss.hankyung.com/finance.xml", name: "한국경제 금융" },
  { url: "https://rss.mt.co.kr/mt_isa/", name: "머니투데이" },
  { url: "https://rss.edaily.co.kr/edaily/RSSSvc.asmx/economy_news", name: "이데일리 경제" },
  { url: "https://rss.heraldcorp.com/rss/economy.xml", name: "헤럴드경제" },
  {
    url: "https://finance.naver.com/news/news_list.naver?mode=LSS3D&section_id=101&section_id2=258&section_id3=401",
    name: "네이버금융",
  },
  { url: "https://www.news1.kr/rss/economy", name: "뉴스1" },
  { url: "https://www.asiae.co.kr/rss/stock.htm", name: "아시아경제" },
  { url: "https://www.fnnews.com/rss/fn_realestate_stock.xml", name: "파이낸셜뉴스" },
  { url: "https://www.sedaily.com/RSS/S.xml", name: "서울경제" },
  { url: "https://news.bizwatch.co.kr/rss/finance.xml", name: "비즈니스워치" },
];
const OUTPUT_PATH = path.resolve(process.env.OUTPUT_PATH || "data/weekly-schedule.json");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const SP500_WATCHLIST = [
  "AAPL","MSFT","NVDA","GOOGL","GOOG","AMZN","META","TSLA",
  "AMD","INTC","QCOM","AVGO","MU","AMAT","LRCX","KLAC","TXN","MRVL","ARM","SMCI",
  "JPM","BAC","WFC","GS","MS","BLK","C","AXP","V","MA","PYPL",
  "JNJ","UNH","LLY","PFE","ABBV","MRK","TMO","ABT","DHR",
  "XOM","CVX","COP","SLB","EOG",
  "WMT","HD","MCD","SBUX","NKE","TGT","COST","LOW",
  "NFLX","DIS","CMCSA","T","VZ",
  "CAT","BA","GE","HON","RTX","LMT","UPS","FDX",
  "SPY","QQQ","IWM","DIA","GLD","SLV","TLT",
  "PLTR","SNOW","CRM","NOW","UBER","ABNB","COIN","HOOD",
  "SOFI","RIVN","NIO","BIDU","BABA","JD","PDD",
  "RBLX","SNAP","ROKU","SPOT","ZM"
];
const SP500_WATCHLIST_SET = new Set(SP500_WATCHLIST);
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

function kstNewsTimeLabel(value) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/\.$/, "");
}

function isNewsWithinHours(value, hours, now = new Date()) {
  if (!value) return false;
  const pubDate = new Date(value);
  if (Number.isNaN(pubDate.getTime())) return false;
  const threshold = new Date(now);
  threshold.setHours(threshold.getHours() - hours);
  return pubDate >= threshold;
}

function isHighImpact(row) {
  const impact = row && row.impact;
  const importance = Number(row && row.importance);
  if (impact === 3 || impact === "3") return true;
  if (String(impact || "").toLowerCase() === "high") return true;
  return Number.isFinite(importance) && importance >= 3;
}

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

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "TotalMoneyAI/1.0",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Finnhub HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from Finnhub: ${text.slice(0, 300)}`);
  }
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

function normalizeEconomic(data) {
  const rows = Array.isArray(data?.economicCalendar) ? data.economicCalendar : [];
  return rows.filter(isHighImpact).map((row) => ({
    date: String(row.date || row.time || "").slice(0, 10),
    event: row.event || "",
    country: row.country || "",
    time: String(row.time || "").slice(11, 16) || "",
    impact: "high",
    importance: 3,
    actual: row.actual ?? "",
    previous: row.previous ?? "",
    estimate: row.estimate ?? "",
  }));
}

function normalizeEarnings(data) {
  const rows = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
  return rows
    .map((row) => ({
      date: String(row.date || "").slice(0, 10),
      symbol: String(row.symbol || "").trim().toUpperCase(),
      company: row.company || "",
      hour: row.hour || "",
      epsEstimate: row.epsEstimate ?? "",
      revenueEstimate: row.revenueEstimate ?? "",
    }))
    .filter((row) => SP500_WATCHLIST_SET.has(row.symbol));
}

function normalizeRss(xml, source) {
  const items = String(xml || "").match(/<item>[\s\S]*?<\/item>/g) || [];
  return items
    .map((item) => {
      const title = decodeXml((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
      const link = decodeXml((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
      const pubDate = decodeXml((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
      return {
        headline: title,
        url: link,
        datetime: pubDate || null,
        date: pubDate ? seoulYmd(new Date(pubDate)) : "",
        timeLabel: kstNewsTimeLabel(pubDate),
        source,
      };
    })
    .filter((row) => row.headline && row.url && row.datetime && !Number.isNaN(new Date(row.datetime).getTime()))
    .sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime())
    .slice(0, 5);
}

async function fetchRssSource(source) {
  const res = await fetch(source.url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const rows = normalizeRss(text, source.name);
  console.log(`✅ ${source.name} 성공 (${rows.length}건)`);
  return rows;
}

async function fetchKoreanNews() {
  const telegramMessages = await collectTelegramMessages({ hours: 3, channelLimit: 60 });
  const telegramRows = telegramRowsForData(telegramMessages, 20).map((row) => ({
    headline: row.title,
    url: "",
    datetime: row.datetime,
    date: row.datetime.slice(0, 10),
    timeLabel: row.timeLabel,
    source: row.source,
    summary: row.summary,
    telegram: true,
  }));
  if (telegramRows.length) return telegramRows;

  const settled = await Promise.allSettled(RSS_SOURCES.map((source) => fetchRssSource(source)));
  const rows = [];
  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    const source = RSS_SOURCES[i];
    if (result.status === "fulfilled") {
      rows.push(...result.value);
    } else {
      console.log(`❌ ${source.name} 실패: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
    }
  }

  const seen = new Set();
  const unique = rows
    .sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime())
    .filter((row) => {
      const key = row.headline.replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const recent24h = unique.filter((row) => isNewsWithinHours(row.datetime, 24));
  const filtered = recent24h.length >= 5 ? recent24h : unique.filter((row) => isNewsWithinHours(row.datetime, 48));
  return filtered.slice(0, 20);
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

async function analyzeWithClaude({ economicCalendar, earningsCalendar, krIPO, krEarnings, news }) {
  const anthropic = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  const payload = { economicCalendar, earningsCalendar, krIPO, krEarnings, news };
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1800,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: `아래 향후 2주 경제 일정, 미국 실적 발표, 한국 신규상장, 국내 주요기업 실적 발표, 주요 뉴스를 바탕으로 한국어 JSON만 반환해줘.
스키마:
{
  "topEvents": ["이번주 핵심 이벤트 TOP5, 각 항목 1문장"],
  "marketImpacts": ["각 이벤트가 국내 시장에 미칠 영향, 3~5개"],
  "watchEarnings": ["주목해야 할 실적 발표 종목, 3~7개"]
}

데이터:
${JSON.stringify(payload).slice(0, 60000)}`,
      },
    ],
  });
  const text = msg.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const parsed = parseClaudeJson(text);
  return {
    topEvents: Array.isArray(parsed.topEvents) ? parsed.topEvents.slice(0, 5) : [],
    marketImpacts: Array.isArray(parsed.marketImpacts) ? parsed.marketImpacts : [],
    watchEarnings: Array.isArray(parsed.watchEarnings) ? parsed.watchEarnings : [],
  };
}

async function main() {
  const token = requireEnv("FINNHUB_API_KEY");
  const today = seoulYmd();
  const to = addDaysYmd(today, 14);
  const economicUrl = new URL(`${FINNHUB_BASE_URL}/calendar/economic`);
  economicUrl.searchParams.set("from", today);
  economicUrl.searchParams.set("to", to);
  economicUrl.searchParams.set("token", token);

  const earningsUrl = new URL(`${FINNHUB_BASE_URL}/calendar/earnings`);
  earningsUrl.searchParams.set("from", today);
  earningsUrl.searchParams.set("to", to);
  earningsUrl.searchParams.set("token", token);

  const [economicRaw, earningsRaw, news, krIPO, krEarnings] = await Promise.all([
    fetchJson(economicUrl),
    fetchJson(earningsUrl),
    fetchKoreanNews(),
    fetchKRIPO(today, to),
    fetchKREarnings(today, to),
  ]);

  const economicCalendar = normalizeEconomic(economicRaw);
  const earningsCalendar = normalizeEarnings(earningsRaw);
  const analysis = await analyzeWithClaude({ economicCalendar, earningsCalendar, krIPO, krEarnings, news });

  const data = {
    meta: {
      title: "매일 증시 일정",
      lastUpdatedKst: seoulStamp(),
      from: today,
      to,
      source: "finnhub+38-detail+naver+claude",
    },
    economicCalendar,
    earningsCalendar,
    krIPO,
    krEarnings,
    analysis,
    news,
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
