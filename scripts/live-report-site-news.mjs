/**
 * 당일 언론사 경제/증권 RSS — live report pressNews
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const RSS_SOURCES = [
  { url: "https://www.mk.co.kr/rss/30100041/", source: "매일경제" },
  { url: "https://www.mk.co.kr/rss/30200030/", source: "매일경제" },
  { url: "https://rss.hankyung.com/stock.xml", source: "한국경제" },
  { url: "https://rss.hankyung.com/economy.xml", source: "한국경제" },
  { url: "https://rss.yna.co.kr/economy/rss.xml", source: "연합뉴스" },
  { url: "https://rss.mt.co.kr/mt_isa/", source: "머니투데이" },
];

const MAX_PER_SOURCE = 5;

function kstIso(ymd, hhmm) {
  return `${ymd}T${hhmm}:00+09:00`;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inWindow(iso, fromIso, toIso) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t >= new Date(fromIso).getTime() && t <= new Date(toIso).getTime();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml, text/xml" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return text;
}

function parseRss(xml, source, ymd) {
  const fromIso = kstIso(ymd, "00:00");
  const toIso = `${ymd}T23:59:59+09:00`;
  const items = String(xml || "").match(/<item>[\s\S]*?<\/item>/g) || [];
  return items
    .map((item) => {
      const title = decodeXml((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
      const url = decodeXml((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
      const pub = decodeXml((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
      const desc = stripHtml(decodeXml((item.match(/<description>([\s\S]*?)<\/description>/) || [])[1]));
      const pubDate = pub ? new Date(pub).toISOString() : "";
      return {
        title,
        url,
        source,
        pubDate,
        content: desc || "",
      };
    })
    .filter((row) => row.title && row.pubDate && inWindow(row.pubDate, fromIso, toIso));
}

function dedupeByTitle(rows) {
  const seen = new Set();
  return rows
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
    .filter((row) => {
      const key = row.title.replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** 당일 00:00 KST 이후 RSS 전체 수집 (워크플로 1회, 병렬) */
export async function fetchPressNewsAll(ymd) {
  const settled = await Promise.allSettled(
    RSS_SOURCES.map(async (feed) => {
      const xml = await fetchText(feed.url);
      const parsed = parseRss(xml, feed.source, ymd);
      console.log(`[live-report] ${feed.source} RSS ${parsed.length}건 (당일)`);
      return parsed.slice(0, MAX_PER_SOURCE);
    })
  );

  const rows = [];
  for (const result of settled) {
    if (result.status === "fulfilled") rows.push(...result.value);
    else console.warn(`[live-report] RSS failed: ${result.reason?.message || result.reason}`);
  }
  return dedupeByTitle(rows);
}

/** 리포트 슬롯 시각까지 발행된 당일 기사만 */
export function filterPressNewsForSlot(allRows, ymd, slotTime) {
  const fromIso = kstIso(ymd, "00:00");
  const toIso = kstIso(ymd, slotTime);
  return (Array.isArray(allRows) ? allRows : []).filter((row) => inWindow(row.pubDate, fromIso, toIso));
}

/** @deprecated use fetchPressNewsAll */
export const fetchIntradaySiteNews = fetchPressNewsAll;

/** @deprecated use filterPressNewsForSlot */
export const filterSiteNewsForSlot = filterPressNewsForSlot;
