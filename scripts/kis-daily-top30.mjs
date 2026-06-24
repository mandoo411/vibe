#!/usr/bin/env node
/**
 * 한국투자증권 Open API → 코스피+코스닥 상승·하락·거래대금 TOP N
 *  → data/daily-market.json 의 days[targetYmd] (topGainers, topDecliners, topTradingValue) 갱신
 *  → AI 종합분석·수급·뉴스 등은 Cowork(daily-closing-report)에서 별도 작성 — 여기서는 수집하지 않음
 *
 * 필수: KIS_ACCESS_TOKEN, KIS_APP_KEY, KIS_APP_SECRET
 * 선택: TARGET_DATE=YYYY-MM-DD (기본: 오늘 KST)
 *       TOP_N (기본 30, 1~50)
 *       KIS_BASE_URL (기본 https://openapi.koreainvestment.com:9443)
 *       OUTPUT_PATH (기본 ./data/daily-market.json)
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ─── 기본 헬퍼 ────────────────────────────────────────────
function seoulYmd(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return String(v).trim();
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNumberOrNull(v) {
  if (v === "" || v == null) return null;
  if (typeof v === "string") {
    const s = v.trim().replace(/%/g, "").replace(/,/g, "").replace(/\s/g, "").replace(/^\+/, "");
    if (s === "" || s === "-" || s === ".") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ""; }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch (_) { return ""; }
    });
}

function stripHtml(s) {
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(label, fetchFn, { retries = 3, delayMs = 2500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchFn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg);
      if (attempt < retries && transient) {
        console.warn(`  [${label}] 네트워크 오류, ${delayMs}ms 후 재시도 (${attempt + 1}/${retries}): ${msg}`);
        await delay(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─── KIS OAuth 토큰: 자동 발급 금지, 환경변수만 사용 ──────────────────
function getKisToken() {
  return requireEnv("KIS_ACCESS_TOKEN");
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

/** KIS FHPST01700000 output 등락률(%) — prdy_ctrt 외 필드명 변형 대응 */
function kisRowPctChange(row) {
  if (!row || typeof row !== "object") return null;
  const keys = ["prdy_ctrt", "PRDY_CTRT", "bstp_nmix_prdy_ctrt", "BSTP_NMIX_PRDY_CTRT"];
  for (const k of keys) {
    const n = toNumberOrNull(row[k]);
    if (n != null && Number.isFinite(n)) return n;
  }
  return null;
}

function pickAcmlTrPbmn(row) {
  if (!row || typeof row !== "object") return "";
  const keys = [
    "acml_tr_pbmn",
    "ACML_TR_PBMN",
    "hts_acml_tr_pbmn",
    "hts_deal_tr_pbmn",
    "deal_tr_pbmn",
  ];
  for (const k of keys) {
    const n = toNumberOrNull(row[k]);
    if (n != null && n > 0) return String(Math.round(n));
  }
  return "";
}

function pickStckAvls(row) {
  if (!row || typeof row !== "object") return "";
  const keys = [
    "stck_avls",
    "STCK_AVLS",
    "hts_avls",
    "HTS_AVLS",
    "hts_avls_unt",
    "HTS_AVLS_UNT",
    "marcap",
    "MARCAP",
    "lstn_stcn",
  ];
  for (const k of keys) {
    const s = sanitizeStr(row[k]);
    if (s) return s;
  }
  return "";
}

/** FHPST01740000 시가총액 필드 → 원 단위 문자열 (kis-realtime-data.js와 동일 규칙) */
function mcapRankingStckAvlsToWonString(raw) {
  const s = sanitizeStr(raw).replace(/,/g, "");
  if (!s) return "";
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return "";
  const WON_MIN = 5e11;
  const WON_MAX = 3e15;
  if (n >= 1e13) return String(Math.round(n));
  if (n >= 1e8) {
    const wM = Math.round(n * 1e6);
    if (wM >= WON_MIN && wM <= WON_MAX) return String(wM);
    return "";
  }
  const wE = Math.round(n * 1e8);
  if (wE >= WON_MIN && wE <= WON_MAX) return String(wE);
  const wM = Math.round(n * 1e6);
  if (wM >= WON_MIN && wM <= WON_MAX) return String(wM);
  return "";
}

function normalizeStckAvlsWon(raw) {
  const s = sanitizeStr(raw);
  if (!s) return "";
  if (/^\d{12,}$/.test(s.replace(/,/g, ""))) return s.replace(/,/g, "");
  return mcapRankingStckAvlsToWonString(s) || s.replace(/,/g, "");
}

function calcTradingValueWon(priceRaw, volRaw) {
  const p = toNumberOrNull(priceRaw);
  const v = toNumberOrNull(volRaw);
  if (p == null || v == null || p <= 0 || v <= 0) return "";
  return String(Math.round(p * v));
}

// ─── KIS 등락률 순위 조회 ─────────────────────────────────
// 시장 코드: 0000(전체) | 0001(코스피) | 1001(코스닥)
async function fetchFluctuationRanking({
  baseUrl,
  token,
  appKey,
  appSecret,
  marketCode,
  marketLabel,
  rankSortClsCode = "0",
}) {
  const url = new URL(`${baseUrl}/uapi/domestic-stock/v1/ranking/fluctuation`);
  const params = {
    fid_cond_mrkt_div_code: "J",
    fid_cond_scr_div_code: "20170",
    fid_input_iscd: marketCode,
    fid_rank_sort_cls_code: rankSortClsCode, // 0:상승률 1:하락률
    fid_input_cnt_1: "0",
    fid_prc_cls_code: "1", // 종가 기준
    fid_input_price_1: "",
    fid_input_price_2: "",
    fid_vol_cnt: "",
    fid_trgt_cls_code: "0",
    fid_trgt_exls_cls_code: "0000000000",
    fid_div_cls_code: "0",
    fid_rsfl_rate1: "",
    fid_rsfl_rate2: "",
  };
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetchWithRetry(`${marketLabel} fluctuation`, () =>
    fetch(url.toString(), {
      method: "GET",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: "FHPST01700000",
        custtype: "P",
      },
    })
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`KIS ranking HTTP ${res.status} (${marketLabel}): ${text.slice(0, 300)}`);
  }
  let json;
  try { json = JSON.parse(text); } catch (_) {
    throw new Error(`KIS ranking: invalid JSON (${marketLabel}): ${text.slice(0, 300)}`);
  }
  if (json.rt_cd && json.rt_cd !== "0") {
    throw new Error(`KIS ranking error (${marketLabel}) rt_cd=${json.rt_cd} msg=${json.msg1 || ""}`);
  }
  const list = Array.isArray(json.output) ? json.output : [];
  return list.map((row) => ({
    code: sanitizeStr(row.stck_shrn_iscd),
    name: sanitizeStr(row.hts_kor_isnm),
    market: marketLabel,
    currentPrice: sanitizeStr(row.stck_prpr),
    prevDelta: toNumberOrNull(row.prdy_vrss),
    change: kisRowPctChange(row),
    volume: sanitizeStr(row.acml_vol),
    tradingValue: sanitizeStr(row.acml_tr_pbmn),
    tradingValueRaw: pickAcmlTrPbmn(row) || calcTradingValueWon(row.stck_prpr, row.acml_vol),
    stck_avls: normalizeStckAvlsWon(pickStckAvls(row)),
    rank: toNumberOrNull(row.data_rank),
  })).filter((r) => r.code && r.name);
}

function formatTradingValue(rawWon) {
  const n = Number(rawWon);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_0000_0000_0000) {
    // 1조 이상
    const jo = n / 1_0000_0000_0000;
    return `${jo.toFixed(2).replace(/\.?0+$/, "")}조`;
  }
  if (n >= 1_0000_0000) {
    const eok = Math.round(n / 1_0000_0000);
    return `${eok.toLocaleString("ko-KR")}억`;
  }
  return `${n.toLocaleString("ko-KR")}원`;
}

// ─── 네이버 금융 (직전 거래일 마감 데이터) ───────────────
// Naver Finance는 EUC-KR 인코딩, 장 마감 후~다음 장 시작 전엔 직전 거래일 종가 기준 데이터를 보여줍니다.
async function fetchNaverFinanceHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "ko,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) {
    throw new Error(`Naver Finance HTTP ${res.status} fetching ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return new TextDecoder("euc-kr").decode(buf);
}

function parseNaverRankingRows(html, marketLabel) {
  // 각 행은 <td class="no">N</td>...<a class="tltle" href="...code=XXX">NAME</a>...<td class="number">가격</td>...
  // 등락률은 <span class="... red01">+N.NN%</span> 또는 <span class="... nv01">-N.NN%</span> 형태.
  const rows = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const tr = m[1];
    if (!/class="tltle"/.test(tr)) continue;
    const codeM = tr.match(/code=(\d{6})"[^>]*class="tltle"[^>]*>([^<]+)<\/a>/);
    if (!codeM) continue;
    const code = codeM[1];
    const name = decodeEntities(codeM[2]).trim();
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let t;
    while ((t = tdRe.exec(tr)) !== null) tds.push(t[1]);
    // tds[0]=순위, [1]=종목명, [2]=현재가, [3]=전일대비, [4]=등락률, [5]=거래량, ...
    const currentPrice = tds[2] ? stripHtml(tds[2]).replace(/,/g, "") : "";
    let change = null;
    if (tds[4]) {
      const txt = stripHtml(tds[4]).replace(/[+]/g, "");
      const isNeg = /class="[^"]*(?:nv|down)[^"]*"/.test(tds[4]);
      const num = txt.replace(/[^\d\.\-]/g, "");
      const v = Number(num);
      if (Number.isFinite(v)) change = isNeg && v > 0 ? -v : v;
    }
    let volume = tds[5] ? stripHtml(tds[5]).replace(/,/g, "") : "";

    rows.push({
      code,
      name,
      market: marketLabel,
      currentPrice,
      change,
      volume,
      tradingValue: "",
      rank: null,
    });
  }
  return rows;
}

async function fetchNaverFinanceRanking({ marketCode, marketLabel, maxPages = 2 }) {
  // sosok=0(KOSPI), sosok=1(KOSDAQ)
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://finance.naver.com/sise/sise_rise.naver?sosok=${marketCode}&page=${page}`;
    const html = await fetchNaverFinanceHtml(url);
    const rows = parseNaverRankingRows(html, marketLabel);
    for (const r of rows) {
      if (seen.has(r.code)) continue;
      seen.add(r.code);
      all.push(r);
    }
    if (rows.length === 0) break;
  }
  return all;
}

async function fetchNaverFinanceDeclineRanking({ marketCode, marketLabel, maxPages = 2 }) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://finance.naver.com/sise/sise_fall.naver?sosok=${marketCode}&page=${page}`;
    const html = await fetchNaverFinanceHtml(url);
    const rows = parseNaverRankingRows(html, marketLabel);
    for (const r of rows) {
      if (seen.has(r.code)) continue;
      seen.add(r.code);
      all.push(r);
    }
    if (rows.length === 0) break;
  }
  return all;
}

function mergeFluctuationByCode(rows) {
  const merged = new Map();
  for (const r of rows) {
    if (!merged.has(r.code)) merged.set(r.code, r);
  }
  return [...merged.values()].filter((r) => r.change != null);
}

function rankFluctuationRows(all, topN, sortAscending) {
  all.sort((a, b) =>
    sortAscending ? (a.change || 0) - (b.change || 0) : (b.change || 0) - (a.change || 0)
  );
  return all.slice(0, topN).map((r, i) => ({ ...r, rank: i + 1 }));
}

async function collectFluctuationTopN({
  baseUrl,
  token,
  appKey,
  appSecret,
  topN,
  rankSortClsCode,
  sortAscending,
  forceNaver,
  logLabel,
}) {
  let rows = [];
  let source = "";

  if (!forceNaver && token) {
    const [kospi, kosdaq] = await Promise.all([
      fetchFluctuationRanking({
        baseUrl,
        token,
        appKey,
        appSecret,
        marketCode: "0001",
        marketLabel: "KOSPI",
        rankSortClsCode,
      }),
      fetchFluctuationRanking({
        baseUrl,
        token,
        appKey,
        appSecret,
        marketCode: "1001",
        marketLabel: "KOSDAQ",
        rankSortClsCode,
      }),
    ]);
    console.log(`  ${logLabel} KOSPI rows: ${kospi.length} | KOSDAQ rows: ${kosdaq.length}`);
    const all = mergeFluctuationByCode([...kospi, ...kosdaq]);
    const allZero = all.length > 0 && all.every((s) => Number(s.change) === 0);
    if (allZero) {
      console.warn(`  ⚠ KIS ${logLabel} 응답이 모두 0%. 네이버 fallback 시도.`);
    } else {
      rows = rankFluctuationRows(all, topN, sortAscending);
      source = "KIS";
    }
  }

  if (rows.length === 0) {
    const fetchNaver = sortAscending ? fetchNaverFinanceDeclineRanking : fetchNaverFinanceRanking;
    const [kospi, kosdaq] = await Promise.all([
      fetchNaver({ marketCode: 0, marketLabel: "KOSPI", maxPages: 2 }),
      fetchNaver({ marketCode: 1, marketLabel: "KOSDAQ", maxPages: 2 }),
    ]);
    console.log(`  ${logLabel} Naver KOSPI rows: ${kospi.length} | KOSDAQ rows: ${kosdaq.length}`);
    const all = mergeFluctuationByCode([...kospi, ...kosdaq]);
    rows = rankFluctuationRows(all, topN, sortAscending);
    source = "NaverFinance";
  }

  return { rows, source };
}

function mapStockJsonRow(s, extra = {}) {
  const tvRaw = sanitizeStr(s.tradingValueRaw) || pickAcmlTrPbmn(s) || calcTradingValueWon(s.currentPrice, s.volume);
  const mcapWon = normalizeStckAvlsWon(s.stck_avls);
  return {
    rank: s.rank,
    code: s.code,
    name: s.name,
    market: s.market,
    change: s.change,
    currentPrice: s.currentPrice,
    prevDelta: s.prevDelta,
    volume: sanitizeStr(s.volume),
    tradingValueRaw: tvRaw,
    tradingValue: formatTradingValue(tvRaw || s.tradingValue),
    stck_avls: mcapWon,
    hts_avls: mcapWon,
    ...extra,
  };
}

function mapTopDeclinersJsonRow(s) {
  return mapStockJsonRow(s, {
    reason: "",
    theme: "",
    newsTitles: [],
  });
}

async function fetchMarketCapLookup({ baseUrl, token, appKey, appSecret }) {
  async function fetchOnce(marketCode, marketLabel) {
    const url = new URL(`${baseUrl}/uapi/domestic-stock/v1/ranking/market-cap`);
    const params = {
      fid_cond_mrkt_div_code: "J",
      fid_cond_scr_div_code: "20174",
      fid_div_cls_code: "0",
      fid_input_iscd: marketCode,
      fid_trgt_cls_code: "0",
      fid_trgt_exls_cls_code: "0000000000",
      fid_input_price_1: "",
      fid_input_price_2: "",
      fid_vol_cnt: "",
    };
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: "FHPST01740000",
        custtype: "P",
      },
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      console.error("[시총API] 실패:", marketLabel, res.status, "invalid JSON");
      throw new Error(`KIS market-cap: invalid JSON (${marketLabel})`);
    }
    if (!res.ok) {
      console.error("[시총API] 실패:", marketLabel, res.status, json?.msg1 || json?.msg_cd || "");
      throw new Error(`KIS market-cap HTTP ${res.status} (${marketLabel}): ${text.slice(0, 300)}`);
    }
    if (json.rt_cd && json.rt_cd !== "0") {
      console.error("[시총API] 실패:", marketLabel, res.status, json?.msg1 || json?.msg_cd || "");
      throw new Error(`KIS market-cap error (${marketLabel}) rt_cd=${json.rt_cd} msg=${json.msg1 || ""}`);
    }
    const list = Array.isArray(json.output) ? json.output : [];
    return list
      .map((row) => ({
        code: sanitizeStr(row.stck_shrn_iscd),
        name: sanitizeStr(row.hts_kor_isnm),
        stck_avls: normalizeStckAvlsWon(pickStckAvls(row)),
        stck_avlsNum: Number(String(normalizeStckAvlsWon(pickStckAvls(row))).replace(/,/g, "")) || 0,
        change: kisRowPctChange(row),
        currentPrice: sanitizeStr(row.stck_prpr),
      }))
      .filter((r) => r.code && r.stck_avls);
  }

  const [kospi, kosdaq] = await Promise.all([
    fetchOnce("0001", "KOSPI"),
    fetchOnce("1001", "KOSDAQ"),
  ]);
  const combined = [...kospi, ...kosdaq].sort((a, b) => (b.stck_avlsNum || 0) - (a.stck_avlsNum || 0));
  const map = new Map();
  const rankByCode = new Map();
  for (const r of combined) {
    if (!map.has(r.code)) {
      map.set(r.code, r.stck_avls);
      rankByCode.set(r.code, rankByCode.size + 1);
    }
  }
  console.log(`  시가총액 lookup: ${map.size}종목`);
  if (map.size === 0) {
    console.error("[시총API] KIS 시총 lookup 0종목");
  }
  return { map, rankByCode };
}

function enrichRowsWithMcap(rows, mcapByCode) {
  if (!mcapByCode || !mcapByCode.size) return rows;
  return rows.map((r) => {
    const fromLookup = mcapByCode.get(r.code);
    const stckAvls = normalizeStckAvlsWon(r.stck_avls) || fromLookup || "";
    return stckAvls ? { ...r, stck_avls: stckAvls } : r;
  });
}

function parseNaverMarketValueKorean(raw) {
  const s = sanitizeStr(raw);
  if (!s) return "";
  let won = 0;
  const jo = s.match(/([\d,]+)\s*조/);
  const eok = s.match(/([\d,]+)\s*억/);
  if (jo) {
    const n = Number(jo[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) won += Math.round(n * 1e12);
  }
  if (eok) {
    const n = Number(eok[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) won += Math.round(n * 1e8);
  }
  if (!jo && !eok) {
    const n = Number(s.replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) {
      won = n >= 1e11 ? Math.round(n) : Math.round(n * 1e8);
    }
  }
  return won >= 1e8 ? String(won) : "";
}

function naverStockMcapWonFromListJson(s) {
  if (!s || typeof s !== "object") return "";
  if (s.marketValueRaw != null && String(s.marketValueRaw).trim() !== "") {
    const n = Number(String(s.marketValueRaw).replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return String(Math.round(n));
  }
  const mv = toNumberOrNull(s.marketValue);
  if (mv != null && mv > 0) return String(Math.round(mv * 1e8));
  return "";
}

async function fetchNaverMarketCapPageJson(page, market = "KOSPI") {
  const pg = Math.max(1, Number(page) || 1);
  const mkt = sanitizeStr(market).toUpperCase() === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
  const url = `https://m.stock.naver.com/api/stocks/marketValue/${mkt}?pageSize=100&page=${pg}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`NAVER market-cap JSON HTTP ${res.status}`);
  }
  return Array.isArray(json.stocks) ? json.stocks : [];
}

async function fetchNaverMarketCapBulkMap() {
  const [k1, k2, k3, q1, q2, q3] = await Promise.all([
    fetchNaverMarketCapPageJson(1, "KOSPI"),
    fetchNaverMarketCapPageJson(2, "KOSPI"),
    fetchNaverMarketCapPageJson(3, "KOSPI"),
    fetchNaverMarketCapPageJson(1, "KOSDAQ"),
    fetchNaverMarketCapPageJson(2, "KOSDAQ"),
    fetchNaverMarketCapPageJson(3, "KOSDAQ"),
  ]);
  const map = new Map();
  for (const s of [...k1, ...k2, ...k3, ...q1, ...q2, ...q3]) {
    const code = sanitizeStr(s.itemCode || s.reutersCode).replace(/\D/g, "").padStart(6, "0").slice(-6);
    const mcap = naverStockMcapWonFromListJson(s);
    if (code && mcap && !map.has(code)) map.set(code, mcap);
  }
  return map;
}

/** 시총 누락 종목 — 네이버 integration API + 시총순위 bulk 보강 */
async function fetchNaverStockMcapWon(code6) {
  const code = String(code6 || "").replace(/\D/g, "").padStart(6, "0").slice(-6);
  if (!/^\d{6}$/.test(code)) return "";
  const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/integration`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(json.totalInfos)) return "";
  const item = json.totalInfos.find((x) => x && x.code === "marketValue");
  return parseNaverMarketValueKorean(item && item.value);
}

async function enrichRowsWithNaverMcap(rows) {
  const missing = rows.filter((r) => r && r.code && !normalizeStckAvlsWon(r.stck_avls));
  if (!missing.length) return rows;
  const byCode = new Map();
  try {
    const bulk = await fetchNaverMarketCapBulkMap();
    for (const r of missing) {
      const mcap = bulk.get(r.code);
      if (mcap) byCode.set(r.code, mcap);
    }
  } catch (e) {
    console.warn("  네이버 시총 bulk lookup 실패:", e.message || e);
  }
  const stillMissing = missing.filter((r) => !byCode.has(r.code));
  for (let i = 0; i < stillMissing.length; i += 6) {
    const chunk = stillMissing.slice(i, i + 6);
    await Promise.all(
      chunk.map(async (r) => {
        try {
          const mcap = await fetchNaverStockMcapWon(r.code);
          if (mcap) byCode.set(r.code, mcap);
        } catch (_) {
          /* skip */
        }
      })
    );
    if (i + 6 < stillMissing.length) await delay(80);
  }
  console.log(`  네이버 시총 보강: ${byCode.size}/${missing.length}종목`);
  if (missing.length > 0 && byCode.size === 0) {
    console.error("[시총API] 네이버 보강 0건:", missing.length, "종목 시총 미수집");
  }
  return rows.map((r) => {
    const mcap = normalizeStckAvlsWon(r.stck_avls) || byCode.get(r.code);
    return mcap ? { ...r, stck_avls: mcap, hts_avls: mcap } : r;
  });
}

async function fetchNaverQuantTopPageJson(market, page) {
  const mkt = sanitizeStr(market).toUpperCase() === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
  const pg = Math.max(1, Number(page) || 1);
  const url = `https://m.stock.naver.com/api/stocks/quantTop/${mkt}?pageSize=100&page=${pg}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`NAVER quantTop JSON HTTP ${res.status}`);
  }
  return Array.isArray(json.stocks) ? json.stocks : [];
}

function isCommonStockRow(s) {
  const end = sanitizeStr(s && s.stockEndType).toLowerCase();
  if (end && end !== "stock") return false;
  const name = sanitizeStr(s && s.stockName);
  if (/\bETF\b|\bETN\b/i.test(name)) return false;
  return true;
}

function naverVolumeFromStock(s) {
  const raw = s && s.accumulatedTradingVolumeRaw;
  if (raw != null && String(raw).trim() !== "") {
    const n = Number(String(raw).replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return String(Math.round(n));
  }
  return sanitizeStr(s && s.accumulatedTradingVolume);
}

function naverStockTradingValueRaw(s) {
  const raw = Number(s && s.accumulatedTradingValueRaw);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const price = sanitizeStr(s.closePrice || (s.overMarketPriceInfo && s.overMarketPriceInfo.overPrice));
  const vol = naverVolumeFromStock(s);
  const calc = calcTradingValueWon(price, vol);
  return calc ? Number(calc) : 0;
}

function mapNaverTradingValueRow(s, rank, board) {
  const codeRaw = String(s.itemCode || s.reutersCode || "").replace(/\D/g, "");
  const code = codeRaw.length <= 6 ? codeRaw.padStart(6, "0") : codeRaw.slice(-6);
  const tradingValueRaw = String(naverStockTradingValueRaw(s) || "");
  const mcapWon = naverStockMcapWonFromListJson(s);
  return {
    rank,
    code,
    name: sanitizeStr(s.stockName),
    market: board,
    currentPrice: sanitizeStr(s.closePrice || (s.overMarketPriceInfo && s.overMarketPriceInfo.overPrice)),
    prevDelta: toNumberOrNull(s.compareToPreviousClosePrice),
    change: toNumberOrNull(s.fluctuationsRatio),
    volume: naverVolumeFromStock(s),
    tradingValueRaw,
    tradingValue: formatTradingValue(tradingValueRaw),
    stck_avls: mcapWon,
  };
}

/** NAVER 시가총액·거래대금(quantTop) 풀 — 실시간시세 거래대금 탭과 동일 계열 */
async function collectTradingValueTopN({ topN }) {
  const [k1, k2, k3, q1, q2, q3, v1, v2] = await Promise.all([
    fetchNaverMarketCapPageJson(1, "KOSPI"),
    fetchNaverMarketCapPageJson(2, "KOSPI"),
    fetchNaverMarketCapPageJson(3, "KOSPI"),
    fetchNaverMarketCapPageJson(1, "KOSDAQ"),
    fetchNaverMarketCapPageJson(2, "KOSDAQ"),
    fetchNaverMarketCapPageJson(3, "KOSDAQ"),
    fetchNaverQuantTopPageJson("KOSPI", 1).catch(() => []),
    fetchNaverQuantTopPageJson("KOSDAQ", 1).catch(() => []),
  ]);
  const byCode = new Map();
  for (const s of [...k1, ...k2, ...k3, ...q1, ...q2, ...q3, ...v1, ...v2].filter(isCommonStockRow)) {
    const codeRaw = String(s.itemCode || s.reutersCode || "").replace(/\D/g, "");
    const code = codeRaw.length <= 6 ? codeRaw.padStart(6, "0") : codeRaw.slice(-6);
    if (!/^\d{6}$/.test(code)) continue;
    const tv = naverStockTradingValueRaw(s);
    const board = sanitizeStr(s.sosok) === "1" ? "KOSDAQ" : "KOSPI";
    const hit = byCode.get(code);
    if (!hit || tv > hit.tv) byCode.set(code, { s, tv, board });
  }
  const sorted = [...byCode.values()].sort((a, b) => b.tv - a.tv).slice(0, topN);
  console.log(`  거래대금 NAVER 후보 ${byCode.size}건 → TOP${sorted.length}`);
  return sorted.map((item, i) => mapNaverTradingValueRow(item.s, i + 1, item.board));
}

/** KIS 거래대금 API 실패 시 상승률 TOP 종목의 acml_tr_pbmn으로 대체 */
function buildTradingValueFallbackFromGainers(gainers, topN) {
  const rows = (gainers || [])
    .map((s) => {
      const tradingValueRaw =
        sanitizeStr(s.tradingValueRaw) ||
        pickAcmlTrPbmn(s) ||
        calcTradingValueWon(s.currentPrice, s.volume);
      if (!tradingValueRaw) return null;
      return {
        code: s.code,
        name: s.name,
        market: s.market,
        currentPrice: s.currentPrice,
        prevDelta: s.prevDelta,
        change: s.change,
        volume: sanitizeStr(s.volume),
        tradingValueRaw,
        stck_avls: normalizeStckAvlsWon(s.stck_avls),
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        (toNumberOrNull(b.tradingValueRaw) || 0) - (toNumberOrNull(a.tradingValueRaw) || 0)
    );
  return rows.slice(0, topN).map((r, i) => ({ ...r, rank: i + 1 }));
}

// ─── main ────────────────────────────────────────────────
async function main() {
  const appKey = requireEnv("KIS_APP_KEY");
  const appSecret = requireEnv("KIS_APP_SECRET");

  const baseUrl = (process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(/\/+$/, "");
  const outputPath = path.resolve(process.env.OUTPUT_PATH || path.join("data", "daily-market.json"));
  const topN = Math.max(1, Math.min(50, Number(process.env.TOP_N) || 30));
  const forceNaver = process.env.SOURCE === "naver";
  const targetYmd =
    process.env.TARGET_DATE && YMD_RE.test(process.env.TARGET_DATE)
      ? process.env.TARGET_DATE
      : seoulYmd(new Date());

  console.log(`Target date: ${targetYmd} | TOP ${topN}`);

  let kisOAuthToken = null;
  if (!forceNaver) {
    console.log("[1/4] KIS access token from env...");
    kisOAuthToken = getKisToken();
  }

  console.log("[2/4] KIS 상승률 랭킹 (KOSPI/KOSDAQ)...");
  let { rows: top, source: rankingSource } = await collectFluctuationTopN({
    baseUrl,
    token: kisOAuthToken,
    appKey,
    appSecret,
    topN,
    rankSortClsCode: "0",
    sortAscending: false,
    forceNaver,
    logLabel: "상승률",
  });

  if (!top.length) {
    console.error("상승률 데이터가 비어 있습니다.");
    process.exit(1);
  }

  if (!kisOAuthToken) {
    console.log("[2b/4] KIS access token from env (하락률 보강용)...");
    kisOAuthToken = getKisToken();
  }

  console.log(
    `  상승 Source=${rankingSource} | Top ${top.length}: ${top.slice(0, 3).map((s) => `${s.name}(${s.change}%)`).join(", ")} ...`
  );

  console.log("[2c/4] KIS 하락률 랭킹 (KOSPI/KOSDAQ)...");
  let { rows: bottom, source: declinersSource } = await collectFluctuationTopN({
    baseUrl,
    token: kisOAuthToken,
    appKey,
    appSecret,
    topN,
    rankSortClsCode: "1",
    sortAscending: true,
    forceNaver,
    logLabel: "하락률",
  });

  if (!bottom.length) {
    console.warn("  하락률 데이터가 비어 있습니다.");
  } else {
    console.log(
      `  하락 Source=${declinersSource} | Top ${bottom.length}: ${bottom.slice(0, 3).map((s) => `${s.name}(${s.change}%)`).join(", ")} ...`
    );
  }

  let mcapByCode = new Map();
  if (kisOAuthToken) {
    try {
      const mcapLookup = await fetchMarketCapLookup({
        baseUrl,
        token: kisOAuthToken,
        appKey,
        appSecret,
      });
      mcapByCode = mcapLookup.map;
    } catch (e) {
      console.warn(`  시가총액 lookup 실패(스킵): ${e.message || e}`);
    }
  }
  top = enrichRowsWithMcap(top, mcapByCode);
  bottom = enrichRowsWithMcap(bottom, mcapByCode);
  top = await enrichRowsWithNaverMcap(top);
  bottom = await enrichRowsWithNaverMcap(bottom);

  console.log(`[3/4] 거래대금 TOP${topN} (네이버)...`);
  let topTradingValueRaw = [];
  try {
    topTradingValueRaw = await collectTradingValueTopN({ topN });
  } catch (e) {
    console.warn(`  거래대금 TOP${topN} 실패: ${e.message || e}`);
  }
  if (!topTradingValueRaw.length) {
    topTradingValueRaw = buildTradingValueFallbackFromGainers(top, topN);
    if (topTradingValueRaw.length) {
      console.log(`  거래대금 폴백: topGainers acml_tr_pbmn ${topTradingValueRaw.length}건`);
    } else {
      console.error("[거래대금API] KIS·폴백 모두 0건");
    }
  }
  console.log(`  거래대금 ${topTradingValueRaw.length}건`);

  const topTradingValueEnriched = enrichRowsWithMcap(topTradingValueRaw, mcapByCode);
  const topTradingValueWithMcap = await enrichRowsWithNaverMcap(topTradingValueEnriched);
  const topGainers = top.map((s) => mapStockJsonRow(s, { reason: "", theme: "", newsTitles: [] }));
  const topDecliners = bottom.map(mapTopDeclinersJsonRow);
  const topTradingValue = topTradingValueWithMcap.map(mapTopDeclinersJsonRow);

  console.log("[4/4] daily-market.json 갱신 (TOP30만, AI 필드는 기존값 유지)...");
  const data = (await readJsonIfExists(outputPath)) || {
    meta: { title: "마감시황", timezoneNote: "KST 기준. 특별한 표기가 없으면 종가 기준입니다." },
    days: {},
  };
  if (!data.days || typeof data.days !== "object") data.days = {};
  const existing = data.days[targetYmd] || {};

  data.days[targetYmd] = {
    ...existing,
    date: targetYmd,
    topGainers,
    topDecliners: topDecliners.length ? topDecliners : existing.topDecliners || [],
    topTradingValue: topTradingValue.length ? topTradingValue : existing.topTradingValue || [],
    topGainersUpdatedAt: seoulYmd(new Date()),
    topGainersSource: rankingSource,
    topDeclinersUpdatedAt: seoulYmd(new Date()),
    topDeclinersSource: bottom.length ? declinersSource : existing.topDeclinersSource || "",
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outputPath} (key=${targetYmd})`);

  const archiveDir = path.join(path.dirname(outputPath), "daily");
  const archivePath = path.join(archiveDir, `${targetYmd}.json`);
  await fs.mkdir(archiveDir, { recursive: true });
  const archivePayload = { date: targetYmd, ...data.days[targetYmd] };
  await fs.writeFile(archivePath, JSON.stringify(archivePayload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${archivePath}`);

  console.log("\n=== 미리보기 ===");
  console.log(`상승 TOP3: ${topGainers.slice(0, 3).map((s) => `${s.name}(${s.change}%)`).join(", ")}`);
  console.log(`하락 TOP3: ${topDecliners.slice(0, 3).map((s) => `${s.name}(${s.change}%)`).join(", ")}`);
  console.log(`거래대금 TOP3: ${topTradingValue.slice(0, 3).map((s) => s.name).join(", ")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack || e.message) : e);
  process.exit(1);
});
