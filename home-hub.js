(function () {
  const CARD_MAP = {
    daily: "kospi",
    briefing: "sp500",
    realtime: "samsung",
    us: "nasdaq",
    crypto: "btc",
  };

  function seoulYmd() {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  function formatHubQuote(item, kind) {
    if (!item || item.value == null || !Number.isFinite(Number(item.value))) {
      return { text: "—", dir: "" };
    }
    const v = Number(item.value);
    const pct = Number(item.changePct);
    let price = "";
    if (kind === "btc") {
      price = `$${Math.round(v).toLocaleString("ko-KR")}`;
    } else if (kind === "samsung") {
      price = `${Math.round(v).toLocaleString("ko-KR")}원`;
    } else if (kind === "sp500" || kind === "nasdaq") {
      price = v.toLocaleString("en-US", { maximumFractionDigits: 2 });
    } else {
      price = v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    }
    const pctStr = Number.isFinite(pct) ? ` ${pct > 0 ? "+" : ""}${pct.toFixed(2)}%` : "";
    const dir = !Number.isFinite(pct) || pct === 0 ? "" : pct > 0 ? "up" : "down";
    return { text: `${price}${pctStr}`, dir };
  }

  function setBadge(cardKey, text, opts) {
    const card = document.querySelector(`[data-hub-card="${cardKey}"]`);
    const el = card && card.querySelector("[data-hub-badge]");
    if (!el) return;
    el.textContent = text;
    el.classList.remove("is-up", "is-down", "is-soon");
    if (opts && opts.soon) el.classList.add("is-soon");
    else if (opts && opts.dir === "up") el.classList.add("is-up");
    else if (opts && opts.dir === "down") el.classList.add("is-down");
  }

  async function fetchScheduleCount() {
    const path = "data/weekly-schedule.json";
    const t = Date.now();
    const urls = [
      `/api/repo-data?path=${encodeURIComponent(path)}&t=${t}`,
      `./${path}?t=${t}`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const data = await res.json();
        const today = seoulYmd();
        const list = Array.isArray(data.economicCalendar) ? data.economicCalendar : [];
        const isUsKr = (r) => {
          const c = String(r?.country || "").toUpperCase();
          return c === "US" || c === "KR";
        };
        const n = list.filter((row) => isUsKr(row) && String(row.date || "").slice(0, 10) === today).length;
        return n;
      } catch (_) {
        /* try next */
      }
    }
    return null;
  }

  async function updateHubBadges() {
    try {
      const res = await fetch("/api/market-ticker?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const hub = data.hub && typeof data.hub === "object" ? data.hub : {};
      Object.keys(CARD_MAP).forEach((cardKey) => {
        const hubKey = CARD_MAP[cardKey];
        const item = hub[hubKey];
        const { text, dir } = formatHubQuote(item, hubKey);
        setBadge(cardKey, text, { dir });
      });
    } catch (_) {
      Object.keys(CARD_MAP).forEach((cardKey) => setBadge(cardKey, "—", {}));
    }

    setBadge("world", "Apple 시총 1위", {});
    setBadge("ai", "곧 출시", { soon: true });

    try {
      const n = await fetchScheduleCount();
      setBadge("schedule", n == null ? "오늘 경제지표 —" : `오늘 경제지표 ${n}건`, {});
    } catch (_) {
      setBadge("schedule", "오늘 경제지표 —", {});
    }
  }

  function initBottomNavActive() {
    const path = (window.location.pathname || "").replace(/\/+$/, "") || "/";
    const items = document.querySelectorAll(".tm-bottom-nav__item");
    items.forEach((a) => {
      const href = (a.getAttribute("href") || "").replace(/\/+$/, "");
      const isHome = href === "/index.html" || href === "./index.html" || href === "/" || href.endsWith("/index.html");
      const active =
        (isHome && (path === "/" || path.endsWith("/index.html") || path.endsWith("index.html"))) ||
        (!isHome && path.endsWith(href.replace(/^\.\//, "")));
      a.classList.toggle("is-active", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  function boot() {
    initBottomNavActive();
    updateHubBadges();
    setInterval(updateHubBadges, 5 * 60 * 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
