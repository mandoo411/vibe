/**
 * 장마감 후 당일 상승률 TOP50을 수집해 data/prev-top50.json 으로 저장 (GitHub Actions용).
 * 한투 fluctuation FHPST01700000 — api/kis-realtime-data.js 의 fetchGainersMerged50 과 동일 로직.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "prev-top50.json");

const DEFAULT_BASE = "https://openapi.koreainvestment.com:9443";
const KIS_GAP_MS = Math.max(0, Number(process.env.KIS_API_GAP_MS) || 700);
const FLUCTUATION_RANK_MAX_PAGES = Math.max(
  1,
  Math.min(30, Number(process.env.KIS_FLUCTUATION_MAX_PAGES) || 12)
);

function baseUrl() {
  return (process.env.KIS_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNum(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function kisOutputRows(json) {
  if (!json || typeof json !== "object") return [];
  for (const key of ["output", "output1", "output2", "OUTPUT", "Output"]) {
    const v = json[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

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

function pickAcmlVol(row) {
  if (!row || typeof row !== "object") return "";
  const keys = ["acml_vol", "ACML_VOL", "prdy_acml_vol", "tot_acml_vol", "hts_acml_vol", "acmlVol"];
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

function approxPbmnFromPriceVol(priceStr, volStr) {
  const p = Number(String(priceStr || "").replace(/,/g, ""));
  const v = Number(String(volStr || "").replace(/,/g, ""));
  if (!Number.isFinite(p) || !Number.isFinite(v) || p <= 0 || v <= 0) return "";
  const x = p * v;
  if (!Number.isFinite(x) || x <= 0 || x > Number.MAX_SAFE_INTEGER) return "";
  return String(Math.round(x));
}

function boardKindFromClsCode(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return null;
  if (/(KOSDAQ|KONEX|KTQ)/.test(s)) return "KOSDAQ";
  if (/KOSPI/.test(s)) return "KOSPI";
  if (/^Q$|^KQ$|^02$|^2$/.test(s)) return "KOSDAQ";
  if (/^Y$|^K$|^KS$|^01$|^1$/.test(s)) return "KOSPI";
  return null;
}

function pickKoreanBoardKind(row, fallbackLabel) {
  const fb = String(fallbackLabel || "").toUpperCase() === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
  if (!row || typeof row !== "object") return fb;
  const direct = sanitizeStr(
    row.bstp_cls_code || row.BSTP_CLS_CODE || row.mrkt_cls_code || row.MRKT_CLS_CODE
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

async function fetchFluctuationRank(marketCode, marketLabel, token, appkey, appsecret) {
  const urlBase = new URL("/uapi/domestic-stock/v1/ranking/fluctuation", baseUrl());
  const buildParams = (fidPrcCls) => ({
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

  async function fetchFluctuationRawRowsPaged(fidPrcCls) {
    const acc = [];
    let trCont = "";
    for (let page = 0; page < FLUCTUATION_RANK_MAX_PAGES; page++) {
      const url = new URL(urlBase.toString());
      for (const [k, v] of Object.entries(buildParams(fidPrcCls))) url.searchParams.set(k, v);
      await sleep(KIS_GAP_MS);
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
          appkey,
          appsecret: appsecret,
          tr_id: "FHPST01700000",
          custtype: "P",
          tr_cont: trCont,
        },
      });
      const text = await res.text();
      const json = JSON.parse(text);
      if (json.rt_cd && json.rt_cd !== "0") {
        throw new Error(`fluctuation ${marketLabel} rt_cd=${json.rt_cd} msg=${json.msg1 || json.msg_cd || ""}`);
      }
      const part = kisOutputRows(json);
      if (!part.length) break;
      acc.push(...part);
      const cont = String(readTrContHeader(res, json) || "").trim().toUpperCase();
      if (cont !== "M") break;
      trCont = "N";
    }
    return acc;
  }

  const mapRawList = (list) =>
    list
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

  const rawPrimary = await fetchFluctuationRawRowsPaged("1");
  const byCode = new Map();
  for (const r of mapRawList(rawPrimary)) {
    if (!byCode.has(r.code)) byCode.set(r.code, r);
  }
  let rows = [...byCode.values()];

  if (rows.length && rows.some((r) => !r.tradingValue)) {
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
  return rows;
}

function ymdKst(d = new Date()) {
  const s = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return s.replace(/-/g, "");
}

async function fetchGainersMerged50(token, appkey, appsecret) {
  const kospi = await fetchFluctuationRank("0001", "KOSPI", token, appkey, appsecret);
  const kosdaq = await fetchFluctuationRank("1001", "KOSDAQ", token, appkey, appsecret);
  const merged = new Map();
  for (const r of [...kospi, ...kosdaq]) {
    if (!merged.has(r.code)) merged.set(r.code, r);
  }
  const all = [...merged.values()].filter((r) => r.changePct != null);
  all.sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
  return all.slice(0, 50).map((r, i) => ({ ...r, rank: i + 1 }));
}

async function main() {
  const token = (process.env.KIS_ACCESS_TOKEN || "").trim();
  const appkey = (process.env.KIS_APP_KEY || "").trim();
  const appsecret = (process.env.KIS_APP_SECRET || "").trim();
  if (!token || !appkey || !appsecret) {
    console.error("Missing KIS_ACCESS_TOKEN, KIS_APP_KEY, or KIS_APP_SECRET");
    process.exit(1);
  }
  const rows = await fetchGainersMerged50(token, appkey, appsecret);
  const sessionYmd = ymdKst(new Date());
  const savedAt = new Date().toISOString();
  const stocks = rows.map((r) => ({
    rank: r.rank,
    code: r.code,
    name: r.name,
    market: r.market,
    tvBoard: r.tvBoard,
    prevDayChangePct: r.changePct != null && Number.isFinite(r.changePct) ? r.changePct : null,
  }));
  const payload = {
    savedAt,
    sessionYmd,
    source: "GitHub Actions — fluctuation FHPST01700000 (코스피·코스닥 통합 상승률 TOP50)",
    stocks,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUT} sessionYmd=${sessionYmd} count=${stocks.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
