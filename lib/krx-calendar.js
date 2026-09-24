/**
 * 한국거래소(KRX) 휴장일 달력 — 2026-09-24 신설. 사이트 전체의 "오늘 장이 열렸나"는 여기서만 판단한다.
 *
 * 왜 만들었나: 2026-09-24(추석 연휴 첫날)에
 *  - 시세 동기화가 "9/24" 항목을 만들었는데 내용은 9/23 순위 복사본이었고,
 *  - 점검봇이 그걸 보고 "거래일인데 마감시황 미발행"이라고 알림을 보냈고,
 *  - 종가시그널 성과 추적이 KIS에서 9/23 시세를 받아 "9/24 결과"로 저장했다(매수가=익일종가 → 0.00%).
 *  각 스크립트가 "주말만 거르기" 또는 "등락률이 0이 아니면 거래일" 같은 추측을 따로 하고 있어서였다.
 *
 * ⚠️ 매년 12월에 다음 해 휴장일을 추가할 것. 한국거래소가 12월 중순에 이듬해 휴장일을 공지한다.
 *    점검봇(scripts/health-check.mjs)이 11월 1일부터 "내년 달력 없음"을 알려준다.
 *    임시공휴일(선거일·정부 지정)이 새로 생기면 그때그때 추가한다.
 *
 * 2026: 한국거래소 공지 기준 17일 (확인: 2026-09-24, jangjeon.kr 휴장일 표 · 2026-05-20 지방선거·제헌절 휴장 보도)
 * 2027: 공휴일 법 기준으로 계산한 **잠정치** — 거래소 공지가 나오면 반드시 대조할 것.
 */

const HOLIDAYS = {
  // 2026 (확정)
  "2026-01-01": "신정",
  "2026-02-16": "설날 연휴",
  "2026-02-17": "설날",
  "2026-02-18": "설날 연휴",
  "2026-03-02": "삼일절 대체공휴일",
  "2026-05-01": "근로자의 날",
  "2026-05-05": "어린이날",
  "2026-05-25": "부처님오신날 대체공휴일",
  "2026-06-03": "전국동시지방선거",
  "2026-07-17": "제헌절",
  "2026-08-17": "광복절 대체공휴일",
  "2026-09-24": "추석 연휴",
  "2026-09-25": "추석",
  "2026-10-05": "개천절 대체공휴일",
  "2026-10-09": "한글날",
  "2026-12-25": "성탄절",
  "2026-12-31": "연말 휴장",
  // 2027 (잠정 — 거래소 공지 후 대조 필요)
  "2027-01-01": "신정",
  "2027-02-08": "설날 연휴",
  "2027-02-09": "설날 대체공휴일",
  "2027-03-01": "삼일절",
  "2027-05-05": "어린이날",
  "2027-05-13": "부처님오신날",
  "2027-07-19": "제헌절 대체공휴일",
  "2027-08-16": "광복절 대체공휴일",
  "2027-09-14": "추석 연휴",
  "2027-09-15": "추석",
  "2027-09-16": "추석 연휴",
  "2027-10-04": "개천절 대체공휴일",
  "2027-10-11": "한글날 대체공휴일",
  "2027-12-27": "성탄절 대체공휴일",
  "2027-12-31": "연말 휴장",
};

/** 달력이 확정·잠정으로 커버하는 마지막 해 */
const COVERED_UNTIL_YEAR = 2027;
const CONFIRMED_UNTIL_YEAR = 2026;

function seoulYmd(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(date);
}

function dow(ymd) {
  // 정오 UTC로 만들어 시간대 경계 문제를 피한다
  return new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0=일 6=토
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 휴장 사유. 거래일이면 null */
function closedReason(ymd = seoulYmd()) {
  const w = dow(ymd);
  if (w === 0 || w === 6) return "주말";
  return HOLIDAYS[ymd] || null;
}

function isTradingDay(ymd = seoulYmd()) {
  return closedReason(ymd) === null;
}

function nextTradingDay(ymd = seoulYmd()) {
  let d = addDays(ymd, 1);
  for (let i = 0; i < 30 && !isTradingDay(d); i++) d = addDays(d, 1);
  return d;
}

function prevTradingDay(ymd = seoulYmd()) {
  let d = addDays(ymd, -1);
  for (let i = 0; i < 30 && !isTradingDay(d); i++) d = addDays(d, -1);
  return d;
}

/** 오늘 이후 가장 가까운 거래일(오늘이 거래일이면 오늘) */
function thisOrNextTradingDay(ymd = seoulYmd()) {
  return isTradingDay(ymd) ? ymd : nextTradingDay(ymd);
}

/** "9/28(월)" 같은 짧은 표기 */
function shortLabel(ymd) {
  const [, m, d] = ymd.split("-").map(Number);
  return `${m}/${d}(${"일월화수목금토"[dow(ymd)]})`;
}

/** 달력 유지보수 경고 — 연말이 가까운데 내년이 없거나, 올해가 잠정치면 문구를 돌려준다 */
function calendarWarning(ymd = seoulYmd()) {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  if (y > COVERED_UNTIL_YEAR || (y === COVERED_UNTIL_YEAR && m >= 11)) {
    return `KRX 휴장일 달력(lib/krx-calendar.js)에 ${y + (m >= 11 ? 1 : 0)}년이 없습니다 — 거래소 공지를 보고 추가해야 합니다.`;
  }
  if (y > CONFIRMED_UNTIL_YEAR && m === 1) {
    return `KRX 휴장일 달력의 ${y}년은 잠정치입니다 — 거래소 공지와 대조해 확정해 주세요.`;
  }
  return null;
}

module.exports = {
  HOLIDAYS,
  COVERED_UNTIL_YEAR,
  seoulYmd,
  closedReason,
  isTradingDay,
  nextTradingDay,
  prevTradingDay,
  thisOrNextTradingDay,
  shortLabel,
  calendarWarning,
};
