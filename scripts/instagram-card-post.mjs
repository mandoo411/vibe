/**
 * 인스타그램 데일리 카드뉴스 자동화 — 메인 스크립트
 * 흐름: data/daily-market.json 읽기 → Claude로 카드 문구 압축 생성 → 5장 PNG 렌더링(다크 테마 기본)
 *       → generated/ 폴더 저장 → git commit·push (워크플로우가 처리)
 *       → (push 후) Meta Graph API로 캐러셀 발행
 *
 * 사용:
 *   node scripts/instagram-card-post.mjs --render    이미지만 생성
 *   node scripts/instagram-card-post.mjs --publish   커밋된 이미지로 Graph API 발행
 */
import { loadLatestSnapshot, buildPromoCopy } from "./promo-market-copy.mjs";
import { buildCardsHTML, renderCardsToPNG } from "./promo-render-cards.mjs";
import { postInstagramCarousel } from "./promo-instagram-api.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const GENERATED_DIR = join(process.cwd(), "generated");
const CAPTION_FILE = join(GENERATED_DIR, "today-caption.txt");
const THEME = process.env.PROMO_CARD_THEME || "dark"; // 'dark' | 'light'

function todayLabel(ymd) {
  return ymd.replaceAll("-", ".");
}

async function render() {
  console.log("1) data/daily-market.json 스냅샷 로딩...");
  const snapshot = await loadLatestSnapshot();

  console.log("2) Claude로 카드 문구 압축 생성...");
  const copy = await buildPromoCopy(snapshot);

  const gainers = (snapshot.topGainers || []).slice(0, 3).map((g) => ({
    ...g,
    reason: copy.stockReasons?.[g.name] || g.reason || g.theme || "",
  }));

  console.log(`3) HTML 카드 5장 빌드 중 (테마: ${THEME})...`);
  const cardsHTML = buildCardsHTML({
    date: todayLabel(snapshot.ymd),
    kospi: snapshot.indexes.kospi,
    kosdaq: snapshot.indexes.kosdaq,
    usdKrw: snapshot.indexes.usdkrw,
    gainers,
    headline: copy.headline,
    aiComment: copy.aiComment,
    checkpoints: copy.checkpoints || [],
    theme: THEME,
  });

  console.log("4) PNG 스크린샷 캡처 중...");
  mkdirSync(GENERATED_DIR, { recursive: true });
  await renderCardsToPNG(cardsHTML, GENERATED_DIR);

  writeFileSync(CAPTION_FILE, buildCaption(snapshot, copy), "utf8");
  console.log("완료: generated/slide-1.png ~ slide-5.png, today-caption.txt");
}

function buildCaption(snapshot, copy) {
  return [
    `📊 ${todayLabel(snapshot.ymd)} 오늘의 시장 요약`,
    "",
    copy.headline,
    "",
    "🤖 AI 오늘의 판단",
    copy.aiComment,
    "",
    "전체 분석은 totalmoney.kr 에서 무료로 확인하세요.",
    "📢 실시간 알림 구독 → t.me/totalmoney_ai",
    "",
    "※ 투자 참고용 정보이며, 투자 판단 및 그 결과에 대한 책임은 투자자 본인에게 있습니다.",
    "",
    "#주식 #코스피 #코스닥 #AI주식분석 #오늘의특징주",
    "#주식투자 #주식공부 #재테크 #totalmoney",
  ].join("\n");
}

async function publish() {
  const caption = readFileSync(CAPTION_FILE, "utf8");
  console.log("Meta Graph API로 캐러셀 발행 중...");
  const result = await postInstagramCarousel(
    ["slide-1.png", "slide-2.png", "slide-3.png", "slide-4.png", "slide-5.png"],
    caption
  );
  console.log("발행 완료:", result);
}

const mode = process.argv.includes("--publish") ? "publish" : "render";

try {
  if (mode === "render") await render();
  else await publish();
} catch (err) {
  console.error("❌ 실패:", err.message);
  process.exit(1);
}
