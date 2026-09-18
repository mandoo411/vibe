/**
 * 종가베팅 "재료" 팩터 — 당일 DART 공시 기반, 2026-09-18 신설.
 *
 * lib/close-betting-score.js의 factorCatalyst(D. 재료, 만점 20)는 이미 준비돼 있었지만
 * row.catalyst를 채워주는 쪽이 없어 항상 미반영이었다. 이 모듈이 그 자리를 채운다.
 *
 * 설계 원칙:
 *  · AI가 "이 공시는 호재다"라고 판단하지 않는다. DART 공시 **제목**을 사실 그대로
 *    보여주고, 제목 텍스트를 규칙(정규식)으로 분류한다 — 할루시네이션 여지가 없다.
 *  · corp_code는 scripts/dart-corp-map.mjs가 매일 생성하는 data/dart-corp-map.json
 *    (상장사 전체 매핑, ~4,000건)을 그대로 쓴다. 종가베팅 후보는 매일 종목이 바뀌므로
 *    dart-events.mjs의 고정 워치리스트 방식은 못 쓴다.
 *  · **하드필터를 통과한 후보 전원에게** 붙여야 한다(present:false여도 붙인다) —
 *    일부만 붙으면 종목마다 채점 분모(max)가 달라져 순위가 왜곡된다
 *    (close-betting-score.js 상단 주석 참조). DART_API_KEY 자체가 없을 때만
 *    전원 스킵해 분모를 균일하게 유지한다.
 *  · 유상증자는 title만으로 제3자배정/일반공모를 구분할 수 없어(본문을 더 읽어야 함)
 *    일괄 caution으로 분류한다 — 잘못된 호재 판정보다 안전한 쪽을 택함.
 *
 * 필수 env: DART_API_KEY (없으면 조용히 빈 Map을 돌려준다 — 스캔 자체는 막지 않음)
 */
const fs = require("node:fs");
const path = require("node:path");

const API_KEY = String(process.env.DART_API_KEY || "").trim();
const CORP_MAP_PATH = path.resolve(process.env.DART_CORP_MAP_PATH || "data/dart-corp-map.json");
const REQUEST_GAP_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let corpMapCache = null;
function loadCorpMap() {
  if (corpMapCache) return corpMapCache;
  try {
    const raw = JSON.parse(fs.readFileSync(CORP_MAP_PATH, "utf8"));
    corpMapCache = raw.map || {};
  } catch (error) {
    console.warn(`[catalyst] dart-corp-map.json 로드 실패 — 재료 전체 스킵: ${error.message}`);
    corpMapCache = {};
  }
  return corpMapCache;
}

async function dartFetchJson(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "TotalMoneyAI/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DART HTTP ${res.status}`);
  return JSON.parse(text);
}

async function fetchTodayDisclosures(corpCode, todayCompact) {
  const url = new URL("https://opendart.fss.or.kr/api/list.json");
  url.searchParams.set("crtfc_key", API_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bgn_de", todayCompact);
  url.searchParams.set("end_de", todayCompact);
  url.searchParams.set("page_count", "20");
  const payload = await dartFetchJson(url);
  if (payload.status === "013") return []; // 조회된 데이터 없음(정상 — 오늘 공시 없음)
  if (payload.status !== "000") throw new Error(`list.json status=${payload.status}: ${payload.message || ""}`);
  return Array.isArray(payload.list) ? payload.list : [];
}

/* 제목 분류 규칙. 순서대로 검사해 먼저 맞는 것을 채택한다.
 * positive만 factorCatalyst의 score>0으로 이어진다. caution은 score 0이지만
 * summary에 "⚠"를 붙여 화면에 보이게 한다(감점이 아니라 정보 제공 — 순수 하드필터
 * +팩터 구조를 깨지 않기 위해 채점에는 반영하지 않는다). */
const POSITIVE_RULES = [
  { re: /공급계약/, score: 15, grade: "공급계약·수주" },
  { re: /무상증자결정/, score: 15, grade: "무상증자" },
  { re: /기술이전|라이선스\s*계약/, score: 15, grade: "기술이전·라이선스" },
  { re: /특허/, score: 10, grade: "특허" },
  { re: /자기주식.*취득결정/, score: 10, grade: "자사주 취득" },
];
const CAUTION_RULES = [
  { re: /불성실공시/, grade: "불성실공시" },
  { re: /관리종목/, grade: "관리종목 지정" },
  { re: /상장폐지/, grade: "상장폐지 관련" },
  { re: /소송/, grade: "소송" },
  { re: /횡령|배임/, grade: "횡령·배임" },
  { re: /감사의견/, grade: "감사의견 이슈" },
  { re: /유상증자결정/, grade: "유상증자(배정방법 미확인)" },
  { re: /최대주주.*변경/, grade: "최대주주 변경" },
];

/** report_nm 앞의 "[기재정정]" 등 대괄호 태그를 모두 떼어낸다(dart-events.mjs와 동일 처리). */
function stripReportTags(reportName) {
  return String(reportName || "").replace(/^(\[.*?\]\s*)+/, "");
}

function classify(reportNameRaw) {
  const reportName = stripReportTags(reportNameRaw);
  for (const rule of POSITIVE_RULES) {
    if (rule.re.test(reportName)) return { kind: "positive", score: rule.score, grade: rule.grade, reportName };
  }
  for (const rule of CAUTION_RULES) {
    if (rule.re.test(reportName)) return { kind: "caution", score: 0, grade: rule.grade, reportName };
  }
  return null;
}

const NO_CATALYST = Object.freeze({ present: false, score: 0, summary: "재료 없음" });

/**
 * @param {{code:string,name:string}[]} candidates 하드필터 통과 종목(전원)
 * @param {string} todayYmd "YYYY-MM-DD"
 * @returns {Promise<Map<string, object>>} code -> catalyst({present,score,summary,grade?,reportName?,kind?})
 *          DART_API_KEY가 없으면 빈 Map(호출부가 그 경우 row.catalyst를 아예 안 붙이게 해
 *          모든 종목이 균일하게 재료 팩터에서 빠진다).
 */
async function fetchCatalystsForCandidates(candidates, todayYmd) {
  const result = new Map();
  if (!API_KEY) {
    console.log("[catalyst] DART_API_KEY 없음 — 재료 팩터 전체 스킵(균일 분모 유지)");
    return result;
  }
  const corpMap = loadCorpMap();
  const todayCompact = String(todayYmd).replace(/-/g, "");
  let hitCount = 0;

  for (const cand of candidates) {
    const corpCode = corpMap[cand.code];
    if (!corpCode) {
      result.set(cand.code, NO_CATALYST);
      continue;
    }
    try {
      const list = await fetchTodayDisclosures(corpCode, todayCompact);
      const hits = [];
      for (const row of list) {
        const cls = classify(row.report_nm);
        if (cls) hits.push(cls);
      }
      if (hits.length === 0) {
        result.set(cand.code, NO_CATALYST);
      } else {
        hits.sort((a, b) => b.score - a.score);
        const best = hits[0];
        result.set(cand.code, {
          present: best.kind === "positive",
          score: best.score,
          grade: best.grade,
          summary: best.kind === "caution" ? `⚠ ${best.grade}` : best.grade,
          reportName: best.reportName,
          kind: best.kind,
        });
        hitCount += 1;
      }
    } catch (error) {
      console.warn(`[catalyst] ${cand.name || ""}(${cand.code}) 공시 조회 실패 — 재료 없음으로 처리: ${error.message}`);
      result.set(cand.code, NO_CATALYST); // 실패해도 분모를 지키기 위해 "없음"으로 채운다
    }
    await sleep(REQUEST_GAP_MS);
  }
  console.log(`[catalyst] 후보 ${candidates.length}종목 중 재료 검출 ${hitCount}건`);
  return result;
}

module.exports = { fetchCatalystsForCandidates, classify, stripReportTags };
