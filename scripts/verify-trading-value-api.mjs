/**
 * 거래대금 TOP100 API 스모크 테스트 (NAVER 풀 + 페이지 슬라이스)
 * Usage: node scripts/verify-trading-value-api.mjs [baseUrl]
 *   baseUrl 기본 http://localhost:3000
 */
const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");

async function get(path) {
  const url = `${base}${path}`;
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data, url };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log("Testing", base);

  for (let page = 1; page <= 4; page++) {
    const { ok, status, data, url } = await get(
      `/api/kis-realtime-data?action=trading-value&page=${page}&pageSize=25`
    );
    assert(ok, `page ${page} HTTP ${status} ${url} ${data.error || ""}`);
    const stocks = data.stocks || [];
    assert(stocks.length === 25, `page ${page}: expected 25 rows, got ${stocks.length}`);
    const ranks = stocks.map((s) => s.rank);
    const expectedStart = (page - 1) * 25 + 1;
    assert(ranks[0] === expectedStart, `page ${page}: first rank ${ranks[0]} expected ${expectedStart}`);
    assert(
      stocks.every((s) => s.code && s.name && s.tradingValue),
      `page ${page}: missing code/name/tradingValue`
    );
    console.log(
      `  page ${page} OK ranks ${ranks[0]}–${ranks[ranks.length - 1]} top=${stocks[0].name} tv=${stocks[0].tradingValue}`
    );
  }

  const cap = await get("/api/kis-realtime-data?action=market-cap&page=1&pageSize=25");
  const gain = await get("/api/kis-realtime-data?action=gainers&page=1&pageSize=25");
  assert(cap.ok && (cap.data.stocks || []).length === 25, "market-cap page1 failed");
  assert(gain.ok && (gain.data.stocks || []).length === 25, "gainers page1 failed");
  console.log("market-cap & gainers page1 OK");
  console.log("All checks passed.");
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
