/**
 * 카드뉴스 v2 — 주간 글로벌 시가총액 랭킹 덱 생성
 *
 * 데이터는 기존 릴스가 쓰던 buildRankingData()를 그대로 재사용한다(원화 환산·국내기업 추출 포함).
 * 문장만 AI가 쓰고 숫자는 코드가 만든다는 원칙은 다른 덱과 같다.
 *
 * 훅은 국내 투자자가 반응할 지점에서 나온다 — "TOP10에 한국 기업이 없다"거나
 * "삼성전자가 몇 위인가"는 국내 커뮤니티에서 늘 도는 이야기다.
 *
 * 사용: node scripts/promo-build-deck-ranking.mjs --out=data/promo/latest-ranking.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildRankingData } from "./promo-render-globalranking.mjs";
import { firstSentence, callClaude, callOpenAI, composeCaption } from "./promo-deck-ai.mjs";

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const pctText = (p) => `${p > 0 ? "▲" : p < 0 ? "▼" : ""}${Math.abs(num(p)).toFixed(2)}%`;
const dirOf = (p) => (num(p) > 0 ? "up" : num(p) < 0 ? "down" : "flat");
const plain = (s) => String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "");

/**
 * buildRankingData()의 marketCapWon은 이미 "7,454.2조원" 형태의 **문자열**이다.
 * 숫자로 착각해 1e12로 나누면 전부 0.0조가 된다(실제로 한 번 그렇게 나갔다).
 * 여기서는 조 단위 숫자로 파싱해 두고, 표시는 joText()가 맡는다.
 */
const joNum = (marketCapWon) => {
  const m = String(marketCapWon ?? "").replace(/,/g, "").match(/([\d.]+)\s*조/);
  return m ? Number(m[1]) : 0;
};
const jo = (joValue) =>
  `${num(joValue).toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}조`;

const COUNTRY_KO = {
  "United States": "미국", "Taiwan": "대만", "Saudi Arabia": "사우디", "China": "중국",
  "Japan": "일본", "Korea": "한국", "South Korea": "한국", "Denmark": "덴마크",
  "Switzerland": "스위스", "France": "프랑스", "Germany": "독일", "India": "인도",
  "United Kingdom": "영국", "Netherlands": "네덜란드", "Ireland": "아일랜드",
};

/* ═════════════ 1) 실측값 ═════════════ */

export function computeRankingFacts(topRows, krRows) {
  const top = topRows.map((r) => ({
    rank: r.rank, name: r.name, country: COUNTRY_KO[r.country] || r.country || "",
    won: joNum(r.marketCapWon), pct: num(r.changePct),
  }));
  const kr = krRows.map((r) => ({
    globalRank: r.globalRank, domesticRank: r.domesticRank, name: r.name,
    won: joNum(r.marketCapWon), pct: num(r.changePct),
  }));

  const last = top[top.length - 1] || null; // TOP10 막차
  const topKr = kr[0] || null;
  const gap = last && topKr ? last.won - topKr.won : 0;
  const need = last && topKr && topKr.won > 0 ? (last.won / topKr.won - 1) * 100 : 0;

  // 같은 반도체인데 순위가 앞선 기업(대만 TSMC 등) — 국내 독자가 가장 반응하는 비교 지점
  const semiRef = top.find((r) => /TSMC/i.test(r.name)) || null;

  const sorted = [...top].sort((a, b) => b.pct - a.pct);
  return {
    top, kr, last, topKr, gap, need, semiRef,
    upCount: top.filter((r) => r.pct > 0).length,
    gainers: sorted.slice(0, 2),
    losers: sorted.slice(-2).reverse(),
    krInTop10: top.some((r) => r.country === "한국"),
  };
}

/* ═════════════ 2) 훅 유형 ═════════════ */

export function pickRankingHookType(f) {
  if (!f.krInTop10 && f.topKr) return "ABSENT"; // TOP10에 한국 기업이 없다
  if (f.krInTop10) return "PRESENT";
  return "GAP";
}

const HOOK_GUIDE = {
  ABSENT: `[부재형] 세계 시총 TOP10에 한국 기업이 하나도 없다. 훅은 "세계 시총 TOP10에 한국 기업은 없습니다" 형태로
           사실을 담담하게 던진다. 몇 위인지는 훅에 쓰지 않는다(2·3번 카드가 답한다).`,
  PRESENT: `[진입형] TOP10에 한국 기업이 있다. 훅은 그 사실과 순위를 크게 던진다.`,
  GAP: `[격차형] 1위와 2위의 격차, 또는 순위 변동을 짚는다.`,
};

/* ═════════════ 3) 뼈대 ═════════════ */

export function buildRankingSkeleton(f, ymd) {
  const d = new Date(`${ymd}T00:00:00+09:00`);
  const dow = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");

  // 3번 카드 막대 — TOP10 막차와 국내 기업을 같은 스케일로 비교한다
  const barBase = Math.max(f.semiRef?.won || 0, f.last?.won || 0);
  const bars = [];
  if (f.semiRef && f.semiRef.won > (f.last?.won || 0)) {
    bars.push({ name: f.semiRef.name, rank: f.semiRef.rank, cap: jo(f.semiRef.won), w: 100, ref: true });
  }
  if (f.last) bars.push({ name: f.last.name, rank: f.last.rank, cap: jo(f.last.won), w: Math.round((f.last.won / barBase) * 1000) / 10, ref: true });
  for (const k of f.kr.slice(0, 2)) {
    bars.push({ name: k.name, rank: k.globalRank, cap: jo(k.won), w: Math.round((k.won / barBase) * 1000) / 10, me: true });
  }

  return {
    slot: "ranking", layout: "ranking", date: ymd,
    slotLabel: "주간 글로벌 랭킹",
    dateLabel: `${mm}.${dd} (${dow})`,
    dateFull: `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`,

    indexChips: [
      f.top[0] && { name: `1위 ${f.top[0].name}`, text: jo(f.top[0].won), dir: "up" },
      f.topKr && { name: f.topKr.name, text: `${jo(f.topKr.won)} · ${f.topKr.globalRank}위`, dir: "up" },
    ].filter(Boolean),

    rankKicker: `${ymd} 기준`,
    rankRows: f.top.map((r) => ({
      rank: r.rank, name: r.name, tag: r.country,
      cap: jo(r.won), pct: pctText(r.pct), dir: dirOf(r.pct),
    })),
    rankFoot: "출처 · TotalMoney AI 주간 랭킹 (원화 환산)",

    krBars: bars,
    gapLabel: "TOP10 진입까지 남은 거리",
    gapValue: f.gap > 0 ? jo(f.gap) : "—",

    // 4번 카드 — 이번 주 오르내린 곳. 수급 블록은 이 슬롯에 해당 데이터가 없어 넣지 않는다.
    flowFoot: "출처 · TotalMoney AI 주간 랭킹 (원화 환산)",
    flowKicker: "이번 주 등락",
    flowInLabel: "오른 곳",
    flowOutLabel: "내린 곳",
    flowIn: f.gainers.map((r) => ({ name: r.name, desc: `<b>${pctText(r.pct)}</b><br>시총 <b>${jo(r.won)}</b> · 세계 ${r.rank}위` })),
    flowOut: f.losers.map((r) => ({ name: r.name, desc: `<b>${pctText(r.pct)}</b><br>시총 <b>${jo(r.won)}</b> · 세계 ${r.rank}위` })),

    ctaTitle: `순위는 매주 바뀝니다.<br><em>추적</em>은 여기서 합니다.`,
    ctaSub: "매주 주말, 전 세계 시총 TOP100과 그 안의 국내 기업 순위를 올립니다.",
    ctaReasons: [
      "TOP10만이 아니라 <b>TOP100 전체</b>와 한국 기업의 정확한 위치를 봅니다.",
      "순위 <b>변동</b>을 추적합니다 — 누가 올라오고 누가 밀렸는지.",
      "원화 환산과 등락률까지 <b>실데이터</b>로 계산합니다.",
    ],
    saveNudge: "<b>저장</b>해두고 다음 주 순위와 비교해보세요.<br>한 주 만에 자리가 바뀌는 기업이 매주 나옵니다.",
  };
}

/* ═════════════ 4) 프롬프트 ═════════════ */

const SYSTEM = `너는 한국 주식시장 카드뉴스의 카피라이터다.
독자는 국내 개인투자자이고, 세계 시총 순위를 통해 "한국 기업이 지금 어디쯤인가"를 확인하려 한다.
과장하거나 애국 감정을 자극하지 않는다. 사실을 정확히 놓고 의미만 짚는다.
반드시 JSON 하나만 출력한다.`;

function buildPrompt(f, hookType, ymd) {
  return `아래는 ${ymd} 기준 전 세계 시가총액 순위 실측값이다. 인스타그램 카드뉴스(5장) 문장을 쓴다.

# 실측값 (이 숫자만 쓸 것)
${f.top.map((r) => `${r.rank}위 ${r.name}(${r.country}) ${jo(r.won)} ${r.pct > 0 ? "+" : ""}${r.pct}%`).join("\n")}
- 국내 기업: ${f.kr.map((k) => `${k.name} 세계 ${k.globalRank}위 ${jo(k.won)} ${k.pct > 0 ? "+" : ""}${k.pct}%`).join(" / ") || "TOP100 내 없음"}
- TOP10 막차(${f.last?.rank}위 ${f.last?.name}) ${jo(f.last?.won)} · 국내 1위와 격차 ${jo(f.gap)} (국내 1위가 ${f.need.toFixed(0)}% 더 커져야 진입)
${f.semiRef ? `- 같은 반도체 대만 ${f.semiRef.name}은 ${f.semiRef.rank}위 ${jo(f.semiRef.won)}` : ""}
- TOP10 중 ${f.upCount}곳 상승

# 훅 유형 (코드가 정했다)
${HOOK_GUIDE[hookType]}

# 규칙
1. 훅(hookHTML)은 **한 문장**이다. 순위 숫자는 훅에 쓰지 않고 2·3번 카드가 답한다.
2. 숫자는 위 실측값에서만 가져온다. 새 숫자 금지.
3. 애국·비하 표현 금지. "우리나라 기업이 자랑스럽다"거나 "겨우 12위"같은 감정 표현을 쓰지 않는다.
4. 문장 40~70자, 90자 상한. "무료" 금지.
5. HTML은 <br> <b> <em> <span>만 쓴다.

# 출력 (JSON만)
{
  "hookTag": "빨간 배지 라벨. 14자 이내",
  "hookHTML": "1번 카드 대제목. <br>로 3~4줄, 핵심은 <em>. 40자 이내",
  "hookSub": "보조 2줄. <br> 1개. 60자 이내",
  "rankTitle": "2번 카드 제목. 순위표를 요약하는 사실 한 줄. <br>로 2줄. 22자 이내",
  "krTitle": "3번 카드 제목. 국내 기업의 자리를 말한다. <br>로 2줄. 22자 이내",
  "gapDesc": "3번 카드 하단 설명. 격차의 의미. <b>로 수치 강조. 90자 이내",
  "flowTitle": "4번 카드 제목. 이번 주 등락을 말한다. <br>로 2줄. 22자 이내",
  "flowNote": "4번 카드 하단 한 문장. <span>로 핵심어 강조. 80자 이내",
  "captionLines": ["캡션 본문 3줄. 각 60~90자", "", ""],
  "themeTags": ["해시태그 3~4개. # 없이"]
}`;
}

/* ═════════════ 5) 폴백 ═════════════ */

function fallbackCopy(f) {
  return {
    hookTag: "전 세계 시가총액 TOP10",
    hookHTML: f.krInTop10
      ? `세계 시총 TOP10에<br><em>한국 기업이</em><br>있습니다`
      : `세계 시총<br>TOP10에<br><em>한국 기업은</em><br><em>없습니다</em>`,
    hookSub: `${f.kr.map((k) => `${k.name}가 ${k.globalRank}위`).join(", ")}.<br>가장 가까이 간 기업들의 자리입니다.`,
    rankTitle: `1위 ${f.top[0]?.name},<br>2위와 ${jo((f.top[0]?.won || 0) - (f.top[1]?.won || 0))} 차이`,
    krTitle: `한국 기업은<br>어디쯤 있나`,
    gapDesc: `${f.topKr?.name} 시가총액이 지금보다 <b>${f.need.toFixed(0)}%</b> 더 커져야 ${f.last?.rank}위 ${f.last?.name}을 넘어섭니다.`,
    flowTitle: `이번 주<br>오른 곳과 내린 곳`,
    flowNote: `TOP10 가운데 <span>${f.upCount}곳</span>이 올랐습니다.`,
    captionLines: [
      `1위는 ${f.top[0]?.name}(${jo(f.top[0]?.won)}), 2위는 ${f.top[1]?.name}(${jo(f.top[1]?.won)})입니다`,
      f.kr.length ? `국내 기업은 ${f.kr.map((k) => `${k.name} 세계 ${k.globalRank}위`).join(", ")}입니다` : "",
      `TOP10 진입까지 ${jo(f.gap)} 남았습니다`,
    ].filter(Boolean),
    themeTags: ["글로벌랭킹", "시가총액", "삼성전자"],
  };
}

/* ═════════════ 6) 조립 ═════════════ */

const LIMITS = { hookHTML: 46, hookSub: 70, rankTitle: 28, krTitle: 28, gapDesc: 96, flowTitle: 28, flowNote: 88 };

function clampCopy(copy, f) {
  copy.hookHTML = firstSentence(copy.hookHTML);
  if (plain(copy.hookHTML).length > LIMITS.hookHTML) copy.hookHTML = fallbackCopy(f).hookHTML;
  for (const [k, max] of Object.entries(LIMITS)) {
    if (k === "hookHTML" || !copy[k]) continue;
    if (plain(copy[k]).length > max) {
      copy[k] = firstSentence(copy[k]);
      if (plain(copy[k]).length > max) copy[k] = plain(copy[k]).slice(0, max).trim();
      console.warn(`[ranking] ${k} 길이 초과 → 잘라냄`);
    }
  }
  return copy;
}

export async function buildRankingDeck(ymd) {
  const date = ymd || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const { topRows, krRows } = await buildRankingData();
  if (!topRows?.length) throw new Error("글로벌 랭킹 데이터가 비어 있습니다");

  const f = computeRankingFacts(topRows, krRows);
  const hookType = pickRankingHookType(f);
  const deck = buildRankingSkeleton(f, date);
  deck.hookType = hookType;

  let copy = null;
  const prompt = buildPrompt(f, hookType, date);
  for (const [label, fn] of [["Claude", callClaude], ["OpenAI", callOpenAI]]) {
    try {
      copy = await fn(SYSTEM, prompt);
      console.log(`[ranking] ${label} 문장 생성 완료 (훅 유형 ${hookType})`);
      break;
    } catch (e) {
      console.warn(`[ranking] ${label} 실패: ${String(e.message).slice(0, 200)}`);
    }
  }
  if (!copy) {
    console.warn("[ranking] AI 두 곳 모두 실패 — 코드 폴백 덱으로 발행합니다");
    copy = fallbackCopy(f);
  }
  copy = clampCopy(copy, f);

  Object.assign(deck, {
    hookTag: copy.hookTag, hookHTML: copy.hookHTML, hookSub: copy.hookSub,
    rankTitle: copy.rankTitle, krTitle: copy.krTitle, gapDesc: copy.gapDesc,
    flowTitle: copy.flowTitle, flowNote: copy.flowNote,
  });
  deck.caption = composeCaption({
    hook: copy.hookHTML, sub: copy.hookSub, lines: copy.captionLines, themeTags: copy.themeTags,
    saveLine: "🔖 저장해두고 다음 주 순위와 비교해보세요.",
    ctaLine: "매주 주말, 전 세계 시총 TOP100을 정리해 올립니다 → @totalmoney_ai",
    extraTags: ["글로벌랭킹", "시가총액", "해외주식"],
  });
  return deck;
}

/* ── CLI ── */
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => {
    const h = process.argv.find((a) => a.startsWith(`--${n}=`));
    return h ? h.split("=").slice(1).join("=") : d;
  };
  const deck = await buildRankingDeck(arg("date"));
  const out = arg("out", `data/promo/ranking-${deck.date}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(deck, null, 2), "utf8");
  console.log(`[ranking] ${deck.date} · 훅유형 ${deck.hookType} → ${out}`);
  console.log(`[ranking] 훅: ${plain(deck.hookHTML)}`);
}
