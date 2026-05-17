#!/usr/bin/env node
/**
 * 텔레그램 채널 메시지 → Claude 분석 → data/weekly-schedule.json 갱신
 *
 * 필수 환경변수: TELEGRAM_TOKEN, ANTHROPIC_API_KEY, TELEGRAM_CHANNEL_ID
 *
 * 텔레그램: 봇을 해당 채널 관리자로 추가해야 channel_post가 getUpdates로 수집됩니다.
 * (Bot API는 채널 과거 메시지 전체 조회를 지원하지 않습니다.)
 *
 * 선택: WEEK_MONDAY=YYYY-MM-DD (해당 주 월요일 키 고정)
 *       OUTPUT_PATH (기본 ./data/weekly-schedule.json)
 *       ANTHROPIC_MODEL (기본 claude-sonnet-4-5)
 *       TELEGRAM_MAX_UPDATES (기본 500, getUpdates 누적 상한)
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const TELEGRAM_API = "https://api.telegram.org";

function seoulYmd(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function addDaysYmd(ymd, n) {
  const t = new Date(ymd + "T12:00:00+09:00").getTime() + n * 86400000;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
}

function mondayYmdFor(ymd) {
  const d = new Date(ymd + "T12:00:00+09:00");
  const jsDay = d.getUTCDay();
  const diffToMon = jsDay === 0 ? -6 : 1 - jsDay;
  return addDaysYmd(ymd, diffToMon);
}

function mondayYmdThisWeek(anchor) {
  return mondayYmdFor(seoulYmd(anchor));
}

function tradingWeekMondayYmd(anchor = new Date()) {
  const ymd = seoulYmd(anchor);
  const d = new Date(ymd + "T12:00:00+09:00");
  const jsDay = d.getUTCDay();
  const mon = mondayYmdThisWeek(anchor);
  if (jsDay === 0 || jsDay === 6) {
    return addDaysYmd(mon, 7);
  }
  return mon;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return String(v).trim();
}

async function tgRequest(token, method, params = {}) {
  const u = new URL(`${TELEGRAM_API}/bot${token}/${method}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const res = await fetch(u);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const desc = data.description || res.statusText || "Telegram API error";
    throw new Error(`Telegram ${method}: ${desc}`);
  }
  return data.result;
}

function normalizeChannelIdForCompare(raw, resolvedId) {
  const s = String(raw).trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  if (resolvedId != null) return Number(resolvedId);
  return s;
}

async function resolveChannelChatId(token, channelId) {
  const s = String(channelId).trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  const chat = await tgRequest(token, "getChat", { chat_id: s });
  return chat.id;
}

function extractMessageText(msg) {
  if (!msg || typeof msg !== "object") return "";
  const parts = [];
  if (msg.text) parts.push(String(msg.text));
  if (msg.caption) parts.push(String(msg.caption));
  return parts.join("\n").trim();
}

function formatSeoulTime(unix) {
  if (unix == null) return "";
  const d = new Date(Number(unix) * 1000);
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(d)
    .replace(" ", "T");
}

/**
 * 봇이 수신한 업데이트에서 채널 포스트만 모읍니다(대기 큐에 쌓인 범위).
 */
async function collectChannelPosts(token, channelIdRaw, maxUpdates) {
  const wh = await tgRequest(token, "getWebhookInfo");
  if (wh.url) {
    console.warn(
      `Webhook is set (${wh.url}). getUpdates only works when webhook is not used. Delete the webhook or run from an environment without webhook.`
    );
  }

  const resolvedId = await resolveChannelChatId(token, channelIdRaw);
  const target = normalizeChannelIdForCompare(channelIdRaw, resolvedId);

  let offset = 0;
  let total = 0;
  const posts = [];

  while (total < maxUpdates) {
    const updates = await tgRequest(token, "getUpdates", {
      offset,
      limit: 100,
      allowed_updates: JSON.stringify(["channel_post", "edited_channel_post"]),
      timeout: 0,
    });

    if (!updates.length) break;

    for (const u of updates) {
      total++;
      const msg = u.channel_post || u.edited_channel_post;
      if (!msg) continue;
      const chatId = msg.chat && msg.chat.id;
      if (chatId == null) continue;
      if (Number(chatId) !== Number(target)) continue;
      const text = extractMessageText(msg);
      if (!text) continue;
      posts.push({
        messageId: msg.message_id,
        date: msg.date,
        dateLabel: formatSeoulTime(msg.date),
        text,
      });
    }

    offset = updates[updates.length - 1].update_id + 1;
  }

  posts.sort((a, b) => a.date - b.date);
  return { resolvedChannelId: resolvedId, posts };
}

function buildTranscript(posts) {
  if (!posts.length) return "";
  return posts
    .map((p, i) => `[#${i + 1} ${p.dateLabel}]\n${p.text}`)
    .join("\n\n---\n\n");
}

function parseJsonFromAssistant(text) {
  const s = String(text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : s;
  return JSON.parse(raw);
}

function emptyDay() {
  return { themes: [], events: [], earnings: [] };
}

function validateWeekPayload(payload, weekMonday) {
  if (!payload || typeof payload !== "object") throw new Error("Invalid AI response: not an object");
  if (payload.weekMonday && payload.weekMonday !== weekMonday) {
    console.warn(`Warning: AI weekMonday ${payload.weekMonday} != target ${weekMonday}; using target key.`);
  }
  const days = payload.days;
  if (!Array.isArray(days) || days.length !== 5) {
    throw new Error("Invalid AI response: days must be an array of length 5 (Mon–Fri)");
  }
  return days.map((d, idx) => {
    const base = emptyDay();
    if (!d || typeof d !== "object") return base;
    base.themes = Array.isArray(d.themes) ? d.themes : [];
    base.events = Array.isArray(d.events) ? d.events : [];
    base.earnings = Array.isArray(d.earnings) ? d.earnings : [];
    for (const ev of base.events) {
      if (ev && typeof ev.stars === "string") ev.stars = Number(ev.stars);
    }
    if (!base.themes.length && !base.events.length && !base.earnings.length) {
      const dow = ["월", "화", "수", "목", "금"][idx] || "?";
      console.warn(`Warning: day index ${idx} (${dow}) is empty.`);
    }
    return base;
  });
}

async function runClaude({ apiKey, model, weekMonday, transcript }) {
  const client = new Anthropic({ apiKey });

  const system = `당신은 한국 주식 시장 캘린더 편집자입니다. 입력은 텔레그램 채널에 올라온 메모·일정 텍스트입니다.

규칙:
- 증시 일정, 테마, 관련 종목, 국내 실적(어닝스) 후보만 추출합니다.
- 어려운 약어·전문 용어는 일반 투자자가 이해하기 쉬운 한국어 문장으로 풀어 씁니다(쉬운 말 풀이는 event.detail이나 theme.summary에 녹입니다).
- 불확실한 날짜는 가장 그럴듯한 평일로 배치하고, detail에 "추정" 또는 "채널 원문 기준"을 짧게 남깁니다.
- 반드시 JSON만 출력합니다. 마크다운, 주석, 코드펜스를 쓰지 마세요.

출력 스키마(그대로 지키세요):
{
  "weekMonday": "${weekMonday}",
  "days": [
    {
      "themes": [ { "name": "string", "summary": "string", "stocks": ["종목명"] } ],
      "events": [ { "tag": "string", "stars": 0, "title": "string", "detail": "string" } ],
      "earnings": [ { "name": "string", "segment": "—", "note": "실적" } ]
    }
  ]
}

days는 정확히 5개: 월, 화, 수, 목, 금 순서입니다.
stars는 0(없음), 1, 2만 사용합니다(중요 일정에만 1~2).
테마가 이벤트와 중복되면 events 쪽을 우선해 간결히 정리합니다.`;

  const user = `이번 주 월요일(Seoul) 기준 키: ${weekMonday}
평일 날짜: ${weekMonday} ~ ${addDaysYmd(weekMonday, 4)}

원문 메시지:
${transcript || "(메시지 없음)"}`;

  const msg = await client.messages.create({
    model,
    max_tokens: 16384,
    system,
    messages: [{ role: "user", content: user }],
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
          title: "일정",
          timezoneNote: "KST 기준. 해외 일정은 현지 발표 시각을 함께 확인하세요.",
        },
        weeks: {},
      };
    }
    throw e;
  }
}

async function main() {
  const token = requireEnv("TELEGRAM_TOKEN");
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const channelId = requireEnv("TELEGRAM_CHANNEL_ID");

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  const outputPath = path.resolve(process.env.OUTPUT_PATH || path.join("data", "weekly-schedule.json"));
  const maxUpdates = Math.min(10000, Math.max(100, Number(process.env.TELEGRAM_MAX_UPDATES) || 500));

  const weekMonday = process.env.WEEK_MONDAY && YMD_RE.test(process.env.WEEK_MONDAY)
    ? process.env.WEEK_MONDAY
    : tradingWeekMondayYmd(new Date());

  console.log(`Target week (Monday key): ${weekMonday}`);

  const { resolvedChannelId, posts } = await collectChannelPosts(token, channelId, maxUpdates);
  console.log(`Telegram channel id (resolved): ${resolvedChannelId}, posts collected: ${posts.length}`);

  const transcript = buildTranscript(posts);
  if (!transcript.trim()) {
    console.error(
      "No channel messages found in bot update queue. Add the bot as a channel admin, post to the channel, then run again (getUpdates only sees pending updates)."
    );
    process.exit(1);
  }

  const ai = await runClaude({ apiKey, model, weekMonday, transcript });
  const days = validateWeekPayload(ai, weekMonday);

  const data = await readJsonIfExists(outputPath);
  if (!data.weeks || typeof data.weeks !== "object") data.weeks = {};

  const lastUpdated = seoulYmd(new Date());
  data.weeks[weekMonday] = {
    meta: {
      ...(data.weeks[weekMonday] && data.weeks[weekMonday].meta ? data.weeks[weekMonday].meta : {}),
      lastUpdated,
      source: "telegram+claude",
    },
    days,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outputPath}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
