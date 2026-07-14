/**
 * 인스타그램 데일리 카드뉴스 자동화 — 메인 스크립트
 * 하루 2회 다른 내용으로 발행한다:
 *   --slot=morning  (08:30 KST) — data/morning-briefing.json 기반, 간밤 미국장 + 오늘 전망
 *   --slot=closing  (17:30 KST) — data/daily-market.json 기반, 코스피·코스닥 마감 + 특징주
 *
 * 흐름: 스냅샷 읽기 → 카피 생성/변환 → 5장 PNG 렌더링 → generated/<slot>/ 저장
 *       → git commit·push (워크플로우가 처리) → Meta Graph API로 캐러셀 발행
 *
 * 사용:
 *   node scripts/instagram-card-post.mjs --slot=morning --render
 *   node scripts/instagram-card-post.mjs --slot=morning --publish
 *   node scripts/instagram-card-post.mjs --slot=closing --render
 *   node scripts/instagram-card-post.mjs --slot=closing --publish
 */
import { loadLatestSnapshot, buildPromoCopy, buildClosingCardData } from "./promo-market-copy.mjs";
import { loadMorningSnapshot, buildMorningCardData } from "./promo-morning-copy.mjs";
import { buildCardsHTML, renderCardsToPNG } from "./promo-render-cards.mjs";
import { postInstagramCarousel } from "./promo-instagram-api.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { seoulYmd } from "./telegram-utils.mjs";

const THEME = process.env.PROMO_CARD_THEME || "light"; // 'dark' | 'light' (기본: light — 사이트 기본 테마와 통일)

function todayLabel(ymd) {
  return ymd.replaceAll("-", ".");
}

function parseArgs() {
  const slotArg = process.argv.find((a) => a.startsWith("--slot="));
  const slot = slotArg ? slotArg.split("=")[1] : "closing";
  if (!["morning", "closing"].includes(slot)) {
    throw new Error(`알 수 없는 --slot 값: ${slot} (morning | closing 중 하나)`);
  }
  const action = process.argv.includes("--publish") ? "publish" : "render";
  return { slot, action };
}

function dirsFor(slot) {
  const generatedDir = join(process.cwd(), "generated", slot);
  const captionFile = join(generatedDir, "today-caption.txt");
  return { generatedDir, captionFile };
}

async function buildCardDataForSlot(slot) {
  if (slot === "morning") {
    const snapshot = await loadMorningSnapshot();
    const cardData = buildMorningCardData(snapshot, { dateLabel: todayLabel(seoulYmd()), theme: THEME });
    return { cardData, caption: buildMorningCaption(cardData) };
  }

  const snapshot = await loadLatestSnapshot();
  console.log("2) Claude로 카드 문구 압축 생성...");
  const copy = await buildPromoCopy(snapshot);

  // featured_stocks(에디터가 고른 실제 이슈 종목, reason/point 포함)를 우선 사용.
  // topGainers는 거래대금 상위 원시 데이터라 reason/theme이 비어있는 경우가 많아 카드가 빈약해짐.
  const featuredGainers = (snapshot.featured_stocks || []).filter((s) => s.type === "급등");
  const gainerSource = featuredGainers.length >= 3 ? featuredGainers : snapshot.topGainers || [];
  const trimReason = (s) => (s && s.length > 42 ? s.slice(0, 40) + "…" : s || "");
  const gainers = gainerSource.slice(0, 3).map((g) => ({
    ...g,
    reason: trimReason(copy.stockReasons?.[g.name] || g.reason || g.point || g.theme || ""),
  }));

  const cardData = buildClosingCardData({
    snapshot,
    copy,
    gainers,
    dateLabel: todayLabel(snapshot.ymd),
    theme: THEME,
  });
  return { cardData, caption: buildClosingCaption(snapshot, copy) };
}

function buildMorningCaption(cardData) {
  return [
    `☀️ ${cardData.date} 아침 브리핑`,
    "",
    cardData.headline,
    "",
    "AI 오늘의 전망",
    cardData.aiComment,
    "",
    "전체 브리핑은 totalmoney.kr 에서 무료로 확인하세요.",
    "실시간 알림 구독 → t.me/totalmoney_ai",
    "",
    "※ 투자 참고용 정보이며, 투자 판단 및 그 결과에 대한 책임은 투자자 본인에게 있습니다.",
    "",
    "#주식 #미국주식 #나스닥 #증시브리핑 #아침브리핑",
    "#주식투자 #주식공부 #재테크 #totalmoney",
  ].join("\n");
}

function buildClosingCaption(snapshot, copy) {
  return [
    `📊 ${todayLabel(snapshot.ymd)} 오늘의 시장 요약`,
    "",
    copy.headline,
    "",
    "AI 오늘의 판단",
    copy.aiComment,
    "",
    "전체 분석은 totalmoney.kr 에서 무료로 확인하세요.",
    "실시간 알림 구독 → t.me/totalmoney_ai",
    "",
    "※ 투자 참고용 정보이며, 투자 판단 및 그 결과에 대한 책임은 투자자 본인에게 있습니다.",
    "",
    "#주식 #코스피 #코스닥 #AI주식분석 #오늘의특징주",
    "#주식투자 #주식공부 #재테크 #totalmoney",
  ].join("\n");
}

async function render(slot) {
  console.log(`1) ${slot === "morning" ? "data/morning-briefing.json" : "data/daily-market.json"} 스냅샷 로딩...`);
  const { cardData, caption } = await buildCardDataForSlot(slot);

  console.log(`3) HTML 카드 5장 빌드 중 (slot: ${slot}, 테마: ${THEME})...`);
  const cardsHTML = buildCardsHTML(cardData);

  console.log("4) PNG 스크린샷 캡처 중...");
  const { generatedDir, captionFile } = dirsFor(slot);
  mkdirSync(generatedDir, { recursive: true });
  await renderCardsToPNG(cardsHTML, generatedDir);

  writeFileSync(captionFile, caption, "utf8");
  console.log(`완료: generated/${slot}/slide-1.png ~ slide-5.png, today-caption.txt`);
}

async function publish(slot) {
  const { generatedDir, captionFile } = dirsFor(slot);
  const caption = readFileSync(captionFile, "utf8");
  console.log(`Meta Graph API로 캐러셀 발행 중 (slot: ${slot})...`);
  const result = await postInstagramCarousel(
    ["slide-1.png", "slide-2.png", "slide-3.png", "slide-4.png", "slide-5.png"].map((f) => `${slot}/${f}`),
    caption
  );
  console.log("발행 완료:", result);
}

const { slot, action } = parseArgs();

try {
  if (action === "render") await render(slot);
  else await publish(slot);
} catch (err) {
  console.error("❌ 실패:", err.message);
  process.exit(1);
}
