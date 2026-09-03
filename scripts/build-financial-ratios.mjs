#!/usr/bin/env node
/**
 * DART 단일회사 주요계정 → 상장사 전체 재무비율 캐시.
 *
 * 배경(2026-09-03): 사용자가 키움 HTS 조건검색식을 그대로 붙여넣었는데
 *   A 시가총액 / B 부채비율 / C 영업이익률 / D 이자보상배율 / E PER
 * 중 실제로 걸리는 건 A·E뿐이었다. B·C·D는 전부 재무제표 지표인데 스크리너 캐시가
 * KIS 시세·수급 데이터로만 만들어져 있어서 재무 항목이 한 줄도 없었기 때문이다.
 *
 * 이 배치가 그 구멍을 메운다. 상장사 전체(약 3,988개)의 최신 사업보고서에서
 * 부채비율·영업이익률·순이익률·ROE·유동비율을 **코드가 직접 계산**해 캐시에 넣는다.
 *
 * 원칙:
 *  - 계산은 전부 코드가 한다. AI 추정값은 단 하나도 넣지 않는다.
 *  - **분모가 0이거나 음수면 비율을 만들지 않고 생략한다.** 자본잠식 기업의 부채비율은
 *    수학적으로는 음수가 나오지만 읽는 사람을 속인다(부채가 적은 것처럼 보인다).
 *  - 연결(CFS) 우선, 없으면 개별(OFS). 한 종목의 재무를 두 기준으로 섞지 않는다.
 *  - 이자보상배율(영업이익/이자비용)은 **의도적으로 제외**한다. 이자비용이 주요계정에
 *    없어서 전체 재무제표 API(fnlttSinglAcntAll)를 종목당 따로 불러야 하는데,
 *    상장사 전체를 매일 돌리기엔 호출량이 과하다.
 *
 * 호출량: 종목당 1회(직전 회계연도), 데이터가 없으면 1회 더(전전년도) → 최대 약 8,000회.
 * DART 일일 한도 20,000회 안에 들어간다.
 *
 * 실행: node scripts/build-financial-ratios.mjs [--limit N] [--year YYYY]
 *   DART_API_KEY 환경변수 필요(GH Secrets/Vercel 환경변수에만 있음 — 로컬 실행 불가).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORP_MAP_PATH = path.join(ROOT, "data", "dart-corp-map.json");
const OUT_PATH = path.join(ROOT, "data", "dart-financial-ratios.json");

const DART_BASE = "https://opendart.fss.or.kr/api/fnlttSinglAcnt.json";
const REPRT_ANNUAL = "11011";
const FETCH_TIMEOUT_MS = 15000;
const CONCURRENCY = 6;

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const LIMIT = Number(argVal("--limit")) || 0;

/** 사업보고서는 회계연도 종료 후 3개월 안에 제출된다. 지금이 2026년 9월이면 FY2025는
 *  이미 나와 있고 FY2026은 아직 없다. 직전 연도부터 시도하고 없으면 한 해 더 뒤로 간다
 *  (3월·6월 결산법인, 신규상장 등). */
const BASE_YEAR = Number(argVal("--year")) || new Date().getFullYear() - 1;
const YEAR_CANDIDATES = [BASE_YEAR, BASE_YEAR - 1];

const API_KEY = String(process.env.DART_API_KEY || process.env.OPENDART_API_KEY || "").trim();
if (!API_KEY) {
  console.error("DART_API_KEY가 없습니다. GitHub Actions에서 실행하세요.");
  process.exit(1);
}

/** 주요계정에서 찾을 항목. 금융·지주사는 "매출액" 대신 "영업수익"으로 신고한다. */
const BS_ACCOUNTS = {
  totalLiabilities: ["부채총계"],
  totalEquity: ["자본총계"],
  currentAssets: ["유동자산"],
  currentLiabilities: ["유동부채"],
};
const IS_ACCOUNTS = {
  revenue: ["매출액", "영업수익", "수익(매출액)"],
  operatingProfit: ["영업이익", "영업이익(손실)"],
  netProfit: ["당기순이익", "당기순이익(손실)", "당기순손익"],
};

function parseAmount(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/,/g, "").replace(/\s/g, "");
  if (!s || s === "-") return null;
  let neg = false;
  let body = s;
  if (/^[-△▲]/.test(body)) {
    neg = true;
    body = body.slice(1);
  } else if (/^\(.*\)$/.test(body)) {
    neg = true;
    body = body.slice(1, -1);
  }
  if (!/^\d+(\.\d+)?$/.test(body)) return null;
  const n = Number(body);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

async function dartFetch(corpCode, year) {
  const url = new URL(DART_BASE);
  url.searchParams.set("crtfc_key", API_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(year));
  url.searchParams.set("reprt_code", REPRT_ANNUAL);
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "TotalMoneyAI/1.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { list: null, rateLimited: false };
  }
  if (!res.ok) return { list: null, rateLimited: res.status === 429 };
  const json = await res.json().catch(() => null);
  // "000"=정상, "013"=조회 데이터 없음(미제출), "020"=일일 한도 초과
  if (!json) return { list: null, rateLimited: false };
  if (json.status === "020") return { list: null, rateLimited: true };
  if (json.status !== "000" || !Array.isArray(json.list) || !json.list.length) {
    return { list: null, rateLimited: false };
  }
  return { list: json.list, rateLimited: false };
}

/** 연결(CFS)이 있으면 연결, 없으면 개별(OFS). 섞지 않는다. */
function pickFsRows(list) {
  const cfs = list.filter((r) => r && r.fs_div === "CFS");
  if (cfs.length) return { rows: cfs, fsLabel: "연결" };
  const ofs = list.filter((r) => r && r.fs_div === "OFS");
  if (ofs.length) return { rows: ofs, fsLabel: "개별" };
  return { rows: list, fsLabel: "" };
}

const norm = (s) => String(s || "").replace(/\s/g, "");

function findAmount(rows, names, sjDivs) {
  const scoped = rows.filter((r) => r && sjDivs.includes(r.sj_div));
  const pool = scoped.length ? scoped : rows;
  for (const want of names) {
    const hit = pool.find((r) => norm(r.account_nm) === norm(want));
    if (hit) {
      const v = parseAmount(hit.thstrm_amount);
      if (v != null) return v;
    }
  }
  return null;
}

/** 분모가 0 이하면 비율을 만들지 않는다(위 헤더 주석의 원칙 2 참고). */
function ratio(numerator, denominator, digits) {
  if (numerator == null || denominator == null) return null;
  if (!(denominator > 0)) return null;
  const v = (numerator / denominator) * 100;
  if (!Number.isFinite(v)) return null;
  const f = Math.pow(10, digits == null ? 1 : digits);
  return Math.round(v * f) / f;
}

function buildRatios(list) {
  const { rows, fsLabel } = pickFsRows(list);
  const bs = {};
  for (const [key, names] of Object.entries(BS_ACCOUNTS)) bs[key] = findAmount(rows, names, ["BS"]);
  const is = {};
  for (const [key, names] of Object.entries(IS_ACCOUNTS)) is[key] = findAmount(rows, names, ["IS", "CIS"]);

  const out = {
    debtRatio: ratio(bs.totalLiabilities, bs.totalEquity, 1),
    operatingMargin: ratio(is.operatingProfit, is.revenue, 2),
    netMargin: ratio(is.netProfit, is.revenue, 2),
    roe: ratio(is.netProfit, bs.totalEquity, 2),
    currentRatio: ratio(bs.currentAssets, bs.currentLiabilities, 1),
  };
  // 비율이 하나도 안 나오면 그 종목은 통째로 생략한다(빈 껍데기를 캐시에 넣지 않는다).
  const filled = Object.values(out).filter((v) => v != null).length;
  if (!filled) return null;
  out.fs = fsLabel || null;
  return out;
}

async function runPool(items, worker, concurrency) {
  let idx = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const corpMapFile = JSON.parse(fs.readFileSync(CORP_MAP_PATH, "utf8"));
  const map = corpMapFile.map || {};
  let codes = Object.keys(map).sort();
  if (LIMIT > 0) codes = codes.slice(0, LIMIT);
  console.log(`대상 ${codes.length}종목 · 회계연도 후보 ${YEAR_CANDIDATES.join(", ")}`);

  const stocks = {};
  const yearCount = {};
  let done = 0;
  let rateLimitHit = false;

  await runPool(
    codes,
    async (code6) => {
      done += 1;
      if (done % 250 === 0) console.log(`  진행 ${done}/${codes.length} · 수집 ${Object.keys(stocks).length}`);
      if (rateLimitHit) return;
      const corpCode = map[code6];
      if (!corpCode) return;
      for (const year of YEAR_CANDIDATES) {
        const { list, rateLimited } = await dartFetch(corpCode, year);
        if (rateLimited) {
          rateLimitHit = true;
          return;
        }
        if (!list) continue;
        const ratios = buildRatios(list);
        if (ratios) {
          ratios.year = year;
          stocks[code6] = ratios;
          yearCount[year] = (yearCount[year] || 0) + 1;
        }
        return; // 데이터를 받은 연도에서 멈춘다(못 만들었어도 전년도로 되돌아가지 않는다)
      }
    },
    CONCURRENCY
  );

  if (rateLimitHit) {
    console.error("::error::DART 일일 호출 한도 초과 — 기존 파일을 건드리지 않고 종료합니다.");
    process.exit(1);
  }

  const collected = Object.keys(stocks).length;
  if (collected < codes.length * 0.3) {
    // 정상이면 상장사의 대부분이 사업보고서를 낸다. 3할도 안 되면 DART 장애나 파싱 회귀를
    // 의심해야 하므로, 멀쩡한 기존 파일을 부실한 결과로 덮어쓰지 않고 실패시킨다.
    console.error(`::error::수집률이 비정상적으로 낮습니다(${collected}/${codes.length}) — 덮어쓰지 않고 종료`);
    process.exit(1);
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "DART fnlttSinglAcnt (사업보고서 · 최근 결산)",
    fiscalYears: yearCount,
    count: collected,
    // 화면·판정 양쪽이 같은 정의를 보도록 여기에 계산식을 남긴다.
    formulas: {
      debtRatio: "부채총계 / 자본총계 × 100",
      operatingMargin: "영업이익 / 매출액 × 100",
      netMargin: "당기순이익 / 매출액 × 100",
      roe: "당기순이익 / 자본총계 × 100",
      currentRatio: "유동자산 / 유동부채 × 100",
    },
    stocks,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload), "utf8");
  const size = fs.statSync(OUT_PATH).size;
  console.log(`완료: ${collected}종목 · ${(size / 1024).toFixed(0)}KB · 연도분포 ${JSON.stringify(yearCount)}`);
  const sample = Object.entries(stocks).slice(0, 3);
  for (const [c, r] of sample) console.log(`  샘플 ${c}:`, JSON.stringify(r));
}

main().catch((e) => {
  console.error("::error::재무비율 수집 실패:", e && e.message);
  process.exit(1);
});
