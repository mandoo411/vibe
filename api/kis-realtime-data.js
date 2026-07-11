/**
 * 한국투자증권 Open API 프록시 (Vercel Serverless)
 * 환경변수:
 *   - KIS_ACCESS_TOKEN : OAuth 액세스 토큰 (GitHub Actions 등에서 주기 갱신 후 주입)
 *   - KIS_APP_KEY, KIS_APP_SECRET : REST/WebSocket 헤더·Approval용 앱 키
 * 선택: KIS_BASE_URL, KIS_API_GAP_MS (기본 700, 호출 간격 ms)
 * 선택: KIS_FLUCTUATION_MAX_PAGES, KIS_MARKET_CAP_MAX_PAGES (순위 연속조회 페이지 상한, 기본 12)
 */

const DEFAULT_BASE = "https://openapi.koreainvestment.com:9443";
const fs = require("fs");
const path = require("path");

/** KIS REST 호출 사이 간격(ms). EGW00201(초당 거래건수 초과) 회피. */
const KIS_GAP_MS = Math.max(0, Number(process.env.KIS_API_GAP_MS) || 700);

/** FHPST01700000 등락률 순위 — 페이지당 ~30건이라 연속조회로 후보 풀 확장 (시장당 상한) */
const FLUCTUATION_RANK_MAX_PAGES = Math.max(
  1,
  Math.min(30, Number(process.env.KIS_FLUCTUATION_MAX_PAGES) || 12)
);

/** FHPST01740000 시가총액 순위 — KIS 공식: 최대 30건, tr_cont 연속조회 불가 */
const MARKET_CAP_RANK_MAX_PAGES = Math.max(
  1,
  Math.min(30, Number(process.env.KIS_MARKET_CAP_MAX_PAGES) || 12)
);

/** action=candle — 일·주·월봉만 (종목+주기별 캔들 메모리 캐시) */
const candleMemoryCache = new Map();

/** market-cap / gainers 페이지별 응답 캐시 (KIS 연속조회 비용 절감) */
const RANK_PAGE_CACHE_MS = Math.max(30_000, Number(process.env.KIS_RANK_PAGE_CACHE_MS) || 120_000);
const rankPageCache = new Map();
const META_CACHE_MS = 60_000;
const metaCache = { index: null, indexAt: 0, session: null, sessionAt: 0 };

function rankPageCacheGet(key) {
  const hit = rankPageCache.get(key);
  if (!hit || Date.now() > hit.expiresAt) return null;
  return hit.payload;
}

function rankPageCacheSet(key, payload) {
  rankPageCache.set(key, { payload, expiresAt: Date.now() + RANK_PAGE_CACHE_MS });
}

function rankRangeForPage(page, pageSize) {
  const pg = Math.max(1, Math.min(4, Number(page) || 1));
  const ps = Math.max(1, Math.min(25, Number(pageSize) || 25));
  const startRank = (pg - 1) * ps + 1;
  const endRank = Math.min(pg * ps, 100);
  return { page: pg, pageSize: ps, startRank, endRank, total: 100 };
}

function isRankPageAll(page) {
  return String(page ?? "").trim().toLowerCase() === "all";
}

/** KIS 순위 API 1회 ~30건 — endRank까지 필요한 연속조회 횟수 */
function kisBatchCountForEndRank(endRank) {
  const n = Math.max(1, Math.min(100, Number(endRank) || 25));
  return Math.min(MARKET_CAP_RANK_MAX_PAGES, Math.max(1, Math.ceil(n / 30)));
}

/** EGW00201(초당 거래건수 초과) — HTTP 500 + JSON 본문으로 올 수 있음 */
function isKisRateLimitError(json) {
  if (!json || typeof json !== "object") return false;
  if (json.msg_cd === "EGW00201") return true;
  const blob = `${json.msg1 || ""} ${json.message || ""}`;
  return /초당 거래건수|EGW00201/.test(String(blob));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** KIS 응답 tr_cont (연속조회). 헤더 이름·대소문자 편차 흡수 */
function readTrContHeader(res, json) {
  const fromBody =
    (json && (json.tr_cont ?? json.TR_CONT ?? json.trCont)) != null
      ? String(json.tr_cont ?? json.TR_CONT ?? json.trCont).trim()
      : "";
  if (fromBody) return fromBody;
  for (const [k, v] of res.headers.entries()) {
    if (String(k).toLowerCase() === "tr_cont" || String(k).toLowerCase() === "tr-cont") {
      return String(v || "").trim();
    }
  }
  return "";
}

function baseUrl() {
  return (process.env.KIS_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

function requireAppKeySecret() {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  if (!appkey || !appsecret) {
    const err = new Error("Missing KIS_APP_KEY or KIS_APP_SECRET");
    err.statusCode = 503;
    throw err;
  }
  return { appkey, appsecret };
}

/** GitHub Actions 등에서 갱신한 OAuth 액세스 토큰 (tokenP 직접 호출 없음). */
function requireAccessToken() {
  const t = process.env.KIS_ACCESS_TOKEN;
  const trimmed = t == null ? "" : String(t).trim();
  if (!trimmed) {
    const err = new Error("Missing KIS_ACCESS_TOKEN");
    err.statusCode = 503;
    throw err;
  }
  return trimmed;
}

async function kisGet(path, trId, searchParams, trCont = "", fetchOpts = {}) {
  const { appkey, appsecret } = requireAppKeySecret();
  const token = requireAccessToken();
  await sleep(KIS_GAP_MS);
  const url = new URL(path, baseUrl());
  for (const [k, v] of Object.entries(searchParams || {})) {
    url.searchParams.set(k, v == null ? "" : String(v));
  }
  const qPreview = String(url.search || "").slice(0, 220);
  console.log("[kis-api] →", { path, trId, trCont: trCont || "", query: qPreview });
  const headers = {
    "content-type": "application/json; charset=utf-8",
    authorization: `Bearer ${token}`,
    appkey,
    appsecret: appsecret,
    tr_id: trId,
    custtype: "P",
    tr_cont: trCont,
  };

  const timeoutMs =
    fetchOpts && fetchOpts.timeoutMs != null && Number.isFinite(Number(fetchOpts.timeoutMs))
      ? Math.max(1000, Number(fetchOpts.timeoutMs))
      : 0;

  const maxTry = 7;
  for (let attempt = 0; attempt < maxTry; attempt++) {
    let res;
    if (timeoutMs > 0) {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        res = await fetch(url.toString(), { method: "GET", headers, signal: ctrl.signal });
      } catch (e) {
        clearTimeout(tid);
        if (e && e.name === "AbortError") {
          throw new Error(`KIS GET timeout after ${timeoutMs}ms (${path})`);
        }
        throw e;
      }
      clearTimeout(tid);
    } else {
      res = await fetch(url.toString(), { method: "GET", headers });
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (!res.ok && attempt < maxTry - 1) {
        await sleep(800 + attempt * 400);
        continue;
      }
      throw new Error(`KIS GET invalid JSON (${path}) HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    const rateLimited = isKisRateLimitError(json);
    /** EGW00201 등은 HTTP 500 + rt_cd≠0 으로만 올 때가 있어 res.ok 전에 재시도 판단 */
    if (!res.ok && rateLimited && attempt < maxTry - 1) {
      await sleep(900 + attempt * 450);
      continue;
    }
    if (!res.ok) {
      console.error("[kis-api] KIS GET HTTP error", {
        status: res.status,
        path,
        trId,
        snippet: text.slice(0, 500),
      });
      throw new Error(`KIS GET HTTP ${res.status} (${path}): ${text.slice(0, 400)}`);
    }
    if (json.rt_cd && json.rt_cd !== "0") {
      const msg = json.msg1 || json.msg_cd || "";
      if (rateLimited && attempt < maxTry - 1) {
        await sleep(900 + attempt * 450);
        continue;
      }
      console.error("[kis-api] KIS rt_cd error", {
        path,
        trId,
        rt_cd: json.rt_cd,
        msg1: json.msg1,
        msg_cd: json.msg_cd,
      });
      throw new Error(`KIS rt_cd=${json.rt_cd} msg=${msg}`);
    }
    const nextTrCont = readTrContHeader(res, json);
    const outN = kisOutputRows(json).length;
    console.log("[kis-api] ←", { path, trId, rt_cd: json && json.rt_cd, outputRowCount: outN });
    return { json, trCont: nextTrCont };
  }
  throw new Error(`KIS GET failed after retries (${path})`);
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

/** REST/JSON 종목 row에서 현재가 — stck_prpr 만 사용 (prpr_unt 등은 단위·스케일이 달라 오표시 원인) */
function pickStckPrpr(row) {
  if (!row || typeof row !== "object") return "";
  return sanitizeStr(row.stck_prpr ?? row.STCK_PRPR);
}

/**
 * KIS 시가총액 관련 필드(stck_avls, hts_avls 등) — TR마다 **백만원** 또는 **억원** 정수로 오는 경우가 있어
 * 둘 다 안전하게 원화 문자열로 환산한다. (이미 원 단위인 초대 정수는 그대로)
 */
function pickMcapMillionWonFromRow(row) {
  if (!row || typeof row !== "object") return "";
  const keys = [
    "stck_avls",
    "STCK_AVLS",
    "hts_avls",
    "HTS_AVLS",
    "hts_avls_unt",
    "HTS_AVLS_UNT",
    "stck_mxac_avls",
    "STCK_MXAC_AVLS",
  ];
  for (const k of keys) {
    if (!(k in row)) continue;
    const v = row[k];
    if (v != null && String(v).trim() !== "") return v;
  }
  for (const k of Object.keys(row)) {
    if (!/avls/i.test(k)) continue;
    if (/rlim|rate|prtt|비중|whol.*rlim/i.test(k)) continue;
    const v = row[k];
    if (v != null && String(v).trim() !== "") return v;
  }
  return "";
}

/** 시가총액 필드 정수 → 원 단위 문자열 (백만원 / 억원 / 이미 원) — 시총순위 외 TR용 */
function mcapAvlsRawToWonString(raw) {
  const s = normalizeWonMoneyString(raw);
  if (!s) return "";
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e13) return String(Math.round(n));

  const WON_MAX = 3e15;
  const WON_MIN = 5e11;

  if (n >= 1e8) {
    const asWon = Math.round(n);
    const asMillionWon = Math.round(n * 1e6);
    const millionOk = asMillionWon >= WON_MIN && asMillionWon <= WON_MAX;
    // NAVER marketValueRaw(원): 보통 1e9~1e12 — KIS 백만원(1e8대)과 구분
    if (asWon >= 1e9 && asWon < 1e13) return String(asWon);
    if (millionOk) return String(asMillionWon);
    if (asWon >= 1e8 && asWon <= WON_MAX) return String(asWon);
    return "";
  }

  if (n < 2e7) {
    const wE = Math.round(n * 1e8);
    if (wE >= WON_MIN && wE <= WON_MAX) return String(wE);
  }
  const wM = Math.round(n * 1e6);
  if (wM >= WON_MIN && wM <= WON_MAX) return String(wM);
  return "";
}

/**
 * FHPST01740000 시가총액 순위의 stck_avls — 8자리 이상은 백만원, 그 미만은 억원 우선 후 백만원.
 */
function mcapRankingStckAvlsToWonString(raw) {
  const s = normalizeWonMoneyString(raw);
  if (!s) return "";
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e13) return String(Math.round(n));
  const WON_MAX = 3e15;
  const WON_MIN = 5e11;
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

/** 클라이언트로 내려갈 시가총액(원) 문자열: 순위/현재가 응답 row */
function marketCapWonStringForStockRow(row) {
  if (!row || typeof row !== "object") return "";
  const millionField = pickMcapMillionWonFromRow(row);
  if (millionField) {
    const w = mcapAvlsRawToWonString(millionField);
    if (w) return w;
  }
  const legacy = sanitizeStr(row.mcapEok) || sanitizeStr(row.stck_avls);
  if (!legacy) return "";
  const n = Number(String(legacy).replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e13) return String(Math.round(n));
  return mcapAvlsRawToWonString(legacy);
}

function toNum(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** KIS 응답 본문 배열 (output / output1 / output2 등 편차) */
function kisOutputRows(json) {
  if (!json || typeof json !== "object") return [];
  for (const key of ["output", "output1", "output2", "OUTPUT", "Output"]) {
    const v = json[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** 숫자·문자·과학적 표기 등을 원 단위 정수 문자열로 정규화 (없으면 "") */
function normalizeWonMoneyString(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v <= 0) return "";
    return String(Math.round(Math.abs(v)));
  }
  const s0 = String(v).trim();
  if (!s0) return "";
  if (/^[\d.]+e[+-]?\d+$/i.test(s0)) {
    const n = Number(s0);
    if (Number.isFinite(n) && n > 0) return String(Math.round(n));
  }
  const s = s0.replace(/[^\d,]/g, "");
  if (s && /\d/.test(s)) return s;
  return "";
}

/**
 * KIS 순위/등락률 응답에서 누적 거래대금(원) 필드명이 환경·API마다 달라질 수 있어 후보를 순서대로 탐색.
 */
function pickAcmlTrPbmn(row) {
  if (!row || typeof row !== "object") return "";
  const keys = [
    "acml_tr_pbmn",
    "ACML_TR_PBMN",
    "hts_acml_tr_pbmn",
    "hts_deal_tr_pbmn",
    "deal_tr_pbmn",
    "prtt_tr_pbmn",
    "tot_acml_tr_pbmn",
    "acml_pbmn",
    "stck_mxac_tr_pbmn",
    "mxac_tr_pbmn",
    "acmlTrPbmn",
  ];
  for (const k of keys) {
    const got = normalizeWonMoneyString(row[k]);
    if (got) return got;
  }
  for (const k of Object.keys(row)) {
    if (!/pbmn/i.test(k)) continue;
    const got = normalizeWonMoneyString(row[k]);
    if (got) return got;
  }
  return "";
}

/**
 * 거래대금(원) = stck_prpr(현재가) × acml_vol(누적거래량)
 * 가능하면 KIS acml_tr_pbmn(누적 거래대금) 필드를 우선 사용.
 */
function calcTradingValueWon(priceStr, volStr) {
  const p = Number(String(priceStr || "").replace(/,/g, ""));
  const v = Number(String(volStr || "").replace(/,/g, ""));
  if (!Number.isFinite(p) || !Number.isFinite(v) || p <= 0 || v <= 0) return "";
  const x = p * v;
  if (!Number.isFinite(x) || x <= 0 || x > Number.MAX_SAFE_INTEGER) return "";
  return String(Math.round(x));
}

function pickLargerVolStr(a, b) {
  const na = Number(String(a ?? "").replace(/,/g, ""));
  const nb = Number(String(b ?? "").replace(/,/g, ""));
  if (!Number.isFinite(na) || na <= 0) return sanitizeStr(b) || sanitizeStr(a);
  if (!Number.isFinite(nb) || nb <= 0) return sanitizeStr(a) || sanitizeStr(b);
  return nb >= na ? String(Math.round(nb)) : String(Math.round(na));
}

/** NAVER 거래대금(원) 참고 — vol×price가 현저히 작으면 거래량 보정 후 재계산 */
function syncVolumeForTradingValue(priceStr, volStr, refTradingValueWon) {
  const p = Number(String(priceStr || "").replace(/,/g, ""));
  let v = Number(String(volStr || "").replace(/,/g, ""));
  const ref = refTradingValueWon != null ? Number(refTradingValueWon) : NaN;
  if (Number.isFinite(p) && p > 0 && Number.isFinite(ref) && ref > 0) {
    const implied = Math.round(ref / p);
    if (!Number.isFinite(v) || v <= 0 || p * v < ref * 0.72) {
      v = implied;
    }
  }
  if (!Number.isFinite(v) || v <= 0) {
    return {
      volume: sanitizeStr(volStr),
      tradingValue: calcTradingValueWon(priceStr, volStr) || "",
    };
  }
  const volOut = String(v);
  return { volume: volOut, tradingValue: calcTradingValueWon(priceStr, volOut) || "" };
}

/** @deprecated calcTradingValueWon 사용 */
function approxPbmnFromPriceVol(priceStr, volStr) {
  return calcTradingValueWon(priceStr, volStr);
}

function calcTradingValueWonFromRow(row) {
  return calcTradingValueWon(pickStckPrpr(row), pickAcmlVol(row));
}

/** 누적 거래량(주) 문자열 정규화 */
function normalizeShareVolString(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
    return String(Math.round(Math.abs(v)));
  }
  const s0 = String(v).trim();
  if (!s0) return "";
  if (/^[\d.]+e[+-]?\d+$/i.test(s0)) {
    const n = Number(s0);
    if (Number.isFinite(n) && n >= 0) return String(Math.round(n));
  }
  const s = s0.replace(/[^\d,]/g, "");
  if (s && /\d/.test(s)) return s;
  return "";
}

/** 누적 거래량(주) — 필드명 편차 흡수 (시총 순위 등) */
function pickAcmlVol(row) {
  if (!row || typeof row !== "object") return "";
  const keys = [
    "acml_vol",
    "ACML_VOL",
    "prdy_acml_vol",
    "tot_acml_vol",
    "hts_acml_vol",
    "acmlVol",
  ];
  for (const k of keys) {
    const got = normalizeShareVolString(row[k]);
    if (got) return got;
  }
  for (const k of Object.keys(row)) {
    if (!/acml.*vol|acml_vol/i.test(k)) continue;
    const got = normalizeShareVolString(row[k]);
    if (got) return got;
  }
  return "";
}

/**
 * KIS 순위/시세 응답의 bstp_cls_code·mrkt_cls_code 등으로 코스피/코스닥 구분.
 * 해석 불가 시 fallbackLabel(KOSPI|KOSDAQ) 사용.
 */
function pickKoreanBoardKind(row, fallbackLabel) {
  const fb = String(fallbackLabel || "").toUpperCase() === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
  if (!row || typeof row !== "object") return fb;
  const direct = sanitizeStr(
    row.bstp_cls_code ||
      row.BSTP_CLS_CODE ||
      row.mrkt_cls_code ||
      row.MRKT_CLS_CODE
  );
  if (direct) {
    const b = boardKindFromClsCode(direct);
    if (b) return b;
  }
  for (const k of Object.keys(row)) {
    if (!/bstp_cls|mrkt_cls/i.test(k)) continue;
    const s = sanitizeStr(row[k]);
    if (!s) continue;
    const b = boardKindFromClsCode(s);
    if (b) return b;
  }
  return fb;
}

/** 분류 코드 문자열 → KOSPI | KOSDAQ (알 수 없으면 null) */
function boardKindFromClsCode(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return null;
  if (/(KOSDAQ|KONEX|KTQ)/.test(s)) return "KOSDAQ";
  if (/KOSPI/.test(s)) return "KOSPI";
  if (/^Q$|^KQ$|^02$|^2$/.test(s)) return "KOSDAQ";
  if (/^Y$|^K$|^KS$|^01$|^1$/.test(s)) return "KOSPI";
  return null;
}

/**
 * 시가총액 순위 TR (코스피·코스닥 공통 파라미터, fid_input_iscd 로 시장 선택)
 * @param {string} fidInputIscd "0001" 코스피 | "1001" 코스닥
 * @param {number} maxRows 상한
 * @param {string} fallbackBoard
 * @param {{ logSample?: boolean }} [opts] logSample=false 시 첫 행 console.log 생략
 */
function mapMarketCapKisRow(row, fallbackBoard) {
  const code = sanitizeStr(row.mksc_shrn_iscd);
  if (!code) return null;
  const price = pickStckPrpr(row);
  const volume = pickAcmlVol(row);
  const tradingValue = pickAcmlTrPbmn(row) || calcTradingValueWon(price, volume) || "";
  const avlsRaw = sanitizeStr(row.stck_avls ?? row.STCK_AVLS);
  const mcapWon = avlsRaw ? mcapRankingStckAvlsToWonString(avlsRaw) : "";
  return {
    rank: toNum(row.data_rank),
    code,
    name: sanitizeStr(row.hts_kor_isnm),
    price,
    changePct: toNum(row.prdy_ctrt),
    volume,
    tradingValue,
    mcapEok: mcapWon,
    stck_avls: mcapWon,
    tvBoard: pickKoreanBoardKind(row, fallbackBoard),
  };
}

/** KIS 시가총액 순위 단일 호출 (최대 ~30건, tr_cont 미지원) */
async function fetchMarketCapKisOnce(fidInputIscd, fallbackBoard, opts = {}) {
  const logSample = opts.logSample !== false;
  const params = {
    fid_input_price_2: "",
    fid_cond_mrkt_div_code: "J",
    fid_cond_scr_div_code: "20174",
    fid_div_cls_code: "0",
    fid_input_iscd: fidInputIscd,
    fid_trgt_cls_code: "0",
    fid_trgt_exls_cls_code: "0000000000",
    fid_input_price_1: "",
    fid_vol_cnt: "",
  };
  const { json } = await kisGet(
    "/uapi/domestic-stock/v1/ranking/market-cap",
    "FHPST01740000",
    params,
    ""
  );
  const part = kisOutputRows(json);
  if (logSample && part.length > 0) {
    console.log("[kis-realtime-data][market-cap] KIS single call", {
      fid_input_iscd: fidInputIscd,
      rowCount: part.length,
    });
  }
  const rows = [];
  const seen = new Set();
  for (const row of part) {
    const mapped = mapMarketCapKisRow(row, fallbackBoard);
    if (!mapped || seen.has(mapped.code)) continue;
    seen.add(mapped.code);
    rows.push(mapped);
  }
  rows.sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  return rows;
}

/**
 * NAVER m.stock JSON — 코스피 시가총액 TOP100 (UTF-8, ETF/ETN 제외)
 */
/** NAVER 누적거래량 — Raw(주) 우선, 표시·거래대금은 항상 현재가×거래량 */
function naverVolumeFromStock(s) {
  const raw = s && s.accumulatedTradingVolumeRaw;
  if (raw != null && String(raw).trim() !== "") {
    const n = Number(String(raw).replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return String(Math.round(n));
  }
  return sanitizeStr(s && s.accumulatedTradingVolume);
}

function finalizeRowQuoteFields(row) {
  if (!row) return row;
  const out = { ...row };
  const fromPriceVol = calcTradingValueWon(out.price, out.volume);
  out.tradingValue = fromPriceVol || pickAcmlTrPbmn(out) || out.tradingValue || "";
  return out;
}

function naverStockMcapWonFromListJson(s) {
  if (!s || typeof s !== "object") return "";
  if (s.marketValueRaw != null && String(s.marketValueRaw).trim() !== "") {
    const n = Number(String(s.marketValueRaw).replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return String(Math.round(n));
  }
  const mv = toNum(s.marketValue);
  if (mv != null && mv > 0) return String(Math.round(mv * 1e8));
  return "";
}

/** NAVER integration totalInfos 시총 표기 — "1조 9,761억", "2837억" 등 */
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

async function fetchNaverStockMcapWonFromIntegration(code6) {
  const code = String(code6 || "")
    .replace(/\D/g, "")
    .padStart(6, "0")
    .slice(-6);
  if (!/^\d{6}$/.test(code)) return "";
  const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/integration`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(json.totalInfos)) return "";
  const item = json.totalInfos.find((x) => x && x.code === "marketValue");
  return parseNaverMarketValueKorean(item && item.value);
}

let naverMcapBulkMapCache = null;
let naverMcapBulkMapAt = 0;
const NAVER_MCAP_BULK_TTL_MS = 10 * 60 * 1000;
const NAVER_MCAP_ENRICH_CONCURRENCY = 8;

async function getNaverMcapBulkMap() {
  if (naverMcapBulkMapCache && Date.now() - naverMcapBulkMapAt < NAVER_MCAP_BULK_TTL_MS) {
    return naverMcapBulkMapCache;
  }
  const [k1, k2, k3, q1, q2, q3] = await Promise.all([
    fetchNaverMarketCapPageJson(1, "KOSPI"),
    fetchNaverMarketCapPageJson(2, "KOSPI"),
    fetchNaverMarketCapPageJson(3, "KOSPI"),
    fetchNaverMarketCapPageJson(1, "KOSDAQ"),
    fetchNaverMarketCapPageJson(2, "KOSDAQ"),
    fetchNaverMarketCapPageJson(3, "KOSDAQ"),
  ]);
  const map = new Map();
  for (const s of [...k1, ...k2, ...k3, ...q1, ...q2, ...q3].filter(isCommonStockRow)) {
    const codeRaw = String(s.itemCode || s.reutersCode || "").replace(/\D/g, "");
    const code = codeRaw.length <= 6 ? codeRaw.padStart(6, "0") : codeRaw.slice(-6);
    const mcapWon = naverStockMcapWonFromListJson(s);
    if (code && mcapWon && !map.has(code)) map.set(code, mcapWon);
  }
  naverMcapBulkMapCache = map;
  naverMcapBulkMapAt = Date.now();
  return map;
}

async function lookupMcapForCodes(codes) {
  const uniq = [...new Set((codes || []).map((c) => String(c || "").replace(/\D/g, "").padStart(6, "0").slice(-6)).filter((c) => /^\d{6}$/.test(c)))].slice(
    0,
    60
  );
  if (!uniq.length) return [];
  const bulk = await getNaverMcapBulkMap();
  const items = [];
  const stillMissing = [];
  for (const code of uniq) {
    const fromBulk = bulk.get(code);
    if (fromBulk) items.push({ code, stck_avls: fromBulk });
    else stillMissing.push(code);
  }
  for (let i = 0; i < stillMissing.length; i += NAVER_MCAP_ENRICH_CONCURRENCY) {
    const chunk = stillMissing.slice(i, i + NAVER_MCAP_ENRICH_CONCURRENCY);
    const part = await Promise.all(
      chunk.map(async (code) => {
        try {
          const stck_avls = await fetchNaverStockMcapWonFromIntegration(code);
          return stck_avls ? { code, stck_avls } : null;
        } catch (_) {
          return null;
        }
      })
    );
    for (const hit of part) {
      if (hit) items.push(hit);
    }
  }
  return items;
}

async function enrichRowsWithNaverMcap(rows) {
  if (!rows || !rows.length) return rows || [];
  let bulk;
  try {
    bulk = await getNaverMcapBulkMap();
  } catch (e) {
    console.warn("[kis-realtime-data][mcap] bulk lookup failed", e && e.message);
    bulk = new Map();
  }
  const merged = rows.map((r) => {
    const existing = marketCapWonStringForStockRow(r);
    if (existing) return finalizeRowQuoteFields({ ...r, stck_avls: existing, mcapEok: existing });
    const fromBulk = bulk.get(r.code);
    if (fromBulk) return finalizeRowQuoteFields({ ...r, stck_avls: fromBulk, mcapEok: fromBulk });
    return finalizeRowQuoteFields(r);
  });
  const missing = merged.filter((r) => r.code && !marketCapWonStringForStockRow(r));
  if (!missing.length) return merged;
  const byCode = new Map();
  for (let i = 0; i < missing.length; i += NAVER_MCAP_ENRICH_CONCURRENCY) {
    const chunk = missing.slice(i, i + NAVER_MCAP_ENRICH_CONCURRENCY);
    await Promise.all(
      chunk.map(async (r) => {
        try {
          const mcap = await fetchNaverStockMcapWonFromIntegration(r.code);
          if (mcap) byCode.set(r.code, mcap);
        } catch (_) {
          /* skip */
        }
      })
    );
  }
  return merged.map((r) => {
    const mcap = marketCapWonStringForStockRow(r) || byCode.get(r.code);
    return mcap ? finalizeRowQuoteFields({ ...r, stck_avls: mcap, mcapEok: mcap }) : r;
  });
}

function mapNaverMarketCapRow(s, rank) {
  const codeRaw = String(s.itemCode || s.reutersCode || "").replace(/\D/g, "");
  const code = codeRaw.length <= 6 ? codeRaw.padStart(6, "0") : codeRaw.slice(-6);
  const changePct = toNum(s.fluctuationsRatio);
  const changeAmt = toNum(s.compareToPreviousClosePrice);
  const price = sanitizeStr(s.closePrice || (s.overMarketPriceInfo && s.overMarketPriceInfo.overPrice));
  const volume = naverVolumeFromStock(s);
  const tradingValue = calcTradingValueWon(price, volume) || "";
  const mcapWon = naverStockMcapWonFromListJson(s);
  return {
    rank,
    code,
    name: sanitizeStr(s.stockName),
    price,
    changePct: changePct != null && Number.isFinite(changePct) ? changePct : null,
    changeAmt: changeAmt != null && Number.isFinite(changeAmt) ? changeAmt : null,
    volume,
    tradingValue,
    mcapEok: mcapWon,
    stck_avls: mcapWon,
    tvBoard: "KOSPI",
  };
}

function isCommonStockRow(s) {
  const end = sanitizeStr(s && s.stockEndType).toLowerCase();
  if (end && end !== "stock") return false;
  const name = sanitizeStr(s && s.stockName);
  if (/\bETF\b|\bETN\b/i.test(name)) return false;
  return true;
}

async function fetchNaverMarketCapPageJson(page, market = "KOSPI") {
  const pg = Math.max(1, Number(page) || 1);
  const mkt = sanitizeStr(market).toUpperCase() === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
  const url = `https://m.stock.naver.com/api/stocks/marketValue/${mkt}?pageSize=100&page=${pg}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`NAVER market-cap JSON HTTP ${res.status}: ${JSON.stringify(json).slice(0, 120)}`);
  }
  return Array.isArray(json.stocks) ? json.stocks : [];
}

async function fetchNaverMarketCapTop100() {
  const cacheKey = "naver-mcap-json:100:stocks-only";
  const cached = rankPageCacheGet(cacheKey);
  if (cached) return cached;

  const [page1, page2] = await Promise.all([fetchNaverMarketCapPageJson(1), fetchNaverMarketCapPageJson(2)]);
  const merged = [...page1, ...page2].filter(isCommonStockRow);
  const result = merged.slice(0, 100).map((s, i) => mapNaverMarketCapRow(s, i + 1));
  if (result.length < 100) {
    console.warn("[kis-realtime-data][market-cap] stocks-only list short", result.length);
  }
  rankPageCacheSet(cacheKey, result);
  return result;
}

/** NAVER 종목 시세 — 정규장+NXT 통합 누적거래량 (stock-analysis·종목검색과 동일) */
async function fetchNaverStockPriceSnapshot(code6) {
  const code = String(code6 || "").replace(/\D/g, "").padStart(6, "0").slice(-6);
  if (!/^\d{6}$/.test(code)) return null;
  const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/price?pageSize=1&page=1`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  const json = await res.json().catch(() => []);
  if (!res.ok) {
    throw new Error(`NAVER stock price HTTP ${res.status}`);
  }
  const row = Array.isArray(json) ? json[0] : null;
  if (!row || typeof row !== "object") return null;
  const price = sanitizeStr(row.closePrice || (row.overMarketPriceInfo && row.overMarketPriceInfo.overPrice));
  let volume = naverVolumeFromStock(row);
  if (!volume && row.accumulatedTradingVolume != null) {
    const n = Number(String(row.accumulatedTradingVolume).replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) volume = String(Math.round(n));
  }
  const changePct = toNum(row.fluctuationsRatio);
  const changeAmt = toNum(row.compareToPreviousClosePrice);
  return { price, volume, changePct, changeAmt };
}

const NAVER_PRICE_OVERLAY_CONCURRENCY = 20;

/** 통합 거래량(NAVER /stock/{code}/price)으로 거래대금 산출 후 행 구성 */
async function rowWithNxtIntegratedVolume(code6, baseRow, naverListStock) {
  const code = String(code6 || "").replace(/\D/g, "").padStart(6, "0").slice(-6);
  const skeleton =
    baseRow || finalizeRowQuoteFields(mapNaverMarketCapRow(naverListStock || {}, 0));
  try {
    const live = await fetchNaverStockPriceSnapshot(code);
    if (!live) return finalizeRowQuoteFields({ ...skeleton, code });
    return finalizeRowQuoteFields({
      ...skeleton,
      code,
      name: skeleton.name || (naverListStock && sanitizeStr(naverListStock.stockName)) || skeleton.name,
      price: live.price || skeleton.price,
      volume: live.volume || skeleton.volume,
      changePct: live.changePct != null ? live.changePct : skeleton.changePct,
      changeAmt: live.changeAmt != null ? live.changeAmt : skeleton.changeAmt,
      volumeNxtIntegrated: true,
    });
  } catch (e) {
    console.warn("[kis-realtime-data] nxt-integrated volume", code, e && e.message);
    return finalizeRowQuoteFields({ ...skeleton, code });
  }
}

async function buildNxtIntegratedTvTop100(candidateByCode) {
  /** 후보 풀 전체에 /price 호출 시 10초+ — 리스트 거래대금 상위만 NXT 통합 재산출 */
  const TV_NXT_INTEGRATE_CANDIDATES = 150;
  const preliminary = [...candidateByCode.entries()]
    .map(([code, item]) => ({ code, tv: Number(item && item.tv) || 0, item }))
    .sort((a, b) => b.tv - a.tv)
    .slice(0, TV_NXT_INTEGRATE_CANDIDATES);
  const scored = [];
  for (let i = 0; i < preliminary.length; i += NAVER_PRICE_OVERLAY_CONCURRENCY) {
    const chunk = preliminary.slice(i, i + NAVER_PRICE_OVERLAY_CONCURRENCY);
    const part = await Promise.all(
      chunk.map(async ({ code, item }) => {
        const row = await rowWithNxtIntegratedVolume(code, item && item.row, item && item.s);
        const tv = Number(row.tradingValue) || 0;
        return { code, tv, row };
      })
    );
    scored.push(...part);
  }
  return scored
    .sort((a, b) => b.tv - a.tv)
    .slice(0, 100)
    .map((item, i) => finalizeRowQuoteFields({ ...item.row, rank: i + 1, volumeNxtIntegrated: true }));
}

function quoteOverlayNeeded(row) {
  if (row && row.volumeNxtIntegrated) return false;
  const code = String(row?.code || "")
    .replace(/\D/g, "")
    .padStart(6, "0")
    .slice(-6);
  return /^\d{6}$/.test(code);
}

/** 페이지 종목 시세 보강 — 거래대금 = 현재가×NXT통합 거래량 (청크 단위) */
async function overlayNaverPriceLive(rows, { limit } = {}) {
  if (!rows || !rows.length) return [];
  const needOverlay = [];
  const skip = [];
  for (const r of rows) {
    const base = finalizeRowQuoteFields(r);
    if (!quoteOverlayNeeded(base)) {
      skip.push(base);
      continue;
    }
    const code = String(r.code || "").replace(/\D/g, "").padStart(6, "0").slice(-6);
    if (!/^\d{6}$/.test(code)) {
      skip.push(base);
      continue;
    }
    needOverlay.push({ code, base });
  }
  const capped = limit ? needOverlay.slice(0, limit) : needOverlay;
  const rest = limit ? needOverlay.slice(limit) : [];
  const overlaid = [];
  for (let i = 0; i < capped.length; i += NAVER_PRICE_OVERLAY_CONCURRENCY) {
    const chunk = capped.slice(i, i + NAVER_PRICE_OVERLAY_CONCURRENCY);
    const part = await Promise.all(
      chunk.map(async ({ code, base }) => {
        try {
          return await rowWithNxtIntegratedVolume(code, base, null);
        } catch (e) {
          console.warn("[kis-realtime-data] naver price overlay", code, e && e.message);
          return base;
        }
      })
    );
    overlaid.push(...part);
  }
  const tail = rest.map(({ base }) => base);
  return [...overlaid, ...tail, ...skip];
}

/** KIS TOP30 시세로 NAVER 순위 목록 상위 종목 실시간 필드 보강 */
async function overlayKisMarketCapLive(rows) {
  if (!rows || !rows.length) return rows;
  try {
    const kis30 = await fetchMarketCapKisOnce("0001", "KOSPI", { logSample: false });
    const byCode = new Map(kis30.map((r) => [r.code, r]));
    return rows.map((r) => {
      const k = byCode.get(r.code);
      if (!k) return r;
      const price = k.price || r.price;
      const volume = pickLargerVolStr(r.volume, k.volume);
      return finalizeRowQuoteFields({
        ...r,
        price,
        changePct: k.changePct != null ? k.changePct : r.changePct,
        volume,
        stck_avls: k.stck_avls || r.stck_avls,
        mcapEok: k.mcapEok || r.mcapEok,
      });
    });
  } catch (e) {
    console.warn("[kis-realtime-data][market-cap] KIS overlay failed", e && e.message);
    return (rows || []).map((r) => finalizeRowQuoteFields(r));
  }
}

/** 시가총액 TOP100 — NAVER 리스트 + KIS TOP30 시세 (NXT /price 100회 호출 생략) */
async function fetchMarketCapAll() {
  let all = await fetchNaverMarketCapTop100();
  all = await overlayKisMarketCapLive(all);
  return all.map((r) => finalizeRowQuoteFields(r));
}

/** 시가총액 TOP100 — 페이지당 25건 */
async function fetchMarketCapPage(page, pageSize = 25) {
  const { startRank, endRank } = rankRangeForPage(page, pageSize);
  const all = await fetchMarketCapAll();
  return all.filter((r) => r.rank >= startRank && r.rank <= endRank);
}

async function fetchMarketCapRows(fidInputIscd, maxRows, fallbackBoard, opts = {}) {
  const rows = await fetchMarketCapKisOnce(fidInputIscd, fallbackBoard, opts);
  const cap = Math.max(1, Math.min(30, Number(maxRows) || 30));
  return rows.filter((r) => r.code).slice(0, cap);
}

/** 코스피 시가총액 상위 30 */
async function fetchMarketCapKospi30() {
  return fetchMarketCapRows("0001", 30, "KOSPI");
}

/** 코스피 시가총액 상위 100 (NAVER 순위 + KIS TOP30 보강) */
async function fetchMarketCapKospi100() {
  return fetchNaverMarketCapTop100();
}

async function fetchNaverQuantTopPageJson(market, page) {
  const mkt = sanitizeStr(market).toUpperCase() === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
  const pg = Math.max(1, Number(page) || 1);
  const url = `https://m.stock.naver.com/api/stocks/quantTop/${mkt}?pageSize=100&page=${pg}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`NAVER quantTop JSON HTTP ${res.status}: ${JSON.stringify(json).slice(0, 120)}`);
  }
  return Array.isArray(json.stocks) ? json.stocks : [];
}

async function fetchNaverDownPageJson(market, page) {
  const mkt = sanitizeStr(market).toUpperCase() || "KOSPI";
  const pg = Math.max(1, Number(page) || 1);
  const url = `https://m.stock.naver.com/api/stocks/down/${encodeURIComponent(mkt)}?pageSize=100&page=${pg}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`NAVER losers JSON HTTP ${res.status}: ${JSON.stringify(json).slice(0, 120)}`);
  }
  return Array.isArray(json.stocks) ? json.stocks : [];
}

async function fetchNaverUpPageJson(market, page) {
  const mkt = sanitizeStr(market).toUpperCase() || "KOSPI";
  const pg = Math.max(1, Number(page) || 1);
  const url = `https://m.stock.naver.com/api/stocks/up/${encodeURIComponent(mkt)}?pageSize=100&page=${pg}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`NAVER gainers JSON HTTP ${res.status}: ${JSON.stringify(json).slice(0, 120)}`);
  }
  return Array.isArray(json.stocks) ? json.stocks : [];
}

/** NAVER 상승률 — 코스피·코스닥 합산 원본 (ETF/ETN 제외) */
async function fetchNaverGainersMergedRaw() {
  const [k1, k2, q1, q2] = await Promise.all([
    fetchNaverUpPageJson("KOSPI", 1),
    fetchNaverUpPageJson("KOSPI", 2),
    fetchNaverUpPageJson("KOSDAQ", 1),
    fetchNaverUpPageJson("KOSDAQ", 2),
  ]);
  const merged = [...k1, ...k2, ...q1, ...q2].filter(isCommonStockRow);
  merged.sort(
    (a, b) =>
      (toNum(b.fluctuationsRatio) ?? -Infinity) - (toNum(a.fluctuationsRatio) ?? -Infinity)
  );
  return merged;
}

function mapNaverGainersMergedRows(merged, limit = 100) {
  return merged.slice(0, limit).map((s, i) => {
    const row = mapNaverMarketCapRow(s, i + 1);
    const board = sanitizeStr(s.sosok) === "1" ? "KOSDAQ" : "KOSPI";
    return { ...row, tvBoard: board };
  });
}

/** 실시간 시세 반영 후 상승 종목만 남기고 등락률 내림차순 재정렬 */
function sanitizeGainersRows(rows) {
  const positives = (rows || [])
    .map((r) => finalizeRowQuoteFields(r))
    .filter((r) => {
      const p = toNum(r.changePct);
      return p != null && Number.isFinite(p) && p > 0;
    })
    .sort((a, b) => (toNum(b.changePct) ?? 0) - (toNum(a.changePct) ?? 0));
  return positives.slice(0, 100).map((r, i) => ({ ...r, rank: i + 1 }));
}

/** NAVER 상승률 — 코스피·코스닥 합산 TOP100 (UTF-8, ETF/ETN 제외) */
async function fetchNaverGainersTop100() {
  const cacheKey = "naver-gainers-json:100:stocks-only";
  const cached = rankPageCacheGet(cacheKey);
  if (cached) return cached;

  const merged = await fetchNaverGainersMergedRaw();
  const result = mapNaverGainersMergedRows(merged, 100);
  if (result.length < 100) {
    console.warn("[kis-realtime-data][gainers] stocks-only list short", result.length);
  }
  rankPageCacheSet(cacheKey, result);
  return result;
}

/** 상승률 TOP100 — NAVER 리스트 시세 + 상승 종목만 (NXT /price 대량 호출 생략) */
async function fetchGainersAll() {
  const merged = await fetchNaverGainersMergedRaw();
  const candidates = mapNaverGainersMergedRows(merged, 150);
  const enriched = await enrichRowsWithNaverMcap(candidates.map((r) => finalizeRowQuoteFields(r)));
  return sanitizeGainersRows(enriched);
}

/** 상승률 TOP100 — 페이지당 25건 */
async function fetchGainersPage(page, pageSize = 25) {
  const { startRank, endRank } = rankRangeForPage(page, pageSize);
  const all = await fetchGainersAll();
  return all.filter((r) => r.rank >= startRank && r.rank <= endRank);
}

async function fetchGainersMerged100() {
  return fetchNaverGainersTop100();
}

/** NAVER 하락률 — 코스피·코스닥 합산 TOP100 (등락률 오름차순) */
async function fetchNaverLosersTop100() {
  const cacheKey = "naver-losers-json:100:stocks-only";
  const cached = rankPageCacheGet(cacheKey);
  if (cached) return cached;

  const [k1, k2, q1, q2] = await Promise.all([
    fetchNaverDownPageJson("KOSPI", 1),
    fetchNaverDownPageJson("KOSPI", 2),
    fetchNaverDownPageJson("KOSDAQ", 1),
    fetchNaverDownPageJson("KOSDAQ", 2),
  ]);
  const merged = [...k1, ...k2, ...q1, ...q2].filter(isCommonStockRow);
  merged.sort(
    (a, b) =>
      (toNum(a.fluctuationsRatio) ?? Infinity) - (toNum(b.fluctuationsRatio) ?? -Infinity)
  );
  const result = merged.slice(0, 100).map((s, i) => {
    const row = mapNaverMarketCapRow(s, i + 1);
    const board = sanitizeStr(s.sosok) === "1" ? "KOSDAQ" : "KOSPI";
    return { ...row, tvBoard: board };
  });
  if (result.length < 50) {
    console.warn("[kis-realtime-data][losers] stocks-only list short", result.length);
  }
  rankPageCacheSet(cacheKey, result);
  return result;
}

/** 하락률 TOP100 — 페이지당 25건 */
async function fetchLosersPage(page, pageSize = 25) {
  const { startRank, endRank } = rankRangeForPage(page, pageSize);
  const all = await fetchNaverLosersTop100();
  const slice = all.filter((r) => r.rank >= startRank && r.rank <= endRank);
  const priced = await overlayNaverPriceLive(slice.map((r) => finalizeRowQuoteFields(r)));
  return enrichRowsWithNaverMcap(priced);
}

function naverStockTradingValueRaw(s) {
  const raw = Number(s && s.accumulatedTradingValueRaw);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const mapped = mapNaverMarketCapRow(s, 0);
  const tv = Number(mapped.tradingValue);
  return Number.isFinite(tv) && tv > 0 ? tv : 0;
}

/** 거래대금 TOP100 — 후보 풀(정규장 리스트) → NXT통합 거래량으로 재정렬 */
async function fetchNaverTradingValueTop100() {
  const cacheKey = "naver-tv-integrated-json:100:stocks-only:nxt-v2";
  const cached = rankPageCacheGet(cacheKey);
  if (cached) return cached;

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
    if (!code) continue;
    const tv = naverStockTradingValueRaw(s);
    const hit = byCode.get(code);
    if (!hit || tv > hit.tv) byCode.set(code, { s, tv, row: null });
  }

  const result = await buildNxtIntegratedTvTop100(byCode);
  if (result.length < 50) {
    console.warn("[kis-realtime-data][trading-value] integrated list short", result.length);
  }
  rankPageCacheSet(cacheKey, result);
  return result;
}

/** 거래대금 TOP100 — KIS 시세 보강 */
async function fetchTradingValueAll() {
  const all = await fetchNaverTradingValueTop100();
  return enrichRowsWithNaverMcap(all.map((r) => finalizeRowQuoteFields(r)));
}

/** 거래대금 TOP100 — 페이지당 25건 (KIS 시세 보강) */
async function fetchTradingValuePage(page, pageSize = 25) {
  const { startRank, endRank } = rankRangeForPage(page, pageSize);
  const all = await fetchTradingValueAll();
  return all.filter((r) => r.rank >= startRank && r.rank <= endRank);
}

/**
 * 등락률 순위 — 지정 batchCount만큼 tr_cont 연속조회 (~30건/회)
 * @param {number} batchCount 1=1~30위, 2=~60위, ...
 */
async function fetchFluctuationMarketBatches(marketCode, marketLabel, batchCount, opts = {}) {
  const closeOnly = Boolean(opts.closeOnly);
  const batches = Math.max(1, Math.min(FLUCTUATION_RANK_MAX_PAGES, Number(batchCount) || 1));
  const fluctuationSearchParams = (fidPrcCls) => ({
    fid_cond_mrkt_div_code: "J",
    fid_cond_scr_div_code: "20170",
    fid_input_iscd: marketCode,
    fid_rank_sort_cls_code: "0",
    fid_input_cnt_1: "0",
    fid_prc_cls_code: fidPrcCls,
    fid_input_price_1: "",
    fid_input_price_2: "",
    fid_vol_cnt: "",
    fid_trgt_cls_code: "0",
    fid_trgt_exls_cls_code: "0000000000",
    fid_div_cls_code: "0",
    fid_rsfl_rate1: "",
    fid_rsfl_rate2: "",
  });

  async function fetchRawBatches(fidPrcCls) {
    const acc = [];
    let trCont = "";
    for (let i = 0; i < batches; i++) {
      const { json, trCont: nextTr } = await kisGet(
        "/uapi/domestic-stock/v1/ranking/fluctuation",
        "FHPST01700000",
        fluctuationSearchParams(fidPrcCls),
        trCont
      );
      const part = kisOutputRows(json);
      if (!part.length) break;
      acc.push(...part);
      const cont = String(nextTr || "").trim().toUpperCase();
      if (cont !== "M") break;
      trCont = "N";
    }
    return acc;
  }

  const mapRawRows = (list) =>
    list
      .map((row) => {
        const code = sanitizeStr(row.stck_shrn_iscd);
        const price = pickStckPrpr(row);
        const volume = pickAcmlVol(row);
        const tradingValue = pickAcmlTrPbmn(row) || calcTradingValueWon(price, volume) || "";
        return {
          code,
          name: sanitizeStr(row.hts_kor_isnm),
          market: marketLabel,
          tvBoard: pickKoreanBoardKind(row, marketLabel),
          price,
          changePct: toNum(row.prdy_ctrt),
          volume,
          tradingValue,
        };
      })
      .filter((r) => r.code && r.name);

  const rawPrimary = await fetchRawBatches("1");
  const byCode = new Map();
  for (const r of mapRawRows(rawPrimary)) {
    if (!byCode.has(r.code)) byCode.set(r.code, r);
  }
  let rows = [...byCode.values()];

  rows = rows.map((r) => ({
    ...r,
    tradingValue: calcTradingValueWon(r.price, r.volume) || "",
  }));
  return rows;
}

/**
 * @param {{ closeOnly?: boolean, maxRows?: number }} [opts]
 *   closeOnly: fid_prc_cls_code=1 만 사용(등락률·전일대비 랭킹).
 */
async function fetchFluctuationRank(marketCode, marketLabel, opts = {}) {
  const closeOnly = Boolean(opts.closeOnly);
  const maxRows = opts.maxRows != null && Number.isFinite(Number(opts.maxRows)) ? Number(opts.maxRows) : null;
  const batches = maxRows != null ? kisBatchCountForEndRank(maxRows) : FLUCTUATION_RANK_MAX_PAGES;
  let rows = await fetchFluctuationMarketBatches(marketCode, marketLabel, batches, { closeOnly });
  if (maxRows != null) rows = rows.slice(0, maxRows);
  console.log("[kis-api] fluctuation merged", {
    market: marketLabel,
    closeOnly,
    uniqueRows: rows.length,
    batches,
  });
  return rows;
}

/** 업종/지수 현재가 후보 — bstp_nmix_prpr 만 쓰면 다른 업종 수치(비정상)가 잡히는 경우가 있어 nmix 우선 */
function pickIndexLevelRaw(row) {
  if (!row || typeof row !== "object") return "";
  return (
    sanitizeStr(row.nmix_prpr) ||
    sanitizeStr(row.NMIX_PRPR) ||
    sanitizeStr(row.nmix_nmix_prpr) ||
    sanitizeStr(row.NMIX_NMIX_PRPR) ||
    sanitizeStr(row.bstp_nmix_prpr) ||
    sanitizeStr(row.BSTP_NMIX_PRPR) ||
    sanitizeStr(row.stck_prpr) ||
    sanitizeStr(row.STCK_PRPR) ||
    sanitizeStr(row.prpr_nmix) ||
    sanitizeStr(row.prpr)
  );
}

function indexLevelPlausible(fidInputIscd, rawLevel) {
  const n = Number(String(rawLevel).replace(/,/g, ""));
  if (!Number.isFinite(n)) return false;
  if (fidInputIscd === "0001") return n > 500 && n < 8000;
  if (fidInputIscd === "1001") return n > 300 && n < 4000;
  return true;
}

function normalizeIndexLevelNumber(fidInputIscd, rawLevel) {
  const raw = String(rawLevel ?? "").trim();
  const n0 = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n0)) return null;
  // 일부 환경에서 지수가 100배 스케일(예: 280000 = 2800.00)로 오는 경우가 있어 보정
  // 이미 소수점이 포함된 값은 보정하지 않는다.
  if (/[.]/.test(raw)) return n0;
  if (fidInputIscd === "0001" && n0 > 8000 && n0 < 800000) return n0 / 100;
  if (fidInputIscd === "1001" && n0 > 4000 && n0 < 400000) return n0 / 100;
  return n0;
}

async function fetchNaverIndexPrice(indexCode) {
  const code = String(indexCode || "").trim().toUpperCase();
  if (code !== "KOSPI" && code !== "KOSDAQ") return null;
  const url = `https://m.stock.naver.com/api/index/${encodeURIComponent(code)}/price?pageSize=1&page=1`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`NAVER index HTTP ${res.status}: ${text.slice(0, 160)}`);
  const arr = JSON.parse(text);
  const row = Array.isArray(arr) ? arr[0] : null;
  if (!row || typeof row !== "object") return null;
  const close = sanitizeStr(row.closePrice);
  const ratio = toNum(row.fluctuationsRatio);
  const n = Number(close.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return {
    value: n.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    changePct: ratio != null && Number.isFinite(ratio) ? ratio : null,
    raw: row,
  };
}

async function fetchIndexPrice(fidInputIscd, label) {
  let best = null;
  const iscdCandidates = (() => {
    const base = String(fidInputIscd || "").trim();
    // 코스피는 KIS index TR에서 0001을 사용 (요청값 고정)
    const list = [base === "0001" ? "0001" : base];
    return [...new Set(list.filter(Boolean))];
  })();

  // 코스피(0001)는 KIS 공식 파라미터: U + 0001
  const condCandidates = String(fidInputIscd) === "0001" ? ["U"] : ["J", "U"];
  for (const fidCondMrktDivCode of condCandidates) {
    console.log("[kis-realtime-data][index] → inquire-index-price", {
      tr_id: "FHPUP02100000",
      fid_cond_mrkt_div_code: fidCondMrktDivCode,
      fid_input_iscd: fidInputIscd,
      label,
    });
    try {
      for (const iscd of iscdCandidates) {
        const { json } = await kisGet(
          "/uapi/domestic-stock/v1/quotations/inquire-index-price",
          "FHPUP02100000",
          {
            fid_cond_mrkt_div_code: fidCondMrktDivCode,
            fid_input_iscd: iscd,
          },
          ""
        );
        const o = json.output ?? json.output1 ?? json.output2;
        const row = Array.isArray(o) ? o[0] : o;
        if (!row || typeof row !== "object") continue;
        const rawLevel = pickIndexLevelRaw(row);
        const changePct = toNum(row.prdy_ctrt || row.bstp_nmix_prdy_ctrt || row.nmix_prdy_ctrt);
        const scaled = rawLevel ? normalizeIndexLevelNumber(fidInputIscd, rawLevel) : null;
        const plausible = scaled != null && indexLevelPlausible(fidInputIscd, String(scaled));
        const value =
          scaled == null
            ? ""
            : scaled.toLocaleString("ko-KR", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });
        if (!best && rawLevel && scaled != null && Number.isFinite(scaled) && scaled > 0) {
          best = { id: fidInputIscd, label, value, changePct, raw: row };
        }
        if (rawLevel && plausible) {
          console.log("[kis-realtime-data][index] ←", {
            label,
            fid_input_iscd: fidInputIscd,
            fid_cond_mrkt_div_code: fidCondMrktDivCode,
            rawLevel,
            value,
            changePct,
            keysSample: Object.keys(row).filter((k) => /nmix|prpr|ctrt|bstp/i.test(k)).slice(0, 12),
          });
          return { id: fidInputIscd, label, value, changePct, raw: row };
        }
      }
    } catch (e) {
      console.warn("[kis-realtime-data][index] try failed", fidCondMrktDivCode, fidInputIscd, e && e.message);
    }
  }
  if (best) return best;

  console.log("[kis-realtime-data][index] ← no plausible level", { label, fidInputIscd });
  return { id: fidInputIscd, label, value: "", changePct: null, raw: null };
}

/** 업종 지수 표시값 — API 문자열 유지·숫자만 정규 포맷 */
function formatIndexDisplayValue(raw) {
  const t = sanitizeStr(raw);
  if (!t) return "";
  const n = Number(String(t).replace(/,/g, ""));
  if (!Number.isFinite(n)) return t;
  const hasDot = /[.]/.test(t);
  return n.toLocaleString("ko-KR", {
    minimumFractionDigits: hasDot ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

async function fetchMarketTime() {
  try {
    const { json } = await kisGet(
      "/uapi/domestic-stock/v1/quotations/market-time",
      "HHMCM000002C0",
      {},
      ""
    );
    const o1 = json.output1;
    const row = Array.isArray(o1) ? o1[0] : o1;
    return row && typeof row === "object" ? row : null;
  } catch {
    return null;
  }
}

async function getApprovalKey() {
  await sleep(KIS_GAP_MS);
  const { appkey, appsecret } = requireAppKeySecret();
  console.log("[kis-api] → POST oauth2/Approval");
  const res = await fetch(`${baseUrl()}/oauth2/Approval`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey,
      secretkey: appsecret,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Approval HTTP ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  if (!json.approval_key) throw new Error(`Approval: no approval_key: ${text.slice(0, 400)}`);
  console.log("[kis-api] ← POST oauth2/Approval OK");
  return json.approval_key;
}

function sessionLabelFromKst() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const wd = map.weekday;
  const hour = Number(map.hour || 0);
  const minute = Number(map.minute || 0);
  const t = hour * 60 + minute;
  const weekend = wd === "Sat" || wd === "Sun";
  if (weekend) return { key: "closed", label: "휴장", detail: "주말" };
  if (t < 9 * 60) return { key: "pre", label: "장전", detail: "정규장 개장 전 (KST)" };
  if (t < 15 * 60 + 30) return { key: "open", label: "장중", detail: "정규장 (KST 09:00–15:30)" };
  return { key: "after", label: "장후", detail: "정규장 마감 후 · NXT 시간외 등" };
}

/** KST 기준 YYYYMMDD */
function ymdKst(d = new Date()) {
  const s = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return s.replace(/-/g, "");
}

function subtractCalendarDaysFromYmd(ymd, days) {
  const y = Number(ymd.slice(0, 4));
  const mo = Number(ymd.slice(4, 6)) - 1;
  const da = Number(ymd.slice(6, 8));
  const u = Date.UTC(y, mo, da) - days * 86400000;
  const d = new Date(u);
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function candleCacheTtlMs() {
  const s = sessionLabelFromKst();
  return s.key === "open" ? 30 * 60 * 1000 : 24 * 60 * 60 * 1000;
}

/**
 * ?period= 쿼리 정규화 — 일·주·월봉만 지원 (D|W|M).
 */
function normalizeCandlePeriodParam(raw) {
  const s = sanitizeStr(raw).toLowerCase();
  if (!s) return "D";
  const map = {
    d: "D",
    daily: "D",
    일: "D",
    일봉: "D",
    w: "W",
    weekly: "W",
    주: "W",
    주봉: "W",
    m: "M",
    monthly: "M",
    월: "M",
    월봉: "M",
  };
  if (map[s] != null) return map[s];
  const u = s.toUpperCase();
  if (u === "D" || u === "W" || u === "M") return u;
  return "D";
}

function normalizeDomesticStockCode6(code) {
  const digits = String(code || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length <= 6 ? digits.padStart(6, "0") : digits.slice(-6);
}

/** 일/주/월봉 목표 개수 */
function dailyCandleTargetCount(periodDiv) {
  const p = String(periodDiv || "D").toUpperCase();
  if (p === "M") return 120;
  return 200;
}

/** 첫 조회 fid_input_date_1 하한 (오늘 기준 과거 달력일) */
function dailyFirstWindowStartDays(periodDiv) {
  const p = String(periodDiv || "D").toUpperCase();
  if (p === "M") return 3650;
  if (p === "W") return 1460;
  return 365;
}

/** 이전 구간으로 넘길 때 한 번에 덮을 달력 폭 */
function dailyBackwardChunkDays(periodDiv) {
  const p = String(periodDiv || "D").toUpperCase();
  if (p === "M") return 4000;
  if (p === "W") return 1000;
  return 450;
}

/** 2026-07-11: 실시간시세 페이지 차트에 미국주식/암호화폐와 동일한 이동평균선(20/60/120/200일)을
 * 추가하기 위한 계산 — 국내주식은 원 단위 정수라 그대로 반올림한다(us-market/crypto의
 * roundSmart 소수점 보정은 여기선 불필요). */
function computeMaSeries(closes, period) {
  const out = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    out.push(Math.round(sum / period));
  }
  return out;
}

function withMaSeries(bars) {
  const closes = (bars || []).map((c) => c.close);
  return {
    candles: bars,
    ma20: computeMaSeries(closes, 20),
    ma60: computeMaSeries(closes, 60),
    ma120: computeMaSeries(closes, 120),
    ma200: computeMaSeries(closes, 200),
  };
}

/** KIS output2 행 → Lightweight Charts용 일/주/월 (time YYYY-MM-DD) */
function mapDailyItemchartRow(row) {
  if (!row || typeof row !== "object") return null;
  const dateRaw = sanitizeStr(
    row.stck_bsop_date ||
      row.STCK_BSOP_DATE ||
      row.bstp_bsop_date ||
      row.BSTP_BSOP_DATE ||
      row.trd_dd ||
      row.TRD_DD
  );
  if (!/^\d{8}$/.test(dateRaw)) return null;
  const time = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
  const open = toNum(
    row.stck_oprc || row.STCK_OPRC || row.bstp_stck_oprc || row.stck_sdpr || row.STCK_SDPR
  );
  const high = toNum(row.stck_hgpr || row.STCK_HGPR);
  const low = toNum(row.stck_lwpr || row.STCK_LWPR);
  const close = toNum(
    row.stck_clpr || row.STCK_CLPR || row.stck_prpr || row.STCK_PRPR || row.prpr || row.PRPR
  );
  if (open == null || high == null || low == null || close == null) return null;
  const volRaw = toNum(
    row.acml_vol ||
      row.ACML_VOL ||
      row.prdy_vol ||
      row.PRDY_VOL ||
      row.hts_acml_vol ||
      row.hts_vol ||
      row.tot_acml_vol
  );
  const volume = volRaw != null && Number.isFinite(volRaw) && volRaw >= 0 ? volRaw : 0;
  return { time, open, high, low, close, volume };
}

/**
 * 국내주식기간별시세(일/주/월) — 응답당 최대 약 100건이라 구간을 나눠 병합.
 * @param {string} periodDiv  D | W | M
 */
async function fetchDailyItemchartCandlesFromKis(code6, periodDiv = "D") {
  const div = sanitizeStr(periodDiv).toUpperCase();
  const fidPeriod = div === "W" || div === "M" ? div : "D";
  const target = dailyCandleTargetCount(fidPeriod);
  const endAll = ymdKst(new Date());
  const byTime = new Map();
  let chunkEnd = endAll;
  const floorYmd = subtractCalendarDaysFromYmd(endAll, dailyFirstWindowStartDays(fidPeriod));

  for (let iter = 0; iter < 30; iter++) {
    if (iter > 0) await sleep(KIS_GAP_MS);
    const chunkStart =
      iter === 0
        ? floorYmd
        : subtractCalendarDaysFromYmd(chunkEnd, dailyBackwardChunkDays(fidPeriod));
    let d1 = chunkStart;
    let d2 = chunkEnd;
    if (d1 >= d2) {
      d1 = subtractCalendarDaysFromYmd(d2, 30);
    }
    if (d1 >= d2) break;

    const { json } = await kisGet(
      "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
      "FHKST03010100",
      {
        fid_cond_mrkt_div_code: "J",
        fid_input_iscd: code6,
        fid_input_date_1: d1,
        fid_input_date_2: d2,
        fid_period_div_code: fidPeriod,
        fid_org_adj_prc: "0",
      },
      ""
    );
    let raw = json.output2;
    if (raw && !Array.isArray(raw)) raw = [raw];
    if (!Array.isArray(raw)) raw = [];
    const batch = [];
    for (const row of raw) {
      const b = mapDailyItemchartRow(row);
      if (b) batch.push(b);
    }
    batch.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    if (!batch.length) break;
    const beforeSize = byTime.size;
    for (const b of batch) byTime.set(b.time, b);
    if (byTime.size >= target) break;
    if (byTime.size === beforeSize && iter > 2) break;

    const oldestYmd = String(batch[0].time).replace(/\D/g, "").slice(0, 8);
    if (!/^\d{8}$/.test(oldestYmd)) break;
    const nextEnd = subtractCalendarDaysFromYmd(oldestYmd, 1);
    if (nextEnd >= chunkEnd) break;
    chunkEnd = nextEnd;
  }

  const bars = [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return bars.slice(-target);
}

function json(res, status, body, opts) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  // 실시간 데이터지만 30초 Edge Cache는 허용범위 — KIS 호출 부하/지연 완화. approval 등은 noStore로 제외.
  const noStore = (opts && opts.noStore) || status !== 200;
  res.setHeader(
    "cache-control",
    noStore ? "no-store" : "public, s-maxage=30, stale-while-revalidate=30"
  );
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  const actionRaw = (req.query && req.query.action) || "snapshot";
  const action = actionRaw;

  try {
    if (action === "approval") {
      const approval_key = await getApprovalKey();
      json(
        res,
        200,
        {
          approval_key,
          wsUrl: "ws://ops.koreainvestment.com:21000",
          note: "HTTPS 페이지에서는 브라우저가 ws:// WebSocket을 차단할 수 있습니다. 이 경우 자동으로 REST 갱신 모드로 동작합니다.",
        },
        { noStore: true }
      );
      return;
    }

    if (action === "mcap-lookup") {
      try {
        const raw = sanitizeStr(req.query && req.query.codes);
        const codes = raw.split(/[,|\s]+/);
        const items = await lookupMcapForCodes(codes);
        json(res, 200, { items, cached: false });
      } catch (e) {
        console.error("[kis-realtime-data] action=mcap-lookup", e && e.message, e);
        json(res, 200, { items: [], cached: false });
      }
      return;
    }

    if (action === "market-cap") {
      const pageRaw = req.query && req.query.page;
      if (isRankPageAll(pageRaw)) {
        const cacheKey = "market-cap:nxt-v4:all";
        const cached = rankPageCacheGet(cacheKey);
        if (cached) {
          json(res, 200, { ...cached, cached: true });
          return;
        }
        const stocks = await fetchMarketCapAll();
        const payload = {
          total: 100,
          page: "all",
          pageSize: 100,
          rankStart: 1,
          rankEnd: 100,
          stocks,
          cached: false,
        };
        rankPageCacheSet(cacheKey, payload);
        json(res, 200, payload);
        return;
      }
      const range = rankRangeForPage(pageRaw, req.query && req.query.pageSize);
      const cacheKey = `market-cap:nxt-v4:${range.page}:${range.pageSize}`;
      const cached = rankPageCacheGet(cacheKey);
      if (cached) {
        json(res, 200, { ...cached, cached: true });
        return;
      }
      const stocks = await fetchMarketCapPage(range.page, range.pageSize);
      const payload = {
        total: range.total,
        page: range.page,
        pageSize: range.pageSize,
        rankStart: range.startRank,
        rankEnd: range.endRank,
        stocks,
        cached: false,
      };
      rankPageCacheSet(cacheKey, payload);
      json(res, 200, payload);
      return;
    }

    if (action === "gainers") {
      try {
        const pageRaw = req.query && req.query.page;
        if (isRankPageAll(pageRaw)) {
          const cacheKey = "gainers:nxt-v5:all";
          const cached = rankPageCacheGet(cacheKey);
          if (cached) {
            json(res, 200, { ...cached, cached: true });
            return;
          }
          const stocks = await fetchGainersAll();
          const payload = {
            total: 100,
            page: "all",
            pageSize: 100,
            rankStart: 1,
            rankEnd: 100,
            stocks,
            cached: false,
          };
          rankPageCacheSet(cacheKey, payload);
          json(res, 200, payload);
          return;
        }
        const range = rankRangeForPage(pageRaw, req.query && req.query.pageSize);
        const cacheKey = `gainers:nxt-v5:${range.page}:${range.pageSize}`;
        const cached = rankPageCacheGet(cacheKey);
        if (cached) {
          json(res, 200, { ...cached, cached: true });
          return;
        }
        const stocks = await fetchGainersPage(range.page, range.pageSize);
        const payload = {
          total: range.total,
          page: range.page,
          pageSize: range.pageSize,
          rankStart: range.startRank,
          rankEnd: range.endRank,
          stocks,
          cached: false,
        };
        rankPageCacheSet(cacheKey, payload);
        json(res, 200, payload);
      } catch (e) {
        console.error("[kis-realtime-data] action=gainers", e && e.message, e);
        json(res, 200, { total: 0, page: 1, pageSize: 25, rankStart: 1, rankEnd: 25, stocks: [], cached: false });
      }
      return;
    }

    if (action === "losers") {
      try {
        const range = rankRangeForPage(req.query && req.query.page, req.query && req.query.pageSize);
        const cacheKey = `losers:nxt-v3:${range.page}:${range.pageSize}`;
        const cached = rankPageCacheGet(cacheKey);
        if (cached) {
          json(res, 200, { ...cached, cached: true });
          return;
        }
        const stocks = await fetchLosersPage(range.page, range.pageSize);
        const payload = {
          total: range.total,
          page: range.page,
          pageSize: range.pageSize,
          rankStart: range.startRank,
          rankEnd: range.endRank,
          stocks,
          cached: false,
        };
        rankPageCacheSet(cacheKey, payload);
        json(res, 200, payload);
      } catch (e) {
        console.error("[kis-realtime-data] action=losers", e && e.message, e);
        json(res, 200, { total: 0, page: 1, pageSize: 25, rankStart: 1, rankEnd: 25, stocks: [], cached: false });
      }
      return;
    }

    if (action === "trading-value") {
      try {
        const pageRaw = req.query && req.query.page;
        if (isRankPageAll(pageRaw)) {
          const cacheKey = "trading-value:nxt-v4:all";
          const cached = rankPageCacheGet(cacheKey);
          if (cached) {
            json(res, 200, { ...cached, cached: true });
            return;
          }
          const stocks = await fetchTradingValueAll();
          const payload = {
            total: 100,
            page: "all",
            pageSize: 100,
            rankStart: 1,
            rankEnd: 100,
            stocks,
            cached: false,
          };
          rankPageCacheSet(cacheKey, payload);
          json(res, 200, payload);
          return;
        }
        const range = rankRangeForPage(pageRaw, req.query && req.query.pageSize);
        const cacheKey = `trading-value:nxt-v4:${range.page}:${range.pageSize}`;
        const cached = rankPageCacheGet(cacheKey);
        if (cached) {
          json(res, 200, { ...cached, cached: true });
          return;
        }
        const stocks = await fetchTradingValuePage(range.page, range.pageSize);
        const payload = {
          total: range.total,
          page: range.page,
          pageSize: range.pageSize,
          rankStart: range.startRank,
          rankEnd: range.endRank,
          stocks,
          cached: false,
        };
        rankPageCacheSet(cacheKey, payload);
        json(res, 200, payload);
      } catch (e) {
        console.error("[kis-realtime-data] action=trading-value", e && e.message, e);
        json(res, 200, { total: 0, page: 1, pageSize: 25, rankStart: 1, rankEnd: 25, stocks: [], cached: false });
      }
      return;
    }

    /** NXT 전용 순위 API는 fid_cond_mrkt_div_code 1자 제한 등으로 미지원 — 클라이언트는 준비중 UI */
    if (action === "index") {
      if (metaCache.index && Date.now() - metaCache.indexAt < META_CACHE_MS) {
        json(res, 200, metaCache.index);
        return;
      }
      const [kospi, kosdaq] = await Promise.all([
        fetchIndexPrice("0001", "코스피"),
        fetchIndexPrice("1001", "코스닥"),
      ]);
      const payload = { indexes: [kospi, kosdaq] };
      metaCache.index = payload;
      metaCache.indexAt = Date.now();
      json(res, 200, payload);
      return;
    }

    if (action === "session") {
      if (metaCache.session && Date.now() - metaCache.sessionAt < META_CACHE_MS) {
        json(res, 200, metaCache.session);
        return;
      }
      const marketTime = await fetchMarketTime();
      const clock = sessionLabelFromKst();
      const payload = { clock, marketTime };
      metaCache.session = payload;
      metaCache.sessionAt = Date.now();
      json(res, 200, payload);
      return;
    }

    if (action === "candle") {
      const code6 = normalizeDomesticStockCode6(req.query && req.query.code);
      if (!code6) {
        json(res, 400, { error: "Missing or invalid code" });
        return;
      }
      const periodKey = normalizeCandlePeriodParam(req.query && req.query.period);
      const cacheKey = `${code6}|${periodKey}`;
      const now = Date.now();
      const cached = candleMemoryCache.get(cacheKey);
      const cacheStaleVolume =
        cached &&
        cached.bars &&
        cached.bars.length > 0 &&
        !Object.prototype.hasOwnProperty.call(cached.bars[0], "volume");
      const ttl = candleCacheTtlMs();
      if (cached && now < cached.expiresAt && !cacheStaleVolume) {
        json(res, 200, { code: code6, period: periodKey, ...withMaSeries(cached.bars), cached: true });
        return;
      }
      const bars = await fetchDailyItemchartCandlesFromKis(code6, periodKey);
      candleMemoryCache.set(cacheKey, { bars, expiresAt: now + ttl, period: periodKey });
      json(res, 200, { code: code6, period: periodKey, ...withMaSeries(bars), cached: false });
      return;
    }

    if (action === "snapshot") {
      const marketTime = await fetchMarketTime();
      await sleep(KIS_GAP_MS);
      const [kospi, kosdaq] = await Promise.all([
        fetchIndexPrice("0001", "코스피"),
        fetchIndexPrice("1001", "코스닥"),
      ]);
      let gainers = [];
      try {
        gainers = (await fetchNaverGainersTop100()).slice(0, 50);
      } catch (e) {
        console.error("[kis-realtime-data][snapshot] gainers", e && e.message, e);
      }
      await sleep(KIS_GAP_MS);
      const cap = await fetchMarketCapKospi30();
      const clock = sessionLabelFromKst();
      json(res, 200, {
        clock,
        marketTime,
        indexes: [kospi, kosdaq],
        gainers,
        marketCap: cap,
      });
      return;
    }

    json(res, 400, { error: "Unknown action" });
  } catch (e) {
    const status = e.statusCode || 500;
    json(res, status, { error: e.message || String(e) });
  }
}
