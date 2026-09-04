/**
 * TotalMoney AI — "핵심 지표(Key Indicator)" 판정 공용 모듈
 * ---------------------------------------------------------------------------
 * 왜 필요한가
 *   경제일정 데이터 소스(ForexFactory/Investing 계열)는 애초에 high-impact 항목만
 *   긁어오기 때문에 **모든 행의 impact가 "high"** 다(2026-09-04 기준 408건 전부).
 *   그래서 `impact === "high"` 로 거르면 사실상 아무것도 안 걸러지고,
 *   텔레그램 "주요 지표" 알림에 원유재고·모기지금리·연준 위원 개별 연설까지 섞여 나갔다.
 *   → 지표의 성격으로 직접 판정한다. 이 파일이 그 단일 기준점이다.
 *
 * 어디에 쓰이나 (2026-09-04 운영자 결정)
 *   ✅ 텔레그램 알림 (scripts/telegram-*.mjs)
 *   ✅ 웹 상단 강조 — "다음 핵심 지표", "이번 달 핵심 지표", 달력 강조점
 *   ❌ 웹 전체 일정표는 그대로 전부 노출한다 (정보량 유지)
 *
 * 포함 기준 — "뉴스에 나오고 실제로 시장을 움직이는 매크로 이벤트"
 *   미국: FOMC(금리·의사록·점도표·기자회견·잭슨홀), 연준 의장/부의장 발언,
 *         CPI, PCE, PPI, 고용보고서(NFP·실업률·시간당임금), GDP,
 *         ISM 제조업/서비스, 소매판매, 주간 신규실업수당, EIA 원유재고
 *   한국: 전반 — 금통위, CPI, 수출, GDP, 실업률, 소비자심리, 기업경기, PMI,
 *         한은 총재 발언, 코스피200 만기일
 *
 * 제외 기준 — 지금 노이즈로 판단한 것
 *   연준 개별 위원 연설(Barkin·Waller·Barr·Williams…), 지역 연은 지수(Empire State·
 *   Philly·Dallas·Chicago Fed), 주택지표(착공·허가·매매·NAHB·Case-Shiller),
 *   무역·재고(무역수지·수출입·기업재고·도매재고·TIC), 내구재, 공장주문,
 *   고용비용지수·생산성, 재정수지, 수출입물가, API 원유재고, 휘발유 재고,
 *   MBA 모기지금리, ADP, JOLTs, 소비자신뢰·미시간 소비자심리
 *
 * 기준을 바꾸고 싶으면
 *   아래 KEY_RULES(포함)와 EXCLUDE_RULES(제외)만 고치면 웹·텔레그램에 동시 반영된다.
 *   EXCLUDE가 KEY보다 먼저 적용된다.
 * ---------------------------------------------------------------------------
 * 브라우저: <script src="./assets/key-indicators.js"></script> → window.TM_KEY
 * Node    : createRequire 로 require("../assets/key-indicators.js")
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TM_KEY = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function normalizeCountry(country) {
    const c = String(country || "").trim();
    if (!c) return "";
    const u = c.toUpperCase();
    if (/^(US|USA|U\.S\.|UNITED STATES)$/.test(u) || c === "미국") return "US";
    if (/^(KR|KOREA|SOUTH KOREA|ROK)$/.test(u) || c === "한국" || c === "대한민국") return "KR";
    return u.length === 2 ? u : c;
  }

  /* ── 먼저 걸러내는 것들 (KEY_RULES보다 우선) ───────────────────────────── */
  const EXCLUDE_RULES = [
    // 연준 "개별 위원" 연설 — 의장/부의장은 아래 KEY_RULES에서 되살린다
    /\bFed\s+(?!Chair|Vice)[A-Z][a-z]+\s+(Speech|Testimony)/,
    /(연준|Fed)\s*(위원|이사)\s*연설/,
    // 지역 연은 체감지수
    /(Empire\s*State|Philadelphia\s*Fed|Philly\s*Fed|Dallas\s*Fed|Richmond\s*Fed|Kansas\s*City\s*Fed|Chicago\s*Fed|Chicago\s*PMI)/i,
    // 주택
    /(Housing\s*Starts|Building\s*Permits|Home\s*Sales|NAHB|Case[-\s]?Shiller|주택착공|건축\s*허가|주택\s*판매|주택가격)/i,
    // 무역·재고·자금흐름
    /(Balance\s*of\s*Trade|Goods\s*Trade|Current\s*Account|Wholesale\s*Inventories|Business\s*Inventories|Retail\s*Inventories|TIC\s*Flows|무역수지|경상수지|재고)/i,
    /(Export\s*Prices|Import\s*Prices|수출물가|수입물가)/i,
    // 생산·주문·비용
    /(Durable\s*Goods|Factory\s*Orders|Industrial\s*Production|Capacity\s*Utilization|내구재|공장\s*주문|산업생산)/i,
    /(Employment\s*Cost|Unit\s*Labour\s*Costs|Unit\s*Labor\s*Costs|Nonfarm\s*Productivity|노동비용|생산성)/i,
    /(Monthly\s*Budget|Corporate\s*Profits|재정수지)/i,
    // 주간 노이즈 (신규 실업수당·EIA 원유재고는 KEY_RULES에서 되살린다)
    /(MBA\s*(30|15)?[-\s]*Year|MBA\s*Mortgage|모기지)/i,
    /(API\s*Crude|Gasoline\s*Stocks|Distillate|Natural\s*Gas\s*Stocks|Short[-\s]*Term\s*Energy)/i,
    /(ADP\s*Employment|JOLTs|JOLTS)/i,
    // 심리·기대 지표 (미국) — 한국 것은 KR 전반 규칙에서 살린다
    /(Michigan\s*Consumer|UMich|CB\s*Consumer\s*Confidence|Consumer\s*Sentiment)/i,
    // ISM 하위 항목 (본지수만 본다)
    /ISM\s*(Manufacturing|Services|Non[-\s]*Manufacturing)\s*(Employment|Prices|New\s*Orders)/i,
    // S&P Global 속보치 PMI (미국) — 미국은 ISM만 본다
    /S&P\s*Global\s*(Composite|Services|Manufacturing)\s*PMI\s*Flash/i,
  ];

  /* ── 핵심으로 인정하는 것들 ────────────────────────────────────────────── */
  const KEY_RULES = [
    // 통화정책
    { re: /(FOMC|Fed\s*Interest\s*Rate\s*Decision|Fed\s*Press\s*Conference|Jackson\s*Hole|기준금리|금리\s*결정|금통위|한국은행\s*기준금리)/i },
    { re: /Fed\s*(Chair|Vice\s*Chair)\s*[A-Za-z]*\s*(Speech|Testimony)/i }, // 의장·부의장만
    { re: /(연준\s*의장|파월|의장\s*기자회견|한은\s*총재|BoK\s*Gov)/i },
    // 물가
    { re: /(Inflation\s*Rate|\bCPI\b|소비자물가|근원\s*물가)/i },
    { re: /(\bPCE\b|Personal\s*Consumption\s*Expenditure|개인소비지출)/i },
    { re: /(\bPPI\b|Producer\s*Price|생산자물가)/i },
    // 고용 (미국 월간 고용보고서 + 주간 신규 실업수당)
    { re: /(Non[-\s]*Farm\s*Payrolls|\bNFP\b|비농업\s*(부문\s*)?고용)/i },
    { re: /(Unemployment\s*Rate|실업률)/i },
    { re: /(Average\s*Hourly\s*Earnings|시간당\s*(평균\s*)?임금)/i },
    { re: /(Participation\s*Rate|경제활동\s*참가율)/i },
    { re: /(Initial\s*Jobless\s*Claims|신규\s*실업수당)/i },
    // 성장
    { re: /(\bGDP\b|Gross\s*Domestic|국내총생산)/i },
    // 경기 체감 (미국은 ISM 본지수만)
    { re: /^(?!.*Flash).*\bISM\b.*(PMI|지수)/i },
    // 소비
    { re: /(Retail\s*Sales|소매판매)/i },
    // 원자재 재고 (EIA 원유만)
    { re: /EIA\s*Crude\s*Oil\s*Stocks/i },
    // 파생 만기일
    { re: /(동시만기|네\s*마녀|선물·?옵션\s*만기|옵션\s*만기)/i },
  ];

  /**
   * 미국에만 적용하는 제외 규칙.
   * 예) 수출입 — 미국 수출입은 부수 지표지만, 한국 수출(Exports YoY)은
   *     국내 증시 선행지표로 취급되므로 한국에는 적용하지 않는다.
   */
  const US_ONLY_EXCLUDE_RULES = [/^\s*(Exports|Imports)\b/i];

  /**
   * 한국 지표는 "전반"을 핵심으로 본다(2026-09-04 운영자 결정).
   * 국내 이용자 중심 서비스라 한국 지표는 건수가 적고 대부분 뉴스에 다뤄진다.
   * 단, 위 EXCLUDE(주택·무역·재고 등)는 한국에도 그대로 적용한다.
   */
  const KR_EXTRA_RULES = [
    /(Consumer\s*Confidence|Business\s*Confidence|소비자심리|기업경기|기업신뢰)/i,
    /(Exports|Imports|수출|수입)/i,
    /(S&P\s*Global\s*Manufacturing\s*PMI|제조업\s*PMI)/i,
  ];

  function textOf(row, extraText) {
    const parts = [
      extraText,
      row && row.event,
      row && row.title,
      row && row.name,
      row && row.indicator,
    ];
    return parts.filter(Boolean).join(" ").trim();
  }

  /**
   * @param {object} row  경제일정 한 행 ({event, title, country, ...})
   * @param {string} [extraText]  화면에서 번역된 한글 지표명이 있으면 같이 넘긴다
   * @returns {boolean}
   */
  function isKeyIndicator(row, extraText) {
    const country = normalizeCountry(row && row.country);
    if (country !== "US" && country !== "KR") return false;

    const t = textOf(row, extraText);
    if (!t) return false;

    for (let i = 0; i < EXCLUDE_RULES.length; i += 1) {
      if (EXCLUDE_RULES[i].test(t)) return false;
    }
    if (country === "US") {
      for (let i = 0; i < US_ONLY_EXCLUDE_RULES.length; i += 1) {
        if (US_ONLY_EXCLUDE_RULES[i].test(t)) return false;
      }
    }
    for (let i = 0; i < KEY_RULES.length; i += 1) {
      if (KEY_RULES[i].re.test(t)) return true;
    }
    if (country === "KR") {
      for (let i = 0; i < KR_EXTRA_RULES.length; i += 1) {
        if (KR_EXTRA_RULES[i].test(t)) return true;
      }
    }
    return false;
  }

  return { isKeyIndicator, normalizeCountry, KEY_RULES, EXCLUDE_RULES, US_ONLY_EXCLUDE_RULES, KR_EXTRA_RULES };
});
