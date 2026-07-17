/**
 * 카드뉴스 발행 전에 "오늘자 데이터가 실제로 준비됐는지" 확인하는 게이트 스크립트.
 *
 * 배경: daily-market-sync.yml 코멘트에 있듯, 한국 공휴일에도 sync:kis는 그대로 실행되고
 * 더미(0%) 데이터가 들어올 수 있다. 또한 마감 시황의 지수/총평(analysis)은 자동이 아니라
 * Cowork(수동/AI) 단계에서 채워지므로, 그 단계가 누락되면 topGainers만 있고 indexes/analysis가
 * 빈 채로 남을 수 있다. 이 상태에서 그대로 발행하면 휴장일에도 의미 없는(혹은 0% 도배) 카드가 올라간다.
 *
 * 그래서 workflow_dispatch/cron이 평일에 돌더라도, 실제 "오늘자 시황 데이터"가 채워져 있는지
 * 이 스크립트로 한 번 더 확인하고, 없으면 워크플로우가 렌더링/발행 자체를 건너뛰게 한다.
 *
 * 사용: node scripts/check-promo-data-ready.mjs --slot=morning|closing
 * 종료 코드 0 → stdout에 "ready" 출력, 발행 가능
 * 종료 코드 1 → stdout에 "not-ready: <이유>" 출력, 발행 스킵
 */
import { readJson, seoulYmd } from "./telegram-utils.mjs";

const slotArg = process.argv.find((a) => a.startsWith("--slot="));
const slot = slotArg ? slotArg.split("=")[1] : "closing";

function fail(reason) {
  console.log(`not-ready: ${reason}`);
  process.exit(1);
}

function ok() {
  console.log("ready");
  process.exit(0);
}

async function checkClosing() {
  const today = seoulYmd();
  let raw;
  try {
    raw = await readJson("./data/daily-market.json");
  } catch (err) {
    fail(`data/daily-market.json 읽기 실패: ${err.message}`);
    return;
  }

  const day = raw?.days?.[today];
  if (!day) {
    fail(`오늘(${today}) 데이터 없음 — 휴장일이거나 daily-market-sync가 아직 안 돌았을 수 있음`);
    return;
  }

  const kospiClose = day?.indexes?.kospi?.close;
  const hasIndex = Number.isFinite(kospiClose);
  const hasAnalysis = String(day?.analysis || "").trim().length > 0;

  if (!hasIndex || !hasAnalysis) {
    fail(
      `오늘(${today}) 지수/총평 데이터 미완성 (indexes:${hasIndex ? "OK" : "없음"}, analysis:${hasAnalysis ? "OK" : "없음"}) — 휴장일이거나 시황 정리(Cowork) 단계가 아직 반영 안 됨`
    );
    return;
  }

  ok();
}

async function checkMorning() {
  const today = seoulYmd();
  let raw;
  try {
    raw = await readJson("./data/morning-briefing.json");
  } catch (err) {
    fail(`data/morning-briefing.json 읽기 실패: ${err.message}`);
    return;
  }

  const updatedYmd = String(raw?.updatedAt || "").slice(0, 10);
  if (updatedYmd !== today) {
    fail(`morning-briefing.json이 오늘(${today}) 기준으로 갱신되지 않음 (updatedAt: ${updatedYmd || "없음"}) — 휴장일이거나 수집이 아직 안 됨`);
    return;
  }

  const summary = String(raw?.aiAnalysis?.summary || raw?.aiAnalysis?.domesticImpact || "").trim();
  if (!summary) {
    fail("aiAnalysis 요약 내용 없음");
    return;
  }

  ok();
}

try {
  if (slot === "morning") await checkMorning();
  else await checkClosing();
} catch (err) {
  fail(`체크 중 오류: ${err instanceof Error ? err.message : err}`);
}
