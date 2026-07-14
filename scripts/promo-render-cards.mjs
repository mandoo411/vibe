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
  stocks = fillRepeatBlock(stocks, "ITEM", listItems.slice(0, 3), (g, i) => `
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
