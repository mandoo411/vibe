/** KST / ET 기준 장 개장 여부 — 시장지표·티커 라이브 표시 */

function tzParts(timeZone, date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: dayMap[parts.weekday] ?? 0,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function minsSinceMidnight(hour, minute) {
  return hour * 60 + minute;
}

function isWeekday(dow) {
  return dow >= 1 && dow <= 5;
}

/** KRX 정규장 09:00–15:30 KST */
function isKoreaEquitySessionOpen(now = new Date()) {
  const { dow, hour, minute } = tzParts("Asia/Seoul", now);
  if (!isWeekday(dow)) return false;
  const m = minsSinceMidnight(hour, minute);
  return m >= 9 * 60 && m < 15 * 60 + 30;
}

/** 미국 주식 정규·프리·애프터 (ET) */
function isUsEquitySessionOpen(now = new Date()) {
  const { dow, hour, minute } = tzParts("America/New_York", now);
  if (!isWeekday(dow)) return false;
  const m = minsSinceMidnight(hour, minute);
  return m >= 4 * 60 && m < 20 * 60;
}

/** 외환 — 월~금 (주말 휴장, 단순화) */
function isForexSessionOpen(now = new Date()) {
  const { dow } = tzParts("America/New_York", now);
  return isWeekday(dow);
}

function yahooStateIsLive(state) {
  const s = String(state || "").toUpperCase();
  if (!s) return false;
  return s === "REGULAR" || s === "PRE" || s === "POST" || s === "PREPRE" || s === "POSTPOST";
}

const ALWAYS_LIVE_IDS = new Set(["btc", "eth", "bitcoin", "ethereum"]);
const NEVER_LIVE_IDS = new Set(["fear-greed", "btc-dominance"]);

/**
 * @param {string} id
 * @param {{ marketState?: string|null, session?: string }} opts
 */
function resolveIndicatorLive(id, opts = {}) {
  const key = String(id || "").toLowerCase();
  if (NEVER_LIVE_IDS.has(key)) return false;
  if (ALWAYS_LIVE_IDS.has(key)) return true;

  const session = opts.session || inferSession(key);
  const now = opts.now || new Date();

  if (session === "korea") return isKoreaEquitySessionOpen(now);
  if (session === "us") return isUsEquitySessionOpen(now) || yahooStateIsLive(opts.marketState);
  if (session === "forex") return isForexSessionOpen(now);
  if (session === "crypto") return true;
  if (session === "futures") return yahooStateIsLive(opts.marketState) || isUsEquitySessionOpen(now);
  if (session === "asia" || session === "europe") {
    if (opts.marketState) return yahooStateIsLive(opts.marketState);
    return false;
  }

  if (opts.marketState) return yahooStateIsLive(opts.marketState);
  return false;
}

function inferSession(id) {
  if (id === "kospi" || id === "kosdaq" || id === "kospi200") return "korea";
  if (id === "ewy") return "us";
  if (id === "usdkrw" || id === "dxy") return "forex";
  if (
    id === "nasdaq-futures" ||
    id === "wti" ||
    id === "brent" ||
    id === "natgas" ||
    id === "gold" ||
    id === "silver" ||
    id === "platinum" ||
    id === "copper" ||
    id === "wheat" ||
    id === "corn" ||
    id === "soy" ||
    id === "us10y" ||
    id === "us2y"
  ) {
    return "futures";
  }
  if (id === "vix" || id === "sp500" || id === "nasdaq" || id === "dow") return "us";
  if (id === "n225" || id === "hsi" || id === "sse" || id === "twii") return "asia";
  if (id === "dax" || id === "ftse" || id === "cac" || id === "stoxx50") return "europe";
  return "us";
}

module.exports = {
  isKoreaEquitySessionOpen,
  isUsEquitySessionOpen,
  isForexSessionOpen,
  yahooStateIsLive,
  resolveIndicatorLive,
  inferSession,
};
