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

  const fallback = () => ({
    headline: extractHeadlineFallback(analysisText),
    aiComment: extractHeadlineFallback(analysisText),
    checkpoints: extractOutlookFallback(analysisText),
    stockReasons: Object.fromEntries(gainers.map((g) => [g.name, g.reason || g.theme || "상승률 상위"])),
  });

  if (!apiKey || !analysisText) return fallback();

  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system:
        "TotalMoney AI 카드뉴스/트윗 문구 작성자. 브랜드 보이스: 전문적이지만 쉽게, 결론이 명확하게, 과장 없이. " +
        "반드시 JSON만 출력 (마크다운 코드블록 금지).",
      messages: [
        {
          role: "user",
          content: ensureJsonSafe(`아래는 오늘 장마감 리포트 원문이야. 이걸 압축해서 SNS 카드뉴스/트윗용 짧은 문구로 만들어줘.

[리포트 원문]
${analysisText.slice(0, 6000)}

[오늘의 특징주 TOP3]
${gainers.map((g) => `${g.name} ${g.change > 0 ? "+" : ""}${g.change}%`).join(", ")}

다음 JSON 스키마로만 응답:
{
  "headline": "커버 슬라이드용 한 줄 헤드라인 (20자 내외)",
  "aiComment": "AI 오늘의 판단 코멘트 (60~90자, 근거+주의사항 포함)",
  "checkpoints": ["내일 주목할 변수 1", "변수 2", "변수 3"],
  "stockReasons": { "종목명": "상승/하락 이유 한 줄(15자 내외)" }
}`),
        },
      ],
    });
    const text = res.content?.find((b) => b.type === "text")?.text || "";
    return parseJsonFromAssistant(text);
  } catch (error) {
    console.warn(
      `[promo-market-copy] Claude 실패(${isClaudeUnavailableError(error) ? "billing/unavailable" : "error"}), 원문에서 직접 추출:`,
      error instanceof Error ? error.message : error
    );
    return fallback();
  }
}
