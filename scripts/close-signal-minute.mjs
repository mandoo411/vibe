/**
 * 종가시그널 선정 종목의 "다음 날" 1분봉 저장 (2026-10-06 신설, 시우 요청).
 *
 * 왜: 지금까지는 다음 날 시가·고가·저가·종가 4개 값만 있어서 "시가 이후 언제 파는 게 나은가"를
 * 연구할 수 없었다(CRASH_BACKTEST.md 12장). KIS 분봉은 **당일 것만** 받을 수 있으므로,
 * 결과일 장 마감 뒤(15:45 close 단계)에 그날 분봉을 매일 쌓는다. 20거래일 이상 모이면 매도 시점 연구에 쓴다.
 *
 * 대상: 직전 거래일 1520 스캔의 종가시그널 상위 5 + 관리자용 6~20위 + 1주 스윙 상위 5(중복 제거).
 * 저장: Supabase Storage 비공개 버킷 `research`의 `minute/<결과일>.json` (하루 한 파일, 덮어쓰기). 내부 연구용 — 화면에 쓰지 않는다.
 *   (테이블 대신 Storage를 쓴 이유: 새 테이블 생성(DDL) 없이 service_role 키만으로 GHA에서 바로 쌓을 수 있다.)
 *
 * 필수 env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KIS_ACCESS_TOKEN, KIS_APP_KEY, KIS_APP_SECRET
 * 선택 env: REVIEW_PHASE(open이면 건너뜀), MINUTE_DRY_RUN=1(받기만 하고 저장 생략)
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { fetchMinuteBars } = require("../lib/kis-indicators.js");
const krx = require("../lib/krx-calendar.js");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY_RUN = process.env.MINUTE_DRY_RUN === "1";
const PHASE_ENV = String(process.env.REVIEW_PHASE || "auto").trim().toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seoulYmd = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
const seoulHour = () =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false }).format(new Date()));

async function sb(pathAndQuery, init) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      ...(init && init.headers),
    },
  });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function main() {
  const phase = PHASE_ENV === "open" || PHASE_ENV === "close" ? PHASE_ENV : seoulHour() < 12 ? "open" : "close";
  if (phase !== "close") {
    console.log("[minute] 장 마감 단계가 아니라 건너뜁니다(분봉은 15:45 단계에서만 받는다).");
    return;
  }
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음");
  const today = seoulYmd();
  if (krx.closedReason(today)) {
    console.log(`[minute] ${today} 휴장 — 건너뜀`);
    return;
  }

  const rows = await (
    await sb(`trade_signal_intraday?slot=eq.1520&as_of_date=lt.${today}&order=as_of_date.desc&limit=3&select=as_of_date,payload`, { method: "GET" })
  ).json();
  const row = (rows || []).find((r) => r && r.payload && r.payload.closeBetting && Array.isArray(r.payload.closeBetting.ranked) && r.payload.closeBetting.ranked.length);
  if (!row) {
    console.log("[minute] 대상 랭킹 없음 — 건너뜀");
    return;
  }
  if (krx.nextTradingDay(row.as_of_date) !== today) {
    console.log(`[minute] ${row.as_of_date} 선정분의 결과일이 오늘(${today})이 아님 — 건너뜀`);
    return;
  }

  const cb = row.payload.closeBetting;
  const sw = row.payload.swing || {};
  const targets = new Map();
  for (const r of cb.ranked || []) targets.set(r.code, { code: r.code, name: r.name, kind: "close", rank: r.rank, shortlist: r.shortlist === true, buy: r.close });
  for (const r of cb.rankedExt || []) if (!targets.has(r.code)) targets.set(r.code, { code: r.code, name: r.name, kind: "close", rank: r.rank, shortlist: false, buy: r.close });
  for (const r of sw.ranked || []) if (!targets.has(r.code)) targets.set(r.code, { code: r.code, name: r.name, kind: "swing", rank: r.rank, shortlist: false, buy: r.close });
  console.log(`[minute] ${row.as_of_date} 선정 → ${today} 분봉 대상 ${targets.size}종목`);

  const out = [];
  for (const t of targets.values()) {
    if (!t.code) continue;
    let bars = [];
    for (let attempt = 0; attempt < 2 && !bars.length; attempt++) {
      try {
        bars = await fetchMinuteBars(t.code);
      } catch (e) {
        console.log(`::warning::${t.name}(${t.code}) 분봉 실패: ${e && e.message}`);
        await sleep(800);
      }
    }
    await sleep(150);
    const first = bars[0], last = bars[bars.length - 1];
    console.log(`  ${t.kind} ${String(t.rank).padStart(2)}. ${t.name} ${bars.length}봉 ${first ? first.t : "-"}~${last ? last.t : "-"}`);
    if (!bars.length) continue; // 받은 게 없으면 저장하지 않는다(지어내지 않음)
    out.push({
      code: t.code,
      name: t.name,
      kind: t.kind,
      rank: t.rank,
      shortlist: t.shortlist,
      buyPrice: t.buy != null ? Number(t.buy) : null,
      bars: bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]), // [HHMM, 시가, 고가, 저가, 종가, 거래량]
    });
  }

  if (DRY_RUN) {
    console.log(`[minute] DRY_RUN — ${out.length}종목 저장 생략`);
    return;
  }
  if (!out.length) {
    console.log("[minute] 받은 분봉이 없어 저장하지 않습니다.");
    return;
  }
  // 비공개 버킷이 없으면 만든다(이미 있으면 400/409 — 무시).
  const mk = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "research", name: "research", public: false }),
  });
  if (!mk.ok && mk.status !== 400 && mk.status !== 409) console.log(`::warning::버킷 생성 응답 ${mk.status} ${(await mk.text()).slice(0, 120)}`);
  const body = JSON.stringify({ reviewDate: today, asOfDate: row.as_of_date, savedAt: new Date().toISOString(), stocks: out });
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/research/minute/${today}.json`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", "x-upsert": "true" },
    body,
  });
  if (!up.ok) throw new Error(`Storage 업로드 실패 HTTP ${up.status} ${(await up.text()).slice(0, 200)}`);
  console.log(`[minute] research/minute/${today}.json 저장 ${out.length}종목 · ${(body.length / 1024).toFixed(0)}KB`);
}

main().catch((error) => {
  console.error("[minute] 실패", error);
  process.exit(1);
});
