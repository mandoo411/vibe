import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_CHANNEL_LIMIT = 60;

const PRIORITY_RULES = [
  { priority: 1, msgLimit: 30, keywords: ["스톡허브", "stockhub"], tag: "domestic" },
  { priority: 1, msgLimit: 30, keywords: ["미국주식", "인사이더"], tag: "us" },
  { priority: 1, msgLimit: 20, keywords: ["거시경제", "경제", "매크로", "macro"], tag: "macro" },
  { priority: 2, msgLimit: 15, keywords: ["크립토", "코인", "비트", "bitcoin", "crypto"], tag: "crypto" },
];

const MARKET_KEYWORDS = [
  "주식",
  "증시",
  "코스피",
  "코스닥",
  "미국주식",
  "나스닥",
  "S&P",
  "다우",
  "거시경제",
  "매크로",
  "경제",
  "금리",
  "환율",
  "유가",
  "금",
  "원자재",
  "반도체",
  "2차전지",
  "바이오",
  "방산",
  "원전",
  "로봇",
  "조선",
  "크립토",
  "코인",
  "비트",
  "%",
  "상승",
  "하락",
  "급등",
  "급락",
];

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactTelegramText(value, limit = 220) {
  const clean = stripHtml(value);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1)}…`;
}

function channelPriority(name) {
  const lower = String(name || "").toLowerCase();
  for (const rule of PRIORITY_RULES) {
    if (rule.keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
      return { priority: rule.priority, msgLimit: rule.msgLimit, tag: rule.tag };
    }
  }
  return { priority: 3, msgLimit: 5, tag: "other" };
}

async function withTimeout(promise, ms, onTimeout = () => {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Telegram collection timeout ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function collectTelegramMessages(options = {}) {
  const session = process.env.TELEGRAM_SESSION;
  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID || "", 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!session || !apiId || !apiHash) return [];

  const hours = Math.max(1, Number(options.hours) || 3);
  const channelLimit = Math.max(1, Number(options.channelLimit) || DEFAULT_CHANNEL_LIMIT);
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const filterKeywords = options.keywords || MARKET_KEYWORDS;
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3 });

  return withTimeout(
    (async () => {
      try {
        await client.connect();
        const dialogs = await client.getDialogs({});
        const channels = dialogs
          .filter((dialog) => dialog.isChannel || dialog.isGroup)
          .map((dialog) => ({ ...dialog, ...channelPriority(dialog.name) }))
          .sort((a, b) => a.priority - b.priority || String(a.name || "").localeCompare(String(b.name || "")))
          .slice(0, channelLimit);
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);
        const results = await Promise.allSettled(
          channels.map(async (channel) => {
            try {
              const messages = await client.getMessages(channel.entity, { limit: channel.msgLimit });
              return messages
                .filter((message) => message.message && new Date(Number(message.date) * 1000) >= since)
                .map((message) => ({
                  channel: channel.name || "unknown",
                  priority: channel.priority,
                  tag: channel.tag,
                  text: stripHtml(message.message),
                  date: new Date(Number(message.date) * 1000),
                }));
            } catch (error) {
              console.log(`Telegram channel read failed: ${channel.name || "unknown"} - ${error.message}`);
              return [];
            }
          })
        );
        return results
          .filter((result) => result.status === "fulfilled")
          .flatMap((result) => result.value)
          .filter((message) => filterKeywords.some((keyword) => message.text.toLowerCase().includes(String(keyword).toLowerCase())))
          .sort((a, b) => a.priority - b.priority || b.date - a.date);
      } finally {
        await Promise.resolve(client.disconnect()).catch(() => {});
      }
    })(),
    timeoutMs,
    () => Promise.resolve(client.disconnect()).catch(() => {})
  ).catch((error) => {
    console.log(`Telegram collection failed: ${error.message}`);
    return [];
  });
}

export function telegramRowsForData(messages, limit = 20) {
  return messages.slice(0, limit).map((message) => ({
    title: compactTelegramText(message.text, 90),
    headline: compactTelegramText(message.text, 90),
    summary: compactTelegramText(message.text, 360),
    source: message.channel,
    channel: message.channel,
    publishedAt: message.date.toISOString(),
    datetime: message.date.toISOString(),
    timeLabel: new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(message.date),
    url: "",
    telegram: true,
    tag: message.tag,
  }));
}
