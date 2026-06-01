/**
 * Finnhub crypto news (48h / 72h fallback)
 * GET /api/crypto-news
 */

module.exports = async function handler(req, res) {
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
  if (!FINNHUB_KEY) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Missing FINNHUB_API_KEY" }));
    return;
  }

  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/news?category=crypto&minId=0&token=${encodeURIComponent(FINNHUB_KEY)}`
    );
    const data = await r.json();
    if (!r.ok) {
      const msg =
        data && typeof data === "object" && data.error
          ? String(data.error)
          : `Finnhub HTTP ${r.status}`;
      throw new Error(msg);
    }

    const now = Date.now();
    const ms48h = 48 * 60 * 60 * 1000;
    const ms72h = 72 * 60 * 60 * 1000;

    const news = (Array.isArray(data) ? data : [])
      .map((n) => ({
        title: n.headline,
        summary: n.summary,
        source: n.source,
        url: n.url,
        publishedAt: new Date(n.datetime * 1000).toISOString(),
        datetime: n.datetime * 1000,
      }))
      .sort((a, b) => b.datetime - a.datetime);

    let filtered = news.filter((n) => now - n.datetime < ms48h);
    if (filtered.length < 10) {
      filtered = news.filter((n) => now - n.datetime < ms72h);
    }
    filtered = filtered.slice(0, 20);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=300");
    res.end(
      JSON.stringify({
        news: filtered,
        updatedAt: new Date().toISOString(),
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: e.message || String(e) }));
  }
};
