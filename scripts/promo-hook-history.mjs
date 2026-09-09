/**
 * 훅 반복 방지용 최근 이력 저장소
 *
 * 2026-09-09 신설. 마감 카드가 60거래일 연속 같은 훅("딱 두 종목에 몰렸습니다")으로
 * 나간 게 확인돼서, 유형 선택에 "최근에 쓴 건 피한다"는 규칙을 넣기 위해 만들었다.
 * 데이터가 없는 초기 상태에서도 안전하게 동작해야 하므로 읽기/쓰기 모두 실패를 삼킨다.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_PATH = "data/promo/hook-history.json";

/** { closing: [{date,type}], morning: [...], ranking: [...] } */
export function readHookHistory(path = DEFAULT_PATH) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

/** 해당 슬롯에서 최근에 쓴 훅 유형을 최신순으로 돌려준다. */
export function recentHookTypes(slot, limit = 8, path = DEFAULT_PATH) {
  const all = readHookHistory(path);
  const list = Array.isArray(all[slot]) ? all[slot] : [];
  return list.slice(-limit).reverse().map((r) => r && r.type).filter(Boolean);
}

/**
 * 이번에 쓴 유형을 기록한다. 같은 날짜로 다시 돌리면(재실행) 덮어쓴다 —
 * 워크플로가 실패해 재시도할 때 같은 날이 두 번 쌓이면 이력이 왜곡된다.
 */
export function appendHookType(slot, date, type, path = DEFAULT_PATH) {
  try {
    const all = readHookHistory(path);
    const list = Array.isArray(all[slot]) ? all[slot] : [];
    const i = list.findIndex((r) => r && r.date === date);
    if (i >= 0) list[i] = { date, type };
    else list.push({ date, type });
    all[slot] = list.slice(-40);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
  } catch (e) {
    console.warn("[hook] 이력 저장 실패(무시하고 진행):", e && e.message);
  }
}

/**
 * 최근에 쓴 유형일수록 큰 감점. 후보가 여럿일 때만 순위를 바꾸고,
 * 후보가 하나뿐이면 감점을 받아도 그대로 선택된다(억지로 다른 훅을 만들지 않는다).
 */
export function repeatPenalty(type, recent) {
  const i = recent.indexOf(type);
  // (1) 최근성 — 직전에 쓴 유형일수록 크게 깎는다
  let p = 0;
  if (i === 0) p = 60;
  else if (i === 1) p = 38;
  else if (i === 2) p = 24;
  else if (i > 0 && i < 5) p = 14;
  else if (i >= 5) p = 6;

  // (2) 빈도 — 최근 창에서 이미 여러 번 쓴 유형은 추가로 깎는다.
  //     최근성만 보면 "A→B→A→B" 처럼 두 유형이 번갈아 도는 패턴이 생긴다.
  const count = recent.filter((t) => t === type).length;
  if (count > 1) p += (count - 1) * 14;
  return p;
}

/** 후보 목록에서 점수 - 반복감점 이 가장 높은 것을 고른다. */
export function chooseHook(candidates, recent, fallback) {
  const scored = candidates
    .filter((c) => c && c.type && Number.isFinite(c.score))
    .map((c) => ({ ...c, final: c.score - repeatPenalty(c.type, recent) }))
    .sort((a, b) => b.final - a.final);
  if (!scored.length) return { type: fallback, why: "조건에 걸린 후보가 없어 기본형", final: 0, all: [] };
  return { ...scored[0], all: scored };
}
