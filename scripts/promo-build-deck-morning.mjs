/**
 * 카드뉴스 v2 — 아침 브리핑 덱 생성
 *
 * 마감시황(promo-build-deck.mjs)과 같은 원칙이다.
 *  · 숫자는 전부 코드가 계산하고, 문장만 AI가 쓴다(계산값을 프롬프트에 주입)
 *  · Claude → OpenAI → 코드 폴백 3단
 *  · 훅 유형을 데이터로 먼저 정하고, 그 답이 2번 카드(간밤 지수)에 오게 한다
 *
 * 사용: node scripts/promo-build-deck-morning.mjs --out=data/promo/latest-morning.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { firstSentence, callClaude, callOpenAI, composeCaption } from "./promo-deck-ai.mjs";

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const pctText = (p) => `${p > 0 ? "▲" : p < 0 ? "▼" : ""} ${Math.abs(num(p)).toFixed(2)}%`;
const dirOf = (p) => (num(p) > 0 ? "up" : num(p) < 0 ? "down" : "flat");
const fmt = (v, d = 2) => num(v).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
const plain = (s) => String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "");

/* ═════════════ 1) 실측값 ═════════════ */

export function computeMorningFacts(m) {
  const byId = new Map((m.usMarket?.indices || []).map((i) => [i.id, i]));
  const pick = (id) => {
    const x = byId.get(id);
    return x ? { name: x.name, close: num(x.close), pct: num(x.changePct) } : null;
  };
  const commodities = m.forex?.commodities || [];
  const com = (id) => {
    const c = commodities.find((x) => x.id === id || x.name === id);
    return c ? { name: c.name, price: num(c.price), pct: num(c.changePct) } : null;
  };

  const nasdaq = pick("nasdaq"), sp = pick("sp500"), dow = pick("dow");
  const majors = [nasdaq, sp, dow].filter(Boolean);
  const ewy = (m.usMarket?.indices || []).find((i) => /EWY|한국/.test(i.name || ""));
  const sox = com("필라델피아반도체") || com("sox");

  const sectors = (m.sectors || []).map((s) => ({ name: s.sector, pct: num(s.changePct) }))
    .sort((a, b) => b.pct - a.pct);
  const top = (m.topStocks || []).map((s) => ({ symbol: s.symbol, pct: num(s.changePct) }));
  const btc = (m.crypto?.assets || []).find((a) => a.symbol === "BTC");

  return {
    date: String(m.updatedAt || "").slice(0, 10),
    nasdaq, sp, dow,
    futures: pick("nasdaq_fut") || pick("nasdaqFut") ||
      (m.usMarket?.indices || []).map((i) => (/선물/.test(i.name) ? { name: i.name, close: num(i.close), pct: num(i.changePct) } : null)).find(Boolean),
    ewy: ewy ? { name: "한국 ETF(EWY)", close: num(ewy.close), pct: num(ewy.changePct) } : null,
    sox, gold: com("gold") || com("금"), wti: com("wti") || com("WTI유가"),
    majorsUp: majors.filter((x) => x.pct > 0).length,
    majorsAvg: majors.length ? majors.reduce((a, x) => a + x.pct, 0) / majors.length : 0,
    sectors, sectorBest: sectors[0] || null, sectorWorst: sectors[sectors.length - 1] || null,
    topStocks: top,
    btc: btc ? { price: num(btc.priceUsd), pct: num(btc.changePct24h) } : null,
    ai: m.aiAnalysis || {},
  };
}

/* ═════════════ 2) 훅 유형 (코드) ═════════════ */

export function pickMorningHookType(f) {
  // EWY형 — 한국 ETF가 크게 움직인 날. 국내 투자자에게 가장 직접적인 신호다.
  if (f.ewy && Math.abs(f.ewy.pct) >= 2) return "EWY";
  // 갈림형 — 지수와 반도체가 반대로 움직인 날
  if (f.sox && Math.abs(f.sox.pct) >= 1.5 && Math.sign(f.sox.pct) !== Math.sign(f.majorsAvg)) return "SPLIT";
  // 이례조합형 — 안전자산과 위험자산이 같이 오른 날
  if (f.gold && f.gold.pct >= 1 && f.majorsAvg > 0) return "SAFE";
  return "SYNC";
}

const HOOK_GUIDE = {
  EWY: `[EWY형] 미국에 상장된 한국 ETF가 크게 움직였다. 훅은 "간밤 미국 증시는 <방향>인데,
        한국 ETF만 <등락률> <방향>했습니다" 형태. 왜 그런지는 밝히지 않는다(2·3번 카드가 답한다).`,
  SPLIT: `[갈림형] 지수와 반도체가 반대로 움직였다. 훅은 "지수는 <방향>인데 반도체만 <등락률> <방향>했습니다" 형태.`,
  SAFE: `[이례조합형] 위험자산과 안전자산이 같이 올랐다. 훅은 "나스닥도 금도 같이 올랐습니다" 형태로
         이례적이라는 점을 짚는다.`,
  SYNC: `[동조형] 3대 지수가 같은 방향으로 움직였다. 훅은 그 원인 하나를 명사로 압축한다.`,
};

/* ═════════════ 3) 뼈대 ═════════════ */

export function buildMorningSkeleton(f) {
  const d = new Date(`${f.date}T00:00:00+09:00`);
  const dow = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");

  const KO = { AAPL: "애플", MSFT: "MS", NVDA: "엔비디아", AMZN: "아마존", META: "메타",
               TSLA: "테슬라", GOOGL: "알파벳", AMD: "AMD", PLTR: "팔란티어", COIN: "코인베이스" };

  const main = [f.nasdaq, f.sp, f.dow, f.ewy].filter(Boolean).map((x) => ({
    name: x.name, value: /EWY/.test(x.name) ? `$${fmt(x.close)}` : fmt(x.close),
    pct: pctText(x.pct), dir: dirOf(x.pct),
  }));

  // 훅에서 EWY를 던졌으면 2번 카드에서 EWY가 눈에 띄어야 한다 — 칩에도 같이 올린다
  const chips = [];
  if (f.ewy) chips.push({ name: "한국 ETF", text: pctText(f.ewy.pct), dir: dirOf(f.ewy.pct) });
  if (f.sox) chips.push({ name: "필라 반도체", text: pctText(f.sox.pct), dir: dirOf(f.sox.pct) });
  if (f.nasdaq) chips.push({ name: "나스닥100", text: pctText(f.nasdaq.pct), dir: dirOf(f.nasdaq.pct) });

  return {
    slot: "morning", layout: "morning", date: f.date,
    slotLabel: "아침 브리핑",
    dateLabel: `${mm}.${dd} (${dow})`,
    dateFull: `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`,
    indexChips: chips.slice(0, 3),
    idxMain: main.slice(0, 4),
    idxSub: f.futures ? [{ name: f.futures.name, value: fmt(f.futures.close), pct: pctText(f.futures.pct), dir: dirOf(f.futures.pct) }] : [],
    btTitle: "간밤 미국 대형주",
    bigTech: f.topStocks.slice(0, 4).map((s) => ({ name: KO[s.symbol] || s.symbol, pct: pctText(s.pct), dir: dirOf(s.pct) })),
    watchSectors: (f.ai.watchSectors || []).slice(0, 5),
    ctaTitle: `장 열리기 전<br><em>3분</em>이면 끝납니다.`,
    ctaSub: "매일 아침 8시, 간밤 미국장과 오늘 볼 것만 추려서 올립니다.",
    ctaReasons: [
      "지수 숫자만 나열하지 않습니다. <b>오늘 코스피를 어떻게 볼지</b>까지 씁니다.",
      "“오른다”가 아니라 <b>무엇을 확인해야 하는지</b>를 알려줍니다.",
      "실시간 시세 데이터만 씁니다. <b>추정치는 넣지 않습니다.</b>",
    ],
    saveNudge: "<b>저장</b>해두고 9시 장 열릴 때 한 번 더 보세요.<br>어디를 볼지 정하고 시작하는 것과 아닌 것은 다릅니다.",
  };
}

/* ═════════════ 4) 프롬프트 ═════════════ */

const SYSTEM = `너는 한국 주식시장 카드뉴스의 카피라이터다.
독자는 장 열리기 전 5분 동안 이 카드를 넘기는 국내 개인투자자다.
"간밤에 무슨 일이 있었고, 오늘 무엇을 봐야 하는가"만 알려준다.
사라고 부추기지 않고, 확인해야 할 것을 말한다. 반드시 JSON 하나만 출력한다.`;

function buildPrompt(f, hookType) {
  const s = (x) => (x ? `${x.name} ${fmt(x.close ?? x.price)} (${x.pct > 0 ? "+" : ""}${x.pct}%)` : "-");
  return `아래는 ${f.date} 아침 기준 간밤 미국 시장 데이터와 그날 작성된 분석이다.
인스타그램 카드뉴스(5장) 문장을 쓴다.

# 코드가 계산해 둔 실측값 (이 숫자만 쓸 것. 새 숫자를 만들지 말 것)
- ${s(f.nasdaq)} / ${s(f.sp)} / ${s(f.dow)}
- ${s(f.ewy)} · ${s(f.sox)}
- 나스닥 선물 ${f.futures ? `${fmt(f.futures.close)} (${f.futures.pct > 0 ? "+" : ""}${f.futures.pct}%)` : "-"}
- 금 ${f.gold ? `${f.gold.pct > 0 ? "+" : ""}${f.gold.pct}%` : "-"} · WTI ${f.wti ? `${f.wti.pct > 0 ? "+" : ""}${f.wti.pct}%` : "-"} · 비트코인 ${f.btc ? `$${f.btc.price.toLocaleString()} (${f.btc.pct > 0 ? "+" : ""}${f.btc.pct}%)` : "-"}
- 섹터 최강 ${f.sectorBest?.name} ${f.sectorBest?.pct}% / 최약 ${f.sectorWorst?.name} ${f.sectorWorst?.pct}%
- 대형주: ${f.topStocks.map((t) => `${t.symbol} ${t.pct > 0 ? "+" : ""}${t.pct}%`).join(", ")}
- 3대 지수 중 ${f.majorsUp}개 상승

# 그날 분석
핵심 이슈: ${(f.ai.keyIssues || []).join(" / ")}
국내 영향: ${String(f.ai.domesticImpact || "").slice(0, 700)}
오늘 시나리오: ${String(f.ai.todayOutlook?.scenario || "").slice(0, 700)}
요약: ${String(f.ai.summary || "").slice(0, 900)}

# 훅 유형 (코드가 데이터로 정했다. 반드시 이 유형으로 쓸 것)
${HOOK_GUIDE[hookType]}

# 규칙
1. **훅에서 던진 질문의 답은 2·3번 카드에 있다.** 1번 카드는 사실 하나만 크게 던진다.
2. 숫자는 위 실측값에서만 가져온다. 추정치·어림값 금지.
3. 훅(hookHTML)은 **한 문장**이다. 두 문장을 붙이면 훅이 죽는다.
4. verdictHTML은 요약이 아니라 **오늘 장을 어떻게 볼지에 대한 규정**이다.
   "상승 출발이 예상됩니다" 같은 서술 말고 "갭업은 열리되 지켜내는지가 관건이다" 처럼 말한다.
5. watchRows는 오늘 **확인할 것** 3개다. 매수·매도 권유 금지. 그중 가장 위험한 항목 하나만 hot:true.
6. 문장은 40~70자, 90자 상한. 상투구 금지. "무료"라는 단어 금지.
7. HTML은 <br> <b> <em> <span>만 쓴다.

# 좋은 예 / 나쁜 예
- hookHTML O: "간밤 미국 증시는 밀렸는데<br><em>한국 ETF만</em><br>4.6% 올랐습니다"
            X: "간밤 미국 증시가 하락했습니다. 하지만 한국 ETF는 상승했습니다" (두 문장)
- hookSub  O: "오늘 코스피가 어디서 출발할지,<br>답은 이 안에 있습니다."
            X: "궁금하시죠? 다음 카드에서 확인하세요" (낚시 말투 금지)
- verdictHTML O: "오늘은<br><em>갭업을 지켜내는지</em>가 관건이다."
              X: "오늘 코스피는 상승 출발이 예상됩니다" (규정이 아니라 예보)

# 출력 (JSON만)
{
  "hookTag": "빨간 배지 라벨. 12자 이내",
  "hookHTML": "1번 카드 대제목. <br>로 3~4줄, 핵심은 <em>. 40자 이내",
  "hookSub": "보조 2줄. <br> 1개. 60자 이내",
  "idxTitle": "2번 카드 제목. <br>로 2줄. 20자 이내",
  "idxComment": "2번 카드 하단 한 문장. 지수 흐름의 성격. 70자 이내",
  "verdictHTML": "3번 카드. 오늘 장을 한 문장으로 규정. <br>로 2줄, 핵심구는 <em>. 30자 이내",
  "verdictWhy": ["근거 3개. 각 55~80자. <b>로 수치 강조", "", ""],
  "watchTitle": "4번 카드 제목. <br>로 2줄. 20자 이내",
  "watchRows": [
    {"title":"확인할 것 1", "desc":"왜 봐야 하는지. <b> 사용. 80자 이내", "hot":false},
    {"title":"확인할 것 2", "desc":"", "hot":true},
    {"title":"확인할 것 3", "desc":"", "hot":false}
  ],
  "captionLines": ["캡션 본문 3줄. 각 60~90자", "", ""],
  "themeTags": ["그날 테마 해시태그 3~4개. # 없이"]
}`;
}

/* ═════════════ 5) 폴백 ═════════════ */

function fallbackCopy(f) {
  const up = f.majorsAvg > 0;
  return {
    hookTag: "간밤 미국장",
    hookHTML: f.ewy
      ? `간밤 한국 ETF가<br><em>${pctText(f.ewy.pct)}</em><br>${f.ewy.pct > 0 ? "올랐" : "내렸"}습니다`
      : `간밤 미국 3대 지수가<br><em>${up ? "올랐" : "내렸"}습니다</em>`,
    hookSub: `오늘 코스피가 어디서 출발할지,<br>답은 이 안에 있습니다.`,
    idxTitle: `간밤 미국 지수<br>마감 현황`,
    idxComment: `3대 지수 중 ${f.majorsUp}개가 상승 마감했고, 섹터는 ${f.sectorBest?.name}이 가장 강했습니다.`,
    verdictHTML: `오늘은<br><em>${up ? "갭업을 지켜내는지" : "낙폭을 줄이는지"}</em>가 관건이다.`,
    verdictWhy: [
      `나스닥100 ${f.nasdaq ? `${f.nasdaq.pct > 0 ? "+" : ""}${f.nasdaq.pct}%` : "-"}, S&P500 ${f.sp ? `${f.sp.pct > 0 ? "+" : ""}${f.sp.pct}%` : "-"}, 다우 ${f.dow ? `${f.dow.pct > 0 ? "+" : ""}${f.dow.pct}%` : "-"}로 마감했다.`,
      f.sox ? `필라델피아반도체는 <b>${f.sox.pct > 0 ? "+" : ""}${f.sox.pct}%</b>, 한국 ETF는 <b>${f.ewy ? `${f.ewy.pct > 0 ? "+" : ""}${f.ewy.pct}%` : "-"}</b>였다.` : "",
      `섹터는 <b>${f.sectorBest?.name} ${f.sectorBest?.pct}%</b>가 가장 강했고 <b>${f.sectorWorst?.name} ${f.sectorWorst?.pct}%</b>가 가장 약했다.`,
    ].filter(Boolean),
    watchTitle: `오늘 이것만<br>확인하면 됩니다`,
    watchRows: [
      { title: "시가 이후 흐름", desc: `간밤 지표가 시가에 반영된 뒤 <b>그 수준을 지켜내는지</b>가 관건입니다.` },
      { title: "반도체 동조 여부", hot: true, desc: `필라델피아반도체 <b>${f.sox ? `${f.sox.pct > 0 ? "+" : ""}${f.sox.pct}%` : "-"}</b>가 국내 반도체로 이어지는지 확인이 필요합니다.` },
      { title: "환율과 원자재", desc: `금 <b>${f.gold ? `${f.gold.pct > 0 ? "+" : ""}${f.gold.pct}%` : "-"}</b>, WTI <b>${f.wti ? `${f.wti.pct > 0 ? "+" : ""}${f.wti.pct}%` : "-"}</b> 흐름이 업종별로 다르게 작용합니다.` },
    ],
    captionLines: [
      `나스닥100 ${f.nasdaq ? `${f.nasdaq.pct > 0 ? "+" : ""}${f.nasdaq.pct}%` : "-"}, S&P500 ${f.sp ? `${f.sp.pct > 0 ? "+" : ""}${f.sp.pct}%` : "-"}, 다우 ${f.dow ? `${f.dow.pct > 0 ? "+" : ""}${f.dow.pct}%` : "-"}로 마감했습니다`,
      f.ewy ? `한국 ETF(EWY)는 ${f.ewy.pct > 0 ? "+" : ""}${f.ewy.pct}%, 필라델피아반도체는 ${f.sox ? `${f.sox.pct > 0 ? "+" : ""}${f.sox.pct}%` : "-"}였습니다` : "",
      `오늘 확인할 것 3가지는 카드 4번에 정리했습니다`,
    ].filter(Boolean),
    themeTags: ["아침브리핑", "미국증시", "나스닥"],
  };
}

/* ═════════════ 6) 조립 ═════════════ */

const LIMITS = { hookHTML: 46, hookSub: 70, idxTitle: 26, idxComment: 78,
                 verdictHTML: 36, watchTitle: 26 };

function clampCopy(copy, f) {
  copy.hookHTML = firstSentence(copy.hookHTML);
  if (plain(copy.hookHTML).length > LIMITS.hookHTML) {
    console.warn(`[morning] 훅이 ${plain(copy.hookHTML).length}자 — 폴백 훅으로 교체`);
    copy.hookHTML = fallbackCopy(f).hookHTML;
  }
  for (const [k, max] of Object.entries(LIMITS)) {
    if (k === "hookHTML" || !copy[k]) continue;
    if (plain(copy[k]).length > max) {
      copy[k] = firstSentence(copy[k]);
      if (plain(copy[k]).length > max) copy[k] = plain(copy[k]).slice(0, max).trim();
      console.warn(`[morning] ${k} 길이 초과 → 잘라냄`);
    }
  }
  copy.verdictWhy = (copy.verdictWhy || []).filter(Boolean).slice(0, 3);
  copy.watchRows = (copy.watchRows || []).filter((x) => x && x.title).slice(0, 3);
  // hot은 하나만 — 전부 강조하면 아무것도 강조되지 않는다
  let hotSeen = false;
  copy.watchRows = copy.watchRows.map((r) => {
    if (r.hot && !hotSeen) { hotSeen = true; return r; }
    return { ...r, hot: false };
  });
  return copy;
}

export async function buildMorningDeck(path = "data/morning-briefing.json") {
  const m = JSON.parse(readFileSync(path, "utf8"));
  const f = computeMorningFacts(m);
  if (!f.nasdaq && !f.sp && !f.dow) throw new Error("간밤 지수 데이터가 없습니다");

  const hookType = pickMorningHookType(f);
  const deck = buildMorningSkeleton(f);
  deck.hookType = hookType;

  const prompt = buildPrompt(f, hookType);
  let copy = null;
  for (const [label, fn] of [["Claude", callClaude], ["OpenAI", callOpenAI]]) {
    try {
      copy = await fn(SYSTEM, prompt);
      console.log(`[morning] ${label} 문장 생성 완료 (훅 유형 ${hookType})`);
      break;
    } catch (e) {
      console.warn(`[morning] ${label} 실패: ${String(e.message).slice(0, 200)}`);
    }
  }
  if (!copy) {
    console.warn("[morning] AI 두 곳 모두 실패 — 코드 폴백 덱으로 발행합니다");
    copy = fallbackCopy(f);
  }
  copy = clampCopy(copy, f);

  Object.assign(deck, {
    hookTag: copy.hookTag, hookHTML: copy.hookHTML, hookSub: copy.hookSub,
    idxTitle: copy.idxTitle, idxComment: copy.idxComment,
    verdictHTML: copy.verdictHTML, verdictWhy: copy.verdictWhy,
    watchTitle: copy.watchTitle, watchRows: copy.watchRows,
  });
  deck.caption = composeCaption({
    hook: copy.hookHTML, sub: copy.hookSub, lines: copy.captionLines,
    themeTags: copy.themeTags,
    saveLine: "🔖 저장해두고 9시 장 열릴 때 한 번 더 보세요.",
    ctaLine: "매일 아침 8시, AI가 정리한 장전 브리핑을 올립니다 → @totalmoney_ai",
    extraTags: ["미국주식", "나스닥", "아침브리핑", "증시브리핑"],
  });
  return deck;
}

/* ── CLI ── */
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => {
    const h = process.argv.find((a) => a.startsWith(`--${n}=`));
    return h ? h.split("=").slice(1).join("=") : d;
  };
  const deck = await buildMorningDeck();
  const out = arg("out", `data/promo/morning-${deck.date}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(deck, null, 2), "utf8");
  console.log(`[morning] ${deck.date} · 훅유형 ${deck.hookType} → ${out}`);
  console.log(`[morning] 훅: ${plain(deck.hookHTML)}`);
}
