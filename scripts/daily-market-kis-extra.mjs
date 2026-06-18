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
    if (n == null) continue;
    if (/tr_pbmn|pbmn|amt/i.test(k)) {
      if (Math.abs(n) >= 1000) return Math.round(n / 100);
      return Math.round(n);
    }
    return Math.round(n / 1e8);
  }
  return null;
}

function seoulYmdFromDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
}

function prevYmdStr(ymd) {
  const t = new Date(`${ymd}T12:00:00+09:00`).getTime() - 86400000;
  return seoulYmdFromDate(new Date(t));
}

function isBeforeKstMarketClose() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h < 15 || (h === 15 && m < 30);
}

function parseInvestorFlowRow(row, marketLabel) {
  if (!row) return { market: marketLabel, foreign: null, institution: null, retail: null };
  return {
    market: marketLabel,
    foreign: pickAmtEok(row, ["frgn_ntby_tr_pbmn", "frgn_ntby_amt", "frgn_ntby_tr_pbmn_amt"]),
    institution: pickAmtEok(row, ["orgn_ntby_tr_pbmn", "orgn_ntby_amt", "orgn_ntby_tr_pbmn_amt"]),
    retail: pickAmtEok(row, ["prsn_ntby_tr_pbmn", "prsn_ntby_amt", "prsn_ntby_tr_pbmn_amt"]),
  };
}

function hasInvestorAmounts(result) {
  return [result.foreign, result.institution, result.retail].some((v) => v != null);
}

async function requestInvestorFlowDay({ baseUrl, token, appKey, appSecret, ymd, marketCode, marketLabel }) {
  const ymdCompact = String(ymd).replace(/-/g, "");
  const url = new URL(`${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", marketCode);
  url.searchParams.set("FID_INPUT_DATE_1", ymdCompact);
  url.searchParams.set("FID_INPUT_DATE_2", ymdCompact);
  url.searchParams.set("FID_INPUT_ISCD_2", "");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: "FHPTJ04040000",
      custtype: "P",
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error("[수급API] 실패:", marketLabel, res.status, "invalid JSON");
    throw new Error(`KIS invalid JSON (FHPTJ04040000)`);
  }
  if (!res.ok || (json.rt_cd && json.rt_cd !== "0")) {
    console.error("[수급API] 실패:", marketLabel, res.status, json?.msg1 || json?.msg_cd || "");
    throw new Error(`KIS rt_cd=${json.rt_cd} (${marketLabel}) ${json.msg1 || ""}`);
  }
  const row = Array.isArray(json.output) ? json.output[0] : json.output;
  return parseInvestorFlowRow(row, marketLabel);
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
  const dates = [ymd];
  if (isBeforeKstMarketClose()) dates.push(prevYmdStr(ymd));

  let lastErr;
  for (let i = 0; i < dates.length; i++) {
    try {
      const result = await requestInvestorFlowDay({
        baseUrl,
        token,
        appKey,
        appSecret,
        ymd: dates[i],
        marketCode,
        marketLabel,
      });
      if (hasInvestorAmounts(result)) {
        if (i > 0) {
          console.log(`[수급API] ${marketLabel}: ${dates[i]} 일자 폴백 사용`);
        }
        return result;
      }
      if (i < dates.length - 1) continue;
      return result;
    } catch (e) {
      lastErr = e;
      if (i < dates.length - 1) continue;
    }
  }
  throw lastErr || new Error(`[수급API] ${marketLabel} 데이터 없음`);
}

export async function fetchSupplyBothMarkets(ctx, ymd) {
  const settled = await Promise.allSettled([
    fetchInvestorFlowByMarket({ ...ctx, ymd, marketCode: "0001", marketLabel: "코스피" }),
    fetchInvestorFlowByMarket({ ...ctx, ymd, marketCode: "1001", marketLabel: "코스닥" }),
  ]);
  for (const r of settled) {
    if (r.status === "rejected") {
      console.error("[수급API] rejected:", r.reason?.message || r.reason);
    }
  }
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
