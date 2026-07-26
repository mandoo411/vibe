/**
 * templates/card-manpyeong-light.html -> PNG 1장 렌더링 (Puppeteer).
 * card-reel-light.html(1장 요약 카드)을 대체하는 "마감 증시 만평" 포맷 —
 * 지수 듀얼 박스 + 종목 하이라이트 배지 + AI 판단 + 내일 주목할 변수를
 * AI가 그린 무드 삽화(개구리 마스코트) 위에 얹는다.
 *
 * cardData는 promo-market-copy.mjs의 buildClosingCardData() 결과를 그대로 재사용한다
 * (date, heroPct, headline, indexRows, listItems, aiTitle/aiComment, checkpoints).
 * 숫자·종목명·문구는 전부 이 실데이터에서 오며, AI 이미지 생성 모델은 절대
 * 텍스트/숫자를 그리지 않는다(promo-gemini-background.mjs 설계 원칙과 동일).
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

function findIndexRow(indexRows, name) {
  return (indexRows || []).find((r) => r?.name === name) || null;
}

function stockBadgeHTML(item) {
  const pctNum = Number(item.pct) || 0;
  const cls = dir(pctNum);
  const pctText = `${arrow(pctNum)} ${Math.abs(pctNum).toFixed(2)}%`;
  const reason = trimToNaturalBreak(item.reason || "", 20);
  return `
      <div class="stock-badge">
        <span class="name">${item.name}</span>
        <span class="pct ${cls}">${pctText}</span>
        ${reason ? `<span class="reason">${reason}</span>` : ""}
      </div>`;
}

function checkItemHTML(text) {
  return `
      <div class="cp-item"><span class="cp-dot"></span><span>${trimToNaturalBreak(text, 46)}</span></div>`;
}

/** cardData(buildClosingCardData 결과) + 배경 이미지(data URI) -> 만평 릴스 HTML 문자열 */
export function buildManpyeongHTML(cardData, bgDataUri) {
  const {
    date, slotLabel,
    heroLabel, heroPct,
    indexRows = [],
    headline,
    aiTitle, aiComment,
    checkpointsTitle, checkpoints = [],
    listItems = [],
    theme = "light",
  } = cardData;

  const s = suffix(theme);
  const read = (name) => readFileSync(join(TEMPLATES_DIR, `${name}${s}.html`), "utf8");

  const kosdaqRow = findIndexRow(indexRows, "코스닥");
  const kosdaqPct = kosdaqRow?.pct ?? 0;

  let html = fillSimpleVars(read("card-manpyeong"), {
    DATE: date,
    SLOT_LABEL: slotLabel,
    HERO_LABEL: heroLabel,
    HERO_DIR: dir(heroPct),
    HERO_ARROW: arrow(heroPct),
    HERO_PCT: Math.abs(heroPct).toFixed(2),
    KOSDAQ_DIR: dir(kosdaqPct),
    KOSDAQ_ARROW: arrow(kosdaqPct),
    KOSDAQ_PCT: Math.abs(kosdaqPct).toFixed(2),
    HEADLINE: headline,
    AI_TITLE: aiTitle,
    AI_COMMENT: aiComment,
    CHECKPOINTS_TITLE: checkpointsTitle,
    BG_DATA_URI: bgDataUri,
  });

  const badgeBlock = listItems.slice(0, 2).map(stockBadgeHTML).join("");
  console.error("[manpyeong-debug] stockBadges=" + JSON.stringify(listItems.slice(0, 2).map((i) => i.name)) + " badgeBlockLen=" + badgeBlock.length);
  html = html.replace(/<!--STOCKBADGE_START-->[\s\S]*?<!--STOCKBADGE_END-->/, badgeBlock);

  const checkBlock = checkpoints.slice(0, 2).map(checkItemHTML).join("");
  console.error("[manpyeong-debug] checkpoints=" + JSON.stringify(checkpoints.slice(0, 2)) + " checkBlockLen=" + checkBlock.length);
  html = html.replace(/<!--CHECKITEM_START-->[\s\S]*?<!--CHECKITEM_END-->/, checkBlock);

  return html;
}

/** 만평 HTML -> 1080x1920 PNG 1장. outPath에 저장 (기존 renderReelToPNG와 동일한 캡처 로직) */
export async function renderManpyeongToPNG(html, outPath) {
  mkdirSync(join(outPath, ".."), { recursive: true });
  const tmpPath = join(TEMPLATES_DIR, `_tmp-manpyeong.html`);
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
