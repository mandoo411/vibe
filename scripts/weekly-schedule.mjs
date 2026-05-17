#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const RSS_SOURCES = [
  "https://www.mk.co.kr/rss/30200030/",
  "https://www.mk.co.kr/rss/30100041/",
  "https://rss.hankyung.com/economy.xml",
  "https://rss.hankyung.com/international.xml",
  "https://rss.yna.co.kr/economy/rss.xml",
  "https://rss.yna.co.kr/international/rss.xml",
];
const EXCLUDE_KEYWORDS = [
  "결혼","이혼","열애","교제","임신","출산","사망","부고","빈소",
  "드라마","영화","배우","가수","아이돌","콘서트","팬미팅",
  "맛집","레시피","요리","카페","인테리어","인테리어",
  "다이어트","운동","헬스","뷰티","패션","스타일",
  "살인","폭행","성범죄","납치","교통사고","음주운전",
  "날씨","미세먼지","황사","비","태풍",
  "청약","분양","재건축","재개발","아파트",
  "치매","건강","병원","의료보험",
];
const INCLUDE_KEYWORDS = [
  "코스피","코스닥","증시","주식","펀드","ETF","채권","금리","환율",
  "수출","수입","무역","경상수지","GDP","물가","CPI","인플레이션","기준금리",
  "이란","전쟁","미중","관세","트럼프","제재","협상","외교","동맹",
  "러시아","우크라이나","중동","이스라엘","하마스","가자","후티",
  "OPEC","오펙","원유","유가","에너지",
  "G7","G20","IMF","세계은행","WTO",
  "반도체","AI","인공지능","빅테크","데이터센터","전기차","배터리",
  "삼성","SK하이닉스","현대차","LG","포스코","카카오","네이버",
  "엔비디아","애플","테슬라","아마존","구글","메타","마이크로소프트",
  "연준","Fed","FOMC","ECB","금값","구리","달러","원화",
  "비트코인","이더리움","암호화폐","크립토",
  "영업이익","매출","실적","어닝","상장","공모","IPO",
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

function isRecentNewsDate(value, now = new Date()) {
  if (!value) return false;
  const pubDate = new Date(value);
  if (Number.isNaN(pubDate.getTime())) return false;
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  return pubDate >= thirtyDaysAgo;
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

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      accept: "*/*",
      "user-agent": "TotalMoneyAI/1.0",
      ...headers,
    },
  });
  const text = await res.text();
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

function rssSourceName(url) {
  if (/mk\.co\.kr/i.test(url)) return "매일경제";
  if (/hankyung\.com/i.test(url)) return "한국경제";
  if (/yna\.co\.kr/i.test(url)) return "연합뉴스";
  return "뉴스";
}

function keywordIncludes(title, keywords) {
  const normalizedTitle = String(title || "").toLowerCase();
  return keywords.some((keyword) => normalizedTitle.includes(String(keyword).toLowerCase()));
}

function passesNewsKeywordFilter(title) {
  if (keywordIncludes(title, EXCLUDE_KEYWORDS)) return false;
  return keywordIncludes(title, INCLUDE_KEYWORDS);
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
    .filter((row) => row.headline && row.url && isRecentNewsDate(row.datetime) && passesNewsKeywordFilter(row.headline))
    .sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime())
    .slice(0, 6);
}

async function fetchRssSource(url) {
  const xml = await fetchText(url, { accept: "application/rss+xml, application/xml, text/xml" });
  return normalizeRss(xml, rssSourceName(url));
}

async function fetchKoreanNews() {
  const settled = await Promise.allSettled(RSS_SOURCES.map((url) => fetchRssSource(url)));
  const rows = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      rows.push(...result.value);
    } else {
      console.warn(`Korean RSS fetch failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
    }
  }

  const seen = new Set();
  return rows
    .sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime())
    .filter((row) => {
      const key = row.headline.replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
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

async function analyzeWithClaude({ economicCalendar, earningsCalendar, news }) {
  const anthropic = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  const payload = { economicCalendar, earningsCalendar, news };
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1800,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: `아래 향후 2주 경제 일정, 실적 발표, 주요 뉴스를 바탕으로 한국어 JSON만 반환해줘.
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

  const [economicRaw, earningsRaw, news] = await Promise.all([
    fetchJson(economicUrl),
    fetchJson(earningsUrl),
    fetchKoreanNews(),
  ]);

  const economicCalendar = normalizeEconomic(economicRaw);
  const earningsCalendar = normalizeEarnings(earningsRaw);
  const analysis = await analyzeWithClaude({ economicCalendar, earningsCalendar, news });

  const data = {
    meta: {
      title: "매일 증시 일정",
      lastUpdatedKst: seoulStamp(),
      from: today,
      to,
      source: "finnhub+claude",
    },
    economicCalendar,
    earningsCalendar,
    analysis,
    news,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
