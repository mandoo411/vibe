/**
 * 한국투자증권 Open API 프록시 (Vercel Serverless)
 * 환경변수:
 *   - KIS_ACCESS_TOKEN : OAuth 액세스 토큰 (GitHub Actions 등에서 주기 갱신 후 주입)
 *   - KIS_APP_KEY, KIS_APP_SECRET : REST/WebSocket 헤더·Approval용 앱 키
 * 선택: KIS_BASE_URL, KIS_API_GAP_MS (기본 700, 호출 간격 ms)
 * 선택: KIS_FLUCTUATION_MAX_PAGES, KIS_MARKET_CAP_MAX_PAGES (순위 연속조회 페이지 상한, 기본 12)
 * 선택: KIS_TRADE_PBMN_MAX_PAGES — 거래금액순위(volume-rank, fid_blng_cls_code=3) 연속조회 상한, 기본 12
 * 선택: KIS_TRADE_PBMN_HTTP_TIMEOUT_MS — 첫 페이지 HTTP 타임아웃(ms), 기본 20000
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

/** FHPST01740000 시가총액 순위 — 페이지 제한으로 연속조회 (시장당 상한) */
const MARKET_CAP_RANK_MAX_PAGES = Math.max(
  1,
  Math.min(30, Number(process.env.KIS_MARKET_CAP_MAX_PAGES) || 12)
);

/** FHPST01710000 국내 거래금액순위 — 공식 `quotations/volume-rank` + fid_blng_cls_code=3 (거래금액순). 연속조회 페이지 상한 */
const TRADE_PBMN_RANK_MAX_PAGES = Math.max(
  1,
  Math.min(30, Number(process.env.KIS_TRADE_PBMN_MAX_PAGES) || 12)
);

/** volume-rank(거래금액순) 단일 HTTP 타임아웃(ms). 미설정 시 kisGet 기본(무제한)과 병행 가능하나 클라이언트 대기 완화용. */
const TRADE_PBMN_HTTP_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.KIS_TRADE_PBMN_HTTP_TIMEOUT_MS) || 20000
);

/** action=candle — 일·주·월봉만 (종목+주기별 캔들 메모리 캐시) */
const candleMemoryCache = new Map();

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
    const w = Math.round(n * 1e6);
    if (w >= WON_MIN && w <= WON_MAX) return String(w);
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

/** API가 거래대금을 비울 때 표시용 근사치(현재가×누적거래량, 원) */
function approxPbmnFromPriceVol(priceStr, volStr) {
  const p = Number(String(priceStr || "").replace(/,/g, ""));
  const v = Number(String(volStr || "").replace(/,/g, ""));
  if (!Number.isFinite(p) || !Number.isFinite(v) || p <= 0 || v <= 0) return "";
  const x = p * v;
  if (!Number.isFinite(x) || x <= 0 || x > Number.MAX_SAFE_INTEGER) return "";
  return String(Math.round(x));
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
async function fetchMarketCapRows(fidInputIscd, maxRows, fallbackBoard, opts = {}) {
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

  const rawAll = [];
  let trCont = "";
  for (let page = 0; page < MARKET_CAP_RANK_MAX_PAGES; page++) {
    const { json, trCont: nextTr } = await kisGet(
      "/uapi/domestic-stock/v1/ranking/market-cap",
      "FHPST01740000",
      params,
      trCont
    );
    const part = kisOutputRows(json);
    if (!part.length) break;
    rawAll.push(...part);
    const cont = String(nextTr || "").trim().toUpperCase();
    if (cont !== "M") break;
    trCont = "N";
  }
  const chunk = rawAll;

  if (logSample) {
    if (chunk.length > 0) {
      const row0 = chunk[0];
      const avlsKeys = Object.keys(row0).filter((k) => /avls|iscd|rank|prpr|ctrt/i.test(k));
      const avls0 = sanitizeStr(row0.stck_avls ?? row0.STCK_AVLS);
      const won0 = avls0 ? mcapRankingStckAvlsToWonString(avls0) : "";
      console.log("[kis-realtime-data][market-cap] KIS 응답 샘플", {
        tr_id: "FHPST01740000",
        url: "/uapi/domestic-stock/v1/ranking/market-cap",
        fid_cond_scr_div_code: "20174 (시가총액 순위 전용)",
        fid_input_iscd: fidInputIscd,
        pagedRowCount: chunk.length,
        maxPagesCap: MARKET_CAP_RANK_MAX_PAGES,
        sample_avls_related_keys: avlsKeys,
        stck_avls: row0.stck_avls ?? row0.STCK_AVLS,
        hts_avls: row0.hts_avls ?? row0.HTS_AVLS,
        stck_prpr: row0.stck_prpr ?? row0.STCK_PRPR,
        converted_won_string: won0 || "(없음)",
      });
    } else {
      console.log("[kis-realtime-data][market-cap] 빈 output", { fid_input_iscd: fidInputIscd });
    }
  }
  const rows = [];
  const seen = new Set();
  for (const row of chunk) {
    const code = sanitizeStr(row.mksc_shrn_iscd);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const price = pickStckPrpr(row);
    const volume = pickAcmlVol(row);
    let tradingValue = pickAcmlTrPbmn(row);
    if (!tradingValue) tradingValue = approxPbmnFromPriceVol(price, volume) || "";
    const avlsRaw = sanitizeStr(row.stck_avls ?? row.STCK_AVLS);
    const mcapWon = avlsRaw ? mcapRankingStckAvlsToWonString(avlsRaw) : "";
    rows.push({
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
    });
  }
  return rows.filter((r) => r.code).slice(0, maxRows);
}

/** 코스피 시가총액 상위 30 */
async function fetchMarketCapKospi30() {
  return fetchMarketCapRows("0001", 30, "KOSPI");
}

/**
 * @param {{ closeOnly?: boolean }} [opts]
 *   closeOnly: fid_prc_cls_code=1 만 사용(등락률·전일대비 랭킹).
 */
async function fetchFluctuationRank(marketCode, marketLabel, opts = {}) {
  const closeOnly = Boolean(opts.closeOnly);
  const fluctuationSearchParams = (fidPrcCls) => ({
    fid_cond_mrkt_div_code: "J",
    fid_cond_scr_div_code: "20170",
    fid_input_iscd: marketCode,
    fid_rank_sort_cls_code: "0",
    fid_input_cnt_1: "0",
    /** 1: 등락률(종가/전일대비 스크립트). 0: 현재가 */
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

  /** 연속조회(tr_cont M→N)로 등락률 순위 원시 행 누적 */
  async function fetchFluctuationRawRowsPaged(fidPrcCls) {
    const params = fluctuationSearchParams(fidPrcCls);
    const acc = [];
    let trCont = "";
    for (let page = 0; page < FLUCTUATION_RANK_MAX_PAGES; page++) {
      const { json, trCont: nextTr } = await kisGet(
        "/uapi/domestic-stock/v1/ranking/fluctuation",
        "FHPST01700000",
        params,
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

  const mapRawRowsToRanked = (list) =>
    list
      .map((row) => {
        const code = sanitizeStr(row.stck_shrn_iscd);
        const price = pickStckPrpr(row);
        const volume = pickAcmlVol(row);
        const tradingValue = pickAcmlTrPbmn(row);
        return {
          code,
          name: sanitizeStr(row.hts_kor_isnm),
          market: marketLabel,
          tvBoard: pickKoreanBoardKind(row, marketLabel),
          price,
          changePct: toNum(row.prdy_ctrt),
          volume,
          tradingValue,
          rank: toNum(row.data_rank),
        };
      })
      .filter((r) => r.code && r.name);

  const rawPrimary = await fetchFluctuationRawRowsPaged("1");
  const byCode = new Map();
  for (const r of mapRawRowsToRanked(rawPrimary)) {
    if (!byCode.has(r.code)) byCode.set(r.code, r);
  }
  let rows = [...byCode.values()];

  if (!closeOnly && rows.length && rows.some((r) => !r.tradingValue)) {
    const rawAlt = await fetchFluctuationRawRowsPaged("0");
    const tvByCode = new Map();
    for (const row of rawAlt) {
      const c = sanitizeStr(row.stck_shrn_iscd);
      const tv = pickAcmlTrPbmn(row);
      if (c && tv) tvByCode.set(c, tv);
    }
    rows = rows.map((r) => (r.tradingValue ? r : { ...r, tradingValue: tvByCode.get(r.code) || "" }));
  }
  rows = rows.map((r) =>
    r.tradingValue ? r : { ...r, tradingValue: approxPbmnFromPriceVol(r.price, r.volume) || "" }
  );
  console.log("[kis-api] fluctuation merged", {
    market: marketLabel,
    closeOnly,
    uniqueRows: rows.length,
    maxPagesCap: FLUCTUATION_RANK_MAX_PAGES,
  });
  return rows;
}

async function fetchGainersMerged50() {
  const [kospi, kosdaq] = await Promise.all([
    fetchFluctuationRank("0001", "KOSPI"),
    fetchFluctuationRank("1001", "KOSDAQ"),
  ]);
  const merged = new Map();
  for (const r of [...kospi, ...kosdaq]) {
    if (!merged.has(r.code)) merged.set(r.code, r);
  }
  const all = [...merged.values()].filter((r) => r.changePct != null);
  all.sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
  return all.slice(0, 50).map((r, i) => ({ ...r, rank: i + 1 }));
}

/** 거래대금 문자열 → 정렬용 숫자(원) */
function tradePbmnSortKey(tvStr) {
  const n = Number(String(tvStr || "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * [국내주식] 거래금액순위 — 한투 공식은 `GET /uapi/domestic-stock/v1/quotations/volume-rank` (TR FHPST01710000),
 * fid_cond_scr_div_code=20171, fid_blng_cls_code=3(거래금액순). 코스피/코스닥은 등락률·시총과 같이 fid_cond_mrkt_div_code=J + fid_input_iscd 0001|1001.
 */
async function fetchTradePbmnRankRowsForMarket(fidMrktDiv, marketLabel) {
  const isKosdaq = fidMrktDiv === "Q" || String(marketLabel || "").toUpperCase() === "KOSDAQ";
  const fidInputIscd = isKosdaq ? "1001" : "0001";
  const params = {
    fid_cond_mrkt_div_code: "J",
    fid_cond_scr_div_code: "20171",
    fid_input_iscd: fidInputIscd,
    fid_div_cls_code: "0",
    fid_blng_cls_code: "3",
    fid_trgt_cls_code: "111111111",
    fid_trgt_exls_cls_code: "0000000000",
    fid_input_price_1: "",
    fid_input_price_2: "",
    fid_vol_cnt: "",
    fid_input_date_1: "",
  };

  const rawAll = [];
  let trCont = "";
  for (let page = 0; page < TRADE_PBMN_RANK_MAX_PAGES; page++) {
    const fetchOpts = page === 0 ? { timeoutMs: TRADE_PBMN_HTTP_TIMEOUT_MS } : {};
    const { json, trCont: nextTr } = await kisGet(
      "/uapi/domestic-stock/v1/quotations/volume-rank",
      "FHPST01710000",
      params,
      trCont,
      fetchOpts
    );
    const part = kisOutputRows(json);
    if (!part.length) break;
    rawAll.push(...part);
    const cont = String(nextTr || "").trim().toUpperCase();
    if (cont !== "M") break;
    trCont = "N";
  }

  const rows = [];
  const seen = new Set();
  for (const row of rawAll) {
    const code = sanitizeStr(
      row.mksc_shrn_iscd || row.MKSC_SHRN_ISCD || row.stck_shrn_iscd || row.STCK_SHRN_ISCD
    );
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const name = sanitizeStr(row.hts_kor_isnm);
    if (!name) continue;
    const price = pickStckPrpr(row);
    const volume = pickAcmlVol(row);
    let tradingValue = pickAcmlTrPbmn(row);
    if (!tradingValue) tradingValue = approxPbmnFromPriceVol(price, volume) || "";
    rows.push({
      code,
      name,
      price,
      changePct: toNum(row.prdy_ctrt),
      volume,
      tradingValue,
      tvBoard: pickKoreanBoardKind(row, isKosdaq ? "KOSDAQ" : "KOSPI"),
    });
  }
  return rows;
}

/** 단일 시장 trade-pbmn만 호출해 거래대금 기준 TOP50(순위 부여). */
async function fetchTradePbmnTop50ForMarket(fidMrktDiv, marketLabel) {
  const rows = await fetchTradePbmnRankRowsForMarket(fidMrktDiv, marketLabel);
  const all = [...rows].filter((r) => r.code && r.name);
  all.sort((a, b) => tradePbmnSortKey(b.tradingValue) - tradePbmnSortKey(a.tradingValue));
  return all.slice(0, 50).map((r, i) => ({ ...r, rank: i + 1 }));
}

function getPrevTop50JsonPath() {
  return path.join(process.cwd(), "data", "prev-top50.json");
}

/** 전일 상승 TOP50 — data/prev-top50.json 만 읽음(KIS 호출 없음). 실패·빈 목록 시 noData */
function loadPrevDayTop50FromDisk() {
  const filePath = getPrevTop50JsonPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { stocks: [], noData: true };
    }
    const rawText = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(rawText);
    const rawList = Array.isArray(data.stocks) ? data.stocks : [];
    const stocks = rawList
      .filter((x) => x && sanitizeStr(x.code))
      .map((x, i) => {
        const digits = String(x.code).replace(/\D/g, "");
        const code = digits.length <= 6 ? digits.padStart(6, "0") : digits.slice(-6);
        return {
          rank: x.rank != null ? toNum(x.rank) : i + 1,
          code,
          name: sanitizeStr(x.name),
          market: sanitizeStr(x.market) || "KOSPI",
          tvBoard: sanitizeStr(x.tvBoard) || sanitizeStr(x.market) || "KOSPI",
          prevDayChangePct: toNum(x.prevDayChangePct),
        };
      })
      .filter((x) => x.code && x.name)
      .slice(0, 50);
    return { stocks, noData: stocks.length === 0 };
  } catch {
    return { stocks: [], noData: true };
  }
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

async function fetchIndexPrice(fidInputIscd, label) {
  for (const fidCondMrktDivCode of ["J", "U"]) {
    console.log("[kis-realtime-data][index] → inquire-index-price", {
      tr_id: "FHPUP02100000",
      fid_cond_mrkt_div_code: fidCondMrktDivCode,
      fid_input_iscd: fidInputIscd,
      label,
    });
    try {
      const { json } = await kisGet(
        "/uapi/domestic-stock/v1/quotations/inquire-index-price",
        "FHPUP02100000",
        {
          fid_cond_mrkt_div_code: fidCondMrktDivCode,
          fid_input_iscd: fidInputIscd,
        },
        ""
      );
      const o = json.output;
      const row = Array.isArray(o) ? o[0] : o;
      if (!row || typeof row !== "object") continue;
      const rawLevel = pickIndexLevelRaw(row);
      const changePct = toNum(row.prdy_ctrt || row.bstp_nmix_prdy_ctrt || row.nmix_prdy_ctrt);
      const value = formatIndexDisplayValue(rawLevel);
      if (rawLevel && indexLevelPlausible(fidInputIscd, rawLevel)) {
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
    } catch (e) {
      console.warn("[kis-realtime-data][index] try failed", fidCondMrktDivCode, fidInputIscd, e && e.message);
    }
  }
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

/** [국내주식] 주식현재가 시세 — fid_cond_mrkt_div_code J(코스피)·Q(코스닥) */
async function fetchDomesticInquirePrice(code6, fidMrktDiv) {
  const { json } = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-price",
    "FHKST01010100",
    {
      fid_cond_mrkt_div_code: fidMrktDiv,
      fid_input_iscd: code6,
    },
    "",
    { timeoutMs: 12000 }
  );
  const o = json.output;
  const row = Array.isArray(o) ? o[0] : o;
  if (!row || typeof row !== "object") {
    throw new Error("inquire-price: empty output");
  }
  const price = pickStckPrpr(row);
  const changePct = toNum(row.prdy_ctrt ?? row.PRDY_CTRT);
  return { code: code6, price, changePct, mrkt: fidMrktDiv };
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

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
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
      json(res, 200, {
        approval_key,
        wsUrl: "ws://ops.koreainvestment.com:21000",
        note: "HTTPS 페이지에서는 브라우저가 ws:// WebSocket을 차단할 수 있습니다. 이 경우 자동으로 REST 갱신 모드로 동작합니다.",
      });
      return;
    }

    if (action === "market-cap") {
      const stocks = await fetchMarketCapKospi30();
      json(res, 200, { stocks });
      return;
    }

    if (action === "gainers") {
      try {
        const stocks = await fetchGainersMerged50();
        json(res, 200, { stocks });
      } catch (e) {
        console.error("[kis-realtime-data] action=gainers", e && e.message, e);
        json(res, 200, { stocks: [] });
      }
      return;
    }

    if (action === "trade-pbmn-top50") {
      try {
        const mrktRaw = String((req.query && req.query.mrkt) != null ? req.query.mrkt : "J")
          .trim()
          .toUpperCase();
        let fid = "J";
        let marketLabel = "KOSPI";
        if (mrktRaw === "Q" || mrktRaw === "KOSDAQ") {
          fid = "Q";
          marketLabel = "KOSDAQ";
        } else if (mrktRaw === "J" || mrktRaw === "KOSPI" || mrktRaw === "") {
          fid = "J";
          marketLabel = "KOSPI";
        } else {
          json(res, 400, {
            error: "Invalid mrkt. Use J (KOSPI) or Q (KOSDAQ).",
            stocks: [],
          });
          return;
        }
        const stocks = await fetchTradePbmnTop50ForMarket(fid, marketLabel);
        json(res, 200, { stocks, mrkt: fid });
      } catch (e) {
        console.error("[kis-realtime-data] action=trade-pbmn-top50", e && e.message, e);
        json(res, 502, {
          error: e.message || String(e),
          stocks: [],
        });
      }
      return;
    }

    if (action === "prev-day-top50") {
      const { stocks, noData } = loadPrevDayTop50FromDisk();
      json(res, 200, { stocks, noData });
      return;
    }

    if (action === "inquire-price") {
      const code6 = normalizeDomesticStockCode6(req.query && req.query.code);
      if (!/^\d{6}$/.test(code6)) {
        json(res, 400, { error: "Invalid code", code: code6, price: "", changePct: null });
        return;
      }
      let fid = String((req.query && req.query.mrkt) || "J").trim().toUpperCase();
      if (fid === "KOSPI") fid = "J";
      if (fid === "KOSDAQ") fid = "Q";
      if (fid !== "J" && fid !== "Q") {
        json(res, 400, { error: "Invalid mrkt (use J or Q)", code: code6, price: "", changePct: null });
        return;
      }
      try {
        const quote = await fetchDomesticInquirePrice(code6, fid);
        json(res, 200, quote);
      } catch (e) {
        console.error("[kis-realtime-data] action=inquire-price", code6, fid, e && e.message, e);
        json(res, 502, {
          error: e.message || String(e),
          code: code6,
          price: "",
          changePct: null,
        });
      }
      return;
    }

    /** NXT 전용 순위 API는 fid_cond_mrkt_div_code 1자 제한 등으로 미지원 — 클라이언트는 준비중 UI */
    if (action === "index") {
      const [kospi, kosdaq] = await Promise.all([
        fetchIndexPrice("0001", "코스피"),
        fetchIndexPrice("1001", "코스닥"),
      ]);
      json(res, 200, { indexes: [kospi, kosdaq] });
      return;
    }

    if (action === "session") {
      const marketTime = await fetchMarketTime();
      const clock = sessionLabelFromKst();
      json(res, 200, { clock, marketTime });
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
        json(res, 200, { code: code6, period: periodKey, candles: cached.bars, cached: true });
        return;
      }
      const bars = await fetchDailyItemchartCandlesFromKis(code6, periodKey);
      candleMemoryCache.set(cacheKey, { bars, expiresAt: now + ttl, period: periodKey });
      json(res, 200, { code: code6, period: periodKey, candles: bars, cached: false });
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
        gainers = await fetchGainersMerged50();
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
