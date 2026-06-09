/**
 * Korean crypto news via RSS (no translation)
 * GET /api/crypto-news
 */

const USER_AGENT =
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
      "user-agent": USER_AGENT,
      accept: "application/rss+xml, application/xml, text/xml",
    },
  });
  const xml = await res.text();
  if (!res.ok) throw new Error(`${feed.source} HTTP ${res.status}`);
  return parseRssItems(xml, feed.source);
}

function dedupeAndSort(rows) {
  const seen = new Set();
  return rows
    .sort((a, b) => b.datetime - a.datetime)
    .filter((row) => {
      const key = row.url || row.title;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_NEWS);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
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

    const news = dedupeAndSort(rows);
    if (!news.length) {
      throw new Error("No crypto news available from RSS feeds");
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=300");
    res.end(
      JSON.stringify({
        news,
        updatedAt: new Date().toISOString(),
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: e.message || String(e) }));
  }
};
