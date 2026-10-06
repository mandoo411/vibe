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
let reason = force ? null : cal.closedReason(ymd);

/* 2026-10-07: 백업 schedule 실행 가드 (--backup-of=<워크플로 파일> [--not-before=HH:MM])
 * GitHub schedule은 이 저장소에서 2~9시간 밀린다. 정시 실행은 pg_cron(workflow_dispatch)이 하고 schedule은
 * 백업인데, 백업이 자정을 넘겨 돌면서 "다음 날"을 처리하다 실패 알림을 보냈다
 * (마감 리포트 9/28 00:31·10/6 01:03, 워치독 10/7 01:24 — 정시 실행은 전부 성공했었다).
 * schedule 이벤트일 때만: ① 최근 12시간 안에 정시(dispatch) 실행이 성공했거나 ② 지금이 --not-before 이전
 * (=자정을 넘겨 밀림)이면 open=false로 건너뛴다. 수동·pg_cron 실행에는 영향 없음. */
const backupOf = (process.argv.find((a) => a.startsWith("--backup-of=")) || "").split("=")[1];
if (!reason && backupOf && process.env.GITHUB_EVENT_NAME === "schedule") {
  const nb = (process.argv.find((a) => a.startsWith("--not-before=")) || "").split("=")[1];
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date()).replace(":", "");
  if (nb && Number(hm) < Number(nb.replace(":", ""))) {
    reason = `백업 실행이 ${hm.slice(0, 2)}:${hm.slice(2)}까지 밀림 — 해당 날짜 지남`;
  } else {
    try {
      const repo = process.env.GITHUB_REPOSITORY;
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
      const url = `https://api.github.com/repos/${repo}/actions/workflows/${backupOf}/runs?status=success&created=>=${since}&per_page=20`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
      const data = await res.json();
      const done = (data.workflow_runs || []).find((r) => r.event !== "schedule");
      if (done) reason = `정시 실행(${done.event}, ${done.created_at})이 이미 성공 — 백업 생략`;
      else console.log(`[krx-guard] 최근 12시간 정시 실행 성공 기록 없음 — 백업 실행 진행`);
    } catch (e) {
      console.log(`[krx-guard] 정시 실행 확인 실패(${e.message}) — 백업 실행 진행`);
    }
  }
}
if (force) console.log("[krx-guard] KRX_FORCE — 휴장일 판정을 건너뜁니다(수동 강제 실행)");
const next = cal.thisOrNextTradingDay(ymd);

if (reason) console.log(`::notice::${ymd} ${/백업|정시/.test(reason) ? reason : `한국 증시 휴장(${reason}) — 다음 거래일 ${next}`}. 이 작업은 건너뜁니다.`);
else console.log(`[krx-guard] ${ymd} 거래일`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `open=${reason ? "false" : "true"}\nreason=${reason || ""}\nnext=${next}\n`);
}

if (process.argv.includes("--exit-code") && reason) process.exit(1);
