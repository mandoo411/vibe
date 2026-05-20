#!/usr/bin/env node

import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
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
const CHANNEL_LIMIT = 60;
const TOTAL_TIMEOUT = 60000;
const PRIORITY_1_KEYWORDS = [
  "스톡허브",
  "stockhub",
  "거시경제",
  "경제",
  "시황",
  "주식",
  "증시",
  "코스피",
  "코스닥",
  "매크로",
  "macro",
  "뉴스",
  "news",
  "리포트",
  "분석",
  "투자",
  "stock",
];
const PRIORITY_2_KEYWORDS = [
  "트레이딩",
  "매매",
  "선물",
  "옵션",
  "차트",
  "ETF",
  "펀드",
  "부동산",
  "금리",
  "환율",
];
const PRIORITY_3_KEYWORDS = [
  "크립토",
  "코인",
  "비트",
  "bitcoin",
  "crypto",
  "이더",
  "리플",
  "알트",
  "NFT",
  "defi",
  "web3",
];
const STOCK_KEYWORDS = [
  "주식",
  "증시",
  "코스피",
  "코스닥",
  "상한가",
  "하한가",
  "급등",
  "급락",
  "매수",
  "매도",
  "수급",
  "외국인",
  "기관",
  "테마",
  "섹터",
  "실적",
  "어닝",
  "배당",
  "공모",
  "상장",
  "IPO",
  "반도체",
  "AI",
  "인공지능",
  "2차전지",
  "배터리",
  "바이오",
  "방산",
  "스페이스X",
  "SpaceX",
  "우주",
  "위성",
  "원전",
  "SMR",
  "로봇",
  "조선",
  "금리",
  "환율",
  "달러",
  "유가",
  "금값",
  "원자재",
  "비트코인",
  "이더리움",
  "크립토",
  "암호화폐",
  "%",
  "상승",
  "하락",
  "급반등",
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
  "🚀 스페이스X/우주항공": ["스페이스X", "SpaceX", "우주항공", "위성", "발사체", "누리호", "이노스페이스", "우주"],
  "💾 AI/반도체": ["AI", "인공지능", "반도체", "HBM", "엔비디아", "NVIDIA", "파운드리", "칩"],
  "🔋 2차전지": ["2차전지", "배터리", "리튬", "양극재", "음극재", "전고체"],
  "💊 바이오": ["임상", "신약", "FDA", "허가", "바이오시밀러", "항암"],
  "🛡️ 방산": ["방산", "무기", "수출", "K방산", "미사일", "전투기"],
  "⚛️ 원전": ["원전", "SMR", "핵연료", "원자력"],
  "🤖 로봇": ["로봇", "자동화", "협동로봇", "휴머노이드"],
  "🚢 조선": ["조선", "LNG선", "수주", "HD현대중공업"],
};
const BLUECHIP_THRESHOLD = 3.0;
/** 코스피·코스닥 일반 종목 상한가 근접 (%) */
const LIMIT_UP_MIN_RATE = 29;

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

const LIVE_SLOTS = [
  "09:00",
  "09:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "12:00",
  "12:30",
  "13:00",
  "13:30",
  "14:00",
  "14:30",
  "15:00",
  "15:30",
];

function assertMarketOpen() {
  const clock = seoulClock();
  const weekdayOpen = clock.weekday !== "Sat" && clock.weekday !== "Sun";
  if (!weekdayOpen || clock.minutes < 9 * 60 || clock.minutes > 15 * 60 + 30) {
    console.log("현재 장 운영 시간이 아닙니다.");
    return null;
  }
  return clock;
}

function slotForClock(clock) {
  const rounded = clock.minute < 30 ? 0 : 30;
  return `${String(clock.hour).padStart(2, "0")}:${String(rounded).padStart(2, "0")}`;
}

function slotMinutes(time) {
  const [h, m] = String(time).split(":").map(Number);
  return h * 60 + m;
}

async function slotAlreadyPublished(date, time) {
  try {
    const data = await readJson(DATA_PATH);
    if (data.date !== date || !Array.isArray(data.reports)) return false;
    return data.reports.some((report) => report.time === time);
  } catch {
    return false;
  }
}

/** 장 시작 후 지난 슬롯 중 아직 JSON에 없는 시간 (오래된 순) */
async function unpublishedDueSlots(ymd, clock) {
  const force = process.env.LIVE_REPORT_FORCE === "1";
  const due = LIVE_SLOTS.filter((t) => slotMinutes(t) <= clock.minutes);
  if (force) return due;
  const missing = [];
  for (const time of due) {
    if (!(await slotAlreadyPublished(ymd, time))) missing.push(time);
  }
  return missing;
}

async function loadPreviousIndexes(date) {
  try {
    const data = await readJson(DATA_PATH);
    if (data.date !== date || !Array.isArray(data.reports) || !data.reports.length) return null;
    const last = data.reports[data.reports.length - 1];
    if (last?.kospi?.value > 0 && last?.kosdaq?.value > 0) {
      return { kospi: last.kospi, kosdaq: last.kosdaq };
    }
  } catch {
    // ignore
  }
  return null;
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
  if (!row || typeof row !== "object") return null;
  const keys = [
    "nmix_prpr",
    "NMIX_PRPR",
    "nmix_nmix_prpr",
    "NMIX_NMIX_PRPR",
    "bstp_nmix_prpr",
    "BSTP_NMIX_PRPR",
    "stck_prpr",
    "STCK_PRPR",
  ];
  for (const key of keys) {
    const value = toNum(row[key]);
    if (value != null && value !== 0) return value;
  }
  return null;
}

function indexPlausible(fidInputIscd, value) {
  if (!Number.isFinite(value)) return false;
  if (fidInputIscd === "0001") return value > 500 && value < 8000;
  if (fidInputIscd === "1001") return value > 300 && value < 4000;
  return true;
}

async function fetchIndex(fidInputIscd, label, token, appKey, appSecret) {
  let lastError;
  for (const fidCondMrktDivCode of ["J", "U"]) {
    try {
      const json = await kisGet(
        "/uapi/domestic-stock/v1/quotations/inquire-index-price",
        "FHPUP02100000",
        { fid_cond_mrkt_div_code: fidCondMrktDivCode, fid_input_iscd: fidInputIscd },
        token,
        appKey,
        appSecret
      );
      const row = outputRows(json)[0] || json.output || {};
      const value = pickIndexValue(row);
      if (indexPlausible(fidInputIscd, value)) {
        return {
          label,
          value,
          change: toNum(row.prdy_ctrt || row.bstp_nmix_prdy_ctrt || row.nmix_prdy_ctrt),
        };
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return { label, value: 0, change: 0 };
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
    if (!quote || Math.abs(quote.rate || 0) < BLUECHIP_THRESHOLD) continue;
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

/** Claude API JSON 오류 방지 — 깨진 UTF-16/이모지 서로게이트 제거 */
function sanitizeUnicode(value) {
  const s = String(value ?? "");
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(new TextEncoder().encode(s));
  } catch {
    return s.replace(/[\uD800-\uDFFF]/g, "").replace(/\uFFFD/g, "");
  }
}

/** Anthropic 요청 본문 직렬화 전 검증 */
function ensureJsonSafe(value, maxLen = 80_000) {
  let s = sanitizeUnicode(value);
  if (s.length > maxLen) s = `${sanitizeUnicode(s.slice(0, maxLen - 1))}…`;
  JSON.parse(JSON.stringify({ t: s }));
  return s;
}

function compactText(value, limit = 150) {
  let clean = sanitizeUnicode(stripHtml(value)).replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  clean = sanitizeUnicode(clean.slice(0, limit - 1));
  return `${clean}…`;
}

async function withTimeout(promise, ms, label, onTimeout = () => {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`${label} timeout ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function getChannelPriority(channelName) {
  const name = String(channelName || "").toLowerCase();
  if (PRIORITY_1_KEYWORDS.some((keyword) => name.includes(keyword.toLowerCase()))) {
    return { priority: 1, msgLimit: 20 };
  }
  if (PRIORITY_2_KEYWORDS.some((keyword) => name.includes(keyword.toLowerCase()))) {
    return { priority: 2, msgLimit: 10 };
  }
  if (PRIORITY_3_KEYWORDS.some((keyword) => name.includes(keyword.toLowerCase()))) {
    return { priority: 3, msgLimit: 3 };
  }
  return { priority: 4, msgLimit: 5 };
}

async function collectTelegramMessages() {
  const session = process.env.TELEGRAM_SESSION;
  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID || "", 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!session || !apiId || !apiHash) {
    console.log("텔레그램 세션 환경변수가 없어 채널 메시지 수집을 건너뜁니다.");
    return [];
  }

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3 });
  return withTimeout(
    (async () => {
      try {
        await client.connect();
        const dialogs = await client.getDialogs({});
        const allChannels = dialogs.filter((dialog) => dialog.isChannel || dialog.isGroup);
        const channels = allChannels
          .map((channel) => ({
            ...channel,
            ...getChannelPriority(channel.name),
          }))
          .sort((a, b) => a.priority - b.priority)
          .slice(0, CHANNEL_LIMIT);
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const priorityCounts = channels.reduce((counts, channel) => {
          counts[channel.priority] = (counts[channel.priority] || 0) + 1;
          return counts;
        }, {});

        console.log(`총 ${channels.length}개 채널 처리 시작`);
        console.log(
          `채널 우선순위: 1순위 ${priorityCounts[1] || 0}개, 2순위 ${priorityCounts[2] || 0}개, 3순위 ${priorityCounts[3] || 0}개, 미분류 ${priorityCounts[4] || 0}개`
        );

        const results = await Promise.allSettled(
          channels.map(async (channel) => {
            try {
              const messages = await client.getMessages(channel.entity, { limit: channel.msgLimit });
              return messages
                .filter((msg) => msg.message && new Date(Number(msg.date) * 1000) >= twoHoursAgo)
                .map((msg) => ({
                  channel: sanitizeUnicode(channel.name || "unknown"),
                  priority: channel.priority,
                  text: sanitizeUnicode(stripHtml(msg.message)),
                  date: new Date(Number(msg.date) * 1000),
                }));
            } catch (error) {
              console.log(`채널 읽기 실패: ${channel.name || "unknown"} - ${error.message}`);
              return [];
            }
          })
        );

        const allMessages = results
          .filter((result) => result.status === "fulfilled")
          .flatMap((result) => result.value)
          .filter((message) => message.text)
          .sort((a, b) => b.date - a.date);
        console.log(`총 ${allMessages.length}개 메시지 수집 완료`);
        return allMessages;
      } finally {
        await Promise.resolve(client.disconnect()).catch(() => {});
      }
    })(),
    TOTAL_TIMEOUT,
    "Telegram message collection",
    () => Promise.resolve(client.disconnect()).catch(() => {})
  ).catch((error) => {
    console.log(`텔레그램 메시지 수집 실패: ${error.message}`);
    return [];
  });
}

function filterStockMessages(messages) {
  return messages
    .filter((msg) => STOCK_KEYWORDS.some((keyword) => msg.text.includes(keyword)))
    .sort((a, b) => a.priority - b.priority || b.date - a.date)
    .slice(0, 50);
}

function getStockMessages(stockName, messages, limit = 3) {
  return messages
    .filter((message) => message.text.includes(stockName))
    .slice(0, limit)
    .map((message) => `[${message.channel}] ${compactText(message.text, 400)}`);
}

function buildStockMessageMap(rows, messages) {
  return new Map(rows.map((row) => [row.name, getStockMessages(row.name, messages)]));
}

function buildLimitUpStocks(rankings, stockMessages) {
  return rankings
    .filter((row) => (row.rate ?? 0) >= LIMIT_UP_MIN_RATE)
    .map((row) => {
      const messages = getStockMessages(row.name, stockMessages, 3);
      return {
        name: row.name,
        code: row.code,
        rate: row.rate,
        price: row.price,
        rank: row.rank,
        messages,
        comment: messages[0] || "",
      };
    });
}

function buildThemeSummary(messages) {
  return Object.entries(THEME_KEYWORDS)
    .map(([name, keywords]) => ({
      name,
      messages: messages
        .filter((message) => keywords.some((keyword) => message.text.includes(keyword)))
        .slice(0, 3)
        .map((message) => `[${message.channel}] ${compactText(message.text, 150)}`),
    }))
    .filter((theme) => theme.messages.length > 0)
    .slice(0, 8);
}

function telegramMessagesText(messages) {
  if (!messages.length) return "최근 2시간 내 수집된 주식 관련 메시지가 없습니다.";
  return messages
    .slice(0, 35)
    .map((message) => `${sanitizeUnicode(message.channel)}: ${compactText(message.text, 120)}`)
    .join("\n");
}

function stockMessagesText(rows, stockMessagesByName) {
  return rows
    .map((row, index) => {
      const messages = stockMessagesByName.get(row.name) || [];
      const lines = messages.length ? messages.map((message) => `   ${message}`).join("\n") : "   관련 메시지 없음";
      return `${index + 1}. ${row.name} ${fmtPct(row.rate, 1)}\n${lines}`;
    })
    .join("\n");
}

function themeText(themes) {
  if (!themes.length) return "감지된 테마 메시지 없음";
  return themes
    .map((theme) => `${theme.name}:\n${theme.messages.map((message) => `   ${message}`).join("\n")}`)
    .join("\n");
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

function bluechipText(rows, stockMessagesByName) {
  if (!rows.length) return "감지된 대형주 특징주 없음";
  return rows
    .map((row) => {
      const messages = stockMessagesByName.get(row.name) || [];
      const messageLines = messages.length ? messages.map((message) => `   ${message}`).join("\n") : "   관련 메시지 없음";
      const label = row.rate >= 5 ? "급등" : row.rate <= -5 ? "급락" : "주목";
      return `${row.icon} ${row.name} ${fmtPct(row.rate, 1)} (${label})\n${messageLines}`;
    })
    .join("\n");
}

function topRowsText(rows) {
  return rows
    .map((row) => `${row.rank}. ${row.name} ${fmtPct(row.rate, 1)} 현재가 ${formatWon(row.price)} 거래대금 ${formatTradingValue(row.tradingValue)}`)
    .join("\n");
}

async function runClaude({
  apiKey,
  time,
  kospi,
  kosdaq,
  top30,
  stockMessages,
  stockMessagesByName,
  themes,
  bluechipMovers,
  bluechipMessagesByName,
}) {
  const client = new Anthropic({ apiKey });
  const user = ensureJsonSafe(`현재 시각: ${time}
코스피: ${fmtNumber(kospi.value, 2)} ${fmtPct(kospi.change, 2)}
코스닥: ${fmtNumber(kosdaq.value, 2)} ${fmtPct(kosdaq.change, 2)}

=== 상승률 TOP30 ===
${topRowsText(top30)}

=== 텔레그램 채널 실시간 메시지 (최근 2시간, ${stockMessages.length}개) ===
${telegramMessagesText(stockMessages)}

=== TOP10 종목별 관련 채널 메시지 ===
${stockMessagesText(top30.slice(0, 10), stockMessagesByName)}

=== 감지된 테마 및 채널 메시지 ===
${themeText(themes)}

=== 대형주 특징주 ===
${bluechipText(bluechipMovers, bluechipMessagesByName)}

위 실제 채널 메시지를 근거로 아래를 **풍성하고 구체적으로** 작성하세요 (각 섹션 최소 4~8문장, TOP10 종목은 종목별 2~3문장):
1. 🎙️ 현재 장세 총평 (야구 중계 스타일, 수급·지수·심리 포함)
2. 📰 채널 핵심 뉴스 요약 (스톡허브·거시경제 채널 메시지 3~5건 인용, 채널명 병기)
3. 🔥 오늘의 핵심 테마와 급등 이유 (테마별 대표 종목, 채널 메시지 인용 필수)
4. ⚡ 대형주·특징주 심층 분석 (급등/급락 종목별 매수·매도 논리)
5. 🏆 상승률 TOP10 집중 분석 (종목별 왜 올랐는지, 리스크 1줄)
6. 📊 TOP30 한눈에 (간단 목록)
7. 🎯 다음 30분 관전 포인트 (구체적 종목·이벤트·가격대)`);

  const system = ensureJsonSafe(
    "당신은 20년차 주식시장 전문 해설가입니다.\n야구 중계처럼 생동감 있고 흥미롭게, 그러나 숫자와 사실은 정확히 분석해주세요.\n텔레그램 채널의 실제 메시지를 반드시 인용하고, 채널명을 함께 적어주세요.\n추측이 아닌 채널 메시지·지수·등락률 데이터에 근거하세요.\n스톡허브, 거시경제 채널을 최우선으로 참고하세요.\n크립토 채널은 크립토 관련일 때만 참고하세요.\n섹션 제목에 이모지를 사용하고, 종목 분석은 대충 쓰지 말고 구체적으로 작성하세요."
  );

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4500,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = msg.content.find((item) => item.type === "text");
  if (!block || block.type !== "text") throw new Error("Unexpected Claude response shape");
  return sanitizeUnicode(block.text).trim();
}

function buildTelegramMessage({ ymd, time, kospi, kosdaq, aiAnalysis, top30 }) {
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
    const base = `${row.rank}위 ${mdText(row.name)} *${fmtPct(row.rate, 1)}*`;
    lines.push(`${base} ${formatWon(row.price)}`);
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
  await fs.writeFile(
    DATA_PATH,
    `${JSON.stringify(data, (_k, v) => (typeof v === "string" ? sanitizeUnicode(v) : v), 2)}\n`,
    "utf8"
  );
}

async function gitCommitAndPush(time) {
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
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      execFileSync("git", ["pull", "--rebase", "origin", "main"], { stdio: "inherit" });
      execFileSync("git", ["push", "origin", "HEAD:main"], { stdio: "inherit" });
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
      console.warn(`git push retry ${attempt + 1}/3`);
      await sleep(2000 * (attempt + 1));
    }
  }
}

async function publishLiveReportSlot(ymd, time, creds, shared, { postTelegram = false } = {}) {
  const { token, appKey, appSecret, anthropicKey } = creds;
  console.log(`Live report slot: ${ymd} ${time} KST`);

  let kospi = await fetchIndex("0001", "코스피", token, appKey, appSecret);
  let kosdaq = await fetchIndex("1001", "코스닥", token, appKey, appSecret);
  if (!kospi?.value || !kosdaq?.value) {
    const prev = await loadPreviousIndexes(ymd);
    if (prev) {
      if (!kospi?.value) kospi = { label: "코스피", ...prev.kospi };
      if (!kosdaq?.value) kosdaq = { label: "코스닥", ...prev.kosdaq };
      console.warn(`[${time}] 지수 조회 실패 — 직전 슬롯 지수 사용`);
    }
  }
  if (!kospi?.value || !kosdaq?.value) {
    throw new Error(`[${time}] 지수 조회 실패 (코스피=${kospi?.value}, 코스닥=${kosdaq?.value})`);
  }

  const rankings = [
    ...(await fetchFluctuationRanking("0001", "KOSPI", token, appKey, appSecret)),
    ...(await fetchFluctuationRanking("1001", "KOSDAQ", token, appKey, appSecret)),
  ]
    .sort((a, b) => (b.rate || 0) - (a.rate || 0))
    .slice(0, 30)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  if (!rankings.length) throw new Error(`[${time}] 상승률 TOP30 데이터가 비어 있습니다.`);

  const telegramMessages = shared.telegramMessages || [];
  const stockMessages = shared.stockMessages || filterStockMessages(telegramMessages);
  const stockMessagesByName = buildStockMessageMap(rankings.slice(0, 10), stockMessages);
  const themes = buildThemeSummary(stockMessages);
  const bluechipMovers = await fetchBluechipMovers(token, appKey, appSecret);
  const bluechipMessagesByName = buildStockMessageMap(bluechipMovers, stockMessages);
  const limitUpStocks = buildLimitUpStocks(rankings, stockMessages);

  const aiAnalysis = await runClaude({
    apiKey: anthropicKey,
    time,
    kospi,
    kosdaq,
    top30: rankings,
    stockMessages,
    stockMessagesByName,
    themes,
    bluechipMovers,
    bluechipMessagesByName,
  });
  const top30 = rankings.map((row) => ({
    rank: row.rank,
    name: row.name,
    code: row.code,
    rate: row.rate,
    price: row.price,
  }));
  const top10 = top30.slice(0, 10);

  await writeLiveReport({
    date: ymd,
    time,
    kospi: { value: kospi.value, change: kospi.change },
    kosdaq: { value: kosdaq.value, change: kosdaq.change },
    aiAnalysis,
    top10,
    top30,
    telegramMessages: stockMessages.slice(0, 50).map((message) => ({
      channel: message.channel,
      text: compactText(message.text, 2500),
      date: message.date.toISOString(),
    })),
    stockMessages: Object.fromEntries(
      [...stockMessagesByName.entries()].map(([name, messages]) => [name, messages])
    ),
    themes,
    limitUpStocks,
    bluechipMovers: bluechipMovers
      .map((row) => ({
        name: row.name,
        code: row.code,
        rate: row.rate,
        price: row.price,
        type: row.label,
        messages: bluechipMessagesByName.get(row.name) || [],
      }))
      .filter((row) => row.messages.length > 0),
  });

  if (postTelegram) {
    try {
      await sendTelegramMessage(
        buildTelegramMessage({ ymd, time, kospi, kosdaq, aiAnalysis, top30 })
      );
      console.log(`[${time}] Telegram channel posted.`);
    } catch (error) {
      console.warn(`[${time}] Telegram send failed (report saved): ${error.message || error}`);
    }
  }

  console.log(`Live report saved: ${ymd} ${time}`);
}

async function main() {
  const clock = assertMarketOpen();
  if (!clock) return;
  const ymd = seoulYmd();
  const due = await unpublishedDueSlots(ymd, clock);

  if (!due.length) {
    console.log(`모든 due 슬롯 발행 완료 (${ymd}, ${clock.hour}:${String(clock.minute).padStart(2, "0")} KST)`);
    return;
  }

  const maxCatch = Math.max(1, Number(process.env.LIVE_REPORT_MAX_CATCHUP) || 1);
  const batch = due.slice(0, maxCatch);
  console.log(
    `미발행 ${due.length}개 (due≤${slotForClock(clock)}): 이번 실행 ${batch.join(", ")}${due.length > batch.length ? ` · 남음 ${due.slice(batch.length).join(", ")} (다음 실행에서 계속)` : ""}`
  );

  const creds = {
    token: requireEnv("KIS_ACCESS_TOKEN"),
    appKey: requireEnv("KIS_APP_KEY"),
    appSecret: requireEnv("KIS_APP_SECRET"),
    anthropicKey: requireEnv("ANTHROPIC_API_KEY"),
  };

  console.log("텔레그램 메시지 1회 수집…");
  const telegramMessages = await collectTelegramMessages();
  const shared = {
    telegramMessages,
    stockMessages: filterStockMessages(telegramMessages),
  };

  const published = [];
  for (let i = 0; i < batch.length; i++) {
    const time = batch[i];
    const postTelegram = i === batch.length - 1;
    try {
      await publishLiveReportSlot(ymd, time, creds, shared, { postTelegram });
      published.push(time);
    } catch (error) {
      console.error(`[${time}] 발행 실패:`, error.message || error);
    }
  }

  if (!published.length) {
    throw new Error(
      "발행된 슬롯이 없습니다. 로그에서 Claude API·KIS 오류를 확인하세요. (미발행 슬롯은 다음 수동 실행 시 1개씩 보강)"
    );
  }
  await gitCommitAndPush(published[published.length - 1]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
