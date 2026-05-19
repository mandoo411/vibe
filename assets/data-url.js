/** GitHub main 기준 JSON (data/ 푸시만으로 갱신, Vercel 재배포 불필요) */
window.TM_RAW_BASE = "https://raw.githubusercontent.com/mandoo411/vibe/main";

window.tmDataUrl = function tmDataUrl(path) {
  const p = String(path || "").replace(/^\//, "");
  return `${window.TM_RAW_BASE}/${p}`;
};

/** Raw 우선, 실패 시 동일 출처 ./data/ (비공개 저장소·최초 배포 전 폴백) */
window.tmFetchJson = async function tmFetchJson(path, options = {}) {
  const p = String(path || "").replace(/^\//, "");
  const bust = options.cacheBust !== false ? `?t=${Date.now()}` : "";
  const urls = [`${window.TM_RAW_BASE}/${p}${bust}`, `./${p}${bust}`];
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
