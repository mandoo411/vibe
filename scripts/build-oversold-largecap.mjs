/**
 * 대형주 과매도 반등 (2026-10-19 신설) — 시우 요청으로 백테스트 후 메뉴화.
 *
 * 조건(백테스트와 동일): 시총 1조↑ · 20일 평균 거래대금 50억↑ · RSI(14) < 30 · 종가가 20일선보다 10% 넘게 아래.
 * 해당 종목을 RSI 낮은 순으로 최대 5개. 스팩·리츠·우선주 제외.
 * 근거: 2024-06~2026-10 근사 백테스트(다음 날 시가 매수, 비용 0.23% 차감) — 1건 평균 코스피 대비
 *   5일 보유 학습 +0.50%p / 검증(2026) +2.19%p, 20일 보유 +1.18%p / +3.62%p. 생존 편향·현재 상장주식수 기준 시총이라는 한계가 있다.
 *
 * 입력: data/kr-screener-cache.json (매 거래일 16:00 kr-screener-cache.yml이 만든다)
 * 출력: data/oversold-largecap.json — { asOfDate, picks[], history[] }
 *   history는 선정일별 기록. 기준가 = 선정일 종가. 이후 실행 때마다 거래일 수(age)를 하나씩 올리며
 *   5거래일째 종가(d5)·20거래일째 종가(d20)를 확정한다. 같은 asOfDate로 두 번 돌아도 age는 안 오른다.
 */
import fs from "node:fs";

const CACHE = "data/kr-screener-cache.json";
const OUT = "data/oversold-largecap.json";
const MIN_MC_EOK = 10000;
const MIN_TV20_EOK = 50;
const MAX_RSI = 30;
const MAX_GAP_MA20 = -10; // %
const TOP = 5;
const KEEP_HISTORY = 80;
const BAD_NAME = /스팩|리츠|\d우|우$|우B$|우C$/;

const r1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const asOf = cache.asOfDate;
if (!asOf) {
  console.error("cache has no asOfDate");
  process.exit(1);
}
const byCode = new Map((cache.stocks || []).map((s) => [s.code, s]));

const picks = [];
for (const s of cache.stocks || []) {
  const n = s.snapshot;
  if (!n || BAD_NAME.test(s.name || "")) continue;
  if (!(s.marketCapEok >= MIN_MC_EOK)) continue;
  const tv20 = n.next && n.next.avgVol20 && s.close ? (n.next.avgVol20 * s.close) / 1e8 : null;
  if (!(tv20 >= MIN_TV20_EOK)) continue;
  if (!(n.rsiCur < MAX_RSI)) continue;
  const gap = n.ma20Cur ? (s.close / n.ma20Cur - 1) * 100 : null;
  if (!(gap < MAX_GAP_MA20)) continue;
  picks.push({
    code: s.code,
    name: s.name,
    market: s.market,
    close: s.close,
    changePct: r1(s.changePct),
    rsi: r1(n.rsiCur),
    gapMa20: r1(gap),
    marketCapEok: Math.round(s.marketCapEok),
  });
}
picks.sort((a, b) => a.rsi - b.rsi);
const matched = picks.length;
const top = picks.slice(0, TOP);

let prev = { history: [] };
try {
  prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
} catch (_) {
  /* 첫 실행 */
}
const history = Array.isArray(prev.history) ? prev.history : [];

// 기존 기록의 경과 거래일·결과가 갱신
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
// 오늘 선정분 (같은 날 재실행이면 덮어쓴다)
const idx = history.findIndex((h) => h.date === asOf);
const entry = {
  date: asOf,
  source: "live",
  age: 0,
  lastSeen: asOf,
  matched,
  picks: top.map((p) => ({ code: p.code, name: p.name, base: p.close, rsi: p.rsi, gapMa20: p.gapMa20 })),
};
if (idx >= 0) history[idx] = entry;
else if (top.length) history.push(entry);
history.sort((a, b) => (a.date < b.date ? -1 : 1));
while (history.length > KEEP_HISTORY) history.shift();

const out = {
  updatedAt: new Date().toISOString(),
  asOfDate: asOf,
  rule: { minMarketCapEok: MIN_MC_EOK, minTradingValue20Eok: MIN_TV20_EOK, maxRsi: MAX_RSI, maxGapMa20Pct: MAX_GAP_MA20, top: TOP },
  matched,
  picks: top,
  history,
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`[oversold-largecap] ${asOf} matched=${matched} picks=${top.map((p) => p.name).join(", ")} history=${history.length}`);
