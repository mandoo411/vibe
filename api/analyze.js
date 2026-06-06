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

const CLAUDE_MODEL = "claude-sonnet-4-20250514";

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
    "web_search 결과는 2번(story)과 4번(events)에 반드시 반영하세요.",
    "제공된 KIS 실시간 시세와 web_search 최신 뉴스만 근거로 분석하세요.",
    "일반 투자자도 이해할 수 있는 언어로 작성하세요.",
    "",
    "4번 '다가오는 이벤트' 규칙:",
    `- ${today} 이후 날짜가 언급된 것만 포함. 과거 날짜·과거형 문장(했다/밝혔다/기록했다) 완전 제외.`,
    '- "예정" "방문 예정" "출시 예정" "발표 예정" "~할 계획" 키워드가 있는 뉴스만 이벤트 후보로 선별.',
    "- 이벤트 제목은 구체적으로 (❌ CEO 해외 일정 → ✅ 젠슨황 방한 / 삼성 CEO 회동 예정).",
    "- 확실한 미래 일정이 없으면 events를 빈 배열 []로 두고 chart나 story에 언급하지 말 것. 프론트는 빈 배열 시 '현재 확인된 예정 이벤트 없음' 표시.",
    '- 날짜 불명확하면 "2026년 하반기 예정"처럼 쓰고 억지로 구체 날짜 넣지 말 것.',
    "",
    "5번 '차트 흐름 분석' 규칙 — KIS 시세 데이터 기반, 아래 항목을 모두 포함하고 각 항목마다 수치·근거 명시:",
    "- 이동평균선: 20/60/120/200일선 대비 현재가 위치",
    "- RSI 추정 (최근 가격 흐름 기반)",
    "- 일목균형표: 전환선/기준선/구름대 위·아래 여부",
    "- 지지선·저항선 수치 (예: 1차 지지 116,500원 / 2차 지지 112,000원)",
    "- 52주 전고점·전저점(입력 데이터 high52w/low52w) 언급",
    "- 엘리어트 파동 관점 현재 구간 추정",
    "",
    "6번 'AI 주관적 판단' 규칙:",
    "- short=단기(1-2주), mid=중기(1-3개월), long=장기(6개월-1년) 전망을 각각 상세히",
    "- scenarios A(강세)/B(중립)/C(약세): 조건·진입·목표·손절(또는 C는 strategy·목표하단)·probability(%) 필수",
    "- comment: AI 총평 3-5문장, 실제 트레이더 말투",
    "",
    "최종 답변은 반드시 아래 JSON 형식만 포함하고, 마크다운 코드블록 없이 순수 JSON만 반환하세요.",
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

function parseJsonFromText(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(t);
  } catch (firstErr) {
    const match = t.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (secondErr) {
        console.error("[analyze] JSON 파싱 실패", t.slice(0, 2000));
        throw secondErr;
      }
    }
    console.error("[analyze] JSON 파싱 실패", t.slice(0, 2000));
    throw firstErr;
  }
}

async function messagesCreateWithPause(client, options, maxPauseTurns = 2) {
  let messages = [...(options.messages || [])];
  const { messages: _omit, ...rest } = options;
  let response = null;

  for (let turn = 0; turn <= maxPauseTurns; turn++) {
    response = await client.messages.create({
      ...rest,
      messages,
    });
    logContentBlocks(response);

    if (!response || response.stop_reason !== "pause_turn") {
      break;
    }

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

function buildUserPrompt(quote, stockName, today) {
  const name = stockName || quote.stockName || quote.stockCode;
  const year = seoulYear();
  return [
    `오늘은 ${today}입니다. 모든 분석은 이 시점 기준으로 작성하세요.`,
    `분석 종목: ${name} (${quote.stockCode})`,
    "",
    "【필수】 web_search 2회 — JSON 작성 전 반드시 실행:",
    `- 검색1 (한국어): "${name} 일정 예정 ${year}"`,
    `- 검색2 (영어): "[${name}의 영문기업명 또는 CEO명] schedule event ${year}" (영문명/CEO명 추정 가능하면 사용)`,
    "- 2회 검색 결과를 2번 story(왜 지금 이 가격)와 4번 events(다가오는 이벤트)에 반드시 반영.",
    "- 학습데이터·과거 기억 금지. web_search 확인 정보만 사용.",
    "",
    "4번 '다가오는 이벤트' 규칙:",
    `- ${today} 이후 날짜만. "예정/방문 예정/출시 예정/발표 예정/~할 계획" 키워드 있는 것만.`,
    '- 과거형("했다/밝혔다/기록했다") 완전 제외. 구체적 제목(예: 젠슨황 방한).',
    "- 미래 일정 없으면 events: []. 날짜 불명확하면 '2026년 하반기 예정' 등으로.",
    "",
    "5번 '차트 흐름 분석' — 아래 KIS 시세로 MA20/60/120/200, RSI, 일목, 지지·저항, 52주 고저, 엘리어트 모두 수치 포함.",
    "",
    "6번 'AI 주관적 판단' — short/mid/long 상세 + scenarios A/B/C(조건·진입·목표·손절·확률%) + comment 3-5문장.",
    "",
    "아래 KIS 실시간 시세를 참고하고, web_search 2회 후 JSON만 응답하세요.",
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

async function claudeAnalyze(quote, stockName) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: requireAnthropicKey() });
  const today = todayKoreaLabel();
  const user = buildUserPrompt(quote, stockName, today);
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
          tools: WEB_SEARCH_TOOLS,
          messages: [{ role: "user", content: user }],
        },
        2
      );

      const fullText = extractTextFromContent(msg && msg.content);
      const parsed = parseJsonFromText(fullText);
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
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      throw new Error("Invalid JSON body");
    }
  }
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
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

  let analysis;
  let analysisError = "";
  try {
    analysis = await claudeAnalyze(quote, stockName);
  } catch (e) {
    analysisError = (e && e.message) || "Claude 분석 실패";
    console.error("[analyze] Claude error", analysisError);
    analysis = normalizeAnalysis(null, quote);
  }

  json(res, 200, {
    stockCode: code6,
    stockName,
    currentPrice: quote.currentPrice,
    changeAmt: quote.changeAmt,
    changeRate: quote.changeRate,
    analysis,
    analysisError: analysisError || undefined,
  });
};

module.exports.default = module.exports;
