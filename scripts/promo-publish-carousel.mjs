/**
 * 카드뉴스 v2 캐러셀 발행 (Meta Graph API)
 *
 * 전제: generated/<dir>/ 안의 PNG가 이미 main에 push돼 있어야 한다.
 * Graph API는 공개 URL만 읽을 수 있어서 raw.githubusercontent.com 경로를 넘긴다.
 *
 * 사용:
 *   node scripts/promo-publish-carousel.mjs --dir=closing-v2 --deck=data/promo/closing-2026-09-04.json
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { postInstagramCarousel } from "./promo-instagram-api.mjs";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};

const dir = arg("dir");
const deckPath = arg("deck");
if (!dir) throw new Error("--dir=<generated 하위 폴더명> 이 필요합니다");

// 캡션은 덱 JSON을 우선하고, 없으면 렌더 단계가 떨궈 둔 caption.txt를 쓴다.
let caption = "";
if (deckPath && existsSync(deckPath)) caption = JSON.parse(readFileSync(deckPath, "utf8")).caption || "";
if (!caption) {
  const p = join("generated", dir, "caption.txt");
  if (existsSync(p)) caption = readFileSync(p, "utf8");
}
if (!caption.trim()) throw new Error("캡션이 비어 있습니다 — 덱 JSON의 caption 또는 caption.txt를 확인하세요");

// 존재하는 슬라이드만 모은다(레이아웃마다 장수가 다르다. 인스타 캐러셀은 2~10장).
const files = [];
for (let i = 1; i <= 10; i++) {
  const rel = `${dir}/slide-${i}.png`;
  if (existsSync(join("generated", rel))) files.push(rel);
}
if (files.length < 2) throw new Error(`캐러셀에 필요한 이미지가 부족합니다 (${files.length}장)`);

console.log(`[publish] ${files.length}장 발행 시작`);
files.forEach((f) => console.log(`  - ${f}`));
console.log(`[publish] 캡션 ${caption.length}자, 첫 줄: ${caption.split("\n")[0]}`);

if (process.env.PROMO_DRY_RUN === "1") {
  console.log("[publish] PROMO_DRY_RUN=1 — 실제 발행하지 않고 종료합니다.");
  process.exit(0);
}

const res = await postInstagramCarousel(files, caption);
console.log(`[publish] 발행 완료 · media id = ${res.id}`);
