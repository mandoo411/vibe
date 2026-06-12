const FEAR_GREED_URL = "https://api.alternative.me/fng/?limit=1";

function toNum(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function fearGreedPlaceholder() {
  return {
    id: "fear-greed",
    symbol: "FNG",
    name: "공포탐욕 지수",
    value: null,
    changePct: null,
    rating: null,
    sparkline: [],
    unit: "gauge",
    live: false,
  };
}

function parseFearGreedBody(body) {
  const row = body?.data?.[0];
  const value = row?.value != null ? Math.round(toNum(row.value)) : null;
  if (value == null) return null;
  return {
    id: "fear-greed",
    symbol: "FNG",
    name: "공포탐욕 지수",
    value,
    changePct: null,
    rating: row?.value_classification ? String(row.value_classification) : null,
    sparkline: [],
    unit: "gauge",
    live: false,
  };
}

async function fetchFearGreedIndex({ retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(FEAR_GREED_URL, {
        headers: {
          Accept: "application/json",
          "User-Agent": "TotalMoneyAI/1.0 (+https://vibe-mu-nine.vercel.app)",
        },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`FearGreed HTTP ${res.status}`);
      const parsed = parseFearGreedBody(JSON.parse(text));
      if (parsed) return parsed;
      throw new Error("FearGreed empty payload");
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  console.warn("[fear-greed] fetch failed", lastErr && lastErr.message);
  return fearGreedPlaceholder();
}

module.exports = {
  FEAR_GREED_URL,
  fearGreedPlaceholder,
  parseFearGreedBody,
  fetchFearGreedIndex,
};
