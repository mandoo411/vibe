/**
 * 장마감 리포트 Claude 분석 (Haiku web_search 사전수집 + Sonnet JSON)
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
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
const REPORT_EXAMPLE_PATH = join(dirname(fileURLToPath(import.meta.url)), "report-example.md");

function loadReportExample() {
  try {
    return readFileSync(REPORT_EXAMPLE_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

function sanitizeStr(v) {
  return v == null ? "" : sanitizeUnicode(String(v).trim());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Anthropic Messages API web_search (Haiku, Node.js 직접 호출) */
export async function fetchWebSearch(query, apiKey = process.env.ANTHROPIC_API_KEY, targetYmd = "") {
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
            content: targetYmd
              ? `오늘 날짜는 ${targetYmd}입니다. ${targetYmd} 당일 기준 최신 뉴스만 검색해서 핵심 내용 2-3문장으로 요약해줘. 기사에 나온 구체적 수치(금액·%·포인트, 특히 외국인/기관/개인 순매수·순매도 금액은 조/억원 단위까지)는 절대 빠뜨리지 말고 숫자 그대로 포함해줘. 오늘 날짜와 무관한 오래된 정보는 제외해줘. 검색어: ${query}`
              : `다음을 웹서치해서 핵심 내용만 2-3문장으로 요약해줘. 기사에 나온 구체적 수치(금액·%·포인트)는 빠뜨리지 말고 숫자 그대로 포함해줘: ${query}`,
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

const MCAP_TOP100_FALLBACK = new Set([
  "005930", "000660", "005935", "402340", "207940",
  "005380", "000270", "068270", "035420", "012330",
  "055550", "105560", "316140", "032830", "003550",
  "028260", "066570", "034730", "035720", "086790",
  "009540", "010130", "011170", "003490", "017670",
  "030200", "015760", "034020", "096770", "010950",
  "011200", "000810", "033780", "009150", "018260",
  "051910", "006400", "247540", "373220", "352820",
  "161390", "003670", "000720", "042700", "036570",
  "009830", "011790", "004020", "010140", "005490",
  "000100", "002380", "021240", "008770", "009770",
  "024110", "001040", "047050", "139480", "004170",
  "326030", "180640", "088350", "138040", "007070",
  "000990", "002790", "004990", "097950", "001680",
  "006280", "090430", "271560", "010060", "302440",
  "377300", "012450", "003830", "005940", "029780",
  "000080", "006360", "011780", "001270", "025840",
  "002240", "004800", "016360", "011420", "000120",
  "007310", "001800", "004140", "001450", "006120",
  "023530", "000210", "004370", "002870", "005830",
]);

function isMcapRankLookupEmpty(mcapRankByCode) {
  if (!mcapRankByCode) return true;
  if (mcapRankByCode instanceof Map) return mcapRankByCode.size === 0;
  if (typeof mcapRankByCode === "object") return Object.keys(mcapRankByCode).length === 0;
  return true;
}

function buildMcapTop100Movers(topGainers, topDecliners, mcapRankByCode, limit = 15) {
  const useFallback = isMcapRankLookupEmpty(mcapRankByCode);
  const inTop100 = (s) => {
    const code = sanitizeStr(s?.code);
    if (!code) return false;
    if (useFallback) return MCAP_TOP100_FALLBACK.has(code);
    const rank = mcapRankOf(code, mcapRankByCode);
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

  const macro1 = await fetchWebSearch(`코스피 ${targetYmd} 마감 시황 외국인 수급 FOMC`, apiKey, targetYmd);
  await delay(WEB_SEARCH_DELAY_MS);
  const macro2 = await fetchWebSearch(`${targetYmd} 코스피 코스닥 마감 시황 수급`, apiKey, targetYmd);
  const macroNews = mergeNewsText(macro1, macro2);
  await delay(WEB_SEARCH_DELAY_MS);

  const fomcNews = await fetchWebSearch(`FOMC 금리 결정 ${targetYmd} 한국 증시`, apiKey, targetYmd);
  await delay(WEB_SEARCH_DELAY_MS);

  const foreignFlow1 = await fetchWebSearch(
    `${targetYmd} 코스피 코스닥 외국인 기관 개인 순매수 순매도 금액 조원 억원`,
    apiKey,
    targetYmd
  );
  await delay(WEB_SEARCH_DELAY_MS);
  const foreignFlow2 = await fetchWebSearch(`${targetYmd} 외국인 기관 순매수 순매도`, apiKey, targetYmd);
  const foreignFlowNews = mergeNewsText(foreignFlow1, foreignFlow2);

  const stockNews = {};
  for (const stock of (topGainers || []).slice(0, 10)) {
    await delay(WEB_SEARCH_DELAY_MS);
    const searched = await fetchWebSearch(`${stock.name} 급등 이유 ${targetYmd}`, apiKey, targetYmd);
    stockNews[stock.code] = mergeNewsText(searched, newsFromMap(newsMap, stock.code));
  }

  const { up: mcapUpAll, down: mcapDown } = buildMcapTop100Movers(topGainers, topDecliners, mcapRankByCode);
  // 그룹A 후보: 시총 100위 이내 + 5% 이상 상승 대형주
  const mcapUp = (mcapUpAll || []).filter((s) => (Number(s.change) || 0) >= 5);
  const riseNews = {};
  for (const stock of mcapUp.slice(0, 8)) {
    await delay(WEB_SEARCH_DELAY_MS);
    const searched = await fetchWebSearch(`${stock.name} 급등 이유 ${targetYmd}`, apiKey, targetYmd);
    riseNews[stock.code] = mergeNewsText(searched, newsFromMap(newsMap, stock.code));
  }
  const declineNews = {};
  for (const stock of mcapDown.slice(0, 5)) {
    await delay(WEB_SEARCH_DELAY_MS);
    const searched = await fetchWebSearch(`${stock.name} 급락 이유 ${targetYmd}`, apiKey, targetYmd);
    declineNews[stock.code] = mergeNewsText(searched, newsFromMap(newsMap, stock.code));
  }

  console.log(
    `[daily-market-ai] 웹서치 완료 — 매크로 ${macroNews.length > 0 ? "OK" : "없음"}, 특징주 ${Object.keys(stockNews).length}건, 시총상위상승 ${mcapUp.length}건`
  );

  return { macroNews, fomcNews, foreignFlowNews, stockNews, declineNews, riseNews, mcapUp, mcapDown };
}

function buildSupplyLines(supply) {
  const lines = [];
  for (const row of supply) {
    lines.push(`[${row.market}]`);
    lines.push(`  외국인: ${fmtEok(row.foreign)}`);
    lines.push(`  기관: ${fmtEok(row.institution)}`);
    lines.push(`  개인: ${fmtEok(row.retail ?? row.individual)}`);
  }
  return lines;
}

function supplyHasData(supply) {
  if (!Array.isArray(supply) || !supply.length) return false;
  return supply.some(
    (r) => r.foreign != null || r.institution != null || r.retail != null || r.individual != null
  );
}

function buildSupplySection(supply, searchContext) {
  if (supplyHasData(supply)) {
    return ["=== 수급 현황 (억원, 순매수) ===", ...buildSupplyLines(supply)];
  }
  const macro = [
    sanitizeStr(searchContext?.macroNews),
    sanitizeStr(searchContext?.foreignFlowNews),
    sanitizeStr(searchContext?.fomcNews),
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    "=== 수급 현황 ===",
    "(KIS API 수급 데이터 없음 - 웹서치 뉴스 기반 추정)",
    macro || "(수급 관련 뉴스 없음)",
  ];
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
  const movers = buildMcapTop100Movers(topGainers, topDecliners, mcapRankByCode);
  const mcapDown = ctx.mcapDown || movers.down;
  const mcapUp = ctx.mcapUp || (movers.up || []).filter((s) => (Number(s.change) || 0) >= 5);

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
  if (mcapUp.length) {
    lines.push("");
    lines.push("[시총 100위 내 +5% 이상 상승 대형주 뉴스]");
    const riseNews = ctx.riseNews || {};
    for (const stock of mcapUp.slice(0, 8)) {
      lines.push(`${stock.name} ${fmtPct(stock.change)}: ${riseNews[stock.code] || "(수집된 뉴스 없음)"}`);
    }
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
  lines.push("=== 시총 100위 내 +5% 이상 상승 대형주 (그룹A 특징주 후보) ===");
  if (!mcapUp.length) lines.push("(해당 없음 — +5% 이상 상승한 시총 100위 종목 없음)");
  else {
    mcapUp.slice(0, 10).forEach((s, i) => {
      lines.push(`${i + 1}. ${s.name} ${fmtPct(s.change)} 현재가:${fmtPricePlain(s.currentPrice || s.price)}원`);
    });
  }

  lines.push("");
  lines.push("=== 상승률 TOP30 (그룹B 특징주 후보) ===");
  (topGainers || []).slice(0, 30).forEach((s, i) => {
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
  lines.push(...buildSupplySection(supply, ctx));

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
  "stocks": [
    { "code": "009470", "name": "삼화전기", "theme": "전력·페라이트", "reason": "재료 요약", "change_pct": 30.0 }
  ],
  "watchlist": ["...", "...", "..."],
  "strategy": { "kospi": "", "kosdaq": "", "market_type": "" }
}`);

  lines.push("");
  lines.push(
    "위 제공 데이터(지수/수급/종목/뉴스)만 근거로 JSON을 작성하세요.\n\n[featured_stocks 선정 규칙 — 총 10종목, 그룹A/그룹B 교차 보충 방식]\n- 그룹A 후보 (기본 할당 5종목): '시총 100위 내 +5% 이상 상승 대형주' 목록에서 상승 재료가 뉴스로 명확히 확인되는 종목만 시총 상위 우선으로 선정. 재료가 불명확하면 그 종목은 제외하고 같은 목록의 다른 +5% 종목으로 대체(할루시네이션 절대 금지).\n- 그룹B 후보 (기본 할당 5종목): 코스피·코스닥 전체 상승률 상위 목록('상승률 TOP30')에서 등락률 +20% 이상이면서 상승 재료가 뉴스로 명확히 확인되는 종목만 선정. 재료가 불명확하면 그 종목은 제외하고 다른 +20% 이상 종목으로 대체.\n- 교차 보충: 그룹A 또는 그룹B 중 한쪽이 조건 충족 종목 수가 기본 할당(5개)보다 적으면, 부족한 개수만큼 다른 그룹의 '조건을 충족하는' 후보 풀에서 추가로 채워 총 10종목을 맞춘다. 예) 그룹A 조건충족 종목이 3개뿐이면 그룹A 3개 + 그룹B 조건충족 종목 중 최대 7개(그룹B 풀에 7개 이상 있으면 7개, 모자라면 있는 만큼). 반대 방향(그룹B 부족 → 그룹A 풀에서 보충)도 동일하게 적용.\n- 두 그룹을 합쳐도 조건 충족 종목이 10개 미만이면, 충족하는 종목만 나열하고 억지로 채우지 마세요.\n- 배열 순서는 그룹A 종목 먼저, 그룹B(및 보충분) 다음. 각 종목은 reason(재료)·point(투자포인트)를 반드시 채우고, 뉴스에 재료가 없는 종목은 절대 넣지 마세요.\n\nfeatured_stocks에 포함된 종목은 stocks에도 반드시 포함하고, 상승률 TOP30 전 종목을 stocks에 theme(전력인프라/반도체/바이오/원전/광통신/금융/기타 등)으로 분류하세요."
  );
  return lines.join("\n");
}

function buildSystemPrompt() {
  const base = `[역할]
너는 한국 증시 전문 애널리스트다. 수집된 시장 데이터만을 근거로
기승전결이 있는 마감시황 리포트를 작성한다.

[제목 형식 — 본문(7개 섹션) 시작 전 반드시 포함, 정확히 이 형식]
📊 TOTAL MONEY AI · 마감 리포트
{YYYY}년 {M}월 {D}일 ({요일})

위 두 줄을 쓴 뒤 빈 줄 하나, 그리고 구분선(────────────────) 한 줄을 넣고 그 다음에 아래 7개 섹션을 시작한다. 제목 두 줄과 날짜 형식을 절대 바꾸지 마라(텔레그램 발송 스크립트가 이 줄을 그대로 인식해서 강조 처리한다).

[반드시 지킬 출력 구조] (이 7개 섹션 순서 고정)
1. 핵심 한 줄 — 오늘 장 전체를 한 문장으로 압축
2. 지수 — 코스피/코스닥/원달러 현재가·등락·등락률 (표)
3. 시장 흐름 분석 — 4~5문단의 자연스러운 줄글. 아래 기승전결 흐름을 내부 작성 가이드로만 참고하고, "기/승/전/결" 같은 라벨이나 머리글자는 절대 출력 텍스트에 쓰지 마라 (그냥 이어지는 문단으로 서술):
   · (기) 간밤 해외 이슈가 시초가에 미친 영향
   · (승) 장 초반 어떤 세력/섹터가 주도했는지
   · (전) 반전·디커플링·변곡점
   · (결) 순환매/마무리 흐름
4. 투자자별 매매 동향 — 외국인/기관/개인 × 코스피/코스닥, 마지막에 "핵심:" 한 줄. 금액은 "조" 단위를 섞지 말고 억 단위로 통일해서 표기하고(예: 1조2,710억 → 12,710억), 같은 블록 내 줄들의 금액 끝자리(억)가 시각적으로 맞춰지도록 부호(+/-)와 숫자 자리수를 정렬해서 작성
   ※ 우선순위: ① "[외국인·기관 수급 뉴스]" 등 제공된 뉴스 검색 결과 안에 외국인/기관/개인 순매수·순매도 "금액"(조원/억원 단위)이 나와 있으면 반드시 그 숫자를 그대로 사용해서 작성하라 — KIS API 수급 데이터가 비어 있어도 뉴스에 금액이 있으면 "데이터 없음"이 아니다. 큰 폭의 등락(예: 지수 ±5% 이상)이 있었던 날일수록 언론이 외국인/기관/개인 매매 금액을 구체적으로 보도하는 경우가 많으니 뉴스 본문을 꼼꼼히 확인하라. ② 뉴스에도 금액이 전혀 없을 때만 정성적 묘사(예: "외국인·기관이 동반 매도하며 차익실현을 주도했다")로 대체하라. ③ 정성적 묘사조차 근거가 없을 때만 4번 섹션을 생략한다. 이 세 단계 중 어느 경우든 "정확한 수급 데이터 미확인", "공식 데이터 집계 전이라 반영하지 않음" 같은 내부 작성 사정을 설명하는 문장은 절대 쓰지 마라(고객에게 노출되면 안 되는 내부 변명이다).
5. 오늘의 특징주 — 총 10종목, 그룹A/그룹B 교차 보충 방식 (그룹A: 시총 100위 내 +5% 이상 상승 대형주 기본 5개, 시총 상위·재료 확실 우선 / 그룹B: 코스피·코스닥 전체 상승률 +20% 이상·재료 확실 기본 5개). 한쪽 그룹의 조건 충족 종목이 5개보다 적으면 부족분만큼 다른 그룹의 조건 충족 풀에서 추가로 채워 총 10개를 맞춘다(예: 그룹A 3개면 그룹A 3개 + 그룹B 7개). 두 그룹 합산도 10개 미만이면 충족하는 만큼만 넣는다. 각 종목마다 반드시 두 줄 세트:
   · 재료: 왜 움직였는지 (재료/수급)
   · 포인트: 주의사항 또는 향후 전망
   ※ 소형 테마주를 지수 흐름의 원인으로 쓰지 말 것. 재료가 확인되지 않은 종목은 제외.
   ※※ 재료 할루시네이션 절대 금지: 입력 데이터(뉴스 제목)에 등장하지 않는 업종/테마/정책을 재료로 지어내지 마라. 종목명만 보고 업종을 추측하거나(예: 회사명에서 연상되는 산업을 임의로 단정) 그 종목과 무관한 다른 종목의 테마(예: 같은 날 급등한 다른 테마주의 재료)를 가져다 붙이는 것도 금지. 입력 뉴스 제목 안에서 해당 종목명과 명확히 연결되는 재료를 찾을 수 없으면, 그 종목은 그룹A/B 후보에서 제외하고 재료가 확인되는 다른 종목으로 교체하라. 대체할 종목도 없으면 5번 섹션 종목 수를 줄여서 출력한다 (빈 재료나 추정 재료로 채우지 말 것).
6. 향후 전략 및 총평 — 코스피/코스닥 각각 전략 (이 섹션에는 "내일 주목할 변수"를 포함하지 말 것)
7. 내일 주목할 변수 — 별도의 독립 섹션으로 구성. 향후 전략 섹션과 구분선으로 분리하고, 3가지 변수를 번호(1, 2, 3)와 함께 제시

[톤 규칙]
- 차분하고 전문적인 애널리스트 톤. 핵심을 명료하고 군더더기 없이 서술
- 모든 수치는 반드시 [숫자 + 왜 + 의미] 세트로
- 추측성 단정 금지

[표기 규칙]
- 각 섹션 제목 앞에는 어울리는 이모지를 하나씩 붙여 가독성을 높인다 (예: 📊 📌 📈 🔄 💰 🎯). 단, 본문 문장 안에서는 이모지를 과하게 남발하지 말고 핵심 줄(소제목/요약줄)에만 절제해서 사용
- ■▶◆ 같은 기호는 사용하지 말 것 (이모지로 대체)
- 화려한 수식어보다 사실·수치 중심으로 작성

[절대 규칙 — 할루시네이션 금지]
- 입력 데이터에 없는 수치/종목은 절대 지어내지 마라
- 데이터가 부족하면 그 섹션은 짧게 쓰되, 거짓 숫자는 넣지 마라
- 데이터 부족을 이유로 "데이터 미확인", "집계 전", "이번 리포트에 반영하지 않음" 같은 내부 작성 사정을 설명하는 문장을 본문에 절대 쓰지 마라(고객 노출 절대 금지, 그룹A/B 같은 내부 용어 노출 금지 규칙과 동일한 원칙). 데이터가 없으면 그 내용을 조용히 생략하거나 정성적 서술로만 대체하라
- 특징주 "재료"는 반드시 입력 뉴스 제목에서 해당 종목명과 직접 연결되는 내용만 사용. 종목명에서 연상되는 업종을 짐작해서 쓰거나, 다른 종목의 테마를 가져다 붙이는 것은 할루시네이션이다. 확인 안 되면 그 종목을 빼라
- 상승=빨강(#e24b4a), 하락=파랑(#3b82f6), 초록 절대 금지 (HTML 출력 시)

[JSON 출력 절대 규칙]
- 최종 출력은 반드시 { 로 시작하고 } 로 끝나는 순수 JSON만
- JSON 앞뒤 어떤 텍스트도 절대 금지
- 마크다운 코드블록 절대 금지
- 분석 과정 설명 텍스트 절대 금지`;

  const example = loadReportExample();
  if (!example) return base;
  return `${base}\n\n[이런 수준과 구조로 작성하라는 예시]:\n${example}`;
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

function normalizeStockThemeRow(s) {
  if (!s || typeof s !== "object") return null;
  const code = sanitizeStr(s.code);
  const name = sanitizeStr(s.name);
  if (!code && !name) return null;
  const changeRaw = s.change_pct ?? s.change ?? s.changePct;
  const changeNum = Number(changeRaw);
  return {
    code,
    name,
    theme: sanitizeStr(s.theme) || "기타",
    reason: sanitizeStr(s.reason || s.entryReason),
    change_pct: Number.isFinite(changeNum) ? changeNum : null,
  };
}

function normalizeStocksList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeStockThemeRow).filter(Boolean);
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

  const stocks = normalizeStocksList(parsed.stocks);
  if (stocksForThemes?.length && !stocks.length) {
    console.warn(`Claude stocks missing (expected ~${stocksForThemes.length} theme rows)`);
  } else if (stocksForThemes?.length && stocks.length !== stocksForThemes.length) {
    console.warn(`Claude stocks length ${stocks.length} != ${stocksForThemes.length}`);
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
