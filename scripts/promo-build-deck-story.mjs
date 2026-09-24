/**
 * 마감 카드뉴스 v3 "이슈 스토리" 문장 생성 (2026-09-24 신설)
 *
 * 왜 바꿨나: v2는 훅 유형을 숫자(거래대금 쏠림·수급)로만 골라서 2번 카드가 매일
 * "거래대금 1·2위 = 삼성전자·SK하이닉스", 4번 카드가 매일 "돈 몰린 업종"이었다.
 * 그날 마감 리포트에는 "이란이 호르무즈 재개방 제안 → 유가 하락 → 급등 출발" 같은
 * 원인 사슬이 다 적혀 있는데 카드에는 한 줄도 안 쓰였다.
 *
 * v3 구성: 1 훅(그날 사건을 질문으로) → 2·3 이슈 카드(사건→반응→결과 + 움직인 종목)
 *          → 4 급등 이유 → 5 수급 한 줄 + 다음에 볼 것 → 6 CTA
 *
 * 할루시네이션 방지(프로젝트 규칙):
 *  - 종목 등락률은 AI가 쓰지 않는다. AI는 종목 "이름"만 고르고, 코드가 시세 데이터에서
 *    찾아 붙인다. 못 찾으면 그 종목은 뺀다.
 *  - AI가 쓴 문장 속 숫자는 전부 분석 원문·시세 데이터에 실제로 있는 숫자여야 한다.
 *    없는 숫자가 나오면 그 항목을 버린다(훅이면 v3 전체를 포기하고 v2 덱으로 발행).
 */
import { callClaude, callOpenAI, parseJson } from "./promo-deck-ai.mjs";

const plain = (s) => String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/* ───────── 숫자 검증 ───────── */

/* 숫자 토큰 = 숫자 + 단위. 단위가 있으면 단위까지 같아야 통과한다
   (원문에 "3.5조"가 있다고 AI가 쓴 "3.5%"를 통과시키면 안 된다 — 테스트에서 실제로 새어 나갔다). */
const NUM_RE = /(\d[\d,]*(?:\.\d+)?)\s*(%|조|억|만|원|달러|포인트|p|배|대\s?1)?/g;
const keyOf = (n, u) => {
  const t = String(Number(String(n).replace(/,/g, "")));
  return `${t}|${u ? u.replace(/\s/g, "") : ""}`;
};

function numberSet(corpus) {
  const set = new Set();
  for (const m of String(corpus).matchAll(NUM_RE)) {
    set.add(keyOf(m[1], m[2]));
    set.add(keyOf(m[1], "")); // 단위 없이 쓴 경우는 숫자만 맞으면 허용
  }
  return set;
}

/** 문장 속 숫자가 전부 원문에 (같은 단위로) 있으면 true. 단위 없는 12 이하 정수(순서·개수)는 허용. */
export function numbersVerified(text, allowed) {
  for (const m of plain(text).replace(/[+\-▲▼]/g, " ").matchAll(NUM_RE)) {
    const [, n, u] = m;
    if (!u && /^\d+$/.test(n) && Number(n) <= 12) continue;
    if (allowed.has(keyOf(n, u))) continue;
    return false;
  }
  return true;
}

/* ───────── 종목 등락률 조회 ───────── */

function buildPriceBook(day) {
  const book = new Map();
  const put = (name, pct, market) => {
    if (!name || pct == null || book.has(name)) return;
    book.set(name, { pct, market: market || "" });
  };
  // 우선순위: 마감 리포트 특징주 → 리포트 본문에 적힌 등락률 → 시세 목록.
  // 시세 목록(topTradingValue 등)은 장 마감 뒤 재수집되며 시간외 가격이 섞여 리포트와 다를 수 있다
  // (9/23: 두산에너빌리티 리포트 -5.55% / 목록 -4.39%). 카드 문장은 리포트에서 나오므로 숫자도 리포트를 따른다.
  for (const s of day.featured_stocks || []) put(s.name, num(s.change), s.market);
  const text = String(day.analysis || "");
  for (const m of text.matchAll(/([가-힣A-Za-z0-9&]{2,20})\(([+-]\d+(?:\.\d+)?)%\)/g)) put(m[1], num(m[2]));
  for (const m of text.matchAll(/([가-힣A-Za-z0-9&]{2,20}?)(?:은|는|이|가)\s[^.\n]{0,45}?(\d+(?:\.\d+)?)%\s?(상승|하락|올|내|급등|급락)/g)) {
    const v = num(m[2]);
    if (v != null) put(m[1], /하락|내|급락/.test(m[3]) ? -v : v);
  }
  for (const list of [day.topGainers, day.topDecliners, day.topTradingValue]) {
    for (const r of list || []) put(r.name, num(r.change), r.market);
  }
  return book;
}

const fmtPct = (p) => `${p > 0 ? "▲" : p < 0 ? "▼" : ""}${Math.abs(p).toFixed(2)}%`;
const dirOf = (p) => (p > 0 ? "up" : p < 0 ? "down" : "flat");

/* ───────── 프롬프트 ───────── */

const SYSTEM = `너는 한국 증시 인스타그램 카드뉴스 편집자다.
독자는 "오늘 시장에 무슨 일이 있었고, 그래서 어느 종목이 왜 움직였는지"를 알고 싶어서 카드를 넘긴다.
숫자 나열은 실패다. 사건(뉴스) → 시장 반응 → 결과의 인과를 쉬운 말로 보여준다.
사라고 부추기지 않는다. 반드시 JSON 하나만 출력한다.`;

function buildPrompt({ f, analysis, featured, names, prevHooks }) {
  return `아래는 ${f.date} 한국 증시 마감 리포트 원문과 시세 데이터다. 이걸로 인스타그램 카드뉴스 문장을 쓴다.

# 마감 리포트 원문 (사실의 유일한 출처)
${String(analysis).slice(0, 7000)}

# 특징주 (리포트 작성자가 정리한 재료)
${featured.map((s) => `- ${s.name} ${s.change > 0 ? "+" : ""}${s.change}% · ${s.type || ""} · 재료: ${s.reason || ""}`).join("\n")}

# 카드에 칩으로 붙일 수 있는 종목 이름 (이 목록에 있는 이름만 stocks/movers에 쓸 것)
${names.join(", ")}

# 최근 훅 (이것과 같은 구조·같은 소재 금지)
${prevHooks.length ? prevHooks.map((h) => `- ${h}`).join("\n") : "- (없음)"}

# 카드 구성
1번 훅: 오늘 시장에서 가장 궁금한 "사건"이나 "반전"을 질문으로 던진다. 답은 2·3번 카드가 준다.
   예) "아침엔 +1.94%로 출발,<br>오후엔 마이너스까지.<br>코스피에 무슨 일이?"
   예) "코스피 7,000 탈환,<br>누가 끌어올렸을까?"
   예) "메타 신제품 하나에<br>국내 부품주가<br>들썩였습니다"
   나쁜 예) "오늘 증시의 돈 8조가 두 종목에 몰렸습니다" (매일 같은 얘기)
2·3번 이슈 카드: 오늘 시장을 움직인 서로 다른 원인 2개. 각각
   question = 독자가 궁금해할 질문형 제목, chain = 사건→반응→결과 3~4단계, stocks = 그 이슈로 움직인 종목 이름 1~3개.
   두 이슈는 원인이 달라야 한다(예: ① 해외 뉴스로 급등 출발 ② 연휴 부담으로 밀림). "삼성전자가 거래대금 1위" 같은 순위 나열은 이슈가 아니다.
4번 급등 이유: 상한가·급등 종목 2~3개와 "왜 올랐는지" 한 문장. 테마명 태그를 붙인다.
5번: 수급 한 줄 해석(누가 팔고 누가 받았나) + 다음 거래일 전에 확인할 것 3가지.

# 규칙
1. 숫자는 위 원문에 적힌 숫자만 그대로 쓴다. 계산하거나 반올림한 새 숫자 금지(코드가 검사해서 어기면 버린다).
2. 종목 등락률은 쓰지 마라(코드가 붙인다). 이름만 쓴다.
3. 어려운 용어는 쉬운 말로 푼다. "매수 추천", "수익", "무료" 금지. 상투구("귀추가 주목") 금지.
4. HTML은 <br> <b> <em>만. 훅·질문의 핵심어 1개만 <em>, chain/why/next의 핵심어는 <b>.
5. 훅(hookHTML)은 한 문장, <br>로 2~3줄, 공백 포함 40자 이내. 숫자는 많아야 1개.

# 출력 (JSON만)
{
  "hookTag": "빨간 배지 라벨, 12자 이내 (예: 연휴 전날의 롤러코스터)",
  "hookHTML": "...",
  "hookSub": "훅 아래 2줄, <br> 1개, 50자 이내. 답의 실마리만 준다",
  "issues": [
    {"kicker": "카드 머리 라벨 12자 이내 (예: 아침 급등의 이유)",
     "question": "질문형 제목, <br>로 2~3줄, 28자 이내",
     "chain": [{"label": "사건|반응|겹친 호재|부담|버팀목|배경 중 하나", "text": "45자 이내"}, {"label": "결과", "text": "마지막은 반드시 label=결과"}],
     "stocks": ["종목명"]},
    {"kicker": "", "question": "", "chain": [], "stocks": []}
  ],
  "moversTitle": "4번 카드 제목, <br>로 2줄, 18자 이내 (예: 상한가·급등,<br>왜 갔을까?)",
  "movers": [{"name": "종목명", "tag": "테마 6자 이내", "why": "왜 올랐나 한 문장, 60자 이내"}],
  "supplyNote": "수급 해석 한 문장, 60자 이내",
  "nextTitle": "5번 카드 소제목, 16자 이내 (예: 내일 장 전에 볼 3가지 / 연휴 동안 확인할 3가지)",
  "next": ["<b>변수</b> — 왜 중요한지, 40자 이내", "", ""],
  "captionLines": ["캡션 본문 3줄. 각 60~90자. 사건과 원인 중심", "", ""],
  "themeTags": ["그날 테마 해시태그 3~4개, # 없이"]
}`;
}

/* ───────── 메인 ───────── */

/**
 * @returns {Promise<object|null>} deck에 합칠 필드. 검증을 통과 못 하면 null (호출 측이 v2로 폴백)
 */
export async function buildStoryCopy(f, day, { prevHooks = [], writer } = {}) {
  const analysis = String(day.analysis || "");
  if (analysis.length < 800) {
    console.warn("[story] 마감 리포트 원문이 없거나 너무 짧아 v3를 건너뜁니다");
    return null;
  }
  const book = buildPriceBook(day);
  const featured = (day.featured_stocks || []).filter((s) => s && s.name);
  const names = [...book.keys()].slice(0, 80);

  // 숫자 검증용 말뭉치: 원문 + 특징주 재료 + 시세 수치
  const corpus = [
    analysis,
    ...featured.map((s) => `${s.reason || ""} ${s.point || ""} ${s.change}`),
    `${f.kospi.close} ${f.kospi.pct} ${f.kosdaq.close} ${f.kosdaq.pct} ${f.usdkrw ?? ""}`,
    JSON.stringify(day.investor_trend || {}),
  ].join("\n");
  const allowed = numberSet(corpus);

  const prompt = buildPrompt({ f, analysis, featured, names, prevHooks });
  let raw = null;
  const writers = writer
    ? [["test", writer]]
    : [["OpenAI", (s, p) => callOpenAI(s, p)], ["Claude", (s, p) => callClaude(s, p)]];
  for (const [label, fn] of writers) {
    try {
      const out = await fn(SYSTEM, prompt);
      raw = typeof out === "string" ? parseJson(out) : out;
      console.log(`[story] ${label} 문장 생성 완료`);
      break;
    } catch (e) {
      console.warn(`[story] ${label} 실패: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  if (!raw) return null;

  const bad = (where, text) => {
    const ok = numbersVerified(text, allowed);
    if (!ok) console.warn(`[story] 원문에 없는 숫자 → 버림 (${where}): ${plain(text).slice(0, 80)}`);
    return !ok;
  };
  const clip = (s, n) => (plain(s).length > n ? null : s);

  // 훅: 검증 실패면 v3 전체 포기
  const hookHTML = clip(raw.hookHTML, 44);
  if (!hookHTML || bad("hook", hookHTML) || bad("hookSub", raw.hookSub || "")) {
    console.warn("[story] 훅 검증 실패 — v2 덱으로 폴백");
    return null;
  }

  const chipOf = (name) => {
    const hit = book.get(String(name || "").trim());
    return hit && hit.pct != null ? { name, text: fmtPct(hit.pct), dir: dirOf(hit.pct), pct: hit.pct } : null;
  };

  const issues = (raw.issues || []).map((it, i) => {
    if (!it || !it.question || !Array.isArray(it.chain)) return null;
    if (!clip(it.question, 30) || bad(`issue${i + 1}.q`, it.question)) return null;
    const chain = it.chain
      .filter((s) => s && s.text && clip(s.text, 56) && !bad(`issue${i + 1}.chain`, s.text))
      .slice(0, 4);
    if (chain.length < 3 || chain[chain.length - 1].label !== "결과") {
      console.warn(`[story] 이슈 ${i + 1} 사슬이 3단계 미만이거나 결과로 안 끝남 → 버림`);
      return null;
    }
    const stocks = (it.stocks || []).map(chipOf).filter(Boolean).slice(0, 2);
    return { kicker: String(it.kicker || "").slice(0, 14), question: it.question, chain, stocks,
             source: "출처 · 당일 마감 리포트 · 한국투자증권 시세" };
  }).filter(Boolean).slice(0, 2);
  if (!issues.length) {
    console.warn("[story] 쓸 수 있는 이슈 카드가 없음 — v2 덱으로 폴백");
    return null;
  }

  const movers = (raw.movers || []).map((m) => {
    const c = chipOf(m?.name);
    if (!c || !m.why || !clip(m.why, 66) || bad(`mover ${m.name}`, m.why)) return null;
    const limitUp = c.pct >= 29.5 && c.pct <= 30.1; // 신규상장 첫날(최대 400%)은 상한가가 아니다
    return { name: c.name, tag: String(m.tag || "").slice(0, 7), why: m.why, dir: c.dir,
             pct: limitUp ? `${c.text} 상한가` : c.text };
  }).filter(Boolean).slice(0, 3);

  const next = (raw.next || []).filter((n) => n && clip(n, 48) && !bad("next", n)).slice(0, 3);
  const supplyNote = raw.supplyNote && clip(raw.supplyNote, 66) && !bad("supplyNote", raw.supplyNote)
    ? raw.supplyNote : "";

  // 소제목의 "3가지"는 실제로 살아남은 개수로 맞춘다(검증에서 빠지면 "3가지"인데 2개만 보인다)
  let nextTitle = plain(raw.nextTitle).slice(0, 18) || "다음 장 전에 볼 3가지";
  nextTitle = nextTitle.replace(/\d+\s?가지/, `${next.length}가지`);

  const out = {
    hookTag: plain(raw.hookTag).slice(0, 14),
    hookHTML,
    hookSub: raw.hookSub && clip(raw.hookSub, 56) ? raw.hookSub : "",
    issues,
    moversKicker: "오늘 급등주, 이유는 이것",
    moversTitle: raw.moversTitle && clip(raw.moversTitle, 20) ? raw.moversTitle : "상한가·급등,<br>왜 갔을까?",
    movers,
    supplyNote,
    nextTitle,
    next,
    captionLines: (raw.captionLines || []).filter((l) => l && numbersVerified(l, allowed)).slice(0, 3),
    themeTags: (raw.themeTags || []).map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean).slice(0, 4),
  };
  return withCommas(out);
}

/** "7153.99" → "7,153.99". 연도(1990~2100 정수 4자리)와 이미 쉼표가 있는 숫자는 건드리지 않는다. */
function commaNum(str) {
  return String(str).replace(/(?<![\d,.])(\d{4,})(\.\d+)?(?![\d,])/g, (m, int, dec = "") => {
    if (!dec && int.length === 4 && Number(int) >= 1990 && Number(int) <= 2100) return m;
    return Number(int).toLocaleString("en-US") + dec;
  });
}
function withCommas(v) {
  if (typeof v === "string") return commaNum(v);
  if (Array.isArray(v)) return v.map(withCommas);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = k === "text" && typeof x === "string" && /[▲▼]/.test(x) ? x : withCommas(x);
    return o;
  }
  return v;
}
