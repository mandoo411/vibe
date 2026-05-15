#!/usr/bin/env node
/**
 * 장전 브리핑 — 미국 지수·VIX·공포탐욕·환율/원자재·BTC·미국 상승주·섹터 ETF 수집
 * → Claude 분석 → data/briefing.json
 *
 * 필수: ANTHROPIC_API_KEY
 * 선택: TARGET_DATE=YYYY-MM-DD (기본: 오늘 KST)
 *       ANTHROPIC_MODEL (기본 claude-sonnet-4-5)
 *       OUTPUT_PATH (기본 ./data/briefing.json)
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const US_INDICES = [
  { id: "dow", name: "다우", symbol: "^DJI" },
  { id: "nasdaq", name: "나스닥", symbol: "^IXIC" },
  { id: "sp500", name: "S&P 500", symbol: "^GSPC" },
];

const FX_COMMODITIES = [
  { id: "usdkrw", name: "달러/원", symbol: "KRW=X" },
  { id: "wti", name: "WTI 유가", symbol: "CL=F" },
  { id: "gold", name: "금", symbol: "GC=F" },
];

const SECTOR_ETFS = [
  { symbol: "XLK", name: "기술(XLK)" },
  { symbol: "SOXX", name: "반도체(SOXX)" },
  { symbol: "XLV", name: "헬스케어(XLV)" },
  { symbol: "XLE", name: "에너지(XLE)" },
  { symbol: "XLF", name: "금융(XLF)" },
  { symbol: "XLY", name: "임의소비(XLY)" },
  { symbol: "XLI", name: "산업재(XLI)" },
  { symbol: "XLU", name: "유틸리티(XLU)" },
];

const NASDAQ_EXCHANGES = new Set(["NMS", "NGM", "NCM", "NASDAQ", "Nasdaq", "NasdaqGS", "NasdaqGM"]);

function seoulYmd(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return String(v).trim();
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNumberOrNull(v) {
  if (v === "" || v == null) return null;
  if (typeof v === "string") {
    const s = v.trim().replace(/%/g, "").replace(/,/g, "").replace(/\s/g, "").replace(/^\+/, "");
    if (s === "" || s === "-" || s === ".") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJsonFromAssistant(text) {
  const s = String(text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : s;
  return JSON.parse(raw);
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 280)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`);
  }
}

/** Yahoo Finance v8 chart — 종가·전일 대비 등락률 */
async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const json = await fetchJson(url);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo chart empty: ${symbol}`);

  const meta = result.meta || {};
  let price = toNumberOrNull(meta.regularMarketPrice);
  let prev = toNumberOrNull(meta.chartPreviousClose ?? meta.previousClose);

  const closes = result.indicators?.quote?.[0]?.close;
  if (Array.isArray(closes) && closes.length) {
    const valid = closes.filter((c) => c != null && Number.isFinite(c));
    if (valid.length >= 1 && price == null) price = valid[valid.length - 1];
    if (valid.length >= 2 && prev == null) prev = valid[valid.length - 2];
  }

  let changePct = null;
  if (price != null && prev != null && prev !== 0) {
    changePct = round2(((price - prev) / prev) * 100);
  }

  return {
    symbol,
    price: price != null ? round2(price) : null,
    previousClose: prev != null ? round2(prev) : null,
    changePct,
  };
}

async function fetchUsIndices() {
  const out = [];
  for (const idx of US_INDICES) {
    const q = await fetchYahooQuote(idx.symbol);
    out.push({
      id: idx.id,
      name: idx.name,
      symbol: idx.symbol,
      close: q.price,
      previousClose: q.previousClose,
      changePct: q.changePct,
    });
    await delay(350);
  }
  return out;
}

async function fetchVix() {
  const q = await fetchYahooQuote("^VIX");
  return {
    symbol: "^VIX",
    name: "VIX",
    value: q.price,
    previousClose: q.previousClose,
    changePct: q.changePct,
  };
}

async function fetchFearGreed() {
  const url = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
  const json = await fetchJson(url);
  const fg = json?.fear_and_greed || json?.fear_and_greed_historical?.data?.[0];
  const score = toNumberOrNull(json?.fear_and_greed?.score ?? fg?.score);
  const rating = sanitizeStr(json?.fear_and_greed?.rating ?? fg?.rating);
  const previousScore = toNumberOrNull(
    json?.fear_and_greed?.previous_close ?? json?.fear_and_greed?.previousClose ?? fg?.previous_close
  );
  const timestamp = sanitizeStr(json?.fear_and_greed?.timestamp ?? fg?.x);
  return { score, rating, previousScore, timestamp };
}

async function fetchFxCommodities() {
  const out = [];
  for (const item of FX_COMMODITIES) {
    const q = await fetchYahooQuote(item.symbol);
    out.push({
      id: item.id,
      name: item.name,
      symbol: item.symbol,
      price: q.price,
      previousClose: q.previousClose,
      changePct: q.changePct,
    });
    await delay(350);
  }
  return out;
}

async function fetchBitcoin() {
  const priceUrl =
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,krw&include_24hr_change=true";
  const globalUrl = "https://api.coingecko.com/api/v3/global";
  const [priceJson, globalJson] = await Promise.all([fetchJson(priceUrl), fetchJson(globalUrl)]);
  const btc = priceJson?.bitcoin || {};
  const dominance = toNumberOrNull(globalJson?.data?.market_cap_percentage?.btc);
  return {
    usd: round2(btc.usd),
    krw: round2(btc.krw),
    changePct24h: round2(btc.usd_24h_change),
    dominancePct: round2(dominance),
  };
}

function isNasdaqQuote(q) {
  const ex = sanitizeStr(q.exchange);
  const full = sanitizeStr(q.fullExchangeName);
  if (NASDAQ_EXCHANGES.has(ex)) return true;
  if (/nasdaq/i.test(full)) return true;
  return false;
}

/** 나스닥 상승률 상위 — Yahoo predefined screener 후 거래소 필터 */
async function fetchUsGainersTop10() {
  const url =
    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=50";
  const json = await fetchJson(url);
  const quotes =
    json?.finance?.result?.[0]?.quotes ||
    json?.finance?.result?.quotes ||
    [];

  const nasdaq = quotes
    .filter((q) => q && isNasdaqQuote(q))
    .filter((q) => toNumberOrNull(q.regularMarketChangePercent) != null)
    .sort(
      (a, b) =>
        (toNumberOrNull(b.regularMarketChangePercent) || 0) -
        (toNumberOrNull(a.regularMarketChangePercent) || 0)
    );

  const picked = (nasdaq.length >= 5 ? nasdaq : quotes).slice(0, 10);

  return picked.map((q, i) => ({
    rank: i + 1,
    ticker: sanitizeStr(q.symbol),
    name: sanitizeStr(q.shortName || q.longName || q.symbol),
    changePct: round2(toNumberOrNull(q.regularMarketChangePercent)),
    sector: sanitizeStr(q.sector || q.sectorDisp || ""),
    exchange: sanitizeStr(q.exchange || q.fullExchangeName),
  }));
}

async function fetchSectorEtfs() {
  const out = [];
  for (const etf of SECTOR_ETFS) {
    const sym = etf.symbol;
    const q = await fetchYahooQuote(sym);
    out.push({
      symbol: sym,
      name: etf.name,
      price: q.price,
      previousClose: q.previousClose,
      changePct: q.changePct,
    });
    await delay(350);
  }
  return out;
}

function buildClaudePayload(data) {
  const lines = [];
  lines.push(`대상 날짜(KST): ${data.ymd}`);
  lines.push("");
  lines.push("=== 미국 3대 지수 (전일 마감) ===");
  for (const x of data.usIndices) {
    lines.push(
      `${x.name} (${x.symbol}): 종가 ${x.close ?? "—"}, 등락률 ${x.changePct != null ? (x.changePct > 0 ? "+" : "") + x.changePct + "%" : "—"}`
    );
  }
  lines.push("");
  lines.push("=== VIX ===");
  lines.push(
    `VIX: ${data.vix?.value ?? "—"}, 등락률 ${data.vix?.changePct != null ? data.vix.changePct + "%" : "—"}`
  );
  lines.push("");
  lines.push("=== CNN 공포탐욕지수 ===");
  lines.push(
    `점수 ${data.fearGreed?.score ?? "—"} (${data.fearGreed?.rating || "—"}), 이전 ${data.fearGreed?.previousScore ?? "—"}`
  );
  lines.push("");
  lines.push("=== 환율·원자재 ===");
  for (const x of data.fxCommodities) {
    lines.push(
      `${x.name}: ${x.price ?? "—"}, 등락률 ${x.changePct != null ? x.changePct + "%" : "—"}`
    );
  }
  lines.push("");
  lines.push("=== 비트코인 (CoinGecko) ===");
  lines.push(
    `USD ${data.bitcoin?.usd ?? "—"}, KRW ${data.bitcoin?.krw ?? "—"}, 24h ${data.bitcoin?.changePct24h ?? "—"}%, 도미넌스 ${data.bitcoin?.dominancePct ?? "—"}%`
  );
  lines.push("");
  lines.push("=== 미국(나스닥) 상승 TOP10 ===");
  for (const g of data.usGainers) {
    lines.push(
      `#${g.rank} ${g.ticker} ${g.name} ${g.changePct != null ? "+" + g.changePct + "%" : "—"} [${g.sector || "섹터 미상"}]`
    );
  }
  lines.push("");
  lines.push("=== 섹터 ETF 등락률 ===");
  for (const e of data.sectorEtfs) {
    lines.push(`${e.symbol} ${e.name}: ${e.changePct != null ? e.changePct + "%" : "—"}`);
  }
  if (data.errors?.length) {
    lines.push("");
    lines.push("=== 수집 경고 ===");
    data.errors.forEach((err) => lines.push(`- ${err}`));
  }
  return lines.join("\n");
}

async function analyzeWithClaude({ apiKey, model, data }) {
  const client = new Anthropic({ apiKey });
  const userText = buildClaudePayload(data);

  const system = `당신은 한국 주식 시장 장전 브리핑 애널리스트입니다.
입력은 미국 마감·VIX·공포탐욕·환율/원자재·비트코인·미국 상승주·섹터 ETF 데이터입니다.

반드시 아래 JSON 객체만 출력하세요. 마크다운·코드펜스·설명 금지.

{
  "oneLiner": "오늘 국내시장 한줄 요약 (한국어 1문장, 40~80자)",
  "sectorsTop3": ["주목 섹터1", "주목 섹터2", "주목 섹터3"],
  "flowOutlook": "미국→국내 수급 예상 흐름 (한국어 2~4문장)",
  "strategyPoints": "오늘 전략 포인트 (한국어 2~4문장, 불릿 없이 문단)"
}

규칙:
- 입력 데이터에 근거해 작성. 없는 수치는 만들지 마세요.
- 투자 권유·단정적 예측은 피하고, 맥락·리스크 균형을 유지하세요.
- sectorsTop3는 한국 투자자 관점의 섹터/테마 키워드 3개(짧게).`;

  const msg = await client.messages.create({
    model,
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: userText }],
  });

  const block = msg.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("Unexpected Claude response shape");
  const parsed = parseJsonFromAssistant(block.text);

  return {
    oneLiner: sanitizeStr(parsed.oneLiner),
    sectorsTop3: Array.isArray(parsed.sectorsTop3)
      ? parsed.sectorsTop3.map((s) => sanitizeStr(s)).filter(Boolean).slice(0, 3)
      : [],
    flowOutlook: sanitizeStr(parsed.flowOutlook),
    strategyPoints: sanitizeStr(parsed.strategyPoints),
  };
}

async function safeRun(label, fn, errors) {
  try {
    return await fn();
  } catch (e) {
    const msg = `${label}: ${e && e.message ? e.message : String(e)}`;
    console.error("[morning-briefing]", msg);
    errors.push(msg);
    return null;
  }
}

async function main() {
  const targetYmd = process.env.TARGET_DATE?.trim() || seoulYmd();
  const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-5";
  const outputPath = path.resolve(process.cwd(), process.env.OUTPUT_PATH?.trim() || "./data/briefing.json");
  const apiKey = requireEnv("ANTHROPIC_API_KEY");

  const errors = [];
  const generatedAt = new Date().toISOString();

  console.log("[morning-briefing] collecting", { targetYmd });

  const usIndices =
    (await safeRun("usIndices", fetchUsIndices, errors)) || US_INDICES.map((i) => ({
      id: i.id,
      name: i.name,
      symbol: i.symbol,
      close: null,
      previousClose: null,
      changePct: null,
    }));

  const vix =
    (await safeRun("vix", fetchVix, errors)) || {
      symbol: "^VIX",
      name: "VIX",
      value: null,
      previousClose: null,
      changePct: null,
    };

  const fearGreed =
    (await safeRun("fearGreed", fetchFearGreed, errors)) || {
      score: null,
      rating: "",
      previousScore: null,
      timestamp: "",
    };

  const fxCommodities =
    (await safeRun("fxCommodities", fetchFxCommodities, errors)) ||
    FX_COMMODITIES.map((i) => ({
      id: i.id,
      name: i.name,
      symbol: i.symbol,
      price: null,
      previousClose: null,
      changePct: null,
    }));

  const bitcoin =
    (await safeRun("bitcoin", fetchBitcoin, errors)) || {
      usd: null,
      krw: null,
      changePct24h: null,
      dominancePct: null,
    };

  const usGainers = (await safeRun("usGainers", fetchUsGainersTop10, errors)) || [];

  const sectorEtfs =
    (await safeRun("sectorEtfs", fetchSectorEtfs, errors)) ||
    SECTOR_ETFS.map((e) => ({
      symbol: e.symbol,
      name: e.name,
      price: null,
      previousClose: null,
      changePct: null,
    }));

  const partial = {
    ymd: targetYmd,
    generatedAt,
    usIndices,
    vix,
    fearGreed,
    fxCommodities,
    bitcoin,
    usGainers,
    sectorEtfs,
    errors,
  };

  let analysis = {
    oneLiner: "",
    sectorsTop3: [],
    flowOutlook: "",
    strategyPoints: "",
  };

  try {
    analysis = await analyzeWithClaude({ apiKey, model, data: partial });
  } catch (e) {
    const msg = `claude: ${e && e.message ? e.message : String(e)}`;
    console.error("[morning-briefing]", msg);
    errors.push(msg);
  }

  const briefing = {
    ...partial,
    analysis,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(briefing, null, 2)}\n`, "utf8");
  console.log("[morning-briefing] wrote", outputPath, {
    errors: errors.length,
    gainers: usGainers.length,
  });
}

main().catch((e) => {
  console.error("[morning-briefing] fatal", e);
  process.exit(1);
});
