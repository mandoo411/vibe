/**
 * 한국투자증권 Open API 프록시 (Vercel Serverless)
 * 환경변수: KIS_APP_KEY, KIS_APP_SECRET
 * 선택: KIS_BASE_URL, KIS_API_GAP_MS (기본 700, 호출 간격 ms), KIS_TOKEN_SKEW_MS (토큰 만료 여유 ms, 기본 120000)
 */

const DEFAULT_BASE = "https://openapi.koreainvestment.com:9443";

/** KIS REST 호출 사이 간격(ms). EGW00201(초당 거래건수 초과) 회피. */
const KIS_GAP_MS = Math.max(0, Number(process.env.KIS_API_GAP_MS) || 700);

/** EGW00201(초당 거래건수 초과) — HTTP 500 + JSON 본문으로 올 수 있음 */
function isKisRateLimitError(json) {
  if (!json || typeof json !== "object") return false;
  if (json.msg_cd === "EGW00201") return true;
  const blob = `${json.msg1 || ""} ${json.message || ""}`;
  return /초당 거래건수|EGW00201/.test(String(blob));
}

/** OAuth 액세스 토큰 캐시 (동일 서버리스 인스턴스 메모리 내에서 재사용). */
let tokenCache = {
  access_token: null,
  /** epoch ms — 이 시각 이후에는 만료로 간주 */
  expires_at_ms: 0,
};
/** 동시에 여러 요청이 만료 토큰을 만나도 tokenP는 한 번만 호출 */
let tokenRefreshInflight = null;

/** 만료 전 이 시간(ms)부터 재발급. 환경변수 KIS_TOKEN_SKEW_MS로 조정 (기본 2분). */
const TOKEN_EXPIRY_SKEW_MS = Math.max(
  60_000,
  Number(process.env.KIS_TOKEN_SKEW_MS) || 120_000
);

function isAccessTokenCachedValid() {
  if (!tokenCache.access_token) return false;
  return Date.now() < tokenCache.expires_at_ms - TOKEN_EXPIRY_SKEW_MS;
}

async function fetchNewAccessToken() {
  const { appkey, appsecret } = requireKeys();
  await sleep(KIS_GAP_MS);
  const res = await fetch(`${baseUrl()}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey,
      appsecret: appsecret,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`tokenP HTTP ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error(`tokenP: no access_token: ${text.slice(0, 400)}`);
  const ttlSec = Number(json.expires_in) || 86400;
  tokenCache = {
    access_token: json.access_token,
    expires_at_ms: Date.now() + ttlSec * 1000,
  };
  return tokenCache.access_token;
}

/**
 * 유효한 토큰이 있으면 즉시 반환. 없거나 곧 만료면 한 번만 발급 후 공유(inflight).
 */
async function getAccessToken() {
  if (isAccessTokenCachedValid()) {
    return tokenCache.access_token;
  }
  if (tokenRefreshInflight) {
    await tokenRefreshInflight;
    if (isAccessTokenCachedValid()) return tokenCache.access_token;
    throw new Error("KIS access token refresh completed but token still invalid");
  }
  tokenRefreshInflight = fetchNewAccessToken().finally(() => {
    tokenRefreshInflight = null;
  });
  return tokenRefreshInflight;
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

function requireKeys() {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  if (!appkey || !appsecret) {
    const err = new Error("Missing KIS_APP_KEY or KIS_APP_SECRET");
    err.statusCode = 503;
    throw err;
  }
  return { appkey, appsecret };
}

async function kisGet(path, trId, searchParams, trCont = "") {
  const { appkey, appsecret } = requireKeys();
  const token = await getAccessToken();
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

/** 코스피 시가총액 상위 30 (단일 조회, 연속조회 없음) */
async function fetchMarketCapKospi30() {
  const { json } = await kisGet(
    "/uapi/domestic-stock/v1/ranking/market-cap",
    "FHPST01740000",
    {
      fid_input_price_2: "",
      fid_cond_mrkt_div_code: "J",
      fid_cond_scr_div_code: "20174",
      fid_div_cls_code: "0",
      fid_input_iscd: "0001",
      fid_trgt_cls_code: "0",
      /** 등락률 순위와 동일 10자리 — "0"만 줄 때 일부 필드가 비는 사례 대비 */
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
    /** 시총 순위 TR은 응답에 누적거래대금 컬럼이 없는 경우가 있어 근사치 사용 */
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
    });
  }
  return rows.filter((r) => r.code).slice(0, 30);
}

async function fetchFluctuationRank(marketCode, marketLabel) {
  const urlBase = new URL("/uapi/domestic-stock/v1/ranking/fluctuation", baseUrl());
  const buildParams = (fidPrcCls) => ({
    fid_cond_mrkt_div_code: "J",
    fid_cond_scr_div_code: "20170",
    fid_input_iscd: marketCode,
    fid_rank_sort_cls_code: "0",
    fid_input_cnt_1: "0",
    /** 1: 종가(일간 스크립트와 동일). 0: 현재가 — 환경에 따라 거래대금 필드가 한쪽만 채워질 수 있음 */
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
    const { appkey, appsecret } = requireKeys();
    const token = await getAccessToken();

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
  if (rows.length && rows.some((r) => !r.tradingValue)) {
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
  const { appkey, appsecret } = requireKeys();
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

  const action = (req.query && req.query.action) || "snapshot";

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

    if (action === "snapshot") {
      const marketTime = await fetchMarketTime();
      await sleep(KIS_GAP_MS);
      const kospi = await fetchIndexPrice("0001", "코스피");
      await sleep(KIS_GAP_MS);
      const kosdaq = await fetchIndexPrice("1001", "코스닥");
      const gainers = await fetchGainersMerged50();
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
