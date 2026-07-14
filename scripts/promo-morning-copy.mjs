/**
 * 아침 브리핑(08:30 KST) 카드뉴스용 데이터 어댑터
 * data/morning-briefing.json (morning-briefing.mjs가 07:55 KST에 이미 채워둔 데이터)을 읽어
 * promo-render-cards.mjs가 바로 쓸 수 있는 공통 cardData 형태로 변환한다.
 *
 * 설계 원칙: morning-briefing.json 안의 aiAnalysis는 이미 AI가 만들어둔 분석이라
 * 여기서 Claude를 다시 호출하지 않는다 (마감 시황 카피와 달리, 원문을 그대로 요약 배치만 한다).
 */
import { readJson } from "./telegram-utils.mjs";

const DATA_PATH = "./data/morning-briefing.json";

const TICKER_NAME_KO = {
  AAPL: "애플", MSFT: "마이크로소프트", NVDA: "엔비디아", AMZN: "아마존",
  META: "메타", TSLA: "테슬라", GOOGL: "알파벳(구글)", AMD: "AMD",
  PLTR: "팔란티어", COIN: "코인베이스",
};

function trimTo(text, maxLen) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

/** 문단에서 첫 문장만 뽑는다 (마침표/다/요 뒤 공백 기준) */
function firstSentence(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  const m = s.split(/(?<=[.다다요])\s+/);
  return m[0] || s;
}

export async function loadMorningSnapshot() {
  const raw = await readJson(DATA_PATH);
  if (!raw || !raw.aiAnalysis) {
    throw new Error("data/morning-briefing.json에 aiAnalysis 데이터가 없습니다 (morning-briefing 워크플로우가 아직 안 돌았을 수 있음)");
  }
  return raw;
}

export function buildMorningCardData(snapshot, { dateLabel, theme = "light" } = {}) {
  const ai = snapshot.aiAnalysis || {};
  const indices = snapshot.usMarket?.indices || [];
  const commodities = snapshot.forex?.commodities || [];
  const usdKrw = snapshot.forex?.rates?.["USD/KRW"];

  const nasdaq = indices.find((i) => i.id === "nasdaq") || indices[0] || { changePct: 0 };
  const sp500 = indices.find((i) => i.id === "sp500");
  const sox = commodities.find((c) => c.id === "sox");

  const indexRows = [
    nasdaq && { name: "나스닥100", value: nasdaq.close?.toLocaleString?.() ?? String(nasdaq.close ?? "—"), pct: nasdaq.changePct },
    sp500 && { name: "S&P500", value: sp500.close?.toLocaleString?.() ?? String(sp500.close ?? "—"), pct: sp500.changePct },
    sox && { name: "필라델피아반도체", value: sox.price?.toLocaleString?.() ?? String(sox.price ?? "—"), pct: sox.changePct },
    usdKrw && { name: "원/달러", value: `${Math.round(usdKrw).toLocaleString()}원`, pct: 0 },
  ].filter(Boolean);

  // topStocks(실시간 대형주 등락)를 등락폭 큰 순으로 정렬해 "간밤 특징주"로 사용
  const topStocks = [...(snapshot.topStocks || [])]
    .filter((s) => Number.isFinite(s.changePct))
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 3)
    .map((s) => ({
      name: TICKER_NAME_KO[s.symbol] || s.symbol,
      reason: "",
      pct: s.changePct,
    }));

  const headline = trimTo(firstSentence(ai.summary), 58);
  const aiComment = trimTo(firstSentence(ai.domesticImpact) || firstSentence(ai.summary), 90);
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
