/**
 * 장마감 리포트 Claude 분석 (구조화 JSON + web_search)
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

function fmtPrice(v) {
  if (v == null || v === "") return "—";
  const n = Number(String(v).replace(/,/g, ""));
  if (Number.isFinite(n)) return `${n.toLocaleString("ko-KR")}원`;
  return `${sanitizeStr(v)}원`;
}

function fmtMcap(raw) {
  const s = sanitizeStr(raw);
  if (!s) return "—";
  const n = Number(String(s).replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return s;
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}조`;
  const eok = n / 1e8;
  if (eok >= 10000) return `${(eok / 10000).toFixed(1)}조`;
  if (eok >= 100) return `${eok.toFixed(0)}억`;
  return `${Math.round(eok)}억`;
}

function fmtStockRow(s) {
  const code = s.code ? `(${s.code})` : "";
  const tv = s.tradingValue || s.tradingValueRaw || "—";
  return `${s.name || "—"}${code} ${fmtPct(s.change)} ${fmtPrice(s.currentPrice || s.price)} 거래대금 ${tv} 시총 ${fmtMcap(s.stck_avls || s.hts_avls)}`;
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

function buildMcapTop100Movers(topGainers, topDecliners, mcapRankByCode, limit = 15) {
  const inTop100 = (s) => {
    const rank = mcapRankOf(s?.code, mcapRankByCode);
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

function buildMacroSearchQueries(targetYmd) {
  return [
    `${targetYmd} 코스피 코스닥 마감 시황 수급`,
    `${targetYmd} 외국인 기관 순매수 순매도`,
    `FOMC 금리 ${targetYmd} 한국 증시 영향`,
    `오늘 증시 특징주 급등 이유 ${targetYmd}`,
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
}) {
  const lines = [];
  const fx = findUsdKrw(marketExtras);
  const { up: mcapUp, down: mcapDown } = buildMcapTop100Movers(
    topGainers,
    topDecliners,
    mcapRankByCode
  );

  lines.push(`오늘 장마감 데이터 (${targetYmd} KST)`);
  lines.push("");
  lines.push("=== 1-1. 지수 (KIS/수집 데이터) ===");
  for (const idx of indexes || []) {
    lines.push(
      `${idx.name}: 현재가 ${idx.value || "—"} / 등락률 ${fmtPct(idx.change)}${idx.tradingValue ? ` / 거래대금 ${idx.tradingValue}` : ""}`
    );
  }
  if (fx) {
    const fxVal = fx.valueFormatted || fx.value || "—";
    const fxChg = fx.changePct != null ? ` / 등락률 ${fmtPct(fx.changePct)}` : "";
    lines.push(`원/달러: ${fxVal}${fxChg}`);
  } else {
    lines.push("원/달러: (수집 데이터 없음)");
  }

  lines.push("");
  lines.push("=== 1-2. 수급 (KIS, 억원 순매수) ===");
  if (!supply?.length) lines.push("(수급 데이터 없음)");
  else {
    for (const row of supply) {
      lines.push(
        `${row.market}: 외국인 ${fmtEok(row.foreign)}, 기관 ${fmtEok(row.institution)}, 개인 ${fmtEok(row.retail ?? row.individual)}`
      );
    }
  }

  lines.push("");
  lines.push("=== 1-3. 종목 (KIS 수집) ===");
  lines.push("[상승률 TOP30]");
  for (const s of (topGainers || []).slice(0, 30)) {
    lines.push(`- ${fmtStockRow(s)}`);
  }
  lines.push("");
  lines.push("[하락률 TOP30]");
  for (const s of (topDecliners || []).slice(0, 30)) {
    lines.push(`- ${fmtStockRow(s)}`);
  }
  lines.push("");
  lines.push("[시총 TOP100 중 등락률 상위 (대형주 특징주 Pool)]");
  if (!mcapUp.length) lines.push("(해당 없음 또는 시총 순위 미수집)");
  else for (const s of mcapUp) lines.push(`- ${fmtStockRow(s)}`);
  lines.push("");
  lines.push("[시총 TOP100 중 등락률 하위 (대형주 급락 Pool)]");
  if (!mcapDown.length) lines.push("(해당 없음 또는 시총 순위 미수집)");
  else for (const s of mcapDown) lines.push(`- ${fmtStockRow(s)}`);

  lines.push("");
  lines.push("=== 1-4. 매크로 뉴스 (web_search 필수 — STEP 1에서 반드시 검색) ===");
  for (const q of buildMacroSearchQueries(targetYmd)) {
    lines.push(`- "${q}"`);
  }

  lines.push("");
  lines.push("=== 출력 JSON 스키마 (순수 JSON만, 코드블록 없이) ===");
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
  "watchlist": ["...", "...", "..."],
  "strategy": { "kospi": "", "kosdaq": "", "market_type": "" }
}`);

  lines.push("");
  lines.push(
    "위 수집 데이터와 web_search 결과만 근거로 JSON을 작성하세요. 재료 미확인 종목은 featured_stocks에서 제외하세요."
  );
  return lines.join("\n");
}

const WEB_SEARCH_TOOLS = [
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 15,
  },
];

function buildSystemPrompt(targetYmd) {
  return `당신은 TotalMoney AI의 한국 주식시장 수석 애널리스트입니다.
매일 장 마감 후 마감시황 리포트를 작성합니다.

## 작업 순서 (반드시 이 순서대로)

### STEP 1. 매크로 뉴스 검색
다음을 반드시 웹서치로 확인:
- "${targetYmd} 코스피 마감 시황 수급 외국인 기관"
- "FOMC 금리 결정 한국 증시 영향 ${targetYmd}"
- 기타 오늘 시장에 영향을 준 매크로 이슈

### STEP 2. 특징주 재료 검색
상승률 TOP10 각 종목에 대해 반드시 웹서치:
- "{종목명} 급등 이유 ${targetYmd}"
- "{종목명} 상한가 재료 공시 ${targetYmd}"
검색 결과에서 구체적 재료(공시/뉴스/수주) 확인
재료 미확인 종목은 리포트에서 제외

하락률 TOP5 (시총 100위 이내) 각 종목도 웹서치:
- "{종목명} 급락 이유 ${targetYmd}"

### STEP 3. 리포트 작성

아래 구조로 작성:

**[분석 원칙]**

1. 인과관계 정확히 기술
   - 지수 등락 원인은 시총 상위 대형주 또는 수급으로 설명
   - 소형 테마주 급등을 지수 흐름의 원인으로 절대 금지
   - 올바른 예: "외국인 X조원 순매수 + SK하이닉스 신고가가 코스피를 견인"
   - 금지 예: "삼화전기가 올라서 코스피가 버텼다"

2. 수급 원인 설명 필수
   - "외국인 -1조원" 같은 숫자만 나열 금지
   - 왜 샀는지/팔았는지 맥락 포함
   - 예: "외국인은 FOMC 매파 충격에도 HBM 수요 확신으로 SK하이닉스 집중 매수"

3. 핵심 한 줄 작성 규칙
   - 오늘 장 전체를 관통하는 가장 큰 원인 1개로 요약
   - 코스피/코스닥 방향 다르면 둘 다 포함
   - 구체적이고 임팩트 있게

4. 특징주 선정 기준
   - Pool A: 전 종목 +20% 이상 급등 (재료 확인된 것만)
   - Pool B: 시총 100위 이내 +10% 이상 급등
   - Pool C: 시총 100위 이내 -5% 이하 급락 (최소 3개)
   - Pool 구분 없이 통합 표시, 최대 10종목
   - 재료 미확인 종목 절대 포함 금지

**[리포트 구조]**

### 1. 핵심 한 줄
오늘 장 전체를 관통하는 한 문장

### 2. 지수 마감
코스피 / 코스닥 / 원달러 테이블
(현재가 / 등락 / 등락률)

### 3. 시장 흐름 분석
- 장 흐름 서술 (시가→종가 과정)
- 매크로 원인 (금리/환율/해외증시)
- 코스피/코스닥 차별화 원인 설명

### 4. 투자자별 매매 동향
- 외국인/기관/개인 각각 수급 방향 + 원인
- 코스피/코스닥 각각 테이블로 표시

### 5. 오늘의 특징주 (최대 10종목)
각 종목:
- 종목명 / 등락률 / 현재가
- 재료: 웹서치로 확인된 구체적 뉴스/공시 내용
- 포인트: 투자 관점 1줄 (과열 경고 포함 시 명시)

### 6. 향후 전략 및 총평
- 오늘 장세 성격 규정
- 코스피/코스닥 각각 단기 전략
- 내일 주목할 변수 3개 (시간/내용 구체적으로)

**[출력 규칙]**
- 반드시 순수 JSON만 출력 (마크다운 코드블록 없이)
- 추측이나 일반론 금지, 데이터+웹서치 기반으로만
- 재료 미확인 종목은 featured_stocks에서 제외
- 웹서치 없이 재료 작성 절대 금지`;
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
  const user = ensureJsonSafe(
    buildUserPrompt({
      targetYmd,
      indexes,
      supply,
      marketExtras,
      topGainers,
      topDecliners,
      mcapRankByCode,
    })
  );

  let parsed;
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: 14000,
      system: buildSystemPrompt(targetYmd),
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

  const featured = normalizeFeaturedList(parsed.featured_stocks || parsed.issueStocks);
  const summary = sanitizeStr(parsed.summary);
  const analysis = sanitizeStr(parsed.analysis);
  const watchlist = Array.isArray(parsed.watchlist)
    ? parsed.watchlist.map((w) => sanitizeStr(w)).filter(Boolean).slice(0, 3)
    : [];
  const investorTrend =
    parsed.investor_trend && typeof parsed.investor_trend === "object" ? parsed.investor_trend : {};
  const strategy = parsed.strategy && typeof parsed.strategy === "object" ? parsed.strategy : {};

  const stocks = Array.isArray(parsed.stocks) ? parsed.stocks : [];
  if (stocksForThemes?.length && stocks.length !== stocksForThemes.length) {
    console.warn(`Claude stocks length ${stocks.length} != ${stocksForThemes.length}, padding`);
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
