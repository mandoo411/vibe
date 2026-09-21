/**
 * 카드뉴스 v2 — 종가시그널 기록 덱 생성 (2026-09-21 신설)
 *
 * 왜 이 카드인가: 무료 시세 사이트가 절대 못 보여주는 게 "이 서비스가 찍은 종목이 실제로
 * 어땠는가"다. close_signal_results에 거래일마다 쌓이는 기록이 그 자체로 콘텐츠가 된다.
 *
 * ⚠️ 이 덱은 **AI를 부르지 않는다.** 다른 덱은 "숫자는 코드, 문장은 AI"인데 여기는 문장까지
 * 코드가 쓴다. 성과 수치는 한 글자만 틀려도 신뢰가 통째로 날아가는 값이고, 문장 자체가
 * "N거래일 중 M일이 플러스" 같은 숫자 서술이라 AI가 개입할 여지도 이득도 없다.
 * 덤으로 발행당 토큰 비용이 0이다.
 *
 * ⚠️ **이긴 구간만 골라 보여주지 않는다.** 최근 N거래일을 연속으로 싣고, 손실 난 날도
 * 같은 막대에 그대로 그린다. 누적이 마이너스면 훅 문구도 그에 맞게 바뀐다(pickHook).
 *
 * 필수 env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * 선택 env: CS_MIN_DAYS(발행 하한 거래일 수, 기본 10)
 * 사용: node scripts/promo-build-deck-close-signal.mjs --out=data/promo/latest-close-signal.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const MIN_DAYS = Number(process.env.CS_MIN_DAYS || 10);

/** 달력에 그릴 최근 거래일 수. 12줄이 1350px 카드에 들어가는 상한이다(13줄부터 넘친다). */
const DAILY_ROWS = 12;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pctText = (p) => (p == null ? "—" : `${p > 0 ? "+" : ""}${p.toFixed(2)}%`);
const pctShort = (p) => (p == null ? "—" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`);
const dirOf = (p) => (p == null ? "" : p > 0 ? "up" : p < 0 ? "down" : "");
const mdLabel = (ymd) => {
  const [, m, d] = String(ymd).split("-");
  return `${Number(m)}/${Number(d)}`;
};
async function loadResults() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음");
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/close_signal_results?order=as_of_date.desc&limit=60` +
      `&select=as_of_date,review_date,phase,source,pick_count,picks,summary`,
    { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } }
  );
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
  const rows = await res.json();
  // 종가까지 확정된 날만 쓴다. 시가만 찍힌 당일 행은 아직 반쪽이라 뺀다.
  return (Array.isArray(rows) ? rows : []).filter((r) => r.phase === "close");
}

function computeFacts(days) {
  const picks = days.flatMap((d) => d.picks || []);
  const openRets = picks.map((p) => num(p.openReturnPct)).filter((v) => v != null);
  const closeRets = picks.map((p) => num(p.closeReturnPct)).filter((v) => v != null);
  const mean = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null);
  const rate = (a) => (a.length ? Math.round((a.filter((v) => v > 0).length / a.length) * 1000) / 10 : null);
  const dayCloses = days.map((d) => num((d.summary || {}).avgCloseReturnPct)).filter((v) => v != null);
  const best = closeRets.length
    ? picks.filter((p) => p.closeReturnPct != null).sort((a, b) => b.closeReturnPct - a.closeReturnPct)[0]
    : null;
  return {
    days: days.length,
    picks: picks.length,
    avgOpen: mean(openRets),
    winOpen: rate(openRets),
    avgClose: mean(closeRets),
    winClose: rate(closeRets),
    plusDays: dayCloses.filter((v) => v > 0).length,
    dayCount: dayCloses.length,
    best,
    latest: days[0] || null,
  };
}

/** 훅은 실제 기록을 따라간다. 마이너스 구간에서 "수익났다"고 쓰면 그날로 끝이다.
 *
 * ⚠️ 문구 규칙(2026-09-21, 시우 지적 → 금감원 제재 사례 확인 후 반영):
 * **승부·도박·적중을 연상시키는 말을 쓰지 않는다** — "이긴 날/진 날", "맞혔다", "적중",
 * "성적표", "승률", "베팅". '종가베팅'을 '종가시그널'로 개명한 것과 같은 이유다.
 * 대신 사실 그대로만 쓴다: "수익 난 날 / 손실 난 날", "수익 종목 비율", "기록".
 * 또 **결과가 좋은 구간만 골라 보여주지 않는다** — 좋은 기간만 제시하는 표시·광고는
 * 금감원이 실제로 과태료를 매긴 유형이다. 거래일을 연속으로 싣는 지금 구조를 깨지 말 것. */
function pickHook(f) {
  const good = (f.avgClose || 0) > 0;
  if (good) {
    return {
      tag: "종가시그널 기록",
      html: `${f.dayCount}거래일 기록을<br><em>숨김 없이</em><br>전부 공개합니다`,
      sub: `매일 장 마감 직전 5종목을 고르고,<br>다음 날 결과를 그대로 기록했습니다.`,
    };
  }
  return {
    tag: "종가시그널 기록",
    html: `손실 난 날도<br><em>그대로</em><br>남깁니다`,
    sub: `${f.dayCount}거래일 기록 전부입니다.<br>결과가 나쁜 날을 빼고 보여주지 않습니다.`,
  };
}

export async function buildCloseSignalDeck() {
  const all = await loadResults();
  if (all.length < MIN_DAYS) {
    const err = new Error(`기록이 ${all.length}거래일뿐입니다 (하한 ${MIN_DAYS}거래일) — 발행하지 않습니다`);
    err.code = "NOT_ENOUGH_DATA";
    throw err;
  }
  const f = computeFacts(all);
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const hook = pickHook(f);

  /* 막대 폭: 최댓값을 100%로 잡는다. 절대 스케일을 쓰면 잔잔한 구간이 전부 실선이 된다. */
  const recent = all.slice(0, DAILY_ROWS).reverse();
  const maxAbs = Math.max(
    1,
    ...recent.map((d) => Math.abs(num((d.summary || {}).avgCloseReturnPct) || 0))
  );
  const csDailyRows = recent.map((d) => {
    const v = num((d.summary || {}).avgCloseReturnPct);
    return {
      label: mdLabel(d.as_of_date),
      pct: v == null ? 0 : v,
      w: v == null ? 0 : Math.min(50, (Math.abs(v) / maxAbs) * 48),
      dir: dirOf(v),
      text: pctShort(v),
    };
  });

  const latest = f.latest;
  const csPickRows = (latest ? latest.picks || [] : []).slice(0, 5).map((p) => ({
    name: p.name,
    sub: `${p.consensus != null ? `기법 ${p.consensus}개 · ` : ""}${p.score != null ? `${p.score}점` : ""}`.replace(/ · $/, ""),
    open: pctShort(num(p.openReturnPct)),
    openDir: dirOf(num(p.openReturnPct)),
    close: pctShort(num(p.closeReturnPct)),
    closeDir: dirOf(num(p.closeReturnPct)),
  }));
  const ls = (latest && latest.summary) || {};

  const deck = {
    slot: "close-signal",
    layout: "close-signal",
    date: today,
    slotLabel: "종가시그널 기록",
    dateLabel: mdLabel(today),
    dateFull: `${Number(today.slice(5, 7))}월 ${Number(today.slice(8, 10))}일`,

    /* 1. 훅 */
    hookTag: hook.tag,
    hookHTML: hook.html,
    hookSub: hook.sub,
    indexChips: [
      { name: "시가 매도", text: pctText(f.avgOpen), dir: dirOf(f.avgOpen) },
      { name: "종가 매도", text: pctText(f.avgClose), dir: dirOf(f.avgClose) },
    ],

    /* 2. 누적 기록 */
    csRecordKicker: `${f.dayCount}거래일 · 선정 ${f.picks}종목 누적`,
    csRecordTitle: "종가에 매수했다면<br>어떻게 됐나",
    csRecordCells: [
      { k: "다음날 시가에 팔았다면", v: pctText(f.avgOpen), dir: dirOf(f.avgOpen), s: `수익 종목 비율 ${f.winOpen ?? "—"}%`, hi: false },
      { k: "다음날 종가에 팔았다면", v: pctText(f.avgClose), dir: dirOf(f.avgClose), s: `수익 종목 비율 ${f.winClose ?? "—"}%`, hi: true },
      { k: "플러스로 끝난 날", v: `${f.plusDays}/${f.dayCount}`, dir: "", s: "종가 매도 기준", hi: false },
      {
        k: "가장 크게 오른 종목",
        v: pctShort(num(f.best && f.best.closeReturnPct)),
        dir: dirOf(num(f.best && f.best.closeReturnPct)),
        s: f.best ? f.best.name : "—",
        hi: false,
      },
    ],
    /* 금감원이 실제로 과태료를 매긴 유형 중 하나가 **필수 기재사항 누락**이다
     * (원금 손실 가능성 / 개별 투자상담 불가 / 정식 금융투자업자가 아님).
     * 숫자가 가장 크게 박히는 이 장에 원금 손실 가능성을 같이 둔다. */
    csRecordNote:
      `선정일 <b>종가에 매수</b>한 것으로 가정한 수치입니다. 세금·수수료는 반영하지 않았습니다. ` +
      `<b>원금 손실이 발생할 수 있으며</b>, 과거 기록이 미래 수익을 보장하지 않습니다.`,

    /* 3. 거래일별 */
    csDailyKicker: `최근 ${csDailyRows.length}거래일`,
    csDailyTitle: "수익 난 날과<br>손실 난 날",
    csDailyRows,
    csDailyFoot: "각 거래일 선정 5종목의 평균 · 다음날 종가 매도 기준",

    /* 4. 직전 선정 결과 */
    csPicksKicker: latest ? `${mdLabel(latest.as_of_date)} 선정 → ${mdLabel(latest.review_date)} 결과` : "직전 선정",
    csPicksTitle: "가장 최근<br>5종목",
    csPickRows,
    csPicksSummary:
      `시가 매도 <b>${pctText(num(ls.avgOpenReturnPct))}</b> · ` +
      `종가 매도 <b>${pctText(num(ls.avgCloseReturnPct))}</b>` +
      (ls.closeWins != null ? ` · 5종목 중 <b>${ls.closeWins}종목</b> 수익` : ""),
    csPicksFoot: "조건검색 결과이며 매수·매도 권유가 아닙니다 · 개별 투자상담을 하지 않습니다",

    csFoot: "totalmoney.kr · 종가시그널",

    /* 5. CTA */
    ctaTitle: "고른 종목을<br><em>전부 기록</em>합니다.",
    ctaSub: "결과가 나쁜 날을 빼지 않고 그대로 싣습니다.",
    ctaReasons: [
      "매일 장 마감 직전 <b>9가지 매매기법</b>이 겹쳐서 잡은 5종목을 고릅니다.",
      "다음 거래일 <b>시가와 종가</b> 결과를 자동으로 기록합니다.",
      "거래일별 결과를 <b>달력</b>으로 모두 공개합니다 — 손실 난 날도 그대로 있습니다.",
    ],
    saveNudge: "<b>저장</b>해두고 다음 주 기록과 비교해보세요.<br>기록은 매 거래일 쌓입니다.",
    ctaFoot: "원금 손실이 발생할 수 있습니다 · 개별 투자상담을 하지 않습니다 · 정식 금융투자업자가 아닙니다",
  };

  const capLines = [
    `· 지난 ${f.dayCount}거래일 동안 선정한 ${f.picks}종목의 결과입니다.`,
    `· 선정일 종가에 매수했다고 가정했을 때, 다음날 시가 매도 평균 ${pctText(f.avgOpen)}(수익 종목 비율 ${f.winOpen ?? "—"}%), 종가 매도 평균 ${pctText(f.avgClose)}(${f.winClose ?? "—"}%)입니다.`,
    `· 하루 단위로는 ${f.dayCount}일 중 ${f.plusDays}일이 플러스로 끝났습니다.`,
    `· 전체 기록은 totalmoney.kr 종가시그널 페이지의 성과 달력에서 날짜별로 확인할 수 있습니다.`,
  ];
  deck.caption = [
    hook.html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""),
    hook.sub.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""),
    "",
    ...capLines,
    "",
    "🔖 저장해두고 다음 주 기록과 비교해보세요.",
    "매 거래일 기록을 쌓아 공개합니다 → @totalmoney_ai",
    "",
    "※ 공개된 시세·수급·공시 데이터를 정해진 조건식으로 계산한 조건검색 결과이며, 특정 종목의 매수·매도를 권유하지 않습니다.",
    "※ 원금 손실이 발생할 수 있습니다. 과거 기록이 미래 수익을 보장하지 않으며, 투자 판단과 그 결과의 책임은 본인에게 있습니다.",
    "※ 개별 투자상담은 하지 않습니다. 정식 금융투자업자가 아닙니다.",
    "",
    "#종가매매 #국내주식 #주식투자 #매매기법 #퀀트투자 #주식공부 #투자공부 #토탈머니",
  ].join("\n");
  return deck;
}

/* ── CLI ── */
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => {
    const h = process.argv.find((a) => a.startsWith(`--${n}=`));
    return h ? h.split("=").slice(1).join("=") : d;
  };
  try {
    const deck = await buildCloseSignalDeck();
    const out = arg("out", `data/promo/close-signal-${deck.date}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(deck, null, 2), "utf8");
    console.log(`[close-signal] ${deck.date} · ${deck.csDailyRows.length}거래일 → ${out}`);
  } catch (error) {
    if (error.code === "NOT_ENOUGH_DATA") {
      /* 기록이 모자란 건 고장이 아니다. 빨간 실패로 알림을 울리는 대신 **덱 파일을 쓰지 않고**
       * 정상 종료한다. 워크플로는 파일이 생겼는지로 발행 여부를 판단한다
       * (0이 아닌 코드로 끝내면 Actions가 실패로 표시해 매주 가짜 경보가 울린다). */
      console.log(`::notice::${error.message}`);
      process.exit(0);
    }
    throw error;
  }
}
