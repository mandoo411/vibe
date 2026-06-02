/**
 * KIS 종목 시세(시세1+시세2) 합쳐서 반환
 * GET /api/kis-stock-quote?code=005930
 */

const DEFAULT_KIS_BASE = "https://openapi.koreainvestment.com:9443";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNum(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeCode6(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 6) return digits;
  if (digits.length < 6) return digits.padStart(6, "0");
  return digits.slice(-6);
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
  return sanitizeStr(process.env.KIS_BASE_URL || DEFAULT_KIS_BASE).replace(/\/+$/, "");
}

async function kisGetJson(path, trId, params) {
  const { token, appkey, appsecret } = requireKisCreds();
  const url = new URL(path, kisBaseUrl());
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, v == null ? "" : String(v));
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey,
      appsecret,
      tr_id: trId,
    },
  });
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

function marketLabelFromRow(row) {
  const hint = sanitizeStr(
    (row && (row.mrkt_div_cls_code || row.MRKT_DIV_CLS_CODE || row.rprs_mrkt_kor_name || row.RPRS_MRKT_KOR_NAME)) ||
      ""
  );
  const blob = String(hint || "").toUpperCase();
  if (/KOSDAQ|KQ|KONEX/.test(blob) || /코스닥/.test(hint)) return "KOSDAQ";
  if (/KOSPI|KS|KRX/.test(blob) || /코스피|유가/.test(hint)) return "KOSPI";
  return hint || "";
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const code6 = normalizeCode6(url.searchParams.get("code") || "");
    if (!/^\d{6}$/.test(code6)) {
      return json(res, 400, { error: "code(6자리)가 필요합니다." });
    }

    const commonParams = {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code6,
    };

    const [p1, p2] = await Promise.all([
      kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", commonParams),
      kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-price-2", "FHPST01010000", commonParams),
    ]);

    const o1 = (p1 && p1.output) || {};
    const o2 = (p2 && p2.output) || {};

    const currentPrice = toNum(o1.stck_prpr);
    const changeAmt = toNum(o1.prdy_vrss);
    const changeRate = toNum(o1.prdy_ctrt);
    const volume = toNum(o1.acml_vol);
    const tradingValue = toNum(o1.acml_tr_pbmn) || (currentPrice != null && volume != null ? currentPrice * volume : null);
    const mcapRaw = sanitizeStr(o1.hts_avls || o1.stck_avls);

    const prevClose = toNum(o2.stck_prdy_clpr);
    const open = toNum(o2.stck_oprc) ?? toNum(o1.stck_oprc);
    const high = toNum(o2.stck_hgpr) ?? toNum(o1.stck_hgpr);
    const low = toNum(o2.stck_lwpr) ?? toNum(o1.stck_lwpr);
    const prevVolume = toNum(o2.prdy_vol);
    const warn = sanitizeStr(o2.mrkt_warn_cls_name);

    const per = toNum(o1.per);
    const pbr = toNum(o1.pbr);
    const eps = toNum(o1.eps);
    const bps = toNum(o1.bps);

    return json(res, 200, {
      stockCode: code6,
      stockName: sanitizeStr(o1.hts_kor_isnm || o1.prdt_abrv_name || o1.isnm || o2.hts_kor_isnm || ""),
      market: marketLabelFromRow(o1) || marketLabelFromRow(o2),
      currentPrice: currentPrice == null ? null : Math.round(currentPrice),
      changeAmt: changeAmt == null ? null : Math.round(changeAmt),
      changeRate: changeRate == null ? null : Math.round(changeRate * 100) / 100,
      volume: volume == null ? null : Math.round(volume),
      tradingValue: tradingValue == null ? null : Math.round(tradingValue),
      marketCapRaw: mcapRaw || "",
      prevClose: prevClose == null ? null : Math.round(prevClose),
      open: open == null ? null : Math.round(open),
      high: high == null ? null : Math.round(high),
      low: low == null ? null : Math.round(low),
      prevVolume: prevVolume == null ? null : Math.round(prevVolume),
      warn: warn || "",
      financials: {
        per,
        pbr,
        eps,
        bps,
      },
      raw1: o1,
      raw2: o2,
    });
  } catch (e) {
    const status = (e && e.statusCode) || 500;
    return json(res, status, { error: e && e.message ? e.message : String(e) });
  }
};

