/**
 * 장마감 리포트 Claude 분석 (구조화 JSON)
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  buildFallbackDailyClosingReport,
  ensureJsonSafe,
  isClaudeUnavailableError,
  parseJsonFromAssistant,
  sanitizeUnicode,
} from "./claude-utils.mjs";

function sanitizeStr(v) {
  return v == null ? "" : sanitizeUnicode(String(v).trim());
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

function buildUserPrompt({
  targetYmd,
  indexes,
  supply,
  sectors,
  topGainers,
  topDecliners,
  volumeLeaders,
  telegramMessages,
  pressNews,
}) {
  const lines = [];
  lines.push(`오늘 장마감 데이터 (${targetYmd} KST):`);
  lines.push("");
  lines.push("=== 지수 ===");
  for (const idx of indexes || []) {
    const tv = idx.tradingValue ? ` 거래대금 ${idx.tradingValue}` : "";
    lines.push(`${idx.name}: ${idx.value || "—"} ${fmtPct(idx.change)}${tv}`);
  }
  lines.push("");
  lines.push("=== 수급 (억원, 순매수) ===");
  for (const row of supply || []) {
    lines.push(
      `${row.market}: 외국인 ${fmtEok(row.foreign)}, 기관 ${fmtEok(row.institution)}, 개인 ${fmtEok(row.retail)}`
    );
  }
  lines.push("");
  lines.push("=== 업종별 등락률 ===");
  for (const s of (sectors || []).slice(0, 25)) {
    lines.push(`${s.name}: ${fmtPct(s.changePct)}`);
  }
  lines.push("");
  lines.push("=== 상승률 TOP10 ===");
  for (const s of (topGainers || []).slice(0, 10)) {
    lines.push(`${s.name} ${fmtPct(s.change)} ${s.currentPrice || ""}원`);
  }
  lines.push("");
  lines.push("=== 하락률 TOP10 ===");
  for (const s of (topDecliners || []).slice(0, 10)) {
    lines.push(`${s.name} ${fmtPct(s.change)} ${s.currentPrice || ""}원`);
  }
  lines.push("");
  lines.push("=== 거래량 상위 ===");
  for (const s of (volumeLeaders || []).slice(0, 10)) {
    lines.push(`${s.name} ${fmtPct(s.change)} 거래량 ${s.volume || "—"} [${s.sector || "기타"}]`);
  }
  lines.push("");
  lines.push("=== 텔레그램 채널 메시지 ===");
  if (!telegramMessages?.length) lines.push("(없음)");
  else {
    for (const msg of telegramMessages.slice(0, 35)) {
      lines.push(`- [${msg.channel}] ${sanitizeStr(msg.text).slice(0, 200)}`);
    }
  }
  lines.push("");
  lines.push("=== 오늘 언론사 뉴스 ===");
  if (!pressNews?.length) lines.push("(없음)");
  else {
    for (const n of pressNews.slice(0, 20)) {
      lines.push(`- [${n.source}] ${n.title}`);
    }
  }
  lines.push("");
  lines.push(`위 데이터를 바탕으로 JSON만 출력하세요.`);
  return lines.join("\n");
}

const WEB_SEARCH_TOOLS = [
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 10,
  },
];

const SYSTEM_PROMPT = `당신은 TotalMoney AI의 한국 주식시장 수석 애널리스트입니다.
매일 장 마감 후 시황 분석 리포트를 작성합니다.

[특징주 선정 규칙]
1. 반드시 web_search로 각 급등/급락 종목의 당일 뉴스/공시를 검색해서 정확한 재료 확인
2. 재료 확인 없이 섹터 동반, 테마 수혜 같은 추측성 재료 절대 금지
3. 재료 확인 불가 시 해당 종목 제외
4. 선정 기준:
   - 전 종목 +20% 이상 급등 (재료 확인된 것만, 최대 10개)
   - 시총 100위 이내 +10% 이상 급등
   - 시총 100위 이내 -5% 이하 급락 (최소 3개)
5. 각 종목 필드:
   - reason: 구체적 뉴스/공시 내용 (예: 윌테크놀러지 지분 83% 인수 공시)
   - point: 투자 포인트 1줄 (예: 거래대금 890억 폭증, 수혜 지속 여부 확인 필요)

[종합분석 규칙]
- 핵심 한 줄 요약 (굵게 표시용 ** 마크다운)
- 시장 흐름 3~4문장 (수급/매크로/섹터 포함)
- 외국인/기관/개인 수급 방향 반드시 언급
- 내일 주목할 변수 3개 (watchlist 배열)

[출력 규칙]
- 반드시 순수 JSON만 출력
- 마크다운 코드블록 없이
- 추측이나 일반론 금지, 데이터 기반으로만 작성`;

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
}) {
  const user = ensureJsonSafe(
    buildUserPrompt({
      targetYmd,
      indexes,
      supply,
      sectors,
      topGainers,
      topDecliners,
      volumeLeaders,
      telegramMessages,
      pressNews,
    })
  );

  let parsed;
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: 12000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: user }],
      tools: WEB_SEARCH_TOOLS,
    });

    const rawText = response?.content?.find((b) => b.type === "text")?.text ?? "";
    parsed = parseJsonFromAssistant(rawText);
    if (!parsed || typeof parsed !== "object") throw new Error("Claude output invalid");
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

  const stocks = Array.isArray(parsed.stocks) ? parsed.stocks : [];
  if (stocksForThemes?.length && stocks.length !== stocksForThemes.length) {
    console.warn(`Claude stocks length ${stocks.length} != ${stocksForThemes.length}, padding`);
  }

  return {
    headlineIssue: sanitizeStr(parsed.headlineIssue),
    supplyComment: sanitizeStr(parsed.supplyComment),
    analysis: sanitizeStr(parsed.analysis || parsed.marketSummary),
    issueStocks: Array.isArray(parsed.issueStocks)
      ? parsed.issueStocks.map((s) => ({
          ...s,
          entryReason: sanitizeStr(s.entryReason || s.reason),
          background: sanitizeStr(s.background || s.point),
          reason: sanitizeStr(s.reason || s.entryReason),
          point: sanitizeStr(s.point || s.background),
          type: sanitizeStr(s.type) || (Number(s.change) < 0 ? "급락" : "급등"),
        }))
      : Array.isArray(parsed.featured_stocks)
        ? parsed.featured_stocks
        : [],
    featured_stocks: Array.isArray(parsed.featured_stocks) ? parsed.featured_stocks : [],
    sectorFlow: parsed.sectorFlow && typeof parsed.sectorFlow === "object" ? parsed.sectorFlow : {},
    tomorrowCheckpoints: Array.isArray(parsed.tomorrowCheckpoints) ? parsed.tomorrowCheckpoints.slice(0, 3) : [],
    watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist.slice(0, 3) : [],
    oneLineVerdict: sanitizeStr(parsed.oneLineVerdict),
    marketSummary: sanitizeStr(parsed.marketSummary || parsed.analysis),
    notableStocks: Array.isArray(parsed.notableStocks) ? parsed.notableStocks : [],
    stocks,
    topNews: Array.isArray(parsed.topNews) ? parsed.topNews : [],
    marketExtraComments:
      parsed.marketExtraComments && typeof parsed.marketExtraComments === "object"
        ? parsed.marketExtraComments
        : {},
  };
}
