/**
 * 장마감 리포트용 KIS 추가 데이터 (수급·업종·거래량)
 */

export const SECTOR_MAP = {
  삼성전자: "반도체",
  SK하이닉스: "반도체",
  삼성전자우: "반도체",
  SK스퀘어: "반도체",
  한미반도체: "반도체",
  주성엔지니어링: "반도체장비",
  한성크린텍: "반도체장비",
  현대차: "자동차",
  기아: "자동차",
  현대모비스: "자동차",
  LG전자: "가전·IT",
  LG디스플레이: "디스플레이",
  LG화학: "2차전지",
  LG에너지솔루션: "2차전지",
  삼성SDI: "2차전지",
  포스코퓨처엠: "2차전지",
  에코프로: "2차전지",
  에코프로비엠: "2차전지",
  POSCO홀딩스: "철강",
  현대제철: "철강",
  KB금융: "금융",
  신한지주: "금융",
  하나금융지주: "금융",
  삼성증권: "증권",
  미래에셋증권: "증권",
  한화에어로스페이스: "방산",
  LIG넥스원: "방산",
  한국항공우주: "방산",
  HD현대중공업: "조선",
  삼성중공업: "조선",
  한화오션: "조선",
  셀트리온: "바이오",
  삼성바이오로직스: "바이오",
  SK바이오팜: "바이오",
  유한양행: "바이오",
  NAVER: "플랫폼",
  카카오: "플랫폼",
  크래프톤: "게임",
  엔씨소프트: "게임",
  현대건설: "건설",
  삼성물산: "건설",
  SK텔레콤: "통신",
  KT: "통신",
  LG유플러스: "통신",
};

const SECTOR_INDEX_CODES = [
  { code: "0001", name: "코스피" },
  { code: "1001", name: "코스닥" },
  { code: "1012", name: "반도체" },
  { code: "1013", name: "자동차" },
  { code: "1014", name: "화학" },
  { code: "1015", name: "철강" },
  { code: "1016", name: "기계" },
  { code: "1017", name: "건설" },
  { code: "1018", name: "유통" },
  { code: "1019", name: "금융" },
  { code: "1020", name: "증권" },
  { code: "1021", name: "보험" },
  { code: "1022", name: "운송" },
  { code: "1023", name: "통신" },
  { code: "1024", name: "전기전자" },
  { code: "1025", name: "의료정밀" },
  { code: "1026", name: "음식료" },
  { code: "1027", name: "섬유의복" },
  { code: "1028", name: "종이목재" },
  { code: "1029", name: "부동산" },
  { code: "1030", name: "오락문화" },
  { code: "1031", name: "서비스" },
];

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNumberOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/,/g, "").replace(/%/g, "").replace(/^\+/, ""));
  return Number.isFinite(n) ? n : null;
}

function kisRowPctChange(row) {
  if (!row || typeof row !== "object") return null;
  for (const k of ["prdy_ctrt", "PRDY_CTRT", "bstp_nmix_prdy_ctrt", "BSTP_NMIX_PRDY_CTRT", "prdy_ctrt_val"]) {
    const n = toNumberOrNull(row[k]);
    if (n != null) return n;
  }
  return null;
}

function pickAmtEok(row, keys) {
  for (const k of keys) {
    const n = toNumberOrNull(row[k]);
    if (n != null) return Math.round(n / 1e8);
  }
  return null;
}

async function kisGet(url, trId, token, appKey, appSecret) {
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: trId,
      custtype: "P",
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`KIS invalid JSON (${trId}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`KIS HTTP ${res.status} (${trId})`);
  if (json.rt_cd && json.rt_cd !== "0") {
    throw new Error(`KIS rt_cd=${json.rt_cd} (${trId}) ${json.msg1 || ""}`);
  }
  return json;
}

/** 시장별 투자자 순매수 (억원) — FHPTJ04040000 */
export async function fetchInvestorFlowByMarket({ baseUrl, token, appKey, appSecret, ymd, marketCode, marketLabel }) {
  const url = new URL(`${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", "0001");
  url.searchParams.set("FID_INPUT_DATE_1", ymd.replace(/-/g, ""));
  url.searchParams.set("FID_INPUT_DATE_2", ymd.replace(/-/g, ""));
  url.searchParams.set("FID_INPUT_ISCD_1", marketCode);
  url.searchParams.set("FID_INPUT_ISCD_2", "");

  const json = await kisGet(url, "FHPTJ04040000", token, appKey, appSecret);
  const row = Array.isArray(json.output) ? json.output[0] : json.output;
  if (!row) return { market: marketLabel, foreign: null, institution: null, retail: null };

  return {
    market: marketLabel,
    foreign: pickAmtEok(row, ["frgn_ntby_tr_pbmn", "frgn_ntby_amt", "frgn_ntby_tr_pbmn_amt"]),
    institution: pickAmtEok(row, ["orgn_ntby_tr_pbmn", "orgn_ntby_amt", "orgn_ntby_tr_pbmn_amt"]),
    retail: pickAmtEok(row, ["prsn_ntby_tr_pbmn", "prsn_ntby_amt", "prsn_ntby_tr_pbmn_amt"]),
  };
}

export async function fetchSupplyBothMarkets(ctx, ymd) {
  const settled = await Promise.allSettled([
    fetchInvestorFlowByMarket({ ...ctx, ymd, marketCode: "KSP", marketLabel: "코스피" }),
    fetchInvestorFlowByMarket({ ...ctx, ymd, marketCode: "KSQ", marketLabel: "코스닥" }),
  ]);
  return settled
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value)
    .filter(Boolean);
}

/** 업종별 등락률 — FHPUP02100000 */
export async function fetchSectorMoves({ baseUrl, token, appKey, appSecret }) {
  const rows = [];
  for (const sector of SECTOR_INDEX_CODES) {
    try {
      const url = new URL(`${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-index-price`);
      url.searchParams.set("FID_COND_MRKT_DIV_CODE", "U");
      url.searchParams.set("FID_INPUT_ISCD", sector.code);
      const json = await kisGet(url, "FHPUP02100000", token, appKey, appSecret);
      const out = json.output;
      const row = Array.isArray(out) ? out[0] : out;
      const change = kisRowPctChange(row);
      const name = sanitizeStr(row?.hts_kor_isnm) || sector.name;
      if (change != null) rows.push({ name, changePct: change });
    } catch {
      /* skip failed sector */
    }
  }
  return rows.filter((r) => r.name && r.changePct != null);
}

/** 거래량 상위 — FHPST01710000 */
export async function fetchVolumeRanking({ baseUrl, token, appKey, appSecret, marketCode, marketLabel, limit = 20 }) {
  const url = new URL(`${baseUrl}/uapi/domestic-stock/v1/quotations/volume-rank`);
  const params = {
    fid_cond_mrkt_div_code: "J",
    fid_cond_scr_div_code: "20171",
    fid_input_iscd: marketCode,
    fid_div_cls_code: "0",
    fid_blng_cls_code: "0",
    fid_trgt_cls_code: "111111111",
    fid_trgt_exls_cls_code: "0000000000",
    fid_input_price_1: "",
    fid_input_price_2: "",
    fid_vol_cnt: String(limit),
    fid_input_date_1: "",
  };
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const json = await kisGet(url, "FHPST01710000", token, appKey, appSecret);
  const list = Array.isArray(json.output) ? json.output : [];
  return list
    .map((row) => ({
      code: sanitizeStr(row.stck_shrn_iscd),
      name: sanitizeStr(row.hts_kor_isnm),
      market: marketLabel,
      currentPrice: sanitizeStr(row.stck_prpr),
      change: kisRowPctChange(row),
      volume: sanitizeStr(row.acml_vol),
    }))
    .filter((r) => r.code && r.name);
}

export function lookupSector(name) {
  const key = sanitizeStr(name);
  if (SECTOR_MAP[key]) return SECTOR_MAP[key];
  const loose = key.replace(/\s+/g, "");
  for (const [k, v] of Object.entries(SECTOR_MAP)) {
    if (k.replace(/\s+/g, "") === loose) return v;
  }
  return "기타";
}

export async function fetchVolumeTopMerged(ctx, limit = 20) {
  const settled = await Promise.allSettled([
    fetchVolumeRanking({ ...ctx, marketCode: "0001", marketLabel: "KOSPI", limit: 30 }),
    fetchVolumeRanking({ ...ctx, marketCode: "1001", marketLabel: "KOSDAQ", limit: 30 }),
  ]);
  const merged = new Map();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const row of result.value) {
      if (!merged.has(row.code)) merged.set(row.code, row);
    }
  }
  return [...merged.values()]
    .sort((a, b) => (toNumberOrNull(b.volume) ?? 0) - (toNumberOrNull(a.volume) ?? 0))
    .slice(0, limit)
    .map((row) => ({
      ...row,
      sector: lookupSector(row.name),
    }));
}

export function buildIssueStockCandidates(topGainers, limit = 5) {
  const rows = Array.isArray(topGainers) ? [...topGainers] : [];
  rows.sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0));
  return rows.slice(0, limit).map((r) => ({
    name: r.name,
    code: r.code,
    change: r.change,
    currentPrice: r.currentPrice,
    market: r.market,
  }));
}
