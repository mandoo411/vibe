/**
 * templates/*.html -> PNG 렌더링 (Puppeteer)
 * 카드뉴스 5장(커버/지수/리스트/AI 코멘트/CTA)을 만든다.
 *
 * 아침 브리핑(간밤 미국장 + 오늘 전망) / 마감 시황(코스피·코스닥 마감 + 특징주) 두 모드를
 * 같은 템플릿으로 렌더링할 수 있도록, 모드별 어댑터(promo-market-copy.mjs / promo-morning-copy.mjs)가
 * 아래의 공통 cardData 형태로 값을 만들어 넘겨준다.
 *
 * cardData 형태:
 * {
 *   date, slotLabel,                    // "2026.07.15", "마감 시황" | "아침 브리핑"
 *   coverTitleLine1, coverTitleLine2,    // 커버 제목 2줄
 *   heroLabel, heroPct,                  // 커버 큰 수치("코스피" / "나스닥" 등 + 등락률)
 *   headline,                            // 커버 하단 인용구
 *   indexTitle, indexRows: [{name, value, pct}],       // 슬라이드 2
 *   listTitle, listItems: [{name, reason, pct?}],      // 슬라이드 3 (pct 없으면 등락 배지 생략)
 *   aiTitle, aiComment,                  // 슬라이드 4
 *   checkpointsTitle, checkpoints: [string],
 *   theme: 'dark' | 'light',
 * }
 */
import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const TEMPLATES_DIR = join(process.cwd(), "templates");

function fillSimpleVars(html, vars) {
  let out = html;
  for (const [key, val] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, String(val));
  }
  return out;
}

function fillRepeatBlock(html, markerName, items, rowBuilder) {
  const re = new RegExp(`<!--${markerName}_TEMPLATE_START[\\s\\S]*?${markerName}_TEMPLATE_END-->`);
  return html.replace(re, items.map(rowBuilder).join("\n"));
}

const arrow = (pct) => (pct > 0 ? "▲" : pct < 0 ? "▼" : "");
const dir = (pct) => (pct > 0 ? "up" : pct < 0 ? "down" : "flat");
const suffix = (theme) => (theme === "light" ? "-light" : "");

/** 커버 히어로 수치 옆에 넣는 미니 트렌드 스파크라인 SVG (상승/하락/보합에 따라 색·모양 변경) */
function heroTrendSVG(pct) {
  const up = pct > 0;
  const flat = pct === 0;
  const color = flat ? "#9aa3b2" : up ? "#e24b4a" : "#3b82f6";
  const points = flat
    ? "4,30 20,30 36,30 52,30 68,30 84,30 100,30"
    : up
    ? "4,44 20,38 36,40 52,26 68,30 84,12 100,6"
    : "4,6 20,12 36,10 52,24 68,20 84,38 100,44";
  const dotXY = up ? "100,6" : flat ? "100,30" : "100,44";
  const [dx, dy] = dotXY.split(",");
  return `<svg viewBox="0 0 104 50" fill="none" xmlns="http://www.w3.org/2000/svg">
    <polyline points="${points}" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
    <circle cx="${dx}" cy="${dy}" r="6" fill="${color}"/>
  </svg>`;
}

/** 5장의 카드에 들어갈 HTML을 채워서 반환. cardData.theme: 'dark' | 'light' */
export function buildCardsHTML(cardData) {
  const {
    date, slotLabel,
    coverTitleLine1, coverTitleLine2,
    heroLabel, heroPct,
    headline,
    indexTitle, indexRows = [],
    listTitle, listItems = [],
    aiTitle, aiComment,
    checkpointsTitle, checkpoints = [],
    theme = "dark",
  } = cardData;

  const s = suffix(theme);
  const read = (name) => readFileSync(join(TEMPLATES_DIR, `${name}${s}.html`), "utf8");

  const cover = fillSimpleVars(read("card-cover"), {
    DATE: date,
    SLOT_LABEL: slotLabel,
    COVER_TITLE_LINE1: coverTitleLine1,
    COVER_TITLE_LINE2: coverTitleLine2,
    HERO_LABEL: heroLabel,
    HERO_DIR: dir(heroPct),
    HERO_ARROW: arrow(heroPct),
    HERO_PCT: Math.abs(heroPct).toFixed(2),
    HERO_TREND_SVG: heroTrendSVG(heroPct),
    HEADLINE: headline,
  });

  let index = read("card-index");
  index = fillSimpleVars(index, { PAGE_TITLE: indexTitle });
  index = fillRepeatBlock(index, "ROW", indexRows, (r) => `
    <div class="panel row">
      <div class="name">${r.name}</div>
      <div class="value">${r.value}</div>
      <div class="pct ${dir(r.pct)}">${r.pct ? `${arrow(r.pct)} ${Math.abs(r.pct).toFixed(2)}%` : ""}</div>
    </div>`);

  let stocks = read("card-stocks");
  stocks = fillSimpleVars(stocks, { PAGE_TITLE: listTitle });
  stocks = fillRepeatBlock(stocks, "ITEM", listItems.slice(0, 5), (g, i) => `
    <div class="panel item">
      <div class="rank ${i === 0 ? "gold" : ""}">${i + 1}</div>
      <div class="info">
        <div class="name">${g.name}</div>
        <div class="reason">${g.reason || ""}</div>
      </div>
      <div class="pct ${dir(g.pct)}">${g.pct != null ? `${arrow(g.pct)} ${Math.abs(g.pct).toFixed(2)}%` : ""}</div>
    </div>`);

  let ai = read("card-ai");
  ai = fillSimpleVars(ai, { PAGE_TITLE: aiTitle, AI_COMMENT: aiComment, CHECKPOINTS_TITLE: checkpointsTitle });
  ai = fillRepeatBlock(ai, "TAG", checkpoints.slice(0, 3), (c) => `<span class="tag-gold">${c}</span>`);

  const cta = read("card-cta");

  return { cover, index, stocks, ai, cta };
}

/** HTML 5장을 1080x1350 PNG로 캡처. outDir에 slide-1.png ~ slide-5.png 저장 */
export async function renderCardsToPNG(cardsHTML, outDir) {
  mkdirSync(outDir, { recursive: true });
  const tmpFiles = [];
  const order = ["cover", "index", "stocks", "ai", "cta"];

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 2 });

  const outputs = [];
  try {
    for (let i = 0; i < order.length; i++) {
      const key = order[i];
      const tmpPath = join(TEMPLATES_DIR, `_tmp-${key}.html`);
      writeFileSync(tmpPath, cardsHTML[key]);
      tmpFiles.push(tmpPath);

      await page.goto(`file://${tmpPath}`, { waitUntil: "networkidle0" });
      const outPath = join(outDir, `slide-${i + 1}.png`);
      await page.screenshot({ path: outPath });
      outputs.push(outPath);
    }
  } finally {
    await browser.close();
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch {}
    }
  }
  return outputs;
}
