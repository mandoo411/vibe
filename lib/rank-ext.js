/**
 * 2026-10-02 관리자 전용 6~20위 (시우 요청).
 * 공개 상위 5종목은 기존 랭킹 그대로 두고, 20위까지 따로 채점한 결과에서 상위 5종목을 뺀 나머지를
 * 6위부터 다시 번호를 매겨 돌려준다. 공개 통계·달력·카드뉴스에는 쓰지 않는다.
 */
function extRanks(all, top, max = 20) {
  const seen = new Set((top || []).map((r) => r && r.code));
  const out = [];
  for (const r of all || []) {
    if (!r || seen.has(r.code)) continue;
    seen.add(r.code);
    out.push(Object.assign({}, r, { rank: (top || []).length + out.length + 1 }));
    if ((top || []).length + out.length >= max) break;
  }
  return out;
}
module.exports = { extRanks };
