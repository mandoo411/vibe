#!/usr/bin/env node

import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import {
  fmtNumber,
  fmtPct,
  formatDateKo,
  mdText,
  readJson,
  requireEnv,
  sendTelegramMessage,
  seoulYmd,
  SITE_URL,
  toNum,
} from "./telegram-utils.mjs";

const DATA_PATH = process.env.LIVE_REPORT_PATH || "data/live-report.json";
const KIS_BASE_URL = (process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(/\/+$/, "");
const KIS_GAP_MS = Math.max(0, Number(process.env.KIS_API_GAP_MS) || 700);
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const NEWS_RSS_SOURCES = [
  "https://www.mk.co.kr/rss/30100041/",
  "https://rss.hankyung.com/stock.xml",
  "https://rss.hankyung.com/finance.xml",
];
const BLUECHIP_LIST = [
  "삼성전자",
  "SK하이닉스",
  "LG에너지솔루션",
  "삼성바이오로직스",
  "현대차",
  "기아",
  "셀트리온",
  "POSCO홀딩스",
  "LG화학",
  "삼성SDI",
  "현대모비스",
  "카카오",
  "네이버",
  "삼성물산",
  "한화에어로스페이스",
  "두산에너빌리티",
  "HD현대중공업",
  "고려아연",
  "에코프로비엠",
  "포스코퓨처엠",
  "SK이노베이션",
  "LG전자",
  "현대건설",
  "한국전력",
  "KT",
];
const BLUECHIP_CODES = {
  삼성전자: "005930",
  SK하이닉스: "000660",
  LG에너지솔루션: "373220",
  삼성바이오로직스: "207940",
  현대차: "005380",
  기아: "000270",
  셀트리온: "068270",
  POSCO홀딩스: "005490",
  LG화학: "051910",
  삼성SDI: "006400",
  현대모비스: "012330",
  카카오: "035720",
  네이버: "035420",
  삼성물산: "028260",
  한화에어로스페이스: "012450",
  두산에너빌리티: "034020",
  HD현대중공업: "329180",
  고려아연: "010130",
  에코프로비엠: "247540",
  포스코퓨처엠: "003670",
  SK이노베이션: "096770",
  LG전자: "066570",
  현대건설: "000720",
  한국전력: "015760",
  KT: "030200",
};
const THEME_KEYWORDS = {
  우주항공: ["한화에어로스페이스", "AP위성", "켄코아에어로스페이스", "비투엔", "쎄트렉아이", "인텔리안테크", "AP우주항공"],
  AI반도체: ["삼성전자", "SK하이닉스", "한미반도체", "리노공업", "HPSP", "이수페타시스"],
  "2차전지": ["에코프로", "에코프로비엠", "포스코퓨처엠", "삼성SDI", "LG에너지솔루션", "엘앤에프"],
  바이오: ["삼성바이오로직스", "셀트리온", "유한양행", "한미약품", "레고켐바이오"],
  방산: ["한화에어로스페이스", "현대로템", "LIG넥스원", "한국항공우주"],
  원전: ["두산에너빌리티", "한전기술", "비에이치아이", "우리기술"],
  로봇: ["레인보우로보틱스", "HD현대", "두산로보틱스"],
  스페이스X: ["AP위성", "켄코아에어로스페이스", "쎄트렉아이", "이노스페이스", "AP우주항공"],
};
const THEME_EMOJI = {
  우주항공: "🚀",
  AI반도체: "💾",
  "2차전지": "🔋",
  바이오: "💊",
  방산: "🛡️",
  원전: "⚛️",
  로봇: "🤖",
  스페이스X: "🚀",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch (_) {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_, num) => {
      try {
        return String.fromCodePoint(Number(num));
      } catch (_) {
        return "";
      }
    })
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value) {
  return decodeEntities(String(value || "").replace(/<[^>]+>/g, " "));
}

function uniqueTitles(titles, limit = 3) {
  const seen = new Set();
  const out = [];
  for (const title of titles) {
    const clean = stripHtml(title);
    if (!clean || clean.length < 6) continue;
    const key = clean.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function seoulClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: map.weekday,
    hour: Number(map.hour),
    minute: Number(map.minute),
    minutes: Number(map.hour) * 60 + Number(map.minute),
  };
}

function assertMarketOpen() {
  const clock = seoulClock();
  const weekdayOpen = clock.weekday !== "Sat" && clock.weekday !== "Sun";
  if (!weekdayOpen || clock.minutes < 9 * 60 || clock.minutes > 15 * 60 + 30) {
    console.log("현재 장 운영 시간이 아닙니다.");
    return null;
  }
  return `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
}

function normalizeSlotTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const rounded = m < 15 ? 0 : m < 45 ? 30 : 0;
  const hour = m >= 45 ? h + 1 : h;
  return `${String(hour).padStart(2, "0")}:${String(rounded).padStart(2, "0")}`;
}

function kisHeaders(trId, token, appKey, appSecret, trCont = "") {
  return {
    "content-type": "application/json; charset=utf-8",
    authorization: `Bearer ${token}`,
    appkey: appKey,
    appsecret: appSecret,
    tr_id: trId,
    custtype: "P",
    tr_cont: trCont,
  };
}

async function kisGet(path, trId, params, token, appKey, appSecret, trCont = "") {
  await sleep(KIS_GAP_MS);
  const url = new URL(path, KIS_BASE_URL);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, value == null ? "" : String(value)));
  const res = await fetch(url, { headers: kisHeaders(trId, token, appKey, appSecret, trCont) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`KIS invalid JSON ${path}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`KIS HTTP ${res.status} ${path}: ${text.slice(0, 300)}`);
  if (json.rt_cd && json.rt_cd !== "0") throw new Error(`KIS rt_cd=${json.rt_cd} msg=${json.msg1 || json.msg_cd || ""}`);
  return json;
}

function outputRows(json) {
  const out = json?.output;
  if (Array.isArray(out)) return out;
  if (out && typeof out === "object") return [out];
  return [];
}

function pickIndexValue(row) {
  return row?.nmix_prpr || row?.NMIX_PRPR || row?.nmix_nmix_prpr || row?.bstp_nmix_prpr || row?.stck_prpr || "";
}

async function fetchIndex(fidInputIscd, label, token, appKey, appSecret) {
  const json = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-index-price",
    "FHPUP02100000",
    { fid_cond_mrkt_div_code: "J", fid_input_iscd: fidInputIscd },
    token,
    appKey,
    appSecret
  );
  const row = outputRows(json)[0] || json.output || {};
  return {
    label,
    value: toNum(pickIndexValue(row)),
    change: toNum(row.prdy_ctrt || row.bstp_nmix_prdy_ctrt || row.nmix_prdy_ctrt),
  };
}

function pickTradingValue(row) {
  return row?.acml_tr_pbmn || row?.ACML_TR_PBMN || row?.tr_pbmn || row?.TR_PBMN || "";
}

async function fetchFluctuationRanking(marketCode, marketLabel, token, appKey, appSecret) {
  const json = await kisGet(
    "/uapi/domestic-stock/v1/ranking/fluctuation",
    "FHPST01700000",
    {
      fid_cond_mrkt_div_code: "J",
      fid_cond_scr_div_code: "20170",
      fid_input_iscd: marketCode,
      fid_rank_sort_cls_code: "0",
      fid_input_cnt_1: "0",
      fid_prc_cls_code: "0",
      fid_input_price_1: "",
      fid_input_price_2: "",
      fid_vol_cnt: "",
      fid_trgt_cls_code: "0",
      fid_trgt_exls_cls_code: "0000000000",
      fid_div_cls_code: "0",
      fid_rsfl_rate1: "",
      fid_rsfl_rate2: "",
    },
    token,
    appKey,
    appSecret
  );
  return outputRows(json)
    .map((row) => ({
      code: String(row.stck_shrn_iscd || "").trim(),
      name: String(row.hts_kor_isnm || "").trim(),
      market: marketLabel,
      price: toNum(row.stck_prpr),
      rate: toNum(row.prdy_ctrt),
      volume: toNum(row.acml_vol),
      tradingValue: toNum(pickTradingValue(row)),
    }))
    .filter((row) => row.code && row.name && row.rate != null);
}

async function fetchStockQuote(code, fallbackName, token, appKey, appSecret) {
  for (const marketCode of ["J", "Q"]) {
    try {
      const json = await kisGet(
        "/uapi/domestic-stock/v1/quotations/inquire-price",
        "FHKST01010100",
        { FID_COND_MRKT_DIV_CODE: marketCode, FID_INPUT_ISCD: code },
        token,
        appKey,
        appSecret
      );
      const row = outputRows(json)[0] || json.output || {};
      const rate = toNum(row.prdy_ctrt);
      if (rate == null) continue;
      return {
        code,
        name: String(row.hts_kor_isnm || fallbackName || "").trim(),
        price: toNum(row.stck_prpr),
        rate,
        volume: toNum(row.acml_vol),
        tradingValue: toNum(pickTradingValue(row)),
      };
    } catch (_) {
      // Some bluechips are not on this market division; try the next one.
    }
  }
  return null;
}

async function fetchBluechipMovers(token, appKey, appSecret) {
  const movers = [];
  for (const name of BLUECHIP_LIST) {
    const code = BLUECHIP_CODES[name];
    if (!code) continue;
    const quote = await fetchStockQuote(code, name, token, appKey, appSecret);
    if (!quote || Math.abs(quote.rate || 0) < 3) continue;
    const abs = Math.abs(quote.rate);
    const type =
      quote.rate >= 5
        ? { icon: "🔴", label: "급등 특징주", desc: "대형주 급등" }
        : quote.rate <= -5
          ? { icon: "🔵", label: "급락 특징주", desc: "대형주 급락" }
          : { icon: "⚡", label: "주목 특징주", desc: quote.rate > 0 ? "대형주 강세" : "대형주 약세" };
    movers.push({ ...quote, ...type });
  }
  movers.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));
  return movers;
}

async function fetchNaverFinanceNews(code) {
  if (!code) return [];
  const url = `https://finance.naver.com/item/news_news.naver?code=${encodeURIComponent(code)}&page=1`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "ko,en;q=0.9",
      },
    });
    if (!res.ok) return [];
    const html = new TextDecoder("euc-kr").decode(Buffer.from(await res.arrayBuffer()));
    const titles = [];
    const titleAttr = /title=["']([^"']+)["']/g;
    let match;
    while ((match = titleAttr.exec(html)) !== null) titles.push(match[1]);
    const anchorText = /<a[^>]+href=["'][^"']*news_read\.naver[^"']*["'][^>]*>([\s\S]*?)<\/a>/g;
    while ((match = anchorText.exec(html)) !== null) titles.push(match[1]);
    return uniqueTitles(titles, 3);
  } catch (_) {
    return [];
  }
}

async function fetchRssNewsPool() {
  const items = [];
  for (const url of NEWS_RSS_SOURCES) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) continue;
      const xml = await res.text();
      const itemRe = /<item\b[\s\S]*?<\/item>/g;
      const titleRe = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
      let match;
      while ((match = itemRe.exec(xml)) !== null) {
        const title = match[0].match(titleRe)?.[1];
        if (title) items.push(stripHtml(title));
      }
    } catch (_) {
      // RSS is an optional enrichment source.
    }
  }
  return uniqueTitles(items, 120);
}

function rssTitlesForStock(pool, name, limit = 3) {
  if (!name) return [];
  return uniqueTitles(pool.filter((title) => title.includes(name)), limit);
}

async function fetchNewsForRows(rows, rssPool) {
  const settled = await Promise.allSettled(
    rows.map(async (row) => {
      const titles = [
        ...(await fetchNaverFinanceNews(row.code)),
        ...rssTitlesForStock(rssPool, row.name, 3),
      ];
      return [row.code || row.name, uniqueTitles(titles, 3)];
    })
  );
  const map = new Map(rows.map((row) => [row.code || row.name, []]));
  for (const result of settled) {
    if (result.status === "fulfilled") map.set(result.value[0], result.value[1]);
  }
  return map;
}

function formatWon(value) {
  const n = toNum(value);
  if (n == null) return "-";
  return `${fmtNumber(n, 0)}원`;
}

function formatTradingValue(value) {
  const n = toNum(value);
  if (n == null || n <= 0) return "-";
  if (n >= 1_0000_0000_0000) return `${(n / 1_0000_0000_0000).toFixed(1).replace(/\\.0$/, "")}조`;
  if (n >= 1_0000_0000) return `${Math.round(n / 1_0000_0000).toLocaleString("ko-KR")}억`;
  return `${n.toLocaleString("ko-KR")}원`;
}

function detectThemeForRow(row) {
  const name = String(row?.name || "");
  if (!name) return null;
  for (const [theme, stocks] of Object.entries(THEME_KEYWORDS)) {
    if (stocks.some((stock) => name.includes(stock) || stock.includes(name))) {
      return { name: theme, emoji: THEME_EMOJI[theme] || "📌" };
    }
  }
  return null;
}

function rssTitlesForTheme(pool, theme, stocks, limit = 3) {
  return uniqueTitles(
    pool.filter((title) => title.includes(theme) || stocks.some((stock) => title.includes(stock))),
    limit
  );
}

function buildThemeSummary(rows, rssPool) {
  return Object.entries(THEME_KEYWORDS)
    .map(([name, stocks]) => {
      const matched = rows.filter((row) => {
        const rowName = String(row.name || "");
        return rowName && stocks.some((stock) => rowName.includes(stock) || stock.includes(rowName));
      });
      return {
        name,
        emoji: THEME_EMOJI[name] || "📌",
        rows: matched.map((row) => row.name),
        news: rssTitlesForTheme(rssPool, name, stocks, 3),
      };
    })
    .filter((theme) => theme.rows.length >= 3)
    .slice(0, 6);
}

function themeText(themes) {
  if (!themes.length) return "특정 테마 쏠림은 아직 뚜렷하지 않습니다.";
  return themes
    .map((theme) => {
      const newsLines = theme.news.length ? `\n   📰 ${theme.news.join("\n   📰 ")}` : "";
      return `${theme.emoji} ${theme.name}: ${theme.rows.slice(0, 8).join(", ")}${newsLines}`;
    })
    .join("\n");
}

function newsText(newsMap, rows) {
  return rows
    .map((row, index) => {
      const titles = newsMap.get(row.code || row.name) || [];
      const newsLines = titles.length ? titles.map((title) => `   📰 ${title}`).join("\n") : "   📰 관련 뉴스 없음";
      return `${index + 1}. ${row.name} ${fmtPct(row.rate, 1)}\n${newsLines}`;
    })
    .join("\n");
}

function bluechipText(rows, newsMap) {
  if (!rows.length) return "감지된 대형주 특징주 없음";
  return rows
    .map((row) => {
      const titles = newsMap.get(row.code || row.name) || [];
      const newsLines = titles.length ? titles.map((title) => `   📰 ${title}`).join("\n") : "   📰 관련 뉴스 없음";
      const label = row.rate >= 5 ? "급등" : row.rate <= -5 ? "급락" : "주목";
      return `${row.icon} ${row.name} ${fmtPct(row.rate, 1)} (${label})\n${newsLines}`;
    })
    .join("\n");
}

function topRowsText(rows) {
  return rows
    .map((row) => `${row.rank}. ${row.name} ${fmtPct(row.rate, 1)} 현재가 ${formatWon(row.price)} 거래대금 ${formatTradingValue(row.tradingValue)}`)
    .join("\n");
}

async function runClaude({ apiKey, time, kospi, kosdaq, top30, newsMap, themes, bluechipMovers, bluechipNewsMap }) {
  const client = new Anthropic({ apiKey });
  const user = `현재 시각: ${time}
코스피: ${fmtNumber(kospi.value, 2)} ${fmtPct(kospi.change, 2)}
코스닥: ${fmtNumber(kosdaq.value, 2)} ${fmtPct(kosdaq.change, 2)}

=== 상승률 TOP30 ===
${topRowsText(top30)}

=== TOP10 종목별 관련 뉴스 ===
${newsText(newsMap, top30.slice(0, 10))}

=== 오늘 감지된 테마 ===
${themeText(themes)}

=== 대형주 특징주 ===
${bluechipText(bluechipMovers, bluechipNewsMap)}

위 데이터를 바탕으로:
1. 🎙️ 현재 장세 총평 (3줄, 야구중계 스타일)
2. 🔥 오늘의 핵심 테마와 이유 (뉴스 근거)
3. ⚡ 특징주 분석 (대형주 급등락 이유)
4. 🎯 다음 30분 관전 포인트`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system:
      "당신은 주식시장 전문 해설가입니다. 야구 중계처럼 생동감 있고 흥미롭게 분석해주세요. 실제 뉴스와 데이터를 근거로 설명하고 왜 오르는지 이유와 맥락을 정확히 짚어주세요. 추측이 아닌 실제 뉴스 근거를 반드시 언급하세요. 이모지를 적절히 사용해 읽기 쉽게 작성해주세요.",
    messages: [{ role: "user", content: user }],
  });
  const block = msg.content.find((item) => item.type === "text");
  if (!block || block.type !== "text") throw new Error("Unexpected Claude response shape");
  return block.text.trim();
}

function buildTelegramMessage({ ymd, time, kospi, kosdaq, aiAnalysis, top30, newsMap }) {
  const lines = [
    "📺 *TotalMoney AI - 라이브 리포트*",
    `📅 ${formatDateKo(ymd)} *${time}* 현재`,
    "",
    `📈 코스피 *${fmtNumber(kospi.value, 0)}* ${fmtPct(kospi.change, 1)} | 코스닥 *${fmtNumber(kosdaq.value, 0)}* ${fmtPct(kosdaq.change, 1)}`,
    "",
    "━━━━━━━━━━━━━━━",
    "🎙️ *AI 장세 중계*",
    mdText(aiAnalysis),
    "",
    "━━━━━━━━━━━━━━━",
    "🏆 *상승률 TOP30*",
  ];
  top30.forEach((row) => {
    const theme = detectThemeForRow(row, newsMap.get(row.code || row.name) || []);
    const themeSuffix = theme ? ` ${theme.emoji}${mdText(theme.name)}` : "";
    const base = `${row.rank}위 ${mdText(row.name)} *${fmtPct(row.rate, 1)}*`;
    lines.push(`${base} ${formatWon(row.price)}${themeSuffix}`);
  });
  lines.push("", "━━━━━━━━━━━━━━━", `🔗 ${SITE_URL}/live-report.html`);
  return lines.join("\n");
}

async function writeLiveReport(payload) {
  let data;
  try {
    data = await readJson(DATA_PATH);
  } catch (_) {
    data = { date: payload.date, reports: [] };
  }
  if (data.date !== payload.date) {
    data = { date: payload.date, reports: [] };
  }
  data.reports = Array.isArray(data.reports) ? data.reports : [];
  data.reports = data.reports.filter((report) => report.time !== payload.time);
  data.reports.push(payload);
  data.reports.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function gitCommitAndPush(time) {
  if (process.env.LIVE_REPORT_SKIP_GIT === "1") {
    console.log("LIVE_REPORT_SKIP_GIT=1, skip git commit/push.");
    return;
  }
  execFileSync("git", ["config", "user.name", "github-actions[bot]"], { stdio: "inherit" });
  execFileSync("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], { stdio: "inherit" });
  execFileSync("git", ["add", DATA_PATH], { stdio: "inherit" });
  try {
    execFileSync("git", ["diff", "--cached", "--quiet", "--", DATA_PATH], { stdio: "ignore" });
    console.log("No live-report data changes to commit.");
    return;
  } catch (_) {
    // git diff --quiet exits 1 when there are staged changes.
  }
  execFileSync("git", ["commit", "-m", `chore(data): live report ${seoulYmd()} ${time} KST`], { stdio: "inherit" });
  execFileSync("git", ["pull", "--rebase", "origin", "main"], { stdio: "inherit" });
  execFileSync("git", ["push", "origin", "HEAD:main"], { stdio: "inherit" });
}

async function main() {
  const rawTime = assertMarketOpen();
  if (!rawTime) return;
  const time = normalizeSlotTime(rawTime);
  const ymd = seoulYmd();

  const token = requireEnv("KIS_ACCESS_TOKEN");
  const appKey = requireEnv("KIS_APP_KEY");
  const appSecret = requireEnv("KIS_APP_SECRET");
  const anthropicKey = requireEnv("ANTHROPIC_API_KEY");

  const kospi = await fetchIndex("0001", "코스피", token, appKey, appSecret);
  const kosdaq = await fetchIndex("1001", "코스닥", token, appKey, appSecret);

  const rankings = [
    ...(await fetchFluctuationRanking("0001", "KOSPI", token, appKey, appSecret)),
    ...(await fetchFluctuationRanking("1001", "KOSDAQ", token, appKey, appSecret)),
  ]
    .sort((a, b) => (b.rate || 0) - (a.rate || 0))
    .slice(0, 30)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  if (!rankings.length) throw new Error("상승률 TOP30 데이터가 비어 있습니다.");

  const rssPool = await fetchRssNewsPool();
  const newsMap = await fetchNewsForRows(rankings.slice(0, 10), rssPool);
  const themes = buildThemeSummary(rankings, rssPool);
  const bluechipMovers = await fetchBluechipMovers(token, appKey, appSecret);
  const bluechipNewsMap = await fetchNewsForRows(bluechipMovers, rssPool);

  const aiAnalysis = await runClaude({
    apiKey: anthropicKey,
    time,
    kospi,
    kosdaq,
    top30: rankings,
    newsMap,
    themes,
    bluechipMovers,
    bluechipNewsMap,
  });
  const top30 = rankings.map((row) => ({
    rank: row.rank,
    name: row.name,
    code: row.code,
    rate: row.rate,
    price: row.price,
  }));
  const top10 = top30.slice(0, 10);

  const payload = {
    time,
    kospi: { value: kospi.value, change: kospi.change },
    kosdaq: { value: kosdaq.value, change: kosdaq.change },
    aiAnalysis,
    top10,
    top30,
    themes: themes.map((theme) => ({ name: theme.name, emoji: theme.emoji, stocks: theme.rows, news: theme.news })),
    bluechipMovers: bluechipMovers.map((row) => ({
      name: row.name,
      code: row.code,
      rate: row.rate,
      price: row.price,
      type: row.label,
      news: bluechipNewsMap.get(row.code || row.name) || [],
    })),
  };

  await sendTelegramMessage(
    buildTelegramMessage({ ymd, time, kospi, kosdaq, aiAnalysis, top30, newsMap })
  );
  await writeLiveReport({ date: ymd, ...payload });
  gitCommitAndPush(time);
  console.log(`Live report sent and saved: ${ymd} ${time}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
