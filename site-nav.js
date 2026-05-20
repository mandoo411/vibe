(function () {
  function formatTickerValue(item) {
    if (!item || item.value == null || item.value === "") return "—";
    const value = Number(item && item.value);
    if (!Number.isFinite(value)) return "—";
    const label = String(item.label || "");
    if (label.includes("BTC")) return `$${Math.round(value).toLocaleString("ko-KR")}`;
    if (label.includes("원/달러")) return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    if (label.includes("유가") || label.includes("금")) return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  }

  function formatTickerPct(value) {
    if (value == null || value === "") return "";
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  }

  function relocateTicker(bar) {
    const header = document.querySelector(".tm-site-header");
    if (!header) return;
    let wrap = bar.closest(".tm-market-ticker-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "tm-market-ticker-wrap";
      bar.parentNode.insertBefore(wrap, bar);
      wrap.appendChild(bar);
    }
    if (wrap.previousElementSibling !== header) {
      header.insertAdjacentElement("afterend", wrap);
    }
  }

  function ensureTickerBar() {
    const found = document.querySelector(".tm-market-ticker");
    if (found) {
      relocateTicker(found);
      return found;
    }
    const bar = document.createElement("div");
    bar.className = "tm-market-ticker";
    bar.setAttribute("aria-label", "실시간 시장 지표");
    bar.innerHTML = '<div class="tm-market-ticker__track">시장 지표 로딩 중…</div>';
    const wrap = document.createElement("div");
    wrap.className = "tm-market-ticker-wrap";
    wrap.appendChild(bar);

    const header = document.querySelector(".tm-site-header");
    if (header && header.parentNode) {
      header.insertAdjacentElement("afterend", wrap);
    } else {
      document.body.insertBefore(wrap, document.body.firstChild);
    }

    return bar;
  }

  async function updateTickerBar() {
    const bar = ensureTickerBar();
    const track = bar.querySelector(".tm-market-ticker__track");
    try {
      const res = await fetch("/api/market-ticker?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      track.innerHTML = items
        .map((item) => {
          const pct = Number(item.changePct);
          const cls = Number.isFinite(pct) && pct > 0 ? "is-up" : Number.isFinite(pct) && pct < 0 ? "is-down" : "";
          return `<span class="tm-market-ticker__item"><b>${item.label || "-"}</b><strong>${formatTickerValue(item)}</strong><em class="${cls}">${formatTickerPct(item.changePct)}</em></span>`;
        })
        .join("");
    } catch (_) {
      track.textContent = "시장 지표를 불러오지 못했습니다";
    }
  }

  function seoulParts() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return {
      weekday: map.weekday,
      minutes: Number(map.hour) * 60 + Number(map.minute),
    };
  }

  function ensureLiveNavLink() {
    const link = document.querySelector('.tm-site-nav a[href*="live-report"]');
    if (!link) return null;
    link.classList.add("tm-site-nav__link--live-report");
    if (!link.querySelector(".tm-nav-live-led")) {
      const led = document.createElement("span");
      led.className = "tm-nav-live-led";
      led.setAttribute("aria-hidden", "true");
      link.insertBefore(led, link.firstChild);
    }
    return link;
  }

  function updateLiveState() {
    const link = ensureLiveNavLink();
    try {
      const { weekday, minutes } = seoulParts();
      const weekdayOpen = weekday !== "Sat" && weekday !== "Sun";
      const marketOpen = weekdayOpen && minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
      document.body.classList.toggle("is-kr-market-open", marketOpen);
      if (link) {
        link.classList.toggle("is-live", marketOpen);
        link.classList.toggle("is-closed", !marketOpen);
      }
    } catch (_) {
      document.body.classList.remove("is-kr-market-open");
      if (link) {
        link.classList.remove("is-live");
        link.classList.add("is-closed");
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureLiveNavLink();
      updateLiveState();
      updateTickerBar();
    }, { once: true });
  } else {
    ensureLiveNavLink();
    updateLiveState();
    updateTickerBar();
  }
  setInterval(updateLiveState, 60 * 1000);
  setInterval(updateTickerBar, 5 * 60 * 1000);
})();
