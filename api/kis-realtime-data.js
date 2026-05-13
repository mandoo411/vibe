/**
 * 한국투자증권 Open API 프록시 (Vercel Serverless)
 * 환경변수: KIS_APP_KEY, KIS_APP_SECRET
 * 선택: KIS_BASE_URL, KIS_API_GAP_MS (기본 500, 호출 간격 ms)
 */

const DEFAULT_BASE = "https://openapi.koreainvestment.com:9443";

/** KIS REST 호출 사이 간격(ms). EGW00201(초당 거래건수 초과) 회피. */
const KIS_GAP_MS = Math.max(0, Number(process.env.KIS_API_GAP_MS) || 500);

let tokenMem = { access_token: null, expires_at: 0 };

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

async function getAccessToken() {
  const { appkey, appsecret } = requireKeys();
  const now = Date.now();
  if (tokenMem.access_token && now < tokenMem.expires_at - 60_000) {
    return tokenMem.access_token;
  }
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
  tokenMem = {
    access_token: json.access_token,
    expires_at: Date.now() + ttlSec * 1000,
  };
  return tokenMem.access_token;
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

  const maxTry = 4;
  for (let attempt = 0; attempt < maxTry; attempt++) {
    const res = await fetch(url.toString(), { method: "GET", headers });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`KIS GET invalid JSON (${path}) HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    if (!res.ok) {
      throw new Error(`KIS GET HTTP ${res.status} (${path}): ${text.slice(0, 400)}`);
    }
    if (json.rt_cd && json.rt_cd !== "0") {
      const msg = json.msg1 || json.msg_cd || "";
      const rateLimited =
        json.msg_cd === "EGW00201" || /초과|거래건수/.test(String(msg));
      if (rateLimited && attempt < maxTry - 1) {
        await sleep(600 + attempt * 350);
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

/**
 * KIS 순위/등락률 응답에서 누적 거래대금(원) 필드명이 환경·API마다 달라질 수 있어 후보를 순서대로 탐색.
 */
function pickAcmlTrPbmn(row) {
  if (!row || typeof row !== "object") return "";
  const keys = [
    "acml_tr_pbmn",
    "ACML_TR_PBMN",
    "hts_acml_tr_pbmn",
    "prtt_tr_pbmn",
    "tot_acml_tr_pbmn",
    "acml_pbmn",
    "stck_mxac_tr_pbmn",
    "mxac_tr_pbmn",
  ];
  for (const k of keys) {
    const v = row[k];
    if (v == null || v === "") continue;
    const s0 = String(v).trim();
    const s = s0.replace(/[^\d,]/g, "");
    if (s && /\d/.test(s)) return s;
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
      fid_trgt_exls_cls_code: "0",
      fid_input_price_1: "",
      fid_vol_cnt: "",
    },
    ""
  );
  const chunk = Array.isArray(json.output) ? json.output : [];
  const rows = [];
  for (const row of chunk) {
    const code = sanitizeStr(row.mksc_shrn_iscd);
    if (!code) continue;
    rows.push({
      rank: toNum(row.data_rank),
      code,
      name: sanitizeStr(row.hts_kor_isnm),
      price: sanitizeStr(row.stck_prpr),
      changePct: toNum(row.prdy_ctrt),
      volume: sanitizeStr(row.acml_vol),
      tradingValue: pickAcmlTrPbmn(row),
      mcapEok: sanitizeStr(row.stck_avls),
    });
  }
  return rows.filter((r) => r.code).slice(0, 30);
}

async function fetchFluctuationRank(marketCode, marketLabel) {
  const url = new URL("/uapi/domestic-stock/v1/ranking/fluctuation", baseUrl());
  const params = {
    fid_cond_mrkt_div_code: "J",
    fid_cond_scr_div_code: "20170",
    fid_input_iscd: marketCode,
    fid_rank_sort_cls_code: "0",
    fid_input_cnt_1: "0",
    /** 0: 현재가 기준(장중 누적 거래대금 등). 1(종가)일 때 acml_tr_pbmn이 비는 경우가 있음 */
    fid_prc_cls_code: "0",
    fid_input_price_1: "",
    fid_input_price_2: "",
    fid_vol_cnt: "",
    fid_trgt_cls_code: "0",
    fid_trgt_exls_cls_code: "0000000000",
    fid_div_cls_code: "0",
    fid_rsfl_rate1: "",
    fid_rsfl_rate2: "",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

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
  const list = Array.isArray(json.output) ? json.output : [];
  return list.map((row) => ({
    code: sanitizeStr(row.stck_shrn_iscd),
    name: sanitizeStr(row.hts_kor_isnm),
    market: marketLabel,
    price: sanitizeStr(row.stck_prpr),
    changePct: toNum(row.prdy_ctrt),
    volume: sanitizeStr(row.acml_vol),
    tradingValue: pickAcmlTrPbmn(row),
    rank: toNum(row.data_rank),
  })).filter((r) => r.code && r.name);
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
      const kospi = await fetchIndexPrice("0001", "코스피");
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
