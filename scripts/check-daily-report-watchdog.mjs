#!/usr/bin/env node
/**
 * 마감시황 워치독 — "거래일인데 마감 리포트가 안 채워졌다"를 잡아 텔레그램으로 알린다.
 *
 * 왜 필요한가 (2026-09-10 사고)
 *   마감시황 본문(indexes·analysis·investor_trend·featured_stocks)은 GitHub Actions가
 *   아니라 시우 PC의 Cowork 예약작업이 채운다. 2026-09-10에 Windows 보안 업데이트
 *   KB5124008이 설치되면서 Cowork 로컬 샌드박스의 파일 접근이 막혔고, 그날 예약작업이
 *   돌지 못해 data/daily-market.json의 해당 항목이 거래대금 순위만 있고 지수·총평이
 *   빈 채로 남았다.
 *   카드뉴스 게이트(check-promo-data-ready.mjs)는 정상적으로 발행을 막았지만,
 *   워크플로가 "Success"로 끝나서 아무에게도 알림이 가지 않았다. 하루 통째로 미발행.
 *
 *   같은 사고가 2026-06-23에도 있었고 그때 이 워치독을 만들었는데,
 *   저장소에 푸시되지 않아 실제로는 한 번도 돌지 않았다(2026-09-11 확인).
 *
 * 판정 (오탐을 막는 게 핵심 — 휴장일에 알림이 오면 곧 무시하게 된다)
 *   1) 오늘 항목이 없거나 순위 데이터가 비어 있으면 → 휴장일이거나 KIS 동기화 전. 조용히 종료.
 *   2) 순위 데이터에 0%가 아닌 등락이 있으면 → 장이 열린 거래일이 확실하다.
 *   3) 그런데 지수(indexes.kospi.close)나 총평(analysis)이 비어 있으면 → Cowork 단계 누락. 알림.
 *
 *   실제 2026-09-10 데이터로 확인: topGainers 30건(샘표 +29.99% 등) · indexes 키 자체가 없음
 *   · analysis 0자 → 위 규칙에서 정확히 "거래일 + 리포트 누락"으로 잡힌다.
 *
 * 사용: node scripts/check-daily-report-watchdog.mjs [--stage=first|final]
 *   first — 1차 점검(16:40 KST). "아직 안 됐다" 알림.
 *   final — 마지막 점검(19:00 KST). "오늘 발행 못 한다" 알림.
 */
import { readJson, seoulYmd } from "./telegram-utils.mjs";

const DATA_PATH = process.env.DAILY_MARKET_PATH || "data/daily-market.json";
const stageArg = process.argv.find((a) => a.startsWith("--stage="));
const STAGE = stageArg ? stageArg.split("=")[1] : "first";

/** 장이 열린 날인지 — 순위 목록에 0%가 아닌 등락이 하나라도 있으면 거래일이다. */
function isTradingDay(day) {
  if (!day || typeof day !== "object") return false;
  const lists = [day.topGainers, day.topDecliners, day.topTradingValue];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      const raw = String((s && (s.change != null ? s.change : s.change_pct)) || "").replace(/[+%,\s]/g, "");
      const chg = Number(raw);
      if (Number.isFinite(chg) && chg !== 0) return true;
    }
  }
  return false;
}

/** 마감 리포트에서 Cowork가 채워야 하는 항목들. 빠진 것 목록을 그대로 돌려준다. */
function missingParts(day) {
  const miss = [];
  const kospiClose = day && day.indexes && day.indexes.kospi ? day.indexes.kospi.close : undefined;
  if (!Number.isFinite(kospiClose)) miss.push("지수(indexes)");
  if (String((day && day.analysis) || "").trim().length < 50) miss.push("총평(analysis)");
  if (!(day && day.investor_trend)) miss.push("수급(investor_trend)");
  if (!day || !Array.isArray(day.featured_stocks) || day.featured_stocks.length === 0) {
    miss.push("특징주(featured_stocks)");
  }
  return miss;
}

async function sendAlert(text) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_TOKEN 또는 chat id(TELEGRAM_ADMIN_CHAT_ID/TELEGRAM_CHANNEL_ID) 미설정");
  }
  const url = "https://api.telegram.org/bot" + token + "/sendMessage";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error("Telegram sendMessage 실패: " + (data.description || res.statusText));
  }
}

async function main() {
  const today = process.env.PROMO_FORCE_DATE || seoulYmd();

  let data;
  try {
    data = await readJson(DATA_PATH);
  } catch (err) {
    console.error("[watchdog] " + DATA_PATH + " 읽기 실패: " + err.message);
    process.exitCode = 1;
    return;
  }

  const day = data && data.days ? data.days[today] : null;

  if (!isTradingDay(day)) {
    console.log("[watchdog] " + today + ": 거래 데이터 없음 — 휴장일이거나 KIS 동기화 전. 알림 생략");
    return;
  }

  const miss = missingParts(day);
  if (miss.length === 0) {
    console.log("[watchdog] " + today + ": 마감 리포트 정상 — 알림 없음");
    return;
  }

  console.log("[watchdog] " + today + ": 거래일인데 누락 — " + miss.join(", "));

  const head =
    STAGE === "final"
      ? "🚨 *[운영] 오늘 마감시황 발행 실패*"
      : "⚠️ *[운영] 마감시황 리포트 누락 감지*";
  const tail =
    STAGE === "final"
      ? [
          "이 상태로는 오늘 인스타 카드뉴스가 나가지 않습니다.",
          "지금이라도 Cowork 마감시황 작업을 돌리면,",
          "데이터가 커밋되는 즉시 카드뉴스가 자동 발행됩니다.",
        ]
      : [
          "PC가 켜져 있고 Claude 앱이 로그인돼 있는지 확인해 주세요.",
          "Cowork 마감시황 작업을 수동으로 돌려도 됩니다.",
        ];

  const text = [
    head,
    "",
    "날짜: " + today + " (거래일)",
    "누락: " + miss.join(", "),
    "",
    "거래대금·등락률 순위는 수집됐지만,",
    "Cowork 마감 리포트 단계가 반영되지 않았습니다.",
    "",
  ].concat(tail).join("\n");

  await sendAlert(text);
  console.log("[watchdog] 알림 발송 완료");
}

main().catch((err) => {
  console.error("[watchdog] 실패:", err);
  process.exitCode = 1;
});
