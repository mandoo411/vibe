/**
 * 인스타/X 홍보 콘텐츠용 카피 생성
 * data/daily-market.json (기존 sync 워크플로우가 채워둔 데이터)을 읽어서
 * 카드뉴스·트윗에 필요한 짧은 문구(headline, aiComment, checkpoints, stockReasons)를 만든다.
 *
 * 설계 원칙: KIS API를 새로 호출하지 않는다 — 이미 kis-daily-top30.mjs / daily-market-ai.mjs가
 * 채워둔 data/daily-market.json 을 그대로 재사용한다 (중복 API 호출·토큰 관리 방지).
 * Claude 호출도 이미 만들어진 analysis 원문을 압축하는 용도로만 가볍게 1회 사용한다(Haiku).
 */
import { readJson, seoulYmd } from "./telegram-utils.mjs";
import { ensureJsonSafe, isClaudeUnavailableError, parseJsonFromAssistant, sanitizeUnicode } from "./claude-utils.mjs";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_SEARCH_MODEL || "claude-haiku-4-5-20251001";
const DATA_PATH = "./data/daily-market.json";

/** analysis 원문(마크다운 텍스트)에서 "핵심 한 줄" 섹션만 뽑아내는 폴백 파서 */
function extractHeadlineFallback(analysisText) {
  const m = String(analysisText || "").match(/핵심 한 줄\s*\n([\s\S]*?)(?:\n\n|📈)/);
  const line = m ? m[1].trim() : "";
  return line.length > 60 ? line.slice(0, 58) + "…" : line || "오늘의 시장 요약";
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

/** "시장 흐름 분석" 섹션에서 AI 코멘트용 문단을 뽑는 폴백(헤드라인과 겹치지 않도록 별도 소스 사용) */
function extractFlowCommentFallback(analysisText) {
  const m = String(analysisText || "").match(/(?:🔄\s*)?시장 흐름 분석\s*\n([\s\S]*?)(?:\n\n|$)/);
  const para = m ? m[1].trim() : "";
  if (!para) return "";
  const sentence = para.split(/(?<=[.다다요])\s+/)[0] || para;
  return sentence.length > 90 ? sentence.slice(0, 88) + "…" : sentence;
}

/** data/daily-market.json에서 오늘(없으면 가장 최근) 스냅샷을 읽는다 */
export async function loadLatestSnapshot() {
  const raw = await readJson(DATA_PATH);
  const days = raw.days || {};
  const today = seoulYmd();
  const key = days[today] ? today : Object.keys(days).sort().pop();
  if (!key) throw new Error("data/daily-market.json에 사용 가능한 날짜 데이터가 없습니다");
  return { ymd: key, ...days[key] };
}

/**
 * 카드뉴스/트윗 공용 카피 생성.
 * Claude 실패 시 analysis 원문에서 직접 뽑은 문구로 자동 폴백 (기존 daily-market-ai.mjs 방식과 동일한 철학).
 */
export async function buildPromoCopy(snapshot) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const analysisText = sanitizeUnicode(snapshot.analysis || "");
  const gainers = (snapshot.topGainers || []).slice(0, 3);

  const fallback = () => {
    const headline = extractHeadlineFallback(analysisText);
    const flowComment = extractFlowCommentFallback(analysisText);
    return {
      headline,
      aiComment: flowComment || headline,
      checkpoints: extractOutlookFallback(analysisText),
      stockReasons: Object.fromEntries(gainers.map((g) => [g.name, g.reason || g.theme || "상승률 상위"])),
    };
  };

  if (!apiKey || !analysisText) return fallback();

  const client = new Anthropic({ apiKey });
  const userPrompt = ensureJsonSafe(`아래는 오늘 장마감 리포트 원문이야. 이걸 압축해서 SNS 카드뉴스/트윗용 짧은 문구로 만들어줘.

[리포트 원문]
${analysisText.slice(0, 6000)}

[오늘의 특징주 TOP3]
${gainers.map((g) => `${g.name} ${g.change > 0 ? "+" : ""}${g.change}%`).join(", ")}

다음 JSON 스키마로만 응답:
{
  "headline": "커버 슬라이드용 한 줄 헤드라인 (20자 내외)",
  "aiComment": "AI 오늘의 판단 코멘트 (60~90자, 근거+주의사항 포함, headline과 다른 내용/문장으로)",
  "checkpoints": ["내일 주목할 변수 1", "변수 2", "변수 3"],
  "stockReasons": { "종목명": "상승/하락 이유 한 줄(15자 내외)" }
}`);

  const MAX_ATTEMPTS = 3;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 600,
        system:
          "TotalMoney AI 카드뉴스/트윗 문구 작성자. 브랜드 보이스: 전문적이지만 쉽게, 결론이 명확하게, 과장 없이. " +
          "반드시 JSON만 출력 (마크다운 코드블록 금지).",
        messages: [{ role: "user", content: userPrompt }],
      });
      const text = res.content?.find((b) => b.type === "text")?.text || "";
      const parsed = parseJsonFromAssistant(text);
      // headline과 aiComment가 우연히 같으면 폴백 코멘트로 대체(카드가 중복되어 보이는 것 방지)
      if (parsed.aiComment && parsed.headline && parsed.aiComment === parsed.headline) {
        parsed.aiComment = extractFlowCommentFallback(analysisText) || parsed.aiComment;
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
  console.warn("[promo-market-copy] Claude 전체 실패, 원문에서 직접 추출:", lastError instanceof Error ? lastError.message : lastError);
  return fallback();
}
