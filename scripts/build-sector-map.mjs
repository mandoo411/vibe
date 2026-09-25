/**
 * 2026-09-25 국내 종목 → 섹터(WICS 10대 섹터) 매핑 파일 생성: data/kr-sector-map.json
 *
 * 홈 섹터 히트맵이 종목을 섹터별로 묶을 때 쓴다. 시세(가격·등락률)는 여기 담지 않는다 —
 * 분류만 담고, 시세는 히트맵이 실시간으로 따로 받는다.
 * 출처: WISEindex WICS 섹터 구성종목(코스피+코스닥 공통). 섹터 편입은 자주 안 바뀌므로
 * sync-market-data.mjs가 파일이 7일 넘게 묵었을 때만 다시 만든다(직접 실행도 가능).
 *
 *   node scripts/build-sector-map.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "kr-sector-map.json");

// WICS 섹터 코드 → 화면 표시 이름(짧게)
export const WICS_SECTORS = {
  G45: "IT",
  G20: "산업재",
  G40: "금융",
  G25: "경기소비재",
  G35: "헬스케어",
  G50: "통신서비스",
  G15: "소재",
  G30: "필수소비재",
  G10: "에너지",
  G55: "유틸리티",
};

function ymdKst(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d).replace(/-/g, "");
}

async function fetchSector(code, ymd) {
  const url = `https://www.wiseindex.com/Index/GetIndexComponets?ceil_yn=0&dt=${ymd}&sec_cd=${code}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; totalmoney-sector-map)" },
  });
  if (!res.ok) throw new Error(`WICS ${code} HTTP ${res.status}`);
  const j = await res.json();
  return Array.isArray(j && j.list) ? j.list : [];
}

export async function buildSectorMap() {
  // 가장 최근 영업일 자료를 찾는다(주말·휴장일이면 빈 목록이 온다)
  let ymd = "";
  for (let back = 0; back < 12; back++) {
    const d = ymdKst(new Date(Date.now() - back * 86400000));
    const probe = await fetchSector("G45", d).catch(() => []);
    if (probe.length) {
      ymd = d;
      break;
    }
  }
  if (!ymd) throw new Error("WICS 구성종목을 찾지 못했습니다(최근 12일).");

  const map = {};
  for (const code of Object.keys(WICS_SECTORS)) {
    const list = await fetchSector(code, ymd);
    if (!list.length) throw new Error(`WICS ${code} 구성종목이 비었습니다(${ymd}).`);
    for (const r of list) {
      const c = String(r.CMP_CD || "").trim().toUpperCase();
      if (/^[0-9A-Z]{6}$/.test(c)) map[c] = code;
    }
  }
  const n = Object.keys(map).length;
  if (n < 1500) throw new Error(`매핑 종목 수가 너무 적습니다(${n}).`);
  const payload = {
    updatedAt: new Date().toISOString(),
    asOf: ymd,
    source: "WICS",
    sectors: WICS_SECTORS,
    count: n,
    map,
  };
  await fs.writeFile(OUT, JSON.stringify(payload) + "\n", "utf8");
  return payload;
}

export async function ensureFreshSectorMap(maxAgeDays = 7) {
  try {
    const cur = JSON.parse(await fs.readFile(OUT, "utf8"));
    const age = Date.now() - Date.parse(cur.updatedAt || 0);
    if (Number.isFinite(age) && age < maxAgeDays * 86400000) return false;
  } catch {
    /* 없으면 새로 만든다 */
  }
  await buildSectorMap();
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSectorMap()
    .then((p) => console.log(`kr-sector-map.json: ${p.count}종목 (WICS ${p.asOf})`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
