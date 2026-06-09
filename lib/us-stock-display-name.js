/**
 * KIS 해외 종목명이 업종·섹터 라벨로 내려오는 경우(예: AMD → 반도체 및 반도체장비) 표시명 보정
 */

const KO_BY_SLUG = require("./world-market-names-ko");
const RANKED = require("./world-market-ranked");

const US_TICKER_KO = new Map();
for (const row of RANKED) {
  const sym = String(row.symbol || "")
    .toUpperCase()
    .replace(/-/g, "/");
  if (!sym) continue;
  const ko = KO_BY_SLUG[row.cmcSlug];
  if (ko) US_TICKER_KO.set(sym, ko);
}

/** KIS·랭킹에서 종종 내려오는 업종/섹터 라벨 */
const SECTOR_NAME_RE =
  /^(반도체|금융|기술|에너지|헬스|보험|산업|소비|통신|유틸|부동산|소재|IT|소프트웨어|헬스케어|필수소비재|임의소비재|경기소비재)/;

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function normalizeUsTickerKey(ticker) {
  return sanitizeStr(ticker).toUpperCase().replace(/-/g, "/");
}

function isKisRsymToken(value) {
  return /^D(NYS|NAS|AMS)[A-Z0-9./]{1,12}$/i.test(sanitizeStr(value));
}

function isLikelyUsSectorName(name) {
  const n = sanitizeStr(name);
  if (!n) return true;
  if (/ 및 /.test(n)) return true;
  if (SECTOR_NAME_RE.test(n) && n.length <= 24) return true;
  if (/(장비|서비스|제품|산업|섹터)$/.test(n) && !/[A-Za-z]/.test(n) && n.length <= 20) return true;
  return false;
}

function resolveUsDisplayName(ticker, rawName) {
  const t = normalizeUsTickerKey(ticker);
  const raw = sanitizeStr(rawName);
  if (!t) return raw || "";

  const mapped = US_TICKER_KO.get(t) || US_TICKER_KO.get(t.replace(/\//g, "."));

  if (isKisRsymToken(raw) || !raw || raw.toUpperCase() === t) {
    return mapped || t;
  }
  if (isLikelyUsSectorName(raw)) {
    return mapped || t;
  }
  return raw;
}

module.exports = {
  US_TICKER_KO,
  isKisRsymToken,
  isLikelyUsSectorName,
  resolveUsDisplayName,
};
