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
    json(res, 200, text);
  } catch (e) {
    json(res, 500, { error: e.message || String(e) });
  }
};
