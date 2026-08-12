/**
 * 글로벌 시가총액 TOP10 + 국내기업 랭킹 릴스(주간, 매주 토요일) — templates/card-globalranking-reel.html 렌더링.
 *
 * 데이터 출처:
 *  - data/world-market-cache.json (world-market.html 페이지와 동일한 캐시, companiesmarketcap.com 기반, TOP100)
 *  - lib/world-market-ranked.js (심볼 -> 국가/야후심볼 메타, generate-world-market-ranked.mjs가 생성)
 *  - 로고: FMP image-stock(미국 심볼) / companiesmarketcap.com company-logos(해외 심볼, yahooSymbol 기준)
 *    — 렌더 시점에 fetch해서 base64 data URI로 인라인(외부 이미지 로드 실패로 릴스가 깨지는 것 방지).
 *  - 국기: flagcdn.com 실제 국기 이미지(ISO 3166-1 alpha-2 코드 기반).
 *
 * 2026-08-13 개편: TOP20 → TOP10으로 축소하고, 캐시(TOP100) 안에서 국가가 한국인 종목(삼성전자,
 * SK하이닉스 등)을 별도 "국내기업" 섹션으로 분리해 국내 순위 + 글로벌 순위 배지로 보여준다.
 * 기존의 순위변동(▲/▼) 배지는 사용자 피드백("지저분해 보임")으로 완전히 제거했다.
 */
import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getMarketcapReelBackground } from "./promo-gemini-background.mjs";

const TEMPLATES_DIR = join(process.cwd(), "templates");
const CACHE_PATH = join(process.cwd(), "data", "world-market-cache.json");
const RANKED_PATH = join(process.cwd(), "lib", "world-market-ranked.js");

const GLOBAL_TOP_N = 10;

function fillVars(html, vars) {
  let out = html;
  for (const [key, val] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, String(val));
  }
  return out;
}

// 사용자 요청: 시가총액을 달러가 아니라 원화(한화)로 표시.
// 조(兆) 단위가 절대다수라서 "조" 기준으로만 포맷하고, 소수점 아래는 "억" 단위까지 붙여 정밀도를 살린다.
function fmtWon(usdAmount, usdKrwRate) {
  const usd = Number(usdAmount);
  const rate = Number(usdKrwRate) || 1380;
  if (!Number.isFinite(usd)) return "—";
  const krw = usd * rate;
  const jo = krw / 1e12; // 1조 = 1e12원
  if (Math.abs(jo) >= 1) return `${jo.toLocaleString("ko-KR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}조원`;
  const eok = krw / 1e8; // 1억 = 1e8원
  return `${eok.toLocaleString("ko-KR", { maximumFractionDigits: 0 })}억원`;
}

async function fetchUsdKrwRate() {
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1d&range=5d", {
      headers: { "user-agent": "Mozilla/5.0 (compatible; TotalMoneyAI/1.0)" },
    });
    const body = await res.json().catch(() => ({}));
    const rate = Number(body?.chart?.result?.[0]?.meta?.regularMarketPrice);
    if (Number.isFinite(rate) && rate > 500 && rate < 3000) return rate;
  } catch {
    // fallback below
  }
  return 1380; // 환율 조회 실패 시 안전한 근사값(정확한 수치가 아니므로 자주 갱신되는 값으로 교체 권장)
}

const dirCls = (pct) => (pct > 0 ? "up" : pct < 0 ? "down" : "flat");
const arrow = (pct) => (pct > 0 ? "▲" : pct < 0 ? "▼" : "—");

// 이모지 국기는 Puppeteer 렌더 환경(GitHub Actions 등)에 컬러 이모지 폰트가 없으면
// 빈 네모(□□)로 깨진다 — 실제 국기 이미지(flagcdn.com, ISO 3166-1 alpha-2 코드 기반)를 써서
// 렌더 환경에 상관없이 항상 정확하게 보이도록 한다.
function countryIso2(country) {
  const text = String(country || "").toLowerCase();
  if (/united states|usa|^us$/.test(text)) return "us";
  if (/china|hong kong/.test(text)) return "cn";
  if (/taiwan/.test(text)) return "tw";
  if (/japan/.test(text)) return "jp";
  if (/korea/.test(text)) return "kr";
  if (/saudi/.test(text)) return "sa";
  if (/netherlands/.test(text)) return "nl";
  if (/france/.test(text)) return "fr";
  if (/germany/.test(text)) return "de";
  if (/united kingdom|uk|ireland/.test(text)) return "gb";
  if (/canada/.test(text)) return "ca";
  if (/switzerland/.test(text)) return "ch";
  if (/denmark/.test(text)) return "dk";
  if (/emirates|uae/.test(text)) return "ae";
  if (/australia/.test(text)) return "au";
  if (/india/.test(text)) return "in";
  if (/spain/.test(text)) return "es";
  if (/italy/.test(text)) return "it";
  if (/brazil/.test(text)) return "br";
  if (/mexico/.test(text)) return "mx";
  if (/singapore/.test(text)) return "sg";
  if (/indonesia/.test(text)) return "id";
  return "";
}

function flagUrlFor(country) {
  const iso2 = countryIso2(country);
  if (!iso2) return "";
  return `https://flagcdn.com/w80/${iso2}.png`;
}

async function fetchFlagDataUri(country) {
  const url = flagUrlFor(country);
  if (!url) return "";
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; TotalMoneyAI/1.0)" } });
    if (!res.ok) return "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 30) return "";
    const ct = res.headers.get("content-type") || "image/png";
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}

function logoUrlFor(meta) {
  const symbol = String(meta.symbol || "").trim().toUpperCase();
  if (symbol) return `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`;
  const yahoo = String(meta.yahooSymbol || "").trim();
  if (yahoo) return `https://companiesmarketcap.com/img/company-logos/64/${encodeURIComponent(yahoo)}.png`;
  return "";
}

async function fetchLogoDataUri(url) {
  if (!url) return "";
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; TotalMoneyAI/1.0)" } });
    if (!res.ok) return "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 50) return ""; // 너무 작으면 플레이스홀더/에러 이미지일 확률이 높음
    const ct = res.headers.get("content-type") || "image/png";
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}

function metaFor(e, bySymbol, metas) {
  const key = String(e.symbol || "").toUpperCase();
  return bySymbol.get(key) || metas.find((m) => m.name === e.name) || {};
}

async function enrichRow(e, { bySymbol, metas, KO_NAMES, usdKrwRate }) {
  const meta = metaFor(e, bySymbol, metas);
  const country = meta.country || "United States";
  const logoUrl = logoUrlFor(meta.symbol || meta.yahooSymbol ? meta : { symbol: e.symbol });
  const logoDataUri = await fetchLogoDataUri(logoUrl);
  const flagDataUri = await fetchFlagDataUri(country);
  // 사용자 요청: 기업명은 한글로 표기 (cmcSlug 기준 KO_NAMES 매핑, 없으면 영문명 그대로 폴백).
  const nameKo = (meta.cmcSlug && KO_NAMES[meta.cmcSlug]) || e.name;
  return {
    rank: e.rank,
    name: nameKo,
    nameEn: e.name,
    symbol: e.symbol || meta.yahooSymbol || "",
    marketCap: e.marketCap,
    marketCapWon: fmtWon(e.marketCap, usdKrwRate),
    changePct: Number(e.changePct) || 0,
    country,
    flagDataUri,
    logoDataUri,
  };
}

/** world-market-cache.json(TOP100) + world-market-ranked.js ->
 *  { topRows: 글로벌 TOP10, krRows: TOP10 밖에 있는 국내(한국) 기업 목록(국내순위 오름차순) } */
export async function buildRankingData() {
  const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  // lib/*.js는 .mjs가 아닌 CommonJS(module.exports)라 require로 읽는다.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const metas = require(RANKED_PATH);
  const KO_NAMES = require(join(process.cwd(), "lib", "world-market-names-ko.js"));

  const bySymbol = new Map();
  for (const m of metas) {
    if (m.symbol) bySymbol.set(m.symbol.toUpperCase(), m);
    if (m.yahooSymbol) bySymbol.set(m.yahooSymbol.toUpperCase(), m);
  }

  const allEntries = Object.values(cache.entries || {}).sort((a, b) => a.rank - b.rank);

  console.log("   USD/KRW 환율 조회 중...");
  const usdKrwRate = await fetchUsdKrwRate();
  console.log(`   USD/KRW ≈ ${usdKrwRate}`);

  const ctx = { bySymbol, metas, KO_NAMES, usdKrwRate };

  const topSlice = allEntries.slice(0, GLOBAL_TOP_N);
  const topRows = [];
  for (const e of topSlice) topRows.push(await enrichRow(e, ctx));

  // TOP10 밖에 있는 국내(한국) 기업만 별도 섹션으로 — 실데이터에 있는 만큼만 표시(임의로 지어내지 않음).
  const krCandidates = allEntries.filter((e, idx) => {
    if (idx < GLOBAL_TOP_N) return false;
    const meta = metaFor(e, bySymbol, metas);
    return /korea/i.test(meta.country || "");
  });
  const krRowsRaw = [];
  for (const e of krCandidates) krRowsRaw.push(await enrichRow(e, ctx));
  const krRows = krRowsRaw
    .sort((a, b) => a.rank - b.rank)
    .map((r, i) => ({ ...r, domesticRank: i + 1, globalRank: r.rank }));

  return { topRows, krRows };
}

function rowHTML(row) {
  const cls = dirCls(row.changePct);
  const logoCell = row.logoDataUri
    ? `<div class="grank-logo-wrap"><img src="${row.logoDataUri}" alt="" /></div>`
    : `<div class="grank-logo-wrap fallback">🌐</div>`;
  const flagCell = row.flagDataUri
    ? `<img class="grank-flag-img" src="${row.flagDataUri}" alt="" title="${row.country}" />`
    : `<span class="grank-flag-fallback" title="${row.country}">🌐</span>`;
  const pctText = `${arrow(row.changePct)} ${Math.abs(row.changePct).toFixed(2)}%`;
  const medal = row.rank === 1 ? "🥇" : row.rank === 2 ? "🥈" : row.rank === 3 ? "🥉" : "";
  const top3Cls = row.rank <= 3 ? "top3" : "";
  const rankCell = medal
    ? `<span class="medal">${medal}</span>`
    : `<span class="num">${row.rank}</span>`;
  return `
      <div class="grank-row ${top3Cls}">
        <div class="grank-rank">${rankCell}</div>
        ${logoCell}
        <div class="grank-name">
          <span class="n" title="${row.name}">${row.name}</span>
        </div>
        <div class="grank-cap">${row.marketCapWon}</div>
        <div class="grank-chg ${cls}">${pctText}</div>
        <div class="grank-country">${flagCell}</div>
      </div>`;
}

function krRowHTML(row) {
  const cls = dirCls(row.changePct);
  const logoCell = row.logoDataUri
    ? `<div class="grank-logo-wrap"><img src="${row.logoDataUri}" alt="" /></div>`
    : `<div class="grank-logo-wrap fallback">🌐</div>`;
  const pctText = `${arrow(row.changePct)} ${Math.abs(row.changePct).toFixed(2)}%`;
  return `
      <div class="kr-row">
        <div class="kr-rank-badge">${row.domesticRank}</div>
        ${logoCell}
        <div class="kr-name">
          <span class="n" title="${row.name}">${row.name}</span>
          <span class="kr-global-badge">글로벌 ${row.globalRank}위</span>
        </div>
        <div class="grank-cap">${row.marketCapWon}</div>
        <div class="grank-chg ${cls}">${pctText}</div>
      </div>`;
}

export async function buildGlobalRankingHTML({ dateLabel, topRows, krRows, bgDataUri }) {
  const read = (name) => readFileSync(join(TEMPLATES_DIR, `${name}.html`), "utf8");
  let html = fillVars(read("card-globalranking-reel"), {
    DATE: dateLabel,
    BG_DATA_URI: bgDataUri,
  });
  const rowsBlock = topRows.map(rowHTML).join("");
  html = html.replace(/<!--GRANKROW_START-->[\s\S]*?<!--GRANKROW_END-->/, rowsBlock);

  const krBlock = krRows.map(krRowHTML).join("");
  html = html.replace(/<!--KRROW_START-->[\s\S]*?<!--KRROW_END-->/, krBlock);
  // 국내기업 데이터가 없으면(캐시 TOP100 안에 한국 기업이 하나도 없는 예외적인 경우) 섹션 자체를 숨긴다
  // — "데이터 없으면 지어내지 않고 표시를 생략한다" 원칙.
  if (krRows.length === 0) {
    html = html.replace(/<!--KRSECTION_START-->[\s\S]*?<!--KRSECTION_END-->/, "");
  }
  return html;
}

export async function renderGlobalRankingToPNG(html, outPath) {
  mkdirSync(join(outPath, ".."), { recursive: true });
  const tmpPath = join(TEMPLATES_DIR, `_tmp-globalranking.html`);
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

function todayLabel() {
  const d = new Date();
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}년 ${m}월 ${day}일`;
}

async function main() {
  const outPath = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1] || "./generated/globalranking-test.png";
  console.log("1) top10 + 국내기업 데이터 + 로고 로딩...");
  const { topRows, krRows } = await buildRankingData();
  console.log(`   글로벌 TOP10: ${topRows.length}개, 국내기업: ${krRows.length}개 (로고 성공: ${[...topRows, ...krRows].filter((r) => r.logoDataUri).length}/${topRows.length + krRows.length})`);

  const upCount = topRows.filter((r) => r.changePct > 0).length;
  const downCount = topRows.filter((r) => r.changePct < 0).length;
  const dir = upCount > downCount ? "up" : downCount > upCount ? "down" : "flat";
  console.log(`2) 배경 생성 중 (방향: ${dir})...`);
  const bgDataUri = await getMarketcapReelBackground(dir);

  console.log("3) HTML 빌드 중...");
  const html = await buildGlobalRankingHTML({ dateLabel: todayLabel(), topRows, krRows, bgDataUri });

  console.log("4) PNG 렌더 중...");
  await renderGlobalRankingToPNG(html, outPath);
  console.log(`완료: ${outPath}`);
}

import { pathToFileURL } from "node:url";
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
