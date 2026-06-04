/**
 * Claude API 공통: UTF-16 서로게이트 제거, 크레딧/API 오류 감지, 규칙 기반 폴백 분석
 */

export function sanitizeUnicode(value) {
  const s = String(value ?? "");
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(new TextEncoder().encode(s));
  } catch {
    return s.replace(/[\uD800-\uDFFF]/g, "").replace(/\uFFFD/g, "");
  }
}

export function ensureJsonSafe(value, maxLen = 80_000) {
  let s = sanitizeUnicode(value);
  if (s.length > maxLen) s = `${sanitizeUnicode(s.slice(0, maxLen - 1))}…`;
  JSON.parse(JSON.stringify({ t: s }));
  return s;
}

export function isClaudeUnavailableError(error) {
  const msg = String(error?.message || error?.error?.message || error || "");
  return (
    /credit balance|too low|billing|purchase credits/i.test(msg) ||
    /invalid_request_error.*JSON|no low surrogate/i.test(msg) ||
    /rate_limit|overloaded|529|502|503/i.test(msg)
  );
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function buildFallbackLiveAnalysis({ time, kospi, kosdaq, top30 = [], themes = [] }) {
  const topLines = top30
    .slice(0, 15)
    .map((r) => `- ${r.rank}. ${r.name} ${fmtPct(r.rate)} (${r.price ?? "—"}원)`)
    .join("\n");
  const themeLines = (themes || [])
    .slice(0, 6)
    .map((t) => `- ${t.name || t.theme}: ${(t.count || t.leaders?.length || 0)}종`)
    .join("\n");
  return ensureJsonSafe(`# 📈 실시간 시황 (${time})

## 🎙️ 지수
- 코스피 **${kospi?.value ?? "—"}** ${fmtPct(kospi?.change)}
- 코스닥 **${kosdaq?.value ?? "—"}** ${fmtPct(kosdaq?.change)}

## 🏆 상승률 상위
${topLines || "(데이터 없음)"}

## 🔥 감지 테마
${themeLines || "(테마 요약 없음)"}

---
※ Claude AI 분석이 일시 중단되어(크레딧·API) 지수·종목·테마 데이터만 표시합니다. 크레딧 충전 후 풀 분석이 자동 복구됩니다.`);
}

export function buildFallbackDailyClosingReport({
  targetYmd,
  indexes = [],
  supply = [],
  sectors = [],
  topGainers = [],
}) {
  const idxLine = indexes.map((i) => `${i.name} ${i.value || "—"} ${fmtPct(i.change)}`).join(" · ");
  const supplyLine = supply
    .map((r) => `${r.market}: 외 ${r.foreign ?? "—"}억 / 기 ${r.institution ?? "—"}억`)
    .join(" | ");
  const sectorStrong = [...sectors]
    .sort((a, b) => (b.changePct || 0) - (a.changePct || 0))
    .slice(0, 3)
    .map((s) => `${s.name} ${fmtPct(s.changePct)}`);
  const sectorWeak = [...sectors]
    .sort((a, b) => (a.changePct || 0) - (b.changePct || 0))
    .slice(0, 3)
    .map((s) => `${s.name} ${fmtPct(s.changePct)}`);
  const stocks = topGainers.map((s) => ({
    code: s.code,
    reason: `${s.name} ${fmtPct(s.change)} (AI 분석 대기)`,
    theme: "기타",
  }));

  return {
    headlineIssue: idxLine || `${targetYmd} 장마감 데이터`,
    supplyComment: supplyLine || "수급 데이터 기준 요약 (AI 분석 대기)",
    issueStocks: topGainers.slice(0, 5).map((s) => ({
      name: s.name,
      change: s.change,
      entryReason: "상승률 상위",
      background: "Claude 분석 일시 중단",
    })),
    sectorFlow: {
      strong: sectorStrong.map((name) => ({ name, changePct: null, reason: "업종 데이터" })),
      weak: sectorWeak.map((name) => ({ name, changePct: null, reason: "업종 데이터" })),
      summary: "섹터별 등락은 입력 데이터 기준 (AI 해석 대기)",
    },
    tomorrowCheckpoints: [
      "미국 증시·환율 흐름 확인",
      "외국인·기관 수급 지속 여부",
      "상승 테마 확산 vs 차익 실현",
    ],
    oneLineVerdict: idxLine ? `${targetYmd} 마감 — ${idxLine}` : `${targetYmd} 마감`,
    marketSummary: `Claude API 크레딧/일시 오류로 AI 시황 요약을 생성하지 못했습니다. 지수·수급·상승률 TOP·업종 데이터는 정상 저장되었습니다.`,
    notableStocks: topGainers.slice(0, 8).map((s) => ({
      name: s.name,
      code: s.code,
      change: s.change,
      tradingValue: s.tradingValue || "",
      note: `${fmtPct(s.change)} (AI 분석 대기)`,
    })),
    stocks,
    topNews: [],
    marketExtraComments: {},
    _fallback: true,
  };
}

export function buildFallbackBriefingAnalysis(data) {
  const indices = data?.usMarket?.indices || [];
  const idxText = indices
    .map((i) => `${i.name} ${fmtPct(i.changePct)}`)
    .filter(Boolean)
    .join(", ");
  const top = (data?.topStocks || []).slice(0, 5).map((s) => s.symbol).join(", ");
  return {
    keyIssues: [
      idxText ? `미국 지수: ${idxText}` : "미국 지수 데이터 확인",
      top ? `주요 종목: ${top}` : "빅테크 종목 동향 확인",
      "Claude AI 분석 일시 중단 — 정적·실시간 데이터만 표시",
    ],
    domesticImpact:
      "Anthropic API 크레딧 부족으로 AI 장전 분석을 생성하지 못했습니다. 상단 미국 지수·환율·뉴스는 수집된 데이터를 참고해 주세요.",
    watchSectors: (data?.sectors || []).slice(0, 3).map((s) => s.name || s.symbol).filter(Boolean),
    marketComments: {},
    _fallback: true,
  };
}

/** Claude 응답 텍스트 → JSON (잘린 응답·코드펜스 복구) */
export function parseJsonFromAssistant(text) {
  let raw = sanitizeUnicode(String(text || "")).trim();
  raw = raw
    .replace(/^```json\s*/im, "")
    .replace(/^```\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim();

  const tryParse = (candidate) => {
    const s = String(candidate || "").trim();
    if (!s) throw new Error("empty JSON");
    return JSON.parse(s);
  };

  const attempts = [() => tryParse(raw)];
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) attempts.push(() => tryParse(braceMatch[0]));

  const repaired = repairTruncatedJsonObject(raw);
  if (repaired) attempts.push(() => tryParse(repaired));

  let lastErr;
  for (const fn of attempts) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Claude JSON parse failed");
}

function repairTruncatedJsonObject(text) {
  const start = String(text || "").indexOf("{");
  if (start < 0) return null;
  let s = String(text).slice(start).trim();

  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if ((c === "}" || c === "]") && stack.length) stack.pop();
  }

  if (inString) s += '"';
  while (stack.length) s += stack.pop();
  return s;
}
