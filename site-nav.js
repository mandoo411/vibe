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

  function navContext() {
    const header = document.querySelector(".tm-site-header");
    const nav = header ? header.querySelector(".tm-site-nav") : null;
    return { header, nav };
  }

  function setNavOpen(open) {
    const { header } = navContext();
    if (!header) return;
    const toggle = header.querySelector(".tm-nav-toggle");
    const mobile = window.innerWidth <= 768;
    header.classList.toggle("is-nav-open", open);
    document.body.classList.toggle("tm-mobile-nav-open", open && mobile);
    if (!toggle) return;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    const icon = toggle.querySelector(".tm-nav-toggle__icon");
    const label = toggle.querySelector(".tm-nav-toggle__label");
    if (icon) icon.textContent = open ? "×" : "☰";
    if (label) label.textContent = open ? "닫기" : "메뉴";
  }

  function ensureNavToggle() {
    const { header, nav } = navContext();
    if (!header || !nav) return null;

    if (!nav.id) nav.id = "tm-site-nav-menu";

    let toggle = header.querySelector(".tm-nav-toggle");
    if (!toggle) {
      toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "tm-nav-toggle";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-controls", nav.id);
      toggle.innerHTML =
        '<span class="tm-nav-toggle__icon" aria-hidden="true">☰</span><span class="tm-nav-toggle__label">메뉴</span>';
      header.insertBefore(toggle, nav);
    }

    if (!header.dataset.navBound) {
      toggle.addEventListener("click", () => {
        const open = header.classList.contains("is-nav-open");
        setNavOpen(!open);
      });

      nav.addEventListener("click", (event) => {
        const link = event.target.closest("a");
        if (link && window.innerWidth <= 768) setNavOpen(false);
      });

      document.addEventListener("click", (event) => {
        if (window.innerWidth > 768) return;
        if (!header.contains(event.target)) setNavOpen(false);
      });

      window.addEventListener("resize", () => {
        if (window.innerWidth > 768) setNavOpen(false);
      });

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") setNavOpen(false);
      });

      window.addEventListener("resize", () => {
        if (window.innerWidth > 768) setNavOpen(false);
      });

      header.dataset.navBound = "true";
    }

    setNavOpen(false);
    return toggle;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureNavToggle();
      updateTickerBar();
    }, { once: true });
  } else {
    ensureNavToggle();
    updateTickerBar();
  }
  setInterval(updateTickerBar, 5 * 60 * 1000);
})();
