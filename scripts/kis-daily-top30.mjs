#!/usr/bin/env node
/**
 * 한국투자증권 Open API → 코스피+코스닥 상승률 TOP 30
 *  → 각 종목 네이버 뉴스 헤드라인 수집
 *  → Claude로 "상승 이유 한 줄 + 테마 + 시황 요약(summary) + 특징주" 자동 분류
 *  → data/daily-market.json 의 days[targetYmd] (topGainers, summary, notableStocks 등) 에 저장
 *
 * 필수: KIS_ACCESS_TOKEN, KIS_APP_KEY, KIS_APP_SECRET, ANTHROPIC_API_KEY
 * 선택: TARGET_DATE=YYYY-MM-DD (기본: 오늘 KST)
 *       TOP_N (기본 30, 1~50)
 *       NEWS_PER_STOCK (기본 5, 1~10)
 *       NEWS_CONCURRENCY (기본 5, 1~10)
 *       KIS_BASE_URL (기본 https://openapi.koreainvestment.com:9443)
 *       ANTHROPIC_MODEL (기본 claude-sonnet-4-5)
 *       OUTPUT_PATH (기본 ./data/daily-market.json)
 *       KIS_NOTABLE_QUOTE_DELAY_MS (기본 150, 특징주 KIS 개별시세 호출 간격 ms)
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ─── 기본 헬퍼 ────────────────────────────────────────────
function seoulYmd(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return String(v).trim();
}

function sanitizeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toNumberOrNull(v) {
  if (v === "" || v == null) return null;
  if (typeof v === "string") {
    const s = v.trim().replace(/%/g, "").replace(/,/g, "").replace(/\s/g, "").replace(/^\+/, "");
    if (s === "" || s === "-" || s === ".") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ""; }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch (_) { return ""; }
    });
}

function stripHtml(s) {
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── KIS OAuth 토큰: 자동 발급 금지, 환경변수만 사용 ──────────────────
function getKisToken() {
  return requireEnv("KIS_ACCESS_TOKEN");
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

/** KIS FHPST01700000 output 등락률(%) — prdy_ctrt 외 필드명 변형 대응 */
function kisRowPctChange(row) {
  if (!row || typeof row !== "object") return null;
  const keys = ["prdy_ctrt", "PRDY_CTRT", "bstp_nmix_prdy_ctrt", "BSTP_NMIX_PRDY_CTRT"];
  for (const k of keys) {
    const n = toNumberOrNull(row[k]);
    if (n != null && Number.isFinite(n)) return n;
  }
  return null;
}

// ─── KIS 등락률 순위 조회 ─────────────────────────────────
// 시장 코드: 0000(전체) | 0001(코스피) | 1001(코스닥)
async function fetchFluctuationRanking({ baseUrl, token, appKey, appSecret, marketCode, marketLabel }) {
  const url = new URL(`${baseUrl}/uapi/domestic-stock/v1/ranking/fluctuation`);
  const params = {
    fid_cond_mrkt_div_code: "J",
    fid_cond_scr_div_code: "20170",
    fid_input_iscd: marketCode,
    fid_rank_sort_cls_code: "0", // 0:상승률
    fid_input_cnt_1: "0",
    fid_prc_cls_code: "1", // 종가 기준
    fid_input_price_1: "",
    fid_input_price_2: "",
    fid_vol_cnt: "",
    fid_trgt_cls_code: "0",
    fid_trgt_exls_cls_code: "0000000000",
    fid_div_cls_code: "0",
    fid_rsfl_rate1: "",
    fid_rsfl_rate2: "",
  };
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: "FHPST01700000",
      custtype: "P",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`KIS ranking HTTP ${res.status} (${marketLabel}): ${text.slice(0, 300)}`);
  }
  let json;
  try { json = JSON.parse(text); } catch (_) {
    throw new Error(`KIS ranking: invalid JSON (${marketLabel}): ${text.slice(0, 300)}`);
  }
  if (json.rt_cd && json.rt_cd !== "0") {
    throw new Error(`KIS ranking error (${marketLabel}) rt_cd=${json.rt_cd} msg=${json.msg1 || ""}`);
  }
  const list = Array.isArray(json.output) ? json.output : [];
  return list.map((row) => ({
    code: sanitizeStr(row.stck_shrn_iscd),
    name: sanitizeStr(row.hts_kor_isnm),
    market: marketLabel,
    currentPrice: sanitizeStr(row.stck_prpr),
    prevDelta: toNumberOrNull(row.prdy_vrss),
    change: kisRowPctChange(row),
    volume: sanitizeStr(row.acml_vol),
    tradingValue: sanitizeStr(row.acml_tr_pbmn), // 원 단위 누적 거래대금
    rank: toNumberOrNull(row.data_rank),
  })).filter((r) => r.code && r.name);
}

function formatTradingValue(rawWon) {
  const n = Number(rawWon);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_0000_0000_0000) {
    // 1조 이상
    const jo = n / 1_0000_0000_0000;
    return `${jo.toFixed(2).replace(/\.?0+$/, "")}조`;
  }
  if (n >= 1_0000_0000) {
    const eok = Math.round(n / 1_0000_0000);
    return `${eok.toLocaleString("ko-KR")}억`;
  }
  return `${n.toLocaleString("ko-KR")}원`;
}

// ─── 네이버 금융 (직전 거래일 마감 데이터) ───────────────
// Naver Finance는 EUC-KR 인코딩, 장 마감 후~다음 장 시작 전엔 직전 거래일 종가 기준 데이터를 보여줍니다.
async function fetchNaverFinanceHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "ko,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) {
    throw new Error(`Naver Finance HTTP ${res.status} fetching ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return new TextDecoder("euc-kr").decode(buf);
}

function parseNaverRankingRows(html, marketLabel) {
  // 각 행은 <td class="no">N</td>...<a class="tltle" href="...code=XXX">NAME</a>...<td class="number">가격</td>...
  // 등락률은 <span class="... red01">+N.NN%</span> 또는 <span class="... nv01">-N.NN%</span> 형태.
  const rows = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const tr = m[1];
    if (!/class="tltle"/.test(tr)) continue;
    const codeM = tr.match(/code=(\d{6})"[^>]*class="tltle"[^>]*>([^<]+)<\/a>/);
    if (!codeM) continue;
    const code = codeM[1];
    const name = decodeEntities(codeM[2]).trim();
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let t;
    while ((t = tdRe.exec(tr)) !== null) tds.push(t[1]);
    // tds[0]=순위, [1]=종목명, [2]=현재가, [3]=전일대비, [4]=등락률, [5]=거래량, ...
    const currentPrice = tds[2] ? stripHtml(tds[2]).replace(/,/g, "") : "";
    let change = null;
    if (tds[4]) {
      const txt = stripHtml(tds[4]).replace(/[+]/g, "");
      const isNeg = /class="[^"]*(?:nv|down)[^"]*"/.test(tds[4]);
      const num = txt.replace(/[^\d\.\-]/g, "");
      const v = Number(num);
      if (Number.isFinite(v)) change = isNeg && v > 0 ? -v : v;
    }
    let volume = tds[5] ? stripHtml(tds[5]).replace(/,/g, "") : "";

    rows.push({
      code,
      name,
      market: marketLabel,
      currentPrice,
      change,
      volume,
      tradingValue: "",
      rank: null,
    });
  }
  return rows;
}

async function fetchNaverFinanceRanking({ marketCode, marketLabel, maxPages = 2 }) {
  // sosok=0(KOSPI), sosok=1(KOSDAQ)
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://finance.naver.com/sise/sise_rise.naver?sosok=${marketCode}&page=${page}`;
    const html = await fetchNaverFinanceHtml(url);
    const rows = parseNaverRankingRows(html, marketLabel);
    for (const r of rows) {
      if (seen.has(r.code)) continue;
      seen.add(r.code);
      all.push(r);
    }
    if (rows.length === 0) break;
  }
  return all;
}

async function fetchNaverFinanceIndex(code, label) {
  const url = `https://finance.naver.com/sise/sise_index.naver?code=${encodeURIComponent(code)}`;
  const html = await fetchNaverFinanceHtml(url);
  const v = html.match(/<em id="now_value">([\d,\.]+)<\/em>/);
  const r = html.match(/id="change_value_and_rate"[^>]*>\s*<span>([^<]+)<\/span>\s*([+\-]?[\d,\.]+)%/);
  // 방향 판별: change_value 영역 또는 fluc 클래스에 up/dn/nv 같은 토큰이 있는지
  const directionMatch = html.match(/<span class="fluc\s+([a-zA-Z_]+)"\s+id="change_value_and_rate"/);
  const direction = directionMatch ? directionMatch[1].toLowerCase() : "";
  let change = null;
  if (r) {
    const num = Number(r[2].replace(/,/g, ""));
    if (Number.isFinite(num)) {
      const isDown = direction.includes("dn") || direction.includes("down") || direction.includes("nv") || /^-/.test(r[2]);
      change = isDown && num > 0 ? -num : num;
    }
  }
  return {
    name: label,
    value: v ? v[1] : "",
    change,
  };
}

// ─── 네이버 뉴스 검색 (HTML 스크래핑) ─────────────────────
// 네이버는 신형 SDS 검색 페이지에서 뉴스 제목을 JSON props로 임베드합니다.
// "title":"..." 프롭에서 길이 >= 12자인 항목을 기사 제목으로 간주(출판사 이름은 짧음).
function extractNewsTitles(html, limit) {
  const out = [];
  const seen = new Set();

  const push = (s) => {
    if (!s) return;
    const clean = decodeEntities(
      s.replace(/<\/?mark[^>]*>/gi, "").replace(/<[^>]+>/g, "")
    ).replace(/\s+/g, " ").trim();
    if (clean.length < 12) return; // 출판사·짧은 문구 제외
    if (seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };

  // 1) JSON "title" 프롭 (가장 정확)
  const re1 = /"title":"((?:\\.|[^"\\])+)"/g;
  let m;
  while ((m = re1.exec(html)) !== null && out.length < limit) {
    let raw;
    try { raw = JSON.parse(`"${m[1]}"`); } catch (_) { raw = m[1]; }
    push(raw);
  }

  // 2) 헤드라인 CSS 클래스 fallback
  if (out.length < limit) {
    const re2 = /sds-comps-text-type-headline[12][^"]*"[^>]*>([\s\S]{0,300}?)<\/(?:span|a|div|button)>/g;
    while ((m = re2.exec(html)) !== null && out.length < limit) {
      push(m[1]);
    }
  }

  // 3) 구형 .news_tit 마지막 fallback
  if (out.length < limit) {
    const re3 = /<a[^>]+class="[^"]*news_tit[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = re3.exec(html)) !== null && out.length < limit) {
      push(m[1]);
    }
  }

  return out.slice(0, limit);
}

async function searchNaverNews(query, limit, { retries = 3 } = {}) {
  const url = `https://search.naver.com/search.naver?where=news&sort=1&query=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ko,en;q=0.9",
          Referer: "https://www.naver.com/",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-site",
        },
      });
      if (res.status === 429 || res.status === 403) {
        if (attempt < retries) {
          const wait = 800 * (attempt + 1) + Math.floor(Math.random() * 400);
          if (process.env.DEBUG_NEWS) {
            console.warn(`  [news retry] ${query} → HTTP ${res.status}, ${wait}ms 후 재시도`);
          }
          await delay(wait);
          continue;
        }
        if (process.env.DEBUG_NEWS) {
          console.warn(`  [news] ${query} → HTTP ${res.status} (포기)`);
        }
        return [];
      }
      if (!res.ok) {
        if (process.env.DEBUG_NEWS) console.warn(`  [news] ${query} → HTTP ${res.status}`);
        return [];
      }
      const html = await res.text();
      const titles = extractNewsTitles(html, limit);
      if (process.env.DEBUG_NEWS && titles.length === 0) {
        const titleProps = (html.match(/"title":"/g) || []).length;
        console.warn(`  [news] ${query} → 0건 (len=${html.length}, "title"=${titleProps})`);
      }
      return titles;
    } catch (e) {
      if (attempt < retries) {
        await delay(500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  return [];
}

async function fetchNewsForStocks(stocks, perStock, concurrency, perRequestDelayMs) {
  const out = new Map();
  let idx = 0;
  async function worker() {
    while (idx < stocks.length) {
      const i = idx++;
      const s = stocks[i];
      try {
        const titles = await searchNaverNews(`${s.name} 주가`, perStock);
        out.set(s.code, titles);
        if (process.env.DEBUG_NEWS) {
          console.log(`  [news] ${s.name}: ${titles.length}건`);
        }
      } catch (e) {
        console.warn(`Naver news fail [${s.name}]: ${e.message || e}`);
        out.set(s.code, []);
      }
      // 봇 차단 회피용 지터 포함 딜레이
      const jitter = Math.floor(Math.random() * 200);
      await delay(perRequestDelayMs + jitter);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(10, concurrency)) }, worker);
  await Promise.all(workers);
  return out;
}

// ─── Claude: 상승 이유 + 테마 ─────────────────────────────
function parseJsonFromAssistant(text) {
  const s = String(text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : s;
  return JSON.parse(raw);
}

/** 주식현재가 시세 — fid_input_iscd(6자리) + 시장구분으로 등락률(prdy_ctrt) 조회 */
const KIS_INQUIRE_PRICE_TR_ID = "FHKST01010100";

async function fetchKisInquirePricePrdyCtrt({ baseUrl, token, appKey, appSecret, code6, market }) {
  const code = String(code6 || "").replace(/\D/g, "").padStart(6, "0").slice(-6);
  if (!/^\d{6}$/.test(code)) return null;

  const divOrder = [];
  if (market === "KOSDAQ") divOrder.push("Q");
  else if (market === "KOSPI") divOrder.push("J");
  else divOrder.push("J", "Q", "K");

  for (const fidCondMrktDivCode of divOrder) {
    const url = new URL(`${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price`);
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", fidCondMrktDivCode);
    url.searchParams.set("FID_INPUT_ISCD", code);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: KIS_INQUIRE_PRICE_TR_ID,
        custtype: "P",
      },
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    if (json.rt_cd && json.rt_cd !== "0") continue;
    const out = json.output;
    const row = Array.isArray(out) ? out[0] : out;
    if (!row || typeof row !== "object") continue;
    const pct = kisRowPctChange(row);
    if (pct != null && Number.isFinite(pct)) return pct;
  }
  return null;
}

function nameLooseKey(name) {
  return sanitizeStr(name).replace(/\s+/g, "");
}

function buildTopGainerLookup(topGainers) {
  const byCode = new Map();
  const byName = new Map();
  const byNameLoose = new Map();
  for (const s of topGainers) {
    const c = sanitizeStr(s.code);
    if (c) byCode.set(c, s);
    const nm = sanitizeStr(s.name);
    if (nm) {
      byName.set(nm, s);
      byNameLoose.set(nameLooseKey(nm), s);
    }
  }
  return { byCode, byName, byNameLoose };
}

function findTopGainerMatch(topGainers, r, lookup) {
  const codeIn = sanitizeStr(r.code);
  if (codeIn && lookup.byCode.has(codeIn)) return lookup.byCode.get(codeIn);
  const name = sanitizeStr(r.name);
  if (!name) return null;
  return lookup.byName.get(name) || lookup.byNameLoose.get(nameLooseKey(name)) || null;
}

/** 특징주: TOP30(실측) 등락률 우선, 없으면 AI 숫자. 둘 다 없으면 null */
function resolveNotableChangePct(r, match) {
  const fromRank = match != null ? toNumberOrNull(match.change) : null;
  if (fromRank != null && Number.isFinite(fromRank)) return fromRank;
  const fromAi = toNumberOrNull(r.change);
  if (fromAi != null && Number.isFinite(fromAi)) return fromAi;
  return null;
}

/**
 * Claude notableStocks → TOP30 이름·코드 매칭 후 등락률 부착.
 * 여전히 없으면 KIS inquire-price(종목코드)로 prdy_ctrt 보강. 코드는 TOP30에서만(없으면 "").
 */
async function finalizeNotableStocks(raw, topGainers, kisCtx) {
  const lookup = buildTopGainerLookup(topGainers);
  const quoteDelayMs = Math.max(0, Number(process.env.KIS_NOTABLE_QUOTE_DELAY_MS) || 150);
  const rows = [];

  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const name = sanitizeStr(r.name);
      if (!name) continue;
      const match = findTopGainerMatch(topGainers, r, lookup);
      let code = sanitizeStr(r.code) || (match ? sanitizeStr(match.code) : "");
      if (!/^\d{6}$/.test(code)) code = "";

      let change = resolveNotableChangePct(r, match);
      const canQuote =
        change == null &&
        code.length === 6 &&
        kisCtx &&
        kisCtx.token &&
        kisCtx.appKey &&
        kisCtx.appSecret;

      if (canQuote) {
        try {
          await delay(quoteDelayMs);
          const fromKis = await fetchKisInquirePricePrdyCtrt({
            baseUrl: kisCtx.baseUrl,
            token: kisCtx.token,
            appKey: kisCtx.appKey,
            appSecret: kisCtx.appSecret,
            code6: code,
            market: match?.market || "",
          });
          if (fromKis != null && Number.isFinite(fromKis)) change = fromKis;
        } catch (e) {
          console.warn(`  [notable KIS] ${name} (${code}): ${e.message || e}`);
        }
      }

      rows.push({
        name,
        code,
        change: change != null && Number.isFinite(change) ? change : null,
        tradingValue: sanitizeStr(r.tradingValue) || (match ? sanitizeStr(match.tradingValue) : ""),
        note: sanitizeStr(r.note) || (match ? sanitizeStr(match.reason) || sanitizeStr(match.theme) : ""),
      });
    }
  }

  if (rows.length) return rows.slice(0, 12);
  return topGainers.slice(0, 6).map((s) => ({
    name: s.name,
    code: sanitizeStr(s.code),
    change: toNumberOrNull(s.change),
    tradingValue: sanitizeStr(s.tradingValue),
    note: sanitizeStr(s.reason) || sanitizeStr(s.theme),
  }));
}

async function classifyWithClaude({ apiKey, model, targetYmd, stocks, newsMap, indexes }) {
  const client = new Anthropic({ apiKey });

  const lines = [];
  lines.push(`대상 날짜(KST): ${targetYmd}`);
  if (indexes && indexes.length) {
    const idxStr = indexes
      .map((i) => `${i.name} ${i.value || "—"}(${i.change == null ? "—" : (i.change > 0 ? "+" : "") + i.change.toFixed(2) + "%"})`)
      .join(" | ");
    lines.push(`지수 종가: ${idxStr}`);
  }
  lines.push("아래는 그날 한국 증시 상승률 상위 종목과 각 종목 네이버 뉴스 헤드라인입니다.");
  lines.push("");
  stocks.forEach((s, i) => {
    const ch = s.change == null ? "" : (s.change > 0 ? `+${s.change.toFixed(2)}%` : `${s.change.toFixed(2)}%`);
    lines.push(`#${i + 1} ${s.code} ${s.name} (${s.market}) ${ch}`);
    const news = newsMap.get(s.code) || [];
    if (news.length === 0) {
      lines.push("  - (뉴스 없음)");
    } else {
      news.forEach((t) => lines.push(`  - ${t}`));
    }
  });

  const system = `당신은 한국 주식 데이터 큐레이터입니다. 입력은 ${targetYmd}일 한국 증시 상승률 상위 종목 목록과 각 종목 네이버 뉴스 헤드라인입니다.

요구 출력은 다음 JSON 객체(키 네 개)뿐입니다. 마크다운, 코드펜스, 주석, 설명을 절대 추가하지 마세요.

{
  "marketSummary": "한국어 시황 요약 3~5문장. 지수·자금·대표 테마를 뉴스·지수 종가 근거로만 서술.",
  "notableStocks": [
    { "name": "삼성전자", "code": "005930", "change": null, "tradingValue": "1조 2000억", "note": "거래대금·뉴스 기준 한 줄 요약" }
  ],
  "stocks": [
    { "code": "005930", "reason": "HBM4 양산 본격화 기대", "theme": "AI 반도체" }
  ],
  "topNews": [
    { "title": "뉴스 한 줄", "note": "왜 중요한지 1문장(선택)", "source": "출처(선택)" }
  ]
}

규칙(marketSummary):
- 입력에 제시된 지수 종가(있다면)와 종목 뉴스 헤드라인만 근거로 작성.
- 추측·단정적 투자 권유 금지. 문장은 완결형 한국어.

규칙(notableStocks):
- 5~8개. 그날 시황에서 눈에 띄는 종목(상승률 상위·뉴스 헤드라인에 반복 등장·테마 대표주).
- 종목명은 입력 목록과 동일한 한글명. 가능하면 "code"에 입력과 동일한 6자리 종목코드.
- change는 입력 종목의 등락률(%)과 숫자로 일치시키거나, 확신 없으면 null. 0으로 채우지 마세요(후처리에서 TOP30·KIS로 보강).
- tradingValue는 알면 "1234억" 형태, 모르면 빈 문자열 "".
- note는 한 줄(30~60자), 뉴스 단서 기반.

규칙(stocks):
- 입력 순서를 그대로 유지하고 입력 개수와 동일한 길이의 배열.
- reason은 한국어 한 줄(20~40자), 그날 상승 핵심 이유를 뉴스 단서에서만 추출하세요.
- 뉴스에 명확한 단서가 없으면 reason은 빈 문자열 ""로 두세요. 절대 추정하지 마세요.
- theme는 1개 단일 한국어 키워드. 추천 목록: "AI 반도체", "2차전지", "바이오·신약", "로봇·휴머노이드", "조선·LNG", "방산", "원전·SMR", "AI 전력·인프라", "엔터·콘텐츠", "K뷰티", "정유·화학", "건설", "리튬·희토류", "우주·항공", "철강·소재", "유통·소비재", "금융", "테마성 단기상승", "관리종목·실적", "기타". 적절한 항목이 없으면 "기타".

규칙(topNews):
- 입력으로 받은 종목별 뉴스 헤드라인을 종합해, 그날 한국 증시 전체에 영향이 큰 핵심 뉴스 3~5개를 선정해 배열로 출력.
- title은 25자 내외, note는 1문장 이내(선택), source는 알면 적고 모르면 빈 문자열.
- 종목 한 개에만 국한된 단순 회사 발표보다 시장·업종·정책·매크로 임팩트가 큰 뉴스를 우선.`;

  const msg = await client.messages.create({
    model,
    max_tokens: 8192,
    system,
    messages: [{ role: "user", content: lines.join("\n") }],
  });

  const block = msg.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("Unexpected Claude response shape");
  const parsed = parseJsonFromAssistant(block.text);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.stocks)) {
    throw new Error("Claude output missing stocks array");
  }
  return {
    marketSummary: sanitizeStr(parsed.marketSummary),
    notableStocks: Array.isArray(parsed.notableStocks) ? parsed.notableStocks : [],
    stocks: parsed.stocks,
    topNews: Array.isArray(parsed.topNews) ? parsed.topNews : [],
  };
}

// ─── main ────────────────────────────────────────────────
async function main() {
  const appKey = requireEnv("KIS_APP_KEY");
  const appSecret = requireEnv("KIS_APP_SECRET");
  const anthropicKey = requireEnv("ANTHROPIC_API_KEY");

  const baseUrl = (process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(/\/+$/, "");
  const outputPath = path.resolve(process.env.OUTPUT_PATH || path.join("data", "daily-market.json"));
  const topN = Math.max(1, Math.min(50, Number(process.env.TOP_N) || 30));
  const perStock = Math.max(1, Math.min(10, Number(process.env.NEWS_PER_STOCK) || 5));
  const concurrency = Math.max(1, Math.min(10, Number(process.env.NEWS_CONCURRENCY) || 2));
  const perDelay = Math.max(0, Math.min(5000, Number(process.env.NEWS_DELAY_MS) || 500));
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  const forceNaver = process.env.SOURCE === "naver";
  const targetYmd =
    process.env.TARGET_DATE && YMD_RE.test(process.env.TARGET_DATE)
      ? process.env.TARGET_DATE
      : seoulYmd(new Date());

  console.log(
    `Target date: ${targetYmd} | TOP ${topN} | news/stock: ${perStock} | concurrency: ${concurrency} | delay: ${perDelay}ms`
  );

  let top = [];
  let rankingSource = "";
  let kisOAuthToken = null;

  if (!forceNaver) {
    console.log("[1/6] KIS access token from env...");
    kisOAuthToken = getKisToken();

    console.log("[2/6] KIS 상승률 랭킹 (KOSPI/KOSDAQ)...");
    const [kospi, kosdaq] = await Promise.all([
      fetchFluctuationRanking({
        baseUrl,
        token: kisOAuthToken,
        appKey,
        appSecret,
        marketCode: "0001",
        marketLabel: "KOSPI",
      }),
      fetchFluctuationRanking({
        baseUrl,
        token: kisOAuthToken,
        appKey,
        appSecret,
        marketCode: "1001",
        marketLabel: "KOSDAQ",
      }),
    ]);
    console.log(`  KOSPI rows: ${kospi.length} | KOSDAQ rows: ${kosdaq.length}`);

    const merged = new Map();
    for (const r of [...kospi, ...kosdaq]) {
      if (!merged.has(r.code)) merged.set(r.code, r);
    }
    const all = [...merged.values()].filter((r) => r.change != null);
    const allZero = all.length > 0 && all.every((s) => Number(s.change) === 0);
    if (allZero) {
      console.warn(
        "  ⚠ KIS 응답이 모두 0% (장 시작 전·후 휴장 시간). 네이버 금융 fallback으로 전환합니다."
      );
    } else {
      all.sort((a, b) => (b.change || 0) - (a.change || 0));
      top = all.slice(0, topN).map((r, i) => ({ ...r, rank: i + 1 }));
      rankingSource = "KIS";
    }
  }

  if (top.length === 0) {
    console.log("[2/6] 네이버 금융 상승률 랭킹 (KOSPI/KOSDAQ)...");
    const [kospi, kosdaq] = await Promise.all([
      fetchNaverFinanceRanking({ marketCode: 0, marketLabel: "KOSPI", maxPages: 2 }),
      fetchNaverFinanceRanking({ marketCode: 1, marketLabel: "KOSDAQ", maxPages: 2 }),
    ]);
    console.log(`  KOSPI rows: ${kospi.length} | KOSDAQ rows: ${kosdaq.length}`);
    const merged = new Map();
    for (const r of [...kospi, ...kosdaq]) {
      if (!merged.has(r.code)) merged.set(r.code, r);
    }
    const all = [...merged.values()]
      .filter((r) => r.change != null)
      .sort((a, b) => (b.change || 0) - (a.change || 0));
    top = all.slice(0, topN).map((r, i) => ({ ...r, rank: i + 1 }));
    rankingSource = "NaverFinance";
  }

  if (!top.length) {
    console.error("상승률 데이터가 비어 있습니다.");
    process.exit(1);
  }

  if (!kisOAuthToken) {
    console.log("[2b/6] KIS access token from env (특징주 개별 시세 보강용)...");
    kisOAuthToken = getKisToken();
  }

  console.log(
    `  Source=${rankingSource} | Top ${top.length}: ${top.slice(0, 3).map((s) => `${s.name}(${s.change}%)`).join(", ")} ...`
  );

  console.log("[3/6] 코스피·코스닥 지수 (네이버 금융)...");
  let indexes = [];
  try {
    const [kp, kq] = await Promise.all([
      fetchNaverFinanceIndex("KOSPI", "코스피"),
      fetchNaverFinanceIndex("KOSDAQ", "코스닥"),
    ]);
    indexes = [kp, kq].filter((i) => i && i.value);
    console.log(
      "  " +
        indexes
          .map((i) => `${i.name} ${i.value}(${i.change == null ? "—" : (i.change > 0 ? "+" : "") + i.change}%)`)
          .join(" | ")
    );
  } catch (e) {
    console.warn(`  지수 조회 실패: ${e.message || e}`);
  }

  console.log(`[4/6] 종목별 네이버 뉴스 (${top.length}종목)...`);
  const newsMap = await fetchNewsForStocks(top, perStock, concurrency, perDelay);
  const noNewsCount = top.filter((s) => (newsMap.get(s.code) || []).length === 0).length;
  console.log(`  뉴스 수집 완료 (뉴스 없음: ${noNewsCount}종목)`);

  console.log("[5/6] Claude 분석 (이유·테마 + 주요 뉴스)...");
  const ai = await classifyWithClaude({
    apiKey: anthropicKey, model, targetYmd, stocks: top, newsMap, indexes,
  });

  const byCode = new Map();
  for (const r of ai.stocks) {
    if (r && typeof r === "object" && r.code) {
      byCode.set(String(r.code), {
        reason: sanitizeStr(r.reason),
        theme: sanitizeStr(r.theme) || "기타",
      });
    }
  }

  const topGainers = top.map((s) => {
    const extra = byCode.get(s.code) || { reason: "", theme: "기타" };
    return {
      rank: s.rank,
      code: s.code,
      name: s.name,
      market: s.market,
      change: s.change,
      currentPrice: s.currentPrice,
      tradingValue: formatTradingValue(s.tradingValue),
      reason: extra.reason,
      theme: extra.theme,
      newsTitles: (newsMap.get(s.code) || []).slice(0, perStock),
    };
  });

  // 테마별 그룹화 (인기 테마부터)
  const themeMap = new Map();
  for (const s of topGainers) {
    const t = s.theme || "기타";
    if (!themeMap.has(t)) themeMap.set(t, []);
    themeMap.get(t).push({
      name: s.name,
      change: s.change,
      reason: s.reason,
      code: s.code,
      market: s.market,
    });
  }
  const themes = [...themeMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, leaders]) => ({
      name,
      note: "",
      leaders: leaders.sort((x, y) => (y.change || 0) - (x.change || 0)),
    }));

  const topNews = (ai.topNews || []).slice(0, 5).map((n) => ({
    title: sanitizeStr(n.title),
    note: sanitizeStr(n.note),
    source: sanitizeStr(n.source),
    url: typeof n.url === "string" && /^https?:\/\//i.test(n.url) ? n.url : "",
  })).filter((n) => n.title);

  const notableStocks = await finalizeNotableStocks(ai.notableStocks, topGainers, {
    baseUrl,
    token: kisOAuthToken,
    appKey,
    appSecret,
  });
  const summary = sanitizeStr(ai.marketSummary);

  console.log("[6/6] daily-market.json 갱신...");
  const data = (await readJsonIfExists(outputPath)) || {
    meta: { title: "장마감 리포트", timezoneNote: "KST 기준. 특별한 표기가 없으면 종가 기준입니다." },
    days: {},
  };
  if (!data.days || typeof data.days !== "object") data.days = {};
  const existing = data.days[targetYmd] || {};
  data.days[targetYmd] = {
    ...existing,
    summary: summary || sanitizeStr(existing.summary),
    notableStocks: notableStocks.length ? notableStocks : (existing.notableStocks || []),
    indexes: indexes.length ? indexes : (existing.indexes || []),
    themes,
    news: topNews.length ? topNews : (existing.news || []),
    topGainers,
    topGainersUpdatedAt: seoulYmd(new Date()),
    topGainersSource: `${rankingSource}+Naver+Claude`,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outputPath} (key=${targetYmd})`);

  // 결과 미리보기
  console.log("\n=== 미리보기 ===");
  console.log("지수:");
  indexes.forEach((i) => console.log(`  ${i.name} ${i.value} (${i.change == null ? "—" : (i.change > 0 ? "+" : "") + i.change}%)`));
  console.log("테마별 종목 그룹:");
  themes.slice(0, 6).forEach((t) => {
    console.log(`  [${t.name}] (${t.leaders.length}종목)`);
    t.leaders.slice(0, 3).forEach((l) => {
      console.log(`    - ${l.name} ${l.change}% — ${l.reason || "(이유 미상)"}`);
    });
  });
  console.log("주요 뉴스:");
  topNews.forEach((n, i) => console.log(`  ${i + 1}. ${n.title}${n.source ? ` (${n.source})` : ""}`));
  if (summary) {
    console.log("시황 요약:");
    console.log("  " + summary.replace(/\n/g, "\n  "));
  }
  console.log(`특징주: ${notableStocks.length}건`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack || e.message) : e);
  process.exit(1);
});
