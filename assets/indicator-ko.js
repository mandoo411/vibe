/** 경제지표 영문→한글 (weekly-market.html과 동기) */
const INDICATOR_KO = {
  "Fed Interest Rate Decision": "연준 금리 결정",
  "FOMC Meeting Minutes": "FOMC 의사록",
  "RBA Meeting Minutes": "RBA 통화정책 회의록",
  "FOMC Minutes": "FOMC 의사록",
  "Fed Minutes": "연준 의사록",
  "CPI m/m": "소비자물가 (월간)",
  "Core CPI m/m": "근원 소비자물가 (월간)",
  "CPI y/y": "소비자물가 (연간)",
  "PPI m/m": "생산자물가 (월간)",
  "Core PPI m/m": "근원 생산자물가 (월간)",
  "GDP q/q": "GDP (분기)",
  "Prelim GDP q/q": "GDP 속보치 (분기)",
  "NFP": "비농업고용",
  "Non-Farm Employment Change": "비농업고용 변화",
  "Unemployment Rate": "실업률",
  "ADP Non-Farm Employment Change": "ADP 비농업고용",
  "Initial Jobless Claims": "신규 실업수당 청구",
  "Retail Sales m/m": "소매판매 (월간)",
  "Core Retail Sales m/m": "근원 소매판매 (월간)",
  "Retail Sales YoY": "소매판매 (연간)",
  "Retail Sales MoM": "소매판매 (월간)",
  "Retail Sales y/y": "소매판매 (연간)",
  "Retail Sales m/m": "소매판매 (월간)",
  "Retail Sales Ex Autos m/m": "소매판매 (자동차 제외)",
  "Core Retail Sales y/y": "근원 소매판매 (연간)",
  "ISM Manufacturing PMI": "ISM 제조업 PMI",
  "ISM Non-Manufacturing PMI": "ISM 서비스업 PMI",
  "ISM Services PMI": "ISM 서비스 PMI",
  "CB Consumer Confidence": "CB 소비자신뢰지수",
  "Michigan Consumer Sentiment": "미시간 소비자심리지수",
  "New Home Sales": "신규 주택판매",
  "Existing Home Sales": "기존 주택판매",
  "Housing Starts": "주택착공건수",
  "Building Permits": "건축허가",
  "Trade Balance": "무역수지",
  "Balance of Trade": "무역수지",
  "Non Farm Payrolls": "비농업 고용",
  "Non-Farm Payrolls": "비농업 고용",
  "Non Farm Employment Change": "비농업 고용 변화",
  "Ivey PMI s.a": "아이브이 PMI (계절조정)",
  "Ivey PMI": "아이브이 PMI",
  "NAB Business Confidence": "NAB 기업신뢰지수",
  "Exports YoY": "수출 (연간)",
  "Imports YoY": "수입 (연간)",
  "Building Permits MoM": "건축허가 (월간)",
  "CPI YoY": "소비자물가 (연간)",
  "PPI YoY": "생산자물가 (연간)",
  "Current Account": "경상수지",
  "Current Account Balance": "경상수지",
  "Government Budget": "정부 예산",
  "Durable Goods Orders m/m": "내구재 주문 (월간)",
  "Core Durable Goods Orders m/m": "근원 내구재 주문",
  "Industrial Production m/m": "산업생산 (월간)",
  "Industrial Production YoY": "산업생산 (연간)",
  "Industrial Production MoM": "산업생산 (월간)",
  "Industrial Production y/y": "산업생산 (연간)",
  "Industrial Production m/m": "산업생산 (월간)",
  "Capacity Utilization Rate": "설비가동률",
  "PCE Price Index m/m": "PCE 물가지수 (월간)",
  "Core PCE Price Index m/m": "근원 PCE 물가지수",
  "Personal Income m/m": "개인소득 (월간)",
  "Personal Spending m/m": "개인소비 (월간)",
  "Empire State Manufacturing Index": "엠파이어스테이트 제조업지수",
  "Philadelphia Fed Manufacturing Index": "필라델피아 연준 제조업지수",
  "Chicago PMI": "시카고 PMI",
  "Flash Manufacturing PMI": "제조업 PMI 속보치",
  "Flash Services PMI": "서비스 PMI 속보치",
  "PMI Prel": "PMI (속보치)",
  "Manufacturing PMI Prel": "제조업 PMI (속보치)",
  "Services PMI Prel": "서비스 PMI (속보치)",
  "JOLTs Job Openings": "JOLTs 구인건수",
  "Treasury Secretary Press Conference": "재무장관 기자회견",
  "Manufacturing PMI": "제조업 PMI",
  "Services PMI": "서비스 PMI",
  "Composite PMI": "복합 PMI",
  "Business Confidence": "기업신뢰지수",
  "Consumer Confidence": "소비자신뢰지수",
  "Consumer Price Index MoM": "소비자물가지수 (월간)",
  "Consumer Price Index YoY": "소비자물가지수 (연간)",
  "Producer Price Index MoM": "생산자물가지수 (월간)",
  "Producer Price Index YoY": "생산자물가지수 (연간)",
  "Inflation Rate YoY": "소비자물가지수 (연간)",
  "Inflation Rate MoM": "소비자물가지수 (월간)",
  "Inflation Rate YoY Prel": "소비자물가지수 (연간, 속보치)",
  "Inflation Rate MoM Prel": "소비자물가지수 (월간, 속보치)",
  "CPI YoY Prel": "소비자물가 (연간, 속보치)",
  "CPI MoM Prel": "소비자물가 (월간, 속보치)",
  "Core Inflation Rate YoY": "근원 소비자물가지수 (연간)",
  "Core Inflation Rate MoM": "근원 소비자물가지수 (월간)",
  "Employment Change": "고용변화",
  "Interest Rate Decision": "금리 결정",
  "Monetary Policy Statement": "통화정책 성명",
  "Press Conference": "기자회견",
  "Speech": "연설",
  "Testimony": "의회 증언",
  "Foreign Exchange Reserves": "외환보유고",
  "RBA Hunter Speech": "RBA 헌터 총재 연설",
  "RBA Interest Rate Decision": "RBA 금리 결정",
  "Westpac Consumer Confidence": "웨스트팩 소비자신뢰",
  "Westpac Consumer Confidence Change": "웨스트팩 소비자신뢰 변화",
  "Westpac Consumer Confidence Index": "웨스트팩 소비자신뢰지수",
  "Australia CPI q/q": "호주 소비자물가 (분기)",
  "ECB Interest Rate Decision": "ECB 금리 결정",
  "ECB Press Conference": "ECB 기자회견",
  "German CPI m/m": "독일 소비자물가 (월간)",
  "German GDP q/q": "독일 GDP (분기)",
  "German Ifo Business Climate": "독일 IFO 기업환경지수",
  "Eurozone CPI y/y": "유로존 소비자물가 (연간)",
  "Eurozone GDP q/q": "유로존 GDP (분기)",
  "Eurozone PMI": "유로존 PMI",
  "BOE Interest Rate Decision": "영란은행 금리 결정",
  "UK CPI y/y": "영국 소비자물가 (연간)",
  "UK GDP m/m": "영국 GDP (월간)",
  "BOJ Interest Rate Decision": "일본은행 금리 결정",
  "Japan CPI y/y": "일본 소비자물가 (연간)",
  "Tankan Manufacturing Index": "단칸 제조업지수",
  "China CPI y/y": "중국 소비자물가 (연간)",
  "China GDP q/q": "중국 GDP (분기)",
  "China Manufacturing PMI": "중국 제조업 PMI",
  "Caixin Manufacturing PMI": "차이신 제조업 PMI",
  "Commemoration of Atatürk, Youth and Sports Day": "아타튀르크 청소년 체육의 날 (터키)",
  "G7 Summit": "G7 정상회의",
  "G20 Summit": "G20 정상회의",
  "GDP Growth Annualized 1st Est": "GDP 성장률 연율 1차 추정",
  "GDP Growth Rate": "GDP 성장률",
  "GDP Growth Rate QoQ": "GDP 성장률 (분기)",
  "GDP Growth Rate YoY": "GDP 성장률 (연간)",
  "GDP YoY Prel": "GDP (연간, 속보치)",
  "GDP QoQ Prel": "GDP (분기, 속보치)",
  "GDP YoY Flash": "GDP (연간, flash)",
  "GDP QoQ Flash": "GDP (분기, flash)",
  "Unemployment Rate Prel": "실업률 (속보치)",
  "Balance of Trade": "무역수지",
  "Non-Oil Exports MoM": "비석유 수출 (월간)",
  "Non-Oil Exports YoY": "비석유 수출 (연간)",
  "Consumer Inflation Expectations": "소비자 인플레이션 기대",
  "House Price Index YoY": "주택가격지수 (연간)",
  "Composite NZ PCI": "뉴질랜드 복합 PCI",
  "Services NZ PSI": "뉴질랜드 서비스 PSI",
  "Legislative Election": "의회 선거",
  "Constitution Day": "제헌절",
  "Liberation Day": "해방기념일",
  "Ascension Day": "예수승천일",
  "Victoria Day": "빅토리아 데이",
  "Battle of Las Piedras": "라스 피에드라스 전투 기념일",
  "Average Hourly Earnings m/m": "평균 시간당 임금",
  "Average Hourly Earnings MoM": "평균 시간당 임금",
  "Average Hourly Earnings": "평균 시간당 임금",
  "Nonfarm Payrolls": "비농업 고용",
  "ADP Employment Change": "ADP 고용변화",
  "ADP Nonfarm Employment Change": "ADP 비농업고용",
  "JOLTS Job Openings": "JOLTs 구인건수",
  "ISM Manufacturing": "ISM 제조업지수",
  "ISM Non-Manufacturing": "ISM 서비스업지수",
  "Pending Home Sales m/m": "잠정주택판매 (월간)",
  "Pending Home Sales MoM": "잠정주택판매 (월간)",
  "Factory Orders m/m": "공장주문 (월간)",
  "Fed Chair Powell Speaks": "파월 연준의장 발언",
  "Powell Speaks": "파월 발언",
  "Beige Book": "베이지북",
  "FOMC Statement": "FOMC 성명서",
  "President Trump Speaks": "트럼프 대통령 연설",
  "U.S. President Trump Speaks": "트럼프 대통령 연설",
  "Unemployment Claims": "실업수당 청구건수",
  "Continuing Jobless Claims": "연속 실업수당 청구",
};
const INDICATOR_REGEX = [
  [/non[\s-]?farm\s+payrolls/i, "비농업 고용"],
  [/balance\s+of\s+trade/i, "무역수지"],
  [/ivey\s+pmi/i, "아이브이 PMI"],
  [/gdp\s+growth\s+rate\s+yoy/i, "GDP 성장률 (연간)"],
  [/westpac\s+consumer\s+confidence/i, "웨스트팩 소비자신뢰"],
  [/nab\s+business\s+confidence/i, "NAB 기업신뢰지수"],
  [/unemployment\s+rate/i, "실업률"],
  [/exports\s+yoy/i, "수출 (연간)"],
  [/imports\s+yoy/i, "수입 (연간)"],
];
function translateIndicator(name) {
  const raw = String(name || "").trim();
  if (!raw) return raw;
  if (INDICATOR_KO[raw]) return INDICATOR_KO[raw];
  const withoutLeadingDate = raw.replace(/^\d{1,2}\s+[A-Za-z]{3,9}\s+/, "").trim();
  if (INDICATOR_KO[withoutLeadingDate]) return INDICATOR_KO[withoutLeadingDate];
  const normalized = withoutLeadingDate
    .replace(/\bMoM\b/g, "m/m")
    .replace(/\bYoY\b/g, "y/y")
    .replace(/\bQoQ\b/g, "q/q")
    .replace(/\s+/g, " ")
    .trim();
  if (INDICATOR_KO[normalized]) return INDICATOR_KO[normalized];
  const lower = normalized.toLowerCase();
  const exactCi = Object.keys(INDICATOR_KO).find((k) => k.toLowerCase() === lower);
  if (exactCi) return INDICATOR_KO[exactCi];
  for (const [re, ko] of INDICATOR_REGEX) {
    if (re.test(normalized)) return ko;
  }
  const partial = Object.keys(INDICATOR_KO)
    .sort((a, b) => b.length - a.length)
    .find((key) => {
      const k = key.toLowerCase();
      const n = lower;
      return n.includes(k) || k.includes(n);
    });
  return partial ? INDICATOR_KO[partial] : raw;
}

function stripLegacyPeriodLabel(text) {
  return String(text || "")
    .replace(/\s*·\s*(월간|연간|분기)\s*$/g, "")
    .replace(/\s*\(\s*(월간|연간|분기)[^)]*\)/g, "")
    .trim();
}

function parseLegacyPeriod(text) {
  const t = String(text || "");
  if (/\(연간|연간\)|\byoy\b|\by\/y\b/i.test(t)) return "연간";
  if (/\(월간|월간\)|\bmom\b|\bm\/m\b/i.test(t)) return "월간";
  if (/\(분기|분기\)|\bqoq\b|\bq\/q\b/i.test(t)) return "분기";
  return null;
}

function detectIndicatorPeriod(...texts) {
  const t = texts.filter(Boolean).join(" ");
  if (/\b(yoy|y\/y|annual|yearly)\b/i.test(t) || /\(연간\)/i.test(t)) return "연간";
  if (/\b(mom|m\/m|monthly)\b/i.test(t) || /\(월간\)/i.test(t)) return "월간";
  if (/\b(qoq|q\/q|quarterly)\b/i.test(t) || /\(분기\)/i.test(t)) return "분기";
  return null;
}

function normalizeCountryCode(country) {
  const c = String(country || "").trim();
  if (!c) return "";
  const u = c.toUpperCase();
  if (/^(US|USA|U\.S\.|UNITED STATES)$/.test(u) || c === "미국") return "US";
  if (/^(KR|KOREA|SOUTH KOREA|ROK)$/.test(u) || c === "한국" || c === "대한민국") return "KR";
  return u.length === 2 ? u : c;
}

function isUnitedStates(country) {
  return normalizeCountryCode(country) === "US";
}

function resolveFormalIndicator(row) {
  const raw = String(row?.event || "").trim();
  const translated = translateIndicator(raw);
  const search = `${raw} ${translated}`;
  const period = detectIndicatorPeriod(raw, translated) || parseLegacyPeriod(translated);

  if (/근원\s*인플레이션|Core\s*Inflation\s*Rate|Core\s*CPI/i.test(search)) {
    return { nameKo: "근원 소비자물가지수", abbr: "Core CPI", period };
  }
  if (/인플레이션율|Inflation\s*Rate/i.test(search) && !/근원|Core/i.test(search)) {
    return { nameKo: "소비자물가지수", abbr: "CPI", period };
  }
  if (/\bCPI\b|Consumer\s*Price\s*Index|소비자물가/i.test(search) && !/PPI|Producer|생산자물가/i.test(search)) {
    const isCore = /근원|Core/i.test(search);
    return {
      nameKo: isCore ? "근원 소비자물가지수" : "소비자물가지수",
      abbr: isCore ? "Core CPI" : "CPI",
      period,
    };
  }
  if (/생산자물가|\bPPI\b|Producer\s*Price/i.test(search)) {
    const isCore = /근원|Core/i.test(search);
    return {
      nameKo: isCore ? "근원 생산자물가지수" : "생산자물가지수",
      abbr: isCore ? "Core PPI" : "PPI",
      period,
    };
  }
  if (/개인소비|PCE|Personal\s*Consumption/i.test(search)) {
    const isCore = /근원|Core/i.test(search);
    const isPrice = /Price\s*Index|물가/i.test(search);
    return {
      nameKo: isPrice
        ? isCore
          ? "근원 개인소비지출 물가지수"
          : "개인소비지출 물가지수"
        : "개인소비지출",
      abbr: isCore ? "Core PCE" : "PCE",
      period,
    };
  }
  if (
    isUnitedStates(row?.country) &&
    (/금리\s*결정|기준금리|Fed\s*Interest|FOMC.*Decision|Interest\s*Rate\s*Decision/i.test(search) ||
      /^연준\s*금리/i.test(translated))
  ) {
    return { nameKo: "기준금리 결정", abbr: "FOMC", period: null };
  }
  if (/비농업|Non[\s-]?Farm|\bNFP\b/i.test(search)) {
    return { nameKo: "비농업 고용", abbr: "NFP", period };
  }
  if (/실업률|Unemployment\s*Rate/i.test(search)) {
    return { nameKo: "실업률", abbr: "Unemployment", period };
  }
  if (/국내총생산|\bGDP\b/i.test(search)) {
    return { nameKo: "국내총생산", abbr: "GDP", period };
  }
  if (/소비자심리|Michigan\s*Consumer|UMich|Consumer\s*Sentiment/i.test(search)) {
    return { nameKo: "소비자심리지수", abbr: "UMich", period };
  }
  if (/\bISM\b|공급관리/i.test(search)) {
    const isServices = /Non[\s-]?Manufacturing|Services/i.test(search);
    return { nameKo: isServices ? "ISM 서비스업지수" : "ISM 제조업지수", abbr: "ISM", period };
  }
  if (/구매관리자|PMI|Purchasing\s*Managers/i.test(search)) {
    return { nameKo: "구매관리자지수", abbr: "PMI", period };
  }
  return { nameKo: null, abbr: null, period };
}

function indicatorParenLabel(row, formal) {
  if (formal?.abbr) return formal.abbr;
  return String(row?.event || "").trim();
}

function tmEventLabelText(row) {
  const formal = resolveFormalIndicator(row);
  const translated = translateIndicator(row?.event || "");
  const nameKo = formal.nameKo || stripLegacyPeriodLabel(translated);
  const paren = indicatorParenLabel(row, formal);
  const period = formal.period || parseLegacyPeriod(translated);
  let label = nameKo;
  if (paren) label += ` (${paren})`;
  if (period) label += ` · ${period}`;
  return label;
}

window.tmTranslateIndicator = translateIndicator;
window.tmEventLabelText = tmEventLabelText;
const COUNTRY_KO = {
  "United States": "미국",
  US: "미국",
  "Euro Zone": "유로존",
  Eurozone: "유로존",
  Germany: "독일",
  UK: "영국",
  "United Kingdom": "영국",
  Japan: "일본",
  China: "중국",
  Australia: "호주",
  Canada: "캐나다",
  "New Zealand": "뉴질랜드",
  Singapore: "싱가포르",
  "South Korea": "한국",
  Korea: "한국",
  France: "프랑스",
  Italy: "이탈리아",
  Spain: "스페인",
  Brazil: "브라질",
  India: "인도",
  Mexico: "멕시코",
  Turkey: "터키",
  Switzerland: "스위스",
  Sweden: "스웨덴",
  Norway: "노르웨이",
  Taiwan: "대만",
  "Hong Kong": "홍콩",
};

window.tmTranslateCountry = function tmTranslateCountry(c) {
  const k = String(c || "").trim();
  return COUNTRY_KO[k] || k;
};
