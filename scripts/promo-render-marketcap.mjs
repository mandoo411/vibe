/**
 * templates/card-marketcap-reel.html -> PNG 1장 렌더링 (Puppeteer).
 * "마감 시황 릴스" v3 — 기존 만평(개구리 마스코트) 포맷을 대체하는 신규 포맷.
 * (1) 코스피/코스닥 지수 듀얼 카드 (상승/하락에 따라 카드 배경 자체가 빨강/파랑 톤으로 바뀜)
 * (2) 오늘 시황 한줄 논평 (3) 종목 TOP10 리스트 — 이 3가지로 구성한다.
 *
 * 종목 TOP10은 매일 다른 기준으로 로테이션한다: 시가총액 -> 상승률 -> 거래대금 -> (반복).
 * 데이터 출처는 data/kr-realtime.json의 tabs.cap / tabs.gainers / tabs.tv (market-data-sync.yml이
 * 30분마다 갱신) — 새 API 호출 없이 이미 있는 실데이터를 그대로 재사용한다.
 *
 * 숫자/종목명은 전부 코드가 직접 렌더링하고, 배경(우주+사이버 컨셉)만 AI가 그린다
 * (promo-gemini-background.mjs의 getMarketcapReelBackground) — 만평 포맷과 동일한 설계 원칙.
 */
import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./telegram-utils.mjs";
import { firstCompleteSentence, trimToNaturalBreak } from "./promo-text-utils.mjs";

const TEMPLATES_DIR = join(process.cwd(), "templates");
const KR_REALTIME_PATH = process.env.KR_REALTIME_PATH || "./data/kr-realtime.json";

function fillVars(html, vars) {
  let out = html;
  for (const [key, val] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, String(val));
  }
  return out;
}

const arrow = (pct) => (pct > 0 ? "▲" : pct < 0 ? "▼" : "—");
const dir = (pct) => (pct > 0 ? "up" : pct < 0 ? "down" : "flat");
// data/kr-realtime.json의 price 필드는 tab마다 타입이 다르다(cap: 숫자, gainers/tv: "1,550,000" 문자열) —
// 항상 콤마를 제거하고 숫자로 정규화해서 렌더링 직전에 다시 포맷한다.
const toNum = (v) => Number(String(v ?? "").replace(/,/g, "")) || 0;

const RANKING_MODES = [
  { key: "cap", tab: "cap", label: "시가총액 TOP10" },
  { key: "gainers", tab: "gainers", label: "상승률 TOP10" },
  { key: "tv", tab: "tv", label: "거래대금 TOP10" },
];

/** 날짜(YYYY-MM-DD, KST 기준) 기반으로 오늘의 랭킹 모드를 고른다 — 시가총액 -> 상승률 -> 거래대금 순환.
 * "연중 몇 번째 날인지" % 3 으로 결정하는 단순한 방식이라 주말/휴장으로 하루 건너뛰어도
 * 그날그날 결정적(deterministic)으로 같은 결과가 나온다(재시도해도 같은 날은 같은 모드). */
export function pickRankingMode(ymd) {
  const d = new Date(`${ymd}T00:00:00+09:00`);
  const startOfYear = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const dayOfYear = Math.floor((d - startOfYear) / 86400000);
  return RANKING_MODES[((dayOfYear % 3) + 3) % 3];
}

/** kr-realtime.json의 한 tab(cap/gainers/tv)에서 상위 10개를 우리 템플릿이 쓰는 표준 형태로 변환 */
function normalizeRankingRows(tabRows) {
  return (tabRows || []).slice(0, 10).map((r, i) => ({
    rank: r.rank || i + 1,
    name: r.name,
    price: toNum(r.price),
    changeAmt: toNum(r.changeAmt),
    changePct: Number(r.changePct) || 0,
  }));
}

/** "핵심 한 줄" 원문에서 완결된 첫 문장을 뽑고, 화면에 한 줄로 들어가도록(말줄임표 없이) 자연스럽게 자른다.
 * reel의 reason-card가 -webkit-line-clamp로 강제 절단되며 문장이 중간에 잘리던 과거 버그(만평 포맷)를
 * 반복하지 않기 위해, 애초에 코드 레벨에서 "한 줄에 확실히 들어가는 길이"로 자른다. */
export function buildCommentLine(text, maxLen = 40) {
  const sentence = firstCompleteSentence(text);
  return trimToNaturalBreak(sentence, maxLen);
}

function rankingRowHTML(row) {
  const cls = dir(row.changePct);
  const rankCls = row.rank <= 3 ? "gold" : "";
  const priceFmt = row.price.toLocaleString("ko-KR") + "원";
  const changeSign = row.changeAmt > 0 ? "+" : "";
  const changeFmt = `${changeSign}${row.changeAmt.toLocaleString("ko-KR")}`;
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

/**
 * cardData(buildClosingCardData 결과) + kr-realtime 스냅샷 + 배경(data URI) -> 릴스 HTML 문자열.
 * cardData에서는 date/slotLabel/heroPct와, coreLine(핵심 한 줄, reasonLine으로 이미 다듬어진 값)을 쓴다.
 * 지수 포인트 변동(등락폭)은 indexRows에 없으므로 snapshot.indexes(raw)를 별도로 받는다.
 */
export function buildMarketcapHTML({ cardData, snapshot, realtimeTabs, bgDataUri }) {
  const s = "";
  void s;
  const read = (name) => readFileSync(join(TEMPLATES_DIR, `${name}.html`), "utf8");

  const { kospi, kosdaq } = snapshot.indexes || {};
  const mode = pickRankingMode(snapshot.ymd || cardData.date);
  const rows = normalizeRankingRows(realtimeTabs?.[mode.tab]);

  // headline(copy.headline)은 promo-market-copy.mjs에서 이미 "완결된 문장, 35~55자"로 만들어지도록
  // 설계된 필드다(AI 프롬프트 스펙 + fallback의 safeSummarize/looksComplete 검증 둘 다 이 조건을 보장).
  // reasonLine("핵심 한 줄")은 최대 150자까지 허용되는 원인 설명용이라 40자로 다시 자르면 중간에
  // 끊긴 문장이 되기 쉽다(실제로 이 버그를 로컬 테스트에서 발견함) — 대신 이미 짧고 완결된 headline을
  // 그대로 쓰고, 혹시 모를 예외적으로 긴 경우에만 안전망으로 자연스러운 지점에서 자른다.
  // .comment-text는 line-clamp 없이 자연스럽게 줄바꿈되므로 2줄이 되어도 잘리지 않는다.
  const commentSource = cardData.headline || cardData.reasonLine || "";
  const commentLine = buildCommentLine(commentSource, 58);

  let html = fillVars(read("card-marketcap-reel"), {
    DATE: cardData.date,
    SLOT_LABEL: cardData.slotLabel,
    KOSPI_VALUE: kospi?.close != null ? Number(kospi.close).toLocaleString("ko-KR") : "—",
    KOSPI_DIR: dir(kospi?.changePercent ?? 0),
    KOSPI_ARROW: arrow(kospi?.changePercent ?? 0),
    KOSPI_CHANGE: kospi?.change != null ? Math.abs(kospi.change).toFixed(2) : "0.00",
    KOSPI_PCT: (kospi?.changePercent ?? 0).toFixed(2),
    KOSDAQ_VALUE: kosdaq?.close != null ? Number(kosdaq.close).toLocaleString("ko-KR") : "—",
    KOSDAQ_DIR: dir(kosdaq?.changePercent ?? 0),
    KOSDAQ_ARROW: arrow(kosdaq?.changePercent ?? 0),
    KOSDAQ_CHANGE: kosdaq?.change != null ? Math.abs(kosdaq.change).toFixed(2) : "0.00",
    KOSDAQ_PCT: (kosdaq?.changePercent ?? 0).toFixed(2),
    COMMENT_LINE: commentLine,
    RANKING_LABEL: mode.label,
    BG_DATA_URI: bgDataUri,
  });

  const rowsBlock = rows.map(rankingRowHTML).join("");
  console.log(`[marketcap-reel] ranking mode=${mode.key}(${mode.label}), rows=${rows.length}`);
  html = html.replace(/<!--MCAPROW_START-->[\s\S]*?<!--MCAPROW_END-->/, rowsBlock);

  return html;
}

/** kr-realtime.json 전체를 읽어 tabs(cap/gainers/tv)만 반환 */
export async function loadRealtimeTabs() {
  const raw = await readJson(KR_REALTIME_PATH);
  return raw?.tabs || {};
}

/** 마켓캡 릴스 HTML -> 1080x1920 PNG 1장. (기존 renderManpyeongToPNG와 동일한 캡처 로직) */
export async function renderMarketcapToPNG(html, outPath) {
  mkdirSync(join(outPath, ".."), { recursive: true });
  const tmpPath = join(TEMPLATES_DIR, `_tmp-marketcap.html`);
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
