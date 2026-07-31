/**
 * templates/card-usmarket-reel.html -> PNG 1장 렌더링 (Puppeteer).
 * "아침 미증시 브리핑 릴스" — 마감 시황 릴스(promo-render-marketcap.mjs)와 동일한 구조/톤을
 * 간밤 미국장 결과에 맞게 재구성한 버전. 지수 2개 대신 5개(나스닥/S&P500/다우/나스닥선물/한국ETF)를
 * 컴팩트 리스트로 보여주고, 하단 TOP10은 시가총액 -> 거래대금 -> 주요반도체 순으로 매일 로테이션한다.
 *
 * 데이터 출처:
 * - 지수 5개: data/morning-briefing.json의 usMarket.indices (morning-briefing.mjs가 매일 갱신,
 *   다우지수는 이번에 US_INDICES 배열에 새로 추가함 — 다음 morning-briefing 실행부터 포함됨)
 * - 시가총액/거래대금 TOP10: data/us-market-cap.json / data/us-market-volume.json (이미 존재,
 *   market-data-sync.yml이 주기적으로 갱신 — KR 파이프라인의 kr-realtime.json과 동일한 역할)
 * - 주요반도체 TOP10: 사용자가 지정한 9개 티커(NVDA/TSM/AVGO/ASML/AMD/MU/INTC/SKHY/SNDK)를
 *   Yahoo Finance에서 그때그때 직접 조회한다(캐시 파일이 따로 없어서 — cap/volume처럼 사전 동기화된
 *   스냅샷이 아니라 렌더 시점에 실시간으로 가져옴). 사용자가 "TOP10"이라 했지만 실제로 나열한 종목은
 *   9개라 9개만 표시한다(추가 요청 시 반도체 대형주 하나를 더 넣을 수 있음).
 *
 * 숫자/종목명은 전부 코드가 직접 렌더링하고, 배경(우주+사이버 컨셉)만 AI가 그린다 — 마감 릴스와 동일 원칙.
 */
import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./telegram-utils.mjs";
import { buildCommentLine } from "./promo-render-marketcap.mjs";

const TEMPLATES_DIR = join(process.cwd(), "templates");
const US_CAP_PATH = process.env.US_CAP_PATH || "./data/us-market-cap.json";
const US_VOLUME_PATH = process.env.US_VOLUME_PATH || "./data/us-market-volume.json";

function fillVars(html, vars) {
  let out = html;
  for (const [key, val] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, String(val));
  }
  return out;
}

const arrow = (pct) => (pct > 0 ? "▲" : pct < 0 ? "▼" : "—");
const dir = (pct) => (pct > 0 ? "up" : pct < 0 ? "down" : "flat");
const toNum = (v) => Number(String(v ?? "").replace(/,/g, "")) || 0;

/** 사용자 요청 순서 고정: 나스닥 -> S&P500 -> 다우지수 -> 나스닥 선물 -> 한국 ETF(EWY) */
const INDEX_ORDER = [
  { id: "nasdaq", code: "NASDAQ 100" },
  { id: "sp500", code: "S&P 500" },
  { id: "dow", code: "DOW JONES" },
  { id: "nasdaq-futures", code: "NASDAQ FUT" },
  { id: "korea-etf", code: "NYSE : EWY" },
];

const RANKING_MODES = [
  { key: "cap", label: "시가총액 TOP10" },
  { key: "volume", label: "거래대금 TOP10" },
  { key: "semi", label: "주요반도체 TOP10" },
];

/** 날짜(YYYY-MM-DD, KST 기준) 기반 로테이션 — 마감 릴스의 pickRankingMode와 동일한 방식. */
export function pickUsRankingMode(ymd) {
  const d = new Date(`${ymd}T00:00:00+09:00`);
  const startOfYear = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const dayOfYear = Math.floor((d - startOfYear) / 86400000);
  return RANKING_MODES[((dayOfYear % 3) + 3) % 3];
}

// 사용자가 지정한 순서 그대로(시총/거래대금 순이 아니라 "주요 반도체 밸류체인" 관점의 나열).
const SEMI_TICKERS = [
  { ticker: "NVDA", name: "엔비디아" },
  { ticker: "TSM", name: "TSMC(ADR)" },
  { ticker: "AVGO", name: "브로드컴" },
  { ticker: "ASML", name: "ASML홀딩(ADR)" },
  { ticker: "AMD", name: "AMD" },
  { ticker: "MU", name: "마이크론" },
  { ticker: "INTC", name: "인텔" },
  { ticker: "SKHY", name: "SK하이닉스(ADR)" },
  { ticker: "SNDK", name: "샌디스크" },
];

async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result?.meta) throw new Error(`Yahoo ${symbol} empty`);
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose;
  if (price == null || prevClose == null) throw new Error(`Yahoo ${symbol} no price`);
  const changePoints = price - prevClose;
  const changePct = (changePoints / prevClose) * 100;
  return { price, changePoints, changePct };
}

/** us-market-cap.json / us-market-volume.json 공통 정규화 (rank/name/ticker/price/changeAmt/changePct) */
function normalizeCachedRows(stocks) {
  return (stocks || []).slice(0, 10).map((s, i) => ({
    rank: s.rank || i + 1,
    name: s.name,
    ticker: s.ticker,
    price: toNum(s.price),
    changeAmt: toNum(s.changePoints),
    changePct: Number(s.changePct) || 0,
  }));
}

export async function loadUsCapTop10() {
  const raw = await readJson(US_CAP_PATH);
  return normalizeCachedRows(raw?.stocks);
}

export async function loadUsVolumeTop10() {
  const raw = await readJson(US_VOLUME_PATH);
  return normalizeCachedRows(raw?.stocks);
}

/** 주요반도체 TOP(9개) — 캐시 파일이 없어 렌더 시점에 Yahoo에서 직접 조회 */
export async function fetchSemiTop() {
  const rows = [];
  for (let i = 0; i < SEMI_TICKERS.length; i++) {
    const { ticker, name } = SEMI_TICKERS[i];
    try {
      const q = await fetchYahooQuote(ticker);
      rows.push({
        rank: i + 1,
        name,
        ticker,
        price: q.price,
        changeAmt: q.changePoints,
        changePct: q.changePct,
      });
    } catch (error) {
      console.warn(`[usmarket-reel] ${ticker} 시세 조회 실패: ${error instanceof Error ? error.message : error}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return rows;
}

/** 오늘의 로테이션 모드에 맞는 TOP10(또는 TOP9) 행을 가져온다 */
export async function loadRankingRowsForMode(mode) {
  if (mode.key === "cap") return loadUsCapTop10();
  if (mode.key === "volume") return loadUsVolumeTop10();
  return fetchSemiTop();
}

function usIndexRowHTML(entry, idx) {
  const cls = dir(idx.changePct);
  const isEtf = entry.id === "korea-etf";
  const valueFmt = isEtf
    ? `$${Number(idx.close).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : Number(idx.close).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const changePointsFmt = idx.changePoints != null ? Math.abs(idx.changePoints).toFixed(2) : "0.00";
  return `
      <div class="usidx-row ${cls}">
        <div class="usidx-name-wrap">
          <span class="usidx-name">${idx.name}</span>
          <span class="usidx-code">${entry.code}</span>
        </div>
        <div class="usidx-value-wrap">
          <span class="usidx-value ${cls}">${valueFmt}</span>
          <span class="usidx-change ${cls}">${arrow(idx.changePct)} ${changePointsFmt} (${Math.abs(idx.changePct).toFixed(2)}%)</span>
        </div>
      </div>`;
}

function rankingRowHTML(row) {
  const cls = dir(row.changePct);
  const rankCls = row.rank <= 3 ? "gold" : "";
  const priceFmt = `$${row.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const changeSign = row.changeAmt > 0 ? "+" : row.changeAmt < 0 ? "-" : "";
  const changeFmt = `${changeSign}${Math.abs(row.changeAmt).toFixed(2)}`;
  const pctText = `${arrow(row.changePct)} ${Math.abs(row.changePct).toFixed(2)}%`;
  return `
      <div class="mcap-row ${cls}">
        <div class="rank ${rankCls}">${row.rank}</div>
        <div class="stock-info">
          <span class="stock-name">${row.name}</span>
          <span class="stock-price">${priceFmt}</span>
          <span class="stock-change ${cls}">${changeFmt}</span>
        </div>
        <div class="stock-pct ${cls}">${pctText}</div>
      </div>`;
}

// aiAnalysis.conclusion / todayOutlook.scenario는 관행적으로 "전일 회고 문장 + 오늘 전망 문장" 2문장
// 구조로 작성된다. 첫 문장(전일 마감시황 회고)은 마감 릴스 쪽 논평과 내용이 겹치므로, 아침 릴스에는
// 그 다음 문장(오늘 예상흐름/전략)을 우선 쓴다 — "전날 시황보다 오늘 예상흐름이나 간밤 미증시 시황
// 위주로" 써야 한다는 피드백 반영. 문장이 하나뿐이면(둘째 문장이 없으면) 원문 전체로 폴백한다.
function afterFirstSentence(text) {
  const s = String(text || "").trim();
  const m = s.match(/^[^.!?]*[.!?]+\s*/);
  if (!m) return "";
  return s.slice(m[0].length).trim();
}

/** 아침 릴스 한줄 논평 소스 선택: conclusion의 "오늘" 문장 -> todayOutlook의 "오늘" 문장 ->
 * todayOutlook 전체 -> conclusion 전체 -> summary 순으로 폴백(항상 뭔가는 나오게). */
function pickUsCommentSource(aiAnalysis) {
  const conclusion = aiAnalysis?.conclusion || "";
  const outlook = aiAnalysis?.todayOutlook?.scenario || "";
  return (
    afterFirstSentence(conclusion) ||
    afterFirstSentence(outlook) ||
    outlook ||
    conclusion ||
    aiAnalysis?.summary ||
    ""
  );
}

/**
 * snapshot(data/morning-briefing.json 원본) + cardData(date/slotLabel) + 랭킹 행 + 배경 -> HTML 문자열.
 * snapshot.usMarket.indices에서 INDEX_ORDER 순서대로 5개를 뽑고, 한줄 논평은 pickUsCommentSource()로
 * "오늘 예상흐름/간밤 미증시 시황" 위주 문장을 골라 쓴다(전일 마감시황 회고는 마감 릴스 몫).
 */
export function buildUsMarketHTML({ cardData, snapshot, rows, mode, bgDataUri, reelComment }) {
  const read = (name) => readFileSync(join(TEMPLATES_DIR, `${name}.html`), "utf8");
  const indices = snapshot.usMarket?.indices || [];

  const idxRowsBlock = INDEX_ORDER.map((entry) => {
    const idx = indices.find((i) => i.id === entry.id);
    if (!idx) {
      console.warn(`[usmarket-reel] 지수 데이터 없음: ${entry.id} (건너뜀)`);
      return "";
    }
    return usIndexRowHTML(entry, idx);
  }).join("");

  // reelComment(buildMorningReelComment, 촉매→오늘 전망 형식 전용 생성)가 최우선. 구버전
  // 호출부 호환을 위해 없으면 기존 conclusion/todayOutlook 추출 로직으로 폴백.
  const commentSource = reelComment || pickUsCommentSource(snapshot.aiAnalysis);
  const commentLine = buildCommentLine(commentSource);

  let html = fillVars(read("card-usmarket-reel"), {
    DATE: cardData.date,
    SLOT_LABEL: cardData.slotLabel,
    COMMENT_LINE: commentLine,
    RANKING_LABEL: mode.label,
    BG_DATA_URI: bgDataUri,
  });

  html = html.replace(/<!--IDXROW_START-->[\s\S]*?<!--IDXROW_END-->/, idxRowsBlock);

  const rowsBlock = rows.map(rankingRowHTML).join("");
  console.log(`[usmarket-reel] ranking mode=${mode.key}(${mode.label}), rows=${rows.length}`);
  html = html.replace(/<!--MCAPROW_START-->[\s\S]*?<!--MCAPROW_END-->/, rowsBlock);

  return html;
}

/** 아침 미증시 릴스 HTML -> 1080x1920 PNG 1장. (마감 릴스와 동일 캡처 로직) */
export async function renderUsMarketToPNG(html, outPath) {
  mkdirSync(join(outPath, ".."), { recursive: true });
  const tmpPath = join(TEMPLATES_DIR, `_tmp-usmarket.html`);
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
