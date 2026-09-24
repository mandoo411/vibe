/**
 * 아침 브리핑 카드뉴스 v3 "이슈 스토리" (2026-09-24 신설)
 *
 * 마감 v3(promo-build-deck-story.mjs)와 같은 원칙:
 *  1 훅(간밤 사건을 질문으로) → 2·3 이슈 카드(간밤 사건 → 시장 반응 → 한국장 영향)
 *  → 4 오늘 한국장에서 볼 곳 → 5 환율·유가·선물 한 줄 + 장중 체크포인트 → 6 CTA
 *
 * 숫자 안전장치:
 *  - 지수·원자재·종목 칩의 등락률은 코드가 morning-briefing.json 실측값으로 붙인다.
 *  - AI 문장 속 숫자는 원문(아침 분석·뉴스)에 같은 단위로 있어야 한다.
 *  - 추가로, 문장에서 "나스닥 1%" 처럼 실측 지표 이름 바로 뒤에 붙은 %는 실측값과 맞아야 한다.
 *    (9/24 아침 분석 원문이 "나스닥 1%대 하락"이라고 썼지만 실측 나스닥100은 -0.04%였다.
 *     분석 원문이 틀릴 수 있으므로 원문 통과만으로는 부족하다.)
 */
import { callClaude, callOpenAI, parseJson } from "./promo-deck-ai.mjs";
import { numbersVerified, numberSet, withCommas } from "./promo-build-deck-story.mjs";

const plain = (s) => String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const n = (v) => {
  const x = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(x) ? x : null;
};
const fmtPct = (p) => `${p > 0 ? "▲" : p < 0 ? "▼" : ""}${Math.abs(p).toFixed(2)}%`;
const dirOf = (p) => (p > 0 ? "up" : p < 0 ? "down" : "flat");

const KO_TICKER = {
  AAPL: "애플", MSFT: "마이크로소프트", NVDA: "엔비디아", AMZN: "아마존", META: "메타",
  TSLA: "테슬라", GOOGL: "구글", GOOG: "구글", AMD: "AMD", PLTR: "팔란티어", AVGO: "브로드컴",
  NFLX: "넷플릭스", COIN: "코인베이스", MU: "마이크론", INTC: "인텔", ORCL: "오라클",
};

/** 칩으로 붙일 수 있는 실측 지표: 이름 → { pct, aliases } */
function buildEntities(m) {
  const ents = new Map();
  const add = (name, pct, aliases = []) => {
    const p = n(pct);
    if (!name || p == null || ents.has(name)) return;
    ents.set(name, { name, pct: p, aliases: [name, ...aliases] });
  };
  for (const i of m.usMarket?.indices || []) {
    const al = { nasdaq: ["나스닥100", "나스닥"], sp500: ["S&P500", "S&P 500"], dow: ["다우", "다우지수"] }[i.id] || [];
    add(/EWY|한국/.test(i.name || "") ? "한국 ETF(EWY)" : i.name, i.changePct, /EWY|한국/.test(i.name || "") ? ["EWY", "한국 ETF"] : al);
  }
  for (const c of m.forex?.commodities || []) {
    const al = { wti: ["WTI", "유가", "국제유가"] }[c.id] || (/반도체/.test(c.name) ? ["SOX", "필라델피아반도체지수", "필라 반도체"] : []);
    add(c.name, c.changePct, al);
  }
  for (const s of m.sectors || []) add(`${s.sector} 섹터`, s.changePct, [s.sector]);
  for (const s of m.topStocks || []) add(KO_TICKER[s.symbol] || s.symbol, s.changePct, [s.symbol]);
  const btc = (m.crypto?.assets || []).find((a) => a.symbol === "BTC");
  if (btc) add("비트코인", btc.changePct24h, ["BTC"]);
  return ents;
}

/** "나스닥 1%대 하락"처럼 실측 지표 이름 바로 뒤(12자 이내)의 %가 실측과 다르면 false */
function entityPctConsistent(text, ents) {
  const t = plain(text);
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
    const val = Number(m[1]);
    const before = t.slice(Math.max(0, m.index - 14), m.index);
    // 가장 가까이(뒤쪽에) 붙은 이름을 고르고, 같은 위치면 긴 이름을 고른다
    // ("나스닥 선물"을 "나스닥"으로, "국채금리"의 "금"을 금 시세로 오인하지 않도록 1글자 이름은 제외)
    let best = null;
    for (const e of ents.values()) {
      for (const a of e.aliases) {
        if (a.length < 2) continue;
        const pos = before.lastIndexOf(a);
        if (pos < 0) continue;
        const end = pos + a.length;
        if (!best || end > best.end || (end === best.end && a.length > best.len)) best = { e, end, len: a.length };
      }
    }
    if (best && Math.abs(val - Math.abs(best.e.pct)) > 0.06) return false;
  }
  return true;
}

const SYSTEM = `너는 한국 증시 인스타그램 아침 카드뉴스 편집자다.
독자는 장 열리기 전 5분 동안 "간밤에 무슨 일이 있었고, 그게 오늘 한국장에 무슨 뜻인지"를 알려고 카드를 넘긴다.
숫자 나열은 실패다. 사건 → 시장 반응 → 한국장 영향의 인과를 쉬운 말로 보여준다.
사라고 부추기지 않는다. 반드시 JSON 하나만 출력한다.`;

function buildPrompt({ ai, facts, entNames, news, prevHooks }) {
  return `아래는 오늘 아침 브리핑 원문(간밤 미국장 분석)과 실측 데이터다. 이걸로 인스타그램 아침 카드뉴스 문장을 쓴다.

# 실측 데이터 (지수·원자재 등락률은 이것이 정답이다. 원문과 다르면 이걸 믿는다)
${facts}

# 아침 브리핑 원문
${JSON.stringify({
    summary: ai.summary, keyIssues: ai.keyIssues, domesticImpact: ai.domesticImpact,
    usNews: ai.usNewsTable, krNews: ai.krNewsTable, positives: ai.usMarketPositives,
    negatives: ai.usMarketNegatives, watchSectors: ai.watchSectors, watchlist: ai.watchlist,
    checkpoints: ai.todayOutlook?.checkpoints,
  }, null, 1).slice(0, 7000)}

# 오늘 아침 뉴스 제목
${news.map((x) => `- ${x}`).join("\n")}

# 칩으로 붙일 수 있는 지표 이름 (issues[].stocks 에는 이 목록의 이름만)
${entNames.join(", ")}

# 최근 훅 (같은 구조·같은 소재 금지)
${prevHooks.length ? prevHooks.map((h) => `- ${h}`).join("\n") : "- (없음)"}

# 카드 구성
1번 훅: 간밤 가장 큰 사건을, 한국 투자자가 궁금해할 질문으로. 답은 2·3번 카드가 준다.
   좋은 예) "미 국채금리 5% 돌파,<br>오늘 코스피는<br>버틸 수 있을까?" / "간밤 엔비디아 급락,<br>삼성·하이닉스는?"
   나쁜 예) "간밤 미국 증시는 하락했습니다" (사건이 없다)
2·3번 이슈 카드: 간밤 서로 다른 사건 2개. chain = 사건 → 시장 반응 → (결과: 한국장에 어떤 뜻인지) 3~4단계.
   stocks = 그 사건으로 움직인 지표·종목 이름 1~2개(위 목록에서).
4번 오늘 볼 곳: 이 사건들로 오늘 한국장에서 주목받을 업종·종목 2~3개와 이유(watch).
5번: 환율·유가·선물 해석 한 줄(stripNote) + 오늘 장중 체크포인트 3개(next).

# 규칙
1. 숫자는 원문·실측에 적힌 숫자만 그대로. 지수·원자재 등락률을 쓸 거면 실측 데이터 값을 쓴다. 새 숫자·어림값 금지(코드가 검사해서 버린다).
2. "매수 추천", "수익", "무조건" 금지. 전망은 "~할 수 있다"로. 상투구 금지.
3. 어려운 용어는 쉬운 말로(예: 국채금리 → 미국 국채금리(나라 빚의 이자)).
4. HTML은 <br> <b> <em>만. 훅·질문 핵심어 1개만 <em>, 본문 핵심어는 <b>.
5. 훅(hookHTML)은 한 문장, <br>로 3줄, 한 줄은 공백 포함 11자 이내. 숫자는 많아야 1개.
6. chain 각 단계 25~40자, 누가·무엇을·얼마나가 들어간 구체적 문장. "미국 증시 하락" 같은 짧은 문장 금지.

# 출력 (JSON만)
{
  "hookTag": "빨간 배지 12자 이내",
  "hookHTML": "...",
  "hookSub": "훅 아래 2줄, <br> 1개, 50자 이내",
  "issues": [
    {"kicker": "12자 이내 (예: 간밤 1번 뉴스)", "question": "질문형 제목 <br>로 2~3줄 28자 이내, 사건명 포함",
     "chain": [{"label": "사건|반응|배경|겹친 악재|겹친 호재 중 하나", "text": "..."}, {"label": "결과", "text": "한국장에 어떤 뜻인지"}],
     "stocks": ["지표 이름"]},
    {"kicker": "", "question": "", "chain": [], "stocks": []}
  ],
  "watchTitle": "4번 제목 <br>로 2줄 18자 이내 (예: 오늘 한국장,<br>여기를 보세요)",
  "watch": [{"name": "업종 또는 종목", "tag": "6자 이내 이유 태그", "why": "왜 볼 만한가 한 문장 60자 이내"}],
  "stripNote": "환율·유가·선물 해석 한 문장 60자 이내",
  "nextTitle": "16자 이내 (예: 오늘 장중 체크포인트)",
  "next": ["<b>무엇</b> — 왜, 40자 이내", "", ""],
  "captionLines": ["캡션 3줄 60~90자", "", ""],
  "themeTags": ["테마 해시태그 3~4개, # 없이"]
}`;
}

export async function buildMorningStoryCopy(m, { prevHooks = [], writer } = {}) {
  const ai = m.aiAnalysis || {};
  if (!ai.summary && !(ai.keyIssues || []).length) {
    console.warn("[morning-story] 아침 분석 원문이 없어 v3를 건너뜁니다");
    return null;
  }
  const ents = buildEntities(m);
  const facts = [...ents.values()].map((e) => `- ${e.name} ${e.pct > 0 ? "+" : ""}${e.pct}%`).join("\n")
    + `\n- 원/달러 ${m.forex?.rates?.["USD/KRW"] ?? "-"}`;
  const news = (m.news || []).slice(0, 15).map((x) => x.title).filter(Boolean);
  const corpus = [JSON.stringify(ai), news.join("\n"), (m.news || []).map((x) => x.summary || "").join("\n"), facts].join("\n");
  const allowed = numberSet(corpus);

  const prompt = buildPrompt({ ai, facts, entNames: [...ents.keys()], news, prevHooks });
  let raw = null;
  const writers = writer ? [["test", writer]] : [["OpenAI", callOpenAI], ["Claude", callClaude]];
  for (const [label, fn] of writers) {
    try {
      const out = await fn(SYSTEM, prompt);
      raw = typeof out === "string" ? parseJson(out) : out;
      console.log(`[morning-story] ${label} 문장 생성 완료`);
      break;
    } catch (e) {
      console.warn(`[morning-story] ${label} 실패: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  if (!raw) return null;

  const bad = (where, text) => {
    const okNum = numbersVerified(text, allowed);
    const okEnt = entityPctConsistent(text, ents);
    if (!okNum || !okEnt) console.warn(`[morning-story] ${okNum ? "실측과 다른 등락률" : "원문에 없는 숫자"} → 버림 (${where}): ${plain(text).slice(0, 80)}`);
    return !(okNum && okEnt);
  };
  const clip = (s, len) => (plain(s).length > len ? null : s);

  const hookHTML = clip(raw.hookHTML, 44);
  if (!hookHTML || bad("hook", hookHTML) || bad("hookSub", raw.hookSub || "")) {
    console.warn("[morning-story] 훅 검증 실패 — v2 덱으로 폴백");
    return null;
  }
  const chipOf = (name) => {
    const key = String(name || "").trim();
    const e = ents.get(key) || [...ents.values()].find((x) => x.aliases.includes(key));
    return e ? { name: e.name, text: fmtPct(e.pct), dir: dirOf(e.pct) } : null;
  };

  const issues = (raw.issues || []).map((it, i) => {
    if (!it || !it.question || !Array.isArray(it.chain)) return null;
    if (!clip(it.question, 30) || bad(`issue${i + 1}.q`, it.question)) return null;
    const chain = it.chain
      .filter((s) => s && s.text && clip(s.text, 60) && !bad(`issue${i + 1}.chain`, s.text))
      .slice(0, 4)
      .map((s) => ({ label: String(s.label || "").slice(0, 6) || "배경", text: s.text }));
    if (chain.length < 2) {
      console.warn(`[morning-story] 이슈 ${i + 1} 남은 단계 ${chain.length}개 → 버림`);
      return null;
    }
    chain[chain.length - 1].label = "한국장 영향";
    const seen = new Set();
    const stocks = (it.stocks || []).map(chipOf).filter((c) => c && !seen.has(c.name) && seen.add(c.name)).slice(0, 2);
    return { kicker: String(it.kicker || "").slice(0, 14), question: it.question, chain, stocks,
             whoLabel: "간밤 움직인 지표", source: "출처 · 아침 브리핑 · 미국장 종가 데이터" };
  }).filter(Boolean).slice(0, 2);
  if (!issues.length) {
    console.warn("[morning-story] 쓸 수 있는 이슈 카드가 없음 — v2 덱으로 폴백");
    return null;
  }

  const movers = (raw.watch || []).filter((w) => w && w.name && w.why && clip(w.why, 66) && !bad(`watch ${w.name}`, w.why))
    .slice(0, 3).map((w) => ({ name: plain(w.name).slice(0, 14), tag: plain(w.tag).slice(0, 7), why: w.why, pct: "", dir: "flat" }));
  const next = (raw.next || []).filter((x) => x && clip(x, 48) && !bad("next", x)).slice(0, 3);
  let nextTitle = plain(raw.nextTitle).slice(0, 18) || "오늘 장중 체크포인트";
  nextTitle = nextTitle.replace(/\d+\s?가지/, `${next.length}가지`);

  // 5번 카드 상단 띠: 환율·유가·선물 (코드 실측)
  const strip = [];
  const krw = n(m.forex?.rates?.["USD/KRW"]);
  if (krw) strip.push({ who: "원/달러", amount: krw.toLocaleString("en-US", { maximumFractionDigits: 1 }), dir: "flat" });
  const wti = ents.get("WTI유가");
  if (wti) strip.push({ who: "WTI 유가", amount: fmtPct(wti.pct), dir: dirOf(wti.pct) });
  const fut = [...ents.values()].find((e) => /선물/.test(e.name));
  if (fut) strip.push({ who: "나스닥 선물", amount: fmtPct(fut.pct), dir: dirOf(fut.pct) });

  return withCommas({
    hookTag: plain(raw.hookTag).slice(0, 14),
    hookHTML,
    hookSub: raw.hookSub && clip(raw.hookSub, 56) ? raw.hookSub : "",
    issues,
    moversKicker: "간밤 이슈, 오늘 한국장은",
    moversTitle: raw.watchTitle && clip(raw.watchTitle, 20) ? raw.watchTitle : "오늘 한국장,<br>여기를 보세요",
    moversFoot: "관심 목록이지 매수 추천이 아닙니다 · 장중 흐름을 먼저 확인하세요",
    movers,
    nextKicker: "환율·유가·선물, 그리고 오늘 볼 것",
    strip,
    stripNote: raw.stripNote && clip(raw.stripNote, 66) && !bad("stripNote", raw.stripNote) ? raw.stripNote : "",
    nextTitle,
    next,
    captionLines: (raw.captionLines || []).filter((l) => l && numbersVerified(l, allowed) && entityPctConsistent(l, ents)).slice(0, 3),
    themeTags: (raw.themeTags || []).map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean).slice(0, 4),
  });
}
