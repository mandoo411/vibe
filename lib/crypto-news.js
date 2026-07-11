/**
 * 크립토 전문 매체(코인데스크 코리아·토큰포스트·블록미디어) RSS 뉴스 — api/crypto.js(kind=news,
 * 크립토 페이지 뉴스 위젯)와 api/analyze.js(AI 종목분석, 암호화폐 수급/재료 분석 근거)가
 * 공유하는 단일 소스. 2026-07-11: AI 종목분석이 Claude의 범용 web_search에만 의존하다 보니
 * 국내 크립토 전문 매체 기사를 놓치는 경우가 많아(특히 소형 알트코인), 크립토 페이지에
 * 이미 연결돼 있던 이 RSS 피드를 분석 프롬프트에도 그대로 재사용하도록 분리했다.
 */

const NEWS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const RSS_FEEDS = [
  { url: "https://www.coindeskkorea.com/feed/", source: "코인데스크 코리아" },
  { url: "https://tokenpost.kr/rss", source: "토큰포스트" },
  { url: "https://www.blockmedia.co.kr/feed/", source: "블록미디어" },
];

const MAX_NEWS = 20;

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

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ");
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function cleanText(value) {
  return decodeHtmlEntities(decodeXml(value)).replace(/\s+/g, " ").trim();
}

function parseRssItems(xml, source) {
  const items = String(xml || "").match(/<item>[\s\S]*?<\/item>/g) || [];
  return items
    .map((item) => {
      const title = cleanText((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
      const url = cleanText((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
      const pubRaw = cleanText(
        (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] ||
          (item.match(/<dc:date>([\s\S]*?)<\/dc:date>/) || [])[1]
      );
      const summary = stripHtml((item.match(/<description>([\s\S]*?)<\/description>/) || [])[1]);
      const publishedMs = pubRaw ? new Date(pubRaw).getTime() : NaN;
      if (!title || !url || Number.isNaN(publishedMs)) return null;
      return {
        title,
        summary: summary || "",
        source,
        url,
        publishedAt: new Date(publishedMs).toISOString(),
        datetime: publishedMs,
      };
    })
    .filter(Boolean);
}

async function fetchRssFeed(feed) {
  const res = await fetch(feed.url, {
    headers: {
      "user-agent": NEWS_USER_AGENT,
      accept: "application/rss+xml, application/xml, text/xml",
    },
  });
  const xml = await res.text();
  if (!res.ok) throw new Error(`${feed.source} HTTP ${res.status}`);
  return parseRssItems(xml, feed.source);
}

function dedupeAndSort(rows, limit) {
  const seen = new Set();
  return rows
    .sort((a, b) => b.datetime - a.datetime)
    .filter((row) => {
      const key = row.url || row.title;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit || MAX_NEWS);
}

/** 3개 매체 RSS를 병렬로 가져와 최신순으로 합친다. 개별 피드가 실패해도(네트워크 등) 나머지는
 * 계속 사용한다(Promise.allSettled). limit을 넘기면 그만큼만 반환(기본 MAX_NEWS=20). */
async function fetchAllCryptoNews(limit) {
  const settled = await Promise.allSettled(RSS_FEEDS.map((feed) => fetchRssFeed(feed)));
  const rows = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "fulfilled") {
      rows.push(...result.value);
    } else {
      console.warn("[crypto-news] RSS failed:", RSS_FEEDS[i].source, result.reason && result.reason.message);
    }
  }
  return dedupeAndSort(rows, limit);
}

/** name(코인명/티커)과 관련된 기사만 골라낸다 — 제목·요약에 이름이 포함된 것 우선, 없으면
 * (특정 코인 전용 기사가 드물 수 있으므로) 최신 크립토 시장 전반 뉴스로 폴백한다. */
function filterNewsByRelevance(news, name, limit) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return news.slice(0, limit || 8);
  const matched = news.filter(
    (item) =>
      String(item.title || "").toLowerCase().includes(n) ||
      String(item.summary || "").toLowerCase().includes(n)
  );
  const pool = matched.length ? matched : news;
  return pool.slice(0, limit || 8);
}

module.exports = {
  RSS_FEEDS,
  parseRssItems,
  fetchRssFeed,
  dedupeAndSort,
  fetchAllCryptoNews,
  filterNewsByRelevance,
};
