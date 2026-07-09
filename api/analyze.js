/**
 * AI 종목분석 — Vercel Serverless Function
 * POST /api/analyze
 * body: { code: "005930", name: "삼성전자" }
 *
 * Required env (추가):
 * - OPENAI_API_KEY (optional: OPENAI_MODEL, 기본 gpt-5.4-mini) - Claude 실패/토큰부족 시 자동 폴백
 *
 * 2026-07-07 패치: Claude(web_search 포함) 호출이 실패하면(토큰 소진 등) 자동으로 OpenAI로 폴백한다.
 * OpenAI 경로는 Anthropic 내장 web_search를 쓸 수 없으므로, 대신 구글 뉴스 RSS(무료)로
 * 최신 헤드라인을 수집해 프롬프트에 근거로 넣어준다.
 */

const {
  bearerToken,
  getUserFromToken,
  getSubscription,
  tryIncrementFreeUsage,
  currentMonthKeySeoul,
  isConfigured: supabaseConfigured,
} = require("../lib/supabase-server");

const FREE_MONTHLY_LIMIT = 3; // keep in sync with assets/pricing-config.js free plan description

const DEFAULT_KIS_BASE = "https://openapi.koreainvestment.com:9443";

const WEB_SEARCH_TOOLS = [
  {
    type: "web_search_20250305",
    name: "web_search",
    // 2026-07-08: 일정/재료 검색 2회 + 수급 데이터 누락 시 추가 검색 1회를 허용하기 위해 2->3으로 상향.
    // 2026-07-10: 컨센서스 목표주가 검색이 필수 항목으로 추가되어 예산 부족을 막기 위해 3->4로 상향.
    max_uses: 4,
  },
];

const STOCK_ANALYSIS_TOOL = {
  name: "stock_analysis",
  description: "주식 분석 결과를 JSON으로 반환",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "object",
        properties: {
          direction: { type: "string" },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
      },
      priceReason: { type: "string" },
      supplyDemand: { type: "string" },
      upcomingEvents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            title: { type: "string" },
            date: { type: "string" },
            type: { type: "string" },
          },
        },
      },
      materialAnalysis: {
        type: "object",
        properties: {
          materials: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                strength: { type: "string" },
                reflectionPct: { type: "number" },
                comment: { type: "string" },
              },
            },
          },
          aiComment: { type: "string" },
        },
      },
      chartAnalysis: { type: "string" },
      aiJudgment: {
        type: "object",
        required: [
          "shortTerm",
          "midTerm",
          "longTerm",
          "entryPrice",
          "stopLoss",
          "target",
          "scenarioA",
          "scenarioB",
          "scenarioC",
          "aiComment",
        ],
        properties: {
          shortTerm: { type: "string" },
          midTerm: { type: "string" },
          longTerm: { type: "string" },
          entryPrice: { type: "number" },
          stopLoss: { type: "number" },
          target: { type: "number" },
          scenarioA: {
            type: "object",
            required: ["condition", "entry", "target", "stopLoss", "probability"],
            properties: {
              condition: { type: "string" },
              entry: { type: "number" },
              target: { type: "number" },
              stopLoss: { type: "number" },
              probability: { type: "number" },
            },
          },
          scenarioB: {
            type: "object",
            required: ["condition", "entry", "target", "stopLoss", "probability"],
            properties: {
              condition: { type: "string" },
              entry: { type: "number" },
              target: { type: "number" },
              stopLoss: { type: "number" },
              probability: { type: "number" },
            },
          },
          scenarioC: {
            type: "object",
            required: ["condition", "entry", "stopLoss", "strategy", "downTarget", "probability"],
            properties: {
              condition: { type: "string" },
              entry: { type: "number" },
              stopLoss: { type: "number" },
              strategy: { type: "string" },
              downTarget: { type: "number" },
              probability: { type: "number" },
            },
          },
          aiComment: { type: "string" },
        },
      },
    },
    required: [
      "summary",
      "priceReason",
      "supplyDemand",
      "upcomingEvents",
      "materialAnalysis",
      "chartAnalysis",
      "aiJudgment",
    ],
  },
};

const ANALYSIS_TOOLS = [...WEB_SEARCH_TOOLS, STOCK_ANALYSIS_TOOL];

const CLAUDE_MODEL = "claude-sonnet-4-6";

const ANALYSIS_PARSE_ERROR_MSG =
  "AI 분석 응답 처리 중 오류. 다시 시도해주세요.";

/** 프롬프트 주입용 한국 시각 기준 오늘 날짜 */
function todayKoreaLabel() {
  return new Date().toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function seoulYear() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
  }).format(new Date());
}

/** 오늘 날짜를 Asia/Seoul 기준 YYYY-MM-DD 로 반환 (이벤트 과거일자 필터링용) */
function seoulTodayISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** 문자열에서 YYYY-MM-DD 형태의 날짜를 최대한 관대하게 추출 (구분자 -, ., / 모두 허용).
 * 못 찾으면 null (예: '2026년 하반기 예정' 같은 모호한 표현은 걸러내지 않고 통과시킴). */
function extractISODate(raw) {
  const s = String(raw || "");
  const m = s.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  if (!m) return null;
  const mo = String(m[2]).padStart(2, "0");
  const d = String(m[3]).padStart(2, "0");
  return `${m[1]}-${mo}-${d}`;
}

/** 오늘(Asia/Seoul) 이전 날짜의 이벤트인지 판별. 날짜를 못 읽으면 과거로 취급하지 않음(통과). */
function isPastEventDate(dateStr, todayISO) {
  const iso = extractISODate(dateStr);
  if (!iso) return false;
  return iso < todayISO;
}

const ANALYST_PERSONA_RULES = `당신은 20년 경력의 베테랑 증권 애널리스트이고, 고객이 돈을 내고 구독하는 유료 리포트를 씁니다.
그래서 아래는 절대 규칙입니다:
- 할루시네이션(추정을 사실처럼 서술) 금지. 확인 안 된 것을 확인된 것처럼 쓰지 않는다.
- 거짓 정보, 한물간(스테일) 정보 금지 — 반드시 web_search로 확인한 최신 사실만 사용한다.
- "정보가 제공되지 않아 단정하기 어렵습니다", "확인되지 않아 ~일 수 있습니다", "~인 것으로 보입니다" 같은 얼버무리는 헤지(hedge) 표현 금지.
  데이터가 없으면 그냥 없다고 말하지 말고, web_search로 실제 데이터를 찾아서 확정적으로 서술한다.
- 정말 아무리 검색해도 못 찾는 항목은, 애매한 문장으로 채우지 말고 해당 항목 자체를 생략한다 (있지도 않은 이벤트를 "확인 안 됨"이라는 이유로 억지로 만들어 넣지 않는다).
- 답변 텍스트 안에 URL, 도메인명, "(사이트명)", "([출처](링크))" 같은 출처 표기를 절대 포함하지 않는다. 고객은 링크를 클릭해서 스스로 확인하지 않는다 — 애널리스트가 이미 확인한 사실을 자연스러운 문장으로 결론만 전달한다.
- 수급(외국인/기관 순매수) 서술 시 반드시 기준 시점을 명시한다 (예: "당일 기준", "최근 5거래일 누적"). 주가가 높은 종목은 주식 수만 나열하면 체감이 안 되므로, 순매수/순매도 수량과 함께 대략적인 금액(수량×현재가 환산, 예: "약 1,830억원")도 함께 언급한다.
- 입력 데이터에 종목 고유의 foreignNetBuy/institutionNetBuy 값이 없다고 해서 코스피 전체·업종 전체 같은 시장 전반 수급으로 뭉뚱그려 대체하지 않는다. 반드시 web_search로 "[종목명] 외국인 기관 순매수 [날짜]"를 검색해 그 종목 고유의 실제 수량을 찾아 서술한다. 시장 전체 흐름은 배경 설명으로 한 문장 덧붙이는 것은 괜찮지만, 종목 고유 수급 데이터를 대신할 수는 없다.
- PER·PBR이 업종 평균이나 그 종목의 역사적 평균 대비 뚜렷하게 높거나 낮으면(예: PBR 5배 이상, PER 30배 이상, 혹은 반대로 지나치게 낮은 경우) 숫자만 나열하지 말고 밸류에이션 부담(또는 저평가) 여부와 그 배수가 왜 형성됐는지(주가 급등, 이익 급감 등)를 한두 문장으로 짚어준다.
- 밸류에이션을 언급할 때 web_search로 "[종목명] 목표주가" 또는 "[종목명] 증권사 컨센서스"를 검색해서, 확인되는 증권사 평균(또는 최근 발표) 목표주가가 있으면 현재가 대비 괴리율(%)과 함께 반드시 짚어준다. 목표주가와 현재가가 이미 비슷하면(선반영) 그 사실 자체가 중요한 정보이므로 그렇게 서술한다. 검색해도 확인이 안 되면 억지로 지어내지 말고 그 문장 자체를 생략한다.
- materialAnalysis(재료 분석)에는 주가에 유리한 재료만 나열하지 않는다. web_search로 확인되는 재료 중 리스크·부정적 재료(예: 경쟁사의 신제품·증설로 인한 경쟁 심화, 규제·정책 리스크, 실적 눈높이 부담, 공급 축소·원가 상승 등)가 하나라도 확인되면 반드시 최소 1개는 materials 배열에 포함한다 — 지금까지의 강세 스토리와 배치되는 내용이라도 숨기지 않는다. 여러 관점을 균형 있게 짚어야 돈값을 하는 유료 리포트가 된다.
- 다가오는 이벤트는 해당 종목 자체 일정에만 국한하지 않는다. 같은 업종 경쟁사의 실적발표, 업황에 영향을 주는 정책·규제 발표, 주가에 실질적 영향을 줄 매크로 일정(예: 미국 금리 결정, 핵심 경쟁사 실적) 중 확인되는 것이 있으면 함께 포함한다.
- entryPrice(진입가)가 현재가와 차이가 나면(예: 눌림목 매수를 노리는 경우) 그 이유를 opinion 총평(comment)에 반드시 한 문장으로 설명한다. entryPrice가 시나리오 B(중립)의 entry와 다르면 왜 다른지도 명시한다 — 숫자만 던지지 말고 왜 그 가격을 골랐는지 반드시 설명한다.
- 재료 분석의 reflectionPct(반영도)는 "이 재료가 완전히 현실화됐을 때 기대되는 주가 임팩트 대비, 현재 주가에 이미 선반영된 비율"로 정의한다. 각 재료의 judgment(한줄 판단)에는 그 비율을 매긴 근거를 최소 하나 구체적으로 언급한다 — 예: 정보가 공개된 지 얼마나 됐는지, 공개 이후 주가가 이미 얼마나 움직였는지, 증권가 컨센서스·목표주가에 이미 얼마나 반영됐는지. 근거 없이 숫자만 제시하지 않는다.
- 분석 대상이 벤처캐피탈(VC)·사모펀드(PE)·지주회사처럼 지분투자가 핵심 사업인 회사라면, 재료 분석에서 "벤처투자 회수 기대" 같은 뭉뚱그린 표현으로 끝내지 않는다. 반드시 web_search로 "[종목명] 대표 포트폴리오" "[종목명] 투자 기업"을 검색해서, 특히 최근 기업가치가 급등했거나 IPO(상장)를 준비 중인 대표 피투자기업이 있으면 그 기업명과 투자 회수 규모·멀티플을 구체적으로 명시한다. 이런 대표 피투자기업이야말로 재료의 핵심이므로 일반론으로 대체하지 않는다.
- 각 섹션(스토리, 수급, 재료, 차트, 총평)은 따로따로 나열된 사실이 아니라 하나의 기승전결 있는 이야기로 이어지게 쓴다. 앞 섹션에서 나온 근거(예: 밸류에이션 부담, 수급 엇갈림, 미반영 재료)를 뒤 섹션(차트 해석, 총평)에서 다시 연결해서 언급하고, 총평은 앞의 모든 근거를 하나의 결론으로 묶어낸다.
- 지표·사실을 건조하게 나열하지 않는다 (예: "이동평균선: ~, RSI: ~" 식의 항목 나열형 문장 금지). 왜 그 정보가 지금 중요한지, 다른 정보와 어떻게 연결되는지를 자연스러운 문장으로 풀어서 설명한다.
- 고객이 "아, 이런 식으로도 보는구나" 하고 느낄 수 있는 통찰(다른 데서 보기 힘든 연결·비교·해석)을 리포트당 최소 1개 이상 반드시 포함한다. 월 5만원을 내는 고객에게 그냥 숫자 재탕이 아니라 이 돈 값을 한다는 인상을 줘야 한다.
- 어조는 확신에 찬 전문가 톤이되, 실제 근거 없는 과신은 금지한다 (근거는 web_search로 확보하고, 표현은 확정적으로).`;

function buildSystemPrompt(today) {
  return [
    ANALYST_PERSONA_RULES,
    `오늘은 ${today}입니다. 모든 분석은 이 시점 기준으로 작성하세요. 학습데이터의 과거 정보가 아니라 web_search 결과의 최신 뉴스를 반드시 사용하세요.`,
    "JSON 작성 전 web_search를 최소 2회, 필요하면 3회까지 실행하세요 (일정/재료 검색 2회 + 수급 데이터가 없을 경우 추가 검색 1회). 검색 없이 답변하지 마세요.",
    "web_search 결과는 2번(story), 3번(supplyDemand), 4번(events), 5번(materials 재료 분석)에 반드시 반영하세요.",
    "제공된 KIS 실시간 시세와 web_search 최신 뉴스만 근거로 분석하세요.",
    "일반 투자자도 이해할 수 있는 언어로 작성하세요.",
    "",
    `3번 수급 분석(supplyDemand) 규칙 (반드시 준수):
- 입력 데이터의 foreignNetBuy(외국인 순매수), institutionNetBuy(기관 순매수) 값을 우선 사용할 것.
- 이 값이 없거나 null이면, web_search로 "[종목명] 외국인 기관 순매수 [오늘 날짜]"를 검색해서 당일(장중이라 당일 데이터가 없으면 직전 거래일) 실제 수급 데이터를 찾아 그 수치로 서술할 것.
- "수급 정보가 제공되지 않아 단정하기 어렵습니다" 같은 문장은 절대 쓰지 말 것 — 반드시 검색해서 찾은 실제 방향성(순매수/순매도, 규모)으로 확정적으로 서술할 것.`,
    "",
    `4번 다가오는 이벤트 규칙 (반드시 준수):
- upcomingEvents에는 web_search로 날짜와 사실관계가 명확히 확인된 미래 이벤트만 포함할 것.
- 확인이 안 됐거나 애매한 건은 "아직 확인되지 않음" 같은 문구로 이벤트에 넣지 말고 아예 배열에서 제외할 것 (미확정 사실을 이벤트인 것처럼 만들지 않는다).
- 오늘은 ${today} 이다. 이 날짜 이후의 미래 이벤트만 포함할 것.
- 2024년, 2025년 날짜는 절대 포함 금지. 2026년 이후만 허용.
- 웹검색 결과에서 '예정' '방문 예정' '출시 예정' '발표 예정' '~할 계획' '~에 참석' 키워드가 있는 것만 선별.
- '했다' '밝혔다' '기록했다' '하락했다' 등 과거형은 절대 이벤트로 넣지 말 것.
- 웹검색으로 다음 실적발표일 등 공식 일정이 명확히 확인되면 그것으로 채우고, 확인이 안 되면 무리해서 채우지 말 것.
- 이벤트가 정말 하나도 확인되지 않으면 배열을 비우지 말고
  [{ label:'정보없음', title:'현재 확인된 예정 이벤트 없음', date:'', type:'neutral' }] 하나만 넣을 것 (추측성 항목을 여러 개 만들지 말 것)
- 이벤트 제목은 구체적으로: ❌'CEO 해외 일정' → ✅'젠슨황 방한 / 삼성 CEO 회동 예정'
- 날짜를 정확히 모르면 '2026년 하반기 예정' 식으로 표현.`,
    "",
    `5번 재료 분석 — web_search 결과 기반 (반드시 준수):
- materialAnalysis.materials는 반드시 2개 이상 채울 것.
- 웹검색 결과에서 해당 종목 관련 재료를 찾아서 채워줘.
- 재료가 없으면 아래처럼 기본 재료로 채울 것:
  · 실적 모멘텀: 다음 실적발표 예상치 기반
  · 업종 트렌드: 해당 업종 현재 흐름
- strength는 반드시 '강'/'중'/'하' 중 하나.
- reflectionPct는 반드시 0-100 사이 숫자.
- aiComment: AI 재료 종합 판단 3~5문장, 실제 트레이더 말투`,
    "",
    `6번 차트 흐름 분석 — 제공된 실제 수치만 사용(추정 금지). 아래 항목 전부 수치와 근거 포함:
① 이동평균선(일봉): 20일/60일/120일/200일선 대비 현재가 위치와 해석
② RSI: 제공된 RSI(14) 값 + 과매수/과매도 해석
③ 일목균형표: 전환선/기준선/구름대 위아래 여부
④ 지지선/저항선(단기, 일봉 기준): 1차·2차 수치 명시
⑤ 전고점/전저점: 수치와 의미 (high52w/low52w 활용)
⑥ 주봉 흐름 — 입력에 weeklyIndicators가 있으면: 20주선/60주선 대비 현재가 위치, 주봉 스윙 저항·지지(resistances/supports) 수치를 지지·저항 구조로 해석
⑦ 월봉 흐름 — 입력에 monthlyIndicators가 있으면: 12개월선/24개월선 대비 현재가 위치로 장기 추세(정배열/역배열) 판단, 월봉 스윙 저항·지지를 장기 지지·저항으로 해석
⑧ 멀티 타임프레임 정합성: 일봉·주봉·월봉 추세가 같은 방향인지 한 문장으로 비교 판단 (예: "일봉·주봉은 상승 정배열이나 월봉은 아직 24개월선 아래")
⑨ 엘리어트 파동: weeklyIndicators/monthlyIndicators의 스윙 저항·지지 순서가 있으면 그 근거로 현재 추정 파동 구간을 서술. 스윙 데이터가 불충분해 파동 번호를 특정하기 어려우면, "데이터 미확보"나 "판단 보류" 같은 내부 사정을 고객에게 노출하지 말고, 파동 번호 언급 없이 "장기 상승 추세 안에서의 조정 국면" 같은 정성적 표현으로 자연스럽게 넘어갈 것. 임의의 파동 번호·가격은 지어내지 말 것.
⑩ ICT(스마트머니) 관점: 제공된 지지·저항 구간을 유동성(liquidity) 구간 개념으로 짧게 해석. 데이터에 없는 오더블록/FVG 가격을 새로 만들어내지 말고 반드시 제공된 실제 스윙 레벨 범위 안에서만 언급
- weeklyIndicators/monthlyIndicators가 모두 없으면 ⑥~⑩ 내용은 억지로 채우지 말고 그 부분 언급 자체를 생략한 채 ①~⑤(일봉 중심 분석)만으로 자연스럽게 문단을 마무리할 것. "데이터가 없어서" 같은 문구는 절대 고객에게 노출하지 말 것.`,
    "",
    `7번 AI 주관적 판단 지침:
- aiJudgment 필드는 반드시 모든 하위 필드를 채울 것.
- 특히 아래 필드는 절대 누락 금지:
  · shortTerm, midTerm, longTerm: 문자열로 반드시 작성
  · entryPrice, stopLoss, target: 반드시 숫자 (0 금지)
    현재가 기준으로 합리적인 수치 계산해서 넣을 것
    entryPrice = 현재가 ± 1~2%
    stopLoss = entryPrice 기준 -3~5%
    target = entryPrice 기준 +10~20%
  · scenarioA/B/C 전부 entry(진입가)와 stopLoss(손절가)를 반드시 숫자로 채울 것 (0 금지, 절대 비워두지 말 것):
    - scenarioA(강세).entry/target/stopLoss: entryPrice 근방에서 강세 시나리오에 맞게 계산
    - scenarioB(중립).entry/target/stopLoss: 현재가 근방 진입, target=entry+5~8%, stopLoss=entry-3~5%
    - scenarioC(약세).entry/stopLoss: 이탈 후 반등을 노리는 재진입가 개념으로, entry=downTarget 근방, stopLoss=entry-3% 근방 (target은 downTarget으로 대체)
  · scenarioA/B/C: probability 합계 반드시 100
  · aiComment: 반드시 3문장 이상, entryPrice가 현재가·시나리오B entry와 다르면 그 이유 포함
- 단기(1-2주) / 중기(1-3개월) / 장기(6개월-1년) 전망 각각 상세히
- 시나리오 A (강세): 조건 / 진입가 / 목표가 / 손절가 / 확률%
- 시나리오 B (중립): 조건 / 진입가 / 목표가 / 손절가 / 확률% (entry/target/stopLoss 절대 0으로 두지 말 것)
- 시나리오 C (약세): 조건 / 진입가 / 대응전략 / 목표 하단 / 손절가 / 확률% (entry/stopLoss도 반드시 채울 것)
- 5번 재료 분석 결과를 반드시 반영 (예: '재료 미반영 구간이 크므로 A시나리오 확률 높게 책정')`,
    "",
    "web_search 2회 완료 후 반드시 stock_analysis 도구를 호출해 최종 결과를 반환하세요.",
    "direction은 매수|관망|회피 중 하나, confidence는 0~100 상승 확률입니다.",
    "scenario A/B/C 확률 합계는 100%입니다.",
  ].join("\n");
}

const CLAUDE_RESPONSE_SCHEMA = `{
  "summary": {
    "signal": "매수|관망|회피",
    "probability": 75,
    "description": "3줄 이내 핵심 요약"
  },
  "story": "왜 지금 이 가격인가 스토리텔링",
  "supply": "수급 분석 직관적 설명",
  "events": [
    {"type": "호재|악재", "content": "내용", "date": "날짜"}
  ],
  "materials": {
    "items": [
      {
        "name": "재료명",
        "strength": "상|중|하",
        "reflectionPct": 30,
        "reflectionNote": "30% 반영 — 아직 미반영 구간 큼",
        "judgment": "한줄 판단"
      }
    ],
    "unreflected": "미반영 핵심 재료 1~2개 설명",
    "summary": "AI 재료 종합 판단 3~5문장"
  },
  "chart": "차트 흐름 분석",
  "opinion": {
    "short": "단기(1-2주) 전망",
    "mid": "중기(1-3개월) 전망",
    "long": "장기(6개월-1년) 전망",
    "entry": 0,
    "stop": 0,
    "target": 0,
    "comment": "AI 총평 3-5문장",
    "scenarios": [
      {
        "label": "A",
        "type": "강세",
        "condition": "발동 조건",
        "entry": 0,
        "target": 0,
        "stop": 0,
        "probability": 40
      },
      {
        "label": "B",
        "type": "중립",
        "condition": "발동 조건",
        "entry": 0,
        "target": 0,
        "stop": 0,
        "probability": 35
      },
      {
        "label": "C",
        "type": "약세",
        "condition": "발동 조건",
        "entry": 0,
        "stop": 0,
        "strategy": "대응 전략",
        "targetLow": 0,
        "probability": 25
      }
    ]
  }
}`;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, body) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

// 2026-07-08: AI 응답 텍스트에 "([도메인](URL))" 같은 인용/출처 표기가 섞여 나오는 문제의
// 방어적 안전망. 프롬프트로 금지 지시를 넣어도 LLM이 100% 지키지 않을 수 있으므로,
// 모든 자유 텍스트 필드가 공통으로 거치는 sanitizeStr()에서 강제로 제거한다.
function stripCitations(s) {
  if (!s) return s;
  let out = s;
  // "([text](https://...))" 형태 — 괄호로 한 번 더 감싼 마크다운 링크(가장 흔한 패턴)
  out = out.replace(/\(\[[^\]]*\]\(https?:\/\/[^)]*\)\)/g, "");
  // "[text](https://...)" 형태 — 일반 마크다운 링크
  out = out.replace(/\[[^\]]*\]\(https?:\/\/[^)]*\)/g, "");
  // 그 외 본문에 그대로 남은 URL
  out = out.replace(/https?:\/\/[^\s)]+/g, "");
  // 링크 제거 후 남는 빈 괄호, 이중 공백, 구두점 앞 공백 정리
  out = out.replace(/\(\s*\)/g, "");
  out = out.replace(/[ \t]{2,}/g, " ");
  out = out.replace(/\s+([.,)])/g, "$1");
  return out.trim();
}

function sanitizeStr(v) {
  if (v == null) return "";
  return String(v).trim();
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

function requireAnthropicKey() {
  const k = sanitizeStr(process.env.ANTHROPIC_API_KEY);
  if (!k) {
    const err = new Error("Missing ANTHROPIC_API_KEY");
    err.statusCode = 503;
    throw err;
  }
  return k;
}

function requireOpenAIKey() {
  const k = sanitizeStr(process.env.OPENAI_API_KEY);
  if (!k) {
    const err = new Error("Missing OPENAI_API_KEY");
    err.statusCode = 503;
    throw err;
  }
  return k;
}

/** 구글 뉴스 RSS로 최신 헤드라인 수집 (무료, 실패해도 빈 배열 반환해서 전체 파이프라인 보호).
 * OpenAI 폴백 경로에서 Claude의 web_search를 대체하는 용도. */
async function fetchStockNews(query, maxItems = 5) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
    const xml = await res.text();

    const items = [];
    const seen = new Set();
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) && items.length < maxItems) {
      const block = m[1];
      const titleRaw = (block.match(/<title>([\s\S]*?)<\/title>/) || [, ""])[1];
      const sourceRaw = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [, ""])[1];
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [, ""])[1];

      const decode = (s) =>
        String(s || "")
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim();

      const source = decode(sourceRaw);
      let title = decode(titleRaw);
      if (source && title.endsWith(source)) {
        title = title.slice(0, title.length - source.length).replace(/[\s\-–—]+$/, "");
      }
      if (!title || seen.has(title)) continue;
      seen.add(title);
      items.push({ title, source: source || "출처미상", published: decode(pubDate) });
    }
    return items;
  } catch (e) {
    console.warn("[analyze] news fetch failed", e && e.message);
    return [];
  }
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
  const j = safeParseJSON(text);
  if (j == null) {
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

/** 외국인/기관 순매수 수량 조회 (당일 데이터는 장 종료 후 제공되는 KIS 특성상,
 * 장중에는 최근 영업일 값이 나올 수 있음). 실패해도 전체 응답을 막지 않도록
 * null/null을 반환하고 조용히 넘어간다 — inquire-price 응답에는 이 필드가 없어서
 * 별도 엔드포인트(inquire-investor)를 호출해야 한다. */
async function fetchKisInvestorFlow(code6) {
  try {
    const res = await kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-investor", "FHKST01010900", {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code6,
    });
    const rows = Array.isArray(res && res.output) ? res.output : [];
    const latest = rows[0] || {};
    return {
      foreignNetBuy: toNum(latest.frgn_ntby_qty),
      institutionNetBuy: toNum(latest.orgn_ntby_qty),
    };
  } catch (e) {
    console.warn("[analyze] investor flow fetch failed", code6, e && e.message);
    return { foreignNetBuy: null, institutionNetBuy: null };
  }
}

async function fetchKisQuote(code6) {
  const commonParams = {
    FID_COND_MRKT_DIV_CODE: "J",
    FID_INPUT_ISCD: code6,
  };
  const [p1, p2, investorFlow] = await Promise.all([
    kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", commonParams),
    kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-price-2", "FHPST01010000", commonParams),
    fetchKisInvestorFlow(code6),
  ]);

  const o1 = (p1 && p1.output) || {};
  const o2 = (p2 && p2.output) || {};

  const currentPrice = toNum(o1.stck_prpr);
  const changeAmt = toNum(o1.prdy_vrss);
  const changeRate = toNum(o1.prdy_ctrt);
  const volume = toNum(o1.acml_vol);
  const prevClose = toNum(o2.stck_prdy_clpr);
  const open = toNum(o2.stck_oprc) ?? toNum(o1.stck_oprc);
  const high = toNum(o2.stck_hgpr) ?? toNum(o1.stck_hgpr);
  const low = toNum(o2.stck_lwpr) ?? toNum(o1.stck_lwpr);
  const prevVolume = toNum(o2.prdy_vol);
  const creditRate = toNum(o2.crdt_rate);
  // inquire-price(FHKST01010100) 응답에는 외국인/기관 순매수 필드가 없다.
  // 별도로 inquire-investor(FHKST01010900)를 호출해 가져온 값을 사용한다.
  const foreignNetBuy = investorFlow.foreignNetBuy;
  const institutionNetBuy = investorFlow.institutionNetBuy;

  return {
    stockCode: code6,
    stockName: sanitizeStr(o1.hts_kor_isnm || o1.prdt_abrv_name || o1.isnm || o2.hts_kor_isnm || ""),
    market: marketLabelFromRow(o1) || marketLabelFromRow(o2),
    currentPrice: currentPrice == null ? null : Math.round(currentPrice),
    changeAmt: changeAmt == null ? null : Math.round(changeAmt),
    changeRate: changeRate == null ? null : Math.round(changeRate * 100) / 100,
    volume: volume == null ? null : Math.round(volume),
    prevClose: prevClose == null ? null : Math.round(prevClose),
    open: open == null ? null : Math.round(open),
    high: high == null ? null : Math.round(high),
    low: low == null ? null : Math.round(low),
    prevVolume: prevVolume == null ? null : Math.round(prevVolume),
    creditRate: creditRate == null ? null : Math.round(creditRate * 100) / 100,
    per: toNum(o1.per),
    pbr: toNum(o1.pbr),
    eps: toNum(o1.eps),
    foreignNetBuy,
    institutionNetBuy,
    high52w: toNum(o1.w52_hgpr),
    low52w: toNum(o1.w52_lwpr),
    volTurnoverRate: toNum(o1.vol_tnrt),
    foreignHoldRate: toNum(o1.hts_frgn_ehrt ?? o1.frgn_hldn_qty_rt),
    marketCapRaw: sanitizeStr(o1.hts_avls || o1.stck_avls),
  };
}

function ymdKst(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d).replace(/-/g, "");
}

function subtractCalendarDaysFromYmd(ymd, days) {
  const s = String(ymd || "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(s)) return s;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6)) - 1;
  const day = Number(s.slice(6, 8));
  const dt = new Date(Date.UTC(y, m, day));
  dt.setUTCDate(dt.getUTCDate() - Number(days || 0));
  return ymdKst(dt);
}

function mapWmRow(row) {
  if (!row || typeof row !== "object") return null;
  const dateRaw = sanitizeStr(row.stck_bsop_date || row.STCK_BSOP_DATE);
  if (!/^\d{8}$/.test(dateRaw)) return null;
  const time = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
  const close = toNum(row.stck_clpr || row.STCK_CLPR);
  const high = toNum(row.stck_hgpr || row.STCK_HGPR);
  const low = toNum(row.stck_lwpr || row.STCK_LWPR);
  if (close == null || high == null || low == null) return null;
  return { time, high: Math.round(high), low: Math.round(low), close: Math.round(close) };
}

function maLast(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return Math.round(sum / period);
}

/** 좌우 lookback개 봉보다 고점/저점인 캔들을 스윙 포인트(피벗)로 추출한다.
 * 일봉이 아닌 주봉/월봉 기준 실제 스윙 고점·저점이므로, 단순 52주 고저 한 쌍보다
 * 다차원 지지·저항 구조와 엘리어트 파동 추정의 근거로 쓸 수 있다(추정이 아닌 실측 데이터). */
function findSwingPoints(candles, lookback, maxPoints) {
  const highs = [];
  const lows = [];
  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) return { resistances: [], supports: [] };
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let k = i - lookback; k <= i + lookback; k++) {
      if (k === i) continue;
      if (candles[k].high >= c.high) isHigh = false;
      if (candles[k].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ time: c.time, price: c.high });
    if (isLow) lows.push({ time: c.time, price: c.low });
  }
  return {
    resistances: highs.slice(-maxPoints).map((h) => h.price),
    supports: lows.slice(-maxPoints).map((l) => l.price),
  };
}

/** 종목 고유의 실제 주봉/월봉 데이터를 KIS에서 가져와 이동평균·스윙 고점/저점을 계산한다.
 * 실패해도 전체 분석 응답을 막지 않도록 null을 반환하고 조용히 넘어간다 — 이 데이터가
 * 없으면 프롬프트에서 장기/단기 다중 타임프레임 지시를 건너뛰도록 처리한다(추정 금지 원칙 유지). */
async function fetchKisWeeklyMonthly(code6) {
  try {
    const endAll = ymdKst(new Date());
    const weekStart = subtractCalendarDaysFromYmd(endAll, 1460);
    const monthStart = subtractCalendarDaysFromYmd(endAll, 3650);
    const commonBase = { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code6, FID_ORG_ADJ_PRC: "0" };
    const [wRes, mRes] = await Promise.all([
      kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", "FHKST03010100", {
        ...commonBase,
        FID_INPUT_DATE_1: weekStart,
        FID_INPUT_DATE_2: endAll,
        FID_PERIOD_DIV_CODE: "W",
      }),
      kisGetJson("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", "FHKST03010100", {
        ...commonBase,
        FID_INPUT_DATE_1: monthStart,
        FID_INPUT_DATE_2: endAll,
        FID_PERIOD_DIV_CODE: "M",
      }),
    ]);

    const toRows = (j) => {
      let raw = j && j.output2;
      if (raw && !Array.isArray(raw)) raw = [raw];
      if (!Array.isArray(raw)) raw = [];
      const rows = raw.map(mapWmRow).filter(Boolean);
      rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
      return rows;
    };

    const weekly = toRows(wRes);
    const monthly = toRows(mRes);
    if (!weekly.length && !monthly.length) return null;

    const wCloses = weekly.map((c) => c.close);
    const mCloses = monthly.map((c) => c.close);
    const wSwing = findSwingPoints(weekly, 2, 4);
    const mSwing = findSwingPoints(monthly, 1, 3);

    return {
      weekly: {
        count: weekly.length,
        ma20: maLast(wCloses, 20),
        ma60: maLast(wCloses, 60),
        resistances: wSwing.resistances,
        supports: wSwing.supports,
      },
      monthly: {
        count: monthly.length,
        ma12: maLast(mCloses, 12),
        ma24: maLast(mCloses, 24),
        resistances: mSwing.resistances,
        supports: mSwing.supports,
      },
    };
  } catch (e) {
    console.warn("[analyze] weekly/monthly fetch failed", code6, e && e.message);
    return null;
  }
}

/** 주봉/월봉 데이터를 프롬프트의 JSON 입력 데이터에 끼워넣을 필드로 변환한다.
 * 세 분석 경로(Claude/OpenAI web_search/OpenAI RSS)가 동일한 형태를 쓰도록 공용 함수로 뺐다. */
function wmJsonFields(wm) {
  if (!wm) return { weeklyIndicators: null, monthlyIndicators: null };
  return {
    weeklyIndicators: wm.weekly
      ? { ma20: wm.weekly.ma20, ma60: wm.weekly.ma60, resistances: wm.weekly.resistances, supports: wm.weekly.supports }
      : null,
    monthlyIndicators: wm.monthly
      ? { ma12: wm.monthly.ma12, ma24: wm.monthly.ma24, resistances: wm.monthly.resistances, supports: wm.monthly.supports }
      : null,
  };
}

/** 사람이 읽는 프롬프트 텍스트용 주봉/월봉 수치 블록. wm이 null이면 빈 문자열을 반환한다. */
function formatWmTextBlock(wm) {
  if (!wm) return "";
  const fmt = (n) => (n == null ? "—" : Math.round(n).toLocaleString("ko-KR"));
  const fmtList = (arr) => (Array.isArray(arr) && arr.length ? arr.map((n) => fmt(n)).join(", ") : "—");
  const lines = ["", "실제 주봉/월봉 기술적 데이터 (추정 금지, 아래 수치만 사용):"];
  if (wm.weekly) {
    lines.push(`[주봉] 20주선: ${fmt(wm.weekly.ma20)}원 / 60주선: ${fmt(wm.weekly.ma60)}원`);
    lines.push(`[주봉] 스윙 저항: ${fmtList(wm.weekly.resistances)} / 스윙 지지: ${fmtList(wm.weekly.supports)}`);
  }
  if (wm.monthly) {
    lines.push(`[월봉] 12개월선: ${fmt(wm.monthly.ma12)}원 / 24개월선: ${fmt(wm.monthly.ma24)}원`);
    lines.push(`[월봉] 스윙 저항: ${fmtList(wm.monthly.resistances)} / 스윙 지지: ${fmtList(wm.monthly.supports)}`);
  }
  return lines.join("\n");
}

function extractTextFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function logContentBlocks(msg) {
  if (!msg || !Array.isArray(msg.content)) return;
  const types = msg.content.map((b) => b && b.type).filter(Boolean);
  console.log("[analyze] content block types", types.join(", "));
  if (types.includes("web_search_tool_result")) {
    console.log("[analyze] web_search_tool_result detected");
  }
}

function safeParseJSON(raw) {
  try {
    let text = String(raw || "")
      .replace(/```json[\s\S]*?```/g, (m) => m.replace(/```json|```/g, ""))
      .replace(/```/g, "")
      .trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON found");
    text = text.slice(start, end + 1);
    return JSON.parse(text);
  } catch (e) {
    console.error("JSON parse error:", e.message, String(raw || "").slice(0, 500));
    return null;
  }
}

function parseRequestBodyJson(text) {
  try {
    return JSON.parse(String(text || "").trim() || "{}");
  } catch {
    return null;
  }
}

function extractStockAnalysisToolUse(msg) {
  if (!msg || !Array.isArray(msg.content)) return null;
  const block = msg.content.find((b) => b && b.type === "tool_use" && b.name === "stock_analysis");
  return block && block.input && typeof block.input === "object" ? block.input : null;
}

function normalizeEventType(raw) {
  const t = sanitizeStr(raw);
  if (t === "악재" || t === "bad" || t === "bear") return "악재";
  if (t === "neutral" || t === "정보없음") return "neutral";
  return "호재";
}

function normalizeStrength(raw) {
  const s = sanitizeStr(raw);
  if (s === "상" || s === "강" || s === "high") return "상";
  if (s === "하" || s === "low") return "하";
  return "중";
}
function mapDirectionToSignal(direction) {
  const d = sanitizeStr(direction);
  if (/매수|buy|bull|상승/i.test(d)) return "매수";
  if (/회피|avoid|bear|하락|매도/i.test(d)) return "회피";
  if (/관망|hold|neutral|중립/i.test(d)) return "관망";
  return normalizeSignal(d);
}

function mapScenarioRaw(raw, label, type) {
  if (!raw || typeof raw !== "object") return null;
  return {
    label,
    type,
    condition: sanitizeStr(raw.condition),
    entry: toNum(raw.entry),
    target: toNum(raw.target),
    stop: toNum(raw.stopLoss ?? raw.stop),
    strategy: sanitizeStr(raw.strategy),
    targetLow: toNum(raw.downTarget ?? raw.targetLow),
    probability: toNum(raw.probability),
  };
}

function resolveOpinionPrices(entryRaw, stopRaw, targetRaw, currentPrice) {
  const cp = toNum(currentPrice) || 0;
  let entry = toNum(entryRaw);
  let stop = toNum(stopRaw);
  let target = toNum(targetRaw);

  if (!entry || entry <= 0) {
    entry = cp > 0 ? cp : null;
  }
  if (entry && (!stop || stop <= 0)) {
    stop = Math.round(entry * 0.95);
  }
  if (entry && (!target || target <= 0)) {
    target = Math.round(entry * 1.15);
  }

  return {
    entry: entry ?? (cp > 0 ? cp : 0),
    stop: stop ?? 0,
    target: target ?? 0,
  };
}

/** 시나리오(A/B/C)별 진입가/목표가/손절가 기본값 보정.
 * AI가 스키마 예시값(0)을 그대로 남기거나 필드를 비워둔 경우를 대비한 안전망.
 * - 강세(A): 전체 의견 entry/target/stop을 우선 사용, 없으면 현재가 기준 계산.
 * - 중립(B): 현재가 근방 진입, target=entry+5~8%, stop=entry-3~5%.
 * - 약세(C): targetLow(하방 목표) 근방을 재진입 고려가로 보고, stop은 그보다 살짝 낮게.
 * AI가 이미 유효한 값(0 초과)을 준 경우는 그 값을 그대로 존중하고 건드리지 않는다. */
function resolveScenarioPrices(s, price, opinionPrices) {
  const isBull = s.label === "A" || String(s.type).includes("강");
  const isBear = s.label === "C" || String(s.type).includes("약");
  const cp = toNum(price) || 0;

  let entry = toNum(s.entry);
  if (!entry || entry <= 0) {
    if (isBull) entry = opinionPrices && opinionPrices.entry > 0 ? opinionPrices.entry : cp || null;
    else if (isBear) {
      const low = toNum(s.targetLow);
      entry = low && low > 0 ? Math.round(low * 1.02) : cp > 0 ? Math.round(cp * 0.95) : null;
    } else {
      entry = cp > 0 ? cp : null;
    }
  }

  let stop = toNum(s.stop);
  if ((!stop || stop <= 0) && entry) {
    stop = isBear
      ? Math.round(entry * 0.97)
      : Math.round(entry * (isBull ? 0.95 : 0.96));
  }

  let target = toNum(s.target);
  if ((!target || target <= 0) && entry) {
    target = isBear
      ? Math.round(entry * 1.08)
      : Math.round(entry * (isBull ? 1.15 : 1.06));
  }

  let targetLow = toNum(s.targetLow);
  if (isBear && (!targetLow || targetLow <= 0) && entry) {
    targetLow = Math.round(entry * 0.93);
  }

  // ── 2026-07-09: 방향성 정합성 안전망 ──
  // 위 로직은 "값이 비어 있을 때만" 기본값을 채운다. 그런데 AI가 값을 채우긴 했지만
  // 방향이 틀린 경우(예: 시나리오C의 손절가가 진입가보다 높게 나오는 경우)는 그냥 통과된다.
  // 세 시나리오 모두 "entry 근방에서 매수 진입"을 전제로 하므로 항상
  // stop(손절가) < entry(진입가) < target(목표가) 순서가 성립해야 한다.
  // 값이 존재한다는 이유만으로 신뢰하지 않고, 순서까지 검증해서 어긋나면 교정한다.
  if (entry) {
    if (stop && stop >= entry) {
      stop = Math.round(entry * (isBear ? 0.97 : isBull ? 0.95 : 0.96));
    }
    if (target && target <= entry) {
      target = Math.round(entry * (isBear ? 1.08 : isBull ? 1.15 : 1.06));
    }
    if (isBear && targetLow && targetLow >= entry) {
      targetLow = Math.round(entry * 0.93);
    }
  }

  return {
    entry: entry ?? 0,
    stop: stop ?? 0,
    target: target ?? 0,
    targetLow: targetLow ?? (s.targetLow ?? null),
  };
}

function mapToolInputToLegacy(input) {
  if (!input || typeof input !== "object") return null;

  const summary = input.summary && typeof input.summary === "object" ? input.summary : {};
  const mat = input.materialAnalysis && typeof input.materialAnalysis === "object" ? input.materialAnalysis : {};
  const j = input.aiJudgment && typeof input.aiJudgment === "object" ? input.aiJudgment : {};

  const events = Array.isArray(input.upcomingEvents)
    ? input.upcomingEvents
        .map((e) => ({
          type: normalizeEventType(e && e.type),
          content: sanitizeStr((e && (e.title || e.label || e.content)) || ""),
          date: sanitizeStr(e && e.date),
        }))
        .filter((e) => e.content)
    : [];

  const materialItems = Array.isArray(mat.materials)
    ? mat.materials
        .slice(0, 4)
        .map((it) => {
          const strengthNorm = normalizeStrength(it && it.strength);
          const reflectionPctRaw = toNum(it && it.reflectionPct);
          return {
            name: sanitizeStr(it && it.name),
            strength: strengthNorm,
            reflectionPct:
              reflectionPctRaw == null ? null : Math.max(0, Math.min(100, Math.round(reflectionPctRaw))),
            reflectionNote: "",
            judgment: stripCitations(sanitizeStr(it && (it.comment || it.judgment))),
          };
        })
        .filter((it) => it.name)
    : [];

  const scenarios = [
    mapScenarioRaw(j.scenarioA, "A", "강세"),
    mapScenarioRaw(j.scenarioB, "B", "중립"),
    mapScenarioRaw(j.scenarioC, "C", "약세"),
  ]
    .filter(Boolean)
    .filter((s) => s.condition || s.strategy);

  const prices = resolveOpinionPrices(j.entryPrice ?? j.entry, j.stopLoss ?? j.stop, j.target, null);

  return {
    summary: {
      signal: mapDirectionToSignal(summary.direction || summary.signal),
      probability: toNum(summary.confidence ?? summary.probability),
      description: sanitizeStr(summary.reason || summary.description),
    },
    story: stripCitations(sanitizeStr(input.priceReason || input.story)),
    supply: stripCitations(sanitizeStr(input.supplyDemand || input.supply)),
    events,
    materials: {
      items: materialItems,
      unreflected: stripCitations(sanitizeStr(mat.unreflected || "")),
      summary: stripCitations(sanitizeStr(mat.aiComment || mat.summary || "")),
    },
    chart: stripCitations(sanitizeStr(input.chartAnalysis || input.chart)),
    opinion: {
      short: sanitizeStr(j.shortTerm || j.short) || "단기 전망 정보가 없습니다.",
      mid: sanitizeStr(j.midTerm || j.mid) || "중기 전망 정보가 없습니다.",
      long: sanitizeStr(j.longTerm || j.long) || "장기 전망 정보가 없습니다.",
      entry: prices.entry,
      stop: prices.stop,
      target: prices.target,
      comment: stripCitations(sanitizeStr(j.aiComment || j.comment)),
      scenarios,
    },
  };
}

function parseAnalysisFromResponse(msg) {
  const toolInput = extractStockAnalysisToolUse(msg);
  if (toolInput) {
    const mapped = mapToolInputToLegacy(toolInput);
    if (mapped) return mapped;
  }
  const fullText = extractTextFromContent(msg);
  return safeParseJSON(fullText);
}

async function messagesCreateWithPause(client, options, maxPauseTurns = 4) {
  let messages = [...(options.messages || [])];
  const { messages: _omit, ...rest } = options;
  let response = null;

  for (let turn = 0; turn <= maxPauseTurns; turn++) {
    const toolChoice =
      turn >= maxPauseTurns ? { type: "tool", name: "stock_analysis" } : { type: "auto" };
    response = await client.messages.create({
      ...rest,
      tools: ANALYSIS_TOOLS,
      tool_choice: toolChoice,
      messages,
    });
    logContentBlocks(response);

    if (extractStockAnalysisToolUse(response)) break;
    if (!response || response.stop_reason !== "pause_turn") break;

    console.log("[analyze] pause_turn — continuing", turn + 1);
    messages = messages.concat([{ role: "assistant", content: response.content }]);
  }

  return response;
}

function normalizeSignal(v) {
  const s = sanitizeStr(v);
  if (s === "매수" || s === "관망" || s === "회피") return s;
  return "관망";
}

function normalizeAnalysis(raw, quote) {
  const price = toNum(quote && quote.currentPrice) || 0;
  if (!raw || typeof raw !== "object") {
    return {
      summary: {
        signal: "관망",
        probability: 50,
        description: "분석을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      },
      story: "",
      supply: "",
      events: [],
      materials: { items: [], unreflected: "", summary: "" },
      chart: "",
      opinion: {
        short: "",
        mid: "",
        long: "",
        entry: price,
        stop: 0,
        target: 0,
        comment: "",
        scenarios: [],
      },
      _error: true,
    };
  }

  const summary = raw.summary && typeof raw.summary === "object" ? raw.summary : {};
  const probRaw = toNum(summary.probability);
  const probability =
    probRaw == null ? 50 : Math.max(0, Math.min(100, Math.round(probRaw)));

  const todayISO = seoulTodayISO();
  const events = Array.isArray(raw.events)
    ? raw.events
        .filter((e) => e && typeof e === "object")
        .map((e) => ({
          type: normalizeEventType(e.type),
          content: sanitizeStr(e.content),
          date: sanitizeStr(e.date),
        }))
        .filter((e) => e.content)
        // 종목분석 시점(오늘) 이전 날짜가 명시된 이벤트는 "다가오는 이벤트"가 아니므로 제거.
        // 날짜를 특정할 수 없는 모호한 표현("2026년 하반기 예정" 등)은 그대로 통과시킨다.
        .filter((e) => !isPastEventDate(e.date, todayISO))
    : [];

  const materialsRaw = raw.materials && typeof raw.materials === "object" ? raw.materials : {};
  const materialItems = Array.isArray(materialsRaw.items)
    ? materialsRaw.items
        .filter((it) => it && typeof it === "object")
        .slice(0, 4)
        .map((it) => {
          const strengthNorm = normalizeStrength(it.strength);
          const reflectionPctRaw = toNum(it.reflectionPct ?? it.reflection_pct);
          const reflectionPct =
            reflectionPctRaw == null
              ? null
              : Math.max(0, Math.min(100, Math.round(reflectionPctRaw)));
          return {
            name: sanitizeStr(it.name),
            strength: strengthNorm,
            reflectionPct,
            reflectionNote: sanitizeStr(it.reflectionNote ?? it.reflection_note),
            judgment: stripCitations(sanitizeStr(it.judgment)),
          };
        })
        .filter((it) => it.name)
    : [];

  const opinion = raw.opinion && typeof raw.opinion === "object" ? raw.opinion : {};

  const prices = resolveOpinionPrices(opinion.entry, opinion.stop, opinion.target, price);

  const scenarios = Array.isArray(opinion.scenarios)
    ? opinion.scenarios
        .filter((s) => s && typeof s === "object")
        .map((s) => ({
          label: sanitizeStr(s.label) || "A",
          type: sanitizeStr(s.type) || "중립",
          condition: sanitizeStr(s.condition),
          entry: toNum(s.entry),
          target: toNum(s.target),
          stop: toNum(s.stop),
          strategy: sanitizeStr(s.strategy),
          targetLow: toNum(s.targetLow ?? s.target_low),
          probability: toNum(s.probability),
        }))
        .filter((s) => s.condition || s.strategy)
        // AI가 스키마 예시값(0)을 그대로 남겨서 entry/target/stop이 비는 경우를 방지하는 안전망.
        .map((s) => {
          const resolved = resolveScenarioPrices(s, price, prices);
          return { ...s, ...resolved };
        })
    : [];

  // ── 2026-07-09: 시나리오 확률 정합성 보정 ──
  // A/B/C 확률 합이 100에서 벗어나면 비례 배분해서 정확히 100으로 맞춘다.
  const scenarioProbSum = scenarios.reduce((sum, s) => sum + (toNum(s.probability) || 0), 0);
  if (scenarios.length >= 2 && scenarioProbSum > 0 && Math.abs(scenarioProbSum - 100) > 1) {
    let running = 0;
    scenarios.forEach((s, idx) => {
      if (idx === scenarios.length - 1) {
        s.probability = Math.max(0, 100 - running);
      } else {
        const p = Math.round(((toNum(s.probability) || 0) / scenarioProbSum) * 100);
        s.probability = p;
        running += p;
      }
    });
  }

  // ── 2026-07-09: 상단 "상승확률" ↔ 시나리오 A(강세) 확률 정합성 보정 ──
  // 기존엔 summary.probability(상단 배지 숫자)를 AI가 시나리오와 무관하게 별도로 생성해서,
  // 같은 리포트 안에서 "상승 확률 74%" vs "A안(강세) 40%"처럼 숫자가 서로 어긋나는
  // 신뢰도 문제가 있었다. 상단 "상승확률"의 정의를 "강세 시나리오(A)가 실현될 확률"로
  // 고정하고, 시나리오 A 확률이 있으면 그 값으로 강제 통일한다.
  const scenarioA = scenarios.find(
    (s) => s.label === "A" || String(s.type).includes("강")
  );
  const scenarioAProb = scenarioA ? toNum(scenarioA.probability) : null;
  const finalProbability =
    scenarioAProb == null ? probability : Math.max(0, Math.min(100, Math.round(scenarioAProb)));

  // 2026-07-09: 52주 고점/저점 괴리가 크면 "데이터 오류일 수 있다"고 자동으로 의심하는
  // caveat을 붙였었는데, 실제로 종목이 정당하게 몇 배씩 급등/급락한 경우(예: 테마 급등주)
  // 에는 근거 없이 정확한 데이터를 의심하게 만드는 것이라 오히려 신뢰를 깎는 기능이었다.
  // 가격 데이터만으로 "진짜 급등인지 오류인지" 구분할 방법이 없으므로 제거한다 — 확인 안 된
  // 것을 확인된 것처럼 단정하지 않는다는 원칙은 "의심"에도 동일하게 적용돼야 한다.
  const chartText = stripCitations(sanitizeStr(raw.chart));

  return {
    summary: {
      signal: normalizeSignal(summary.signal),
      probability: finalProbability,
      description: sanitizeStr(summary.description) || "요약 정보가 없습니다.",
    },
    story: stripCitations(sanitizeStr(raw.story)),
    supply: stripCitations(sanitizeStr(raw.supply)),
    events,
    materials: {
      items: materialItems,
      unreflected: stripCitations(sanitizeStr(materialsRaw.unreflected)),
      summary: stripCitations(sanitizeStr(materialsRaw.summary)),
    },
    chart: chartText,
    opinion: {
      short: sanitizeStr(opinion.short) || "단기 전망 정보가 없습니다.",
      mid: sanitizeStr(opinion.mid) || "중기 전망 정보가 없습니다.",
      long: sanitizeStr(opinion.long) || "장기 전망 정보가 없습니다.",
      entry: prices.entry,
      stop: prices.stop,
      target: prices.target,
      comment: stripCitations(sanitizeStr(opinion.comment)),
      scenarios,
    },
  };
}

function claudeModelCandidates() {
  const envModel = sanitizeStr(process.env.ANTHROPIC_MODEL);
  if (envModel === CLAUDE_MODEL) return [CLAUDE_MODEL];
  return [CLAUDE_MODEL];
}

function buildUserPrompt(quote, stockName, today, indicators, wm) {
  const name = stockName || quote.stockName || quote.stockCode;
  const year = seoulYear();
  const ind = indicators && typeof indicators === "object" ? indicators : {};
  const ma20 = toNum(ind.ma20);
  const ma60 = toNum(ind.ma60);
  const ma120 = toNum(ind.ma120);
  const ma200 = toNum(ind.ma200);
  const rsi14 = toNum(ind.rsi14);
  const fmtMa = (n) => (n == null ? "—" : `${Math.round(n).toLocaleString("ko-KR")}`);
  const fmtRsi = (n) => (n == null ? "—" : String(n));
  const indicatorBlock =
    ma20 != null || ma60 != null || ma120 != null || ma200 != null || rsi14 != null
      ? [
          "",
          "실제 기술적 지표 (추정 금지, 아래 수치만 사용):",
          `20일선: ${fmtMa(ma20)}원 / 60일선: ${fmtMa(ma60)}원`,
          `120일선: ${fmtMa(ma120)}원 / 200일선: ${fmtMa(ma200)}원`,
          `RSI(14): ${fmtRsi(rsi14)}`,
        ].join("\n")
      : "";
  const wmBlock = formatWmTextBlock(wm);
  return [
    `오늘은 ${today}입니다. 모든 분석은 이 시점 기준으로 작성하세요.`,
    `분석 종목: ${name} (${quote.stockCode})`,
    "",
    "【필수】 web_search 2~4회 — JSON 작성 전 반드시 실행:",
    `- 검색1 (한국어): "${name} 일정 예정 ${year}"`,
    `- 검색2 (영어): "[${name}의 영문기업명 또는 CEO명] schedule event ${year}" (영문명/CEO명 추정 가능하면 사용)`,
    "- 입력 데이터의 foreignNetBuy/institutionNetBuy가 null이면 검색3으로 '[종목명] 외국인 기관 순매수 오늘'을 추가 검색.",
    `- 검색4: "${name} 목표주가 컨센서스"로 증권사 평균 목표주가를 확인해 2번 story에 현재가 대비 괴리율과 함께 반영. 확인 안 되면 생략.`,
    "- 검색 결과를 2번 story, 3번 supplyDemand, 4번 events, 5번 materials(재료 분석)에 반드시 반영.",
    "- 학습데이터·과거 기억 금지. web_search 확인 정보만 사용.",
    "",
    `3번 수급 분석(supplyDemand) 규칙 (반드시 준수):
- foreignNetBuy(외국인 순매수), institutionNetBuy(기관 순매수) 값이 입력 데이터에 있으면 그 수치로 서술.
- 값이 null이면 web_search로 당일(장중이면 직전 거래일) 실제 수급 데이터를 찾아 확정적으로 서술.
- "정보가 제공되지 않아 단정하기 어렵습니다" 같은 문장 절대 금지.`,
    "",
    `4번 다가오는 이벤트 규칙 (반드시 준수):
- upcomingEvents에는 검색으로 날짜·사실관계가 명확히 확인된 것만 포함. 애매하면 배열에서 제외(추측성 항목 금지).
- 오늘은 ${today} 이다. 이 날짜 이후 미래 이벤트만. 2024·2025년 날짜 금지, 2026년 이후만.
- '예정/방문 예정/출시 예정/발표 예정/~할 계획/~에 참석' 키워드만. 과거형 금지.
- 웹검색으로 다음 실적발표일 등이 명확히 확인되면 채우고, 확인 안 되면 무리해서 채우지 말 것.
- 이벤트가 정말 하나도 확인되지 않으면 배열을 비우지 말고
  [{ label:'정보없음', title:'현재 확인된 예정 이벤트 없음', date:'', type:'neutral' }] 하나만 넣을 것`,
    "",
    `5번 재료 분석 — web_search 기반 (반드시 준수):
- materialAnalysis.materials는 반드시 2개 이상 채울 것.
- 웹검색 결과에서 해당 종목 관련 재료를 찾아서 채워줘.
- 재료가 없으면 기본 재료로 채울 것: 실적 모멘텀(다음 실적발표 예상치), 업종 트렌드(해당 업종 흐름).
- strength는 반드시 '강'/'중'/'하', reflectionPct는 0-100 숫자.`,
    "",
    "6번 차트 — 제공된 실제 수치만 사용. MA20/60/120/200, RSI, 일목, 지지·저항 1·2차, 52주 고저는 기존과 동일. weeklyIndicators/monthlyIndicators가 있으면 주봉·월봉 MA/스윙 지지·저항으로 장기 추세·멀티 타임프레임 정합성·엘리어트 파동·ICT 유동성 관점까지 서술. 근거가 부족한 세부 항목(예: 정확한 파동 번호)은 \"미확보/판단 보류\" 같은 문구로 고객에게 노출하지 말고 조용히 생략하거나 정성적 표현으로 대체할 것. 숫자 추정 금지.",
    "",
    `7번 AI 주관적 판단 (aiJudgment 필수 — 하위 필드 절대 누락 금지):
- shortTerm, midTerm, longTerm: 문자열 필수
- entryPrice, stopLoss, target: 숫자 필수(0 금지). 현재가 ${quote.currentPrice || "—"}원 기준
  entryPrice=현재가±1~2%, stopLoss=entry-3~5%, target=entry+10~20%
- scenarioA/B/C 모두 entry(진입가)/stopLoss(손절가)를 숫자로 반드시 채울 것(0 금지):
  scenarioB.entry는 현재가 근방, target=entry+5~8%, stopLoss=entry-3~5%
  scenarioC.entry는 downTarget 근방 재진입가 개념, stopLoss=entry-3% 근방
- scenarioA/B/C probability 합 100, aiComment 3문장 이상(entryPrice가 현재가·시나리오B entry와 다른 이유 포함)
- 5번 재료 반영 필수`,
    "",
    "web_search 2회 후 stock_analysis 도구로 결과를 반환하세요.",
    "summary.direction=매수|관망|회피, summary.confidence=상승확률(0~100).",
    indicatorBlock,
    wmBlock,
    "",
    "입력 데이터:",
    JSON.stringify({
      stockName: name,
      stockCode: quote.stockCode,
      market: quote.market,
      currentPrice: quote.currentPrice,
      changeAmt: quote.changeAmt,
      changeRate: quote.changeRate,
      volume: quote.volume,
      prevVolume: quote.prevVolume,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      prevClose: quote.prevClose,
      high52w: quote.high52w,
      low52w: quote.low52w,
      creditRate: quote.creditRate,
      per: quote.per,
      pbr: quote.pbr,
      foreignNetBuy: quote.foreignNetBuy,
      institutionNetBuy: quote.institutionNetBuy,
      foreignHoldRate: quote.foreignHoldRate,
      volTurnoverRate: quote.volTurnoverRate,
      ...wmJsonFields(wm),
      analysisDate: today,
    }),
  ].join("\n");
}

async function claudeAnalyze(quote, stockName, indicators, wm) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: requireAnthropicKey() });
  const today = todayKoreaLabel();
  const user = buildUserPrompt(quote, stockName, today, indicators, wm);
  const system = buildSystemPrompt(today);

  let lastErr = null;
  for (const model of claudeModelCandidates()) {
    try {
      const msg = await messagesCreateWithPause(
        client,
        {
          model,
          max_tokens: 3500,
          temperature: 0.25,
          system,
          messages: [{ role: "user", content: user }],
        },
        4
      );

      const parsed = parseAnalysisFromResponse(msg);
      if (parsed == null) {
        const fallbackText = extractTextFromContent(msg && msg.content);
        console.error("[analyze] raw response (500 chars):", String(fallbackText || "").slice(0, 500));
        throw new Error(ANALYSIS_PARSE_ERROR_MSG);
      }
      const normalized = normalizeAnalysis(parsed, quote);
      if (normalized._error) {
        throw new Error("Claude JSON parse failed");
      }
      console.log("[analyze] Claude ok", model, "stop_reason=", msg && msg.stop_reason);
      return normalized;
    } catch (e) {
      lastErr = e;
      console.warn("[analyze] Claude model failed", model, e && e.message);
    }
  }

  const err = new Error((lastErr && lastErr.message) || "Claude analysis failed");
  err.cause = lastErr;
  throw err;
}

/** OpenAI Responses API 1회 호출 (내부 헬퍼). forceSearch=true면 tool_choice로 web_search를
 * 강제 시도한다 (일부 모델/버전 조합에서는 tool_choice 강제 자체가 400으로 거부될 수 있어
 * 그 경우엔 호출부에서 forceSearch=false로 재시도한다). 응답 원본(JSON)을 그대로 반환한다. */
async function callOpenAIResponsesOnce(system, user, apiKey, model, forceSearch) {
  const body = {
    model,
    tools: [{ type: "web_search", search_context_size: "medium" }],
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (forceSearch) body.tool_choice = { type: "web_search" };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`OpenAI Responses HTTP ${res.status}: ${errText.slice(0, 300)}`);
    err.statusCode = res.status;
    throw err;
  }
  return res.json();
}

/** OpenAI Responses API + web_search 툴을 사용하는 실시간 검색 기반 분석 경로.
 * Claude와 마찬가지로 실제 웹검색을 수행해서, 이미 지난 사건(예: 실적발표 완료)을
 * "예정"으로 잘못 서술하는 것을 방지한다.
 *
 * 2026-07-08 패치: 같은 종목을 짧은 간격으로 두 번 분석했을 때 결과가 들쭉날쭉했던
 * 원인 — web_search는 "auto" 모드라 모델이 검색을 하기도 하고 안 하기도 했음(그날그날
 * 다름). 이제는 (1) tool_choice로 검색을 강제 시도 → (2) 강제가 거부되면(모델이 tool_choice
 * 강제를 지원 안 하는 경우) auto 모드로 한 번 더 시도 → (3) 두 시도 모두 응답에 실제
 * web_search_call 흔적이 없으면 "검색 안 한 답변"으로 간주해 신뢰하지 않고 예외를 던져서
 * 호출부(openaiAnalyze)가 RSS 기반 폴백으로 넘어가게 한다. 즉 매 호출마다 반드시
 * "실검색" 또는 "RSS 헤드라인" 둘 중 하나의 실제 최신 정보를 근거로 쓰도록 강제해서
 * 호출할 때마다 결과가 달라지는 문제를 없앤다. */
async function openaiWebSearchAnalyze(quote, stockName, indicators, today, apiKey, model, wm) {
  const name = stockName || quote.stockName || quote.stockCode;
  const ind = indicators && typeof indicators === "object" ? indicators : {};

  const system =
    ANALYST_PERSONA_RULES + "\n\n" +
    "web_search 도구를 이번 요청에서 반드시 최소 1회, 필요하면 여러 번 호출해서, 이 종목의 최신 뉴스와 수급 데이터를 확인한 뒤에만 답하세요.\n" +
    "검색을 호출하지 않고 답하는 것은 허용되지 않습니다.\n" +
    "특히 실적발표·이벤트·재료는 검색 결과로 '이미 발표/발생했는지'를 반드시 먼저 확인하고,\n" +
    "이미 끝난 일을 절대 '예정'이나 '기대'로 서술하지 마세요 (예: 실적발표가 이미 나왔다면 그 결과를 반영하고,\n" +
    "다음 분기 실적발표만 새로운 다가오는 이벤트로 표기).\n" +
    "입력 데이터의 foreignNetBuy/institutionNetBuy가 null이면 web_search로 당일(또는 직전 거래일) 실제 외국인/기관 순매수 데이터를 찾아서 사용하세요 — 정보 없다고 얼버무리지 마세요.\n" +
    "일반 투자자도 이해할 수 있는 언어로 작성하세요.\n" +
    "최종 답변은 반드시 JSON 형식으로만 응답하고 다른 텍스트(설명, 코드블록 등)는 절대 포함하지 마세요.";

  const user = [
    `오늘은 ${today}입니다. 분석 종목: ${name} (${quote.stockCode})`,
    "web_search로 이 종목의 최신 뉴스·공시·실적발표 여부를 반드시 검색해서 확인한 뒤 답하세요. 이번 요청에서 검색 도구 호출은 필수입니다.",
    "검색 없이 학습된 과거 지식만으로 답하지 마세요. 아래 데이터를 받아서 반드시 JSON 형식으로만 응답하세요.",
    "코드블록(```) 금지, 설명 문장 금지, JSON 외 문자 금지. 답변 텍스트 안에 URL·도메인명·출처 표기도 절대 포함하지 말 것.",
    "",
    `supply(수급 분석) 작성 규칙 — 반드시 준수:
- 입력 데이터에 foreignNetBuy/institutionNetBuy 값이 있으면 그 수치로 서술.
- 값이 null이면 web_search로 "[종목명] 외국인 기관 순매수 오늘" 등을 검색해서 실제 데이터를 찾아 확정적으로 서술.
- "정보가 제공되지 않아 단정하기 어렵습니다" 같은 문장 절대 금지.`,
    "",
    `events(다가오는 이벤트) 작성 규칙 — 반드시 준수:
- 오늘은 ${today}이다. 검색으로 날짜·사실관계가 명확히 확인된, 이 날짜 이후(오늘 포함)에 아직 일어나지 않은 일정만 포함할 것.
- 확인이 애매하거나 안 된 건은 이벤트로 넣지 말고 배열에서 제외할 것 (미확정 사실을 "아직 확인 안 됨" 같은 문구로 이벤트화하지 말 것).
- 검색 결과 이미 발표/발생한 것으로 확인되면(실적발표 포함) 그 사건은 이벤트에 넣지 말고 story/supply/materials에 결과로 반영할 것.
- 정확한 날짜를 모르면 '2026-07-15' 같은 구체적 날짜 대신 '2026년 하반기 예정'처럼 모호하게 표기.`,
    "",
    `opinion.scenarios 작성 규칙 — 반드시 준수:
- A/B/C 시나리오 전부 entry와 stop을 반드시 숫자로 채울 것. 0이나 빈 값 금지.
- B(중립).entry는 현재가 근방, target=entry의 +5~8%, stop=entry의 -3~5%로 계산.
- C(약세).entry는 targetLow 근방의 재진입 고려가, stop=entry의 -3% 근방으로 계산.
- entry/target/stop은 반드시 현재가와 스토리에 맞는 합리적인 숫자로 채울 것 (스키마의 0은 예시일 뿐, 실제 값을 계산해서 넣을 것).`,
    "",
    `chart(차트 흐름 분석) 작성 규칙 — 반드시 준수:
- MA20/60/120/200, RSI, 일목, 지지·저항 1·2차, 52주 고저는 기존과 동일하게 작성할 것.
- 입력 데이터에 weeklyIndicators가 있으면 20주선/60주선 대비 현재가 위치와 주봉 스윙 저항·지지(resistances/supports)를 지지·저항 구조로 서술할 것.
- 입력 데이터에 monthlyIndicators가 있으면 12개월선/24개월선 대비 현재가 위치로 장기 추세(정배열/역배열)를 판단하고 월봉 스윙 저항·지지를 장기 지지·저항으로 서술할 것.
- 일봉·주봉·월봉 추세가 같은 방향인지 한 문장으로 비교 판단할 것.
- 엘리어트 파동은 weeklyIndicators/monthlyIndicators의 스윙 저항·지지 순서가 있으면 그 근거로 서술하고, 데이터가 불충분해 파동 번호를 특정하기 어려우면 "미확보"나 "판단 보류" 같은 내부 사정을 고객에게 노출하지 말고 파동 번호 언급 없이 정성적 표현으로 자연스럽게 넘어갈 것 (임의의 파동 번호·가격 금지).
- ICT(스마트머니) 관점은 제공된 지지·저항 구간을 유동성(liquidity) 구간으로만 짧게 해석하고, 데이터에 없는 오더블록/FVG 가격을 새로 만들어내지 말 것.
- weeklyIndicators/monthlyIndicators가 모두 없으면 이 항목들은 언급 자체를 생략하고 일봉 중심 분석만으로 자연스럽게 마무리할 것 ("데이터 없음" 같은 문구를 고객에게 노출하지 말 것).`,
    "",
    CLAUDE_RESPONSE_SCHEMA,
    "",
    "입력 데이터:",
    JSON.stringify({
      stockName: name,
      stockCode: quote.stockCode,
      market: quote.market,
      currentPrice: quote.currentPrice,
      changeAmt: quote.changeAmt,
      changeRate: quote.changeRate,
      volume: quote.volume,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      prevClose: quote.prevClose,
      high52w: quote.high52w,
      low52w: quote.low52w,
      creditRate: quote.creditRate,
      per: quote.per,
      pbr: quote.pbr,
      foreignNetBuy: quote.foreignNetBuy,
      institutionNetBuy: quote.institutionNetBuy,
      ma20: toNum(ind.ma20),
      ma60: toNum(ind.ma60),
      ma120: toNum(ind.ma120),
      ma200: toNum(ind.ma200),
      rsi14: toNum(ind.rsi14),
      ...wmJsonFields(wm),
    }),
  ].join("\n");

  const hasSearchEvidence = (d) => {
    const outputs = Array.isArray(d && d.output) ? d.output : [];
    return outputs.some((o) => o && o.type === "web_search_call");
  };

  let data = null;

  // 1차: tool_choice로 web_search 강제 시도.
  try {
    data = await callOpenAIResponsesOnce(system, user, apiKey, model, true);
  } catch (e) {
    console.warn("[analyze] web_search 강제(tool_choice) 실패 — auto 모드로 재시도", e && e.message);
    data = null;
  }

  // 2차: 강제 호출이 (a) 에러로 실패했거나 (b) 성공했지만 실제로는 검색을 안 한 경우,
  // auto 모드로 한 번 더 시도한다. 강제 호출이 성공하고 검색 흔적도 있으면 그대로 사용.
  if (!data || !hasSearchEvidence(data)) {
    data = await callOpenAIResponsesOnce(system, user, apiKey, model, false);
  }

  if (!hasSearchEvidence(data)) {
    // 두 번 다 검색을 안 했다면 최신 정보 없이 학습 당시 지식으로만 답했다는 뜻 — 신뢰하지
    // 않고 호출부가 RSS 폴백으로 넘어가도록 예외를 던진다. 이게 "호출할 때마다 결과가
    // 달라지는" 문제의 근본 원인이었다.
    throw new Error("OpenAI web_search 미실행 — 검색 없이 응답함");
  }

  const outputs = Array.isArray(data && data.output) ? data.output : [];

  const msgItem = outputs.find((o) => o && o.type === "message");
  const contentArr = msgItem && Array.isArray(msgItem.content) ? msgItem.content : [];
  const textBlock = contentArr.find((c) => c && (c.type === "output_text" || c.type === "text"));
  const text = (textBlock && textBlock.text) || sanitizeStr(data && data.output_text) || "";
  if (!text) throw new Error("OpenAI web_search 응답에 텍스트가 없습니다");
  return text;
}

/** Claude(웹서치 포함) 실패 시(토큰 소진 등) 자동 폴백되는 OpenAI 분석 경로.
 * 1순위: Responses API + web_search 툴로 실시간 검색 기반 분석 (실적발표 등 이미 지난
 * 사건을 "예정"으로 잘못 쓰는 것을 방지). 실패하면(모델/툴 미지원 등) 구글 뉴스
 * RSS(무료) 헤드라인 기반 경로로 자동 폴백한다.
 * 응답 스키마는 CLAUDE_RESPONSE_SCHEMA(레거시 포맷)와 동일하게 맞춰서
 * normalizeAnalysis()를 그대로 재사용한다 (프론트엔드 기대 형태 100% 동일). */
async function openaiAnalyze(quote, stockName, indicators, today, wm) {
  const apiKey = requireOpenAIKey();
  const model = sanitizeStr(process.env.OPENAI_MODEL) || "gpt-5.4-mini";
  const name = stockName || quote.stockName || quote.stockCode;

  let text = null;
  try {
    text = await openaiWebSearchAnalyze(quote, stockName, indicators, today, apiKey, model, wm);
    console.log("[analyze] OpenAI web_search 경로 사용");
  } catch (e) {
    console.warn("[analyze] OpenAI web_search 실패 — RSS 폴백으로 전환", e && e.message);
  }

  if (!text) {
    const news = await fetchStockNews(name, 6);
    const newsBlock = news.length
      ? "\n\n최신 뉴스 헤드라인(구글뉴스, 참고용):\n" +
        news.map((n) => `- ${n.title} (${n.source})`).join("\n")
      : "\n\n(최신 뉴스 헤드라인을 가져오지 못했습니다. 제공된 시세/지표만으로 판단하세요.)";

    const ind = indicators && typeof indicators === "object" ? indicators : {};
    const system =
      ANALYST_PERSONA_RULES + "\n\n" +
      "제공된 데이터와 아래 뉴스 헤드라인을 기반으로 분석하되\n" +
      "일반 투자자도 이해할 수 있는 언어로 작성하세요.\n" +
      "반드시 JSON 형식으로만 응답하고\n" +
      "다른 텍스트는 절대 포함하지 마세요.";

    const user = [
      `오늘은 ${today}입니다. 분석 종목: ${name} (${quote.stockCode})`,
      "아래 데이터를 받아서 반드시 JSON 형식으로만 응답하세요.",
      "코드블록(```) 금지, 설명 문장 금지, JSON 외 문자 금지. 답변 텍스트 안에 URL·도메인명·출처 표기도 절대 포함하지 말 것.",
      "",
      `supply(수급 분석) 작성 규칙 — 반드시 준수:
- foreignNetBuy/institutionNetBuy 값이 있으면 그 수치로 서술.
- 값이 null이면 거래량·가격 흐름 등 제공된 다른 데이터로 수급 상황을 확정적으로 해석해서 서술할 것.
- "수급 정보가 제공되지 않아 단정하기 어렵습니다" 같은 문장은 절대 쓰지 말 것.`,
      "",
      `events(다가오는 이벤트) 작성 규칙 — 반드시 준수:
- 오늘은 ${today}이다. 뉴스로 날짜·사실관계가 명확히 확인된, 이 날짜 이후(오늘 포함)에 아직 일어나지 않은 일정만 포함할 것.
- 확인이 애매하거나 안 된 건은 이벤트로 넣지 말고 배열에서 제외할 것.
- 이미 지나간 날짜, 이미 벌어진 사건('했다/밝혔다/기록했다/하락했다' 등 과거형 서술)은 절대 이벤트로 넣지 말 것.
- 뉴스 헤드라인은 사건 발생 시점을 참고하는 용도로만 쓰고, 과거 사건 자체를 이벤트로 재작성하지 말 것.
- 정확한 날짜를 모르면 '2026-07-15' 같은 구체적 날짜 대신 '2026년 하반기 예정'처럼 모호하게 표기.`,
      "",
      `opinion.scenarios 작성 규칙 — 반드시 준수:
- A/B/C 시나리오 전부 entry와 stop을 반드시 숫자로 채울 것. 0이나 빈 값 금지.
- B(중립).entry는 현재가 근방, target=entry의 +5~8%, stop=entry의 -3~5%로 계산.
- C(약세).entry는 targetLow 근방의 재진입 고려가, stop=entry의 -3% 근방으로 계산.
- entry/target/stop은 반드시 현재가와 스토리에 맞는 합리적인 숫자로 채울 것 (스키마의 0은 예시일 뿐, 실제 값을 계산해서 넣을 것).`,
      "",
      `chart(차트 흐름 분석) 작성 규칙 — 반드시 준수:
- MA20/60/120/200, RSI, 일목, 지지·저항 1·2차, 52주 고저는 기존과 동일하게 작성할 것.
- 입력 데이터에 weeklyIndicators가 있으면 20주선/60주선 대비 현재가 위치와 주봉 스윙 저항·지지를 지지·저항 구조로 서술할 것.
- 입력 데이터에 monthlyIndicators가 있으면 12개월선/24개월선 대비 현재가 위치로 장기 추세(정배열/역배열)를 판단하고 월봉 스윙 저항·지지를 장기 지지·저항으로 서술할 것.
- 일봉·주봉·월봉 추세가 같은 방향인지 한 문장으로 비교 판단할 것.
- 엘리어트 파동은 weeklyIndicators/monthlyIndicators의 스윙 저항·지지 순서가 있으면 그 근거로 서술하고, 데이터가 불충분해 파동 번호를 특정하기 어려우면 "미확보"나 "판단 보류" 같은 내부 사정을 고객에게 노출하지 말고 파동 번호 언급 없이 정성적 표현으로 자연스럽게 넘어갈 것 (임의의 파동 번호·가격 금지).
- ICT(스마트머니) 관점은 제공된 지지·저항 구간을 유동성(liquidity) 구간으로만 짧게 해석하고, 데이터에 없는 오더블록/FVG 가격을 새로 만들어내지 말 것.
- weeklyIndicators/monthlyIndicators가 모두 없으면 이 항목들은 언급 자체를 생략하고 일봉 중심 분석만으로 자연스럽게 마무리할 것 ("데이터 없음" 같은 문구를 고객에게 노출하지 말 것).`,
      "",
      CLAUDE_RESPONSE_SCHEMA,
      newsBlock,
      "",
      "입력 데이터:",
      JSON.stringify({
        stockName: name,
        stockCode: quote.stockCode,
        market: quote.market,
        currentPrice: quote.currentPrice,
        changeAmt: quote.changeAmt,
        changeRate: quote.changeRate,
        volume: quote.volume,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        prevClose: quote.prevClose,
        high52w: quote.high52w,
        low52w: quote.low52w,
        creditRate: quote.creditRate,
        per: quote.per,
        pbr: quote.pbr,
        foreignNetBuy: quote.foreignNetBuy,
        institutionNetBuy: quote.institutionNetBuy,
        ma20: toNum(ind.ma20),
        ma60: toNum(ind.ma60),
        ma120: toNum(ind.ma120),
        ma200: toNum(ind.ma200),
        rsi14: toNum(ind.rsi14),
        ...wmJsonFields(wm),
      }),
    ].join("\n");

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const err = new Error(`OpenAI HTTP ${res.status}: ${errText.slice(0, 300)}`);
      err.statusCode = res.status;
      throw err;
    }

    const data = await res.json();
    text =
      (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  }

  const parsed = safeParseJSON(text);
  if (parsed == null) throw new Error("OpenAI returned non-JSON");
  const normalized = normalizeAnalysis(parsed, quote);
  if (normalized._error) throw new Error("OpenAI JSON parse failed");
  return normalized;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    const parsed = parseRequestBodyJson(req.body);
    if (parsed == null) throw new Error("Invalid JSON body");
    return parsed;
  }
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      const parsed = parseRequestBodyJson(data);
      if (parsed == null) {
        reject(new Error("Invalid JSON body"));
        return;
      }
      resolve(parsed);
    });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    json(res, 400, { error: e.message || "Invalid JSON body" });
    return;
  }

  if (supabaseConfigured()) {
    const token = bearerToken(req);
    const user = await getUserFromToken(token);
    if (!user) {
      json(res, 401, { error: "\uB85C\uADF8\uC778\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." });
      return;
    }
    const sub = await getSubscription(user.id);
    const isPro = sub.status === "active" && (sub.plan === "pro" || sub.plan === "premium");
    if (!isPro) {
      const allowed = await tryIncrementFreeUsage(user.id, currentMonthKeySeoul(), FREE_MONTHLY_LIMIT);
      if (!allowed) {
        json(res, 403, {
          error: `\uBB34\uB8CC \uD50C\uB79C\uC740 \uC774\uBC88 \uB2EC AI \uC885\uBAA9\uBD84\uC11D \uCCB4\uD5D8 ${FREE_MONTHLY_LIMIT}\uD68C\uB97C \uBAA8\uB450 \uC0AC\uC6A9\uD588\uC2B5\uB2C8\uB2E4. Pro\uB85C \uC5C5\uADF8\uB808\uC774\uB4DC\uD558\uBA74 \uBB34\uC81C\uD55C \uC774\uC6A9\uD558\uC2E4 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`,
          code: "USAGE_LIMIT",
        });
        return;
      }
    }
  }

  const code6 = normalizeCode6(body && body.code);
  const name = sanitizeStr(body && body.name);

  if (!/^\d{6}$/.test(code6)) {
    json(res, 400, { error: "code(6자리)가 필요합니다." });
    return;
  }

  let quote;
  // 주봉/월봉 데이터는 실패해도 전체 분석을 막지 않으므로(fetchKisWeeklyMonthly 내부에서
  // 이미 try/catch로 null 처리) 시세 조회와 병렬로 미리 시작해 지연시간을 아낀다.
  const wmPromise = fetchKisWeeklyMonthly(code6);
  try {
    quote = await fetchKisQuote(code6);
  } catch (e) {
    console.error("[analyze] KIS error", code6, e && e.message);
    json(res, (e && e.statusCode) || 502, { error: "시세 조회 실패" });
    return;
  }
  const wm = await wmPromise;

  const stockName = name || quote.stockName || code6;

  const indicators = {
    ma20: toNum(body && body.ma20),
    ma60: toNum(body && body.ma60),
    ma120: toNum(body && body.ma120),
    ma200: toNum(body && body.ma200),
    rsi14: toNum(body && body.rsi14),
  };
  if (body && body.indicators && typeof body.indicators === "object") {
    const bi = body.indicators;
    indicators.ma20 = toNum(bi.ma20) ?? indicators.ma20;
    indicators.ma60 = toNum(bi.ma60) ?? indicators.ma60;
    indicators.ma120 = toNum(bi.ma120) ?? indicators.ma120;
    indicators.ma200 = toNum(bi.ma200) ?? indicators.ma200;
    indicators.rsi14 = toNum(bi.rsi14) ?? indicators.rsi14;
  }

  let analysis;
  let analysisError = "";
  try {
    analysis = await claudeAnalyze(quote, stockName, indicators, wm);
  } catch (e) {
    const claudeErrMsg =
      e && e.message === ANALYSIS_PARSE_ERROR_MSG
        ? ANALYSIS_PARSE_ERROR_MSG
        : (e && e.message) || "Claude 분석 실패";
    console.error("[analyze] Claude error (OpenAI로 폴백 시도)", claudeErrMsg);
    try {
      analysis = await openaiAnalyze(quote, stockName, indicators, todayKoreaLabel(), wm);
      console.log("[analyze] OpenAI 폴백 성공");
    } catch (e2) {
      analysisError = claudeErrMsg;
      console.error("[analyze] OpenAI 폴백도 실패", e2 && e2.message);
      analysis = normalizeAnalysis(null, quote);
      if (analysisError === ANALYSIS_PARSE_ERROR_MSG && analysis.summary) {
        analysis.summary.description = ANALYSIS_PARSE_ERROR_MSG;
      }
    }
  }

  json(res, 200, {
    stockCode: code6,
    stockName,
    currentPrice: quote.currentPrice,
    changeAmt: quote.changeAmt,
    changeRate: quote.changeRate,
    high52w: quote.high52w,
    low52w: quote.low52w,
    marketCapRaw: quote.marketCapRaw || "",
    market: quote.market || "",
    pbr: quote.pbr == null ? null : quote.pbr,
    per: quote.per == null ? null : quote.per,
    analysis,
    analysisError: analysisError || undefined,
  });
};

module.exports.default = module.exports;