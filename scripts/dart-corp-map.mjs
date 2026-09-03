/**
 * DART corp_code(고유번호) ↔ 종목코드 전체 매핑 → data/dart-corp-map.json
 *
 * 배경: DART Open API는 어떤 재무·공시 조회든 corp_code(8자리 DART 고유번호)를
 * 요구하는데, 우리가 아는 건 종목코드(6자리)뿐이다. 지금까지 `scripts/dart-events.mjs`가
 * list.json 공시검색을 종목코드로 스캔해 워치리스트 15종목만 알아내는 방식으로 우회해
 * 왔지만, AI 종목분석은 **임의 종목**을 다루므로 상장사 전체 매핑이 필요하다.
 *
 * 과거 실패 이력(2026-08-28): corpCode.xml(87,000여 법인 zip) 다운로드가 GitHub
 * Actions에서 계속 타임아웃돼 포기했었다. 원인은 파일 크기가 아니라 **fetch에 걸어둔
 * 30초 AbortSignal**이었을 가능성이 높다(같은 코드가 document.xml 수백 KB에는 잘
 * 동작했다). 그래서 이번엔:
 *   - 타임아웃을 180초로 늘리고
 *   - 3회까지 지수 백오프 재시도하고
 *   - 받은 zip이 XML 에러 응답("status":"013" 등)인지 먼저 확인하고
 *   - 상장사(stock_code가 있는 행)만 추려 파일 크기를 100KB대로 줄인다.
 *
 * 실패해도 기존 파일을 덮어쓰지 않는다(빈 결과를 커밋해 서비스를 죽이지 않기 위해).
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readZipEntries } from "./dart-zip-utils.mjs";

const OUTPUT_PATH = path.resolve(process.env.DART_CORP_MAP_OUTPUT_PATH || "data/dart-corp-map.json");
const API_KEY = String(process.env.DART_API_KEY || "").trim();
const DOWNLOAD_URL = "https://opendart.fss.or.kr/api/corpCode.xml";
const FETCH_TIMEOUT_MS = 180000;
const MAX_ATTEMPTS = 3;

/** 최소 이 개수는 나와야 정상으로 본다. 상장사(코스피+코스닥+코넥스)는 2,500~3,000건대다.
 *  이보다 적으면 파싱이 깨졌거나 DART가 반쪽짜리 응답을 준 것이므로 커밋하지 않는다. */
const MIN_EXPECTED_LISTED = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadCorpCodeZip() {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const url = new URL(DOWNLOAD_URL);
      url.searchParams.set("crtfc_key", API_KEY);
      console.log(`corpCode.xml 다운로드 시도 ${attempt}/${MAX_ATTEMPTS} (타임아웃 ${FETCH_TIMEOUT_MS / 1000}초)...`);
      const started = Date.now();
      const res = await fetch(url, {
        headers: { "user-agent": "TotalMoneyAI/1.0" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`  ← ${(buf.length / 1024 / 1024).toFixed(1)}MB, ${((Date.now() - started) / 1000).toFixed(1)}초`);

      // DART는 인증 실패·한도 초과 시 zip이 아니라 XML/JSON 에러 본문을 200으로 준다.
      const head = buf.subarray(0, 4).toString("latin1");
      if (head !== "PK") {
        throw new Error(`zip이 아닌 응답: ${buf.subarray(0, 300).toString("utf8")}`);
      }
      return buf;
    } catch (error) {
      lastError = error;
      console.warn(`  ⚠️ 실패: ${error && error.message}`);
      if (attempt < MAX_ATTEMPTS) {
        const wait = 5000 * attempt;
        console.log(`  ${wait / 1000}초 후 재시도`);
        await sleep(wait);
      }
    }
  }
  throw lastError || new Error("corpCode.xml 다운로드 실패");
}

/** CORPCODE.xml에서 <list>…</list> 블록을 훑어 상장사만 추린다.
 *  8만 7천 건을 정규식 전역 매치로 한 번에 배열화하면 메모리를 크게 쓰므로,
 *  exec 루프로 한 건씩 소비한다. */
function parseListedCompanies(xml) {
  const blockRe = /<list>([\s\S]*?)<\/list>/g;
  const pick = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].trim() : "";
  };

  const map = {};
  const names = {};
  let total = 0;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    total += 1;
    const block = m[1];
    const stockCode = pick(block, "stock_code");
    // 비상장 법인은 stock_code가 공백(" ")으로 채워져 온다.
    if (!/^[0-9A-Z]{6}$/.test(stockCode)) continue;
    const corpCode = pick(block, "corp_code");
    if (!/^\d{8}$/.test(corpCode)) continue;
    map[stockCode] = corpCode;
    const name = pick(block, "corp_name");
    if (name) names[stockCode] = name;
  }
  return { map, names, total };
}

async function main() {
  if (!API_KEY) {
    console.error("DART_API_KEY 환경변수가 없습니다 — GitHub Actions secrets에 설정 필요");
    process.exit(1);
  }

  const zipBuf = await downloadCorpCodeZip();
  const entries = readZipEntries(zipBuf);
  const entryName = Object.keys(entries).find((k) => /CORPCODE\.xml$/i.test(k)) || Object.keys(entries)[0];
  if (!entryName) throw new Error("zip 안에 항목이 없음");
  const xml = entries[entryName].toString("utf8");
  console.log(`zip 항목: ${entryName} (${(xml.length / 1024 / 1024).toFixed(1)}MB XML)`);

  const { map, names, total } = parseListedCompanies(xml);
  const count = Object.keys(map).length;
  console.log(`전체 법인 ${total.toLocaleString()}건 중 상장사 ${count.toLocaleString()}건 추출`);

  if (count < MIN_EXPECTED_LISTED) {
    throw new Error(`상장사 ${count}건은 비정상적으로 적습니다(기대 ${MIN_EXPECTED_LISTED}+) — 기존 파일을 지키기 위해 커밋하지 않고 실패 처리`);
  }

  // 종목코드 오름차순으로 고정 정렬 — 매 실행마다 순서가 흔들려 diff가 통째로
  // 바뀌는 걸 막는다(실제 변경분만 커밋에 남게).
  const sortedMap = {};
  const sortedNames = {};
  for (const code of Object.keys(map).sort()) {
    sortedMap[code] = map[code];
    sortedNames[code] = names[code] || "";
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "DART Open API corpCode.xml",
    totalCorporations: total,
    count,
    map: sortedMap,
    names: sortedNames,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 0)}\n`, "utf8");
  const bytes = (await fs.stat(OUTPUT_PATH)).size;
  console.log(`✅ ${OUTPUT_PATH} 저장 (${(bytes / 1024).toFixed(0)}KB)`);

  // 눈으로 바로 확인할 수 있는 샘플 몇 개
  for (const code of ["005930", "000660", "096770", "035420"]) {
    if (sortedMap[code]) console.log(`  ${code} ${sortedNames[code]} → ${sortedMap[code]}`);
  }
}

main().catch((error) => {
  console.error("❌ corp_code 매핑 실패:", error && error.message);
  process.exit(1);
});
