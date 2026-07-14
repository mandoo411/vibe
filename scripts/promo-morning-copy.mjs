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
    .slice(0, 3)
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
