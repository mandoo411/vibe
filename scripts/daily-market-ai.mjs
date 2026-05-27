/**
 * 장마감 리포트 Claude 분석 (구조화 JSON)
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  buildFallbackDailyClosingReport,
  ensureJsonSafe,
  isClaudeUnavailableError,
  sanitizeUnicode,
} from "./claude-utils.mjs";

function sanitizeStr(v) {
  return v == null ? "" : sanitizeUnicode(String(v).trim());
}

function parseJsonFromAssistant(text) {
  let claudeRawText = String(text || "").trim();

  // 코드블록 제거
  if (typeof claudeRawText === "string") {
    claudeRawText = claudeRawText
      .replace(/^```json\s*/im, "")
      .replace(/^```\s*/im, "")
      .replace(/```\s*$/im, "")
      .trim();
  }

  return JSON.parse(claudeRawText);
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

const SYSTEM_PROMPT = `당신은 전문 주식 애널리스트입니다.
데이터를 바탕으로 정확하고 통찰력 있게 분석하되
일반 투자자도 이해하기 쉽게 설명해주세요.
텔레그램 채널 메시지와 뉴스를 근거로 활용하세요.

You must respond with ONLY valid JSON. No markdown, no code blocks, no explanation. Just raw JSON starting with { and ending with }

출력은 아래 JSON 객체 하나만 (마크다운·코드펜스 금지):

{
  "headlineIssue": "핵심 이슈 한 줄",
  "supplyComment": "수급 해석 2~3문장",
  "issueStocks": [
    { "name": "종목명", "change": 14.41, "entryReason": "진입 이유", "background": "배경 설명" }
  ],
  "sectorFlow": {
    "strong": [{ "name": "섹터명", "changePct": 10.5, "reason": "이유" }],
    "weak": [{ "name": "섹터명", "changePct": -3.2, "reason": "이유" }],
    "summary": "오늘 시장 특징 한 줄"
  },
  "tomorrowCheckpoints": ["포인트1", "포인트2", "포인트3"],
  "oneLineVerdict": "오늘 시장 한 줄 평가",
  "marketSummary": "시황 요약 3~5문장",
  "notableStocks": [{ "name": "종목", "code": "005930", "change": null, "tradingValue": "", "note": "한 줄" }],
  "stocks": [{ "code": "005930", "reason": "상승 이유", "theme": "테마" }],
  "topNews": [{ "title": "뉴스", "note": "", "source": "", "url": "" }],
  "marketExtraComments": {}
}

규칙:
- issueStocks는 급등·급락 이슈 종목 5개 내외
- sectorFlow strong/weak 각 3개 내외, changePct는 숫자
- tomorrowCheckpoints 정확히 3개
- stocks 배열 길이는 입력 상승률 TOP 종목 수와 동일, 순서 유지
- 추측·투자권유 금지`;

export async function analyzeDailyClosingReport({
  apiKey,
  model,
  targetYmd,
  indexes,
  supply,
  sectors,
  topGainers,
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
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: user }],
    });

    let rawText = response?.content?.find((b) => b.type === "text")?.text ?? "";
    // 코드블록 및 불필요한 텍스트 제거
    rawText = rawText
      .replace(/^[\s\S]*?({)/m, "$1") // { 이전 모든 텍스트 제거
      .replace(/}[\s\S]*$/m, (m) => m.split("}")[0] + "}") // 마지막 } 이후 제거
      .trim();
    parsed = JSON.parse(rawText);
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
    issueStocks: Array.isArray(parsed.issueStocks) ? parsed.issueStocks : [],
    sectorFlow: parsed.sectorFlow && typeof parsed.sectorFlow === "object" ? parsed.sectorFlow : {},
    tomorrowCheckpoints: Array.isArray(parsed.tomorrowCheckpoints) ? parsed.tomorrowCheckpoints.slice(0, 3) : [],
    oneLineVerdict: sanitizeStr(parsed.oneLineVerdict),
    marketSummary: sanitizeStr(parsed.marketSummary),
    notableStocks: Array.isArray(parsed.notableStocks) ? parsed.notableStocks : [],
    stocks,
    topNews: Array.isArray(parsed.topNews) ? parsed.topNews : [],
    marketExtraComments:
      parsed.marketExtraComments && typeof parsed.marketExtraComments === "object"
        ? parsed.marketExtraComments
        : {},
  };
}
