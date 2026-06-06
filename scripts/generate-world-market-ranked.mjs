#!/usr/bin/env node
/**
 * companiesmarketcap.com TOP100 → lib/world-market-ranked.js 생성
 */
import fs from "node:fs/promises";
import path from "node:path";

const CMC_HOME = "https://companiesmarketcap.com/";
const OUT_PATH = path.resolve("lib/world-market-ranked.js");

const SUFFIX_COUNTRY = [
  [".KS", "South Korea"],
  [".KQ", "South Korea"],
  [".HK", "China"],
  [".SS", "China"],
  [".SZ", "China"],
  [".SR", "Saudi Arabia"],
  [".DE", "Germany"],
  [".PA", "France"],
  [".SW", "Switzerland"],
  [".AX", "Australia"],
  [".AS", "Netherlands"],
  [".NS", "India"],
  [".AE", "United Arab Emirates"],
  [".L", "United Kingdom"],
  [".T", "Japan"],
  [".MI", "Italy"],
  [".TO", "Canada"],
  [".MC", "Spain"],
  [".TW", "Taiwan"],
];

const SYMBOL_COUNTRY = {
  TSM: "Taiwan",
  ASML: "Netherlands",
  NVO: "Denmark",
  SAP: "Germany",
  TM: "Japan",
  TCEHY: "China",
  BHP: "Australia",
  RY: "Canada",
  SHEL: "United Kingdom",
  LIN: "United Kingdom",
  ARM: "United Kingdom",
  HSBC: "United Kingdom",
  UL: "United Kingdom",
  AZN: "United Kingdom",
  RIO: "United Kingdom",
  BP: "United Kingdom",
  TTE: "France",
  SAN: "France",
  OR: "France",
  MC: "France",
};

function inferCountry(symbol, name) {
  const sym = String(symbol || "").trim().toUpperCase();
  for (const [suffix, country] of SUFFIX_COUNTRY) {
    if (sym.endsWith(suffix)) return country;
  }
  if (SYMBOL_COUNTRY[sym]) return SYMBOL_COUNTRY[sym];
  const n = String(name || "").toLowerCase();
  if (/aramco|saudi/.test(n)) return "Saudi Arabia";
  if (/samsung|hynix|korea/.test(n)) return "South Korea";
  if (/china mobile|petrochina|tencent|moutai|foxconn/.test(n)) return "China";
  if (/toyota|mitsubishi|sony|softbank|honda|nintendo/.test(n)) return "Japan";
  if (/siemens|mercedes|bmw|volkswagen|allianz/.test(n)) return "Germany";
  if (/lvmh|l'oréal|loreal|hermès|hermes|totalenergies/.test(n)) return "France";
  if (/nestlé|nestle|roche|novartis|ubs|zurich/.test(n)) return "Switzerland";
  if (/shell|hsbc|astrazeneca|bp |unilever/.test(n)) return "United Kingdom";
  if (/commonwealth|bhp|westpac/.test(n)) return "Australia";
  if (/reliance/.test(n)) return "India";
  if (/prosus/.test(n)) return "Netherlands";
  if (/international holding/.test(n)) return "United Arab Emirates";
  return "United States";
}

function rowToMeta(row) {
  const sym = String(row.symbol || "").trim().toUpperCase();
  const country = inferCountry(sym, row.name);
  const meta = {
    symbol: sym,
    name: row.name,
    country,
  };
  if (row.cmcSlug) meta.cmcSlug = row.cmcSlug;
  if (/\.(KS|KQ|SR|HK|SS|SZ|DE|PA|SW|AX|AS|NS|AE|L|T|MI|TO|MC|TW|OL|ST|CO|SA|BA|SN|JK|KL|IS|VI|WA|F|BR)$/i.test(sym)) {
    meta.yahooSymbol = sym;
    if (/^\d/.test(sym)) meta.symbol = "";
  }
  if (sym === "005930.KS") {
    meta.symbol = "SSNLF";
    meta.yahooSymbol = "005930.KS";
  }
  return meta;
}

function parseCmcTop100(html) {
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  const rows = html.match(rowRe) || [];
  const out = [];
  for (const row of rows) {
    if (!row.includes("rank-td") || !row.includes("company-name")) continue;
    const sorts = [...row.matchAll(/data-sort="(-?\d+)"/g)].map((m) => Number(m[1]));
    if (sorts.length < 3) continue;
    const rank = sorts[0];
    if (rank < 1 || rank > 100) continue;
    const name = (row.match(/company-name">([^<]+)</) || [])[1]?.trim();
    const symbol = (row.match(/company-code">[\s\S]*?([A-Z0-9][A-Z0-9.-]{0,14})<\//i) || [])[1]?.trim();
    const cmcSlug = (row.match(/href="\/([^/]+)\/marketcap\/"/) || [])[1];
    out.push({ rank, name, symbol, marketCap: sorts[1], cmcSlug });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

function formatMeta(meta) {
  const parts = [`symbol: ${JSON.stringify(meta.symbol || "")}`, `name: ${JSON.stringify(meta.name)}`, `country: ${JSON.stringify(meta.country)}`];
  if (meta.yahooSymbol) parts.push(`yahooSymbol: ${JSON.stringify(meta.yahooSymbol)}`);
  if (meta.cmcSlug) parts.push(`cmcSlug: ${JSON.stringify(meta.cmcSlug)}`);
  return `  { ${parts.join(", ")} }`;
}

export function parseCmcTop100FromHtml(html) {
  return parseCmcTop100(html);
}

export function cmcRowsToMetas(rows) {
  return rows.map(rowToMeta);
}

async function main() {
  const res = await fetch(CMC_HOME, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; TotalMoneyAI/1.0)" },
  });
  const html = await res.text();
  if (!res.ok) throw new Error(`CMC HTTP ${res.status}`);
  const rows = parseCmcTop100(html);
  if (rows.length < 90) throw new Error(`Expected ~100 rows, got ${rows.length}`);

  const metas = rows.map(rowToMeta);
  const body = metas.map(formatMeta).join(",\n");
  const file = `/** companiesmarketcap.com 시가총액 TOP100 (${new Date().toISOString().slice(0, 10)} 자동 생성) */\nmodule.exports = [\n${body},\n];\n`;
  await fs.writeFile(OUT_PATH, file, "utf8");
  const intl = metas.filter((m) => m.country !== "United States").length;
  console.log(`Wrote ${OUT_PATH} (${metas.length} companies, ${intl} non-US)`);
}

import { pathToFileURL } from "node:url";
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
