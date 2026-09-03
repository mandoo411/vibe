/**
 * 전종목 지표 캐시 → 일자별 경량 스냅샷 아카이브 (백테스트용 원재료)
 *
 * 배경(2026-09-03 로드맵 F): 매매시그널의 가장 큰 구멍은 **백테스트가 불가능하다는 것**이다.
 * `data/kr-screener-cache.json`은 매일 덮어써지기 때문에 "이 전략을 3개월 전에 돌렸으면
 * 뭐가 잡혔을까"를 물어볼 과거 데이터 자체가 존재하지 않는다. 백테스트 기능을 언제
 * 만들든, **데이터는 오늘부터 쌓기 시작해야** 그때 쓸 게 있다. 이 스크립트가 그 첫 단계다.
 *
 * 설계 결정 3가지:
 *
 * 1) **main이 아니라 `data-archive` 브랜치에 쌓는다.**
 *    원본 캐시는 8.2MB다. 이걸 매일 main에 커밋하면 1년이면 저장소가 2GB가 되고,
 *    더 나쁘게는 Vercel 배포에 그 파일들이 전부 업로드된다. 워크플로가 이 스크립트의
 *    결과물을 별도 브랜치로 밀어 넣으므로 main·Vercel 배포는 영원히 영향이 없다.
 *
 * 2) **필요한 열만 CSV로 추리고 gzip한다.** 8.2MB JSON → 60~90KB 정도.
 *    JSON의 키 이름이 행마다 반복되는 게 용량의 대부분이라, 열 이름을 헤더 한 줄로
 *    빼는 것만으로 100배 가까이 줄어든다.
 *
 * 3) **숫자를 반올림한다.** 이평선·가격은 정수, RSI·등락률은 소수 2자리, PER/PBR은
 *    소수 2자리. 백테스트 정확도에 영향이 없는 자릿수는 용량만 먹는다.
 *
 * 사용: node scripts/archive-screener-snapshot.mjs --out <디렉터리>
 *   → <디렉터리>/screener/<YYYY-MM>/<YYYY-MM-DD>.csv.gz
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

const CACHE_PATH = path.resolve(process.env.SCREENER_CACHE_PATH || "data/kr-screener-cache.json");

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * 스냅샷 스키마 v1.
 * 열을 추가할 때는 **반드시 뒤에 붙인다** — 과거 파일은 열 수가 적은 채로 남아있고,
 * 읽는 쪽이 헤더 이름으로 찾게 되어 있어야 예전 파일도 계속 읽힌다.
 * `from`은 행에서 값을 꺼내는 함수, `round`는 소수 자릿수(null이면 정수).
 */
const COLUMNS = [
  { name: "code", from: (r) => r.code, raw: true },
  { name: "market", from: (r) => r.market, raw: true },
  { name: "close", from: (r, s) => pick(s.closeCur, r.close), round: 0 },
  { name: "changePct", from: (r) => r.changePct, round: 2 },
  { name: "marketCapEok", from: (r, s) => pick(r.marketCapEok, s.marketCapEok), round: 0 },
  { name: "tradingValueEok", from: (r, s) => pick(r.tradingValueEok, s.tradingValueEok), round: 0 },
  { name: "per", from: (r, s) => s.per, round: 2 },
  { name: "pbr", from: (r, s) => s.pbr, round: 2 },
  { name: "eps", from: (r, s) => s.eps, round: 0 },
  { name: "foreignHoldRate", from: (r, s) => s.foreignHoldRate, round: 2 },
  { name: "volTurnoverRate", from: (r, s) => s.volTurnoverRate, round: 2 },
  { name: "foreignNetBuy", from: (r, s) => s.foreignNetBuy, round: 0 },
  { name: "institutionNetBuy", from: (r, s) => s.institutionNetBuy, round: 0 },
  { name: "rsi", from: (r, s) => s.rsiCur, round: 2 },
  { name: "ma5", from: (r, s) => s.ma5Cur, round: 0 },
  { name: "ma10", from: (r, s) => s.ma10Cur, round: 0 },
  { name: "ma20", from: (r, s) => s.ma20Cur, round: 0 },
  { name: "ma60", from: (r, s) => s.ma60Cur, round: 0 },
  { name: "ma120", from: (r, s) => s.ma120Cur, round: 0 },
  { name: "ma200", from: (r, s) => s.ma200Cur, round: 0 },
  { name: "ma240", from: (r, s) => s.ma240Cur, round: 0 },
  { name: "volumeRatio", from: (r, s) => s.volumeRatio, round: 2 },
  { name: "high52w", from: (r, s) => s.high52wHigh, round: 0 },
  // 거래정지·정리매매는 백테스트에서 반드시 걸러야 하는 값이라 함께 보존한다.
  { name: "tempStop", from: (r, s) => (s.tempStopYn === true ? 1 : 0), raw: true },
  { name: "settlementTrade", from: (r, s) => (s.settlementTradeYn === true ? 1 : 0), raw: true },
];

function pick(...vals) {
  for (const v of vals) if (v != null && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function fmt(col, value) {
  if (col.raw) return value == null ? "" : String(value);
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return "";
  if (!col.round) return String(Math.round(n));
  const f = n.toFixed(col.round);
  // "12.00" → "12" (용량 절약, 의미 동일)
  return f.replace(/\.?0+$/, "") || "0";
}

async function main() {
  const outRoot = path.resolve(argValue("--out", ".snapshots"));

  const raw = await fs.readFile(CACHE_PATH, "utf8");
  const cache = JSON.parse(raw);
  const stocks = Array.isArray(cache.stocks) ? cache.stocks : [];
  const asOfDate = String(cache.asOfDate || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error(`캐시의 asOfDate가 비정상입니다: ${JSON.stringify(cache.asOfDate)}`);
  }
  if (stocks.length < 1000) {
    throw new Error(`종목 ${stocks.length}건은 비정상적으로 적습니다 — 반쪽짜리 캐시를 아카이브하지 않습니다`);
  }

  const lines = [COLUMNS.map((c) => c.name).join(",")];
  let written = 0;
  for (const row of stocks) {
    if (!row || !row.code) continue;
    const snap = row.snapshot || {};
    const cells = COLUMNS.map((c) => fmt(c, c.from(row, snap)));
    // 종가조차 없는 행은 백테스트에 쓸 수 없으므로 버린다.
    if (!cells[2]) continue;
    lines.push(cells.join(","));
    written += 1;
  }

  const csv = `${lines.join("\n")}\n`;
  const gz = zlib.gzipSync(Buffer.from(csv, "utf8"), { level: 9 });

  const month = asOfDate.slice(0, 7);
  const outDir = path.join(outRoot, "screener", month);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${asOfDate}.csv.gz`);
  await fs.writeFile(outPath, gz);

  // 아카이브 전체 목록(읽는 쪽이 "어떤 날짜가 있는지"를 파일 하나로 알 수 있게)
  const indexPath = path.join(outRoot, "screener", "index.json");
  let index = { schema: 1, columns: COLUMNS.map((c) => c.name), dates: [] };
  try {
    const prev = JSON.parse(await fs.readFile(indexPath, "utf8"));
    if (prev && Array.isArray(prev.dates)) index = { ...index, dates: prev.dates };
  } catch {
    /* 첫 실행 */
  }
  if (!index.dates.includes(asOfDate)) index.dates.push(asOfDate);
  index.dates.sort();
  index.updatedAt = new Date().toISOString();
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 0)}\n`, "utf8");

  console.log(
    `✅ ${asOfDate} 스냅샷 저장 — ${written.toLocaleString()}종목 / CSV ${(csv.length / 1024 / 1024).toFixed(2)}MB → gzip ${(gz.length / 1024).toFixed(0)}KB`
  );
  console.log(`   ${outPath}`);
  console.log(`   누적 ${index.dates.length}일치 (${index.dates[0]} ~ ${index.dates[index.dates.length - 1]})`);
}

main().catch((error) => {
  console.error("❌ 스냅샷 아카이브 실패:", error && error.message);
  process.exit(1);
});
