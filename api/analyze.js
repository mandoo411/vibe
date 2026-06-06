/**
 * AI 종목분석 — Vercel Serverless Function
 * POST /api/analyze
 * body: { code: "005930", name: "삼성전자" }
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
        properties: {
          shortTerm: { type: "string" },
          midTerm: { type: "string" },
          longTerm: { type: "string" },
          entryPrice: { type: "number" },
          stopLoss: { type: "number" },
          target: { type: "number" },
          scenarioA: {
            type: "object",
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
            properties: {
              condition: { type: "string" },
              strategy: { type: "string" },
              downTarget: { type: "number" },
              probability: { type: "number" },
            },
          },
          aiComment: { type: "string" },
        },
      },
      signals: {
        type: "object",
        properties: {
          bullCount: { type: "number" },
          bearCount: { type: "number" },
        },
      },
    },
    required: ["summary", "priceReason", "supplyDemand", "chartAnalysis", "aiJudgment", "signals"],
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
- 오늘은 ${today} 이다. 이 날짜 이후의 미래 이벤트만 포함할 것.
- 2024년, 2025년 날짜는 절대 포함 금지. 2026년 이후만 허용.
- 웹검색 결과에서 '예정' '방문 예정' '출시 예정' '발표 예정' '~할 계획' '~에 참석' 키워드가 있는 것만 선별.
- '했다' '밝혔다' '기록했다' '하락했다' 등 과거형은 절대 이벤트로 넣지 말 것.
- 미래 이벤트가 없으면 솔직하게 '현재 확인된 예정 이벤트 없음'으로 표시.
- 이벤트 제목은 구체적으로: ❌'CEO 해외 일정' → ✅'젠슨황 방한 / 삼성 CEO 회동 예정'
- 날짜를 정확히 모르면 '2026년 하반기 예정' 식으로 표현.`,
    "",
    `5번 재료 분석 — web_search 결과 기반:
① 핵심 재료 목록(최대 4개): 재료명, 강도(상/중/하), 주가 반영도 0~100%, reflectionNote, judgment(한줄)
② unreflected: 미반영 핵심 재료 1~2개, 반영 예상 시점·조건
③ summary: AI 재료 종합 판단 3~5문장, 실제 트레이더 말투`,
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
- 단기(1-2주) / 중기(1-3개월) / 장기(6개월-1년) 전망 각각 상세히
- 시나리오 A (강세): 조건 / 진입가 / 목표가 / 손절가 / 확률%
- 시나리오 B (중립): 조건 / 진입가 / 목표가 / 손절가 / 확률%
- 시나리오 C (약세): 조건 / 대응전략 / 목표 하단 / 확률%
- 확률 합계는 반드시 100%
- AI 총평은 실제 트레이더 말투로 3-5문장
- 5번 재료 분석 결과를 반드시 반영 (예: '재료 미반영 구간이 크므로 A시나리오 확률 높게 책정')`,
    "",
    "8번 신호 요약: signals.bullCount/bearCount — 분석 근거 상승·하락 신호 개수",
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
        "strategy": "대응 전략",
        "targetLow": 0,
        "probability": 25
      }
    ]
  },
  "signals": { "up": 6, "down": 2 }
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

async function fetchKisQuote(code6) {
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
  const prevClose = toNum(o2.stck_prdy_clpr);
  const open = toNum(o2.stck_oprc) ?? toNum(o1.stck_oprc);
  const high = toNum(o2.stck_hgpr) ?? toNum(o1.stck_hgpr);
  const low = toNum(o2.stck_lwpr) ?? toNum(o1.stck_lwpr);
  const prevVolume = toNum(o2.prdy_vol);
  const creditRate = toNum(o2.crdt_rate);
  const foreignNetBuy = toNum(o1.frgn_ntby_qty ?? o1.frgn_ntby_vol);
  const institutionNetBuy = toNum(o1.orgn_ntby_qty ?? o1.orgn_ntby_vol);

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

function mapToolInputToLegacy(input) {
  if (!input || typeof input !== "object") return null;

  const summary = input.summary && typeof input.summary === "object" ? input.summary : {};
  const mat = input.materialAnalysis && typeof input.materialAnalysis === "object" ? input.materialAnalysis : {};
  const j = input.aiJudgment && typeof input.aiJudgment === "object" ? input.aiJudgment : {};
  const sig = input.signals && typeof input.signals === "object" ? input.signals : {};

  const events = Array.isArray(input.upcomingEvents)
    ? input.upcomingEvents
        .map((e) => ({
          type: sanitizeStr(e && e.type) === "악재" ? "악재" : "호재",
          content: sanitizeStr((e && (e.title || e.label || e.content)) || ""),
          date: sanitizeStr(e && e.date),
        }))
        .filter((e) => e.content)
    : [];

  const materialItems = Array.isArray(mat.materials)
    ? mat.materials
        .slice(0, 4)
        .map((it) => {
          const strength = sanitizeStr(it && it.strength);
          const strengthNorm = strength === "상" || strength === "중" || strength === "하" ? strength : "중";
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
      short: sanitizeStr(j.shortTerm || j.short),
      mid: sanitizeStr(j.midTerm || j.mid),
      long: sanitizeStr(j.longTerm || j.long),
      entry: toNum(j.entryPrice ?? j.entry),
      stop: toNum(j.stopLoss ?? j.stop),
      target: toNum(j.target),
      comment: sanitizeStr(j.aiComment || j.comment),
      scenarios,
    },
    signals: {
      up: toNum(sig.bullCount ?? sig.up) ?? 0,
      down: toNum(sig.bearCount ?? sig.down) ?? 0,
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
      signals: { up: 0, down: 0 },
      _error: true,
    };
  }

  const summary = raw.summary && typeof raw.summary === "object" ? raw.summary : {};
  const probRaw = toNum(summary.probability);
  const probability =
    probRaw == null ? 50 : Math.max(0, Math.min(100, Math.round(probRaw)));

  const events = Array.isArray(raw.events)
    ? raw.events
        .filter((e) => e && typeof e === "object")
        .map((e) => ({
          type: sanitizeStr(e.type) === "악재" ? "악재" : "호재",
          content: sanitizeStr(e.content),
          date: sanitizeStr(e.date),
        }))
        .filter((e) => e.content)
    : [];

  const materialsRaw = raw.materials && typeof raw.materials === "object" ? raw.materials : {};
  const materialItems = Array.isArray(materialsRaw.items)
    ? materialsRaw.items
        .filter((it) => it && typeof it === "object")
        .slice(0, 4)
        .map((it) => {
          const strength = sanitizeStr(it.strength);
          const strengthNorm = strength === "상" || strength === "중" || strength === "하" ? strength : "중";
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
  const signals = raw.signals && typeof raw.signals === "object" ? raw.signals : {};
  const up = toNum(signals.up);
  const down = toNum(signals.down);

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
      short: sanitizeStr(opinion.short),
      mid: sanitizeStr(opinion.mid),
      long: sanitizeStr(opinion.long),
      entry: toNum(opinion.entry) ?? price,
      stop: toNum(opinion.stop) ?? 0,
      target: toNum(opinion.target) ?? 0,
      comment: sanitizeStr(opinion.comment),
      scenarios,
    },
    signals: {
      up: up == null ? 0 : Math.max(0, Math.round(up)),
      down: down == null ? 0 : Math.max(0, Math.round(down)),
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
- 오늘은 ${today} 이다. 이 날짜 이후 미래 이벤트만. 2024·2025년 날짜 금지, 2026년 이후만.
- '예정/방문 예정/출시 예정/발표 예정/~할 계획/~에 참석' 키워드만. 과거형 금지.
- 없으면 events: [] (프론트는 '현재 확인된 예정 이벤트 없음' 표시). 구체적 제목 필수.`,
    "",
    "5번 재료 분석 — web_search 기반 핵심 재료 4개 이내, unreflected, summary(트레이더 말투 3~5문장).",
    "",
    "6번 차트 — 제공된 실제 MA/RSI 수치만 사용. MA20/60/120/200, RSI, 일목, 지지·저항 1·2차, 52주 고저, 엘리어트 파동 (수치·근거).",
    "",
    "7번 AI 주관적 판단 — short/mid/long + scenarios A/B/C(확률 합 100%) + comment. 5번 재료 반영 필수.",
    "",
    "8번 signals — bullCount/bearCount 신호 개수.",
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
          betas: ["output-128k-2025-02-19"],
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
    analysisError =
      e && e.message === ANALYSIS_PARSE_ERROR_MSG
        ? ANALYSIS_PARSE_ERROR_MSG
        : (e && e.message) || "Claude 분석 실패";
    console.error("[analyze] Claude error", analysisError);
    analysis = normalizeAnalysis(null, quote);
    if (analysisError === ANALYSIS_PARSE_ERROR_MSG && analysis.summary) {
      analysis.summary.description = ANALYSIS_PARSE_ERROR_MSG;
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
