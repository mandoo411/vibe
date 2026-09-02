/**
 * Private repo data/*.json — GitHub Contents API (배포 없이 최신 main 반영)
 * GET ?path=data/live-report.json
 */
const REPO = "mandoo411/vibe";
const ALLOWED = /^data\/[\w.-]+\.json$/i;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=120");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function githubToken() {
  return (
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GH_PAT_REPO_SECRETS_WRITE ||
    process.env.GITHUB_PAT ||
    ""
  ).trim();
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, "");
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });

  const filePath = String(req.query?.path || "")
    .replace(/^\//, "")
    .split("?")[0];
  if (!ALLOWED.test(filePath)) return json(res, 400, { error: "Invalid path" });

  const token = githubToken();
  if (!token) return json(res, 503, { error: "Missing GITHUB_TOKEN on Vercel" });

  const url = `https://api.github.com/repos/${REPO}/contents/${filePath}?ref=main`;
  const headers = {
    Accept: "application/vnd.github.raw",
    "User-Agent": "totalmoney-ai",
    Authorization: `Bearer ${token}`,
  };

  try {
    const gh = await fetch(url, { headers });
    if (!gh.ok) {
      return json(res, gh.status === 404 ? 404 : 502, {
        error: "GitHub fetch failed",
        status: gh.status,
      });
    }
    const text = await gh.text();

    /* 2026-09-02: 홈 화면이 '오늘 마감시황 핵심 한 줄'을 보여주려면 daily-market.json이
       필요한데 이 파일은 3MB가 넘어 홈에서 통째로 받게 할 수 없다. data/daily/<날짜>.json
       아카이브는 AI 분석이 하루 늦게 채워져서 대안이 못 된다.
       Vercel Hobby 함수 12개 제한을 이미 꽉 채운 상태라 새 API 파일을 만들 수 없으므로,
       이 함수에 pick 파라미터를 붙여 서버에서 최신 하루치만 잘라 내려준다. */
    const pick = String(req.query?.pick || "").trim();
    if (pick === "latest-day") {
      try {
        const parsed = JSON.parse(text);
        const days = parsed && parsed.days;
        if (!days || typeof days !== "object") return json(res, 404, { error: "no days" });
        const dates = Object.keys(days).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
        for (let i = dates.length - 1; i >= 0; i--) {
          const d = days[dates[i]];
          if (!d || !d.analysis) continue;
          return json(res, 200, {
            date: dates[i],
            analysis: d.analysis,
            indexes: d.indexes || null,
            marketTone: d.marketTone || null,
            featured_stocks: Array.isArray(d.featured_stocks) ? d.featured_stocks.slice(0, 6) : [],
          });
        }
        return json(res, 404, { error: "no analysed day" });
      } catch (e) {
        return json(res, 500, { error: "parse failed" });
      }
    }

    json(res, 200, text);
  } catch (e) {
    json(res, 500, { error: e.message || String(e) });
  }
};
