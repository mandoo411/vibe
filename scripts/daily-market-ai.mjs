/**
 * 장마감 리포트 Claude 분석 (Haiku web_search 사전수집 + Sonnet JSON)
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  buildFallbackDailyClosingReport,
  ensureJsonSafe,
  isClaudeUnavailableError,
  parseJsonFromAssistant,
  sanitizeUnicode,
} from "./claude-utils.mjs";

const WEB_SEARCH_DELAY_MS = 350;
const WEB_SEARCH_MODEL = process.env.ANTHROPIC_SEARCH_MODEL || "claude-haiku-4-5-20251001";

function sanitizeStr(v) {
  return v == null ? "" : sanitizeUnicode(String(v).trim());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Anthropic Messages API web_search (Haiku, Node.js 직접 호출) */
export async function fetchWebSearch(query, apiKey = process.env.ANTHROPIC_API_KEY) {
  const key = sanitizeStr(apiKey);
  if (!key) {
    console.warn("[web-search] ANTHROPIC_API_KEY missing");
    return "";
  }
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      },
      body: JSON.stringify({
        model: WEB_SEARCH_MODEL,
        max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [
          {
            role: "user",
            content: `다음을 웹서치해서 핵심 내용만 2-3문장으로 요약해줘: ${query}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await response.json();
    if (!response.ok || data?.error) {
      const msg = data?.error?.message || `HTTP ${response.status}`;
      console.warn(`[web-search] ${query}: ${msg}`);
      return "";
    }
    const text = (Array.isArray(data.content) ? data.content : [])
      .filter((b) => b && b.type === "text")
      .map((b) => b.text || "")
      .join("");
    return sanitizeStr(text);
  } catch (e) {
    console.warn(`[web-search] ${query}:`, e instanceof Error ? e.message : e);
    return "";
  }
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtEok(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const sign = v > 0 ? "+" : "";
  if (Math.abs(v) >= 10000) return `${sign}${(v / 10000).toFixed(1)}조`;
  return `${sign}${Math.round(v).toLocaleString("ko-KR")}억`;
}

function fmtPricePlain(v) {
  if (v == null || v === "") return "—";
  const n = Number(String(v).replace(/,/g, ""));
  if (Number.isFinite(n)) return n.toLocaleString("ko-KR");
  return sanitizeStr(v);
}

function findUsdKrw(marketExtras) {
  if (!Array.isArray(marketExtras)) return null;
  return marketExtras.find((r) => /원\s*\/?\s*달러|USD\/KRW|원\/달러/i.test(String(r.label || "")));
}

function mcapRankOf(code, mcapRankByCode) {
  if (!code || !mcapRankByCode) return null;
  if (mcapRankByCode instanceof Map) return mcapRankByCode.get(code) ?? null;
  if (typeof mcapRankByCode === "object") return mcapRankByCode[code] ?? null;
  return null;
}

function buildMcapTop100Movers(topGainers, topDecliners, mcapRankByCode, limit = 15) {
  const inTop100 = (s) => {
    const rank = mcapRankOf(s?.code, mcapRankByCode);
    return rank != null && rank <= 100;
  };
  const up = [...(topGainers || [])]
    .filter(inTop100)
    .sort((a, b) => (Number(b.change) || 0) - (Number(a.change) || 0))
    .slice(0, limit);
  const down = [...(topDecliners || [])]
    .filter(inTop100)
    .sort((a, b) => (Number(a.change) || 0) - (Number(b.change) || 0))
    .slice(0, limit);
  return { up, down };
}

function newsFromMap(newsMap, code) {
  if (!newsMap || !code) return "";
  const list = newsMap instanceof Map ? newsMap.get(code) : newsMap[code];
  if (!Array.isArray(list) || !list.length) return "";
  return list.slice(0, 3).map((t) => sanitizeStr(t)).filter(Boolean).join(" / ");
}

function mergeNewsText(primary, fallback) {
  const a = sanitizeStr(primary);
  const b = sanitizeStr(fallback);
  if (a && b) return `${a}\n${b}`;
  return a || b || "(수집된 뉴스 없음)";
}

/** Claude 호출 전 매크로·특징주 뉴스 사전 수집 */
export async function collectSearchContext({
  targetYmd,
  topGainers,
  topDecliners,
  mcapRankByCode,
  newsMap,
  apiKey,
}) {
  console.log("[daily-market-ai] Anthropic Haiku web_search 사전 수집 시작...");

  const macro1 = await fetchWebSearch(`코스피 ${targetYmd} 마감 시황 외국인 수급 FOMC`, apiKey);
  await delay(WEB_SEARCH_DELAY_MS);
  const macro2 = await fetchWebSearch(`${targetYmd} 코스피 코스닥 마감 시황 수급`, apiKey);
  const macroNews = mergeNewsText(macro1, macro2);
  await delay(WEB_SEARCH_DELAY_MS);

  const fomcNews = await fetchWebSearch(`FOMC 금리 결정 ${targetYmd} 한국 증시`, apiKey);
  await delay(WEB_SEARCH_DELAY_MS);

  const foreignFlowNews = await fetchWebSearch(`${targetYmd} 외국인 기관 순매수 순매도`, apiKey);

  const stockNews = {};
  for (const stock of (topGainers || []).slice(0, 10)) {
    await delay(WEB_SEARCH_DELAY_MS);
    const searched = await fetchWebSearch(`${stock.name} 급등 이유 ${targetYmd}`, apiKey);
    stockNews[stock.code] = mergeNewsText(searched, newsFromMap(newsMap, stock.code));
  }

  const { down: mcapDown } = buildMcapTop100Movers(topGainers, topDecliners, mcapRankByCode);
  const declineNews = {};
  for (const stock of mcapDown.slice(0, 5)) {
    await delay(WEB_SEARCH_DELAY_MS);
    const searched = await fetchWebSearch(`${stock.name} 급락 이유 ${targetYmd}`, apiKey);
    declineNews[stock.code] = mergeNewsText(searched, newsFromMap(newsMap, stock.code));
  }

  console.log(
    `[daily-market-ai] 웹서치 완료 — 매크로 ${macroNews.length > 0 ? "OK" : "없음"}, 특징주 ${Object.keys(stockNews).length}건`
  );

  return { macroNews, fomcNews, foreignFlowNews, stockNews, declineNews, mcapDown };
}

function buildSupplyLines(supply) {
  if (!Array.isArray(supply) || !supply.length) {
    return ["(수급 데이터 없음)"];
  }
  const lines = [];
  for (const row of supply) {
    lines.push(`[${row.market}]`);
    lines.push(`  외국인: ${fmtEok(row.foreign)}`);
    lines.push(`  기관: ${fmtEok(row.institution)}`);
    lines.push(`  개인: ${fmtEok(row.retail ?? row.individual)}`);
  }
  return lines;
}

function buildUserPrompt({
  targetYmd,
  indexes,
  supply,
  marketExtras,
  topGainers,
  topDecliners,
  mcapRankByCode,
  searchContext,
}) {
  const lines = [];
  const fx = findUsdKrw(marketExtras);
  const ctx = searchContext || {};
  const mcapDown = ctx.mcapDown || buildMcapTop100Movers(topGainers, topDecliners, mcapRankByCode).down;

  lines.push(`오늘 장마감 데이터 (${targetYmd} KST)`);
  lines.push("");

  lines.push("=== 오늘 매크로 뉴스 ===");
  lines.push(sanitizeStr(ctx.macroNews) || "(없음)");
  lines.push("");
  lines.push("[FOMC·금리]");
  lines.push(sanitizeStr(ctx.fomcNews) || "(없음)");
  if (ctx.foreignFlowNews) {
    lines.push("");
    lines.push("[외국인·기관 수급 뉴스]");
    lines.push(sanitizeStr(ctx.foreignFlowNews));
  }

  lines.push("");
  lines.push("=== 특징주 뉴스 ===");
  const stockNews = ctx.stockNews || {};
  for (const stock of (topGainers || []).slice(0, 10)) {
    lines.push(`${stock.name}: ${stockNews[stock.code] || "(수집된 뉴스 없음)"}`);
  }
  if (Object.keys(ctx.declineNews || {}).length) {
    lines.push("");
    lines.push("[시총 100위 내 하락 종목 뉴스]");
    for (const stock of mcapDown.slice(0, 5)) {
      lines.push(`${stock.name}: ${ctx.declineNews[stock.code] || "(수집된 뉴스 없음)"}`);
    }
  }

  lines.push("");
  lines.push("=== 지수 마감 ===");
  for (const idx of indexes || []) {
    lines.push(`${idx.name}: ${idx.value || "—"} / 등락률 ${fmtPct(idx.change)}`);
  }
  if (fx) {
    const fxVal = fx.valueFormatted || fx.value || "—";
    lines.push(`원/달러: ${fxVal}`);
  }

  lines.push("");
  lines.push("=== 상승률 TOP10 ===");
  (topGainers || []).slice(0, 10).forEach((s, i) => {
    lines.push(`${i + 1}. ${s.name} ${fmtPct(s.change)} 현재가:${fmtPricePlain(s.currentPrice || s.price)}원`);
  });

  lines.push("");
  lines.push("=== 시총 100위 내 하락 상위 ===");
  if (!mcapDown.length) lines.push("(해당 없음)");
  else {
    mcapDown.slice(0, 10).forEach((s, i) => {
      lines.push(`${i + 1}. ${s.name} ${fmtPct(s.change)} 현재가:${fmtPricePlain(s.currentPrice || s.price)}원`);
    });
  }

  lines.push("");
  lines.push("=== 수급 현황 (억원, 순매수) ===");
  lines.push(...buildSupplyLines(supply));

  lines.push("");
  lines.push("=== 출력 JSON 스키마 (순수 JSON만) ===");
  lines.push(`{
  "date": "${targetYmd}",
  "summary": "핵심 한 줄 요약",
  "kospi": { "close": 0, "change": 0, "pct": 0 },
  "kosdaq": { "close": 0, "change": 0, "pct": 0 },
  "usd_krw": 0,
  "analysis": "시장 흐름 분석 텍스트",
  "investor_trend": {
    "kospi": { "foreign": "...", "institution": "...", "individual": "..." },
    "kosdaq": { "foreign": "...", "institution": "...", "individual": "..." }
  },
  "featured_stocks": [
    { "name": "", "code": "", "price": 0, "change_pct": 0, "type": "급등|급락", "reason": "", "point": "" }
  ],
  "watchlist": ["...", "...", "..."],
  "strategy": { "kospi": "", "kosdaq": "", "market_type": "" }
}`);

  lines.push("");
  lines.push(
    "위 제공 데이터(지수/수급/종목/뉴스)만 근거로 JSON을 작성하세요. 뉴스에 재료가 없는 종목은 featured_stocks에서 제외하세요."
  );
  return lines.join("\n");
}

function buildSystemPrompt() {
  return `당신은 TotalMoney AI 수석 애널리스트입니다.
제공된 데이터(지수/수급/종목/뉴스)를 기반으로
마감시황 리포트를 JSON으로 작성합니다.

[분석 원칙]
1. 지수 등락 원인은 수급 데이터 기반으로 설명
   - 외국인/기관/개인 수급 금액과 방향 반드시 언급
   - 소형 테마주를 지수 원인으로 쓰지 말 것
2. 특징주 재료는 제공된 뉴스에서만 추출
   - 뉴스에 없으면 '재료 미확인'으로 표기 후 제외
3. 핵심 한 줄: 오늘 장 전체를 관통하는 원인 1문장
4. 총평: 코스피/코스닥 각각 전략 + 내일 변수 3개

[출력 규칙]
순수 JSON만 출력. 텍스트 설명 절대 금지.
JSON 앞뒤 설명·코드블록(\`\`\`) 금지. { 로 시작해 } 로 끝날 것.`;
}

function normalizeFeaturedStock(s) {
  if (!s || typeof s !== "object") return null;
  const changeRaw = s.change_pct ?? s.change ?? s.changePct;
  const changeNum = Number(changeRaw);
  const change = Number.isFinite(changeNum) ? changeNum : null;
  const name = sanitizeStr(s.name);
  if (!name) return null;
  const reason = sanitizeStr(s.reason || s.entryReason);
  const point = sanitizeStr(s.point || s.background);
  if (/재료\s*미확인/i.test(reason)) return null;
  return {
    name,
    code: sanitizeStr(s.code),
    price: s.price ?? s.currentPrice ?? null,
    change,
    change_pct: change,
    type: sanitizeStr(s.type) || (change != null && change < 0 ? "급락" : "급등"),
    reason,
    point,
    entryReason: reason,
    background: point,
  };
}

function normalizeFeaturedList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeFeaturedStock).filter(Boolean).slice(0, 10);
}

function buildSupplyComment(investorTrend) {
  if (!investorTrend || typeof investorTrend !== "object") return "";
  const parts = [];
  const map = [
    ["kospi", "코스피"],
    ["kosdaq", "코스닥"],
  ];
  for (const [key, label] of map) {
    const row = investorTrend[key];
    if (!row) continue;
    parts.push(
      `${label}: 외국인 ${sanitizeStr(row.foreign) || "—"}, 기관 ${sanitizeStr(row.institution) || "—"}, 개인 ${sanitizeStr(row.individual) || "—"}`
    );
  }
  return parts.join(" | ");
}

function buildHeadlineIssue(summary, strategy) {
  const s = sanitizeStr(summary);
  if (s) return s;
  return sanitizeStr(strategy?.market_type);
}

function parseClaudeMessageContent(content) {
  const fullText = (Array.isArray(content) ? content : [])
    .filter((item) => item && item.type === "text")
    .map((item) => item.text || "")
    .join("\n")
    .trim();

  if (!fullText) throw new Error("Claude output empty");

  const jsonMatch =
    fullText.match(/```json\s*([\s\S]*?)\s*```/i) || fullText.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch ? jsonMatch[1] : fullText;

  const parsed = parseJsonFromAssistant(jsonStr.trim());
  if (!parsed || typeof parsed !== "object") throw new Error("Claude output invalid");
  return parsed;
}

export async function analyzeDailyClosingReport({
  apiKey,
  model,
  targetYmd,
  indexes,
  supply,
  sectors,
  topGainers,
  topDecliners,
  volumeLeaders,
  telegramMessages,
  pressNews,
  stocksForThemes,
  newsMap,
  marketExtras,
  mcapRankByCode,
}) {
  const searchContext = await collectSearchContext({
    targetYmd,
    topGainers,
    topDecliners,
    mcapRankByCode,
    newsMap,
    apiKey,
  });

  const user = ensureJsonSafe(
    buildUserPrompt({
      targetYmd,
      indexes,
      supply,
      marketExtras,
      topGainers,
      topDecliners,
      mcapRankByCode,
      searchContext,
    })
  );

  let parsed;
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: 14000,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: user }],
    });

    parsed = parseClaudeMessageContent(response?.content);
  } catch (error) {
    console.warn(
      `[daily-market-ai] Claude failed (${isClaudeUnavailableError(error) ? "billing/unavailable" : "error"}), using fallback:`,
      error instanceof Error ? error.message : error
    );
    return buildFallbackDailyClosingReport({
      targetYmd,
      indexes,
      supply,
      sectors,
      topGainers,
    });
  }

  const featured = normalizeFeaturedList(parsed.featured_stocks || parsed.issueStocks);
  const summary = sanitizeStr(parsed.summary);
  const analysis = sanitizeStr(parsed.analysis);
  const watchlist = Array.isArray(parsed.watchlist)
    ? parsed.watchlist.map((w) => sanitizeStr(w)).filter(Boolean).slice(0, 3)
    : [];
  const investorTrend =
    parsed.investor_trend && typeof parsed.investor_trend === "object" ? parsed.investor_trend : {};
  const strategy = parsed.strategy && typeof parsed.strategy === "object" ? parsed.strategy : {};

  const stocks = Array.isArray(parsed.stocks) ? parsed.stocks : [];
  if (stocksForThemes?.length && stocks.length !== stocksForThemes.length) {
    console.warn(`Claude stocks length ${stocks.length} != ${stocksForThemes.length}, padding`);
  }

  return {
    date: sanitizeStr(parsed.date) || targetYmd,
    summary,
    headlineIssue: buildHeadlineIssue(summary, strategy),
    supplyComment: buildSupplyComment(investorTrend) || sanitizeStr(parsed.supplyComment),
    analysis: analysis || summary,
    marketSummary: summary || analysis,
    investor_trend: investorTrend,
    strategy,
    kospi: parsed.kospi && typeof parsed.kospi === "object" ? parsed.kospi : null,
    kosdaq: parsed.kosdaq && typeof parsed.kosdaq === "object" ? parsed.kosdaq : null,
    usd_krw: parsed.usd_krw ?? null,
    issueStocks: featured,
    featured_stocks: featured,
    sectorFlow: parsed.sectorFlow && typeof parsed.sectorFlow === "object" ? parsed.sectorFlow : {},
    tomorrowCheckpoints: watchlist,
    watchlist,
    oneLineVerdict: summary || sanitizeStr(parsed.oneLineVerdict),
    notableStocks: Array.isArray(parsed.notableStocks) ? parsed.notableStocks : [],
    stocks,
    topNews: Array.isArray(parsed.topNews) ? parsed.topNews : [],
    marketExtraComments:
      parsed.marketExtraComments && typeof parsed.marketExtraComments === "object"
        ? parsed.marketExtraComments
        : {},
  };
}
