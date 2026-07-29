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
import { trimToNaturalBreak, firstCompleteSentence } from "./promo-text-utils.mjs";
import { ensureJsonSafe, isClaudeUnavailableError, parseJsonFromAssistant, sanitizeUnicode } from "./claude-utils.mjs";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_SEARCH_MODEL || "claude-haiku-4-5-20251001";
const DATA_PATH = "./data/daily-market.json";

// 카드 상단에 이미 코스피/코스닥 지수 포인트·퍼센트·마감가가 크게 표시되므로, 한줄 논평에서
// 그 수치를 또 반복하면 정보가 겹친다(사용자 피드백: "코스피 오르고 내리고 이런 내용 쓰지 말고
// 지수 수치 이런거 쓰지 말고"). "숫자+포인트/%/원에 마감" 패턴이 들어간 절(clause)을 걸러낸다.
function hasIndexFigures(text) {
  return /\d[\d,]*(\.\d+)?\s*(포인트|p\)|%|원에\s*마감|에\s*마감)/.test(String(text || ""));
}

function extractHeadlineFallback(analysisText) {
  const m = String(analysisText || "").match(/핵심 한 줄\s*\n([\s\S]*?)(?:\n\n|📈)/);
  const para = m ? m[1].trim() : "";
  if (!para) return "";
  // "핵심 한 줄" 문단은 보통 [코스피 수치] [코스닥 수치] [그날 장중에 실제로 있었던 일(사이드카/
  // 서킷브레이커 등) 요약] 순서로 이어진다. 문장(.) 단위가 아니라 절(., 쉼표) 단위로 잘게 쪼개서
  // 지수 수치가 없는 절 — 즉 "오늘 장중 있었던 일" 자체를 설명하는 부분 — 을 우선 쓴다
  // (사용자 피드백: "오늘 장중에 있었던 일들을 임팩트 있는 한줄로"). 전부 수치 포함 절뿐이면
  // 기존처럼 문단 첫 문장으로 폴백한다.
  const clauses = para.split(/(?<=[.,])\s+/).map((s) => s.trim()).filter(Boolean);
  const eventClause = clauses.find((c) => !hasIndexFigures(c) && looksCompleteEnough(c));
  const chosen = eventClause || clauses[0] || para;
  return safeSummarize(chosen, 110);
}

// looksComplete()보다 앞서 정의가 필요해 절 후보 1차 필터용으로 가볍게 문장부호만 확인한다
// (진짜 완결 판정은 safeSummarize 안의 looksComplete가 최종적으로 한 번 더 검증한다).
function looksCompleteEnough(text) {
  return /[.!?]$/.test(String(text || "").trim());
}

function extractOutlookFallback(analysisText) {
  const m = String(analysisText || "").match(/내일 주목할 변수\s*\n([\s\S]*)$/);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((s) => s.replace(/^\d+\)\s*|^-\s*/, "").trim())
    .filter(Boolean)
    // "내일 주목할 변수"는 불확실한 관전 포인트여야 한다. 증시 휴장 같은 단순 일정 공지는
    // 변수가 아니므로 체크포인트에서 제외한다 (사용자 피드백: "휴장은 변수에 왜 쓰는거?").
    .filter((s) => !/휴장|임시공휴일/.test(s))
    .slice(0, 3);
}

function extractInvestorFlowFallback(analysisText) {
  // "핵심:" 서술형 문장을 32자로 자르면 "동반 매도에"처럼 조사/어미에서 끊겨 문장이
  // 안 끝난 것처럼 보인다 (사용자 피드백: "문장이 마무리 안됨"). 대신 숫자+괄호로 그 자체가
  // 완결되는 구조화된 수급 데이터 줄([코스피] 외국인 .../ 기관 ...)을 그대로 사용한다.
  const text = String(analysisText || "");
  const m = text.match(/\[코스피\]\s*([^\n]+)/);
  if (!m) return "";
  const parts = m[1].split("/").map((s) => s.trim()).filter(Boolean);
  const picked = parts.slice(0, 2).join(" / ");
  return picked ? `코스피 수급 ${picked}` : "";
}

function extractStrategyFallback(analysisText, maxLen = 110) {
  const text = String(analysisText || "");
  const start = text.indexOf("향후 전략 및 총평");
  if (start === -1) return "";
  const nextSection = text.indexOf("🔭", start);
  const block = nextSection === -1 ? text.slice(start) : text.slice(start, nextSection);
  const line = block
    .split("\n")
    .slice(1)
    .map((s) => s.trim())
    .find(Boolean) || "";
  return line ? safeSummarize(line, maxLen) : "";
}

// 조사/연결어미로 끝나면 문장이 안 끝난 것처럼 보인다 (사용자 피드백: "동반 매도에... 폭락하며..
// 이렇게 문장이 마무리 안됨"). 억지로 자른 문구가 이런 꼴이면 아예 후보에서 제외한다.
const DANGLING_ENDINGS = ["에서", "으로", "에", "로", "와", "과", "이", "가", "은", "는", "을", "를", "고", "며", "면서", "지만", "라서", "인데", "니까"];
function looksComplete(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (/[.!?)"'」』%]$/.test(s)) return true;
  if (/[다요임음함]$/.test(s)) return true;
  if (DANGLING_ENDINGS.some((e) => s.endsWith(e))) return false;
  // 조사로 끝나지 않아도 마침표/'다·요·임·음·함'류 종결어미가 아니면
  // 문장이 실제로 끝난 것인지 확신할 수 없다(예: trimToNaturalBreak가 명사에서 자른 "...연속").
  // 애매하면 미완성으로 간주해 후보에서 제외한다(사용자 피드백: 문장이 중간에서 끊기면 안 됨).
  return false;
}

// summarizeToSentence(para, maxLen)는 완결된 첫 문장이 maxLen보다 길면 trimToNaturalBreak로
// 다시 자르는데, 이 2차 절단이 문장을 미완성으로 만들 수 있다(looksComplete 실패의 근본 원인).
// 그렇다고 그냥 버리면 AI 판단 박스가 통째로 비어버리는 새 버그가 생긴다(사용자 피드백:
// "박스가 비어있음"). 절단본이 미완성이면 길이 제한을 포기하고 완결된 원문장을 그대로 쓴다 —
// 조금 길어지더라도 미완성 문장이나 빈 박스보다 낫다.
function safeSummarize(para, maxLen) {
  const full = firstCompleteSentence(para);
  if (!full) return "";
  const trimmed = trimToNaturalBreak(full, maxLen);
  return looksComplete(trimmed) ? trimmed : full;
}

function extractFlowCommentFallback(analysisText) {
  const m = String(analysisText || "").match(/(?:🔄\s*)?시장 흐름 분석\s*\n([\s\S]*?)(?:\n\n|$)/);
  const para = m ? m[1].trim() : "";
  return para ? safeSummarize(para, 110) : "";
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
  // 커버(headline)·AI 판단(aiComment) 슬라이드가 이미 "왜 움직였는지" 원인/전략을 다루므로,
  // 시황 요약 슬라이드는 같은 문장을 복사하지 않고 수급 주체라는 새로운 포인트만 추가한다.
  // (전략 코멘트는 aiComment가 전담 — 여기서도 쓰면 슬라이드 2·4가 또 겹친다.)
  // 문장이 어중간하게 잘려 미완성처럼 보이면(looksComplete 실패) 억지로 넣지 않고 생략한다
  // (사용자 피드백: "전 페이지에 썼던 거 그대로 가져다 쓴다", "문장이 마무리 안됨").
  const investorFlow = extractInvestorFlowFallback(analysisText);
  if (investorFlow && looksComplete(investorFlow)) lines.push(investorFlow);
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
    // "오늘 장중에 실제로 있었던 일"을 담는다 (사용자 피드백: "코스피 오르고 내리고 이런 내용
    // 쓰지 말고 지수 수치 이런거 쓰지 말고", "오늘 장중에 있었던 일들을 임팩트 있는 한줄로").
    // extractHeadlineFallback이 "핵심 한 줄" 섹션(오늘 KR 장중 이벤트, 리포트가 직접 뽑아둔
    // 핵심 요약)에서 지수 수치가 없는 절을 우선 골라주므로, flowComment(간밤 뉴욕증시 recap 등
    // 간접 원인 — "시장 흐름 분석" 섹션)보다 resultLine을 headline의 1순위로 쓴다.
    const flowComment = extractFlowCommentFallback(analysisText);
    const resultLine = extractHeadlineFallback(analysisText);
    const strategyComment = extractStrategyFallback(analysisText, 110);
    const headline = resultLine || flowComment || buildIndexHeadline(snapshot) || "오늘의 시장 요약";
    // coreLine = "📌 핵심 한 줄" 섹션 원문(리포트가 직접 뽑아둔 그날의 핵심 한 줄 요약+원인).
    // 만평 릴스의 "왜 움직였는지" 카드는 headline(간밤 뉴욕증시 recap 등 간접 원인)보다
    // 이 핵심 한 줄을 우선 써야 한다 (사용자 피드백: "이 내용으로 만평을 해야하는데 엉뚱한게 써있음"
    // — 릴스에 시장 흐름 분석 문장이 나가고 핵심 한 줄이 안 나간 문제).
    const coreLine = resultLine || flowComment || buildIndexHeadline(snapshot) || "오늘의 시장 요약";
    // AI 판단(aiComment)이 커버(headline)와 똑같은 문장을 반복하지 않도록 한다
    // (사용자 피드백: "1번 카드 4번 카드 내용 중복"). 대체 후보도 억지로 잘라 문장이
    // 안 끝난 것처럼 보이면(looksComplete 실패) 걸러내고, 마땅한 후보가 없으면 비워둔다.
    const aiCandidates = [strategyComment, resultLine, flowComment];
    const aiComment = aiCandidates.find((c) => c && c !== headline && looksComplete(c)) || "";
    return {
      headline,
      coreLine,
      summaryLines: buildFallbackSummaryLines(snapshot, analysisText),
      aiComment,
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
  "headline": "커버 슬라이드용 한 줄 총평 (35~55자). 화면에 이미 표시되는 지수 등락률 숫자·포인트·퍼센트를 그대로 반복하지 말고('코스피 올랐다/내렸다' 같은 방향성 서술도 금지), 오늘 장중에 실제로 있었던 일(수급 이벤트, 사이드카/서킷브레이커, 특징 흐름 등)을 임팩트 있게 설명. 간밤 미국 증시 등 전날/해외 요인 recap이 아니라 오늘 국내 장중 사건 위주로 쓸 것. 완결된 문장으로 끝낼 것.",
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
      if (!Array.isArray(parsed.checkpoints) || parsed.checkpoints.length === 0) {
        parsed.checkpoints = extractOutlookFallback(analysisText);
      }
      // Claude가 만든 headline은 이미 "왜 움직였는지" 원인 설명 프롬프트로 생성된 문장이라
      // 만평 릴스의 reason-card에도 그대로 재사용한다 (fallback 경로의 coreLine과 대응).
      parsed.coreLine = parsed.coreLine || parsed.headline;
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
    // reasonLine(copy.coreLine, "핵심 한 줄")은 원문이 쉼표로 이어지는 긴 복문이라 날마다
    // 길이가 들쭉날쭉하다 (사용자 피드백: 만평에 엉뚱한 문장이 나가는 문제를 고친 뒤, 문장이
    // 길었던 날 아래 종목 카드가 화면 밖으로 잘리는 새 문제 발견). 여기서는 극단적으로 긴
    // 경우만 방지하는 여유 있는 상한을 걸고, 실제 화면 안 보장은 템플릿의 4줄 클램프(말줄임표)
    // 가 맡는다 — 그래야 문장이 매번 정확히 몇 자에서 끊길지 걱정하지 않아도 된다.
    reasonLine: trimToNaturalBreak(copy.coreLine || copy.headline || "", 150),
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
