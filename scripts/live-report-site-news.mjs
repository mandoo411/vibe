/**
 * 장중(09:00~15:30 KST) 증권 RSS 수집 — live report 슬롯별 필터용
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const RSS_FEEDS = [
  { url: "https://www.mk.co.kr/rss/30100041/", source: "매일경제 증권" },
  { url: "https://rss.hankyung.com/stock.xml", source: "한국경제 증권" },
  { url: "https://rss.hankyung.com/finance.xml", source: "한국경제 금융" },
  { url: "https://www.mk.co.kr/rss/30000001/", source: "매일경제" },
  { url: "https://rss.yna.co.kr/economy/rss.xml", source: "연합뉴스 경제" },
  { url: "https://rss.mt.co.kr/mt_isa/", source: "머니투데이" },
  { url: "https://rss.heraldcorp.com/rss/economy.xml", source: "헤럴드경제" },
  { url: "https://www.asiae.co.kr/rss/stock.htm", source: "아시아경제 증권" },
];

const MARKET_KEYWORDS = [
  "주식",
  "증시",
  "코스피",
  "코스닥",
  "증권",
  "종목",
  "상장",
  "etf",
  "투자",
  "외국인",
  "기관",
  "반도체",
  "금융",
  "실적",
  "삼성",
  "sk",
  "현대",
  "lg",
];

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

function isMarketNews(row) {
  const text = `${row.title || ""} ${row.summary || ""}`.toLowerCase();
  return MARKET_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml, text/xml" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return text;
}

function parseRss(xml, source, fromIso, toIso) {
  const items = String(xml || "").match(/<item>[\s\S]*?<\/item>/g) || [];
  return items
    .map((item) => {
      const title = decodeXml((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
      const url = decodeXml((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
      const pub = decodeXml((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
      const summary = stripHtml(decodeXml((item.match(/<description>([\s\S]*?)<\/description>/) || [])[1]));
      const publishedAt = pub ? new Date(pub).toISOString() : "";
      return { title, url, source, publishedAt, summary };
    })
    .filter((row) => row.title && row.url && row.publishedAt && inWindow(row.publishedAt, fromIso, toIso));
}

function dedupe(rows) {
  const seen = new Set();
  return rows
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .filter((row) => {
      const key = row.title.replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** 당일 장중(09:00~15:30) RSS 전체 수집 (워크플로 1회) */
export async function fetchIntradaySiteNews(ymd) {
  const fromIso = kstIso(ymd, "09:00");
  const toIso = kstIso(ymd, "15:30");
  const rows = [];
  for (const feed of RSS_FEEDS) {
    try {
      const xml = await fetchText(feed.url);
      const parsed = parseRss(xml, feed.source, fromIso, toIso);
      console.log(`[live-report] ${feed.source} RSS ${parsed.length}건 (장중)`);
      rows.push(...parsed.slice(0, 12));
    } catch (error) {
      console.warn(`[live-report] ${feed.source} RSS failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  return dedupe(rows).filter(isMarketNews);
}

/** 리포트 슬롯 시각까지 발행된 기사만 */
export function filterSiteNewsForSlot(allRows, ymd, slotTime) {
  const fromIso = kstIso(ymd, "09:00");
  const toIso = kstIso(ymd, slotTime);
  return (Array.isArray(allRows) ? allRows : []).filter((row) => inWindow(row.publishedAt, fromIso, toIso));
}
