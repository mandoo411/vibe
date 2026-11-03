/**
 * 종가시그널 "다음 날 언제 파는 게 나은가" 연구 (2026-11-03, CRASH_BACKTEST.md 14장).
 *
 * 입력: Supabase Storage 비공개 버킷 research/minute/<결과일>.json (close-signal-minute.mjs가 매일 저장).
 * 출력: **집계 수치만** 로그로 찍는다. 저장소가 공개라 GHA 로그도 공개 — 원자료(분봉)는 절대 출력하지 않는다.
 *
 * 매수가 = 선정일 실제 종가(네이버 일봉, 없으면 15:20 스캔가). 비용 왕복 0.23%.
 * 학습 = 앞쪽 절반 거래일, 검증 = 뒤쪽 절반. 규칙은 학습에서 고르고 검증에서 그대로 확인한다.
 *
 * 필수 env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const COST = 0.23;
const H = { apikey: KEY, authorization: `Bearer ${KEY}` };

async function listFiles() {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/research`, {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ prefix: "minute/", limit: 1000, sortBy: { column: "name", order: "asc" } }),
  });
  if (!r.ok) throw new Error(`list HTTP ${r.status}`);
  return (await r.json()).map((x) => x.name).filter((n) => /\.json$/.test(n)).sort();
}
async function getFile(name) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/research/minute/${name}`, { headers: H });
  if (!r.ok) throw new Error(`get ${name} HTTP ${r.status}`);
  return r.json();
}
const dailyCache = new Map();
async function dailyCloses(code) {
  if (dailyCache.has(code)) return dailyCache.get(code);
  const m = new Map();
  try {
    const r = await fetch(`https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=20260901&endTime=20261231&timeframe=day`);
    const rows = JSON.parse((await r.text()).replace(/'/g, '"')).slice(1);
    for (const x of rows) {
      const d = String(x[0]).trim();
      if (d.length === 8 && x[4] > 0) m.set(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, { o: +x[1], h: +x[2], l: +x[3], c: +x[4] });
    }
  } catch {}
  dailyCache.set(code, m);
  return m;
}

const net = (sell, buy) => (sell / buy - 1) * 100 - COST;

// ---- 매도 규칙들: (bars, buy) => 매도가 ----
const priceAt = (bars, hhmm) => {
  let p = null;
  for (const b of bars) if (b[0] <= hhmm) p = b[4];
  return p;
};
const openP = (bars) => bars[0][1] || bars[0][4];
const lastP = (bars) => bars[bars.length - 1][4];
function tpSl(bars, buy, { tp = null, sl = null, until = "1530", base = "buy" }) {
  const o = openP(bars);
  const ref = base === "open" ? o : buy;
  const tpPx = tp != null ? ref * (1 + tp / 100) : null;
  const slPx = sl != null ? ref * (1 - sl / 100) : null;
  // 시가 자체가 목표/손절을 넘어 있으면 시가에 판다(기준이 매수가일 때만 해당)
  if (base === "buy") {
    if (tpPx != null && o >= tpPx) return o;
    if (slPx != null && o <= slPx) return o;
  }
  for (const b of bars) {
    if (b[0] > until) break;
    const [, bo, bh, bl] = b;
    // 같은 봉에서 둘 다 닿으면 손절 먼저(보수적)
    if (slPx != null && bl <= slPx) return Math.min(bo || slPx, slPx);
    if (tpPx != null && bh >= tpPx) return Math.max(bo || tpPx, tpPx);
  }
  return priceAt(bars, until) ?? lastP(bars);
}

const RULES = [
  ["시가 즉시", (b) => openP(b)],
  ...["0905", "0910", "0915", "0930", "1000", "1030", "1100", "1200", "1400"].map((t) => [`${t.slice(0, 2)}:${t.slice(2)} 매도`, (b) => priceAt(b, t)]),
  ["종가(15:30)", (b) => lastP(b)],
];
for (const tp of [1, 2, 3, 5]) for (const until of ["0930", "1000", "1530"])
  RULES.push([`매수가+${tp}% 익절, 아니면 ${until.slice(0, 2)}:${until.slice(2)}`, (b, buy) => tpSl(b, buy, { tp, until })]);
for (const sl of [2, 3, 5]) for (const until of ["0930", "1530"])
  RULES.push([`매수가-${sl}% 손절, 아니면 ${until.slice(0, 2)}:${until.slice(2)}`, (b, buy) => tpSl(b, buy, { sl, until })]);
for (const [tp, sl] of [[2, 2], [3, 2], [3, 3], [5, 3]]) for (const until of ["1000", "1530"])
  RULES.push([`+${tp}%/-${sl}% (매수가 기준), 아니면 ${until.slice(0, 2)}:${until.slice(2)}`, (b, buy) => tpSl(b, buy, { tp, sl, until })]);
for (const sl of [1, 2, 3]) RULES.push([`시가 대비 -${sl}% 손절, 아니면 종가`, (b, buy) => tpSl(b, buy, { sl, base: "open" })]);
for (const tp of [1, 2, 3]) RULES.push([`시가 대비 +${tp}% 익절, 아니면 종가`, (b, buy) => tpSl(b, buy, { tp, base: "open" })]);
// 갭 조건부: 시가가 매수가 위면 시가에 팔고, 아래면 기다린다
for (const until of ["0930", "1000", "1530"])
  RULES.push([`갭상승→시가 / 갭하락→${until.slice(0, 2)}:${until.slice(2)}`, (b, buy) => (openP(b) >= buy ? openP(b) : priceAt(b, until) ?? lastP(b))]);
for (const until of ["0930", "1000", "1530"])
  RULES.push([`갭상승→${until.slice(0, 2)}:${until.slice(2)} / 갭하락→시가`, (b, buy) => (openP(b) >= buy ? priceAt(b, until) ?? lastP(b) : openP(b))]);

function stats(trades, days) {
  if (!trades.length) return null;
  const v = trades.map((t) => t.r).sort((a, b) => a - b);
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  // 날짜별 동일비중 포트폴리오 → 복리
  const byDay = new Map();
  for (const t of trades) (byDay.get(t.day) || byDay.set(t.day, []).get(t.day)).push(t.r);
  let eq = 1, peak = 1, mdd = 0;
  for (const d of days) {
    const a = byDay.get(d);
    if (!a) continue;
    eq *= 1 + a.reduce((s, x) => s + x, 0) / a.length / 100;
    peak = Math.max(peak, eq);
    mdd = Math.min(mdd, eq / peak - 1);
  }
  return {
    n: v.length,
    mean,
    median: v[Math.floor(v.length / 2)],
    pos: (v.filter((x) => x > 0).length / v.length) * 100,
    worst: v[0],
    comp: (eq - 1) * 100,
    mdd: mdd * 100,
  };
}
const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? "  -  " : (x >= 0 ? "+" : "") + x.toFixed(d));

async function main() {
  if (!SUPABASE_URL || !KEY) throw new Error("env 없음");
  const files = await listFiles();
  const samples = []; // {day, group, bars, buy}
  let closeFix = 0, closeMiss = 0, barGap = [];
  for (const name of files) {
    const j = await getFile(name);
    for (const s of j.stocks || []) {
      if (!s.bars || s.bars.length < 30) continue;
      const bars = s.bars.filter((b) => b[0] >= "0900" && b[0] <= "1530");
      if (!bars.length || bars[0][0] > "0905") continue; // 장 초반 봉이 없으면 제외
      const d = await dailyCloses(s.code);
      const prev = d.get(j.asOfDate);
      const today = d.get(j.reviewDate);
      let buy = prev ? prev.c : s.buyPrice;
      if (prev) closeFix++; else closeMiss++;
      if (!buy) continue;
      if (today) barGap.push(Math.abs(lastP(bars) / today.c - 1) * 100);
      const group = s.kind === "swing" ? "swing" : s.rank <= 5 ? "top5" : "ext";
      samples.push({ day: j.reviewDate, group, shortlist: s.shortlist === true, rank: s.rank, bars, buy });
    }
  }
  const days = [...new Set(samples.map((s) => s.day))].sort();
  const half = Math.ceil(days.length / 2);
  const train = new Set(days.slice(0, half)), test = new Set(days.slice(half));
  console.log(`거래일 ${days.length} (${days[0]}~${days[days.length - 1]}) · 학습 ${days[0]}~${days[half - 1]} / 검증 ${days[half]}~${days[days.length - 1]}`);
  console.log(`표본: 상위5 ${samples.filter((s) => s.group === "top5").length} · 선별3 ${samples.filter((s) => s.shortlist).length} · 6~20위 ${samples.filter((s) => s.group === "ext").length} · 매수가=실제종가 ${closeFix} / 스캔가 대체 ${closeMiss}`);
  if (barGap.length) console.log(`분봉 마지막 값 vs 일봉 종가 차이 중앙값 ${barGap.sort((a, b) => a - b)[Math.floor(barGap.length / 2)].toFixed(3)}%`);

  const GROUPS = [
    ["상위5", (s) => s.group === "top5"],
    ["선별3", (s) => s.shortlist],
    ["상위5 중 선별 밖", (s) => s.group === "top5" && !s.shortlist],
    ["6~20위(참고)", (s) => s.group === "ext"],
  ];
  const out = {};
  for (const [gname, gf] of GROUPS) {
    const pool = samples.filter(gf);
    console.log(`\n=== ${gname} (n=${pool.length}) — 1회 평균(비용후)%, 중앙값, 플러스비율, 최악, 일별 동일비중 복리, MDD ===`);
    console.log(`규칙 | 전체 평균 | 학습 평균 | 검증 평균 | 중앙 | +비율 | 최악 | 복리(전체) | 복리 학습 | 복리 검증 | MDD`);
    const rows = [];
    for (const [rname, rf] of RULES) {
      const tr = pool.map((s) => ({ day: s.day, r: net(rf(s.bars, s.buy), s.buy) })).filter((t) => Number.isFinite(t.r));
      const all = stats(tr, days), a = stats(tr.filter((t) => train.has(t.day)), days), b = stats(tr.filter((t) => test.has(t.day)), days);
      if (!all) continue;
      rows.push({ rname, all, a, b });
    }
    for (const r of rows)
      console.log(`${r.rname} | ${f(r.all.mean)} | ${f(r.a && r.a.mean)} | ${f(r.b && r.b.mean)} | ${f(r.all.median)} | ${r.all.pos.toFixed(0)}% | ${f(r.all.worst, 1)} | ${f(r.all.comp, 1)} | ${f(r.a && r.a.comp, 1)} | ${f(r.b && r.b.comp, 1)} | ${f(r.all.mdd, 1)}`);
    // 학습 1등 규칙을 검증에서 확인
    const best = rows.filter((r) => r.a).sort((x, y) => y.a.mean - x.a.mean).slice(0, 5);
    const base = rows.find((r) => r.rname === "시가 즉시");
    console.log(`-- 학습 상위 5개 규칙의 검증 성적 (기준: 시가 즉시 학습 ${f(base.a && base.a.mean)} / 검증 ${f(base.b && base.b.mean)})`);
    for (const r of best) console.log(`   ${r.rname}: 학습 ${f(r.a.mean)} → 검증 ${f(r.b && r.b.mean)}`);
    out[gname] = rows.map((r) => ({ rule: r.rname, all: r.all, train: r.a, test: r.b }));
  }
  // 장 초반 경로: 시가 대비 분 단위 평균(상위5) — 언제 꺾이는지
  const top = samples.filter((s) => s.group === "top5");
  console.log(`\n=== 상위5 평균 경로: 매수가 대비 %(비용 전) ===`);
  for (const t of ["0901", "0903", "0905", "0910", "0915", "0920", "0930", "0945", "1000", "1030", "1100", "1200", "1300", "1400", "1500", "1530"]) {
    const v = top.map((s) => { const p = t === "0901" ? openP(s.bars) : priceAt(s.bars, t); return p ? (p / s.buy - 1) * 100 : null; }).filter((x) => x != null);
    const sorted = [...v].sort((a, b) => a - b);
    console.log(`  ${t === "0901" ? "시가 " : t.slice(0, 2) + ":" + t.slice(2)}  평균 ${f(v.reduce((a, b) => a + b, 0) / v.length)}  중앙 ${f(sorted[Math.floor(sorted.length / 2)])}`);
  }
  // 갭 크기별: 시가 즉시 vs 종가
  console.log(`\n=== 상위5 시가 갭 구간별: 시가 즉시 vs 09:30 vs 종가 (비용후 평균) ===`);
  const bins = [[-99, -2], [-2, 0], [0, 2], [2, 5], [5, 99]];
  for (const [lo, hi] of bins) {
    const p = top.filter((s) => { const g = (openP(s.bars) / s.buy - 1) * 100; return g >= lo && g < hi; });
    if (!p.length) continue;
    const m = (fn) => p.reduce((a, s) => a + net(fn(s), s.buy), 0) / p.length;
    console.log(`  갭 ${lo}~${hi}% n=${p.length}: 시가 ${f(m((s) => openP(s.bars)))} · 09:30 ${f(m((s) => priceAt(s.bars, "0930")))} · 종가 ${f(m((s) => lastP(s.bars)))}`);
  }
  console.log("\nJSON_SUMMARY " + JSON.stringify({ days: days.length, from: days[0], to: days[days.length - 1], groups: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.map((r) => ({ rule: r.rule, mean: +r.all.mean.toFixed(3), tr: r.train && +r.train.mean.toFixed(3), te: r.test && +r.test.mean.toFixed(3), comp: +r.all.comp.toFixed(2), n: r.all.n }))])) }));
}
main().catch((e) => { console.error(e); process.exit(1); });
