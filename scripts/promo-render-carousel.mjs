/**
 * 카드뉴스 v2 — 인스타그램 캐러셀 렌더러 (1080x1350 PNG)
 *
 * 왜 캐러셀인가: 인스타 릴스는 시청 유지율로 추천이 결정되는데, 정지 이미지 1장짜리 영상은
 * 1초 이탈이 찍혀서 알고리즘이 밀어주지 않는다. 같은 내용을 캐러셀로 올리면 판정 지표가
 * 체류시간·저장으로 바뀌고, 정보성 카드뉴스는 그쪽이 훨씬 유리하다.
 *
 * 덱(deck) 데이터는 `data/promo/<slot>-<YYYY-MM-DD>.json`에 들어 있고,
 * 슬라이드 구성(builders)은 슬롯별로 다르다. 슬라이드 1번은 항상 훅, 마지막은 항상 CTA다.
 *
 * 사용:
 *   node scripts/promo-render-carousel.mjs --deck=data/promo/closing-2026-09-04.json --out=generated/closing-v2
 */
import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  slideHook, slideVerdict, slideFlow, slideStocks, slideCTA,
  slideIndex, slideWatch, slideRank, slideKrRank,
} from "./promo-carousel-slides.mjs";

const TEMPLATES_DIR = join(process.cwd(), "templates");

/** 슬롯별 슬라이드 구성. 1번=훅, 마지막=CTA는 공통이고 가운데만 바뀐다. */
export const LAYOUTS = {
  closing: [slideHook, slideVerdict, slideFlow, slideStocks, slideCTA],
  morning: [slideHook, slideIndex, slideVerdict, slideWatch, slideCTA],
  ranking: [slideHook, slideRank, slideKrRank, slideCTA],
};

export function buildersFor(deck) {
  const layout = LAYOUTS[deck.layout || deck.slot];
  if (!layout) throw new Error(`알 수 없는 레이아웃: ${deck.layout || deck.slot}`);
  return layout;
}

/**
 * 덱 → PNG. 임시 HTML을 templates/ 안에 쓰는 이유는 폰트(templates/fonts/…)를
 * 상대경로로 읽게 하기 위해서다. 렌더가 끝나면 임시 파일은 지운다.
 */
export async function renderDeckToPNG(deck, outDir) {
  const builders = buildersFor(deck);
  mkdirSync(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 2 });

  const tmpFiles = [];
  const outputs = [];
  try {
    for (let i = 0; i < builders.length; i++) {
      const html = builders[i](deck);
      const tmpPath = join(TEMPLATES_DIR, `_tmp-carousel-${i + 1}.html`);
      writeFileSync(tmpPath, html);
      tmpFiles.push(tmpPath);

      await page.goto(`file://${tmpPath}`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await new Promise((r) => setTimeout(r, 300));

      // 카드 규격(1350px)을 넘으면 글자가 잘린 채 발행되므로 즉시 실패시킨다.
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h > 1350) throw new Error(`슬라이드 ${i + 1} 내용이 카드 높이를 넘었습니다 (${h}px > 1350px)`);

      const outPath = join(outDir, `slide-${i + 1}.png`);
      await page.screenshot({ path: outPath });
      outputs.push(outPath);
      console.log(`  ✓ slide-${i + 1}.png`);
    }
  } finally {
    await browser.close();
    for (const f of tmpFiles) { try { unlinkSync(f); } catch {} }
  }
  return outputs;
}

export function loadDeck(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/* ── CLI ── */
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, dflt) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split("=").slice(1).join("=") : dflt;
  };
  const deckPath = arg("deck");
  if (!deckPath) throw new Error("--deck=<경로> 가 필요합니다");
  const deck = loadDeck(deckPath);
  const outDir = arg("out", `generated/${deck.slot}-v2`);
  console.log(`[carousel] ${deckPath} → ${outDir} (layout=${deck.layout || deck.slot})`);
  await renderDeckToPNG(deck, outDir);
  if (deck.caption) {
    writeFileSync(join(outDir, "caption.txt"), deck.caption, "utf8");
    console.log("  ✓ caption.txt");
  }
  console.log("[carousel] 완료");
}
