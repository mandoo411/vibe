#!/usr/bin/env node
/**
 * 워크플로 공용 "오늘 한국 증시가 열렸나" 가드 — 2026-09-24 신설.
 * 판단은 lib/krx-calendar.js 한 곳에서만 한다(주말 + 거래소 휴장일).
 *
 * 사용(워크플로 step):
 *   - id: krx
 *     run: node scripts/krx-guard.mjs            # 오늘(KST) 기준
 *   다음 step에서: if: steps.krx.outputs.open == 'true'
 *
 * 출력(GITHUB_OUTPUT): open=true|false, reason=<휴장 사유>, next=<다음 거래일 YYYY-MM-DD>
 * 기본 exit 0 — 휴장일은 "실패"가 아니라 "할 일 없음"이다.
 * 셸에서 쓰려면 --exit-code: 휴장이면 exit 1 (예: if ! node scripts/krx-guard.mjs --exit-code; then ...)
 * 수동 재실행으로 휴장일 판정을 무시하려면 env KRX_FORCE=1.
 */
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cal = require("../lib/krx-calendar.js");

const arg = process.argv.find((a) => a.startsWith("--date="));
const ymd = (arg && arg.split("=")[1]) || process.env.KRX_DATE || cal.seoulYmd();
const force = ["1", "true"].includes(String(process.env.KRX_FORCE || "").toLowerCase());
const reason = force ? null : cal.closedReason(ymd);
if (force) console.log("[krx-guard] KRX_FORCE — 휴장일 판정을 건너뜁니다(수동 강제 실행)");
const next = cal.thisOrNextTradingDay(ymd);

if (reason) console.log(`::notice::${ymd} 한국 증시 휴장(${reason}) — 다음 거래일 ${next}. 이 작업은 건너뜁니다.`);
else console.log(`[krx-guard] ${ymd} 거래일`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `open=${reason ? "false" : "true"}\nreason=${reason || ""}\nnext=${next}\n`);
}

if (process.argv.includes("--exit-code") && reason) process.exit(1);
