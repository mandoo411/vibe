/**
 * 마감 리포트 본문 자동 생성 (GitHub Actions 전용)
 *
 * 시우 PC의 Cowork 예약작업이 하던 일을 러너 안에서 대체한다.
 * PC가 꺼져 있어도 data/daily-market.json의 지수·수급·특징주·본문이 채워진다.
 *
 * 데이터 출처 (전부 날짜 지정 가능 → 과거 날짜 백필도 동일 스크립트로 처리)
 *   - 지수 OHLC      : KIS inquire-daily-indexchartprice (FHKUP03500100)
 *   - 투자자 수급    : KIS inquire-investor-daily-by-market (FHPTJ04040000)
 *   - 업종 등락      : KIS inquire-index-price (당일만 유효)
 *   - 원/달러        : Yahoo Finance KRW=X 일봉
 *   - 뉴스           : 언론사 RSS + 네이버 종목뉴스 (종목 재료의 유일한 근거)
 *   - 본문(analysis) : OpenAI (뉴스에 없는 재료는 쓰지 못하도록 기존 시스템 프롬프트 재사용)
 *
 * 환경변수
 *   KIS_APP_KEY / KIS_APP_SECRET / KIS_ACCESS_TOKEN   필수
 *   OPENAI_API_KEY                                     없으면 데이터만 채우고 본문은 건너뜀
 *   OPENAI_MODEL        기본 gpt-5.1 (사용 불가 시 gpt-5-mini로 자동 강등)
 *   TARGET_DATE         YYYY-MM-DD (기본: 오늘 KST)
 *   FORCE=1             이미 analysis가 있어도 덮어씀 (기본은 건너뜀 — PC 결과 보호)
 *   SKIP_AI=1           본문 생성 생략 (데이터만)
 */

import fs from "fs/promises";
import path from "path";

import {
  fetchSupplyBothMarkets,
  fetchSectorMoves,
  fetchVolumeTopMerged,
} from "./daily-market-kis-extra.mjs";
import { fetchPressNewsAll } from "./live-report-site-news.mjs";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildSupplyComment,
  normalizeFeaturedList,
} from "./daily-market-ai.mjs";
import { ensureJsonSafe, parseJsonFromAssistant } from "./claude-utils.mjs";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const FALLBACK_MODEL = "gpt-5-mini";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 없습니다`);
  return v;
}

function seoulYmd(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
}

function compact(ymd) {
  return String(ymd).replace(/-/g, "");
}

function shiftYmd(ymd, days) {
  const t = new Date(`${ymd}T12:00:00+09:00`).getTime() + days * 86400000;
  return seoulYmd(new Date(t));
}

function num(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/,/g, "").replace(/%/g, "").replace(/^\+/, ""));
  return Number.isFinite(n) ? n : null;
}

function round(n, digits = 2) {
  if (n == null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── KIS ────────────────────────────────────────────────────────────────

async function kisGet(url, trId, ctx) {
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${ctx.token}`,
      appkey: ctx.appKey,
      appsecret: ctx.appSecret,
      tr_id: trId,
      custtype: "P",
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`KIS invalid JSON (${trId}): ${text.slice(0, 160)}`);
  }
  if (!res.ok) throw new Error(`KIS HTTP ${res.status} (${trId})`);
  if (json.rt_cd && json.rt_cd !== "0") {
    throw new Error(`KIS rt_cd=${json.rt_cd} (${trId}) ${json.msg1 || ""}`);
  }
  return json;
}

/** 지수 일봉 — 지정 날짜의 시/고/저/종가와 전일대비 */
async function fetchIndexDaily(ctx, iscd, ymd) {
  const url = new URL(`${ctx.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "U");
  url.searchParams.set("FID_INPUT_ISCD", iscd);
  url.searchParams.set("FID_INPUT_DATE_1", compact(shiftYmd(ymd, -14)));
  url.searchParams.set("FID_INPUT_DATE_2", compact(ymd));
  url.searchParams.set("FID_PERIOD_DIV_CODE", "D");

  const json = await kisGet(url, "FHKUP03500100", ctx);
  const rows = Array.isArray(json.output2) ? json.output2 : [];
  const target = compact(ymd);

  // KIS 응답은 같은 값이 대소문자·접두어가 다른 키로 오는 경우가 있어 후보를 모두 훑는다
  const pick = (row, names) => {
    for (const n of names) {
      for (const k of [n, n.toUpperCase()]) {
        if (row?.[k] !== undefined && row[k] !== "") {
          const v = num(row[k]);
          if (v != null) return v;
        }
      }
    }
    return null;
  };
  const dateOf = (row) =>
    String(row?.stck_bsop_date ?? row?.STCK_BSOP_DATE ?? row?.bsop_date ?? row?.BSOP_DATE ?? "");

  const CLOSE = ["bstp_nmix_prpr", "nmix_prpr", "stck_clpr", "stck_prpr"];
  const OPEN = ["bstp_nmix_oprc", "nmix_oprc", "stck_oprc"];
  const HIGH = ["bstp_nmix_hgpr", "nmix_hgpr", "stck_hgpr"];
  const LOW = ["bstp_nmix_lwpr", "nmix_lwpr", "stck_lwpr"];

  const idx = rows.findIndex((r) => dateOf(r) === target);
  if (idx < 0) {
    console.warn(`  ${iscd}: ${ymd} 일봉이 응답에 없습니다 (수신 ${rows.length}행)`);
    return null;
  }

  const row = rows[idx];
  // output2는 최신순 — 다음 인덱스가 전 거래일
  const prev = rows[idx + 1] || null;
  const close = pick(row, CLOSE);
  const open = pick(row, OPEN);
  const prevClose = prev ? pick(prev, CLOSE) : null;
  if (close == null) return null;

  const change =
    prevClose != null ? round(close - prevClose, 2) : pick(row, ["bstp_nmix_prdy_vrss", "prdy_vrss"]);
  const changePercent =
    prevClose != null && prevClose !== 0
      ? round(((close - prevClose) / prevClose) * 100, 2)
      : pick(row, ["prdy_ctrt", "bstp_nmix_prdy_ctrt"]);

  return {
    close,
    change,
    changePercent,
    open,
    high: pick(row, HIGH),
    low: pick(row, LOW),
    prevClose,
    openChange: open != null && prevClose != null ? round(open - prevClose, 2) : null,
    openChangePercent:
      open != null && prevClose ? round(((open - prevClose) / prevClose) * 100, 2) : null,
  };
}

// ─── 원/달러 ────────────────────────────────────────────────────────────

async function fetchUsdKrw(ymd) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1d&range=3mo";
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Yahoo KRW=X HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const stamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];

  const series = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const c = closes[i];
    if (c == null) continue;
    series.push({ ymd: seoulYmd(new Date(stamps[i] * 1000)), rate: c });
  }
  const idx = series.findIndex((r) => r.ymd === ymd);
  if (idx < 0) return null;
  const rate = round(series[idx].rate, 2);
  const prev = idx > 0 ? round(series[idx - 1].rate, 2) : null;
  const diff = prev != null ? round(rate - prev, 2) : null;

  let note = `${rate.toLocaleString("ko-KR", { minimumFractionDigits: 2 })}원에 마감했다.`;
  if (diff != null && diff !== 0) {
    const dir = diff > 0 ? "오른" : "내린";
    const weak = diff > 0 ? "약세" : "강세";
    note = `전 거래일보다 ${Math.abs(diff).toFixed(2)}원 ${dir} ${rate.toLocaleString("ko-KR", {
      minimumFractionDigits: 2,
    })}원에 마감하며 원화가 ${weak}를 보였다.`;
  }
  return { rate, change: diff, note };
}

// ─── 뉴스 ───────────────────────────────────────────────────────────────

async function fetchNaverStockNews(code, limit = 5) {
  const url = `https://m.stock.naver.com/api/news/stock/${encodeURIComponent(code)}?pageSize=${limit}&page=1`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Referer: "https://m.stock.naver.com/" },
    });
    if (!res.ok) return [];
    const json = await res.json();
    const groups = Array.isArray(json) ? json : [];
    const titles = [];
    for (const g of groups) {
      const items = Array.isArray(g?.items) ? g.items : [g];
      for (const it of items) {
        const t = String(it?.title || "").replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, " ").trim();
        const dt = String(it?.datetime || it?.officeName || "");
        if (t) titles.push({ title: t, datetime: dt });
      }
    }
    return titles.slice(0, limit);
  } catch {
    return [];
  }
}

function titlesToText(rows) {
  if (!rows?.length) return "(수집된 뉴스 없음)";
  return rows.map((r) => (typeof r === "string" ? r : r.title)).filter(Boolean).join(" / ");
}

function pickNews(pressNews, keywords) {
  const re = new RegExp(keywords.join("|"));
  return pressNews.filter((n) => re.test(String(n.title || ""))).slice(0, 12);
}

/** Anthropic web_search 대신 RSS + 네이버 종목뉴스로 searchContext를 만든다 */
async function collectNewsContext({ targetYmd, topGainers, topDecliners, isToday }) {
  let pressNews = [];
  if (isToday) {
    try {
      pressNews = await fetchPressNewsAll(targetYmd);
    } catch (e) {
      console.warn("[closing-report] RSS 수집 실패:", e?.message || e);
    }
  } else {
    console.log("[closing-report] 과거 날짜 — RSS는 당일 기사만 제공하므로 생략");
  }

  const macroNews = titlesToText(pressNews.slice(0, 20));
  const fomcNews = titlesToText(pickNews(pressNews, ["FOMC", "연준", "금리", "파월", "국채"]));
  const foreignFlowNews = titlesToText(
    pickNews(pressNews, ["외국인", "기관", "순매수", "순매도", "수급"])
  );

  const candidates = [...(topGainers || []).slice(0, 12), ...(topDecliners || []).slice(0, 5)];
  const stockNews = {};
  for (const s of candidates) {
    if (!s?.code || stockNews[s.code]) continue;
    const rows = await fetchNaverStockNews(s.code, 5);
    stockNews[s.code] = titlesToText(rows);
    await delay(200);
  }

  const found = Object.values(stockNews).filter((t) => t && t !== "(수집된 뉴스 없음)").length;
  console.log(
    `[closing-report] 뉴스 수집 — 언론 RSS ${pressNews.length}건, 종목뉴스 ${found}/${Object.keys(stockNews).length}종목`
  );

  return { macroNews, fomcNews, foreignFlowNews, stockNews, riseNews: stockNews, declineNews: stockNews, pressNews };
}

// ─── OpenAI ─────────────────────────────────────────────────────────────

async function callOpenAI({ apiKey, model, system, user }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const json = JSON.parse(text);
  const usage = json?.usage || {};
  console.log(
    `[closing-report] OpenAI ${model} — 입력 ${usage.prompt_tokens ?? "?"} / 출력 ${usage.completion_tokens ?? "?"} 토큰`
  );
  return json?.choices?.[0]?.message?.content || "";
}

function isModelUnavailable(error) {
  const body = String(error?.body || error?.message || "");
  return error?.status === 404 || /model_not_found|does not exist|not have access/i.test(body);
}

// ─── 조립 ───────────────────────────────────────────────────────────────

function fmtEokSigned(v) {
  if (v == null) return null;
  const sign = v >= 0 ? "+" : "-";
  const label = v >= 0 ? "순매수" : "순매도";
  return `${sign}${Math.abs(Math.round(v)).toLocaleString("ko-KR")}억(${label})`;
}

function buildInvestorTrend(supply) {
  const out = {};
  for (const row of supply || []) {
    const key = row.market === "코스닥" ? "kosdaq" : "kospi";
    const entry = {};
    const f = fmtEokSigned(row.foreign);
    const i = fmtEokSigned(row.institution);
    const r = fmtEokSigned(row.retail ?? row.individual);
    if (f) entry.foreign = f;
    if (i) entry.institution = i;
    if (r) entry.individual = r;
    if (Object.keys(entry).length) out[key] = entry;
  }
  return out;
}

function toneFrom(kospi, kosdaq) {
  const a = kospi?.changePercent ?? 0;
  const b = kosdaq?.changePercent ?? 0;
  const avg = (a + b) / 2;
  if (avg >= 1.5) return "강세 확산";
  if (avg >= 0.3) return "완만한 상승";
  if (avg > -0.3) return "보합 혼조";
  if (avg > -1.5) return "약세 조정";
  return "동반 급락";
}

async function main() {
  const targetYmd =
    process.env.TARGET_DATE && YMD_RE.test(process.env.TARGET_DATE)
      ? process.env.TARGET_DATE
      : seoulYmd();
  const force = process.env.FORCE === "1";
  const skipAi = process.env.SKIP_AI === "1";
  const isToday = targetYmd === seoulYmd();
  const dataPath = path.resolve(process.env.DAILY_MARKET_PATH || path.join("data", "daily-market.json"));

  console.log(`[closing-report] 대상일 ${targetYmd} (${isToday ? "당일" : "백필"}) | FORCE=${force ? "on" : "off"}`);

  const raw = await fs.readFile(dataPath, "utf8");
  const doc = JSON.parse(raw);
  const day = doc?.days?.[targetYmd];
  if (!day) {
    console.error(`[closing-report] ${targetYmd} 항목이 없습니다 — 먼저 sync:kis가 돌아야 합니다.`);
    process.exit(1);
  }
  if (!Array.isArray(day.topGainers) || !day.topGainers.length) {
    console.error(`[closing-report] ${targetYmd} 순위 데이터가 비어 있습니다.`);
    process.exit(1);
  }
  const tradedToday = day.topGainers.some((s) => Number(s.change) !== 0);
  if (!tradedToday) {
    console.log(`[closing-report] ${targetYmd}는 휴장일로 판단 — 종료`);
    return;
  }
  if (day.analysis && !force) {
    console.log(`[closing-report] ${targetYmd} 본문이 이미 있습니다 — 건너뜀 (덮어쓰려면 FORCE=1)`);
    return;
  }

  const ctx = {
    baseUrl: (process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(/\/+$/, ""),
    token: requireEnv("KIS_ACCESS_TOKEN"),
    appKey: requireEnv("KIS_APP_KEY"),
    appSecret: requireEnv("KIS_APP_SECRET"),
  };

  // 1) 지수
  console.log("[1/5] 지수 일봉 (KIS)...");
  const [kospi, kosdaq] = await Promise.all([
    fetchIndexDaily(ctx, "0001", targetYmd).catch((e) => {
      console.warn("  코스피 실패:", e.message);
      return null;
    }),
    fetchIndexDaily(ctx, "1001", targetYmd).catch((e) => {
      console.warn("  코스닥 실패:", e.message);
      return null;
    }),
  ]);
  if (!kospi) {
    console.error("[closing-report] 코스피 지수를 못 받았습니다 — 중단 (부정확한 리포트 발행 방지)");
    process.exit(1);
  }
  console.log(`  코스피 ${kospi.close} (${kospi.changePercent}%) / 코스닥 ${kosdaq?.close ?? "-"} (${kosdaq?.changePercent ?? "-"}%)`);

  // 2) 수급
  console.log("[2/5] 투자자별 수급 (KIS)...");
  const supply = await fetchSupplyBothMarkets(ctx, targetYmd);
  const investorTrend = buildInvestorTrend(supply);
  console.log(`  수급 ${supply.length}개 시장 수신`);

  // 3) 환율·업종
  console.log("[3/5] 원/달러 · 업종 등락...");
  const usdkrw = await fetchUsdKrw(targetYmd).catch((e) => {
    console.warn("  환율 실패:", e.message);
    return null;
  });
  let sectors = [];
  if (isToday) {
    sectors = await fetchSectorMoves(ctx).catch(() => []);
  }
  let volumeLeaders = [];
  if (isToday) {
    volumeLeaders = await fetchVolumeTopMerged(ctx, 20).catch(() => []);
  }

  const indexes = {
    kospi: { close: kospi.close, change: kospi.change, changePercent: kospi.changePercent },
  };
  if (kosdaq) {
    indexes.kosdaq = { close: kosdaq.close, change: kosdaq.change, changePercent: kosdaq.changePercent };
  }
  if (usdkrw) indexes.usdkrw = { rate: usdkrw.rate, note: usdkrw.note };

  const indexDetail = {};
  if (kospi.open != null) {
    indexDetail.kospi = { open: kospi.open, high: kospi.high, low: kospi.low };
  }
  if (kosdaq?.open != null) {
    indexDetail.kosdaq = { open: kosdaq.open, high: kosdaq.high, low: kosdaq.low };
  }

  // 4) 뉴스
  console.log("[4/5] 뉴스 수집...");
  const searchContext = await collectNewsContext({
    targetYmd,
    topGainers: day.topGainers,
    topDecliners: day.topDecliners,
    isToday,
  });

  // 5) 본문
  let aiResult = null;
  const apiKey = process.env.OPENAI_API_KEY;
  if (skipAi || !apiKey) {
    console.log(`[5/5] 본문 생성 생략 (${skipAi ? "SKIP_AI=1" : "OPENAI_API_KEY 없음"})`);
  } else {
    console.log("[5/5] OpenAI 본문 생성...");
    // buildUserPrompt는 지수를 [{name, value, change}] 배열로 받는다 (JSON 저장 형태와 다름)
    const promptIndexes = [];
    const idxLine = (name, d) =>
      d
        ? {
            name,
            value:
              `${d.close.toLocaleString("ko-KR")}` +
              (d.open != null ? ` (시가 ${d.open.toLocaleString("ko-KR")}` : "") +
              (d.high != null ? ` / 고가 ${d.high.toLocaleString("ko-KR")}` : "") +
              (d.low != null ? ` / 저가 ${d.low.toLocaleString("ko-KR")}` : "") +
              (d.open != null ? ")" : ""),
            change: d.changePercent,
          }
        : null;
    for (const row of [idxLine("코스피", kospi), idxLine("코스닥", kosdaq)]) {
      if (row) promptIndexes.push(row);
    }
    for (const s of sectors.slice(0, 12)) {
      promptIndexes.push({ name: `업종·${s.name}`, value: "—", change: s.changePct });
    }

    const system = buildSystemPrompt();
    const user = ensureJsonSafe(
      buildUserPrompt({
        targetYmd,
        indexes: promptIndexes,
        supply,
        marketExtras: usdkrw
          ? [
              {
                label: "원/달러",
                value: String(usdkrw.rate),
                valueFormatted: usdkrw.note,
              },
            ]
          : [],
        topGainers: day.topGainers,
        topDecliners: day.topDecliners,
        mcapRankByCode: {},
        searchContext,
      })
    );

    const wanted = process.env.OPENAI_MODEL || "gpt-5.1";
    let content = "";
    try {
      content = await callOpenAI({ apiKey, model: wanted, system, user });
    } catch (e) {
      if (isModelUnavailable(e) && wanted !== FALLBACK_MODEL) {
        console.warn(`  ${wanted} 사용 불가 → ${FALLBACK_MODEL}로 재시도`);
        content = await callOpenAI({ apiKey, model: FALLBACK_MODEL, system, user });
      } else {
        throw e;
      }
    }
    const parsed = parseJsonFromAssistant(content);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("OpenAI 출력이 JSON이 아닙니다");
    }
    aiResult = parsed;
  }

  // 병합 — 실데이터가 없는 필드는 쓰지 않는다
  day.indexes = indexes;
  if (Object.keys(indexDetail).length) day.indexDetail = indexDetail;
  if (Object.keys(investorTrend).length) day.investor_trend = investorTrend;
  day.marketTone = toneFrom(kospi, kosdaq);

  if (aiResult) {
    const analysis = String(aiResult.analysis || aiResult.summary || "").trim();
    if (analysis) day.analysis = analysis;
    const featured = normalizeFeaturedList(aiResult.featured_stocks || aiResult.issueStocks);
    if (featured?.length) day.featured_stocks = featured;
    if (aiResult.marketTone) day.marketTone = String(aiResult.marketTone).trim();
  }

  // 서술형(AI)이 있으면 그쪽을 쓰고, 없을 때만 숫자 나열형으로 대체
  const supplyComment =
    (aiResult ? String(aiResult.supplyComment || "").trim() : "") ||
    buildSupplyComment(day.investor_trend);
  if (supplyComment) day.supplyComment = supplyComment;

  doc.days[targetYmd] = day;
  await fs.writeFile(dataPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  // 일자별 파일도 같이 갱신 (있을 때만)
  const perDayPath = path.resolve(path.join("data", "daily", `${targetYmd}.json`));
  try {
    const perDayRaw = await fs.readFile(perDayPath, "utf8");
    const perDay = JSON.parse(perDayRaw);
    Object.assign(perDay, {
      indexes: day.indexes,
      indexDetail: day.indexDetail,
      investor_trend: day.investor_trend,
      marketTone: day.marketTone,
      ...(day.analysis ? { analysis: day.analysis } : {}),
      ...(day.featured_stocks ? { featured_stocks: day.featured_stocks } : {}),
      ...(day.supplyComment ? { supplyComment: day.supplyComment } : {}),
    });
    await fs.writeFile(perDayPath, `${JSON.stringify(perDay, null, 2)}\n`, "utf8");
    console.log(`[closing-report] data/daily/${targetYmd}.json 도 갱신`);
  } catch (e) {
    if (e?.code !== "ENOENT") console.warn("[closing-report] 일자 파일 갱신 실패:", e.message);
  }

  console.log(
    `[closing-report] 완료 — 지수 ${indexes.kospi.close} / 수급 ${Object.keys(investorTrend).length}개 / 본문 ${
      day.analysis ? `${day.analysis.length}자` : "없음"
    } / 특징주 ${day.featured_stocks?.length ?? 0}종목`
  );
  console.log(`  업종 ${sectors.length}건, 거래량상위 ${volumeLeaders.length}건 (참고용 수집)`);
}

main().catch((err) => {
  console.error("[closing-report] 실패:", err?.stack || err?.message || err);
  process.exit(1);
});
