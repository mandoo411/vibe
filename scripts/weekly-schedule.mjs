#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const NEWSAPI_URL = "https://newsapi.org/v2/top-headlines";
const YONHAP_ECONOMY_RSS_URL = "https://www.yonhapnews.co.kr/rss/economy.xml";
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

function ymdFromUnix(sec) {
  if (!sec) return "";
  return seoulYmd(new Date(Number(sec) * 1000));
}

function timeLabelFromUnix(sec) {
  if (!sec) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(Number(sec) * 1000));
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

function normalizeNews(data) {
  const rows = Array.isArray(data) ? data : [];
  return rows.slice(0, 20).map((row) => ({
    headline: row.headline || "",
    url: row.url || "",
    datetime: row.datetime || null,
    date: ymdFromUnix(row.datetime),
    timeLabel: timeLabelFromUnix(row.datetime),
    source: row.source || "",
  }));
}

function normalizeNewsApi(data) {
  const rows = Array.isArray(data?.articles) ? data.articles : [];
  return rows
    .slice(0, 20)
    .map((row) => ({
      headline: row.title || "",
      url: row.url || "",
      datetime: row.publishedAt || null,
      date: row.publishedAt ? seoulYmd(new Date(row.publishedAt)) : "",
      timeLabel: kstNewsTimeLabel(row.publishedAt),
      source: row.source && row.source.name ? row.source.name : "NewsAPI",
    }))
    .filter((row) => row.headline);
}

function normalizeYonhapRss(xml) {
  const items = String(xml || "").match(/<item>[\s\S]*?<\/item>/g) || [];
  return items
    .slice(0, 20)
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
        source: "연합뉴스",
      };
    })
    .filter((row) => row.headline);
}

async function fetchKoreanNews() {
  const newsApiKey = String(process.env.NEWSAPI_KEY || "").trim();
  if (newsApiKey) {
    try {
      const url = new URL(NEWSAPI_URL);
      url.searchParams.set("country", "kr");
      url.searchParams.set("category", "business");
      url.searchParams.set("pageSize", "20");
      url.searchParams.set("apiKey", newsApiKey);
      const text = await fetchText(url, { accept: "application/json" });
      const rows = normalizeNewsApi(JSON.parse(text));
      if (rows.length) return rows;
      console.warn("NewsAPI returned no Korean business news; falling back to Yonhap RSS.");
    } catch (error) {
      console.warn(`NewsAPI fetch failed; falling back to Yonhap RSS: ${error instanceof Error ? error.message : error}`);
    }
  }
  const xml = await fetchText(YONHAP_ECONOMY_RSS_URL, { accept: "application/rss+xml, application/xml, text/xml" });
  return normalizeYonhapRss(xml);
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
