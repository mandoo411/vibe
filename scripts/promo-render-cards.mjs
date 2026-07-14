/**
 * templates/*.html -> PNG 렌더링 (Puppeteer)
 * 카드뉴스 5장(커버/지수/특징주/AI판단/CTA)을 만든다.
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

/** 5장의 카드에 들어갈 HTML을 채워서 반환. theme: 'dark' | 'light' */
export function buildCardsHTML({ date, kospi, kosdaq, usdKrw, gainers, headline, aiComment, checkpoints, theme = "dark" }) {
  const s = suffix(theme);
  const read = (name) => readFileSync(join(TEMPLATES_DIR, `${name}${s}.html`), "utf8");

  const cover = fillSimpleVars(read("card-cover"), {
    DATE: date,
    KOSPI_DIR: dir(kospi.changePercent),
    KOSPI_ARROW: arrow(kospi.changePercent),
    KOSPI_PCT: Math.abs(kospi.changePercent).toFixed(2),
    HEADLINE: headline,
  });

  let index = read("card-index");
  const indexRows = [
    { name: "코스피", value: kospi.close.toLocaleString(), pct: kospi.changePercent },
    { name: "코스닥", value: kosdaq.close.toLocaleString(), pct: kosdaq.changePercent },
    ...(usdKrw?.rate ? [{ name: "원/달러", value: `${Math.round(usdKrw.rate).toLocaleString()}원`, pct: 0 }] : []),
  ];
  index = fillRepeatBlock(index, "ROW", indexRows, (r) => `
    <div class="panel row">
      <div class="name">${r.name}</div>
      <div class="value">${r.value}</div>
      <div class="pct ${dir(r.pct)}">${arrow(r.pct)} ${r.pct ? Math.abs(r.pct).toFixed(2) + "%" : ""}</div>
    </div>`);

  let stocks = read("card-stocks");
  stocks = fillRepeatBlock(stocks, "ITEM", gainers.slice(0, 3), (g, i) => `
    <div class="panel item">
      <div class="rank ${i === 0 ? "gold" : ""}">${i + 1}</div>
      <div class="info">
        <div class="name">${g.name}</div>
        <div class="reason">${g.reason || ""}</div>
      </div>
      <div class="pct ${dir(g.change)}">${arrow(g.change)} ${Math.abs(g.change).toFixed(2)}%</div>
    </div>`);

  let ai = read("card-ai");
  ai = fillSimpleVars(ai, { AI_COMMENT: aiComment });
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
