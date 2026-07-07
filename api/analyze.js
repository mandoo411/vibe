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

const DEFAULT_KIS_BASE = "https://openapi.koreainvestment.com:9443";

const WEB_SEARCH_TOOLS = [
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 2,
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

function buildSystemPrompt(today) {
  return [
    `오늘은 ${today}입니다. 모든 분석은 이 시점 기준으로 작성하세요. 학습데이터의 과거 정보가 아니라 web_search 결과의 최신 뉴스를 반드시 사용하세요.`,
    "당신은 한국 주식 전문 애널리스트입니다.",
    "JSON 작성 전 web_search를 정확히 2회 실행하세요. 검색 없이 답변하지 마세요.",
    "web_search 결과는 2번(story), 4번(events), 5번(materials 재료 분석)에 반드시 반영하세요.",
    "제공된 KIS 실시간 시세와 web_search 최신 뉴스만 근거로 분석하세요.",
    "일반 투자자도 이해할 수 있는 언어로 작성하세요.",
    "",
    `4번 다가오는 이벤트 규칙 (반드시 준수):
- upcomingEvents는 반드시 1개 이상 채울 것.
- 오늘은 ${today} 이다. 이 날짜 이후의 미래 이벤트만 포함할 것.
- 2024년, 2025년 날짜는 절대 포함 금지. 2026년 이후만 허용.
- 웹검색 결과에서 '예정' '방문 예정' '출시 예정' '발표 예정' '~할 계획' '~에 참석' 키워드가 있는 것만 선별.
- '했다' '밝혔다' '기록했다' '하락했다' 등 과거형은 절대 이벤트로 넣지 말 것.
- 웹검색에서 미래 이벤트가 없으면 아래 공식 일정으로 채워줘:
  · 삼성전자: 2분기 실적발표 (2026년 7월 말 예정)
  · LG전자: 2분기 실적발표 (2026년 7월 말 예정)
  · 그 외 종목: '[종목명] 다음 실적발표일'로 검색해서 채울 것
- 이벤트가 정말 없으면 배열을 비우지 말고
  [{ label:'정보없음', title:'현재 확인된 예정 이벤트 없음', date:'', type:'neutral' }] 로 채울 것
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
    `6번 차트 흐름 분석 — 제공된 실제 MA/RSI 수치만 사용(추정 금지). 아래 항목 전부 수치와 근거 포함:
① 이동평균선: 20일/60일/120일/200일선 대비 현재가 위치와 해석
② RSI: 제공된 RSI(14) 값 + 과매수/과매도 해석
③ 일목균형표: 전환선/기준선/구름대 위아래 여부
④ 지지선/저항선: 1차·2차 수치 명시
⑤ 전고점/전저점: 수치와 의미 (high52w/low52w 활용)
⑥ 엘리어트 파동: 현재 구간 추정 및 근거`,
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
  · aiComment: 반드시 3문장 이상
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
            judgment: sanitizeStr(it && (it.comment || it.judgment)),
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
    story: sanitizeStr(input.priceReason || input.story),
    supply: sanitizeStr(input.supplyDemand || input.supply),
    events,
    materials: {
      items: materialItems,
      unreflected: sanitizeStr(mat.unreflected || ""),
      summary: sanitizeStr(mat.aiComment || mat.summary || ""),
    },
    chart: sanitizeStr(input.chartAnalysis || input.chart),
    opinion: {
      short: sanitizeStr(j.shortTerm || j.short) || "단기 전망 정보가 없습니다.",
      mid: sanitizeStr(j.midTerm || j.mid) || "중기 전망 정보가 없습니다.",
      long: sanitizeStr(j.longTerm || j.long) || "장기 전망 정보가 없습니다.",
      entry: prices.entry,
      stop: prices.stop,
      target: prices.target,
      comment: sanitizeStr(j.aiComment || j.comment),
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
            judgment: sanitizeStr(it.judgment),
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

  return {
    summary: {
      signal: normalizeSignal(summary.signal),
      probability,
      description: sanitizeStr(summary.description) || "요약 정보가 없습니다.",
    },
    story: sanitizeStr(raw.story),
    supply: sanitizeStr(raw.supply),
    events,
    materials: {
      items: materialItems,
      unreflected: sanitizeStr(materialsRaw.unreflected),
      summary: sanitizeStr(materialsRaw.summary),
    },
    chart: sanitizeStr(raw.chart),
    opinion: {
      short: sanitizeStr(opinion.short) || "단기 전망 정보가 없습니다.",
      mid: sanitizeStr(opinion.mid) || "중기 전망 정보가 없습니다.",
      long: sanitizeStr(opinion.long) || "장기 전망 정보가 없습니다.",
      entry: prices.entry,
      stop: prices.stop,
      target: prices.target,
      comment: sanitizeStr(opinion.comment),
      scenarios,
    },
  };
}

function claudeModelCandidates() {
  const envModel = sanitizeStr(process.env.ANTHROPIC_MODEL);
  if (envModel === CLAUDE_MODEL) return [CLAUDE_MODEL];
  return [CLAUDE_MODEL];
}

function buildUserPrompt(quote, stockName, today, indicators) {
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
  return [
    `오늘은 ${today}입니다. 모든 분석은 이 시점 기준으로 작성하세요.`,
    `분석 종목: ${name} (${quote.stockCode})`,
    "",
    "【필수】 web_search 2회 — JSON 작성 전 반드시 실행:",
    `- 검색1 (한국어): "${name} 일정 예정 ${year}"`,
    `- 검색2 (영어): "[${name}의 영문기업명 또는 CEO명] schedule event ${year}" (영문명/CEO명 추정 가능하면 사용)`,
    "- 2회 검색 결과를 2번 story, 4번 events, 5번 materials(재료 분석)에 반드시 반영.",
    "- 학습데이터·과거 기억 금지. web_search 확인 정보만 사용.",
    "",
    `4번 다가오는 이벤트 규칙 (반드시 준수):
- upcomingEvents는 반드시 1개 이상 채울 것.
- 오늘은 ${today} 이다. 이 날짜 이후 미래 이벤트만. 2024·2025년 날짜 금지, 2026년 이후만.
- '예정/방문 예정/출시 예정/발표 예정/~할 계획/~에 참석' 키워드만. 과거형 금지.
- 웹검색에서 미래 이벤트가 없으면 아래 공식 일정으로 채워줘:
  · 삼성전자: 2분기 실적발표 (2026년 7월 말 예정)
  · LG전자: 2분기 실적발표 (2026년 7월 말 예정)
  · 그 외 종목: '[종목명] 다음 실적발표일'로 검색해서 채울 것
- 이벤트가 정말 없으면 배열을 비우지 말고
  [{ label:'정보없음', title:'현재 확인된 예정 이벤트 없음', date:'', type:'neutral' }] 로 채울 것`,
    "",
    `5번 재료 분석 — web_search 기반 (반드시 준수):
- materialAnalysis.materials는 반드시 2개 이상 채울 것.
- 웹검색 결과에서 해당 종목 관련 재료를 찾아서 채워줘.
- 재료가 없으면 기본 재료로 채울 것: 실적 모멘텀(다음 실적발표 예상치), 업종 트렌드(해당 업종 흐름).
- strength는 반드시 '강'/'중'/'하', reflectionPct는 0-100 숫자.`,
    "",
    "6번 차트 — 제공된 실제 MA/RSI 수치만 사용. MA20/60/120/200, RSI, 일목, 지지·저항 1·2차, 52주 고저, 엘리어트 파동 (수치·근거).",
    "",
    `7번 AI 주관적 판단 (aiJudgment 필수 — 하위 필드 절대 누락 금지):
- shortTerm, midTerm, longTerm: 문자열 필수
- entryPrice, stopLoss, target: 숫자 필수(0 금지). 현재가 ${quote.currentPrice || "—"}원 기준
  entryPrice=현재가±1~2%, stopLoss=entry-3~5%, target=entry+10~20%
- scenarioA/B/C 모두 entry(진입가)/stopLoss(손절가)를 숫자로 반드시 채울 것(0 금지):
  scenarioB.entry는 현재가 근방, target=entry+5~8%, stopLoss=entry-3~5%
  scenarioC.entry는 downTarget 근방 재진입가 개념, stopLoss=entry-3% 근방
- scenarioA/B/C probability 합 100, aiComment 3문장 이상
- 5번 재료 반영 필수`,
    "",
    "web_search 2회 후 stock_analysis 도구로 결과를 반환하세요.",
    "summary.direction=매수|관망|회피, summary.confidence=상승확률(0~100).",
    indicatorBlock,
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
      analysisDate: today,
    }),
  ].join("\n");
}

async function claudeAnalyze(quote, stockName, indicators) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: requireAnthropicKey() });
  const today = todayKoreaLabel();
  const user = buildUserPrompt(quote, stockName, today, indicators);
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

/** OpenAI Responses API + web_search 툴을 사용하는 실시간 검색 기반 분석 경로.
 * Claude와 마찬가지로 실제 웹검색을 수행해서, 이미 지난 사건(예: 실적발표 완료)을
 * "예정"으로 잘못 서술하는 것을 방지한다. 모델/툴 조합이 지원되지 않거나 실패하면
 * 예외를 던져서 호출부(openaiAnalyze)가 RSS 기반 폴백으로 넘어가게 한다. */
async function openaiWebSearchAnalyze(quote, stockName, indicators, today, apiKey, model) {
  const name = stockName || quote.stockName || quote.stockCode;
  const ind = indicators && typeof indicators === "object" ? indicators : {};

  const system =
    "당신은 한국 주식 전문 애널리스트입니다.\n" +
    "web_search 도구로 반드시 이 종목의 최신 뉴스를 검색해서, 확인된 사실만 근거로 답하세요.\n" +
    "특히 실적발표·이벤트·재료는 검색 결과로 '이미 발표/발생했는지'를 반드시 먼저 확인하고,\n" +
    "이미 끝난 일을 절대 '예정'이나 '기대'로 서술하지 마세요 (예: 실적발표가 이미 나왔다면 그 결과를 반영하고,\n" +
    "다음 분기 실적발표만 새로운 다가오는 이벤트로 표기).\n" +
    "일반 투자자도 이해할 수 있는 언어로 작성하세요.\n" +
    "최종 답변은 반드시 JSON 형식으로만 응답하고 다른 텍스트(설명, 코드블록 등)는 절대 포함하지 마세요.";

  const user = [
    `오늘은 ${today}입니다. 분석 종목: ${name} (${quote.stockCode})`,
    "web_search로 이 종목의 최신 뉴스·공시·실적발표 여부를 반드시 검색해서 확인한 뒤 답하세요.",
    "검색 없이 학습된 과거 지식만으로 답하지 마세요. 아래 데이터를 받아서 반드시 JSON 형식으로만 응답하세요.",
    "코드블록(```) 금지, 설명 문장 금지, JSON 외 문자 금지.",
    "",
    `events(다가오는 이벤트) 작성 규칙 — 반드시 준수:
- 오늘은 ${today}이다. 검색 결과로 확인한, 이 날짜 이후(오늘 포함)에 아직 일어나지 않은 일정만 포함할 것.
- 검색 결과 이미 발표/발생한 것으로 확인되면(실적발표 포함) 그 사건은 이벤트에 넣지 말고 story/supply/materials에 결과로 반영할 것.
- 정확한 날짜를 모르면 '2026-07-15' 같은 구체적 날짜 대신 '2026년 하반기 예정'처럼 모호하게 표기.`,
    "",
    `opinion.scenarios 작성 규칙 — 반드시 준수:
- A/B/C 시나리오 전부 entry와 stop을 반드시 숫자로 채울 것. 0이나 빈 값 금지.
- B(중립).entry는 현재가 근방, target=entry의 +5~8%, stop=entry의 -3~5%로 계산.
- C(약세).entry는 targetLow 근방의 재진입 고려가, stop=entry의 -3% 근방으로 계산.
- entry/target/stop은 반드시 현재가와 스토리에 맞는 합리적인 숫자로 채울 것 (스키마의 0은 예시일 뿐, 실제 값을 계산해서 넣을 것).`,
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
    }),
  ].join("\n");

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      tools: [{ type: "web_search", search_context_size: "medium" }],
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`OpenAI Responses HTTP ${res.status}: ${errText.slice(0, 300)}`);
    err.statusCode = res.status;
    throw err;
  }

  const data = await res.json();
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
async function openaiAnalyze(quote, stockName, indicators, today) {
  const apiKey = requireOpenAIKey();
  const model = sanitizeStr(process.env.OPENAI_MODEL) || "gpt-5.4-mini";
  const name = stockName || quote.stockName || quote.stockCode;

  let text = null;
  try {
    text = await openaiWebSearchAnalyze(quote, stockName, indicators, today, apiKey, model);
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
      "당신은 한국 주식 전문 애널리스트입니다.\n" +
      "제공된 데이터를 기반으로 분석하되\n" +
      "일반 투자자도 이해할 수 있는 언어로 작성하세요.\n" +
      "반드시 JSON 형식으로만 응답하고\n" +
      "다른 텍스트는 절대 포함하지 마세요.";

    const user = [
      `오늘은 ${today}입니다. 분석 종목: ${name} (${quote.stockCode})`,
      "아래 데이터를 받아서 반드시 JSON 형식으로만 응답하세요.",
      "코드블록(```) 금지, 설명 문장 금지, JSON 외 문자 금지.",
      "",
      `events(다가오는 이벤트) 작성 규칙 — 반드시 준수:
- 오늘은 ${today}이다. 이 날짜 이후(오늘 포함)에 아직 일어나지 않은 일정만 포함할 것.
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

  const code6 = normalizeCode6(body && body.code);
  const name = sanitizeStr(body && body.name);

  if (!/^\d{6}$/.test(code6)) {
    json(res, 400, { error: "code(6자리)가 필요합니다." });
    return;
  }

  let quote;
  try {
    quote = await fetchKisQuote(code6);
  } catch (e) {
    console.error("[analyze] KIS error", code6, e && e.message);
    json(res, (e && e.statusCode) || 502, { error: "시세 조회 실패" });
    return;
  }

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
    analysis = await claudeAnalyze(quote, stockName, indicators);
  } catch (e) {
    const claudeErrMsg =
      e && e.message === ANALYSIS_PARSE_ERROR_MSG
        ? ANALYSIS_PARSE_ERROR_MSG
        : (e && e.message) || "Claude 분석 실패";
    console.error("[analyze] Claude error (OpenAI로 폴백 시도)", claudeErrMsg);
    try {
      analysis = await openaiAnalyze(quote, stockName, indicators, todayKoreaLabel());
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
