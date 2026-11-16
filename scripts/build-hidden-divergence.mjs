/**
 * 히든 다이버전스 (2026-11-16 신설) — 시우 요청: "상승추세 출발점 a보다 눌림 바닥 b가 가격은 높은데
 * RSI는 더 낮은 구간(상승 히든 다이버전스)에 온 종목만 찾기".
 *
 * 판정은 build-screener-cache.mjs가 종목마다 일봉으로 계산해 stocks[].hiddenBull에 넣어 둔다
 * (lib/kis-indicators.js detectHiddenBullishDivergence). 이 스크립트는 그걸 거르고 정렬해서 파일로 쓴다.
 *   a: 좌우 5일보다 낮은 바닥, 그 뒤 고점 H까지 +20% 이상 상승, a~H 사이 a보다 낮은 저가 없음
 *   b: 최근 10거래일 안의 최저 저가, H 대비 8% 이상 눌림, H~b 사이 b보다 낮은 저가 없음
 *   조건: b 저가 > a 저가, RSI(14)(b) < RSI(a)
 * 추가 필터: 시총 1,000억↑ · 20일 평균 거래대금 10억↑ · 스팩·리츠 제외. 시총 큰 순.
 *
 * 입력: data/kr-screener-cache.json  출력: data/hidden-divergence.json — { asOfDate, picks[], history[] }
 * history: 날짜별 신규 등장 종목(전날 목록에 없던 것)의 기준가와 5·20거래일 뒤 종가 — 신호가 쓸모 있는지 쌓아 보려고.
 */
import fs from "node:fs";

const CACHE = "data/kr-screener-cache.json";
const OUT = "data/hidden-divergence.json";
const MIN_MC_EOK = 1000;
const MIN_TV20_EOK = 10;
const MAX_PICKS = 80;
const KEEP_HISTORY = 80;
const BAD_NAME = /스팩|리츠/;

const cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const asOf = cache.asOfDate;
if (!asOf) {
  console.error("cache has no asOfDate");
  process.exit(1);
}
const byCode = new Map((cache.stocks || []).map((s) => [s.code, s]));

let prev = { picks: [], history: [] };
try {
  prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
} catch (_) {
  /* 첫 실행 */
}
const prevCodes = new Set(prev.asOfDate && prev.asOfDate < asOf ? (prev.picks || []).map((p) => p.code) : (prev.prevCodes || []));

const picks = [];
let scanned = 0;
for (const s of cache.stocks || []) {
  const hb = s.hiddenBull;
  if (!hb) continue;
  scanned += 1;
  if (BAD_NAME.test(s.name || "")) continue;
  if (!(s.marketCapEok >= MIN_MC_EOK)) continue;
  const n = s.snapshot || {};
  const tv20 = n.next && n.next.avgVol20 && s.close ? (n.next.avgVol20 * s.close) / 1e8 : null;
  if (tv20 != null && tv20 < MIN_TV20_EOK) continue;
  picks.push({
    code: s.code,
    name: s.name,
    market: s.market,
    close: s.close,
    changePct: s.changePct,
    marketCapEok: Math.round(s.marketCapEok),
    sector: n.sector || null,
    isNew: !prevCodes.has(s.code),
    fromB: hb.bLow ? Math.round((s.close / hb.bLow - 1) * 1000) / 10 : null,
    ...hb,
  });
}
picks.sort((a, b) => b.marketCapEok - a.marketCapEok);
const matched = picks.length;
const top = picks.slice(0, MAX_PICKS);

// 기록 — 기존 항목의 경과 거래일과 5·20일 뒤 종가
const history = Array.isArray(prev.history) ? prev.history : [];
for (const h of history) {
  if (h.date >= asOf || h.lastSeen === asOf) continue;
  if ((h.age || 0) >= 20) continue;
  h.age = (h.age || 0) + 1;
  h.lastSeen = asOf;
  for (const p of h.picks) {
    const s = byCode.get(p.code);
    if (!s || !s.close) continue;
    p.last = s.close;
    if (h.age === 5) p.d5 = s.close;
    if (h.age === 20) p.d20 = s.close;
  }
}
const fresh = picks.filter((p) => p.isNew);
const idx = history.findIndex((h) => h.date === asOf);
const entry = {
  date: asOf,
  age: 0,
  lastSeen: asOf,
  matched,
  picks: fresh.map((p) => ({ code: p.code, name: p.name, base: p.close })),
};
if (idx >= 0) history[idx] = entry;
else if (fresh.length) history.push(entry);
history.sort((a, b) => (a.date < b.date ? -1 : 1));
while (history.length > KEEP_HISTORY) history.shift();

const out = {
  updatedAt: new Date().toISOString(),
  asOfDate: asOf,
  rule: { pivot: 5, recentBars: 10, minRisePct: 20, minPullbackPct: 8, minMarketCapEok: MIN_MC_EOK, minTradingValue20Eok: MIN_TV20_EOK },
  scanned,
  matched,
  prevCodes: [...prevCodes],
  picks: top,
  history,
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`[hidden-divergence] ${asOf} raw=${scanned} matched=${matched} new=${fresh.length} top=${top.slice(0, 10).map((p) => p.name).join(", ")}`);
