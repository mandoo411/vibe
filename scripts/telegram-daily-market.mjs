#!/usr/bin/env node
/**
 * 공개 텔레그램 채널 웹 프리뷰(t.me/s/<username>) → Claude 분석(텍스트+이미지) → data/daily-market.json 갱신
 *
 * - 로그인/Telegram API 키 불필요. 채널이 "공개"이고 미리보기가 켜져 있어야 합니다.
 * - 채널 이름은 .env의 TELEGRAM_CHANNEL_ID (예: @mandoo411 또는 mandoo411)
 * - 이미지 메시지는 Claude의 비전 기능으로 직접 분석합니다(이미지 안의 한국어 텍스트 OCR + 해석).
 *
 * 필수 환경변수: TELEGRAM_CHANNEL_ID, ANTHROPIC_API_KEY
 *
 * 선택: TARGET_DATE=YYYY-MM-DD (기본: 오늘 KST)
 *       MESSAGE_LIMIT (기본 50, 1~200)  채널에서 가져올 최근 메시지 수
 *       MAX_IMAGES (기본 20, 1~30)      Claude에 보낼 이미지 상한
 *       OUTPUT_PATH (기본 ./data/daily-market.json)
 *       ANTHROPIC_MODEL (기본 claude-sonnet-4-5)
 *       MAX_PAGES (기본 8, 페이지네이션 안전 상한)
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ─── Date helpers ─────────────────────────────────────────
function seoulYmd(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function ymdFromISO(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return seoulYmd(new Date(t));
}

function labelFromISO(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(t))
    .replace(" ", "T");
}

// ─── Misc helpers ─────────────────────────────────────────
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
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeChannelUsername(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^t\.me\//i, "");
  s = s.replace(/^s\//i, "");
  s = s.replace(/^@/, "");
  s = s.split(/[/?#]/)[0];
  if (!s) return "";
  if (/^-?\d+$/.test(s)) {
    throw new Error(
      `TELEGRAM_CHANNEL_ID가 숫자 ID(${raw})입니다. 공개 채널 웹 프리뷰는 사용자명이 필요합니다 (예: @mandoo411).`
    );
  }
  if (!/^[A-Za-z0-9_]{4,32}$/.test(s)) {
    // 텔레그램 공개 채널 사용자명은 영문/숫자/언더스코어, 4~32자.
    throw new Error(
      `TELEGRAM_CHANNEL_ID(${raw})가 유효한 공개 사용자명 형식이 아닙니다 (영문/숫자/_/4~32자).`
    );
  }
  return s;
}

// ─── HTML → text ──────────────────────────────────────────
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

function htmlToText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<br\s*\/?>(\s*)/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<\/?(?:p|div)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Date marker parsing ──────────────────────────────────
/**
 * 메시지 본문에서 명시적 날짜 표기를 찾아 YYYY-MM-DD로 변환합니다.
 *  - "2026-05-12", "2026.05.12", "2026/5/12"
 *  - "5월 12일", "5월12일"
 * 한국어 표기에는 연도가 없으므로 postYmd(메시지 작성일)의 연도를 추정에 사용합니다.
 * 연말연시에 거꾸로 가는 케이스(예: 1월에 적힌 "12월 30일")는 ±1년 보정합니다.
 */
function parseDateMarker(text, postYmd) {
  if (!text) return null;
  const s = String(text);

  const m1 = s.match(/\b(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})\b/);
  if (m1) {
    const y = Number(m1[1]);
    const mo = Number(m1[2]);
    const d = Number(m1[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  const m2 = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (m2) {
    const mo = Number(m2[1]);
    const d = Number(m2[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let y = postYmd ? Number(postYmd.slice(0, 4)) : new Date().getFullYear();
      if (postYmd) {
        const postMonth = Number(postYmd.slice(5, 7));
        if (mo - postMonth > 6) y -= 1;
        else if (postMonth - mo > 6) y += 1;
      }
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  return null;
}

/**
 * 메시지를 시간 오래된 순으로 훑으며 본문 안의 날짜 마커("5월 12일" 등)를 만나면
 * 그 이후 메시지들의 assignedYmd를 해당 날짜로 갱신합니다. 마커가 나오기 전까지는
 * datetimeISO 기반 ymd를 그대로 사용합니다(원본 배열을 in-place로 수정).
 */
function applyDateMarkers(posts) {
  const asc = [...posts].sort((a, b) => a.messageId - b.messageId);
  let currentDate = null;
  for (const p of asc) {
    const marker = parseDateMarker(p.text, p.ymd);
    if (marker) currentDate = marker;
    p.assignedYmd = currentDate || p.ymd;
  }
  return posts;
}

// ─── t.me/s parsing ───────────────────────────────────────
function extractPhotoUrl(block) {
  const m = block.match(
    /tgme_widget_message_photo_wrap[^"]*"[^>]*?background-image:url\(['"]([^'")]+)['"]\)/
  );
  if (m) return m[1];
  const v = block.match(
    /tgme_widget_message_video[^"]*"[^>]*?(?:background-image|poster)\s*[:=]\s*['"]?([^'")\s]+\.(?:jpg|jpeg|png|webp))['"]?/i
  );
  return v ? v[1] : "";
}

/**
 * 페이지 HTML에서 메시지 블록을 추출합니다.
 * 메시지 블록은 data-post="<username>/<id>" 속성으로 시작합니다.
 */
function parseMessages(html) {
  const posts = [];
  const idRe = /data-post="([^"\/]+)\/(\d+)"/g;
  const positions = [];
  let m;
  while ((m = idRe.exec(html)) !== null) {
    positions.push({ start: m.index, post: m[1], id: Number(m[2]) });
  }
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].start;
    const end = i + 1 < positions.length ? positions[i + 1].start : html.length;
    const block = html.slice(start, end);

    if (/tgme_widget_message_service\b/.test(block)) continue;

    const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
    const datetimeISO = timeMatch ? timeMatch[1] : null;

    const textMatch = block.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/
    );
    const text = textMatch ? htmlToText(textMatch[1]) : "";

    const photoUrl = extractPhotoUrl(block);

    if (!text && !photoUrl) continue;

    posts.push({
      messageId: positions[i].id,
      datetimeISO,
      ymd: ymdFromISO(datetimeISO),
      dateLabel: labelFromISO(datetimeISO),
      text,
      photoUrl,
    });
  }
  return posts;
}

async function fetchPage(username, before) {
  const url = before
    ? `https://t.me/s/${encodeURIComponent(username)}?before=${before}`
    : `https://t.me/s/${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return await res.text();
}

async function fetchChannelMessages(channelRaw, targetCount, maxPages) {
  const username = normalizeChannelUsername(channelRaw);
  if (!username) throw new Error("TELEGRAM_CHANNEL_ID가 비어 있습니다.");

  const all = new Map();
  let before = null;
  let safety = Math.max(1, maxPages);

  while (all.size < targetCount && safety-- > 0) {
    const html = await fetchPage(username, before);

    if (
      /이 채널은 비공개입니다/i.test(html) ||
      /this channel is private/i.test(html) ||
      /Sorry, this channel was deleted/i.test(html) ||
      /Channel not found/i.test(html)
    ) {
      throw new Error(
        `채널 t.me/s/${username} 미리보기에 접근할 수 없습니다. 공개 채널 + 미리보기 허용 여부를 확인하세요.`
      );
    }

    const page = parseMessages(html);
    if (!page.length) break;

    let oldest = Infinity;
    let added = 0;
    for (const p of page) {
      if (!all.has(p.messageId)) {
        all.set(p.messageId, p);
        added++;
      }
      if (p.messageId < oldest) oldest = p.messageId;
    }
    if (added === 0 || !Number.isFinite(oldest)) break;
    before = oldest;
  }

  const arr = [...all.values()].sort((a, b) => b.messageId - a.messageId);
  return arr.slice(0, targetCount);
}

function buildClaudeContent(posts, targetYmd, maxImages) {
  const content = [];
  content.push({
    type: "text",
    text: `대상 날짜(Seoul, YYYY-MM-DD): ${targetYmd}\n\n아래는 텔레그램 채널 @mandoo411(크립토만두)에 ${targetYmd}에 올라온 메시지입니다(최신 메시지부터 정렬). 텍스트가 없는 메시지는 첨부된 이미지에 한국 증시 시황·종목·뉴스 정보가 적혀 있으므로 이미지 내 한국어 텍스트를 읽어 분석에 활용하세요. 모든 데이터는 반드시 ${targetYmd} 단일 거래일 기준이어야 합니다. 이전 거래일의 수치·요약이 섞이지 않도록 주의하세요.\n`,
  });

  let imageCount = 0;
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const header = `[#${i + 1} ${p.dateLabel || "?"} msg:${p.messageId}]`;
    if (p.text) {
      content.push({ type: "text", text: `${header}\n${p.text}` });
    } else {
      content.push({ type: "text", text: header });
    }
    if (p.photoUrl && imageCount < maxImages) {
      content.push({
        type: "image",
        source: { type: "url", url: p.photoUrl },
      });
      imageCount++;
    }
  }

  content.push({
    type: "text",
    text: `\n위 메시지(텍스트+이미지)를 바탕으로 ${targetYmd} 단일 거래일의 한국 증시 데일리 시황을 JSON으로만 출력하세요. 다른 날짜의 수치는 포함하지 마세요.`,
  });
  return { content, imageCount };
}

// ─── Claude ───────────────────────────────────────────────
function parseJsonFromAssistant(text) {
  const s = String(text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : s;
  return JSON.parse(raw);
}

function validateDailyPayload(payload, targetYmd) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid AI response: not an object");
  }
  if (payload.ymd && payload.ymd !== targetYmd) {
    console.warn(`Warning: AI ymd ${payload.ymd} != target ${targetYmd}; using target.`);
  }

  const indexes = Array.isArray(payload.indexes)
    ? payload.indexes
        .map((r) => ({
          name: sanitizeStr(r && r.name),
          value: sanitizeStr(r && r.value),
          change: toNumberOrNull(r && r.change),
        }))
        .filter((r) => r.name)
    : [];

  const notableStocks = Array.isArray(payload.notableStocks)
    ? payload.notableStocks
        .map((r) => ({
          name: sanitizeStr(r && r.name),
          change: toNumberOrNull(r && r.change),
          tradingValue: sanitizeStr(r && r.tradingValue),
          note: sanitizeStr(r && r.note),
        }))
        .filter((r) => r.name)
    : [];

  const themes = Array.isArray(payload.themes)
    ? payload.themes
        .map((t) => ({
          name: sanitizeStr(t && t.name),
          note: sanitizeStr(t && t.note),
          leaders: Array.isArray(t && t.leaders)
            ? t.leaders
                .map((l) => ({
                  name: sanitizeStr(l && l.name),
                  change: toNumberOrNull(l && l.change),
                }))
                .filter((l) => l.name)
            : [],
        }))
        .filter((t) => t.name || (t.leaders && t.leaders.length))
    : [];

  const news = Array.isArray(payload.news)
    ? payload.news
        .map((n) => ({
          title: sanitizeStr(n && n.title),
          note: sanitizeStr(n && n.note),
          source: sanitizeStr(n && n.source),
          url: typeof (n && n.url) === "string" && /^https?:\/\//i.test(n.url) ? n.url : "",
        }))
        .filter((n) => n.title)
    : [];

  return {
    summary: sanitizeStr(payload.summary),
    indexes,
    notableStocks,
    themes,
    news,
  };
}

async function runClaude({ apiKey, model, targetYmd, content }) {
  const client = new Anthropic({ apiKey });

  const system = `당신은 한국 주식 시장 데일리 시황 편집자입니다. 입력은 텔레그램 채널에 올라온 그날의 메모·중계·뉴스이며, 텍스트 메시지와 이미지(주로 한국어가 적힌 캡처·차트·뉴스 스크린샷)가 섞여 있습니다. 입력 메시지는 모두 ${targetYmd} 단일 거래일 기준이며, 새로운 메시지부터 정렬되어 있습니다.

규칙:
- 모든 결과는 반드시 ${targetYmd} 단일 거래일 기준입니다. 이전/이후 거래일의 수치, 요약을 절대 섞지 마세요.
- 이미지 안의 한국어 텍스트를 정확히 읽고(OCR), 그 내용을 분석에 반영합니다.
- 한국 주식시장(코스피·코스닥) 마감 시황에 초점을 맞춥니다.
- 어려운 약어·전문 용어는 일반 투자자가 이해하기 쉬운 한국어 문장으로 풀어 씁니다.
- 등락률(change)은 단위 없는 숫자만(예: 2.5, -1.3). %, 부호는 출력하지 마세요. 알 수 없으면 null.
- 거래대금(tradingValue)은 "1조 2000억" 같은 한국어 단위 문자열을 그대로 둡니다.
- 추정인 항목은 note 끝에 "(추정)"으로 표기합니다.
- 출력은 반드시 JSON 한 덩어리. 마크다운, 코드펜스, 주석을 쓰지 마세요.

출력 스키마(그대로 지키세요):
{
  "ymd": "${targetYmd}",
  "summary": "오늘 시황 요약(2~4문장, 시장 방향·수급·주도주 중심).",
  "indexes": [ { "name": "코스피", "value": "2700.12", "change": 0.5 } ],
  "notableStocks": [
    { "name": "삼성전자", "change": 2.5, "tradingValue": "1조 2000억", "note": "외국인 순매수" }
  ],
  "themes": [
    { "name": "AI 반도체", "note": "HBM 수요 강세", "leaders": [ { "name": "SK하이닉스", "change": 3.2 } ] }
  ],
  "news": [
    { "title": "뉴스 한 줄", "note": "왜 중요한지 1문장", "source": "출처(선택)", "url": "https://..." }
  ]
}

빈 값일 때는 빈 배열([])로 두고, 임의로 만들어내지 마세요.`;

  const msg = await client.messages.create({
    model,
    max_tokens: 8192,
    system,
    messages: [{ role: "user", content }],
  });

  const block = msg.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("Unexpected Claude response shape");
  }
  return parseJsonFromAssistant(block.text);
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return {
        meta: {
          title: "매일 시황 기록",
          timezoneNote: "KST 기준. 특별한 표기가 없으면 종가 기준입니다.",
        },
        days: {},
      };
    }
    throw e;
  }
}

async function main() {
  const channelId = requireEnv("TELEGRAM_CHANNEL_ID");
  const anthropicKey = requireEnv("ANTHROPIC_API_KEY");

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  const limit = Math.max(1, Math.min(200, Number(process.env.MESSAGE_LIMIT) || 50));
  const maxImages = Math.max(1, Math.min(30, Number(process.env.MAX_IMAGES) || 20));
  const maxPages = Math.max(1, Math.min(20, Number(process.env.MAX_PAGES) || 8));
  const outputPath = path.resolve(
    process.env.OUTPUT_PATH || path.join("data", "daily-market.json")
  );
  const targetYmd =
    process.env.TARGET_DATE && YMD_RE.test(process.env.TARGET_DATE)
      ? process.env.TARGET_DATE
      : seoulYmd(new Date());

  console.log(`Target date: ${targetYmd} | message limit: ${limit} | max images: ${maxImages}`);

  const allPosts = await fetchChannelMessages(channelId, limit, maxPages);
  const textCount = allPosts.filter((p) => p.text).length;
  const photoCount = allPosts.filter((p) => p.photoUrl).length;
  console.log(
    `Fetched ${allPosts.length} messages from t.me/s/${normalizeChannelUsername(channelId)} (text:${textCount}, photo:${photoCount}).`
  );

  if (!allPosts.length) {
    console.error("채널에서 가져온 메시지가 없습니다. (공개 채널 + 미리보기 허용 여부 확인)");
    process.exit(1);
  }

  applyDateMarkers(allPosts);
  const dist = allPosts.reduce((acc, p) => {
    const k = p.assignedYmd || "?";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `Date distribution (assignedYmd): ${Object.entries(dist)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([k, v]) => `${k}:${v}`)
      .join(" ")}`
  );

  const postsForDay = allPosts.filter((p) => p.assignedYmd === targetYmd);
  let effectiveYmd = targetYmd;
  let posts = postsForDay;
  if (!postsForDay.length) {
    // Fallback: 가장 최근 1개 날짜의 메시지만 사용 (여러 날짜 혼재 방지)
    const datesDesc = [...new Set(allPosts.map((p) => p.assignedYmd).filter(Boolean))].sort(
      (a, b) => (a < b ? 1 : a > b ? -1 : 0)
    );
    const latestYmd = datesDesc[0];
    if (!latestYmd) {
      console.error("가져온 메시지에 유효한 날짜가 없습니다.");
      process.exit(1);
    }
    effectiveYmd = latestYmd;
    posts = allPosts.filter((p) => p.assignedYmd === latestYmd);
    console.warn(
      `No posts dated ${targetYmd}; using only the latest available date ${latestYmd} (${posts.length} posts).`
    );
  } else {
    console.log(`Posts dated ${targetYmd}: ${postsForDay.length}`);
  }

  // 최신순 정렬(Claude에는 새로운 메시지부터 노출)
  posts = [...posts].sort((a, b) => b.messageId - a.messageId);

  const { content, imageCount } = buildClaudeContent(posts, effectiveYmd, maxImages);
  console.log(`Sending to Claude: ${posts.length} posts, ${imageCount} images (date=${effectiveYmd}).`);

  const ai = await runClaude({ apiKey: anthropicKey, model, targetYmd: effectiveYmd, content });
  const day = validateDailyPayload(ai, effectiveYmd);

  const data = await readJsonIfExists(outputPath);
  if (!data.days || typeof data.days !== "object") data.days = {};

  const existing = data.days[effectiveYmd] || {};
  data.days[effectiveYmd] = {
    ...existing,
    summary: day.summary,
    indexes: day.indexes,
    notableStocks: day.notableStocks,
    themes: day.themes,
    news: day.news,
    updatedAt: seoulYmd(new Date()),
    source: "t.me/s+claude",
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outputPath} (key=${effectiveYmd})`);
  console.log(
    `Summary: ${day.summary ? day.summary.slice(0, 60) + (day.summary.length > 60 ? "…" : "") : "(empty)"}`
  );
  console.log(
    `Counts → indexes:${day.indexes.length} notable:${day.notableStocks.length} themes:${day.themes.length} news:${day.news.length}`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
