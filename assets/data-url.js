/** data/*.json 로드 — Private repo: /api/repo-data, 폴백: 동일 출처 ./data/ */
window.TM_RAW_BASE = "https://raw.githubusercontent.com/mandoo411/vibe/main";

window.tmDataUrl = function tmDataUrl(path) {
  const p = String(path || "").replace(/^\//, "");
  return `${window.TM_RAW_BASE}/${p}`;
};

function tmIsLocalHost() {
  if (typeof location === "undefined") return true;
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "";
}

window.tmFetchJson = async function tmFetchJson(path, options = {}) {
  const p = String(path || "").replace(/^\//, "");
  if (!/^data\/[\w.-]+\.json$/i.test(p)) throw new Error(`Invalid path: ${p}`);

  const bust = options.cacheBust !== false ? Date.now() : null;
  const urls = [];

  if (!tmIsLocalHost()) {
    const q = new URLSearchParams({ path: p });
    if (bust) q.set("t", String(bust));
    urls.push(`/api/repo-data?${q}`);
  }

  urls.push(bust ? `./${p}?t=${bust}` : `./${p}`);
  urls.push(bust ? `${window.TM_RAW_BASE}/${p}?t=${bust}` : `${window.TM_RAW_BASE}/${p}`);

  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store", ...options });
      if (res.ok) return res.json();
      lastErr = new Error(`${url} → ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`Failed to load ${p}`);
};
