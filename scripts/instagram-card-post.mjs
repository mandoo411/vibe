/**
 * 인스타그램 데일리 카드뉴스 자동화 — 메인 스크립트
 * 하루 2회 다른 내용으로 발행한다:
 *   --slot=morning (08:30 KST) — data/morning-briefing.json 기반, 간밤 미국장 + 오늘 전망
 *   --slot=closing (17:30 KST) — data/daily-market.json 기반, 코스피·코스닥 마감 + 특징주
 *
 * 흐름(구 캐러셀, --render/--publish): 스냅샷 읽기 → 카피 생성/변환 → 5장 PNG 렌더링 →
 *       generated/<slot>/ 저장 → git commit·push (워크플로우가 처리) → Meta Graph API로 캐러셀 발행
 *
 * 릴스(--render-reel/--publish-reel, 2026-07-28부터 캐러셀을 대체하는 신규 기본 포맷):
 * - closing: "마감 시황 TOP10"(promo-render-marketcap.mjs) — 코스피/코스닥 듀얼 지수 카드
 *   (상승/하락에 따라 카드 배경색 자체가 바뀜) + 오늘 시황 한줄 논평 + 종목 TOP10 리스트
 *   (시가총액→상승률→거래대금 순으로 날짜 기반 매일 로테이션).
 * - morning: "미국 증시 모닝 브리핑"(promo-render-usmarket.mjs) — 나스닥/S&P500/다우/나스닥선물/
 *   한국ETF(EWY) 5개 지수 리스트 + 간밤 시황 한줄 논평 + 종목 TOP10(시가총액→거래대금→주요반도체
 *   순으로 날짜 기반 매일 로테이션, 반도체 날은 9개 고정 티커).
 * 두 슬롯 모두 AI(Gemini→OpenAI→SVG 폴백)가 그린 사이버+우주 컨셉 배경 위에, 숫자/종목명은
 * 전부 코드가 직접 렌더링한 텍스트를 얹는다(할루시네이션 방지 원칙).
 *
 * 사용:
 *   node scripts/instagram-card-post.mjs --slot=morning --render-reel
 *   node scripts/instagram-card-post.mjs --slot=morning --publish-reel
 *   node scripts/instagram-card-post.mjs --slot=closing --render-reel
 *   node scripts/instagram-card-post.mjs --slot=closing --publish-reel
 */
import { loadLatestSnapshot, buildPromoCopy, buildClosingCardData } from "./promo-market-copy.mjs";
import { loadMorningSnapshot, buildMorningCardData } from "./promo-morning-copy.mjs";
import { buildCardsHTML, renderCardsToPNG } from "./promo-render-cards.mjs";
import { buildMarketcapHTML, renderMarketcapToPNG, loadRealtimeTabs } from "./promo-render-marketcap.mjs";
import { buildUsMarketHTML, renderUsMarketToPNG, pickUsRankingMode, loadRankingRowsForMode } from "./promo-render-usmarket.mjs";
import { getMarketcapReelBackground } from "./promo-gemini-background.mjs";
import { imageToReelVideo } from "./promo-image-to-video.mjs";
import { postInstagramCarousel, postInstagramReel, postInstagramStory } from "./promo-instagram-api.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { seoulYmd } from "./telegram-utils.mjs";
import { trimToNaturalBreak } from "./promo-text-utils.mjs";

const THEME = process.env.PROMO_CARD_THEME || "light"; // 'dark' | 'light' (기본: light — 사이트 기본 테마와 통일)

function todayLabel(ymd) {
  // 사용자 피드백: 릴스 헤더 날짜를 "2026.07.29" 대신 "2026년 07월 29일" 형식으로.
  const [y, m, d] = String(ymd).split("-");
  return `${y}년 ${m}월 ${d}일`;
}

function parseArgs() {
  const slotArg = process.argv.find((a) => a.startsWith("--slot="));
  const slot = slotArg ? slotArg.split("=")[1] : "closing";
  if (!["morning", "closing"].includes(slot)) {
    throw new Error(`알 수 없는 --slot 값: ${slot} (morning | closing 중 하나)`);
  }
  let action = "render";
  if (process.argv.includes("--publish")) action = "publish";
  else if (process.argv.includes("--render-reel")) action = "render-reel";
  else if (process.argv.includes("--publish-reel")) action = "publish-reel";
  return { slot, action };
}

function dirsFor(slot) {
  const generatedDir = join(process.cwd(), "generated", slot);
  const captionFile = join(generatedDir, "today-caption.txt");
  const reelPngFile = join(generatedDir, "reel.png");
  const reelMp4File = join(generatedDir, "reel.mp4");
  return { generatedDir, captionFile, reelPngFile, reelMp4File };
}

async function buildCardDataForSlot(slot) {
  if (slot === "morning") {
    const snapshot = await loadMorningSnapshot();
    const cardData = await buildMorningCardData(snapshot, { dateLabel: todayLabel(seoulYmd()), theme: THEME });
    return { cardData, caption: buildMorningCaption(cardData) };
  }

  const snapshot = await loadLatestSnapshot();
  console.log("2) Claude로 카드 문구 압축 생성...");
  const copy = await buildPromoCopy(snapshot);

  // featured_stocks(에디터가 고른 실제 이슈 종목, reason/point 포함)를 우선 사용.
  // topGainers는 거래대금 상위 원시 데이터라 reason/theme이 비어있는 경우가 많아 카드가 빈약해짐.
  // 5종목을 채워야 하므로 featured_stocks가 모자라면 topGainers로 나머지를 보충한다(중복 종목명 제외).
  const marketByCode = new Map(
    [...(snapshot.topGainers || []), ...(snapshot.topDecliners || [])].map((s) => [s.code, s.market])
  );
  const featuredAll = snapshot.featured_stocks || [];
  // featured_stocks(에디터가 고른 실제 이슈 종목)만을 |등락률| 기준 내림차순 정렬해 상위 5개를 뽑는다.
  // topGainers/topDecliners 원시 데이터는 상한가(30%) 무명 소형주가 섞여 있어 순위에 끼면 카드가 왜곡되므로,
  // featured_stocks가 5개 미만일 때만 보충용으로 사용한다.
  let gainerSource = [...featuredAll].sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  if (gainerSource.length < 5) {
    const usedNames = new Set(featuredAll.map((s) => s.name));
    const fillerAll = [...(snapshot.topGainers || []), ...(snapshot.topDecliners || [])]
      .filter((s) => !usedNames.has(s.name))
      .map((s) => ({ name: s.name, code: s.code, change: s.change, type: s.change >= 0 ? "급등" : "급락", reason: s.reason || s.theme || "" }))
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    gainerSource = [...gainerSource, ...fillerAll];
  }
  // 자연스러운 지점(공백/쉼표)에서 자르기 때문에 카드 안에서 문장이 중간에 끊기지 않는다.
  const trimReason = (s) => trimToNaturalBreak(s || "", 28);
  const gainers = gainerSource.slice(0, 5).map((g) => ({
    ...g,
    market: marketByCode.get(g.code) || "KOSPI",
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

function heroDir(pct) {
  return pct > 0 ? "up" : pct < 0 ? "down" : "flat";
}

/** 아침 미증시 릴스: Gemini 배경 생성 -> "미국 증시 모닝 브리핑" HTML 채우기 -> PNG -> mp4 변환 */
async function renderMorningReel() {
  const { generatedDir, captionFile, reelPngFile, reelMp4File } = dirsFor("morning");
  mkdirSync(generatedDir, { recursive: true });

  console.log("1) data/morning-briefing.json 스냅샷 로딩...");
  const snapshot = await loadMorningSnapshot();
  // 캡션(발행 문구)은 기존 캐러셀 경로와 동일하게 buildMorningCardData의 headline/aiComment를 재사용한다.
  const captionCardData = await buildMorningCardData(snapshot, { dateLabel: todayLabel(seoulYmd()), theme: THEME });
  const caption = buildMorningCaption(captionCardData);

  const ymd = seoulYmd();
  const mode = pickUsRankingMode(ymd);
  console.log(`2) 오늘의 TOP 로테이션 모드: ${mode.key}(${mode.label})`);
  const rows = await loadRankingRowsForMode(mode);

  console.log("3) Gemini로 사이버+우주 배경 이미지 생성 중 (실패 시 OpenAI -> SVG 순으로 대체)...");
  const nasdaqPct = snapshot.usMarket?.indices?.find((i) => i.id === "nasdaq")?.changePct ?? 0;
  const bgDataUri = await getMarketcapReelBackground(heroDir(nasdaqPct));

  console.log("4) 아침 미증시 릴스 HTML 빌드 중...");
  const html = buildUsMarketHTML({
    cardData: { date: todayLabel(ymd), slotLabel: "모닝 브리핑" },
    snapshot,
    rows,
    mode,
    bgDataUri,
  });

  console.log("5) PNG 스크린샷 캡처 중...");
  await renderUsMarketToPNG(html, reelPngFile);

  console.log("6) mp4(릴스용 무음 영상)로 변환 중...");
  await imageToReelVideo(reelPngFile, reelMp4File);

  writeFileSync(captionFile, caption, "utf8");
  console.log(`완료: generated/morning/reel.png, reel.mp4, today-caption.txt`);
}

/** 마감 시황 릴스: Gemini 배경 생성 -> "마감 시황 TOP10" HTML 채우기 -> PNG -> mp4 변환까지 한 번에 처리 */
async function renderClosingReel() {
  console.log("1) data/daily-market.json 스냅샷 로딩...");
  const snapshot = await loadLatestSnapshot();
  console.log("2) Claude로 카드 문구 압축 생성...");
  const copy = await buildPromoCopy(snapshot);
  const cardData = buildClosingCardData({
    snapshot,
    copy,
    gainers: [],
    dateLabel: todayLabel(snapshot.ymd),
    theme: THEME,
  });
  const caption = buildClosingCaption(snapshot, copy);

  console.log("3) Gemini로 사이버+우주 배경 이미지 생성 중 (실패 시 OpenAI -> SVG 순으로 대체)...");
  const bgDataUri = await getMarketcapReelBackground(heroDir(cardData.heroPct));

  console.log("4) data/kr-realtime.json 로딩 (시가총액/상승률/거래대금 TOP10 로테이션용)...");
  const realtimeTabs = await loadRealtimeTabs();

  console.log(`5) 마감 시황 TOP10 릴스 HTML 빌드 중 (slot: closing)...`);
  const html = buildMarketcapHTML({ cardData, snapshot, realtimeTabs, bgDataUri });

  console.log("6) PNG 스크린샷 캡처 중...");
  const { generatedDir, captionFile, reelPngFile, reelMp4File } = dirsFor("closing");
  mkdirSync(generatedDir, { recursive: true });
  await renderMarketcapToPNG(html, reelPngFile);

  console.log("7) mp4(릴스용 무음 영상)로 변환 중...");
  await imageToReelVideo(reelPngFile, reelMp4File);

  writeFileSync(captionFile, caption, "utf8");
  console.log(`완료: generated/closing/reel.png, reel.mp4, today-caption.txt`);
}

async function renderReel(slot) {
  if (slot === "morning") return renderMorningReel();
  return renderClosingReel();
}

async function publishReel(slot) {
  const { captionFile } = dirsFor(slot);
  const caption = readFileSync(captionFile, "utf8");
  console.log(`Meta Graph API로 릴스 발행 중 (slot: ${slot})...`);
  const result = await postInstagramReel(`${slot}/reel.mp4`, caption);
  console.log("발행 완료:", result);

  // 같은 영상을 스토리에도 올린다. 릴스 발행이 이미 끝난 뒤의 부가 단계이므로,
  // 여기서 실패해도(일시적 API 오류 등) 릴스 발행 자체나 아래 dedup 기록(last-published-date.txt)에
  // 영향을 주지 않도록 별도로 감싸서 에러를 삼킨다 — 실패 시 다음 스케줄에서 릴스만 다시 안 나가면 된다.
  try {
    console.log(`Meta Graph API로 스토리 발행 중 (slot: ${slot})...`);
    const storyResult = await postInstagramStory(`${slot}/reel.mp4`);
    console.log("스토리 발행 완료:", storyResult);
  } catch (err) {
    console.warn("⚠️ 스토리 발행 실패 (릴스는 정상 발행됨, 무시하고 계속):", err.message);
  }
}

const { slot, action } = parseArgs();

try {
  if (action === "render") await render(slot);
  else if (action === "publish") await publish(slot);
  else if (action === "render-reel") await renderReel(slot);
  else await publishReel(slot);
} catch (err) {
  console.error("❌ 실패:", err.message);
  process.exit(1);
}
