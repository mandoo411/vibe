#!/usr/bin/env node
/**
 * 글로벌 TOP100 시가총액 캐시 (companiesmarketcap.com)
 * - 메인 페이지 테이블 + 개별 기업 페이지 보완
 * - data/world-market-cache.json → GitHub Actions 주기 갱신
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RANKED = require("../api/world-market-ranked.js");

const OUTPUT_PATH = path.resolve(process.env.WORLD_MARKET_CACHE_PATH || "data/world-market-cache.json");
const CMC_HOME = "https://companiesmarketcap.com/";
const USER_AGENT = "Mozilla/5.0 (compatible; TotalMoneyAI-WorldMarketCache/1.0)";
const PAGE_SLEEP_MS = 280;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKey(meta, rank) {
  const symbol = String(meta.symbol || "").trim().toUpperCase();
  return symbol || `rank:${rank}`;
}

function normalizeName(name) {
  return String(name || "")
    .replace(/\(.*?\)/g, "")
    .replace(/&/g, "and")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cmcSlug(meta) {
  if (meta.cmcSlug) return meta.cmcSlug;
  return String(meta.name || "")
    .replace(/\(.*?\)/g, "")
    .replace(/&/g, "and")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const SLUG_ALIASES = {
  "alphabet-google": "google",
  "meta-platforms-facebook": "meta-platforms",
  "sandp-global": "sp-global",
  "atandt": "att",
  "thermo-fisher": "thermo-fisher-scientific",
  "adp": "automatic-data-processing",
  "cadence-design": "cadence-design-systems",
  "stryker": "stryker-corporation",
  "saudi-aramco": "saudi-aramco",
  "sk-hynix": "sk-hynix",
  "lowe-s": "lowes-companies",
  "deere": "deere-company",
  "marsh-and-mclennan": "marsh-and-mclennan-companies",
};

function parseRowHtml(row) {
  const sorts = [...row.matchAll(/data-sort="(-?\d+)"/g)].map((m) => Number(m[1]));
  if (sorts.length < 4) return null;

  const rank = sorts[0];
  const marketCap = sorts[1];
  const price = sorts[2] / 100;
  const changePct = sorts[3] / 100;
  const nameMatch = row.match(/company-name">([^<]+)</);
  const symbolMatch = row.match(/company-code">[\s\S]*?([A-Z0-9][A-Z0-9.-]{0,14})<\/div>/i);

  return {
    rank,
    name: nameMatch ? nameMatch[1].trim() : "",
    symbol: symbolMatch ? symbolMatch[1].trim().toUpperCase() : "",
    marketCap: marketCap > 0 ? marketCap : null,
    price: price > 0 ? price : null,
    changePct: Number.isFinite(changePct) ? changePct : null,
  };
}

function parseHomepage(html) {
  const bySymbol = new Map();
  const byName = new Map();
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  const rows = html.match(rowRe) || [];

  for (const row of rows) {
    if (!row.includes("rank-td") || !row.includes("company-name")) continue;
    const parsed = parseRowHtml(row);
    if (!parsed || !parsed.marketCap) continue;
    if (parsed.symbol) bySymbol.set(parsed.symbol, parsed);
    if (parsed.name) byName.set(normalizeName(parsed.name), parsed);
  }

  return { bySymbol, byName, rowCount: rows.length };
}

function parseCapFromPage(html) {
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  const values = [];
  for (const m of html.matchAll(/\$\s*([\d.,]+)\s*([KMBT])\b/gi)) {
    const v = Number(m[1].replace(/,/g, "")) * mult[m[2].toUpperCase()];
    if (v >= 1e9 && v < 20e12) values.push(v);
  }
  return values[0] ?? null;
}

function parseCompanyPage(html) {
  const marketCap = parseCapFromPage(html);
  const priceM = html.match(/(?:Share|Stock) price[\s\S]{0,600}?\$\s*([\d.,]+)/i);
  const pctM = html.match(/class="rh-sm"[^>]*>[\s\S]*?(-?[\d.]+)\s*%/i)
    || html.match(/percentage-(?:green|red)"[^>]*>[\s\S]*?(-?[\d.]+)\s*%/i);
  return {
    marketCap,
    price: priceM ? Number(priceM[1].replace(/,/g, "")) : null,
    changePct: pctM ? Number(pctM[1]) : null,
  };
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return text;
}

async function finnhubMarketCap(symbol) {
  const token = String(process.env.FINNHUB_API_KEY || "").trim();
  if (!token || !symbol) return null;
  const url = new URL("https://finnhub.io/api/v1/stock/profile2");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("token", token);
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  const millions = Number(body?.marketCapitalization);
  if (!Number.isFinite(millions) || millions <= 0) return null;
  return millions * 1e6;
}

async function fetchCompanyBySlug(slug) {
  const resolved = SLUG_ALIASES[slug] || slug;
  const html = await fetchHtml(`https://companiesmarketcap.com/${resolved}/marketcap/`);
  const row = parseCompanyPage(html);
  if (!row.marketCap) return null;
  return row;
}

function lookupHome(meta, maps) {
  const sym = String(meta.symbol || "").trim().toUpperCase();
  if (sym && maps.bySymbol.has(sym)) return maps.bySymbol.get(sym);
  const byNorm = maps.byName.get(normalizeName(meta.name));
  if (byNorm) return byNorm;
  return null;
}

async function main() {
  console.log(`Fetching ${CMC_HOME}…`);
  const homeHtml = await fetchHtml(CMC_HOME);
  const maps = parseHomepage(homeHtml);
  console.log(`Homepage index: ${maps.bySymbol.size} symbols (${maps.rowCount} table rows scanned)`);

  const entries = {};
  let withCap = 0;
  let fromHome = 0;
  let fromPage = 0;

  for (let index = 0; index < RANKED.length; index++) {
    const meta = RANKED[index];
    const rank = index + 1;
    const key = cacheKey(meta, rank);

    let row = lookupHome(meta, maps);
    if (row) {
      fromHome += 1;
    } else {
      const slug = cmcSlug(meta);
      try {
        const page = await fetchCompanyBySlug(slug);
        if (page) {
          row = {
            rank,
            name: meta.name,
            symbol: String(meta.symbol || "").toUpperCase(),
            ...page,
          };
          fromPage += 1;
        }
      } catch (error) {
        console.warn(`Page fetch failed ${slug}: ${error.message}`);
      }
      await sleep(PAGE_SLEEP_MS);
    }

    if (!row?.marketCap && meta.symbol) {
      const cap = await finnhubMarketCap(meta.symbol);
      if (cap) {
        row = {
          rank,
          name: meta.name,
          symbol: String(meta.symbol).toUpperCase(),
          marketCap: cap,
          price: null,
          changePct: null,
        };
        console.log(`Finnhub cap: #${rank} ${meta.symbol}`);
      }
    }

    if (!row?.marketCap) {
      console.warn(`No market cap: #${rank} ${meta.name}`);
      continue;
    }

    entries[key] = {
      rank,
      name: meta.name,
      symbol: String(meta.symbol || row.symbol || "").toUpperCase(),
      marketCap: row.marketCap,
      price: row.price ?? null,
      changePct: row.changePct ?? null,
    };
    withCap += 1;
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "companiesmarketcap.com",
    symbolCount: RANKED.length,
    withMarketCap: withCap,
    stats: { fromHome, fromPage },
    entries,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUTPUT_PATH} (${withCap}/${RANKED.length}, home=${fromHome} page=${fromPage})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
