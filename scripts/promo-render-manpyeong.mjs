/**
 * templates/card-manpyeong-light.html -> PNG 1장 렌더링 (Puppeteer).
 * card-reel-light.html(1장 요약 카드)을 대체하는 "마감 증시 만평" 포맷 v2 —
 * 임팩트 우선으로 (1) 지수 등락 (2) 오늘 왜 움직였는지 (3) 오늘의 이슈 종목,
 * 이 3가지만 크게 구성해 AI가 그린 무드 삽화(개구리 마스코트) 위에 얹는다.
 * (v1에 있던 AI 판단 박스 / 내일 주목할 변수 박스는 화면이 복잡해진다는 피드백으로 제거)
 *
 * cardData는 promo-market-copy.mjs의 buildClosingCardData() 결과를 그대로 재사용한다
 * (date, heroPct, headline, indexRows, listItems 만 사용). 숫자·종목명·문구는 전부 이
 * 실데이터에서 오며, AI 이미지 생성 모델은 절대 텍스트/숫자를 그리지 않는다
 * (promo-gemini-background.mjs 설계 원칙과 동일).
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

/** 오늘의 이슈 종목 카드 — 이름/등락률은 크게, 이유는 최대 2줄까지 허용(말줄임 대신 줄바꿈) */
function stockCardHTML(item) {
  const pctNum = Number(item.pct) || 0;
  const cls = dir(pctNum);
  const pctText = `${arrow(pctNum)} ${Math.abs(pctNum).toFixed(2)}%`;
  const reason = trimToNaturalBreak(item.reason || "", 40);
  return `
      <div class="stock-card">
        <div class="row1">
          <span class="name">${item.name}</span>
          <span class="pct ${cls}">${pctText}</span>
        </div>
        ${reason ? `<div class="reason">${reason}</div>` : ""}
      </div>`;
}

/** cardData(buildClosingCardData 결과) + 배경 이미지(data URI) -> 만평 릴스 HTML 문자열 */
export function buildManpyeongHTML(cardData, bgDataUri) {
  const {
    date, slotLabel,
    heroLabel, heroPct,
    indexRows = [],
    headline,
    reasonLine,
    listItems = [],
    theme = "light",
  } = cardData;

  const s = suffix(theme);
  const read = (name) => readFileSync(join(TEMPLATES_DIR, `${name}${s}.html`), "utf8");

  const kospiRow = findIndexRow(indexRows, heroLabel) || findIndexRow(indexRows, "코스피");
  const kosdaqRow = findIndexRow(indexRows, "코스닥");
  const kosdaqPct = kosdaqRow?.pct ?? 0;

  // 등락률(%)만 있으면 임팩트는 있지만 "진짜 데이터"라는 신뢰감이 약하다.
  // 실제 언론/증권사 카드는 항상 "종가 + 등락률"을 함께 보여준다 — indexRows에 이미
  // 있는 실제 종가(value)를 그대로 재사용해 추가한다 (신규 계산·AI 개입 없음, 코드 렌더).
  let html = fillSimpleVars(read("card-manpyeong"), {
    DATE: date,
    SLOT_LABEL: slotLabel,
    HERO_LABEL: heroLabel,
    HERO_VALUE: kospiRow?.value ?? "—",
    HERO_DIR: dir(heroPct),
    HERO_ARROW: arrow(heroPct),
    HERO_PCT: Math.abs(heroPct).toFixed(2),
    KOSDAQ_VALUE: kosdaqRow?.value ?? "—",
    KOSDAQ_DIR: dir(kosdaqPct),
    KOSDAQ_ARROW: arrow(kosdaqPct),
    KOSDAQ_PCT: Math.abs(kosdaqPct).toFixed(2),
    HEADLINE: reasonLine || headline,
    BG_DATA_URI: bgDataUri,
  });

  const cardBlock = listItems.slice(0, 2).map(stockCardHTML).join("");
  console.error("[manpyeong-debug] stockCards=" + JSON.stringify(listItems.slice(0, 2).map((i) => i.name)) + " cardBlockLen=" + cardBlock.length);
  html = html.replace(/<!--STOCKBADGE_START-->[\s\S]*?<!--STOCKBADGE_END-->/, cardBlock);

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
