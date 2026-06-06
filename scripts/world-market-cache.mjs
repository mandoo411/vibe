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

async function loadRankedList() {
  try {
    const genPath = path.resolve("scripts/generate-world-market-ranked.mjs");
    const gen = await import(`file://${genPath.replace(/\\/g, "/")}`);
    const res = await fetch(CMC_HOME, {
      headers: { "user-agent": USER_AGENT },
    });
    const html = await res.text();
    if (!res.ok) throw new Error(`CMC HTTP ${res.status}`);
    const rows = gen.parseCmcTop100FromHtml(html);
    if (rows.length >= 90) {
      console.log(`Using live CMC TOP${rows.length} for cache sync`);
      return gen.cmcRowsToMetas(rows);
    }
  } catch (error) {
    console.warn(`Live CMC ranked list failed, using file: ${error.message}`);
  }
  return require("../lib/world-market-ranked.js");
}

const OUTPUT_PATH = path.resolve(process.env.WORLD_MARKET_CACHE_PATH || "data/world-market-cache.json");
const CMC_HOME = "https://companiesmarketcap.com/";
const CMC_EARNINGS_URL = "https://companiesmarketcap.com/most-profitable-companies/";
const CMC_REVENUE_URL = "https://companiesmarketcap.com/largest-companies-by-revenue/";
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

function parseListingRow(row, valueField) {
  const sorts = [...row.matchAll(/data-sort="(-?\d+)"/g)].map((m) => Number(m[1]));
  if (sorts.length < 3) return null;

  const rank = sorts[0];
  const metric = sorts[1];
  let price = null;
  let changePct = null;
  if (sorts.length >= 4) {
    price = sorts[2] / 100;
    changePct = sorts[3] / 100;
  } else if (Math.abs(sorts[2]) <= 50000) {
    changePct = sorts[2] / 100;
  }
  const nameMatch = row.match(/company-name">([^<]+)</);
  const symbolMatch = row.match(/company-code">[\s\S]*?([A-Z0-9][A-Z0-9.-]{0,14})<\/div>/i);
  const logoMatch = row.match(/company-logos\/64\/([A-Z0-9][A-Z0-9.-]{0,14})\./i);

  const out = {
    rank,
    name: nameMatch ? nameMatch[1].trim() : "",
    symbol: symbolMatch
      ? symbolMatch[1].trim().toUpperCase()
      : logoMatch
        ? logoMatch[1].trim().toUpperCase()
        : "",
    price: price > 0 ? price : null,
    changePct: Number.isFinite(changePct) ? changePct : null,
  };
  if (metric > 0) out[valueField] = metric;
  return out;
}

function parseListing(html, valueField) {
  const bySymbol = new Map();
  const byName = new Map();
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  const rows = html.match(rowRe) || [];

  for (const row of rows) {
    if (!row.includes("rank-td") || !row.includes("company-name")) continue;
    const parsed = parseListingRow(row, valueField);
    if (!parsed || !parsed[valueField]) continue;
    if (parsed.symbol) bySymbol.set(parsed.symbol, parsed);
    if (parsed.name) byName.set(normalizeName(parsed.name), parsed);
  }

  return { bySymbol, byName, rowCount: rows.length };
}

function lookupListing(meta, maps) {
  const sym = String(meta.symbol || "").trim().toUpperCase();
  if (sym && maps.bySymbol.has(sym)) return maps.bySymbol.get(sym);
  const yahoo = String(meta.yahooSymbol || "").trim().toUpperCase();
  if (yahoo && maps.bySymbol.has(yahoo)) return maps.bySymbol.get(yahoo);
  return maps.byName.get(normalizeName(meta.name)) || null;
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

const TTM_UNITS = { billion: 1e9, million: 1e6, trillion: 1e12 };

function parseTtmMetric(html, label) {
  const re = new RegExp(
    `${label} in 20\\d{2} \\(TTM\\):[\\s\\S]*?\\$([\\d.,]+)\\s*(Billion|Million|Trillion)\\s*USD`,
    "i"
  );
  const match = html.match(re);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  const mult = TTM_UNITS[String(match[2] || "").toLowerCase()];
  if (!Number.isFinite(amount) || !mult) return null;
  return amount * mult;
}

async function fetchCompanyTtmMetrics(slug) {
  const resolved = SLUG_ALIASES[slug] || slug;
  const base = `https://companiesmarketcap.com/${resolved}`;
  const out = { netIncome: null, revenue: null };
  try {
    const earnHtml = await fetchHtml(`${base}/earnings/`);
    out.netIncome =
      parseTtmMetric(earnHtml, "Earnings") ?? parseTtmMetric(earnHtml, "Net income");
  } catch (error) {
    console.warn(`Earnings page failed ${resolved}: ${error.message}`);
  }
  await sleep(PAGE_SLEEP_MS);
  try {
    const revHtml = await fetchHtml(`${base}/revenue/`);
    out.revenue = parseTtmMetric(revHtml, "Revenue");
  } catch (error) {
    console.warn(`Revenue page failed ${resolved}: ${error.message}`);
  }
  return out.netIncome != null || out.revenue != null ? out : null;
}

async function main() {
  const RANKED = await loadRankedList();
  console.log("Fetching companiesmarketcap listings…");
  const [homeHtml, earningsHtml, revenueHtml] = await Promise.all([
    fetchHtml(CMC_HOME),
    fetchHtml(CMC_EARNINGS_URL),
    fetchHtml(CMC_REVENUE_URL),
  ]);
  const capMaps = parseListing(homeHtml, "marketCap");
  const earnMaps = parseListing(earningsHtml, "netIncome");
  const revMaps = parseListing(revenueHtml, "revenue");
  console.log(
    `Indexes: cap=${capMaps.bySymbol.size} earn=${earnMaps.bySymbol.size} rev=${revMaps.bySymbol.size}`
  );

  const entries = {};
  let withCap = 0;
  let fromHome = 0;
  let fromPage = 0;

  for (let index = 0; index < RANKED.length; index++) {
    const meta = RANKED[index];
    const rank = index + 1;
    const key = cacheKey(meta, rank);

    let row = lookupListing(meta, capMaps);
    const earnRow = lookupListing(meta, earnMaps);
    const revRow = lookupListing(meta, revMaps);
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

    let netIncome = earnRow?.netIncome ?? null;
    let revenue = revRow?.revenue ?? null;
    if (netIncome == null || revenue == null) {
      const ttm = await fetchCompanyTtmMetrics(cmcSlug(meta));
      if (ttm) {
        if (netIncome == null && ttm.netIncome != null) netIncome = ttm.netIncome;
        if (revenue == null && ttm.revenue != null) revenue = ttm.revenue;
        console.log(`TTM metrics: #${rank} ${meta.name} earn=${netIncome != null} rev=${revenue != null}`);
      }
      await sleep(PAGE_SLEEP_MS);
    }

    entries[key] = {
      rank,
      name: meta.name,
      symbol: String(meta.symbol || row.symbol || "").toUpperCase(),
      marketCap: row.marketCap,
      netIncome,
      revenue,
      price: row.price ?? earnRow?.price ?? revRow?.price ?? null,
      changePct: row.changePct ?? earnRow?.changePct ?? revRow?.changePct ?? null,
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
