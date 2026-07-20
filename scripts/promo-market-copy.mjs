/**
 * 인스타/X 홍보 콘텐츠용 카피 생성
 * data/daily-market.json (기존 sync 워크플로우가 채워둔 데이터)을 읽어서
 * 카드뉴스·트윗에 필요한 짧은 문구(headline, summaryLines, aiComment, checkpoints, stockReasons)를 만든다.
 *
 * 설계 원칙: KIS API를 새로 호출하지 않는다 — 이미 kis-daily-top30.mjs / daily-market-ai.mjs가
 * 채워둔 data/daily-market.json 을 그대로 재사용한다 (중복 API 호출·토큰 관리 방지).
 * Claude 호출도 이미 만들어진 analysis 원문을 압축하는 용도로만 가볍게 1회 사용한다(Haiku).
 */
import { readJson, seoulYmd } from "./telegram-utils.mjs";
import { summarizeToSentence, trimToNaturalBreak } from "./promo-text-utils.mjs";
import { ensureJsonSafe, isClaudeUnavailableError, parseJsonFromAssistant, sanitizeUnicode } from "./claude-utils.mjs";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_SEARCH_MODEL || "claude-haiku-4-5-20251001";
const DATA_PATH = "./data/daily-market.json";

function extractHeadlineFallback(analysisText) {
  const m = String(analysisText || "").match(/핵심 한 줄\s*\n([\s\S]*?)(?:\n\n|📈)/);
  const para = m ? m[1].trim() : "";
  return para ? summarizeToSentence(para, 110) : "";
}

function extractOutlookFallback(analysisText) {
  const m = String(analysisText || "").match(/내일 주목할 변수\s*\n([\s\S]*)$/);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((s) => s.replace(/^-\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

function extractFlowCommentFallback(analysisText) {
  const m = String(analysisText || "").match(/(?:🔄\s*)?시장 흐름 분석\s*\n([\s\S]*?)(?:\n\n|$)/);
  const para = m ? m[1].trim() : "";
  return para ? summarizeToSentence(para, 110) : "";
}

function buildIndexHeadline(snapshot) {
  const { kospi, kosdaq } = snapshot.indexes || {};
  if (!kospi?.close || !Number.isFinite(kospi.changePercent)) return "";
  const dirWord = (pct) => (pct > 0 ? "올라" : pct < 0 ? "내려" : "보합으로");
  let s = `코스피는 ${Math.abs(kospi.changePercent).toFixed(2)}% ${dirWord(kospi.changePercent)} ${kospi.close.toLocaleString()}에`;
  if (kosdaq?.close && Number.isFinite(kosdaq.changePercent)) {
    s += `, 코스닥은 ${Math.abs(kosdaq.changePercent).toFixed(2)}% ${dirWord(kosdaq.changePercent)} ${kosdaq.close.toLocaleString()}에`;
  }
  return `${s} 마감했다.`;
}

function buildFallbackSummaryLines(snapshot, analysisText) {
  const { kospi, kosdaq, usdkrw } = snapshot.indexes || {};
  const dirWord = (pct) => (pct > 0 ? "상승" : pct < 0 ? "하락" : "보합");
  const lines = [];
  if (kospi?.close && Number.isFinite(kospi.changePercent)) {
    lines.push(`코스피 ${kospi.close.toLocaleString()}, ${Math.abs(kospi.changePercent).toFixed(2)}% ${dirWord(kospi.changePercent)} 마감`);
  }
  if (kosdaq?.close && Number.isFinite(kosdaq.changePercent)) {
    lines.push(`코스닥 ${kosdaq.close.toLocaleString()}, ${Math.abs(kosdaq.changePercent).toFixed(2)}% ${dirWord(kosdaq.changePercent)} 마감`);
  }
  if (usdkrw?.rate) {
    lines.push(`원/달러 환율 ${Math.round(usdkrw.rate).toLocaleString()}원 기록`);
  }
  const flow = extractFlowCommentFallback(analysisText);
  if (flow) lines.push(flow);
  const outlook = extractOutlookFallback(analysisText)[0];
  if (outlook) lines.push(trimToNaturalBreak(outlook, 32));
  return lines.slice(0, 5);
}

export async function loadLatestSnapshot() {
  const raw = await readJson(DATA_PATH);
  const days = raw.days || {};
  const today = process.env.PROMO_FORCE_DATE || seoulYmd();
  const key = days[today] ? today : Object.keys(days).sort().pop();
  if (!key) throw new Error("data/daily-market.json에 사용 가능한 날짜 데이터가 없습니다");
  return { ymd: key, ...days[key] };
}

export async function buildPromoCopy(snapshot) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const analysisText = sanitizeUnicode(snapshot.analysis || "");
  const gainers = (snapshot.topGainers || []).slice(0, 5);
  const { kospi, kosdaq, usdkrw } = snapshot.indexes || {};

  const fallback = () => {
    // 커버 슬라이드(headline)는 화면에 이미 크게 표시되는 지수 등락률 숫자를 반복하지 않고,
    // "왜" 그렇게 움직였는지 원인을 담는다 (사용자 피드백 반영: 숫자 재언급 금지, 원인 코멘트 필수).
    // 지수 결과 숫자 요약은 AI 판단 슬라이드(aiComment) 쪽에 배치한다.
    const flowComment = extractFlowCommentFallback(analysisText);
    const resultLine = extractHeadlineFallback(analysisText);
    const headline = flowComment || resultLine || buildIndexHeadline(snapshot) || "오늘의 시장 요약";
    return {
      headline,
      summaryLines: buildFallbackSummaryLines(snapshot, analysisText),
      aiComment: resultLine || flowComment || "",
      checkpoints: extractOutlookFallback(analysisText),
      stockReasons: Object.fromEntries(gainers.map((g) => [g.name, g.reason || g.theme || "상승률 상위"])),
    };
  };

  if (!apiKey || !analysisText) return fallback();

  const client = new Anthropic({ apiKey });
  const indexFacts = [
    kospi?.close && Number.isFinite(kospi.changePercent) ? `코스피 ${kospi.close.toLocaleString()} (${kospi.changePercent > 0 ? "+" : ""}${kospi.changePercent}%)` : null,
    kosdaq?.close && Number.isFinite(kosdaq.changePercent) ? `코스닥 ${kosdaq.close.toLocaleString()} (${kosdaq.changePercent > 0 ? "+" : ""}${kosdaq.changePercent}%)` : null,
    usdkrw?.rate ? `원/달러 ${Math.round(usdkrw.rate).toLocaleString()}원` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const userPrompt = ensureJsonSafe(`아래는 오늘 장마감 리포트 원문이야. 이걸로 SNS 카드뉴스용 문구를 만들어줘.
반드시 아래 [리포트 원문]과 [오늘 지수 마감]에 있는 사실만 사용하고, 원문에 없는 수치·사건·이유는 절대 지어내지 마(할루시네이션 금지). 근거가 부족하면 과장하지 말고 일반적인 표현을 써.

[오늘 지수 마감]
${indexFacts || "데이터 없음"}

[리포트 원문]
${analysisText.slice(0, 6000)}

[오늘의 특징주 TOP3]
${gainers.map((g) => `${g.name} ${g.change > 0 ? "+" : ""}${g.change}%`).join(", ")}

다음 JSON 스키마로만 응답:
{
  "headline": "커버 슬라이드용 한 줄 총평 (35~55자). 화면에 이미 표시되는 지수 등락률 숫자를 그대로 반복하지 말고, 오늘 시장이 왜 그렇게 움직였는지 핵심 원인과 의미를 임팩트 있게 설명. 완결된 문장으로 끝낼 것.",
  "summaryLines": ["오늘 시황을 완결된 문장 5개로 요약(각 20~32자). 지수 흐름/주도 업종/수급 주체/환율·원자재/향후 변수 등 서로 다른 포인트를 다뤄서 정보 밀도를 높일 것. 원문에 없는 내용 금지."],
  "aiComment": "AI 오늘의 판단 (70~100자). 오늘 시황에서 가장 중요한 포인트 1~2개를 근거와 함께 설명하고 투자 유의사항을 짧게 포함. headline과 다른 문장/내용으로 쓸 것.",
  "checkpoints": ["내일 주목할 변수 1", "변수 2", "변수 3"],
  "stockReasons": { "종목명": "상승/하락 이유를 완결된 명사구로 12~16자 내외 (중간에 끊기지 않게 짧게)" }
}
summaryLines는 정확히 5개를 배열로 반환해.`);

  const MAX_ATTEMPTS = 3;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 900,
        system:
          "TotalMoney AI 카드뉴스/트윗 문구 작성자. 브랜드 보이스: 전문적이지만 쉽게, 결론이 명확하게, 과장 없이. " +
          "제공된 리포트 원문과 지수 수치에 없는 사실을 지어내지 마라(할루시네이션 금지) — 모르면 일반적인 표현을 써라. " +
          "반드시 JSON만 출력 (마크다운 코드블록 금지).",
        messages: [{ role: "user", content: userPrompt }],
      });
      const text = res.content?.find((b) => b.type === "text")?.text || "";
      const parsed = parseJsonFromAssistant(text);
      if (parsed.aiComment && parsed.headline && parsed.aiComment === parsed.headline) {
        parsed.aiComment = extractFlowCommentFallback(analysisText) || parsed.aiComment;
      }
      if (!Array.isArray(parsed.summaryLines) || parsed.summaryLines.length === 0) {
        parsed.summaryLines = buildFallbackSummaryLines(snapshot, analysisText);
      }
      return parsed;
    } catch (error) {
      lastError = error;
      const retryable = isClaudeUnavailableError(error) || /connection error/i.test(String(error?.message || ""));
      console.warn(
        `[promo-market-copy] Claude 시도 ${attempt}/${MAX_ATTEMPTS} 실패(${retryable ? "재시도 가능" : "치명적"}):`,
        error instanceof Error ? error.message : error
      );
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  console.warn("[promo-market-copy] Claude 전체 실패, 원문/실측 지수에서 직접 추출:", lastError instanceof Error ? lastError.message : lastError);
  return fallback();
}

export function buildClosingCardData({ snapshot, copy, gainers, dateLabel, theme = "light" }) {
  const { kospi, kosdaq, usdkrw } = snapshot.indexes || {};
  const indexRows = [
    kospi && { name: "코스피", value: kospi.close?.toLocaleString?.() ?? String(kospi.close ?? "—"), pct: kospi.changePercent },
    kosdaq && { name: "코스닥", value: kosdaq.close?.toLocaleString?.() ?? String(kosdaq.close ?? "—"), pct: kosdaq.changePercent },
    usdkrw?.rate && { name: "원/달러", value: `${Math.round(usdkrw.rate).toLocaleString()}원`, pct: 0 },
  ].filter(Boolean);

  return {
    date: dateLabel,
    slotLabel: "마감 시황",
    coverTitleLine1: "AI가 읽은",
    coverTitleLine2: "오늘의 시장",
    heroLabel: "코스피",
    heroPct: kospi?.changePercent || 0,
    headline: copy.headline,
    indexTitle: "오늘의 시황 요약",
    indexRows,
    summaryLines: copy.summaryLines || [],
    listTitle: "오늘의 특징주 TOP5",
    listItems: gainers.map((g) => ({ name: g.name, reason: g.reason, pct: g.change, market: g.market, type: g.type })),
    aiTitle: "AI 오늘의 판단",
    aiComment: copy.aiComment,
    checkpointsTitle: "내일 주목할 변수",
    checkpoints: copy.checkpoints || [],
    theme,
  };
}
