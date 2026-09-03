/**
 * DART(전자공시) 단일회사 주요계정 → "실적 추이" 카드용 실데이터 모듈.
 *
 * 배경(2026-09-03 로드맵 D): AI 종목분석에는 재무·실적 실데이터가 하나도 없었다.
 * KIS에서 PER/PBR/EPS 숫자 하나씩만 받고, 분기 매출·영업이익 추이는 AI가 web_search로
 * "추측"했다 — 검증 불가에 할루시네이션 위험이 가장 큰 구간이었다. 이 모듈은 그 자리를
 * DART 원본 공시 숫자로 교체한다.
 *
 * 원칙:
 *  - 계산·정규화는 전부 코드가 한다. AI는 이 값을 인용만 한다.
 *  - **없으면 지어내지 않고 생략한다.** 항목이 하나라도 비면 그 기간을 통째로 버린다.
 *  - 연결(CFS)이 있으면 연결, 없으면 개별(OFS). 어느 쪽을 썼는지 화면에 표기한다.
 *  - Vercel Hobby 함수 12개 한도 때문에 **새 api/*.js를 만들지 않는다** — api/analyze.js가
 *    분석 응답을 만들 때 여기서 직접 불러 붙인다.
 *
 * 호출량: 종목당 최대 4회(연간 1~2 + 분기 1~3). DART 일일 한도 20,000회에 비해
 * 유료 분석 트래픽은 미미하다. 그래도 같은 종목 반복 조회를 막으려고 인메모리 캐시를 둔다
 * (서버리스라 인스턴스 생존 동안만 유효 — 그걸로 충분하다).
 */

const DART_BASE = "https://opendart.fss.or.kr/api/fnlttSinglAcnt.json";
const FETCH_TIMEOUT_MS = 8000;

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const CACHE_MAX = 200;
const __cache = new Map(); // code6 → { at, value }

/** 사업보고서 / 1분기 / 반기 / 3분기 */
const REPRT = { ANNUAL: "11011", Q1: "11013", HALF: "11012", Q3: "11014" };

/** 분기 보고서 코드 → 사람이 읽는 누적 기간 이름. 원문 thstrm_nm("제 58 기 반기")을
 *  그대로 쓰면 구독자가 몇 년치인지 알 수 없어서 연도를 붙여 다시 만든다. */
const CUMULATIVE_LABEL = {
  [REPRT.Q1]: "1분기",
  [REPRT.HALF]: "상반기 누적",
  [REPRT.Q3]: "3분기 누적",
};

/** 손익계산서에서 뽑을 3개 항목. 금융·지주사는 "매출액" 대신 "영업수익"으로 신고하므로
 *  대체 계정명을 함께 둔다(둘 다 없으면 그 항목은 생략). */
const METRICS = [
  { key: "revenue", label: "매출액", names: ["매출액", "영업수익", "수익(매출액)"] },
  { key: "operatingProfit", label: "영업이익", names: ["영업이익", "영업이익(손실)"] },
  { key: "netProfit", label: "당기순이익", names: ["당기순이익", "당기순이익(손실)", "당기순손익"] },
];

function dartApiKey() {
  return String(process.env.DART_API_KEY || process.env.OPENDART_API_KEY || "").trim();
}

/** corp_code 매핑 로드.
 *  1순위: 번들에 포함된 data/dart-corp-map.json (비용 0)
 *  2순위: GitHub Contents API (배치가 방금 만들어 아직 재배포 전인 경우 —
 *         data/ 변경만으로는 vercel.json ignoreCommand가 풀빌드를 스킵하기 때문에
 *         이 폴백이 없으면 최초 생성 후 다음 코드 배포 전까지 아무 종목도 못 찾는다) */
let __corpMap = null;
let __corpMapAt = 0;
const CORP_MAP_TTL_MS = 24 * 60 * 60 * 1000;

async function loadCorpMap() {
  if (__corpMap && Date.now() - __corpMapAt < CORP_MAP_TTL_MS) return __corpMap;
  try {
    const bundled = require("../data/dart-corp-map.json");
    if (bundled && bundled.map && Object.keys(bundled.map).length > 100) {
      __corpMap = bundled.map;
      __corpMapAt = Date.now();
      return __corpMap;
    }
  } catch {
    /* 아직 배치가 안 돌았거나 번들에 없음 — 아래 폴백으로 */
  }
  const token = (
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GH_PAT_REPO_SECRETS_WRITE ||
    process.env.GITHUB_PAT ||
    ""
  ).trim();
  if (!token) return __corpMap || null;
  try {
    const res = await fetch(
      "https://api.github.com/repos/mandoo411/vibe/contents/data/dart-corp-map.json?ref=main",
      {
        headers: {
          Accept: "application/vnd.github.raw",
          "User-Agent": "totalmoney-ai",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return __corpMap || null;
    const parsed = JSON.parse(await res.text());
    if (parsed && parsed.map && Object.keys(parsed.map).length > 100) {
      __corpMap = parsed.map;
      __corpMapAt = Date.now();
    }
  } catch {
    /* 무시 — 카드를 안 그릴 뿐 분석 자체는 정상 진행 */
  }
  return __corpMap || null;
}

function parseAmount(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/,/g, "").replace(/\s/g, "");
  if (!s || s === "-") return null;
  // DART는 음수를 "-123" 또는 "△123"/"(123)"으로 준다.
  let neg = false;
  let body = s;
  if (/^[-△▲]/.test(body)) {
    neg = true;
    body = body.slice(1);
  } else if (/^\(.*\)$/.test(body)) {
    neg = true;
    body = body.slice(1, -1);
  }
  if (!/^\d+(\.\d+)?$/.test(body)) return null;
  const n = Number(body);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

async function dartFetch(corpCode, bsnsYear, reprtCode) {
  const url = new URL(DART_BASE);
  url.searchParams.set("crtfc_key", dartApiKey());
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(bsnsYear));
  url.searchParams.set("reprt_code", reprtCode);
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "TotalMoneyAI/1.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  // status "000"=정상, "013"=조회된 데이터 없음(=아직 미제출). 그 외는 오류.
  if (!json || json.status !== "000" || !Array.isArray(json.list) || !json.list.length) return null;
  return json.list;
}

/** 연결(CFS)이 있으면 연결, 없으면 개별(OFS). 한 종목의 재무를 두 기준으로 섞으면 안 되므로
 *  기준을 먼저 하나 고르고 그 안에서만 계정을 찾는다. */
function pickFsRows(list) {
  const cfs = list.filter((r) => r && r.fs_div === "CFS");
  if (cfs.length) return { rows: cfs, fsDiv: "CFS", fsLabel: "연결" };
  const ofs = list.filter((r) => r && r.fs_div === "OFS");
  if (ofs.length) return { rows: ofs, fsDiv: "OFS", fsLabel: "개별" };
  return { rows: list, fsDiv: null, fsLabel: "" };
}

function findAccount(rows, names) {
  const norm = (s) => String(s || "").replace(/\s/g, "");
  // 손익계산서(IS) 또는 포괄손익계산서(CIS)에만 있는 계정들이다.
  const scoped = rows.filter((r) => r && (r.sj_div === "IS" || r.sj_div === "CIS"));
  const pool = scoped.length ? scoped : rows;
  for (const want of names) {
    const hit = pool.find((r) => norm(r.account_nm) === norm(want));
    if (hit) return hit;
  }
  return null;
}

const EOK = 100000000; // 1억
function toEok(won) {
  if (won == null) return null;
  return Math.round(won / EOK);
}

function yoyPct(cur, prev) {
  if (cur == null || prev == null) return null;
  // 전년이 적자(음수)면 증감률이 수학적으로는 나오지만 읽는 사람을 속인다
  // (예: -100억 → -50억이 "+50%"). 이런 구간은 비율을 만들지 않고 생략한다.
  if (prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

/** 연간 3개년 — 사업보고서 1회 호출이면 당기·전기·전전기가 한 번에 온다. */
function buildAnnual(list, bsnsYear) {
  const { rows, fsDiv, fsLabel } = pickFsRows(list);
  const slots = [
    { year: Number(bsnsYear) - 2, field: "bfefrmtrm_amount" },
    { year: Number(bsnsYear) - 1, field: "frmtrm_amount" },
    { year: Number(bsnsYear), field: "thstrm_amount" },
  ];
  const out = [];
  for (const slot of slots) {
    const period = { label: `${slot.year}`, year: slot.year };
    let filled = 0;
    for (const metric of METRICS) {
      const row = findAccount(rows, metric.names);
      const v = row ? parseAmount(row[slot.field]) : null;
      if (v != null) {
        period[metric.key] = toEok(v);
        filled += 1;
      }
    }
    // 매출액조차 없으면 그 해는 통째로 버린다(빈 막대를 그리는 게 더 나쁘다).
    if (filled >= 2 && period.revenue != null) out.push(period);
  }
  return { periods: out, fsDiv, fsLabel };
}

/** 최근 분기 누적 + 전년 동기 누적. 누적이 없으면 3개월치로 대체한다.
 *  ⚠️ 기준(누적/3개월)은 매출액 행에서 **한 번만** 정하고 세 항목에 똑같이 적용한다.
 *  항목마다 따로 고르면 "매출은 반기 누적인데 순이익은 3개월"처럼 기간이 섞인 카드가
 *  나와서 구독자가 잘못 읽는다(오프라인 검증에서 실제로 재현됨). 정한 기준으로 값이
 *  안 나오는 항목은 섞지 않고 그냥 생략한다. */
function buildQuarter(list, bsnsYear, reprtCode) {
  const { rows, fsDiv, fsLabel } = pickFsRows(list);

  const anchor = findAccount(rows, METRICS[0].names);
  if (!anchor) return null;
  const usedCumulative =
    parseAmount(anchor.thstrm_add_amount) != null && parseAmount(anchor.frmtrm_add_amount) != null;
  const curField = usedCumulative ? "thstrm_add_amount" : "thstrm_amount";
  const prevField = usedCumulative ? "frmtrm_add_amount" : "frmtrm_q_amount";

  const cur = {};
  const prev = {};
  for (const metric of METRICS) {
    const row = findAccount(rows, metric.names);
    if (!row) continue;
    const c = parseAmount(row[curField]);
    const p = parseAmount(row[prevField]);
    if (c == null || p == null) continue;
    cur[metric.key] = toEok(c);
    prev[metric.key] = toEok(p);
  }
  if (cur.revenue == null) return null;

  const baseLabel = usedCumulative
    ? CUMULATIVE_LABEL[reprtCode] || "최근 분기"
    : { [REPRT.Q1]: "1분기", [REPRT.HALF]: "2분기", [REPRT.Q3]: "3분기" }[reprtCode] || "최근 분기";

  const yoy = {};
  for (const metric of METRICS) {
    const v = yoyPct(cur[metric.key], prev[metric.key]);
    if (v != null) yoy[metric.key] = v;
  }

  return {
    label: `${bsnsYear}년 ${baseLabel}`,
    prevLabel: `${Number(bsnsYear) - 1}년 ${baseLabel}`,
    cumulative: usedCumulative === true,
    current: cur,
    previous: prev,
    yoy,
    fsDiv,
    fsLabel,
  };
}

/** 최근 제출된 분기·반기 보고서를 최신순으로 훑는다. 아직 안 나온 분기는 status 013이라
 *  자동으로 건너뛴다 — 달력으로 추측하지 않고 실제 응답으로 판정한다. */
function quarterCandidates(now) {
  const y = now.getUTCFullYear();
  const out = [];
  for (const year of [y, y - 1]) {
    out.push([year, REPRT.Q3], [year, REPRT.HALF], [year, REPRT.Q1]);
  }
  return out;
}

/**
 * @param {string} code6 6자리 종목코드
 * @returns {Promise<object|null>} 실패·데이터 없음이면 null (카드를 그리지 않음)
 */
async function fetchFinancialTrend(code6) {
  const code = String(code6 || "").trim();
  if (!/^[0-9A-Z]{6}$/.test(code)) return null;
  if (!dartApiKey()) return null;

  const cached = __cache.get(code);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let value = null;
  try {
    const map = await loadCorpMap();
    const corpCode = map && map[code];
    if (!corpCode) {
      __cache.set(code, { at: Date.now(), value: null });
      return null;
    }

    const now = new Date();
    const thisYear = now.getUTCFullYear();

    // 연간: 직전 사업연도부터 시도(3월 이전이면 아직 미제출이라 그 전 해로 폴백)
    let annual = null;
    for (const year of [thisYear - 1, thisYear - 2]) {
      const list = await dartFetch(corpCode, year, REPRT.ANNUAL);
      if (!list) continue;
      const built = buildAnnual(list, year);
      if (built.periods.length >= 2) {
        annual = built;
        break;
      }
    }

    // 분기: 실제로 응답이 오는 첫 후보를 채택
    let quarter = null;
    for (const [year, reprt] of quarterCandidates(now)) {
      const list = await dartFetch(corpCode, year, reprt);
      if (!list) continue;
      const built = buildQuarter(list, year, reprt);
      if (built) {
        quarter = built;
        break;
      }
    }

    if (!annual && !quarter) {
      __cache.set(code, { at: Date.now(), value: null });
      return null;
    }

    value = {
      source: "DART 전자공시 단일회사 주요계정",
      unit: "억원",
      fsLabel: (annual && annual.fsLabel) || (quarter && quarter.fsLabel) || "",
      annual: annual ? annual.periods : [],
      quarter: quarter || null,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn("[dart-financials] 실적 조회 실패", error && error.message);
    value = null;
  }

  if (__cache.size >= CACHE_MAX) {
    const oldest = [...__cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) __cache.delete(oldest[0]);
  }
  __cache.set(code, { at: Date.now(), value });
  return value;
}

/** 억원 정수를 한국식 "N조 N,NNN억원"으로 — 소수점 없음(프로젝트 표기 규칙).
 *  프롬프트에 "1,650,000억원"처럼 넣으면 모델이 그대로 베껴 써서 읽을 수 없는 문장이 된다. */
function fmtEokKo(eok) {
  if (eok == null || !Number.isFinite(eok)) return "";
  const neg = eok < 0;
  const abs = Math.abs(Math.round(eok));
  let text;
  if (abs >= 10000) {
    const jo = Math.floor(abs / 10000);
    const rest = abs % 10000;
    text = rest > 0 ? `${jo.toLocaleString("ko-KR")}조 ${rest.toLocaleString("ko-KR")}억원` : `${jo.toLocaleString("ko-KR")}조원`;
  } else {
    text = `${abs.toLocaleString("ko-KR")}억원`;
  }
  return neg ? `-${text}` : text;
}

/** AI 프롬프트 주입용 — 화면의 막대와 본문 서술이 같은 숫자를 말하게 만든다. */
function financialTrendPromptBlock(fin) {
  if (!fin) return "";
  const lines = [];
  if (Array.isArray(fin.annual) && fin.annual.length) {
    lines.push(`연간(${fin.fsLabel || "재무제표"} 기준):`);
    for (const p of fin.annual) {
      const parts = [];
      if (p.revenue != null) parts.push(`매출 ${fmtEokKo(p.revenue)}`);
      if (p.operatingProfit != null) parts.push(`영업이익 ${fmtEokKo(p.operatingProfit)}`);
      if (p.netProfit != null) parts.push(`순이익 ${fmtEokKo(p.netProfit)}`);
      lines.push(`- ${p.label}년: ${parts.join(" · ")}`);
    }
  }
  if (fin.quarter) {
    const q = fin.quarter;
    const parts = [];
    for (const m of METRICS) {
      if (q.current[m.key] == null) continue;
      const yoy = q.yoy[m.key];
      parts.push(
        `${m.label} ${fmtEokKo(q.current[m.key])}${yoy != null ? `(전년동기 ${yoy > 0 ? "+" : ""}${yoy}%)` : ""}`
      );
    }
    if (parts.length) lines.push(`${q.label}: ${parts.join(" · ")}`);
  }
  if (!lines.length) return "";
  return [
    "",
    "[실적 추이 — DART 전자공시 원본 숫자다. 코드가 파싱한 실측값이므로 추정이 아니며 그대로 인용해도 된다]",
    ...lines,
    "이 표는 화면에도 막대그래프로 함께 나온다. 본문에서는 숫자를 나열하지 말고 '무엇이 꺾였는지/돌아섰는지'만 해석으로 쓴다. 여기 없는 기간의 실적은 절대 지어내지 않는다.",
  ].join("\n");
}

module.exports = { fetchFinancialTrend, financialTrendPromptBlock };
