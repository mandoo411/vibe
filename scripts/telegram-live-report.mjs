#!/usr/bin/env node

import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import {
  fmtNumber,
  fmtPct,
  formatDateKo,
  mdText,
  readJson,
  requireEnv,
  sendTelegramMessage,
  seoulYmd,
  SITE_URL,
  toNum,
} from "./telegram-utils.mjs";

const DATA_PATH = process.env.LIVE_REPORT_PATH || "data/live-report.json";
const KIS_BASE_URL = (process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(/\/+$/, "");
const KIS_GAP_MS = Math.max(0, Number(process.env.KIS_API_GAP_MS) || 700);
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seoulClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: map.weekday,
    hour: Number(map.hour),
    minute: Number(map.minute),
    minutes: Number(map.hour) * 60 + Number(map.minute),
  };
}

function assertMarketOpen() {
  const clock = seoulClock();
  const weekdayOpen = clock.weekday !== "Sat" && clock.weekday !== "Sun";
  if (!weekdayOpen || clock.minutes < 9 * 60 || clock.minutes > 15 * 60 + 30) {
    console.log("현재 장 운영 시간이 아닙니다.");
    return null;
  }
  return `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
}

function normalizeSlotTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const rounded = m < 15 ? 0 : m < 45 ? 30 : 0;
  const hour = m >= 45 ? h + 1 : h;
  return `${String(hour).padStart(2, "0")}:${String(rounded).padStart(2, "0")}`;
}

function kisHeaders(trId, token, appKey, appSecret, trCont = "") {
  return {
    "content-type": "application/json; charset=utf-8",
    authorization: `Bearer ${token}`,
    appkey: appKey,
    appsecret: appSecret,
    tr_id: trId,
    custtype: "P",
    tr_cont: trCont,
  };
}

async function kisGet(path, trId, params, token, appKey, appSecret, trCont = "") {
  await sleep(KIS_GAP_MS);
  const url = new URL(path, KIS_BASE_URL);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, value == null ? "" : String(value)));
  const res = await fetch(url, { headers: kisHeaders(trId, token, appKey, appSecret, trCont) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`KIS invalid JSON ${path}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`KIS HTTP ${res.status} ${path}: ${text.slice(0, 300)}`);
  if (json.rt_cd && json.rt_cd !== "0") throw new Error(`KIS rt_cd=${json.rt_cd} msg=${json.msg1 || json.msg_cd || ""}`);
  return json;
}

function outputRows(json) {
  const out = json?.output;
  if (Array.isArray(out)) return out;
  if (out && typeof out === "object") return [out];
  return [];
}

function pickIndexValue(row) {
  return row?.nmix_prpr || row?.NMIX_PRPR || row?.nmix_nmix_prpr || row?.bstp_nmix_prpr || row?.stck_prpr || "";
}

async function fetchIndex(fidInputIscd, label, token, appKey, appSecret) {
  const json = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-index-price",
    "FHPUP02100000",
    { fid_cond_mrkt_div_code: "J", fid_input_iscd: fidInputIscd },
    token,
    appKey,
    appSecret
  );
  const row = outputRows(json)[0] || json.output || {};
  return {
    label,
    value: toNum(pickIndexValue(row)),
    change: toNum(row.prdy_ctrt || row.bstp_nmix_prdy_ctrt || row.nmix_prdy_ctrt),
  };
}

function pickTradingValue(row) {
  return row?.acml_tr_pbmn || row?.ACML_TR_PBMN || row?.tr_pbmn || row?.TR_PBMN || "";
}

async function fetchFluctuationRanking(marketCode, marketLabel, token, appKey, appSecret) {
  const json = await kisGet(
    "/uapi/domestic-stock/v1/ranking/fluctuation",
    "FHPST01700000",
    {
      fid_cond_mrkt_div_code: "J",
      fid_cond_scr_div_code: "20170",
      fid_input_iscd: marketCode,
      fid_rank_sort_cls_code: "0",
      fid_input_cnt_1: "0",
      fid_prc_cls_code: "0",
      fid_input_price_1: "",
      fid_input_price_2: "",
      fid_vol_cnt: "",
      fid_trgt_cls_code: "0",
      fid_trgt_exls_cls_code: "0000000000",
      fid_div_cls_code: "0",
      fid_rsfl_rate1: "",
      fid_rsfl_rate2: "",
    },
    token,
    appKey,
    appSecret
  );
  return outputRows(json)
    .map((row) => ({
      code: String(row.stck_shrn_iscd || "").trim(),
      name: String(row.hts_kor_isnm || "").trim(),
      market: marketLabel,
      price: toNum(row.stck_prpr),
      rate: toNum(row.prdy_ctrt),
      volume: toNum(row.acml_vol),
      tradingValue: toNum(pickTradingValue(row)),
    }))
    .filter((row) => row.code && row.name && row.rate != null);
}

function formatWon(value) {
  const n = toNum(value);
  if (n == null) return "-";
  return `${fmtNumber(n, 0)}원`;
}

function formatTradingValue(value) {
  const n = toNum(value);
  if (n == null || n <= 0) return "-";
  if (n >= 1_0000_0000_0000) return `${(n / 1_0000_0000_0000).toFixed(1).replace(/\\.0$/, "")}조`;
  if (n >= 1_0000_0000) return `${Math.round(n / 1_0000_0000).toLocaleString("ko-KR")}억`;
  return `${n.toLocaleString("ko-KR")}원`;
}

function topRowsText(rows) {
  return rows
    .map((row) => `${row.rank}. ${row.name} ${fmtPct(row.rate, 1)} 현재가 ${formatWon(row.price)} 거래대금 ${formatTradingValue(row.tradingValue)}`)
    .join("\n");
}

async function runClaude({ apiKey, time, kospi, kosdaq, top50 }) {
  const client = new Anthropic({ apiKey });
  const user = `현재 시각: ${time}
코스피: ${fmtNumber(kospi.value, 2)} ${fmtPct(kospi.change, 2)}
코스닥: ${fmtNumber(kosdaq.value, 2)} ${fmtPct(kosdaq.change, 2)}

상승률 TOP50:
${topRowsText(top50)}

위 데이터를 바탕으로 아래 형식으로 분석해주세요:

🎙️ 현재 장세 총평 (2-3줄, 생동감 있게)

🔥 오늘의 MVP 종목 TOP3
(상한가/급등 이유, 어떤 이슈/테마인지)

📊 강세 섹터 분석
(어느 테마/섹터가 주도하고 있는지)

⚡ 주목할 이슈
(오늘 왜 이런 장세인지 배경 설명)

🎯 다음 30분 관전 포인트`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system:
      "당신은 주식시장 전문 해설가입니다. 야구 중계처럼 생동감 있고 흥미롭게 현재 시장 상황을 분석해주세요. 전문용어는 쉽게 풀어서 설명하고 왜 오르는지 이유와 맥락을 설명해주세요. 이모지를 적절히 사용해 읽기 쉽게 작성해주세요.",
    messages: [{ role: "user", content: user }],
  });
  const block = msg.content.find((item) => item.type === "text");
  if (!block || block.type !== "text") throw new Error("Unexpected Claude response shape");
  return block.text.trim();
}

function buildTelegramMessage({ ymd, time, kospi, kosdaq, aiAnalysis, top10 }) {
  const lines = [
    "📺 *TotalMoney AI - 라이브 리포트*",
    `📅 ${formatDateKo(ymd)} *${time}* 현재`,
    "",
    `📈 코스피 *${fmtNumber(kospi.value, 0)}* ${fmtPct(kospi.change, 1)} | 코스닥 *${fmtNumber(kosdaq.value, 0)}* ${fmtPct(kosdaq.change, 1)}`,
    "",
    "━━━━━━━━━━━━━━━",
    mdText(aiAnalysis),
    "",
    "━━━━━━━━━━━━━━━",
    "🏆 *상승률 TOP10*",
  ];
  top10.forEach((row) => {
    lines.push(`${row.rank}위 ${mdText(row.name)} *${fmtPct(row.rate, 1)}* ${formatWon(row.price)}`);
  });
  lines.push("", "━━━━━━━━━━━━━━━", `🔗 ${SITE_URL}/live-report.html`);
  return lines.join("\n");
}

async function writeLiveReport(payload) {
  let data;
  try {
    data = await readJson(DATA_PATH);
  } catch (_) {
    data = { date: payload.date, reports: [] };
  }
  if (data.date !== payload.date) {
    data = { date: payload.date, reports: [] };
  }
  data.reports = Array.isArray(data.reports) ? data.reports : [];
  data.reports = data.reports.filter((report) => report.time !== payload.time);
  data.reports.push(payload);
  data.reports.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function gitCommitAndPush(time) {
  if (process.env.LIVE_REPORT_SKIP_GIT === "1") {
    console.log("LIVE_REPORT_SKIP_GIT=1, skip git commit/push.");
    return;
  }
  execFileSync("git", ["config", "user.name", "github-actions[bot]"], { stdio: "inherit" });
  execFileSync("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], { stdio: "inherit" });
  execFileSync("git", ["add", DATA_PATH], { stdio: "inherit" });
  try {
    execFileSync("git", ["diff", "--cached", "--quiet", "--", DATA_PATH], { stdio: "ignore" });
    console.log("No live-report data changes to commit.");
    return;
  } catch (_) {
    // git diff --quiet exits 1 when there are staged changes.
  }
  execFileSync("git", ["commit", "-m", `chore(data): live report ${seoulYmd()} ${time} KST`], { stdio: "inherit" });
  execFileSync("git", ["pull", "--rebase", "origin", "main"], { stdio: "inherit" });
  execFileSync("git", ["push", "origin", "HEAD:main"], { stdio: "inherit" });
}

async function main() {
  const rawTime = assertMarketOpen();
  if (!rawTime) return;
  const time = normalizeSlotTime(rawTime);
  const ymd = seoulYmd();

  const token = requireEnv("KIS_ACCESS_TOKEN");
  const appKey = requireEnv("KIS_APP_KEY");
  const appSecret = requireEnv("KIS_APP_SECRET");
  const anthropicKey = requireEnv("ANTHROPIC_API_KEY");

  const kospi = await fetchIndex("0001", "코스피", token, appKey, appSecret);
  const kosdaq = await fetchIndex("1001", "코스닥", token, appKey, appSecret);

  const rankings = [
    ...(await fetchFluctuationRanking("0001", "KOSPI", token, appKey, appSecret)),
    ...(await fetchFluctuationRanking("1001", "KOSDAQ", token, appKey, appSecret)),
  ]
    .sort((a, b) => (b.rate || 0) - (a.rate || 0))
    .slice(0, 50)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  if (!rankings.length) throw new Error("상승률 TOP50 데이터가 비어 있습니다.");

  const aiAnalysis = await runClaude({ apiKey: anthropicKey, time, kospi, kosdaq, top50: rankings });
  const top10 = rankings.slice(0, 10).map((row) => ({
    rank: row.rank,
    name: row.name,
    code: row.code,
    rate: row.rate,
    price: row.price,
  }));

  const payload = {
    time,
    kospi: { value: kospi.value, change: kospi.change },
    kosdaq: { value: kosdaq.value, change: kosdaq.change },
    aiAnalysis,
    top10,
  };

  await sendTelegramMessage(buildTelegramMessage({ ymd, time, kospi, kosdaq, aiAnalysis, top10 }));
  await writeLiveReport({ date: ymd, ...payload });
  gitCommitAndPush(time);
  console.log(`Live report sent and saved: ${ymd} ${time}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
