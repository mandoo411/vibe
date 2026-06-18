/**
 * 마감시황 대시보드 KIS 프록시 (단일 파일 통합)
 * GET ?action=mktfunds|investor|joint-trading
 */

const DEFAULT_BASE = "https://openapi.koreainvestment.com:9443";

const CACHE = new Map();
const TTL = {
  mktfunds: 3600_000,
  investor: 60_000,
  "joint-trading": 60_000,
};

function json(res, status, body, cacheSec) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (cacheSec > 0) {
    res.setHeader("cache-control", `public, s-maxage=${cacheSec}, stale-while-revalidate=30`);
  } else {
    res.setHeader("cache-control", "no-store");
  }
  res.end(JSON.stringify(body));
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNum(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/,/g, "").replace(/^\+/, ""));
  return Number.isFinite(n) ? n : null;
}

function ymdKst(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d).replace(/-/g, "");
}

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit || Date.now() > hit.expiresAt) return null;
  return hit.payload;
}

function cacheSet(key, payload, ttlMs) {
  CACHE.set(key, { payload, expiresAt: Date.now() + ttlMs });
}

function requireKisCreds() {
  const token = sanitizeStr(process.env.KIS_ACCESS_TOKEN);
  const appkey = sanitizeStr(process.env.KIS_APP_KEY);
  const appsecret = sanitizeStr(process.env.KIS_APP_SECRET);
  if (!token || !appkey || !appsecret) {
    const err = new Error("Missing KIS credentials");
    err.statusCode = 503;
    throw err;
  }
  return { token, appkey, appsecret };
}

function kisBaseUrl() {
  return sanitizeStr(process.env.KIS_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

async function kisGet(path, trId, params, opts = {}) {
  const { token, appkey, appsecret } = requireKisCreds();
  const url = new URL(path, kisBaseUrl());
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, v == null ? "" : String(v));
  }
  const headers = {
    "content-type": "application/json; charset=utf-8",
    authorization: `Bearer ${token}`,
    appkey,
    appsecret,
    tr_id: trId,
  };
  if (opts.trCont) headers.tr_cont = String(opts.trCont);
  if (opts.custtype) headers.custtype = String(opts.custtype);

  const res = await fetch(url.toString(), { method: "GET", headers });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    const err = new Error(`KIS invalid JSON: ${text.slice(0, 200)}`);
    err.statusCode = 502;
    throw err;
  }
  if (!res.ok || (j && j.rt_cd && j.rt_cd !== "0")) {
    const msg = (j && (j.msg1 || j.msg_cd)) || `HTTP ${res.status}`;
    const err = new Error(`KIS error: ${msg}`);
    err.statusCode = 502;
    throw err;
  }
  return j;
}

function outputList(json) {
  if (Array.isArray(json.output)) return json.output;
  if (Array.isArray(json.output1)) return json.output1;
  if (json.output && typeof json.output === "object") return [json.output];
  return [];
}

function pickLatestRow(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const withDate = rows
    .map((r) => {
      const d = sanitizeStr(r.stck_bsop_date || r.bsop_date || r.date || r.STCK_BSOP_DATE);
      const n = /^\d{8}$/.test(d) ? Number(d) : null;
      return { r, n };
    })
    .filter((x) => x.r);
  if (!withDate.length) return rows[rows.length - 1];
  withDate.sort((a, b) => (b.n || 0) - (a.n || 0));
  return withDate[0].r;
}

function pickAmtEok(row, keys) {
  for (const k of keys) {
    const n = toNum(row[k]);
    if (n == null) continue;
    if (/tr_pbmn|pbmn|amt/i.test(k) && Math.abs(n) >= 1000) return Math.round(n / 100);
    return Math.round(n);
  }
  return null;
}

async function fetchMktfunds() {
  const ymd = ymdKst();
  const cacheKey = `mktfunds:${ymd}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const path = "/uapi/domestic-stock/v1/quotations/mktfunds";
  const dateCandidates = [ymd, `002${ymd}`];
  let row = null;
  let lastErr = null;
  for (const fidDate of dateCandidates) {
    try {
      const j = await kisGet(path, "FHKST649100C0", { FID_INPUT_DATE_1: fidDate }, { custtype: "P" });
      row = pickLatestRow(outputList(j)) || j.output;
      if (row && typeof row === "object") break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!row || typeof row !== "object") throw lastErr || new Error("mktfunds empty");

  const payload = {
    date: ymd,
    custDepositEok: toNum(row.cust_dpmn_amt ?? row.CUST_DPMN_AMT),
    custDepositChangeEok: toNum(row.cust_dpmn_amt_prdy_vrss ?? row.CUST_DPMN_AMT_PRDY_VRSS),
    creditLoanEok: toNum(row.crdt_loan_rmnd ?? row.CRDT_LOAN_RMND),
    creditLoanChangeEok: toNum(
      row.crdt_loan_rmnd_prdy_vrss ?? row.crdt_loan_rmnd_icdc ?? row.CRDT_LOAN_RMND_PRDY_VRSS
    ),
    unclAmtEok: toNum(row.uncl_amt ?? row.UNCL_AMT),
    raw: row,
    cached: false,
  };
  cacheSet(cacheKey, payload, TTL.mktfunds);
  return payload;
}

async function fetchInvestorMarket(marketKey) {
  const isKosdaq = String(marketKey || "").toUpperCase() === "KOSDAQ";
  const iscd = isKosdaq ? "1001" : "0001";
  const label = isKosdaq ? "KOSDAQ" : "KOSPI";
  const ymd = ymdKst();
  const cacheKey = `investor:${label}:${ymd}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  let foreign = null;
  let institution = null;
  let individual = null;
  let baseDate = ymd;
  let source = "FHKST01010900";

  try {
    const j = await kisGet(
      "/uapi/domestic-stock/v1/quotations/inquire-investor",
      "FHKST01010900",
      {
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: iscd,
      },
      { custtype: "P" }
    );
    const row = pickLatestRow(outputList(j));
    if (row) {
      foreign =
        pickAmtEok(row, ["frgn_ntby_tr_pbmn", "FRGN_NTBY_TR_PBMN"]) ??
        toNum(row.frgn_ntby_qty ?? row.frgn_ntby_vol ?? row.FRGN_NTBY_QTY);
      institution =
        pickAmtEok(row, ["orgn_ntby_tr_pbmn", "ORGN_NTBY_TR_PBMN"]) ??
        toNum(row.orgn_ntby_qty ?? row.orgn_ntby_vol ?? row.ORGN_NTBY_QTY);
      individual =
        pickAmtEok(row, ["prsn_ntby_tr_pbmn", "PRSN_NTBY_TR_PBMN"]) ??
        toNum(row.prsn_ntby_qty ?? row.prsn_ntby_vol ?? row.PRSN_NTBY_QTY);
      baseDate = sanitizeStr(row.stck_bsop_date || row.bsop_date) || ymd;
    }
  } catch (e) {
    console.warn("[dashboard-data] inquire-investor fallback", label, e && e.message);
  }

  if (foreign == null && institution == null && individual == null) {
    const j = await kisGet(
      "/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market",
      "FHPTJ04040000",
      {
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: "0001",
        FID_INPUT_DATE_1: ymd,
        FID_INPUT_DATE_2: ymd,
        FID_INPUT_ISCD_1: isKosdaq ? "KSQ" : "KSP",
        FID_INPUT_ISCD_2: "",
      },
      { custtype: "P" }
    );
    const row = pickLatestRow(outputList(j)) || outputList(j)[0];
    if (row) {
      foreign = pickAmtEok(row, ["frgn_ntby_tr_pbmn", "frgn_ntby_amt"]);
      institution = pickAmtEok(row, ["orgn_ntby_tr_pbmn", "orgn_ntby_amt"]);
      individual = pickAmtEok(row, ["prsn_ntby_tr_pbmn", "prsn_ntby_amt"]);
      baseDate = sanitizeStr(row.stck_bsop_date) || ymd;
      source = "FHPTJ04040000";
    }
  }

  const payload = {
    market: label,
    date: baseDate,
    foreign,
    institution,
    individual,
    unit: "eok",
    source,
    cached: false,
  };
  cacheSet(cacheKey, payload, TTL.investor);
  return payload;
}

function rowCode(row) {
  const raw = sanitizeStr(row.mksc_shrn_iscd || row.stck_shrn_iscd || row.iscd || row.code);
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return digits.length <= 6 ? digits.padStart(6, "0") : digits.slice(-6);
}

function rowName(row) {
  return sanitizeStr(row.hts_kor_isnm || row.stock_name || row.name) || "—";
}

async function fetchForeignInstitutionPage(marketIscd, sortCode, etcCode) {
  const rows = [];
  let trCont = "";
  for (let page = 0; page < 3; page++) {
    const j = await kisGet(
      "/uapi/domestic-stock/v1/quotations/inquire-foreign-institution-total",
      "FHPTJ04400000",
      {
        FID_COND_MRKT_DIV_CODE: "J",
        fid_input_iscd: marketIscd,
        fid_div_cls_code: "1",
        fid_rank_sort_cls_code: sortCode,
        fid_etc_cls_code: etcCode,
      },
      { custtype: "P", trCont }
    );
    rows.push(...outputList(j));
    const next = sanitizeStr(j.tr_cont || j.TR_CONT);
    if (!next || next === "N" || next === "0" || rows.length >= 30) break;
    trCont = next;
  }
  return rows.slice(0, 30);
}

function mapJointRow(row) {
  const code = rowCode(row);
  if (!/^\d{6}$/.test(code)) return null;
  const foreignM = toNum(row.frgn_ntby_tr_pbmn ?? row.FRGN_NTBY_TR_PBMN) ?? 0;
  const instM = toNum(row.orgn_ntby_tr_pbmn ?? row.ORGN_NTBY_TR_PBMN) ?? 0;
  return {
    code,
    name: rowName(row),
    foreignM,
    institutionM: instM,
    totalM: foreignM + instM,
    foreignEok: Math.round(foreignM / 100),
    institutionEok: Math.round(instM / 100),
    totalEok: Math.round((foreignM + instM) / 100),
  };
}

async function fetchJointTrading() {
  const ymd = ymdKst();
  const cacheKey = `joint-trading:${ymd}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const markets = [
    { iscd: "0001", label: "KOSPI" },
    { iscd: "1001", label: "KOSDAQ" },
  ];

  const foreignBuy = new Map();
  const instBuy = new Map();
  const foreignSell = new Map();
  const instSell = new Map();
  const rowByCode = new Map();

  for (const mkt of markets) {
    const [frBuy, inBuy, frSell, inSell] = await Promise.all([
      fetchForeignInstitutionPage(mkt.iscd, "0", "1"),
      fetchForeignInstitutionPage(mkt.iscd, "0", "2"),
      fetchForeignInstitutionPage(mkt.iscd, "1", "1"),
      fetchForeignInstitutionPage(mkt.iscd, "1", "2"),
    ]);
    for (const row of frBuy) {
      const code = rowCode(row);
      if (code) foreignBuy.set(code, mapJointRow(row));
      if (code && !rowByCode.has(code)) rowByCode.set(code, row);
    }
    for (const row of inBuy) {
      const code = rowCode(row);
      if (code) instBuy.set(code, mapJointRow(row));
      if (code) rowByCode.set(code, row);
    }
    for (const row of frSell) {
      const code = rowCode(row);
      if (code) foreignSell.set(code, mapJointRow(row));
    }
    for (const row of inSell) {
      const code = rowCode(row);
      if (code) instSell.set(code, mapJointRow(row));
      if (code) rowByCode.set(code, row);
    }
  }

  function buildJoint(buyMapA, buyMapB, isBuy) {
    const out = [];
    for (const [code, a] of buyMapA) {
      if (!buyMapB.has(code)) continue;
      const b = buyMapB.get(code);
      const raw = rowByCode.get(code);
      const mapped = mapJointRow(raw) || a || b;
      if (!mapped) continue;
      if (isBuy && (mapped.foreignM <= 0 || mapped.institutionM <= 0)) continue;
      if (!isBuy && (mapped.foreignM >= 0 || mapped.institutionM >= 0)) continue;
      out.push(mapped);
    }
    out.sort((x, y) =>
      isBuy ? y.totalM - x.totalM : Math.abs(y.totalM) - Math.abs(x.totalM)
    );
    return out.slice(0, 5);
  }

  const payload = {
    date: ymd,
    buy: buildJoint(foreignBuy, instBuy, true),
    sell: buildJoint(foreignSell, instSell, false),
    source: "FHPTJ04400000",
    cached: false,
  };
  cacheSet(cacheKey, payload, TTL["joint-trading"]);
  return payload;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
    return;
  }
  if (req.method !== "GET") {
    json(res, 405, { error: "Method not allowed" }, 0);
    return;
  }

  const action = sanitizeStr(req.query && req.query.action).toLowerCase();
  try {
    if (action === "mktfunds") {
      const data = await fetchMktfunds();
      json(res, 200, data, TTL.mktfunds / 1000);
      return;
    }
    if (action === "investor") {
      const market = sanitizeStr(req.query && req.query.market) || "KOSPI";
      const data = await fetchInvestorMarket(market);
      json(res, 200, data, TTL.investor / 1000);
      return;
    }
    if (action === "joint-trading") {
      const data = await fetchJointTrading();
      json(res, 200, data, TTL["joint-trading"] / 1000);
      return;
    }
    json(res, 400, { error: "Unknown action. Use mktfunds|investor|joint-trading" }, 0);
  } catch (e) {
    console.error("[dashboard-data]", action, e && e.message, e);
    json(res, e.statusCode || 500, { error: e.message || "Internal error" }, 0);
  }
};
