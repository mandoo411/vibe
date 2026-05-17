#!/usr/bin/env node
/**
 * 장전 브리핑 데이터 수집
 * - 미국시장, 주요 종목, 섹터 ETF, 환율/원자재, crypto, 국내 뉴스 수집
 * - Claude 분석
 * - public/data/morning-briefing.json 저장
 *
 * 필수: ANTHROPIC_API_KEY
 * 권장: KIS_ACCESS_TOKEN, KIS_APP_KEY, KIS_APP_SECRET, NEWSAPI_KEY
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const KIS_BASE_URL = (process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(/\/+$/, "");
const KIS_INDEX_PATH = "/uapi/overseas-price/v1/quotations/inquire-daily-chartprice";
const KIS_INDEX_TR_ID = "FHKST03030100";
const KIS_PRICE_PATH = "/uapi/overseas-price/v1/quotations/price";
const KIS_PRICE_TR_ID = "HHDFS00000300";
const EXCHANGE_RATE_URL = "https://open.er-api.com/v6/latest/USD";
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true&include_market_cap=true";
const NEWSAPI_URL = "https://newsapi.org/v2/everything";
const OUTPUT_PATH = path.resolve(process.env.OUTPUT_PATH || "public/data/morning-briefing.json");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

const US_INDICES = [
  { id: "sp500", name: "S&P 500", kisSymbol: "SPX", yahooSymbol: "^GSPC" },
  { id: "nasdaq", name: "나스닥", kisSymbol: "NAS", yahooSymbol: "^IXIC" },
  { id: "dow", name: "다우존스", kisSymbol: "DJI", yahooSymbol: "^DJI" },
];

const TOP_STOCKS = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "TSLA", "GOOGL", "AMD", "PLTR", "COIN"];

const SECTOR_ETFS = [
  { symbol: "XLK", sector: "기술" },
  { symbol: "XLF", sector: "금융" },
  { symbol: "XLE", sector: "에너지" },
  { symbol: "XLV", sector: "헬스케어" },
  { symbol: "XLI", sector: "산업" },
  { symbol: "XLY", sector: "소비재" },
  { symbol: "XLP", sector: "필수소비" },
  { symbol: "XLU", sector: "유틸리티" },
  { symbol: "XLB", sector: "소재" },
  { symbol: "XLRE", sector: "부동산" },
];

const COMMODITIES = [
  { id: "wti", name: "WTI유가", symbol: "CL=F" },
  { id: "gold", name: "금", symbol: "GC=F" },
  { id: "silver", name: "은", symbol: "SI=F" },
  { id: "copper", name: "구리", symbol: "HG=F" },
];

const NEWS_RSS_FEEDS = [
  { url: "https://rss.hankyung.com/economy.xml", source: "한국경제" },
  { url: "https://www.mk.co.kr/rss/30000001/", source: "매일경제" },
];

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function optionalEnv(name) {
  return String(process.env[name] || "").trim();
}

function sanitizeStr(value) {
  return value == null ? "" : String(value).trim();
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const normalized = typeof value === "string" ? value.replace(/[%,$,\s]/g, "").replace(/^\+/, "") : value;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  const n = toNumber(value);
  return n == null ? null : Math.round(n * 100) / 100;
}

function pickFirst(row, keys) {
  if (!row || typeof row !== "object") return "";
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim() !== "") return value;
  }
  return "";
}

function seoulDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return { year: get("year"), month: get("month"), day: get("day") };
}

function seoulYmd(date = new Date()) {
  const { year, month, day } = seoulDateParts(date);
  return `${year}-${month}-${day}`;
}

function compactYmd(date = new Date()) {
  return seoulYmd(date).replace(/-/g, "");
}

function addDaysKst(ymd, days) {
  const date = new Date(`${ymd}T12:00:00+09:00`);
  date.setDate(date.getDate() + days);
  return seoulYmd(date);
}

function kstIso(ymd, hhmm) {
  return `${ymd}T${hhmm}:00+09:00`;
}

function newsWindow(now = new Date()) {
  const today = seoulYmd(now);
  const yesterday = addDaysKst(today, -1);
  return {
    from: kstIso(yesterday, "15:30"),
    to: kstIso(today, "06:00"),
  };
}

function inNewsWindow(value, window) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date >= new Date(window.from) && date <= new Date(window.to);
}

function kstTimeLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "user-agent": USER_AGENT,
      accept: "*/*",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 280)}`);
  return text;
}

async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, {
    ...opts,
    headers: {
      accept: "application/json",
      ...(opts.headers || {}),
    },
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`);
  }
}

function kisAuth() {
  const token = optionalEnv("KIS_ACCESS_TOKEN");
  const appkey = optionalEnv("KIS_APP_KEY");
  const appsecret = optionalEnv("KIS_APP_SECRET");
  if (!token || !appkey || !appsecret) throw new Error("Missing KIS_ACCESS_TOKEN, KIS_APP_KEY, or KIS_APP_SECRET");
  return { token, appkey, appsecret };
}

function isKisTokenError(body) {
  const blob = `${body?.msg_cd || ""} ${body?.msg1 || ""} ${body?.message || ""}`;
  return /EGW00121|기간이 만료|기간 만료|토큰|token/i.test(blob);
}

async function kisGet(pathname, trId, params) {
  const { token, appkey, appsecret } = kisAuth();
  const url = new URL(pathname, KIS_BASE_URL);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value == null ? "" : String(value));
  }
  const json = await fetchJson(url.toString(), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey,
      appsecret,
      tr_id: trId,
      custtype: "P",
    },
  });
  if (isKisTokenError(json)) throw new Error("KIS_ACCESS_TOKEN expired or invalid (EGW00121)");
  if (json.rt_cd && json.rt_cd !== "0") throw new Error(`KIS rt_cd=${json.rt_cd} msg=${json.msg1 || json.msg_cd || ""}`);
  return json;
}

function outputObject(body, preferred) {
  const value = preferred ? body?.[preferred] : null;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  for (const key of ["output", "output1", "output2", "OUTPUT"]) {
    const candidate = body?.[key];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
    if (Array.isArray(candidate) && candidate[0] && typeof candidate[0] === "object") return candidate[0];
  }
  return {};
}

async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const json = await fetchJson(url);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo chart empty: ${symbol}`);
  const meta = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  const validCloses = Array.isArray(closes) ? closes.filter((n) => n != null && Number.isFinite(Number(n))) : [];
  const price = round2(meta.regularMarketPrice ?? validCloses.at(-1));
  const previousClose = round2(meta.chartPreviousClose ?? meta.previousClose ?? validCloses.at(-2));
  const changePoints = price != null && previousClose != null ? round2(price - previousClose) : null;
  const changePct = price != null && previousClose ? round2((changePoints / previousClose) * 100) : null;
  return { symbol, price, previousClose, changePoints, changePct };
}

async function fetchKisIndex(index) {
  const body = await kisGet(KIS_INDEX_PATH, KIS_INDEX_TR_ID, {
    FID_COND_MRKT_DIV_CODE: "N",
    FID_INPUT_ISCD: index.kisSymbol,
    FID_INPUT_DATE_1: compactYmd(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
    FID_INPUT_DATE_2: compactYmd(),
    FID_PERIOD_DIV_CODE: "D",
  });
  const out = outputObject(body, "output1");
  return {
    id: index.id,
    name: index.name,
    symbol: index.kisSymbol,
    close: round2(pickFirst(out, ["ovrs_nmix_prpr", "OVRS_NMIX_PRPR"])),
    previousClose: null,
    changePct: round2(pickFirst(out, ["prdy_ctrt", "PRDY_CTRT"])),
    changePoints: round2(pickFirst(out, ["ovrs_nmix_prdy_vrss", "OVRS_NMIX_PRDY_VRSS"])),
  };
}

async function fetchUsMarket() {
  const indices = [];
  for (const index of US_INDICES) {
    try {
      indices.push(await fetchKisIndex(index));
    } catch {
      const q = await fetchYahooQuote(index.yahooSymbol);
      indices.push({
        id: index.id,
        name: index.name,
        symbol: index.yahooSymbol,
        close: q.price,
        previousClose: q.previousClose,
        changePct: q.changePct,
        changePoints: q.changePoints,
      });
    }
    await delay(250);
  }
  return { indices };
}

async function fetchKisStock(symbol) {
  const body = await kisGet(KIS_PRICE_PATH, KIS_PRICE_TR_ID, {
    AUTH: "",
    EXCD: "NAS",
    SYMB: symbol,
  });
  const out = outputObject(body);
  const price = round2(pickFirst(out, ["last", "LAST", "ovrs_nmix_prpr", "OVRS_NMIX_PRPR"]));
  const changePct = round2(pickFirst(out, ["rate", "RATE", "prdy_ctrt", "PRDY_CTRT"]));
  const changePoints = round2(pickFirst(out, ["diff", "DIFF", "prdy_vrss", "PRDY_VRSS"]));
  return { symbol, price, changePct, changePoints };
}

async function fetchTopStocks() {
  const rows = [];
  for (const symbol of TOP_STOCKS) {
    try {
      rows.push(await fetchKisStock(symbol));
    } catch {
      const q = await fetchYahooQuote(symbol);
      rows.push({ symbol, price: q.price, changePct: q.changePct, changePoints: q.changePoints });
    }
    await delay(250);
  }
  return rows;
}

async function fetchSectors() {
  const rows = [];
  for (const etf of SECTOR_ETFS) {
    const q = await fetchYahooQuote(etf.symbol);
    rows.push({
      symbol: etf.symbol,
      sector: etf.sector,
      name: `${etf.sector} (${etf.symbol})`,
      price: q.price,
      changePct: q.changePct,
    });
    await delay(250);
  }
  return rows;
}

async function fetchForex() {
  const json = await fetchJson(EXCHANGE_RATE_URL);
  const rates = json?.rates || {};
  const usdKrw = round2(rates.KRW);
  const usdJpy = round2(rates.JPY);
  const usdCny = round2(rates.CNY);
  const eurUsd = rates.EUR ? round2(1 / rates.EUR) : null;
  return {
    rates: {
      "USD/KRW": usdKrw,
      "USD/JPY": usdJpy,
      "USD/CNY": usdCny,
      "EUR/USD": eurUsd,
    },
    base: "USD",
    updatedAt: sanitizeStr(json?.time_last_update_utc || ""),
  };
}

async function fetchCommodities() {
  const rows = [];
  for (const item of COMMODITIES) {
    const q = await fetchYahooQuote(item.symbol);
    rows.push({
      id: item.id,
      name: item.name,
      symbol: item.symbol,
      price: q.price,
      changePct: q.changePct,
      changePoints: q.changePoints,
    });
    await delay(250);
  }
  return rows;
}

async function fetchForexAndCommodities() {
  const [forex, commodities] = await Promise.all([fetchForex(), fetchCommodities()]);
  return { ...forex, commodities };
}

async function fetchCrypto() {
  const json = await fetchJson(COINGECKO_URL);
  const map = {
    bitcoin: "BTC",
    ethereum: "ETH",
    solana: "SOL",
  };
  const assets = Object.entries(map).map(([id, symbol]) => ({
    id,
    symbol,
    priceUsd: round2(json?.[id]?.usd),
    changePct24h: round2(json?.[id]?.usd_24h_change),
    marketCapUsd: round2(json?.[id]?.usd_market_cap),
  }));
  return { assets };
}

function normalizeNewsApi(data, window) {
  const rows = Array.isArray(data?.articles) ? data.articles : [];
  return rows
    .map((row) => ({
      title: sanitizeStr(row.title),
      url: sanitizeStr(row.url),
      source: sanitizeStr(row.source?.name || "NewsAPI"),
      publishedAt: sanitizeStr(row.publishedAt),
    }))
    .filter((row) => row.title && row.url && inNewsWindow(row.publishedAt, window))
    .slice(0, 30);
}

function normalizeRss(xml, source, window) {
  const items = String(xml || "").match(/<item>[\s\S]*?<\/item>/g) || [];
  return items
    .map((item) => {
      const title = decodeXml((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
      const url = decodeXml((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
      const publishedAt = decodeXml((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
      return { title, url, source, publishedAt: publishedAt ? new Date(publishedAt).toISOString() : "" };
    })
    .filter((row) => row.title && row.url && inNewsWindow(row.publishedAt, window))
    .slice(0, 30);
}

async function fetchNewsApi(window) {
  const apiKey = optionalEnv("NEWSAPI_KEY");
  if (!apiKey) return [];
  const url = new URL(NEWSAPI_URL);
  url.searchParams.set("q", "주식 코스피 코스닥 증시");
  url.searchParams.set("language", "ko");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", "30");
  url.searchParams.set("from", window.from);
  url.searchParams.set("to", window.to);
  url.searchParams.set("apiKey", apiKey);
  const json = await fetchJson(url);
  return normalizeNewsApi(json, window);
}

async function fetchRssNews(window) {
  for (const feed of NEWS_RSS_FEEDS) {
    try {
      const xml = await fetchText(feed.url, { headers: { accept: "application/rss+xml, application/xml, text/xml" } });
      const rows = normalizeRss(xml, feed.source, window);
      if (rows.length) return rows;
    } catch (error) {
      console.warn(`[morning-briefing] ${feed.source} RSS failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  return [];
}

async function fetchDomesticNews() {
  const window = newsWindow();
  try {
    const newsApiRows = await fetchNewsApi(window);
    if (newsApiRows.length) return newsApiRows;
  } catch (error) {
    console.warn(`[morning-briefing] NewsAPI failed: ${error instanceof Error ? error.message : error}`);
  }
  return fetchRssNews(window);
}

function parseClaudeJson(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Claude response did not contain JSON");
  return JSON.parse(body.slice(start, end + 1));
}

function buildAnalysisInput(data) {
  return JSON.stringify(
    {
      usMarket: data.usMarket,
      topStocks: data.topStocks,
      sectors: data.sectors,
      forex: data.forex,
      crypto: data.crypto,
      news: data.news,
    },
    null,
    2
  );
}

async function analyzeWithClaude(data) {
  const client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1800,
    system: `당신은 한국 주식 시장 장전 브리핑 애널리스트입니다.
입력 데이터만 근거로 한국어 JSON 객체만 반환하세요. 마크다운, 코드펜스, 설명은 금지입니다.
스키마:
{
  "keyIssues": ["오늘 주목할 핵심 이슈 1", "오늘 주목할 핵심 이슈 2", "오늘 주목할 핵심 이슈 3"],
  "domesticImpact": "국내 증시 영향 분석 2~4문장",
  "watchSectors": ["오늘 주목 섹터/종목 1", "오늘 주목 섹터/종목 2", "오늘 주목 섹터/종목 3"]
}
투자 권유나 단정은 피하고, 리스크와 조건을 함께 언급하세요.`,
    messages: [{ role: "user", content: buildAnalysisInput(data) }],
  });
  const block = msg.content.find((item) => item.type === "text");
  const parsed = parseClaudeJson(block?.text || "");
  return {
    keyIssues: Array.isArray(parsed.keyIssues) ? parsed.keyIssues.map(sanitizeStr).filter(Boolean).slice(0, 3) : [],
    domesticImpact: sanitizeStr(parsed.domesticImpact),
    watchSectors: Array.isArray(parsed.watchSectors) ? parsed.watchSectors.map(sanitizeStr).filter(Boolean).slice(0, 5) : [],
  };
}

async function safeCollect(label, fallback, fn, errors) {
  try {
    return await fn();
  } catch (error) {
    const message = `${label}: ${error instanceof Error ? error.message : error}`;
    console.error("[morning-briefing]", message);
    errors.push(message);
    return fallback;
  }
}

async function main() {
  const errors = [];
  const updatedAt = kstIso(seoulYmd(), "06:00");

  const usMarket = await safeCollect("usMarket", { indices: [] }, fetchUsMarket, errors);
  const topStocks = await safeCollect("topStocks", [], fetchTopStocks, errors);
  const sectors = await safeCollect("sectors", [], fetchSectors, errors);
  const forex = await safeCollect("forex", { rates: {}, commodities: [] }, fetchForexAndCommodities, errors);
  const crypto = await safeCollect("crypto", { assets: [] }, fetchCrypto, errors);
  const news = await safeCollect("news", [], fetchDomesticNews, errors);

  const partial = {
    updatedAt,
    usMarket,
    topStocks,
    sectors,
    forex,
    crypto,
    news,
    aiAnalysis: {
      keyIssues: [],
      domesticImpact: "",
      watchSectors: [],
    },
    errors,
  };

  partial.aiAnalysis = await safeCollect("aiAnalysis", partial.aiAnalysis, () => analyzeWithClaude(partial), errors);

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(partial, null, 2)}\n`, "utf8");
  console.log("[morning-briefing] wrote", OUTPUT_PATH, {
    news: news.length,
    errors: errors.length,
  });
}

main().catch((error) => {
  console.error("[morning-briefing] fatal", error);
  process.exit(1);
});
