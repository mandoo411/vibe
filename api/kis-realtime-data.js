/**
 * 한국투자증권 Open API 프록시 (Vercel Serverless)
 * 환경변수:
 *   - KIS_ACCESS_TOKEN : OAuth 액세스 토큰 (GitHub Actions 등에서 주기 갱신 후 주입)
 *   - KIS_APP_KEY, KIS_APP_SECRET : REST/WebSocket 헤더·Approval용 앱 키
 * 선택: KIS_BASE_URL, KIS_API_GAP_MS (기본 700, 호출 간격 ms)
 */

const DEFAULT_BASE = "https://openapi.koreainvestment.com:9443";
const fs = require("fs");
const path = require("path");

/** KIS REST 호출 사이 간격(ms). EGW00201(초당 거래건수 초과) 회피. */
const KIS_GAP_MS = Math.max(0, Number(process.env.KIS_API_GAP_MS) || 700);

/** action=candle — 일·주·월봉만 (종목+주기별 캔들 메모리 캐시) */
const candleMemoryCache = new Map();

/** action=prev-day-gainers — data/prev-top50.json 목록 + 당일 시세(5분) */
let prevDayGainersCache = null; // { mtimeMs, rankingYmd, stocks }
let prevDayQuotesCache = null; // { at, rankingYmd, codeKey, byCode: Map }

function parsePbmnSortKey(s) {
  const n = Number(String(s || "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
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

async function kisGet(path, trId, searchParams, trCont = "") {
  const { appkey, appsecret } = requireAppKeySecret();
  const token = requireAccessToken();
  await sleep(KIS_GAP_MS);
  const url = new URL(path, baseUrl());
  for (const [k, v] of Object.entries(searchParams || {})) {
    url.searchParams.set(k, v == null ? "" : String(v));
  }
  const headers = {
    "content-type": "application/json; charset=utf-8",
    authorization: `Bearer ${token}`,
    appkey,
    appsecret: appsecret,
    tr_id: trId,
    custtype: "P",
    tr_cont: trCont,
  };

  const maxTry = 7;
  for (let attempt = 0; attempt < maxTry; attempt++) {
    const res = await fetch(url.toString(), { method: "GET", headers });
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
      throw new Error(`KIS GET HTTP ${res.status} (${path}): ${text.slice(0, 400)}`);
    }
    if (json.rt_cd && json.rt_cd !== "0") {
      const msg = json.msg1 || json.msg_cd || "";
      if (rateLimited && attempt < maxTry - 1) {
        await sleep(900 + attempt * 450);
        continue;
      }
      throw new Error(`KIS rt_cd=${json.rt_cd} msg=${msg}`);
    }
    const nextTrCont = readTrContHeader(res, json);
    return { json, trCont: nextTrCont };
  }
  throw new Error(`KIS GET failed after retries (${path})`);
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
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
 */
async function fetchMarketCapRows(fidInputIscd, maxRows, fallbackBoard) {
  const { json } = await kisGet(
    "/uapi/domestic-stock/v1/ranking/market-cap",
    "FHPST01740000",
    {
      fid_input_price_2: "",
      fid_cond_mrkt_div_code: "J",
      fid_cond_scr_div_code: "20174",
      fid_div_cls_code: "0",
      fid_input_iscd: fidInputIscd,
      fid_trgt_cls_code: "0",
      fid_trgt_exls_cls_code: "0000000000",
      fid_input_price_1: "",
      fid_vol_cnt: "",
    },
    ""
  );
  const chunk = kisOutputRows(json);
  const rows = [];
  for (const row of chunk) {
    const code = sanitizeStr(row.mksc_shrn_iscd);
    if (!code) continue;
    const price = sanitizeStr(row.stck_prpr);
    const volume = pickAcmlVol(row);
    let tradingValue = pickAcmlTrPbmn(row);
    if (!tradingValue) tradingValue = approxPbmnFromPriceVol(price, volume) || "";
    rows.push({
      rank: toNum(row.data_rank),
      code,
      name: sanitizeStr(row.hts_kor_isnm),
      price,
      changePct: toNum(row.prdy_ctrt),
      volume,
      tradingValue,
      mcapEok: sanitizeStr(row.stck_avls),
      tvBoard: pickKoreanBoardKind(row, fallbackBoard),
    });
  }
  return rows.filter((r) => r.code).slice(0, maxRows);
}

/** 코스피 시가총액 상위 30 */
async function fetchMarketCapKospi30() {
  return fetchMarketCapRows("0001", 30, "KOSPI");
}

/** market-cap TR 응답으로 코스피·코스닥 합쳐 거래대금 상위 50 */
async function fetchTradeValueTop50FromMarketCap() {
  const kospi = await fetchMarketCapRows("0001", 100, "KOSPI");
  await sleep(KIS_GAP_MS);
  const kosdaq = await fetchMarketCapRows("1001", 100, "KOSDAQ");
  const merged = new Map();
  for (const r of [...kospi, ...kosdaq]) {
    const prev = merged.get(r.code);
    if (!prev) merged.set(r.code, r);
    else if (parsePbmnSortKey(r.tradingValue) > parsePbmnSortKey(prev.tradingValue)) merged.set(r.code, r);
  }
  const list = [...merged.values()];
  list.sort((a, b) => parsePbmnSortKey(b.tradingValue) - parsePbmnSortKey(a.tradingValue));
  return list.slice(0, 50).map((r, i) => ({
    rank: i + 1,
    code: r.code,
    name: r.name,
    price: r.price,
    changePct: r.changePct,
    tradingValue: r.tradingValue,
    tvBoard: r.tvBoard,
  }));
}

/**
 * @param {{ closeOnly?: boolean }} [opts]
 *   closeOnly: fid_prc_cls_code=1 만 사용(등락률·전일대비 랭킹).
 */
async function fetchFluctuationRank(marketCode, marketLabel, opts = {}) {
  const closeOnly = Boolean(opts.closeOnly);
  const urlBase = new URL("/uapi/domestic-stock/v1/ranking/fluctuation", baseUrl());
  const buildParams = (fidPrcCls) => ({
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

  async function fetchOnce(fidPrcCls) {
    const url = new URL(urlBase.toString());
    for (const [k, v] of Object.entries(buildParams(fidPrcCls))) url.searchParams.set(k, v);

    await sleep(KIS_GAP_MS);
    const { appkey, appsecret } = requireAppKeySecret();
    const token = requireAccessToken();

    const maxTry = 4;
    let json;
    for (let attempt = 0; attempt < maxTry; attempt++) {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
          appkey,
          appsecret: appsecret,
          tr_id: "FHPST01700000",
          custtype: "P",
          tr_cont: "",
        },
      });
      const text = await res.text();
      json = JSON.parse(text);
      if (json.rt_cd && json.rt_cd !== "0") {
        const msg = json.msg1 || json.msg_cd || "";
        const rateLimited =
          json.msg_cd === "EGW00201" || /초과|거래건수/.test(String(msg));
        if (rateLimited && attempt < maxTry - 1) {
          await sleep(600 + attempt * 350);
          continue;
        }
        throw new Error(`fluctuation ${marketLabel} rt_cd=${json.rt_cd} msg=${msg}`);
      }
      break;
    }
    return json;
  }

  const mapRows = (rawJson) => {
    const list = kisOutputRows(rawJson);
    return list
      .map((row) => {
        const code = sanitizeStr(row.stck_shrn_iscd);
        const price = sanitizeStr(row.stck_prpr);
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
  };

  let rows = mapRows(await fetchOnce("1"));
  if (!closeOnly && rows.length && rows.some((r) => !r.tradingValue)) {
    const rawAlt = await fetchOnce("0");
    const tvByCode = new Map(
      kisOutputRows(rawAlt).map((row) => [sanitizeStr(row.stck_shrn_iscd), pickAcmlTrPbmn(row)])
    );
    rows = rows.map((r) =>
      r.tradingValue ? r : { ...r, tradingValue: tvByCode.get(r.code) || "" }
    );
  }
  rows = rows.map((r) =>
    r.tradingValue ? r : { ...r, tradingValue: approxPbmnFromPriceVol(r.price, r.volume) || "" }
  );
  return rows;
}

async function fetchGainersMerged50() {
  const kospi = await fetchFluctuationRank("0001", "KOSPI");
  const kosdaq = await fetchFluctuationRank("1001", "KOSDAQ");
  const merged = new Map();
  for (const r of [...kospi, ...kosdaq]) {
    if (!merged.has(r.code)) merged.set(r.code, r);
  }
  const all = [...merged.values()].filter((r) => r.changePct != null);
  all.sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
  return all.slice(0, 50).map((r, i) => ({ ...r, rank: i + 1 }));
}

function getPrevTop50JsonPath() {
  return path.join(process.cwd(), "data", "prev-top50.json");
}

/** data/prev-top50.json — GitHub Actions가 장마감 후 갱신 */
function loadPrevTop50ListFromDisk() {
  const filePath = getPrevTop50JsonPath();
  if (!fs.existsSync(filePath)) {
    return { sessionYmd: "", savedAt: "", stocks: [], mtimeMs: 0 };
  }
  const st = fs.statSync(filePath);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { sessionYmd: "", savedAt: "", stocks: [], mtimeMs: st.mtimeMs };
  }
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
        market: sanitizeStr(x.market) || sanitizeStr(x.tvBoard) || "KOSPI",
        tvBoard: sanitizeStr(x.tvBoard) || sanitizeStr(x.market) || "KOSPI",
        prevDayChangePct: toNum(x.prevDayChangePct),
      };
    })
    .filter((x) => x.code && x.name)
    .slice(0, 50);
  return {
    sessionYmd: data.sessionYmd != null ? String(data.sessionYmd).trim() : "",
    savedAt: data.savedAt != null ? String(data.savedAt).trim() : "",
    stocks,
    mtimeMs: st.mtimeMs,
  };
}

function mergeLiveQuotesIntoPrevDayRows(baseRows, liveByCode) {
  return baseRows.map((r) => {
    const L = liveByCode.get(r.code);
    return {
      rank: r.rank,
      code: r.code,
      name: r.name,
      market: r.market,
      tvBoard: r.tvBoard,
      prevDayChangePct: r.prevDayChangePct != null ? r.prevDayChangePct : null,
      price: L && L.price != null && String(L.price).trim() !== "" ? L.price : "",
      changePct: L && L.changePct != null ? L.changePct : null,
      volume: L && L.volume ? L.volume : "",
      tradingValue: L && L.tradingValue ? L.tradingValue : "",
    };
  });
}

/** 당일 fluctuation 전체에서 코드 매칭 — 5분 메모리 캐시 */
async function enrichPrevDayWithLiveQuotesCached(baseRows, rankingYmd) {
  const codeKey = [...baseRows.map((r) => r.code)].sort().join(",");
  const now = Date.now();
  const ttlQuotes = 5 * 60 * 1000;
  if (
    prevDayQuotesCache &&
    prevDayQuotesCache.rankingYmd === rankingYmd &&
    prevDayQuotesCache.codeKey === codeKey &&
    now - prevDayQuotesCache.at < ttlQuotes
  ) {
    return mergeLiveQuotesIntoPrevDayRows(baseRows, prevDayQuotesCache.byCode);
  }
  const kospi = await fetchFluctuationRank("0001", "KOSPI");
  await sleep(KIS_GAP_MS);
  const kosdaq = await fetchFluctuationRank("1001", "KOSDAQ");
  const byCode = new Map();
  for (const r of [...kospi, ...kosdaq]) {
    if (r.code) byCode.set(r.code, r);
  }
  prevDayQuotesCache = { at: now, rankingYmd, codeKey, byCode };
  return mergeLiveQuotesIntoPrevDayRows(baseRows, byCode);
}

/** 작전장 상승 TOP50 목록 — data/prev-top50.json (mtime 변경 시 재로드) */
async function getPrevDayGainersTop50Cached() {
  const loaded = loadPrevTop50ListFromDisk();
  if (prevDayGainersCache && prevDayGainersCache.mtimeMs === loaded.mtimeMs) {
    return prevDayGainersCache.stocks;
  }
  const rankingYmd = loaded.sessionYmd || "file";
  prevDayGainersCache = {
    at: Date.now(),
    rankingYmd,
    stocks: loaded.stocks,
    mtimeMs: loaded.mtimeMs,
  };
  return loaded.stocks;
}

async function fetchIndexPrice(fidInputIscd, label) {
  const { json } = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-index-price",
    "FHPUP02100000",
    {
      FID_COND_MRKT_DIV_CODE: "U",
      FID_INPUT_ISCD: fidInputIscd,
    },
    ""
  );
  const o = json.output;
  const row = Array.isArray(o) ? o[0] : o;
  if (!row || typeof row !== "object") {
    return { id: fidInputIscd, label, value: "", changePct: null, raw: row };
  }
  const value =
    sanitizeStr(row.nmix_prpr || row.bstp_nmix_prpr || row.prpr_nmix || row.hts_kor_isnm_nmix_prpr);
  const changePct = toNum(row.prdy_ctrt || row.bstp_nmix_prdy_ctrt);
  return { id: fidInputIscd, label, value, changePct, raw: row };
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
  const action = actionRaw === "prevDay" ? "prev-day-gainers" : actionRaw;

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
      const stocks = await fetchGainersMerged50();
      json(res, 200, { stocks });
      return;
    }

    if (action === "prev-day-gainers") {
      const base = await getPrevDayGainersTop50Cached();
      const rankYmd = prevDayGainersCache.rankingYmd || "";
      const stocks = await enrichPrevDayWithLiveQuotesCached(base, rankYmd);
      console.log("[prev-day-gainers] result", {
        source: "data/prev-top50.json",
        sessionYmd: rankYmd,
        baseCount: base.length,
        stocksCount: stocks.length,
      });
      json(res, 200, { stocks });
      return;
    }

    if (action === "trade-value-top50") {
      const stocks = await fetchTradeValueTop50FromMarketCap();
      json(res, 200, { stocks });
      return;
    }

    if (action === "index") {
      const kospi = await fetchIndexPrice("0001", "코스피");
      await sleep(KIS_GAP_MS);
      const kosdaq = await fetchIndexPrice("1001", "코스닥");
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
      const kospi = await fetchIndexPrice("0001", "코스피");
      await sleep(KIS_GAP_MS);
      const kosdaq = await fetchIndexPrice("1001", "코스닥");
      const gainers = await fetchGainersMerged50();
      const cap = await fetchMarketCapKospi30();
      await sleep(KIS_GAP_MS);
      const prevDayBase = await getPrevDayGainersTop50Cached();
      const prevRankYmd = prevDayGainersCache.rankingYmd;
      await sleep(KIS_GAP_MS);
      const prevDayGainers = await enrichPrevDayWithLiveQuotesCached(prevDayBase, prevRankYmd);
      await sleep(KIS_GAP_MS);
      const tradeValueTop50 = await fetchTradeValueTop50FromMarketCap();
      const clock = sessionLabelFromKst();
      json(res, 200, {
        clock,
        marketTime,
        indexes: [kospi, kosdaq],
        gainers,
        marketCap: cap,
        prevDayGainers,
        tradeValueTop50,
      });
      return;
    }

    json(res, 400, { error: "Unknown action" });
  } catch (e) {
    const status = e.statusCode || 500;
    json(res, status, { error: e.message || String(e) });
  }
}
