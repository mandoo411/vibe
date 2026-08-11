/**
 * 아침 브리핑(08:30 KST) 카드뉴스용 데이터 어댑터
 * data/morning-briefing.json (morning-briefing.mjs가 07:55 KST에 이미 채워둔 데이터)을 읽어
 * promo-render-cards.mjs가 바로 쓸 수 있는 공통 cardData 형태로 변환한다.
 *
 * 설계 원칙: morning-briefing.json 안의 aiAnalysis는 이미 AI가 만들어둔 분석이라
 * 여기서 Claude를 다시 호출하지 않는다 (마감 시황 카피와 달리, 원문을 그대로 요약 배치만 한다).
 */
import { readJson } from "./telegram-utils.mjs";
import { summarizeToSentence } from "./promo-text-utils.mjs";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_SEARCH_MODEL || "claude-haiku-4-5-20251001";

const DATA_PATH = "./data/morning-briefing.json";
const DAILY_MARKET_PATH = "./data/daily-market.json";

const TICKER_NAME_KO = {
  AAPL: "애플", MSFT: "마이크로소프트", NVDA: "엔비디아", AMZN: "아마존",
  META: "메타", TSLA: "테슬라", GOOGL: "알파벳(구글)", AMD: "AMD",
  PLTR: "팔란티어", COIN: "코인베이스",
};

// 종목별 상승/하락 맥락을 짧게 붙여줄 기본 코멘트(개별 뉴스 기반이 아닌 업종 일반 동인 — 데이터에 종목별 사유가 없을 때의 보완용)
const TICKER_REASON_KO = {
  AAPL: "실적 시즌 기대감",
  MSFT: "클라우드·AI 투자 확대 기대",
  NVDA: "AI 반도체 랠리 지속",
  AMZN: "이커머스·클라우드 확대 기대",
  META: "광고 실적 기대감",
  TSLA: "인도량·실적 기대감",
  GOOGL: "AI 검색·클라우드 강세",
  AMD: "반도체 업종 강세 동반",
  PLTR: "AI 소프트웨어 수요 기대",
  COIN: "가상자산 시장 강세 동반",
};

export async function loadMorningSnapshot() {
  const raw = await readJson(DATA_PATH);
  if (!raw || !raw.aiAnalysis) {
    throw new Error("data/morning-briefing.json에 aiAnalysis 데이터가 없습니다 (morning-briefing 워크플로우가 아직 안 돌았을 수 있음)");
  }
  return raw;
}

/** 전일 마감 원/달러(종가)를 daily-market.json에서 best-effort로 읽어온다. 실패해도 조용히 undefined 반환 */
async function loadPreviousUsdKrw() {
  try {
    const raw = await readJson(DAILY_MARKET_PATH);
    const days = raw?.days || {};
    const lastKey = Object.keys(days).sort().pop();
    const rate = lastKey ? days[lastKey]?.indexes?.usdkrw?.rate : undefined;
    return Number.isFinite(rate) ? rate : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 모닝 브리핑 릴스 전용 "오늘의 한줄 논평" (2026-07-31 추가)
// 기존 aiComment(domesticImpact/summary 요약)는 카드뉴스 전체용 범용 문구라 형식이 고정되어
// 있지 않았다. 릴스의 한줄 논평은 "예측" 중심이어야 한다: 간밤 해외에서 실제로 있었던 일(원인) ->
// 그 여파로 오늘 국내 증시가 어떤 방향을 보일지(예측)로 이어지는 완결된 문장 하나
// (사용자 피드백: "브리핑은 예측의 영역... 말끝 흐리기 절대 안됨").
// ---------------------------------------------------------------------------

function looksComplete(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (/[.!?)"'」』%]$/.test(s)) return true;
  if (/[다요임음함]$/.test(s)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// "미국 대형주"라고 부를 수 있는 종목 판정 (2026-08-11 추가)
// 배경: morning-briefing.mjs의 TOP_STOCKS 감시 목록에는 애플·마이크로소프트 같은 진짜
// 대형주 외에 코인베이스(COIN)·팔란티어(PLTR)처럼 시총은 훨씬 작지만 등락폭이 큰 종목도
// 섞여 있다. 아래 buildMorningReelFallback()의 "간밤 최대 변동 종목" 로직이 이 구분 없이
// 등락폭 1위 종목을 그대로 "미국 대형주"라고 소개해버려서, 코인베이스가 그냥 그날 밤
// 변동폭이 가장 컸다는 이유만으로 "미국 대형주 약세/강세"로 잘못 소개되는 문제가 있었다
// (코인베이스는 세계 시총 TOP100에도 들지 못한다 — data/world-market-cache.json 기준).
// 이제는 실제 미국 시총 상위 20위 안에 드는 종목만 "대형주" 프레이밍에 쓴다.
// ---------------------------------------------------------------------------
const WORLD_MARKET_CACHE_PATH = "./data/world-market-cache.json";

// world-market-cache.json은 전세계 시총 랭킹이라 미국 외 기업(TSM·삼성·SK하이닉스·ASML·
// 텐센트·Saudi Aramco·중국건설은행 등, 일부는 실제 티커 없이 "rank:N" placeholder 키로
// 저장됨)이 섞여 있다 — "미국 대형주" 판정 시 이들은 제외한다.
const NON_US_MARKET_CAP_SYMBOLS = new Set(["TSM", "SPCX", "SSNLF", "TCEHY", "ASML", "CXMT"]);
const VALID_US_TICKER_RE = /^[A-Z][A-Z.\-]{0,5}$/;

let cachedUsMegaCapSet = null;
/** 실제 미국 시총 상위 20개 티커 집합. world-market-cache.json에서 매번 새로 계산하므로
 * 시총 순위가 바뀌어도(예: AMD가 20위 밖으로 밀려남) 수동 갱신 없이 자동으로 반영된다. */
async function loadUsMegaCapSet() {
  if (cachedUsMegaCapSet) return cachedUsMegaCapSet;
  try {
    const raw = await readJson(WORLD_MARKET_CACHE_PATH);
    const top20 = Object.entries(raw?.entries || {})
      .filter(
        ([sym, e]) =>
          VALID_US_TICKER_RE.test(sym) &&
          !NON_US_MARKET_CAP_SYMBOLS.has(sym) &&
          Number.isFinite(e?.marketCap)
      )
      .sort((a, b) => b[1].marketCap - a[1].marketCap)
      .slice(0, 20)
      .map(([sym]) => sym);
    if (top20.length >= 10) {
      cachedUsMegaCapSet = new Set(top20);
      return cachedUsMegaCapSet;
    }
  } catch {
    /* world-market-cache.json이 없거나 파싱 실패 — 아래 폴백 사용 */
  }
  // 최후 폴백(2026-08-11 실데이터 스냅샷 기준). world-market-cache.json을 못 읽을 때만 쓰이며,
  // 시총 순위는 시간이 지나며 바뀌므로 주기적으로 재검토가 필요하다.
  cachedUsMegaCapSet = new Set([
    "NVDA", "AAPL", "GOOG", "GOOGL", "MSFT", "AMZN", "AVGO", "META", "TSLA",
    "BRK-B", "LLY", "MU", "JPM", "WMT", "AMD", "V", "XOM", "JNJ", "MA", "INTC", "CSCO",
  ]);
  return cachedUsMegaCapSet;
}

async function buildMorningReelFallback(snapshot) {
  const ai = snapshot.aiAnalysis || {};
  const indices = snapshot.usMarket?.indices || [];
  const nasdaq = indices.find((i) => i.id === "nasdaq") || indices[0];
  const dirWord = (pct) => (pct > 0 ? "강세" : pct < 0 ? "약세" : "보합");

  const megaCapSet = await loadUsMegaCapSet();
  const topStocks = [...(snapshot.topStocks || [])]
    .filter((s) => Number.isFinite(s.changePct))
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  // "미국 대형주 ○○ 여파" 문장은 실제 시총 상위 20위 안에 드는 종목이 최대 변동 종목일 때만
  // 쓴다 — 코인베이스·팔란티어처럼 등락폭은 커도 대형주가 아닌 종목이 1위였다는 이유만으로
  // "대형주"라고 잘못 소개하지 않기 위함.
  const top = topStocks.find((s) => megaCapSet.has(s.symbol));

  // 1순위: 간밤 최대 변동 "대형주" + 나스닥 방향으로 완결된 규칙 기반 예측 문장(수치 반복 없음).
  if (top) {
    const name = TICKER_NAME_KO[top.symbol] || top.symbol;
    return `간밤 ${name} 등 미국 대형주 ${dirWord(top.changePct)} 여파로, 오늘 국내 증시는 장초반 ${dirWord(nasdaq?.changePct ?? 0)}가 예상된다.`;
  }
  // 2순위: 이미 완결형으로 큐레이션된 원문 필드가 있으면 그대로.
  const candidate = ai.todayOutlook?.scenario || ai.conclusion || ai.summary || "";
  if (candidate && looksComplete(candidate)) return summarizeToSentence(candidate, 100);
  // 3순위(최후 수단): 방향만으로 완결된 일반 문장. 대형주 변동이 없었던 날(또는 대형주가 아닌
  // 종목만 크게 움직인 날)은 특정 종목명을 지어내지 않고 지수 방향만 언급한다.
  return `간밤 미국 증시 흐름을 반영해 오늘 국내 증시는 장초반 ${dirWord(nasdaq?.changePct ?? 0)}가 예상된다.`;
}

/** 모닝 브리핑 릴스용 한줄 논평을 전용 프롬프트로 생성. Claude 미가용 시 규칙 기반 폴백으로 항상 완결된 문장을 보장한다. */
export async function buildMorningReelComment(snapshot) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const ai = snapshot.aiAnalysis || {};
  const sourceText = [ai.summary, ai.conclusion, ai.todayOutlook?.scenario, ...(ai.keyIssues || [])]
    .filter(Boolean)
    .join("\n");

  const fallback = () => buildMorningReelFallback(snapshot);
  if (!apiKey || !sourceText) return fallback();

  const indices = snapshot.usMarket?.indices || [];
  const indexFacts = indices
    .map((i) => (Number.isFinite(i.changePct) ? `${i.name || i.id} ${i.changePct > 0 ? "+" : ""}${i.changePct}%` : null))
    .filter(Boolean)
    .join(", ");

  const userPrompt = `아래는 간밤 미국 증시·글로벌 브리핑 원문이야. 이걸 바탕으로 인스타 릴스에 들어갈 "오늘의 한줄 논평"을 정확히 한 문장으로 작성해줘.

작성 원칙:
1. 모닝 브리핑은 "예측"을 다루는 논평이다. 간밤 미국장·유럽장·해외 정세 등에서 실제로 있었던 핵심 이벤트를 원인으로 제시하고, 그 여파로 오늘 국내 증시가 어떤 방향(강세/약세)을 보일지 예측으로 이어서 서술해.
2. 반드시 완결된 문장으로 끝내라. "~예상된다", "~전망된다"처럼 명확한 종결어미로 끝날 것. 쉼표나 "..."로 흐리는 것 절대 금지.
3. 화면에 이미 지수 등락률 숫자가 표시되므로 숫자를 반복하지 마라. 대신 "왜" 그런 흐름이 예상되는지 사건 중심으로 설명해.
4. 원문에 없는 사실은 지어내지 마라(할루시네이션 금지).
5. 길이는 40~80자 내외.
6. 참고할 문체 예시(그대로 베끼지 말고 이런 톤으로): "간밤 MS 어닝서프라이즈를 비롯한 메모리관련주들의 급등으로 인해, 장초반 강세가 예상된다."

[간밤 지수 마감]
${indexFacts || "데이터 없음"}

[브리핑 원문]
${sourceText.slice(0, 4000)}

문장 하나만, 따옴표나 다른 부연설명 없이 출력해.`;

  const client = new Anthropic({ apiKey });
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 200,
        system: "TotalMoney AI 인스타 릴스 한줄 논평 작성자. 예측 중심, 명확한 종결어미, 과장·할루시네이션 금지. 문장 하나만 출력.",
        messages: [{ role: "user", content: userPrompt }],
      });
      const text = (res.content?.find((b) => b.type === "text")?.text || "").trim().replace(/^["']|["']$/g, "");
      if (text && looksComplete(text) && text.length <= 140) return text;
    } catch (error) {
      console.warn(`[promo-morning-copy] 브리핑 릴스 코멘트 생성 시도 ${attempt}/${MAX_ATTEMPTS} 실패:`, error instanceof Error ? error.message : error);
      if (attempt === MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return fallback();
}

export async function buildMorningCardData(snapshot, { dateLabel, theme = "light" } = {}) {
  const ai = snapshot.aiAnalysis || {};
  const indices = snapshot.usMarket?.indices || [];
  const commodities = snapshot.forex?.commodities || [];
  const usdKrw = snapshot.forex?.rates?.["USD/KRW"];

  const nasdaq = indices.find((i) => i.id === "nasdaq") || indices[0] || { changePct: 0 };
  const sp500 = indices.find((i) => i.id === "sp500");
  const sox = commodities.find((c) => c.id === "sox");
  const wti = commodities.find((c) => c.id === "wti");
  const koreaEtf = indices.find((i) => i.id === "korea-etf");

  const prevUsdKrw = usdKrw ? await loadPreviousUsdKrw() : undefined;
  const usdKrwPct = usdKrw && prevUsdKrw ? ((usdKrw - prevUsdKrw) / prevUsdKrw) * 100 : 0;

  const indexRows = [
    nasdaq && { name: "나스닥100", value: nasdaq.close?.toLocaleString?.() ?? String(nasdaq.close ?? "—"), pct: nasdaq.changePct },
    sp500 && { name: "S&P500", value: sp500.close?.toLocaleString?.() ?? String(sp500.close ?? "—"), pct: sp500.changePct },
    sox && { name: "필라델피아반도체", value: sox.price?.toLocaleString?.() ?? String(sox.price ?? "—"), pct: sox.changePct },
    wti && { name: "WTI유가", value: `$${wti.price?.toLocaleString?.() ?? wti.price}`, pct: wti.changePct },
    usdKrw && { name: "원/달러", value: `${Math.round(usdKrw).toLocaleString()}원`, pct: usdKrwPct },
    koreaEtf && { name: "한국ETF(EWY)", value: `$${koreaEtf.close?.toLocaleString?.() ?? koreaEtf.close}`, pct: koreaEtf.changePct },
  ].filter(Boolean);

  // topStocks(실시간 대형주 등락)를 등락폭 큰 순으로 정렬해 "간밤 특징주"로 사용
  const topStocks = [...(snapshot.topStocks || [])]
    .filter((s) => Number.isFinite(s.changePct))
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 5)
    .map((s) => ({
      name: TICKER_NAME_KO[s.symbol] || s.symbol,
      reason: TICKER_REASON_KO[s.symbol] || "",
      pct: s.changePct,
    }));

  // keyIssues는 이미 완결된 짧은 문장으로 큐레이션돼 있어 헤드라인으로 쓰면 어중간하게 끊기지 않는다.
  const headline = (ai.keyIssues || [])[0] ? summarizeToSentence(ai.keyIssues[0], 100) : summarizeToSentence(ai.summary, 100);
  const aiComment = summarizeToSentence(ai.domesticImpact || ai.summary, 110);
  const checkpoints = (ai.keyIssues || []).slice(0, 3);

  return {
    date: dateLabel,
    slotLabel: "아침 브리핑",
    coverTitleLine1: "AI가 정리한",
    coverTitleLine2: "간밤 미국장",
    heroLabel: "나스닥100",
    heroPct: nasdaq.changePct || 0,
    headline,
    indexTitle: "글로벌 지수 브리핑",
    indexRows,
    listTitle: "간밤 미국 증시 특징주",
    listItems: topStocks,
    aiTitle: "AI 오늘의 전망",
    aiComment,
    checkpointsTitle: "오늘 체크포인트",
    checkpoints,
    theme,
  };
}
