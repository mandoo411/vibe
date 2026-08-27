/**
 * DART(전자공시) Open API 기반 "다가오는 이벤트" 수집 → data/dart-events.json
 *
 * 배경: AI 종목분석의 "다가오는 이벤트" 섹션이 web_search/뉴스 기반이라 이미
 * 지난 뉴스를 미래 일정처럼 보여주는 사고가 반복됐다(2026-08-27 세션). 그래서
 * 이 섹션의 KR 종목 이벤트는 이제 AI가 만들지 않고, 이 배치가 매일 1회 DART
 * 공식 공시에서 실제 날짜를 뽑아 캐싱한 값만 그대로 노출한다(api/analyze.js
 * normalizeAnalysis에서 KR 종목은 이 데이터로 덮어씀).
 *
 * 신뢰도 등급 (source 필드):
 * - "dart"          : DART 구조화 API(숫자/날짜 필드 그대로) 또는 공시원문에서
 *                      정규식으로 뽑은 날짜. 정규식 파싱은 실패 시 그냥 버리고
 *                      절대 추측하지 않는다(아래 extractAgmDate/extractDividendRecordDate).
 * - "dart-computed" : 실제 공시가 아니라 자본시장법 제출기한 규정(사업연도 종료
 *                      후 45일/90일 이내)으로 코드가 계산한 "예상 구간". 통계나
 *                      실제 확정 일정이 아님을 content에 명시한다.
 *
 * 스코프: earnings-calendar.mjs의 KR_CODES(대형주 위주 고정 워치리스트)만 다룬다.
 * 워치리스트 밖 종목은 이 파일에 데이터가 없고, api/analyze.js는 그 경우 그냥
 * "예정된 주요 일정 없음"으로 비워둔다(뉴스로 억지로 채우지 않음).
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readZipEntries } from "./dart-zip-utils.mjs";
import { KR_CODES, seoulYmd, addDaysYmd, seoulStamp } from "./earnings-calendar.mjs";

const OUTPUT_PATH = path.resolve(process.env.DART_EVENTS_OUTPUT_PATH || "data/dart-events.json");
const CORP_CODE_CACHE_PATH = path.resolve("data/dart-corp-codes.json");
const API_KEY = String(process.env.DART_API_KEY || "").trim();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ymdCompact(ymd) {
  return String(ymd || "").replace(/-/g, "");
}

function normalizeDartDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m8 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m8) return `${m8[1]}-${m8[2]}-${m8[3]}`;
  const mdash = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mdash) return s;
  return null;
}

async function dartFetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "TotalMoneyAI/1.0" },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DART HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function dartFetchBuffer(url, timeoutMs = 30000) {
  const res = await fetch(url, {
    headers: { "user-agent": "TotalMoneyAI/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`DART HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---------------- corp_code (고유번호) 매핑 ----------------

/** corp_code(DART 고유번호) 매핑 — 워치리스트(KR_CODES)만 필요.
 *
 * 원래는 DART가 제공하는 전체 법인 목록(corpCode.xml, 8만7천개 법인 zip)을
 * 통째로 받아서 매핑을 만들려고 했으나, 실제 GitHub Actions 환경에서 이
 * 대용량 엔드포인트가 120초를 줘도 계속 타임아웃났다(2회 확인) — list.json 같은
 * 작은 JSON API는 같은 환경에서 이미 weekly-schedule.mjs가 매일 문제없이 쓰고
 * 있어서, DART 쪽에서 대용량 zip 엔드포인트만 유독 느리거나 제한을 거는 것으로
 * 보인다. 우리는 어차피 워치리스트 15종목만 있으면 되므로, corp_code가 없어도
 * 쓸 수 있는 list.json(공시검색)을 넉넉한 기간으로 스캔해서 각 종목이 낸 아무
 * 공시에서나 corp_code를 뽑아내는 방식으로 우회한다 — corp_code는 한 번 알아내면
 * 절대 안 바뀌는 값이라 로컬 캐시(30일)로 재사용한다. */
async function loadOrRefreshCorpCodeMap() {
  try {
    const raw = await fs.readFile(CORP_CODE_CACHE_PATH, "utf8");
    const cached = JSON.parse(raw);
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    const wanted = Object.keys(KR_CODES);
    const have = cached.map ? wanted.filter((c) => cached.map[c]) : [];
    if (age < 30 * 24 * 3600 * 1000 && have.length === wanted.length) {
      console.log(`corp_code 캐시 재사용 (워치리스트 ${have.length}/${wanted.length}건, ${Math.round(age / 86400000)}일 전)`);
      return cached.map;
    }
  } catch {
    // 캐시 없음/손상 — 새로 받는다
  }

  console.log("corp_code 매핑 — list.json 스캔으로 워치리스트만 알아내는 중...");
  const map = {};
  const wanted = new Set(Object.keys(KR_CODES));
  const today = seoulYmd();
  // 실제로 확인함: corp_code 없이 list.json을 부르면 검색기간이 "3개월"로 하드
  // 캡핑되어 있어서(status=100 에러로 거부) 그냥 시작일을 뒤로 넓히면 안 되고,
  // 3개월짜리 구간을 연속으로 이어붙여서 스캔해야 한다 (0~3개월 전, 3~6개월 전, ...).
  const windows = [];
  for (let i = 0; i < 4; i += 1) {
    windows.push({
      bgn: ymdCompact(addDaysYmd(today, -(i + 1) * 90)),
      end: ymdCompact(addDaysYmd(today, -i * 90 - (i === 0 ? 0 : 1))),
    });
  }
  for (const { bgn, end } of windows) {
    if (wanted.size === 0) break;
    console.log(`  스캔 구간 ${bgn}~${end} (남은 종목 ${wanted.size}개: ${[...wanted].join(",")})`);
    let page = 1;
    let totalPage = 1;
    while (page <= totalPage && page <= 60 && wanted.size > 0) {
      const url = new URL("https://opendart.fss.or.kr/api/list.json");
      url.searchParams.set("crtfc_key", API_KEY);
      url.searchParams.set("bgn_de", bgn);
      url.searchParams.set("end_de", end);
      url.searchParams.set("page_no", String(page));
      url.searchParams.set("page_count", "100");
      let payload;
      try {
        payload = await dartFetchJson(url);
      } catch (error) {
        console.log(`    ⚠️ list.json page=${page} 실패: ${error.message}`);
        break;
      }
      if (payload.status === "013") break;
      if (payload.status !== "000") {
        console.log(`    ⚠️ list.json status=${payload.status}: ${payload.message || ""}`);
        break;
      }
      totalPage = Number(payload.total_page) || 1;
      for (const row of payload.list || []) {
        const stockCode = String(row.stock_code || "").trim();
        if (stockCode && wanted.has(stockCode) && row.corp_code) {
          map[stockCode] = String(row.corp_code).trim();
          wanted.delete(stockCode);
        }
      }
      page += 1;
    }
  }

  if (wanted.size > 0) {
    console.log(`  ⚠️ corp_code를 못 찾은 워치리스트 종목: ${[...wanted].map((c) => `${KR_CODES[c]}(${c})`).join(", ")} — 이 종목들은 이번 실행에서 이벤트 skip`);
  }
  if (Object.keys(map).length === 0) {
    throw new Error("corp_code 매핑 결과가 0건 — list.json 스캔 실패 의심");
  }

  await fs.mkdir(path.dirname(CORP_CODE_CACHE_PATH), { recursive: true });
  await fs.writeFile(
    CORP_CODE_CACHE_PATH,
    JSON.stringify({ fetchedAt: new Date().toISOString(), count: Object.keys(map).length, map }),
    "utf8"
  );
  console.log(`corp_code 매핑 ${Object.keys(map).length}/${Object.keys(KR_CODES).length}건 저장`);
  return map;
}

// ---------------- 정기보고서 주요정보: 배당/기업개황 등 ----------------

async function fetchCompanyInfo(corpCode) {
  const url = new URL("https://opendart.fss.or.kr/api/company.json");
  url.searchParams.set("crtfc_key", API_KEY);
  url.searchParams.set("corp_code", corpCode);
  const payload = await dartFetchJson(url);
  if (payload.status !== "000") return null;
  return {
    accMt: String(payload.acc_mt || "12").padStart(2, "0"),
    corpName: payload.corp_name || "",
  };
}

// ---------------- 공시검색 (list.json) ----------------

async function fetchDisclosureList(corpCode, bgnDeCompact, endDeCompact) {
  const out = [];
  let page = 1;
  let totalPage = 1;
  while (page <= totalPage && page <= 10) {
    const url = new URL("https://opendart.fss.or.kr/api/list.json");
    url.searchParams.set("crtfc_key", API_KEY);
    url.searchParams.set("corp_code", corpCode);
    url.searchParams.set("bgn_de", bgnDeCompact);
    url.searchParams.set("end_de", endDeCompact);
    url.searchParams.set("page_no", String(page));
    url.searchParams.set("page_count", "100");
    const payload = await dartFetchJson(url);
    if (payload.status === "013") break; // 조회된 데이터 없음 — 정상
    if (payload.status !== "000") throw new Error(`list.json status=${payload.status}: ${payload.message || ""}`);
    totalPage = Number(payload.total_page) || 1;
    out.push(...(Array.isArray(payload.list) ? payload.list : []));
    page += 1;
  }
  return out;
}

// ---------------- 자기주식 취득/처분 결정 (구조화 API) ----------------

async function fetchBuybackEvents(corpCode, bgnDeCompact, endDeCompact, todayISO) {
  const events = [];
  const specs = [
    { endpoint: "tsstkAqDecsn", bgField: "aqexpd_bgd", edField: "aqexpd_edd", qtyField: "aqpln_stk_ostk", verb: "취득", type: "호재" },
    { endpoint: "tsstkDpDecsn", bgField: "dpprpd_bgd", edField: "dpprpd_edd", qtyField: "dppln_stk_ostk", verb: "처분", type: "neutral" },
  ];
  for (const spec of specs) {
    const url = new URL(`https://opendart.fss.or.kr/api/${spec.endpoint}.json`);
    url.searchParams.set("crtfc_key", API_KEY);
    url.searchParams.set("corp_code", corpCode);
    url.searchParams.set("bgn_de", bgnDeCompact);
    url.searchParams.set("end_de", endDeCompact);
    let payload;
    try {
      payload = await dartFetchJson(url);
    } catch (error) {
      console.log(`    ⚠️ ${spec.endpoint} 요청 실패: ${error.message}`);
      continue;
    }
    if (payload.status === "013") continue;
    if (payload.status !== "000") {
      console.log(`    ⚠️ ${spec.endpoint} status=${payload.status}: ${payload.message || ""}`);
      continue;
    }
    for (const row of payload.list || []) {
      const edd = normalizeDartDate(row[spec.edField]);
      const bgd = normalizeDartDate(row[spec.bgField]);
      if (!edd || edd <= todayISO) continue; // 이미 종료됐거나 오늘까지인 프로그램은 미래 이벤트가 아님
      const qtyRaw = Number(row[spec.qtyField]);
      const qtyText = Number.isFinite(qtyRaw) && qtyRaw > 0 ? ` (약 ${qtyRaw.toLocaleString("ko-KR")}주)` : "";
      events.push({
        type: spec.type,
        content: `자기주식 ${spec.verb} 기간이 ${bgd || "공시 기준일"}부터 ${edd}까지로 공시됐다${qtyText}.`,
        date: edd,
        source: "dart",
        certainty: "확정",
      });
    }
  }
  return events;
}

// ---------------- 공시 원문 파싱: 주주총회 개최일 / 배당기준일 ----------------

async function fetchDocumentText(rceptNo) {
  const url = new URL("https://opendart.fss.or.kr/api/document.xml");
  url.searchParams.set("crtfc_key", API_KEY);
  url.searchParams.set("rcept_no", rceptNo);
  const buf = await dartFetchBuffer(url, 45000);
  const entries = readZipEntries(buf);
  return Object.values(entries)
    .map((b) => b.toString("utf8"))
    .join("\n");
}

function stripTags(xmlOrHtml) {
  return String(xmlOrHtml || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findDateNear(plainText, anchorRe, windowChars, todayISO, maxISO, debugLabel) {
  // 앵커 문구(예: "배당기준일")가 문서 안에 여러 번 나올 수 있다 — 실제로 SK하이닉스
  // 사례에서 첫 번째 등장은 "배당기준일 확정을 위한 건임"처럼 날짜 없는 설명문이고,
  // 진짜 날짜는 뒤쪽에 따로 나오는 걸 로그로 확인했다. 첫 매치에서 포기하지 않고
  // 모든 등장 위치를 순서대로 시도해서, 유효한(미래+범위 내) 날짜를 주는 첫 번째
  // 위치를 채택한다.
  const globalRe = new RegExp(anchorRe.source, anchorRe.flags.includes("g") ? anchorRe.flags : `${anchorRe.flags}g`);
  const positions = [...plainText.matchAll(globalRe)].map((m) => m.index);
  if (positions.length === 0) {
    if (debugLabel) console.log(`    [debug:${debugLabel}] 앵커 문구 자체를 원문에서 못 찾음`);
    return null;
  }
  let lastFailReason = "";
  for (const idx of positions) {
    const windowText = plainText.slice(idx, idx + windowChars);
    const m = windowText.match(/(\d{4})\s*[.\-년]\s*(\d{1,2})\s*[.\-월]\s*(\d{1,2})/);
    if (!m) {
      lastFailReason = `날짜 패턴 매칭 실패. 주변 텍스트: ${JSON.stringify(windowText.slice(0, 90))}`;
      continue;
    }
    const iso = `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
    if (iso <= todayISO || iso > maxISO) {
      lastFailReason = `날짜는 뽑았지만(${iso}) 범위 밖(오늘=${todayISO}, 상한=${maxISO})`;
      continue;
    }
    if (debugLabel) {
      console.log(`    [debug:${debugLabel}] 성공(${positions.indexOf(idx) + 1}/${positions.length}번째 등장) → ${iso}. 주변 텍스트: ${JSON.stringify(windowText.slice(0, 90))}`);
    }
    return iso;
  }
  if (debugLabel) console.log(`    [debug:${debugLabel}] 앵커 ${positions.length}곳 등장했지만 전부 실패. 마지막 사유: ${lastFailReason}`);
  return null;
}

function extractAgmDate(rawText, todayISO, maxISO) {
  const plain = stripTags(rawText);
  return (
    findDateNear(plain, /회의\s*일시/, 40, todayISO, maxISO, "agm:회의일시") ||
    findDateNear(plain, /개최\s*일시/, 40, todayISO, maxISO, "agm:개최일시") ||
    findDateNear(plain, /주주총회\s*일시/, 40, todayISO, maxISO, "agm:주주총회일시")
  );
}

function extractDividendRecordDate(rawText, todayISO, maxISO) {
  const plain = stripTags(rawText);
  return findDateNear(plain, /배당\s*기준\s*일/, 40, todayISO, maxISO, "dividend:배당기준일");
}

// ---------------- 실적발표 예상 시기 (제출기한 규정 기반 계산) ----------------

function quarterEndsForYear(year, accMtNum) {
  const ends = [];
  for (let k = 1; k <= 4; k += 1) {
    let m = accMtNum - 12 + k * 3;
    let y = year;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    while (m > 12) {
      m -= 12;
      y += 1;
    }
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    ends.push({ ymd: `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`, isAnnual: k === 4 });
  }
  return ends;
}

async function fetchFiledPeriodicReportDates(corpCode, bgnDeYmd, endDeYmd) {
  const list = await fetchDisclosureList(corpCode, ymdCompact(bgnDeYmd), ymdCompact(endDeYmd));
  const EARNINGS_RE = /^(분기|반기|사업)보고서/;
  return list
    .filter((r) => EARNINGS_RE.test(String(r.report_nm || "").replace(/^\[.*?\]\s*/, "")))
    .map((r) => normalizeDartDate(r.rcept_dt))
    .filter(Boolean);
}

async function computeExpectedEarningsWindow(corpCode, todayISO) {
  const info = await fetchCompanyInfo(corpCode);
  const accMt = Number((info && info.accMt) || "12");
  const year = Number(todayISO.slice(0, 4));
  const seen = new Set();
  const candidateEnds = [year - 1, year, year + 1]
    .flatMap((y) => quarterEndsForYear(y, accMt))
    .filter((q) => (seen.has(q.ymd) ? false : (seen.add(q.ymd), true)))
    .sort((a, b) => a.ymd.localeCompare(b.ymd));

  const filedDates = await fetchFiledPeriodicReportDates(corpCode, addDaysYmd(todayISO, -400), todayISO);

  for (const q of candidateEnds) {
    if (q.ymd > todayISO) continue; // 분기가 아직 안 끝났으면 "다음 실적발표" 대상 아님
    const deadlineDays = q.isAnnual ? 90 : 45;
    const deadline = addDaysYmd(q.ymd, deadlineDays);
    if (deadline <= todayISO) continue; // 제출기한도 이미 지남 (그 분기는 처리 완료로 간주)
    const alreadyFiled = filedDates.some((d) => d > q.ymd && d <= deadline);
    if (alreadyFiled) continue;
    const windowStart = addDaysYmd(q.ymd, 1);
    const label = q.isAnnual ? "사업보고서(연간 실적)" : "분기·반기보고서";
    return {
      type: "neutral",
      content: `${label} 제출기한은 자본시장법상 사업연도 종료 후 ${deadlineDays}일 이내(${windowStart}~${deadline} 사이)로 계산된다 — 실제 발표는 이 기간 안에서 이뤄질 전망이다.`,
      date: deadline,
      source: "dart-computed",
      certainty: "추정",
    };
  }
  return null;
}

// ---------------- 종목별 수집 ----------------

async function collectEventsForStock(code, name, corpCode, todayISO) {
  const events = [];
  if (!corpCode) {
    console.log(`  ⚠️ ${name}(${code}) corp_code 매핑 실패 — 이 종목은 skip`);
    return events;
  }

  const bgn180Compact = ymdCompact(addDaysYmd(todayISO, -180));
  const todayCompact = ymdCompact(todayISO);
  const future6mo = addDaysYmd(todayISO, 180);

  try {
    events.push(...(await fetchBuybackEvents(corpCode, bgn180Compact, todayCompact, todayISO)));
  } catch (error) {
    console.log(`  ⚠️ ${name} 자사주 API 실패: ${error.message}`);
  }

  try {
    const bgn45Compact = ymdCompact(addDaysYmd(todayISO, -45));
    const list = await fetchDisclosureList(corpCode, bgn45Compact, todayCompact);
    for (const row of list) {
      const reportName = String(row.report_nm || "");
      const rcept = row.rcept_no;
      if (!rcept) continue;

      if (/주주총회/.test(reportName)) {
        try {
          const text = await fetchDocumentText(rcept);
          const iso = extractAgmDate(text, todayISO, future6mo);
          if (iso) {
            events.push({
              type: "neutral",
              content: `주주총회 소집 공시가 나왔다 (개최일 ${iso}).`,
              date: iso,
              source: "dart",
              certainty: "확정",
            });
          } else {
            console.log(`  ℹ️ ${name} 주총 공시(rcept=${rcept}) 발견했지만 날짜 파싱 실패/조건 불충족 — 미표시`);
          }
        } catch (error) {
          console.log(`  ⚠️ ${name} 주총 문서(rcept=${rcept}) 처리 실패: ${error.message}`);
        }
        await sleep(200);
      } else if (/배당/.test(reportName) && !/자기주식/.test(reportName)) {
        try {
          const text = await fetchDocumentText(rcept);
          const iso = extractDividendRecordDate(text, todayISO, future6mo);
          if (iso) {
            events.push({
              type: "호재",
              content: `배당 관련 공시가 나왔다 (배당기준일 ${iso}).`,
              date: iso,
              source: "dart",
              certainty: "확정",
            });
          } else {
            console.log(`  ℹ️ ${name} 배당 공시(rcept=${rcept}) 발견했지만 기준일 파싱 실패/조건 불충족 — 미표시`);
          }
        } catch (error) {
          console.log(`  ⚠️ ${name} 배당 문서(rcept=${rcept}) 처리 실패: ${error.message}`);
        }
        await sleep(200);
      }
    }
  } catch (error) {
    console.log(`  ⚠️ ${name} 공시목록 조회 실패: ${error.message}`);
  }

  try {
    const earningsEvent = await computeExpectedEarningsWindow(corpCode, todayISO);
    if (earningsEvent) events.push(earningsEvent);
  } catch (error) {
    console.log(`  ⚠️ ${name} 실적발표 시기 계산 실패: ${error.message}`);
  }

  const seenKeys = new Set();
  const dedup = events.filter((e) => {
    const key = `${e.type}|${e.date}|${e.content}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  dedup.sort((a, b) => a.date.localeCompare(b.date));
  return dedup;
}

// ---------------- 실행 ----------------

async function writeOutput(byCode, status) {
  const data = {
    meta: {
      lastUpdatedKst: seoulStamp(),
      source: "dart",
      status,
      watchlistSize: Object.keys(KR_CODES).length,
    },
    events: byCode,
  };
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${OUTPUT_PATH}`);
}

async function main() {
  if (!API_KEY) {
    console.log("⚠️ DART_API_KEY 없음 — 빈 결과로 종료");
    await writeOutput({}, "no_api_key");
    return;
  }

  const today = seoulYmd();
  const corpMap = await loadOrRefreshCorpCodeMap();
  const result = {};

  for (const [code, name] of Object.entries(KR_CODES)) {
    console.log(`\n[${name} ${code}] 이벤트 수집 중...`);
    try {
      result[code] = await collectEventsForStock(code, name, corpMap[code], today);
      console.log(`  → ${result[code].length}건`);
    } catch (error) {
      console.log(`  ❌ ${name} 전체 실패: ${error.message}`);
      result[code] = [];
    }
    await sleep(300);
  }

  await writeOutput(result, "ok");
}

main().catch((error) => {
  console.error("dart-events.mjs 실패:", error);
  process.exitCode = 1;
});
