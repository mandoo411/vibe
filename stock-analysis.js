(function () {
  "use strict";

  let input = null;
  let btn = null;
  let panel = null;
  let stockList = [];
  let running = false;
  let loadingTimer = null;
  let progressTimer = null;
  const acState = { open: false, items: [], active: -1 };

  const LOADING_STEPS = [
    "최신 뉴스 및 재료 수집 중...",
    "기술적 지표 분석 중...",
    "재료 강도 평가 중...",
    "AI 시나리오 시뮬레이션 중...",
    "최종 투자 판단 생성 중...",
  ];

  const CSP_SAFE = true; // eval/new Function 미사용, JSON.parse만 사용

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toNum(v) {
    const n = Number(String(v == null ? "" : v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function safeParseJson(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function normalizeNameKey(name) {
    return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[()·•.,/\\'"]/g, "")
      .replace(/주식회사|㈜/g, "");
  }

  function code6Maybe(s) {
    const digits = String(s || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length === 6) return digits;
    if (digits.length < 6) return digits.padStart(6, "0");
    return digits.slice(-6);
  }

  async function loadStockList() {
    if (stockList.length) return stockList;
    try {
      const res = await fetch("/assets/stock-list.json?t=" + Date.now(), { cache: "no-store" });
      const data = safeParseJson(await res.text());
      if (Array.isArray(data)) {
        stockList = data
          .filter((x) => x && x.code && x.name)
          .map((x) => ({
            code: code6Maybe(x.code),
            name: String(x.name || "").trim(),
            market: String(x.market || "").toUpperCase() === "KOSDAQ" ? "KOSDAQ" : "KOSPI",
          }))
          .filter((x) => /^\d{6}$/.test(x.code) && x.name);
      }
    } catch (err) {
      console.error("[AI분석] stock-list 로드 실패", err);
    }
    return stockList;
  }

  function resolveQueryLocal(qRaw) {
    const q = String(qRaw || "").trim();
    if (!q) return null;
    const code6 = code6Maybe(q);
    if (/^\d{6}$/.test(code6)) {
      const hit = stockList.find((x) => x.code === code6);
      return { code: code6, name: hit ? hit.name : code6 };
    }
    const key = normalizeNameKey(q);
    const exact = stockList.find((x) => normalizeNameKey(x.name) === key);
    if (exact) return { code: exact.code, name: exact.name };
    const partial = stockList.filter((x) => {
      const nk = normalizeNameKey(x.name);
      return nk.includes(key) || key.includes(nk);
    });
    if (partial.length === 1) return { code: partial[0].code, name: partial[0].name };
    return null;
  }

  function acHost() {
    return document.getElementById("ai-stock-ac");
  }

  function setAutocompleteExpanded(open) {
    if (input) input.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeAutocomplete() {
    const host = acHost();
    acState.open = false;
    acState.items = [];
    acState.active = -1;
    if (host) host.hidden = true;
    setAutocompleteExpanded(false);
  }

  function renderAutocomplete(items, total) {
    const host = acHost();
    if (!host) return;
    if (!items || !items.length) {
      closeAutocomplete();
      return;
    }
    acState.open = true;
    acState.items = items;
    if (acState.active >= items.length) acState.active = items.length - 1;
    if (acState.active < 0) acState.active = 0;
    host.hidden = false;
    setAutocompleteExpanded(true);
    host.innerHTML =
      items
        .map((it, idx) => {
          const activeCls = idx === acState.active ? " is-active" : "";
          return `<div class="rt-ac-item${activeCls}" data-ac-idx="${idx}" role="option" tabindex="-1">
            <div class="rt-ac-item__main">
              <span class="rt-ac-item__name">${escapeHtml(it.name)}</span>
              <span class="rt-ac-item__code">${escapeHtml(it.code)}</span>
            </div>
            <span class="rt-ac-item__badge">${escapeHtml(it.market)}</span>
          </div>`;
        })
        .join("") +
      (total > items.length ? `<div class="rt-ac-more">외 ${escapeHtml(String(total - items.length))}개 더 있습니다</div>` : "");
  }

  function moveAutocomplete(delta) {
    if (!acState.open || !acState.items.length) return;
    const next = Math.max(0, Math.min(acState.items.length - 1, (acState.active || 0) + delta));
    acState.active = next;
    renderAutocomplete(acState.items, acState.items.length);
  }

  function pickActiveAutocomplete() {
    if (!acState.open || !acState.items.length) return null;
    const idx = acState.active;
    return idx >= 0 && idx < acState.items.length ? acState.items[idx] : null;
  }

  function filterStocksForAutocomplete(q) {
    const lc = q.toLowerCase();
    return (stockList || []).filter((x) => {
      const name = String(x.name || "").toLowerCase();
      const code = String(x.code || "");
      return name.includes(lc) || code.includes(q) || code.includes(lc);
    });
  }

  function pickStockItem(item) {
    if (!item || !input) return;
    input.value = item.code;
    closeAutocomplete();
    runAnalysis(item.code);
  }

  async function resolveForAnalysis(qRaw) {
    await loadStockList();
    const q = String(qRaw || "").trim();
    if (!q) return null;

    const params = new URLSearchParams(window.location.search);
    const urlCode = code6Maybe(params.get("code") || "");
    const urlName = String(params.get("name") || "").trim();
    if (/^\d{6}$/.test(urlCode) && (q === urlCode || q === urlName || !params.get("q"))) {
      return { code: urlCode, name: urlName || q };
    }
    return resolveQueryLocal(q);
  }

  function fmtPrice(n) {
    const v = toNum(n);
    if (v == null) return "—";
    return Math.round(v).toLocaleString("ko-KR");
  }

  function fmtPct(n) {
    const v = toNum(n);
    if (v == null) return "—";
    const sign = v > 0 ? "+" : "";
    return `${sign}${v.toFixed(2)}%`;
  }

  function chgClass(n) {
    const v = toNum(n);
    if (v == null || v === 0) return "";
    return v > 0 ? "is-up" : "is-down";
  }

  function signalBadgeClass(signal) {
    if (signal === "매수") return "ai-summary-badge--buy";
    if (signal === "회피") return "ai-summary-badge--avoid";
    return "ai-summary-badge--hold";
  }

  function setButtonLoading(on) {
    if (!btn) return;
    if (on) {
      btn.classList.add("is-loading");
      btn.disabled = true;
      btn.innerHTML = '<span class="ai-btn-spinner" aria-hidden="true"></span>분석 중…';
    } else {
      btn.classList.remove("is-loading");
      btn.disabled = false;
      btn.textContent = "AI 분석";
    }
  }

  function skeletonCardsHtml() {
    const skelBody =
      '<div class="ai-skel-line ai-skel-line--mid"></div><div class="ai-skel-line"></div><div class="ai-skel-line ai-skel-line--short"></div>';
    const titles = [
      "한눈에 요약",
      "왜 지금 이 가격인가",
      "수급 분석",
      "다가오는 이벤트",
      "재료 분석",
      "차트 흐름 분석",
      "AI 주관적 판단",
      "신호 요약",
    ];
    return titles
      .map((title, i) => {
        const extra = i === 0 || i === 7 ? " ai-card--summary" : "";
        const sig = i === 7 ? " ai-card--signals" : "";
        const chart = i === 5 ? " ai-card--chart" : "";
        const opinion = i === 6 ? " ai-card--opinion" : "";
        const materials = i === 4 ? " ai-card--materials" : "";
        return `<article class="ai-card is-skeleton${extra}${sig}${chart}${opinion}${materials}"><h3 class="ai-card__title"><span class="ai-card__num">${i + 1}</span>${escapeHtml(title)}</h3><div class="ai-card__body">${skelBody}</div></article>`;
      })
      .join("");
  }

  function clearLoadingTimer() {
    if (loadingTimer) {
      clearInterval(loadingTimer);
      loadingTimer = null;
    }
  }

  function updateLoadingMessage(msg) {
    const el = document.getElementById("ai-loading-msg");
    if (el) el.textContent = msg;
  }

  function formatMarketCapPretty(raw) {
    const n = toNum(raw);
    if (n == null) return "—";
    if (n >= 10000) return `${(n / 10000).toFixed(1)}조`;
    if (n >= 1) return `${Math.round(n).toLocaleString("ko-KR")}억`;
    return `${Math.round(n).toLocaleString("ko-KR")}`;
  }

  function clearProgressTimer() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  function setProgressPct(pct) {
    const bar = document.getElementById("ai-loading-progress-bar");
    const label = document.getElementById("ai-loading-progress-pct");
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    if (bar) bar.style.width = `${v}%`;
    if (label) label.textContent = `${v}%`;
  }

  function startProgressAnimation() {
    clearProgressTimer();
    setProgressPct(0);
    let pct = 0;
    progressTimer = setInterval(() => {
      if (pct >= 95) return;
      pct += pct < 60 ? 2 : pct < 85 ? 1 : 0.5;
      setProgressPct(Math.min(95, pct));
    }, 400);
  }

  async function fetchQuickQuote(code) {
    try {
      const res = await fetch(`/api/kis-stock-quote?code=${encodeURIComponent(code)}`, { cache: "no-store" });
      const data = safeParseJson(await res.text()) || {};
      if (!res.ok) return null;
      const raw1 = data.raw1 || {};
      return {
        stockName: data.stockName || "",
        stockCode: data.stockCode || code,
        currentPrice: data.currentPrice,
        changeRate: data.changeRate,
        high52w: toNum(raw1.w52_hgpr),
        low52w: toNum(raw1.w52_lwpr),
        marketCapRaw: data.marketCapRaw || raw1.hts_avls || raw1.stck_avls || "",
      };
    } catch (err) {
      console.warn("[AI분석] quick quote 실패", err);
      return null;
    }
  }

  function renderLoadingQuoteHeader(quote, fallbackName, fallbackCode) {
    const name = (quote && quote.stockName) || fallbackName || "";
    const code = (quote && quote.stockCode) || fallbackCode || "";
    const priceCls = chgClass(quote && quote.changeRate);
    return (
      `<div class="ai-loading-quote">` +
      `<div class="ai-loading-quote__top">` +
      `<h2 class="ai-loading-quote__name">${escapeHtml(name)}</h2>` +
      `<span class="ai-loading-quote__code">${escapeHtml(code)}</span>` +
      `</div>` +
      `<div class="ai-loading-quote__stats">` +
      `<div class="ai-loading-quote__price ${priceCls}">${escapeHtml(fmtPrice(quote && quote.currentPrice))}<span class="ai-loading-quote__unit">원</span></div>` +
      `<div class="ai-loading-quote__chg ${priceCls}">${escapeHtml(fmtPct(quote && quote.changeRate))}</div>` +
      `<div class="ai-loading-quote__meta"><span>52주 고</span><strong>${escapeHtml(fmtPrice(quote && quote.high52w))}</strong></div>` +
      `<div class="ai-loading-quote__meta"><span>52주 저</span><strong>${escapeHtml(fmtPrice(quote && quote.low52w))}</strong></div>` +
      `<div class="ai-loading-quote__meta"><span>시총</span><strong>${escapeHtml(formatMarketCapPretty(quote && quote.marketCapRaw))}</strong></div>` +
      `</div></div>`
    );
  }

  function showLoading(resolved) {
    if (!panel) return;
    clearLoadingTimer();
    clearProgressTimer();
    panel.hidden = false;
    let step = 0;
    const header =
      `<div id="ai-loading-quote-host" class="ai-loading-quote-host">` +
      `<div class="ai-loading-quote ai-loading-quote--pending"><span class="ai-loading-quote__name">${escapeHtml(resolved.name || "")}</span><span class="ai-loading-quote__code">${escapeHtml(resolved.code || "")}</span><span class="ai-loading-quote__pending">시세 불러오는 중…</span></div></div>`;
    panel.innerHTML =
      header +
      `<div class="ai-loading-panel" role="status" aria-live="polite">` +
      `<div class="ai-loading-progress"><div class="ai-loading-progress__track"><div id="ai-loading-progress-bar" class="ai-loading-progress__bar"></div></div><span id="ai-loading-progress-pct" class="ai-loading-progress__pct">0%</span></div>` +
      `<p id="ai-loading-msg" class="ai-loading-panel__msg">${escapeHtml(LOADING_STEPS[0])}</p>` +
      `<p class="ai-loading-panel__hint">보통 15~25초 소요됩니다</p>` +
      `</div>`;
    startProgressAnimation();
    loadingTimer = setInterval(() => {
      step = (step + 1) % LOADING_STEPS.length;
      updateLoadingMessage(LOADING_STEPS[step]);
    }, 3000);

    void fetchQuickQuote(resolved.code).then((quote) => {
      const host = document.getElementById("ai-loading-quote-host");
      if (!host) return;
      host.innerHTML = renderLoadingQuoteHeader(quote, resolved.name, resolved.code);
    });
  }

  function finishLoadingProgress() {
    clearProgressTimer();
    setProgressPct(100);
  }

  function showError(msg) {
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = `<div class="ai-analysis-error" role="alert">${escapeHtml(msg || "분석을 불러오지 못했습니다")}</div>`;
  }

  function renderEvents(events) {
    if (!Array.isArray(events) || !events.length) {
      return '<p class="ai-card__body ai-event-empty">현재 확인된 예정 이벤트 없음</p>';
    }
    return (
      "<ul class=\"ai-event-list\">" +
      events
        .map((e) => {
          const isBad = e.type === "악재";
          return `<li class="ai-event"><span class="ai-event__badge ${isBad ? "ai-event__badge--bad" : "ai-event__badge--good"}">${escapeHtml(e.type)}</span><span class="ai-event__content">${escapeHtml(e.content)}</span>${e.date ? `<span class="ai-event__date">${escapeHtml(e.date)}</span>` : ""}</li>`;
        })
        .join("") +
      "</ul>"
    );
  }

  function isDarkTheme() {
    return (
      document.documentElement.getAttribute("data-theme") === "dark" ||
      document.body.classList.contains("dark-mode") ||
      document.body.classList.contains("dark")
    );
  }

  function tradingViewSymbol(stockCode, stockName) {
    const code = String(stockCode || "").replace(/\D/g, "");
    if (/^\d{6}$/.test(code)) return `KRX:${code}`;
    const ticker = String(stockName || stockCode || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9.]/g, "");
    if (!ticker) return "KRX:005930";
    const nyseTickers = new Set(["BRK.B", "BRK.A", "JPM", "V", "WMT", "XOM", "BAC", "DIS", "T", "KO", "PFE"]);
    const prefix = nyseTickers.has(ticker) ? "NYSE" : "NASDAQ";
    return `${prefix}:${ticker}`;
  }

  function tradingViewMaStudies() {
    return JSON.stringify(
      [20, 60, 120, 200].map((length) => ({
        id: "MASimple@tv-basicstudies",
        inputs: { length, source: "close" },
      }))
    );
  }

  function tradingViewUrl(symbol) {
    const isDark = isDarkTheme();
    const theme = isDark ? "dark" : "light";
    const chartBg = isDark ? "#131722" : "#ffffff";
    const params = new URLSearchParams({
      symbol,
      interval: "D",
      timezone: "Asia/Seoul",
      theme,
      style: "1",
      locale: "kr",
      toolbar_bg: chartBg,
      bgcolor: chartBg,
      gridcolor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
      hide_side_toolbar: "0",
      allow_symbol_change: "1",
      save_image: "0",
      calendar: "0",
      withdateranges: "1",
      hideideas: "1",
      studies: tradingViewMaStudies(),
      up_color: "#e24b4a",
      down_color: "#3b82f6",
      border_up_color: "#e24b4a",
      border_down_color: "#3b82f6",
      wick_up_color: "#e24b4a",
      wick_down_color: "#3b82f6",
    });
    if (typeof window.tmTradingViewCandleOverrides === "function") {
      params.set("overrides", JSON.stringify(window.tmTradingViewCandleOverrides(isDark)));
    }
    return `https://www.tradingview.com/widgetembed/?${params.toString()}`;
  }

  function refreshTradingViewCharts() {
    document.querySelectorAll(".ai-tv-widget").forEach((iframe) => {
      const sym = iframe.getAttribute("data-symbol");
      if (sym) iframe.src = tradingViewUrl(sym);
    });
  }

  function renderChartSection(stockCode, stockName, chartText) {
    const sym = tradingViewSymbol(stockCode, stockName);
    const text = chartText || "차트 분석이 없습니다.";
    return (
      `<div class="ai-chart-block">` +
      `<div class="ai-chart-tv"><iframe class="ai-tv-widget" data-symbol="${escapeHtml(sym)}" title="${escapeHtml(stockName || stockCode)} TradingView chart" src="${escapeHtml(tradingViewUrl(sym))}" loading="lazy" allowtransparency="true" scrolling="no"></iframe></div>` +
      `<div class="ai-chart-text">${escapeHtml(text)}</div>` +
      `</div>`
    );
  }

  function scenarioCardClass(label, type) {
    const t = String(type || label || "").toUpperCase();
    if (label === "A" || t.includes("강")) return "ai-scenario--bull";
    if (label === "C" || t.includes("약")) return "ai-scenario--bear";
    return "ai-scenario--neutral";
  }

  function renderMaterials(materials) {
    const m = materials && typeof materials === "object" ? materials : {};
    const items = Array.isArray(m.items) ? m.items.slice(0, 4) : [];
    const cards = items.length
      ? items
          .map((it) => {
            const strength = it.strength || "중";
            const strengthCls =
              strength === "상"
                ? "ai-mat-strength--high"
                : strength === "하"
                  ? "ai-mat-strength--low"
                  : "ai-mat-strength--mid";
            const pct = Math.max(0, Math.min(100, toNum(it.reflectionPct) || 0));
            const note = it.reflectionNote || (pct ? `${pct}% 반영` : "");
            return (
              `<article class="ai-mat-card">` +
              `<div class="ai-mat-card__head"><strong class="ai-mat-card__name">${escapeHtml(it.name)}</strong><span class="ai-mat-strength ${strengthCls}">${escapeHtml(strength)}</span></div>` +
              `<div class="ai-mat-reflect"><div class="ai-mat-reflect__track"><div class="ai-mat-reflect__bar" style="width:${pct}%"></div></div><span class="ai-mat-reflect__label">${escapeHtml(note)}</span></div>` +
              `<p class="ai-mat-card__judgment">${escapeHtml(it.judgment || "")}</p>` +
              `</article>`
            );
          })
          .join("")
      : '<p class="ai-mat-empty">확인된 핵심 재료가 없습니다.</p>';
    const unreflected = m.unreflected
      ? `<div class="ai-mat-unreflected"><span class="ai-mat-unreflected__label">미반영 핵심 재료</span><p>${escapeHtml(m.unreflected)}</p></div>`
      : "";
    const summary = m.summary
      ? `<div class="ai-mat-summary"><span class="ai-mat-summary__label">AI 재료 종합 판단</span><p>${escapeHtml(m.summary)}</p></div>`
      : "";
    return `<div class="ai-mat-grid">${cards}</div>${unreflected}${summary}`;
  }

  function renderScenarioCard(s) {
    const label = escapeHtml(s.label || "?");
    const type = escapeHtml(s.type || "");
    const cls = scenarioCardClass(s.label, s.type);
    const prob = toNum(s.probability);
    const probText = prob == null ? "—" : `${Math.round(prob)}%`;
    const isBear = String(s.label) === "C" || String(s.type).includes("약");
    const lines = [
      ["조건", s.condition],
      isBear ? ["대응전략", s.strategy] : ["진입가", s.entry != null ? `${fmtPrice(s.entry)}원` : null],
      isBear ? ["목표 하단", s.targetLow != null ? `${fmtPrice(s.targetLow)}원` : null] : ["목표가", s.target != null ? `${fmtPrice(s.target)}원` : null],
      isBear ? null : ["손절가", s.stop != null ? `${fmtPrice(s.stop)}원` : null],
      ["확률", probText],
    ]
      .filter(Boolean)
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<div class="ai-scenario-row"><span class="ai-scenario-row__k">${escapeHtml(k)}</span><span class="ai-scenario-row__v">${escapeHtml(String(v))}</span></div>`
      )
      .join("");
    return `<article class="ai-scenario ${cls}"><header class="ai-scenario__head"><span class="ai-scenario__label">${label}안</span><span class="ai-scenario__type">${type}</span></header><div class="ai-scenario__body">${lines || "<p>—</p>"}</div></article>`;
  }

  function renderOpinion(op) {
    const o = op && typeof op === "object" ? op : {};
    const rows = [
      ["단기(1-2주)", o.short],
      ["중기(1-3개월)", o.mid],
      ["장기(6개월-1년)", o.long],
    ]
      .filter(([, t]) => t)
      .map(
        ([label, text]) =>
          `<div class="ai-opinion-row"><span class="ai-opinion-row__label">${escapeHtml(label)}</span><span>${escapeHtml(text)}</span></div>`
      )
      .join("");
    const prices = [
      ["진입가", o.entry],
      ["손절가", o.stop],
      ["목표가", o.target],
    ]
      .map(
        ([label, val]) =>
          `<div class="ai-opinion-price"><span class="ai-opinion-price__label">${escapeHtml(label)}</span><span class="ai-opinion-price__value">${escapeHtml(fmtPrice(val))}</span></div>`
      )
      .join("");
    const scenarios = Array.isArray(o.scenarios) && o.scenarios.length ? o.scenarios : [];
    const scenarioHtml = scenarios.length
      ? scenarios.map(renderScenarioCard).join("")
      : '<p class="ai-scenario-empty">시나리오 정보가 없습니다.</p>';
    const comment = o.comment ? `<div class="ai-opinion-comment">${escapeHtml(o.comment)}</div>` : "";
    return (
      `<div class="ai-opinion-layout">` +
      `<div class="ai-opinion-col ai-opinion-col--left">` +
      `<div class="ai-opinion-grid">${rows || "<p>전망 정보가 없습니다.</p>"}</div>` +
      `<div class="ai-opinion-prices">${prices}</div>` +
      `${comment}` +
      `</div>` +
      `<div class="ai-opinion-col ai-opinion-col--right">${scenarioHtml}</div>` +
      `</div>`
    );
  }

  function renderSignals(signals) {
    const up = Math.max(0, Math.round(toNum(signals && signals.up) || 0));
    const down = Math.max(0, Math.round(toNum(signals && signals.down) || 0));
    const total = up + down || 1;
    const upPct = Math.round((up / total) * 100);
    const downPct = 100 - upPct;
    return `<div class="ai-signals"><div class="ai-signals__counts"><span class="ai-signals__up">상승 신호 ${up}개</span><span class="ai-signals__down">하락 신호 ${down}개</span></div><div class="ai-signals__gauge"><span class="ai-signals__gauge-up" style="width:${upPct}%"></span><span class="ai-signals__gauge-down" style="width:${downPct}%"></span></div></div>`;
  }

  function renderAnalysis(data) {
    if (!panel) return;
    let analysis = data && data.analysis;
    if (typeof analysis === "string") analysis = safeParseJson(analysis);
    if (!analysis || typeof analysis !== "object") {
      showError("분석을 불러오지 못했습니다");
      return;
    }

    const summary = analysis.summary && typeof analysis.summary === "object" ? analysis.summary : {};
    const signal = summary.signal || "관망";
    const prob = toNum(summary.probability);
    const probText = prob == null ? "—" : `${prob}%`;
    const priceCls = chgClass(data.changeRate);
    const errBanner =
      analysis._error && data.analysisError
        ? `<div class="ai-analysis-error" style="margin-bottom:12px">${escapeHtml(data.analysisError)}</div>`
        : "";

    panel.hidden = false;
    panel.innerHTML =
      errBanner +
      `<div class="ai-analysis-stock"><h2 class="ai-analysis-stock__name">${escapeHtml(data.stockName || "")}</h2><span class="ai-analysis-stock__code">${escapeHtml(data.stockCode || "")}</span><span class="ai-analysis-stock__price ${priceCls}">${escapeHtml(fmtPrice(data.currentPrice))}원</span><span class="ai-analysis-stock__chg ${priceCls}">${escapeHtml(fmtPct(data.changeRate))}</span></div>` +
      `<div class="ai-analysis-cards">
        <article class="ai-card ai-card--summary"><h3 class="ai-card__title"><span class="ai-card__num">1</span>한눈에 요약</h3><div class="ai-card__body"><span class="ai-summary-badge ${signalBadgeClass(signal)}">${escapeHtml(signal)}</span><div class="ai-summary-prob"><span class="ai-summary-prob__label">상승 확률</span><span class="ai-summary-prob__value">${escapeHtml(probText)}</span></div><p class="ai-summary-desc">${escapeHtml(summary.description || "")}</p></div></article>
        <article class="ai-card"><h3 class="ai-card__title"><span class="ai-card__num">2</span>왜 지금 이 가격인가</h3><div class="ai-card__body">${escapeHtml(analysis.story || "분석 내용이 없습니다.")}</div></article>
        <article class="ai-card"><h3 class="ai-card__title"><span class="ai-card__num">3</span>수급 분석</h3><div class="ai-card__body">${escapeHtml(analysis.supply || "수급 정보가 없습니다.")}</div></article>
        <article class="ai-card"><h3 class="ai-card__title"><span class="ai-card__num">4</span>다가오는 이벤트</h3>${renderEvents(analysis.events)}</article>
        <article class="ai-card ai-card--materials"><h3 class="ai-card__title"><span class="ai-card__num">5</span>재료 분석</h3><div class="ai-card__body">${renderMaterials(analysis.materials)}</div></article>
        <article class="ai-card ai-card--chart"><h3 class="ai-card__title"><span class="ai-card__num">6</span>차트 흐름 분석</h3><div class="ai-card__body">${renderChartSection(data.stockCode, data.stockName, analysis.chart)}</div></article>
        <article class="ai-card ai-card--opinion"><h3 class="ai-card__title"><span class="ai-card__num">7</span>AI 주관적 판단</h3><div class="ai-card__body">${renderOpinion(analysis.opinion)}</div></article>
        <article class="ai-card ai-card--signals"><h3 class="ai-card__title"><span class="ai-card__num">8</span>신호 요약</h3><div class="ai-card__body">${renderSignals(analysis.signals)}</div></article>
      </div>`;
  }

  async function fetchAnalysis(code, name) {
    console.log("[AI분석] fetch 시작", { code, name });
    let res;
    try {
      res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name }),
        cache: "no-store",
      });
    } catch (err) {
      console.error("[AI분석] 실패", err);
      throw err;
    }

    const text = await res.text();
    const data = safeParseJson(text) || {};
    console.log("[AI분석] 응답", res.status, data.analysisError || "ok");

    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.error) throw new Error(data.error);
    if (!data.analysis) throw new Error("분석 데이터가 없습니다");
    return data;
  }

  async function runAnalysis(qRaw) {
    const q = String(qRaw || "").trim();
    if (!q) {
      if (input) input.focus();
      return;
    }
    if (running) return;

    closeAutocomplete();
    running = true;
    setButtonLoading(true);

    try {
      const resolved = await resolveForAnalysis(q);
      if (!resolved || !/^\d{6}$/.test(resolved.code)) {
        throw new Error("종목을 찾을 수 없습니다. 한국 상장 종목명 또는 6자리 코드를 입력해 주세요.");
      }

      if (input) input.value = resolved.name || resolved.code;
      showLoading(resolved);

      const data = await fetchAnalysis(resolved.code, resolved.name);
      finishLoadingProgress();
      renderAnalysis(data);
      refreshTradingViewCharts();
    } catch (err) {
      console.error("[AI분석] 실패", err);
      showError((err && err.message) || "분석을 불러오지 못했습니다");
    } finally {
      clearLoadingTimer();
      clearProgressTimer();
      running = false;
      setButtonLoading(false);
    }
  }

  async function onAnalyzeClick() {
    await loadStockList();
    const q = input ? String(input.value || "").trim() : "";
    const resolved = q ? await resolveForAnalysis(q) : null;
    const code = resolved && resolved.code ? resolved.code : "";
    const name = resolved && resolved.name ? resolved.name : q;
    console.log("[AI분석] 버튼 클릭됨", code, name);
    runAnalysis(q);
  }

  function init() {
    input = document.getElementById("ai-stock-query");
    btn = document.getElementById("ai-stock-submit");
    panel = document.getElementById("ai-analysis-panel");

    console.log("[AI분석] init", {
      input: !!input,
      btn: !!btn,
      panel: !!panel,
      btnIsNull: btn === null,
      readyState: document.readyState,
      cspSafe: CSP_SAFE,
    });

    if (!btn) {
      console.error("[AI분석] #ai-stock-submit 없음 — 리스너 미등록");
      return;
    }
    if (!panel) {
      console.error("[AI분석] #ai-analysis-panel 없음");
      return;
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      onAnalyzeClick();
    });

    if (input) {
      input.addEventListener("input", async () => {
        const q = String(input.value || "").trim();
        if (q.length < 2) {
          closeAutocomplete();
          return;
        }
        await loadStockList();
        const matches = filterStocksForAutocomplete(q);
        renderAutocomplete(matches.slice(0, 8), matches.length);
      });

      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          if (acState.open) {
            e.preventDefault();
            moveAutocomplete(1);
          }
          return;
        }
        if (e.key === "ArrowUp") {
          if (acState.open) {
            e.preventDefault();
            moveAutocomplete(-1);
          }
          return;
        }
        if (e.key === "Enter") {
          const picked = pickActiveAutocomplete();
          if (picked) {
            e.preventDefault();
            pickStockItem(picked);
            return;
          }
          e.preventDefault();
          onAnalyzeClick();
          return;
        }
        if (e.key === "Escape") {
          closeAutocomplete();
        }
      });
    }

    const ac = acHost();
    if (ac && !ac.dataset.wired) {
      ac.dataset.wired = "1";
      ac.addEventListener("mousemove", (e) => {
        const it = e.target && e.target.closest ? e.target.closest("[data-ac-idx]") : null;
        if (!it) return;
        const idx = Number(it.getAttribute("data-ac-idx") || "-1");
        if (Number.isFinite(idx) && idx >= 0) {
          acState.active = idx;
          renderAutocomplete(acState.items, acState.items.length);
        }
      });
      ac.addEventListener("mousedown", (e) => {
        const it = e.target && e.target.closest ? e.target.closest("[data-ac-idx]") : null;
        if (!it) return;
        e.preventDefault();
        const idx = Number(it.getAttribute("data-ac-idx") || "-1");
        const picked = idx >= 0 && idx < acState.items.length ? acState.items[idx] : null;
        if (picked) pickStockItem(picked);
      });
    }

    if (!document.body.dataset.aiAcOutside) {
      document.body.dataset.aiAcOutside = "1";
      document.addEventListener("mousedown", (e) => {
        const host = acHost();
        if (!host || host.hidden) return;
        const t = e.target;
        if (host.contains(t) || (input && input.contains(t))) return;
        closeAutocomplete();
      });
    }

    void loadStockList();

    const themeBtn = document.getElementById("theme-toggle");
    if (themeBtn && !themeBtn.dataset.aiTvThemeBound) {
      themeBtn.dataset.aiTvThemeBound = "1";
      themeBtn.addEventListener("click", () => {
        setTimeout(refreshTradingViewCharts, 0);
      });
    }

    document.getElementById("ai-stock-analysis")?.addEventListener("click", (e) => {
      const chip = e.target && e.target.closest ? e.target.closest(".ai-search-popular__chip") : null;
      if (!chip) return;
      e.preventDefault();
      const query = chip.getAttribute("data-query") || "";
      console.log("[AI분석] 인기종목 클릭", query);
      runAnalysis(query);
    });

    const params = new URLSearchParams(window.location.search);
    const boot = params.get("q") || params.get("name") || params.get("code") || "";
    if (boot) {
      console.log("[AI분석] URL 자동 실행", boot);
      runAnalysis(boot);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
