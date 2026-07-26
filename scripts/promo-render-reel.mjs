/**
 * templates/card-reel(-light).html -> PNG 1장 렌더링 (Puppeteer).
 * 5장 카드뉴스 대신 릴스용 1장 요약 카드(9:16, 1080x1920)를 만든다.
 * cardData 형태는 promo-render-cards.mjs와 동일한 공통 포맷을 그대로 재사용한다.
 */
import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { trimToNaturalBreak } from "./promo-text-utils.mjs";

const TEMPLATES_DIR = join(process.cwd(), "templates");

function fillSimpleVars(html, vars) {
  let out = html;
  for (const [key, val] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, String(val));
  }
  return out;
}

const arrow = (pct) => (pct > 0 ? "▲" : pct < 0 ? "▼" : "");
const dir = (pct) => (pct > 0 ? "up" : pct < 0 ? "down" : "flat");
const suffix = (theme) => (theme === "light" ? "-light" : "");

function checkChip(text, checkColor) {
  return `
      <span class="tag-gold">
        <svg class="chk" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="11" fill="${checkColor}"/><path d="M7 12.5l3 3 7-7.5" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>${text}</span>
      </span>`;
}

/** cardData + 배경 이미지(data URI) -> 릴스 카드 HTML 문자열 */
export function buildReelHTML(cardData, bgDataUri) {
  const {
    date, slotLabel,
    coverTitleLine1, coverTitleLine2,
    heroLabel, heroPct,
    headline,
    aiTitle, aiComment,
    checkpoints = [],
    theme = "light",
  } = cardData;

  const s = suffix(theme);
  const read = (name) => readFileSync(join(TEMPLATES_DIR, `${name}${s}.html`), "utf8");
  const checkColor = theme === "light" ? "#0f8387" : "#d4af37";

  let html = fillSimpleVars(read("card-reel"), {
    DATE: date,
    SLOT_LABEL: slotLabel,
    COVER_TITLE_LINE1: coverTitleLine1,
    COVER_TITLE_LINE2: coverTitleLine2,
    HERO_LABEL: heroLabel,
    HERO_DIR: dir(heroPct),
    HERO_ARROW: arrow(heroPct),
    HERO_PCT: Math.abs(heroPct).toFixed(2),
    HEADLINE: headline,
    AI_TITLE: aiTitle,
    AI_COMMENT: aiComment,
    BG_DATA_URI: bgDataUri,
  });

  const chipBlock = checkpoints.slice(0, 1).map((c) => checkChip(trimToNaturalBreak(c, 34), checkColor)).join("
");
  console.error("DEBUG_CHECKPOINTS=" + JSON.stringify(checkpoints));
  console.error("DEBUG_CHIPBLOCK_LEN=" + chipBlock.length);
  html = html.replace(/<!--CHIP_TEMPLATE_START-->[\s\S]*?<!--CHIP_TEMPLATE_END-->/, chipBlock);

  return html;
}

/** 릴스 HTML -> 1080x1920 PNG 1장. outPath에 저장 */
export async function renderReelToPNG(html, outPath) {
  mkdirSync(join(outPath, ".."), { recursive: true });
  const tmpPath = join(TEMPLATES_DIR, `_tmp-reel.html`);
  writeFileSync(tmpPath, html);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 2 });
    await page.goto(`file://${tmpPath}`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: outPath });
  } finally {
    await browser.close();
    try { unlinkSync(tmpPath); } catch {}
  }
  return outPath;
}
