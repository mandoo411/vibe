/**
 * KIS(한국투자증권) 국내주식 현재가 조회 — 글로벌 랭킹(world-market) 페이지에서
 * 삼성전자·SK하이닉스 등 국내 상장 종목의 가격/시가총액을 라이브로 덮어쓰기 위한 헬퍼.
 *
 * api/kis-stock-quote.js, api/kis-realtime-data.js와 동일한 크레덴셜
 * (KIS_ACCESS_TOKEN / KIS_APP_KEY / KIS_APP_SECRET, 매일 refresh-kis-token 워크플로우가 갱신)을 사용한다.
 *
 * 시가총액 단위 주의:
 * KIS 시세 순위 TR(FHPST01740000)의 stck_avls는 자릿수에 따라 억원/백만원이 섞여 내려와
 * api/kis-realtime-data.js에 자릿수 추정 로직(mcapAvlsRawToWonString)이 따로 있다.
 * 반면 여기서 쓰는 국내주식 현재가 시세 TR(FHKST01010100)의 hts_avls는 KIS 공식 문서상
 * 항상 "억원" 고정 단위이므로 자릿수 추정 없이 1억을 곱하기만 하면 된다.
 * (주의: 시총이 매우 큰 종목—현재 삼성전자 등—에서는 그 자릿수 추정 로직을 그대로 쓰면
 *  억원/백만원 판별 임계값을 넘어서 100배 오차가 날 수 있어 일부러 재사용하지 않았다.)
 */

const DEFAULT_KIS_BASE = "https://openapi.koreainvestment.com:9443";

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNum(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function kisBaseUrl() {
  return sanitizeStr(process.env.KIS_BASE_URL || DEFAULT_KIS_BASE).replace(/\/+$/, "");
}

function hasKisCreds() {
  return Boolean(
    sanitizeStr(process.env.KIS_ACCESS_TOKEN) &&
      sanitizeStr(process.env.KIS_APP_KEY) &&
      sanitizeStr(process.env.KIS_APP_SECRET)
  );
}

function marketCapWonFromHtsAvls(raw) {
  const n = toNum(raw);
  if (n == null || n <= 0) return null;
  return Math.round(n * 1e8);
}

/**
 * 6자리 종목코드(예: "005930")로 KIS 국내주식 현재가를 조회.
 * 크리덴셜이 없거나 호출이 실패하면 null을 반환한다 — 호출부는 기존 캐시/폴백 값을 그대로 써야 한다.
 */
async function fetchKisDomesticQuote(code6) {
  const code = sanitizeStr(code6).toUpperCase();
  if (!/^[0-9A-Z]{6}$/.test(code) || !hasKisCreds()) return null;

  const token = sanitizeStr(process.env.KIS_ACCESS_TOKEN);
  const appkey = sanitizeStr(process.env.KIS_APP_KEY);
  const appsecret = sanitizeStr(process.env.KIS_APP_SECRET);
  const url = new URL("/uapi/domestic-stock/v1/quotations/inquire-price", kisBaseUrl());
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", code);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(process.env.FMP_TIMEOUT_MS) || 10000));
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey,
        appsecret,
        tr_id: "FHKST01010100",
      },
    });
    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return null;
    }
    if (!res.ok || (j && j.rt_cd && j.rt_cd !== "0")) return null;
    const o = (j && j.output) || {};
    const priceKrw = toNum(o.stck_prpr);
    const marketCapWon = marketCapWonFromHtsAvls(o.hts_avls ?? o.stck_avls);
    const changePct = toNum(o.prdy_ctrt);
    if (priceKrw == null && marketCapWon == null) return null;
    return { priceKrw, marketCapWon, changePct };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchKisDomesticQuote };
