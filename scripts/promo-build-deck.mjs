/**
 * 카드뉴스 v2 — 덱(deck) 자동 생성
 *
 * 역할 분담이 이 파일의 전부다.
 *  · 숫자는 전부 코드가 계산한다 (거래대금·비중·수급·지수·등락률). AI에게 숫자를 만들게 하지 않는다.
 *  · 문장만 Claude가 쓴다. 그때도 위에서 계산한 실측값을 프롬프트에 통째로 넣어서
 *    "화면 도표와 본문 문장이 어긋나는" 사고를 막는다.
 *  · Claude가 실패하면 코드가 만든 최소 덱으로 폴백해서 발행 자체는 멈추지 않는다.
 *
 * 훅 규칙: 1번 카드가 던진 질문의 답은 반드시 2번 카드에 있어야 한다.
 * 그래서 훅 유형을 코드가 데이터로 먼저 정하고(A/D/E/C), 그 유형에 맞는 2번 카드를 고른다.
 *
 * 사용:
 *   node scripts/promo-build-deck.mjs --slot=closing --out=data/promo/closing-<date>.json
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/* ═════════════════ 숫자 유틸 ═════════════════ */

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** 1234567890000 → "1.23조" / 79791500000 → "798억" (한국식 표기) */
export function won(raw) {
  const n = Math.abs(num(raw));
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}조`;
  if (n >= 1e8) return `${Math.round(n / 1e8).toLocaleString("ko-KR")}억`;
  return `${Math.round(n).toLocaleString("ko-KR")}원`;
}

/** 8250000000000 → "8조 2,500억" (훅에 쓰는 긴 표기) */
export function wonLong(raw) {
  const n = Math.abs(num(raw));
  const jo = Math.floor(n / 1e12);
  const eok = Math.round((n - jo * 1e12) / 1e8);
  if (jo > 0 && eok > 0) return `${jo}조 ${eok.toLocaleString("ko-KR")}억`;
  if (jo > 0) return `${jo}조`;
  return `${eok.toLocaleString("ko-KR")}억`;
}

const pctText = (p) => `${p > 0 ? "▲" : p < 0 ? "▼" : ""} ${Math.abs(num(p)).toFixed(2)}%`;
const dirOf = (p) => (num(p) > 0 ? "up" : num(p) < 0 ? "down" : "flat");
const esc = (s) => String(s ?? "").replace(/[<>]/g, "");

/** 문장을 maxLen 근처에서 자연스럽게 끊는다(문장부호 우선). */
function trim(text, maxLen) {
  const t = String(text ?? "").trim().replace(/\s+/g, " ");
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen);
  const at = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("다 "), cut.lastIndexOf(", "));
  return (at > maxLen * 0.55 ? cut.slice(0, at + 1) : cut).trim().replace(/[,·]$/, "") + (t.length > maxLen ? "" : "");
}

/* ═════════════════ 1) 코드가 계산하는 실측값 ═════════════════ */

/**
 * 마감시황 스냅샷에서 카드에 쓸 숫자를 전부 뽑는다.
 * 여기서 나온 값만 화면에 찍히고, AI에게도 이 값들만 준다.
 */
export function computeClosingFacts(day) {
  const idx = day.indexes || {};
  const tv = (day.topTradingValue || []).map((r) => ({
    name: r.name, market: r.market, code: r.code,
    raw: num(r.tradingValueRaw), pct: num(r.change),
  })).filter((r) => r.raw > 0);

  const totalTv = tv.reduce((a, r) => a + r.raw, 0);
  const top2 = tv.slice(0, 2);
  const top2Sum = top2.reduce((a, r) => a + r.raw, 0);
  const top2Share = totalTv > 0 ? (top2Sum / totalTv) * 100 : 0;
  const third = tv[2] || null;

  const it = day.investor_trend || {};
  const kospiFlow = it.kospi || {};
  // "+1조6,691억(순매수)" 같은 문자열에서 부호와 금액을 읽는다.
  const parseFlow = (s) => {
    const str = String(s ?? "");
    if (!str) return null;
    const sign = str.trim().startsWith("-") || str.includes("순매도") ? -1 : 1;
    const jo = num((str.match(/(-?[\d,.]+)\s*조/) || [])[1]);
    const eok = num((str.match(/([\d,]+)\s*억/) || [])[1]);
    const amount = Math.abs(jo) * 1e12 + Math.abs(eok) * 1e8;
    return { text: str.replace(/\(.*?\)/, "").trim(), amount, sign,
             label: sign > 0 ? "순매수" : "순매도", dir: sign > 0 ? "up" : "down" };
  };

  // featured_stocks에는 market 필드가 없다. 같은 종목코드를 랭킹 목록에서 찾아 시장을 채운다
  // (없이 두면 코스닥 종목이 전부 '코스피'로 찍힌다 — 스카이랩스가 그랬다).
  const marketByCode = new Map();
  for (const list of [day.topTradingValue, day.topGainers, day.topDecliners]) {
    for (const r of list || []) if (r?.code && r?.market) marketByCode.set(String(r.code), r.market);
  }
  const featured = (day.featured_stocks || []).filter((f) => f && f.name)
    .map((f) => ({ ...f, market: f.market || marketByCode.get(String(f.code)) || "" }));
  const surges = featured.filter((f) => f.type === "급등");

  return {
    date: day.date,
    kospi: { close: num(idx.kospi?.close), pct: num(idx.kospi?.changePercent) },
    kosdaq: { close: num(idx.kosdaq?.close), pct: num(idx.kosdaq?.changePercent) },
    usdkrw: idx.usdkrw?.rate ? num(idx.usdkrw.rate) : null,
    usdkrwNote: idx.usdkrw?.note || "",
    marketTone: day.marketTone || "",
    tv, totalTv, top2, top2Sum, top2Share, third,
    flows: {
      foreign: parseFlow(kospiFlow.foreign),
      institution: parseFlow(kospiFlow.institution),
      individual: parseFlow(kospiFlow.individual),
    },
    featured, surges,
  };
}

/* ═════════════════ 2) 훅 유형 판정 (코드) ═════════════════ */

/**
 * 훅은 감으로 쓰면 매일 무너지므로 유형을 데이터로 먼저 고른다.
 * 각 유형은 2번 카드(답)와 짝이 맞아야 한다 — 답 없는 훅은 낚시다.
 */
export function pickHookType(f) {
  // A 쏠림형 — 거래대금 상위 2종목이 전체의 절반 가까이를 차지한 날
  if (f.top2Share >= 45 && f.top2.length === 2) return "A";

  // D 불일치형 — 지수는 올랐는데 개인이 대규모로 판 날(또는 반대)
  const ind = f.flows.individual;
  if (ind && ind.amount >= 1e12 && Math.sign(f.kospi.pct) === -ind.sign) return "D";

  // E 경고형 — 급등 종목이 3개 이상 몰린 날(테마 과열)
  if (f.surges.length >= 3) return "E";

  // C 범인지목형 — 위 조건이 없으면 원인 하나를 지목하는 기본형
  return "C";
}

/* ═════════════════ 3) 코드가 채우는 덱 뼈대 ═════════════════ */

export function buildDeckSkeleton(f, slotLabel = "마감 시황") {
  const d = new Date(`${f.date}T00:00:00+09:00`);
  const dow = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");

  const deck = {
    slot: "closing", layout: "closing", date: f.date,
    slotLabel,
    dateLabel: `${mm}.${dd} (${dow})`,
    dateFull: `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`,

    // 1번 카드 하단 칩 = 훅의 답을 첫 장에서 이미 보여준다
    indexChips: f.top2.map((r) => ({ name: r.name, text: won(r.raw), dir: "up" })),

    // 2번 카드 (쏠림 공개)
    focusPair: f.top2.map((r, i) => ({
      rank: i + 1, market: r.market === "KOSDAQ" ? "코스닥" : "코스피",
      name: r.name, amount: won(r.raw), pct: pctText(r.pct),
    })),
    shareLabel: `거래대금 상위 ${f.tv.length}종목 ${won(f.totalTv)} 중`,
    sharePct: `${f.top2Share.toFixed(1)}%`,
    shareWidth: Math.round(f.top2Share * 10) / 10,
    shareA: won(f.top2Sum),
    shareB: `${f.tv.length - 2}종목 ${won(f.totalTv - f.top2Sum)}`,
    focusIndexes: [
      { name: "코스피", value: f.kospi.close.toLocaleString("ko-KR", { minimumFractionDigits: 2 }), pct: pctText(f.kospi.pct), dir: dirOf(f.kospi.pct) },
      { name: "코스닥", value: f.kosdaq.close.toLocaleString("ko-KR", { minimumFractionDigits: 2 }), pct: pctText(f.kosdaq.pct), dir: dirOf(f.kosdaq.pct) },
    ],

    // 4번 카드 하단 수급
    supplyTitle: "투자자별 매매동향 · 코스피",
    supply: ["foreign", "institution", "individual"].map((k) => {
      const v = f.flows[k];
      if (!v) return null;
      return { who: { foreign: "외국인", institution: "기관", individual: "개인" }[k],
               amount: v.text, label: v.label, dir: v.dir };
    }).filter(Boolean),

    // 5번 카드 특징주 — 문장은 리포트가 이미 써 둔 것을 길이만 다듬어 쓴다
    stocks: f.featured.slice(0, 2).map((s) => ({
      market: s.market ? (String(s.market).includes("KOSDAQ") ? "코스닥" : "코스피") : "",
      name: s.name, pct: pctText(num(s.change)), dir: dirOf(num(s.change)),
      reason: trim(esc(s.reason), 80),
      risk: trim(esc(s.risk), 95),
    })),

    // 6번 카드 CTA — 고정 문구
    ctaTitle: "숫자는 어디에나 있습니다.<br><em>판단</em>은 여기에 있습니다.",
    ctaSub: "매일 오후 5시, 장이 끝나면 AI가 오늘 시장을 한 문장으로 정리해 올립니다.",
    ctaReasons: [
      "코스피 몇 포인트가 아니라 <b>“오늘 시장이 왜 그랬는지”</b>를 먼저 말합니다.",
      "급등 이유와 함께 <b>리스크</b>까지 같이 씁니다. 사라고 말하지 않습니다.",
      "한국투자증권 시세 + DART 공시 <b>실데이터</b>만 씁니다. 추정치는 넣지 않습니다.",
    ],
    saveNudge: "<b>저장</b>해두고 내일 아침 장 열기 전에 다시 보세요.<br>어제 시장을 알아야 오늘 자리가 보입니다.",
  };

  if (f.usdkrw) {
    deck.focusIndexes.push({ name: "원·달러", value: f.usdkrw.toLocaleString("ko-KR", { minimumFractionDigits: 1 }), pct: "", dir: "flat" });
  }
  return deck;
}

/* ═════════════════ 4) 문장은 Claude가 (실측값 주입) ═════════════════ */

const HOOK_GUIDE = {
  A: `[쏠림형] 거래대금이 상위 2종목에 쏠린 날이다. 훅은 "오늘 증시의 돈 <금액>이 딱 두 종목에 몰렸습니다" 형태로,
      금액을 크게 쓰되 종목명은 훅 본문에 넣지 않는다(2번 카드가 바로 공개한다).`,
  D: `[불일치형] 지수 방향과 개인 수급이 반대인 날이다. 훅은 "코스피는 <등락률>, 그런데 개인은 <금액>을 팔았습니다" 형태로,
      "나만 못 벌었나"라는 감정을 건드린다.`,
  E: `[경고형] 급등 종목이 한꺼번에 나온 날이다. 훅은 "오늘 급등한 <N>종목, 그래서 더 위험합니다" 형태로,
      사라고 부추기지 않고 리스크를 먼저 말한다.`,
  C: `[범인지목형] 시장을 움직인 원인 하나를 지목한다. 훅은 "오늘 시장을 움직인 건 <한 단어>였습니다" 형태로,
      원인을 명사 하나로 압축한다.`,
};

function buildPrompt(f, deck, hookType, analysisText) {
  return `아래는 ${f.date} 한국 증시 마감 데이터와 그날 작성된 분석 원문이다.
이 재료로 인스타그램 카드뉴스(6장) 문장을 쓴다.

# 이미 코드가 계산해 둔 실측값 (이 숫자만 쓸 것. 새 숫자를 만들지 말 것)
- 코스피 ${f.kospi.close} (${f.kospi.pct > 0 ? "+" : ""}${f.kospi.pct}%) / 코스닥 ${f.kosdaq.close} (${f.kosdaq.pct > 0 ? "+" : ""}${f.kosdaq.pct}%)
- 거래대금 1위 ${f.top2[0]?.name} ${won(f.top2[0]?.raw)} (${f.top2[0]?.pct}%) / 2위 ${f.top2[1]?.name} ${won(f.top2[1]?.raw)} (${f.top2[1]?.pct}%)
- 두 종목 합 ${wonLong(f.top2Sum)} = 거래대금 상위 ${f.tv.length}종목 합계 ${won(f.totalTv)}의 ${f.top2Share.toFixed(1)}%
- 3위 ${f.third?.name ?? "-"} ${f.third ? won(f.third.raw) : "-"}
- 수급(코스피) 외국인 ${f.flows.foreign?.text ?? "-"} / 기관 ${f.flows.institution?.text ?? "-"} / 개인 ${f.flows.individual?.text ?? "-"}
- 거래대금 상위 10종목: ${f.tv.slice(0, 10).map((r) => `${r.name} ${r.pct > 0 ? "+" : ""}${r.pct}%`).join(", ")}
- 장 성격: ${f.marketTone || "-"}

# 그날 분석 원문
${trim(analysisText, 5200)}

# 훅 유형 (코드가 데이터로 정했다. 반드시 이 유형으로 쓸 것)
${HOOK_GUIDE[hookType]}

# 규칙
1. **훅에서 던진 질문의 답은 2번 카드에 있다.** 1번 카드는 궁금하게만 만들고, 종목명·원인은 2번 카드 이후에 밝힌다.
2. 숫자는 위 실측값에서만 가져온다. 없는 수치는 쓰지 않는다. 어림값·추정치 금지.
3. 문장은 40~70자. 90자를 넘기지 않는다. 상투구("주목된다", "귀추가 주목") 금지.
4. "무료", "수익률", "매수 추천" 같은 표현은 쓰지 않는다. 사라고 말하지 않는다.
5. flowIn/flowOut은 실제로 오른 업종/내린 업종을 분석 원문에서 찾아 쓰고, 종목명과 등락률을 함께 넣는다.
   flowIn 첫 항목은 거래대금 1·2위와 같은 얘기를 반복하지 말고 그 업종의 **다른 종목**으로 채운다.
6. HTML은 <br> <b> <em> <span>만 쓴다. flowIn/flowOut의 desc에는 <br> 1개와 <b>를 반드시 쓴다.
7. **훅(hookHTML)은 한 문장이다.** 두 문장을 붙이면 훅이 죽는다. 설명은 hookSub이 한다.
8. verdictHTML은 요약이 아니라 **규정**이다. "강세로 마감했습니다" 같은 서술은 실패다.

# 좋은 예 / 나쁜 예
- hookHTML  O: "오늘 증시의 돈<br><em>8조 2,468억</em>이<br>딱 두 종목에<br>몰렸습니다"
             X: "오늘 증시의 돈 8조가 두 종목에 몰렸습니다. 이 두 종목이 시장을 이끌었습니다" (두 문장)
- hookSub   O: "지수는 올랐는데 내 종목만 조용했다면,<br>이유는 이 안에 있습니다."
             X: "어떤 종목인지 궁금하시죠? 다음 카드에서 확인해보세요" (유튜브 낚시 말투 금지)
- hookTag   O: "오늘 시장, 한 줄로 말하면"   X: "투자자 주목" (내용이 없다)
- verdictHTML O: "오늘 반등은<br><em>금리가 만든 반등</em>이다."
               X: "오늘 시장은 강세로 마감했습니다" (규정이 아니라 요약)
- flowIn 첫 항목 O: 거래대금 1·2위를 뺀 같은 업종의 다른 종목들
                 X: 2번 카드에서 이미 공개한 1·2위를 또 쓰는 것

# 출력 (JSON만. 설명 금지)
{
  "hookTag": "빨간 배지에 들어갈 짧은 라벨 (12자 이내)",
  "hookHTML": "1번 카드 대제목. <br>로 3~4줄. 핵심 숫자/단어는 <em>로 감쌈. 전체 40자 이내",
  "hookSub": "훅 아래 보조 2줄. <br> 1개 포함. 60자 이내",
  "focusTitle": "2번 카드 제목. 훅의 답. <br>로 2줄. 25자 이내",
  "focusNote": "2번 카드 하단 한 문장. 3위와의 격차 등 쏠림의 의미. <span>로 핵심어 강조. 70자 이내",
  "verdictHTML": "3번 카드. 오늘 시장을 한 문장으로 규정. <br>로 2줄, 핵심구는 <em>. 30자 이내",
  "verdictWhy": ["근거 3개. 각 60~85자. <b>로 수치·인명 강조", "", ""],
  "flowTitle": "4번 카드 제목. 오늘 업종이 어떻게 갈렸는지를 말한다. \"흐름을 짚어보자\" 같은 맹탕 제목 금지. <br>로 2줄. 20자 이내",
  "flowIn": [{"name":"업종명","desc":"종목 딱 2개의 등락률. 형식은 '종목A <b>+3.93%</b><br>종목B <b>+9.26%</b>'. 3개 이상 넣지 말 것"}, {"name":"","desc":""}],
  "flowOut": [{"name":"업종명","desc":"동일 형식"}, {"name":"","desc":""}],
  "flowNote": "4번 카드 하단 한 문장. <span>로 핵심어 강조. 80자 이내",
  "stocksTitle": "5번 카드 제목. <br>로 2줄. 20자 이내",
  "captionLines": ["캡션 본문 3줄. 각 줄 앞에 '· ' 붙이지 말 것. 60~90자", "", ""],
  "themeTags": ["그날 테마 해시태그 3~4개. # 없이 단어만. 예: 반도체주"]
}`;
}

const SYSTEM = `너는 한국 주식시장 카드뉴스의 카피라이터다.
독자는 국내 개인투자자이고, 네이버금융에서 볼 수 있는 숫자를 다시 보려고 이 카드를 넘기는 게 아니다.
"오늘 시장이 왜 그랬는지"와 "무엇이 위험한지"를 알려고 넘긴다.
사라고 부추기지 않는다. 리스크를 먼저 말하는 것이 이 계정의 정체성이다.
반드시 JSON 하나만 출력한다.`;

function parseJson(text) {
  const s = String(text ?? "");
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSON을 찾지 못했습니다");
  return JSON.parse(m[0]);
}

export async function writeCopyWithClaude(f, deck, hookType, analysisText, apiKey = process.env.ANTHROPIC_API_KEY) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY 없음");
  // 다른 스크립트와 같은 별칭 모델을 쓴다(날짜 붙은 ID는 만료되면 조용히 폴백으로 떨어진다).
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  const client = new Anthropic({ apiKey: key, maxRetries: 3, timeout: 120_000 });
  const prompt = buildPrompt(f, deck, hookType, analysisText);

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      });
      const text = (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return parseJson(text);
    } catch (e) {
      lastErr = e;
      // 왜 실패했는지 남기지 않으면 매번 폴백으로 떨어져도 원인을 알 수 없다.
      console.warn(`[deck] Claude 호출 ${attempt}차 실패 · model=${model} · ${e?.name || "Error"} ` +
        `status=${e?.status ?? "-"} ${String(e?.message || "").slice(0, 200)}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 4000));
    }
  }
  throw lastErr;
}

/**
 * Claude가 막히면(크레딧 소진 등) OpenAI로 같은 프롬프트를 돌린다.
 * 이 저장소의 다른 AI 작업들과 같은 이중화 패턴이다.
 */
export async function writeCopyWithOpenAI(f, deck, hookType, analysisText, apiKey = process.env.OPENAI_API_KEY) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("OPENAI_API_KEY 없음");
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildPrompt(f, deck, hookType, analysisText) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status} ${String(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return parseJson(data?.choices?.[0]?.message?.content ?? "");
}

/* ═════════════════ 5) 폴백 — AI 없이도 발행은 된다 ═════════════════ */

function fallbackCopy(f, hookType) {
  const a = f.top2[0], b = f.top2[1];
  const up = f.kospi.pct > 0;
  return {
    hookTag: "오늘 시장, 한 줄로 말하면",
    hookHTML: `오늘 증시의 돈<br><em>${wonLong(f.top2Sum)}</em>이<br>딱 두 종목에<br>몰렸습니다`,
    hookSub: `지수는 ${up ? "올랐" : "내렸"}는데 내 종목만 조용했다면,<br>이유는 이 안에 있습니다.`,
    focusTitle: `${a?.name}와<br>${b?.name}입니다`,
    focusNote: `거래대금 상위 ${f.tv.length}종목이 굴린 돈의 <span>${f.top2Share.toFixed(1)}%</span>가 이 두 종목에서 돌았습니다.`,
    verdictHTML: `오늘 시장은<br><em>${f.marketTone || (up ? "반등" : "조정")}</em>이었다.`,
    verdictWhy: [
      `코스피 ${f.kospi.close.toLocaleString("ko-KR")} (${f.kospi.pct > 0 ? "+" : ""}${f.kospi.pct}%), 코스닥 ${f.kosdaq.close.toLocaleString("ko-KR")} (${f.kosdaq.pct > 0 ? "+" : ""}${f.kosdaq.pct}%)로 마감했다.`,
      `거래대금 1위는 <b>${a?.name}</b>(${won(a?.raw)}), 2위는 <b>${b?.name}</b>(${won(b?.raw)})였다.`,
      `수급은 외국인 ${f.flows.foreign?.text ?? "-"}, 기관 ${f.flows.institution?.text ?? "-"}, 개인 ${f.flows.individual?.text ?? "-"}였다.`,
    ],
    flowTitle: `오늘 거래대금은<br>어디로 갔나`,
    // 2번 카드에서 이미 공개한 1·2위는 빼야 같은 얘기 반복이 안 된다
    flowIn: f.tv.slice(2).filter((r) => r.pct > 0).slice(0, 2).map((r) => ({
      name: r.name, desc: `<b>${r.pct > 0 ? "+" : ""}${r.pct}%</b> · 거래대금 <b>${won(r.raw)}</b>`,
    })),
    flowOut: f.tv.slice(2).filter((r) => r.pct < 0).slice(0, 2).map((r) => ({
      name: r.name, desc: `<b>${r.pct}%</b> · 거래대금 <b>${won(r.raw)}</b>`,
    })),
    flowNote: `거래대금 상위 ${f.tv.length}종목 가운데 ${f.tv.filter((r) => r.pct > 0).length}종목이 올랐습니다.`,
    stocksTitle: `왜 올랐는지,<br>그리고 무엇이 위험한지`,
    captionLines: [
      `거래대금 1·2위는 ${a?.name}(${won(a?.raw)})와 ${b?.name}(${won(b?.raw)})였습니다`,
      `코스피 ${f.kospi.close.toLocaleString("ko-KR")}(${f.kospi.pct > 0 ? "+" : ""}${f.kospi.pct}%) 코스닥 ${f.kosdaq.close.toLocaleString("ko-KR")}(${f.kosdaq.pct > 0 ? "+" : ""}${f.kosdaq.pct}%)`,
      `외국인·기관·개인 수급은 카드 4번에 정리했습니다`,
    ],
    themeTags: ["마감시황", "오늘의증시"],
  };
}

/* ═════════════════ 6) 캡션 조립 ═════════════════ */

const BASE_TAGS_BIG = ["주식", "재테크", "주식투자"];
const BASE_TAGS_MID = ["주식초보", "국내주식", "증시브리핑", "종목분석", "경제공부", "주식공부중"];
const BRAND_TAG = "토탈머니";

function buildCaption(deck, copy) {
  // <br>을 그냥 지우면 "돈8조 2,468억이딱"처럼 단어가 붙는다. 줄바꿈 태그는 공백으로 바꾼다.
  const strip = (s) => String(s ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const hookLine = strip(copy.hookHTML).replace(/\s+/g, " ");
  const tags = [...BASE_TAGS_BIG, ...BASE_TAGS_MID,
    ...(copy.themeTags || []).map((t) => String(t).replace(/[^가-힣A-Za-z0-9]/g, "")).filter(Boolean).slice(0, 4),
    BRAND_TAG];
  const uniq = [...new Set(tags)];
  return [
    `${hookLine}`,
    strip(copy.hookSub),
    "",
    ...(copy.captionLines || []).slice(0, 3).map((l) => `· ${strip(l)}`),
    "",
    "🔖 저장해두고 내일 아침 장 열기 전에 한 번 더 보세요.",
    "매일 오후 5시, AI가 정리한 마감시황을 올립니다 → @totalmoney_ai",
    "전체 리포트 → totalmoney.kr",
    "",
    "※ 투자 참고용 정보이며, 투자 판단 및 그 결과에 대한 책임은 투자자 본인에게 있습니다.",
    "",
    uniq.map((t) => `#${t}`).join(" "),
  ].join("\n");
}

/* ═════════════════ 7) 조립 + 검증 ═════════════════ */

const LIMITS = {
  hookHTML: 46, hookSub: 70, focusTitle: 30, focusNote: 82,
  verdictHTML: 36, flowTitle: 26, stocksTitle: 26, flowNote: 92,
};

const plain = (s) => String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "");

/** 태그를 살린 채 첫 문장만 남긴다. 모델이 훅에 문장을 덧붙이는 걸 코드가 잘라낸다. */
export function firstSentence(html) {
  const s = String(html ?? "");
  // 태그 밖에 있는 종결부호 위치를 찾는다
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "<") depth++;
    else if (c === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "." || c === "!" || c === "?")) {
      const rest = s.slice(i + 1).replace(/<br\s*\/?>/gi, "").trim();
      if (rest.length > 0) return s.slice(0, i + 1);
    }
  }
  return s;
}

/**
 * 모델이 규칙을 어겨도 화면은 지켜야 한다. 경고만 남기면 결국 그대로 발행된다.
 * - 훅은 첫 문장만 남기고, 그래도 길면 코드 폴백 훅으로 갈아끼운다
 * - 나머지 필드는 길이를 넘으면 자른다
 */
export function clampCopy(copy, f, hookType) {
  copy.hookHTML = firstSentence(copy.hookHTML);
  if (plain(copy.hookHTML).length > LIMITS.hookHTML) {
    console.warn(`[deck] 훅이 ${plain(copy.hookHTML).length}자로 너무 길어 코드 폴백 훅으로 교체합니다`);
    const fb = fallbackCopy(f, hookType);
    copy.hookHTML = fb.hookHTML;
    copy.hookSub = copy.hookSub || fb.hookSub;
  }
  for (const [k, max] of Object.entries(LIMITS)) {
    if (k === "hookHTML" || !copy[k]) continue;
    if (plain(copy[k]).length > max) {
      console.warn(`[deck] ${k} ${plain(copy[k]).length}자 → ${max}자로 자름`);
      copy[k] = firstSentence(copy[k]);
      if (plain(copy[k]).length > max) copy[k] = plain(copy[k]).slice(0, max).trim();
    }
  }
  copy.verdictWhy = (copy.verdictWhy || []).filter(Boolean).slice(0, 3);
  const twoNames = (desc) => {
    const parts = String(desc ?? "").split(/<br\s*\/?>|,\s*/).map((x) => x.trim()).filter(Boolean);
    return parts.slice(0, 2).join("<br>");
  };
  copy.flowIn = (copy.flowIn || []).filter((x) => x && x.name).slice(0, 2)
    .map((x) => ({ ...x, desc: twoNames(x.desc) }));
  copy.flowOut = (copy.flowOut || []).filter((x) => x && x.name).slice(0, 2)
    .map((x) => ({ ...x, desc: twoNames(x.desc) }));

  // 2번 카드에서 이미 공개한 1·2위를 4번 카드가 또 쓰면 같은 얘기 반복이다.
  // (위에서 종목을 2개로 줄인 뒤라 여기서 걸러도 최소 1개는 남는다)
  const top2Names = f.top2.map((r) => r.name);
  if (copy.flowIn[0]) {
    const before = copy.flowIn[0].desc;
    copy.flowIn[0].desc = String(before ?? "")
      .split(/,\s*/)
      .filter((seg) => !top2Names.some((n) => seg.includes(n)))
      .join(", ");
    if (!plain(copy.flowIn[0].desc).trim()) copy.flowIn[0].desc = before; // 다 지워지면 원문 유지
    else if (before !== copy.flowIn[0].desc) console.warn("[deck] flowIn 첫 항목에서 거래대금 1·2위 중복을 제거했습니다");
  }
  return copy;
}

export async function buildClosingDeck(snapshotPath = "data/daily-market.json", opts = {}) {
  const all = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const keys = Object.keys(all.days).sort();
  const date = opts.date || keys[keys.length - 1];
  const day = all.days[date];
  if (!day) throw new Error(`${date} 데이터가 없습니다`);

  const f = computeClosingFacts(day);
  if (f.top2.length < 2) throw new Error("거래대금 데이터가 부족합니다 (휴장일?)");

  const hookType = pickHookType(f);
  const deck = buildDeckSkeleton(f);
  deck.hookType = hookType;

  let copy = null;
  for (const [label, fn] of [["Claude", writeCopyWithClaude], ["OpenAI", writeCopyWithOpenAI]]) {
    try {
      copy = await fn(f, deck, hookType, day.analysis || "");
      console.log(`[deck] ${label} 문장 생성 완료 (훅 유형 ${hookType})`);
      break;
    } catch (e) {
      console.warn(`[deck] ${label} 실패: ${String(e.message).slice(0, 220)}`);
    }
  }
  if (!copy) {
    console.warn("[deck] AI 두 곳 모두 실패 — 코드 폴백 덱으로 발행합니다");
    copy = fallbackCopy(f, hookType);
  }
  copy = clampCopy(copy, f, hookType);

  Object.assign(deck, {
    hookTag: copy.hookTag, hookHTML: copy.hookHTML, hookSub: copy.hookSub,
    focusTitle: copy.focusTitle, focusNote: copy.focusNote,
    verdictHTML: copy.verdictHTML, verdictWhy: copy.verdictWhy,
    flowTitle: copy.flowTitle, flowIn: copy.flowIn, flowOut: copy.flowOut, flowNote: copy.flowNote,
    stocksTitle: copy.stocksTitle,
  });
  deck.caption = buildCaption(deck, copy);
  return deck;
}

/* ── CLI ── */
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => {
    const h = process.argv.find((a) => a.startsWith(`--${n}=`));
    return h ? h.split("=").slice(1).join("=") : d;
  };
  const date = arg("date");
  const deck = await buildClosingDeck("data/daily-market.json", { date });
  const out = arg("out", `data/promo/closing-${deck.date}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(deck, null, 2), "utf8");
  console.log(`[deck] ${deck.date} · 훅유형 ${deck.hookType} → ${out}`);
  console.log(`[deck] 훅: ${String(deck.hookHTML).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`);
}
