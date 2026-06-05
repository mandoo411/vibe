(function () {
  let input = null;
  let btn = null;
  let panel = null;
  let stockList = [];
  let running = false;
  let initialized = false;

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
      const text = await res.text();
      const data = safeParseJson(text);
      if (Array.isArray(data)) {
        stockList = data
          .filter((x) => x && x.code && x.name)
          .map((x) => ({
            code: code6Maybe(x.code),
            name: String(x.name || "").trim(),
          }))
          .filter((x) => /^\d{6}$/.test(x.code) && x.name);
      }
    } catch {}
    return stockList;
  }

  function resolveQueryLocal(qRaw) {
    const q = String(qRaw || "").trim();
    if (!q) return null;
    const code6 = code6Maybe(q);
    if (/^\d{6}$/.test(code6)) {
      const hit = stockList.find((x) => x.code === code6);
      return { query: hit ? hit.name : code6, code: code6, name: hit ? hit.name : code6 };
    }
    const key = normalizeNameKey(q);
    const exact = stockList.find((x) => normalizeNameKey(x.name) === key);
    if (exact) return { query: exact.name, code: exact.code, name: exact.name };
    const partial = stockList.filter((x) => {
      const nk = normalizeNameKey(x.name);
      return nk.includes(key) || key.includes(nk);
    });
    if (partial.length === 1) return { query: partial[0].name, code: partial[0].code, name: partial[0].name };
    return { query: q, code: "", name: q };
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
    const skelBody = `
      <div class="ai-skel-line ai-skel-line--mid"></div>
      <div class="ai-skel-line"></div>
      <div class="ai-skel-line ai-skel-line--short"></div>`;
    const titles = [
      "한눈에 요약",
      "왜 지금 이 가격인가",
      "수급 분석",
      "다가오는 이벤트",
      "차트 흐름 분석",
      "AI 주관적 판단",
      "신호 요약",
    ];
    return titles
      .map((title, i) => {
        const extra = i === 0 || i === 6 ? " ai-card--summary" : "";
        const sig = i === 6 ? " ai-card--signals" : "";
        return `<article class="ai-card is-skeleton${extra}${sig}">
          <h3 class="ai-card__title"><span class="ai-card__num">${i + 1}</span>${escapeHtml(title)}</h3>
          <div class="ai-card__body">${skelBody}</div>
        </article>`;
      })
      .join("");
  }

  function showLoading() {
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = `
      <div class="ai-analysis-status" role="status" aria-live="polite">
        <span class="ai-analysis-status__spinner" aria-hidden="true"></span>
        <span>AI가 분석 중입니다...</span>
      </div>
      <div class="ai-analysis-cards">${skeletonCardsHtml()}</div>`;
  }

  function showError(msg) {
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = `<div class="ai-analysis-error" role="alert">${escapeHtml(msg || "분석을 불러오지 못했습니다")}</div>`;
  }

  function renderEvents(events) {
    if (!Array.isArray(events) || !events.length) {
      return '<p class="ai-card__body">확인된 주요 이벤트가 없습니다.</p>';
    }
    const items = events
      .map((e) => {
        const isBad = e.type === "악재";
        return `<li class="ai-event">
          <span class="ai-event__badge ${isBad ? "ai-event__badge--bad" : "ai-event__badge--good"}">${escapeHtml(e.type)}</span>
          <span class="ai-event__content">${escapeHtml(e.content)}</span>
          ${e.date ? `<span class="ai-event__date">${escapeHtml(e.date)}</span>` : ""}
        </li>`;
      })
      .join("");
    return `<ul class="ai-event-list">${items}</ul>`;
  }

  function renderOpinion(op) {
    const o = op && typeof op === "object" ? op : {};
    const rows = [
      ["단기", o.short],
      ["중기", o.mid],
      ["장기", o.long],
    ]
      .filter(([, text]) => text)
      .map(
        ([label, text]) => `<div class="ai-opinion-row">
          <span class="ai-opinion-row__label">${escapeHtml(label)}</span>
          <span>${escapeHtml(text)}</span>
        </div>`
      )
      .join("");

    const prices = [
      ["진입가", o.entry],
      ["손절가", o.stop],
      ["목표가", o.target],
    ]
      .map(
        ([label, val]) => `<div class="ai-opinion-price">
          <span class="ai-opinion-price__label">${escapeHtml(label)}</span>
          <span class="ai-opinion-price__value">${escapeHtml(fmtPrice(val))}</span>
        </div>`
      )
      .join("");

    const comment = o.comment
      ? `<div class="ai-opinion-comment">"${escapeHtml(o.comment)}"</div>`
      : "";

    return `<div class="ai-opinion-grid">${rows || "<p>시나리오 정보가 없습니다.</p>"}</div>
      <div class="ai-opinion-prices">${prices}</div>${comment}`;
  }

  function renderSignals(signals) {
    const up = Math.max(0, Math.round(toNum(signals && signals.up) || 0));
    const down = Math.max(0, Math.round(toNum(signals && signals.down) || 0));
    const total = up + down || 1;
    const upPct = Math.round((up / total) * 100);
    const downPct = 100 - upPct;
    return `<div class="ai-signals">
      <div class="ai-signals__counts">
        <span class="ai-signals__up">상승 신호 ${up}개</span>
        <span class="ai-signals__down">하락 신호 ${down}개</span>
      </div>
      <div class="ai-signals__gauge" role="img" aria-label="상승 ${up}개, 하락 ${down}개">
        <span class="ai-signals__gauge-up" style="width:${upPct}%"></span>
        <span class="ai-signals__gauge-down" style="width:${downPct}%"></span>
      </div>
    </div>`;
  }

  function renderAnalysis(data) {
    if (!panel) return;
    let analysis = data && data.analysis;
    if (typeof analysis === "string") {
      analysis = safeParseJson(analysis);
    }
    if (!analysis || typeof analysis !== "object") {
      showError("분석을 불러오지 못했습니다");
      return;
    }

    const summary = analysis.summary && typeof analysis.summary === "object" ? analysis.summary : {};
    const signal = summary.signal || "관망";
    const prob = toNum(summary.probability);
    const probText = prob == null ? "—" : `${prob}%`;

    const priceCls = chgClass(data.changeRate);
    const stockName = data.stockName || "";
    const stockCode = data.stockCode || "";

    panel.hidden = false;
    panel.innerHTML = `
      <div class="ai-analysis-stock">
        <h2 class="ai-analysis-stock__name">${escapeHtml(stockName)}</h2>
        <span class="ai-analysis-stock__code">${escapeHtml(stockCode)}</span>
        <span class="ai-analysis-stock__price ${priceCls}">${escapeHtml(fmtPrice(data.currentPrice))}원</span>
        <span class="ai-analysis-stock__chg ${priceCls}">${escapeHtml(fmtPct(data.changeRate))}</span>
      </div>
      <div class="ai-analysis-cards">
        <article class="ai-card ai-card--summary">
          <h3 class="ai-card__title"><span class="ai-card__num">1</span>한눈에 요약</h3>
          <div class="ai-card__body">
            <span class="ai-summary-badge ${signalBadgeClass(signal)}">${escapeHtml(signal)}</span>
            <div class="ai-summary-prob">
              <span class="ai-summary-prob__label">상승 확률</span>
              <span class="ai-summary-prob__value">${escapeHtml(probText)}</span>
            </div>
            <p class="ai-summary-desc">${escapeHtml(summary.description || "")}</p>
          </div>
        </article>
        <article class="ai-card">
          <h3 class="ai-card__title"><span class="ai-card__num">2</span>왜 지금 이 가격인가</h3>
          <div class="ai-card__body">${escapeHtml(analysis.story || "분석 내용이 없습니다.")}</div>
        </article>
        <article class="ai-card">
          <h3 class="ai-card__title"><span class="ai-card__num">3</span>수급 분석</h3>
          <div class="ai-card__body">${escapeHtml(analysis.supply || "수급 정보가 없습니다.")}</div>
        </article>
        <article class="ai-card">
          <h3 class="ai-card__title"><span class="ai-card__num">4</span>다가오는 이벤트</h3>
          ${renderEvents(analysis.events)}
        </article>
        <article class="ai-card">
          <h3 class="ai-card__title"><span class="ai-card__num">5</span>차트 흐름 분석</h3>
          <div class="ai-card__body">${escapeHtml(analysis.chart || "차트 분석이 없습니다.")}</div>
        </article>
        <article class="ai-card">
          <h3 class="ai-card__title"><span class="ai-card__num">6</span>AI 주관적 판단</h3>
          <div class="ai-card__body">${renderOpinion(analysis.opinion)}</div>
        </article>
        <article class="ai-card ai-card--signals">
          <h3 class="ai-card__title"><span class="ai-card__num">7</span>신호 요약</h3>
          <div class="ai-card__body">${renderSignals(analysis.signals)}</div>
        </article>
      </div>`;
  }

  async function fetchAnalysis(resolved) {
    if (!resolved || !/^\d{6}$/.test(resolved.code)) {
      throw new Error("종목을 찾을 수 없습니다");
    }
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: resolved.code, name: resolved.name }),
      cache: "no-store",
    });
    const data = safeParseJson(await res.text()) || {};
    if (!res.ok) throw new Error((data && data.error) || "분석을 불러오지 못했습니다");
    if (data && data.error) throw new Error(data.error);
    if (!data || !data.analysis) throw new Error("분석을 불러오지 못했습니다");
    return data;
  }

  async function resolveForAnalysis(qRaw) {
    await loadStockList();
    const q = String(qRaw || "").trim();
    if (!q) return null;

    const params = new URLSearchParams(window.location.search);
    const urlCode = code6Maybe(params.get("code") || "");
    const urlName = String(params.get("name") || "").trim();
    if (/^\d{6}$/.test(urlCode) && (q === urlCode || q === urlName || !params.get("q"))) {
      return { code: urlCode, name: urlName || q, query: urlName || urlCode };
    }

    return resolveQueryLocal(q);
  }

  async function runAnalysis(qRaw) {
    const q = String(qRaw || "").trim();
    if (!q) {
      if (input) input.focus();
      console.warn("[stock-analysis] runAnalysis: empty query");
      return;
    }
    if (running) {
      console.warn("[stock-analysis] runAnalysis: already running");
      return;
    }

    running = true;
    if (input) input.value = q;
    setButtonLoading(true);
    showLoading();

    try {
      const resolved = await resolveForAnalysis(q);
      if (!resolved || !/^\d{6}$/.test(resolved.code)) {
        throw new Error("종목을 찾을 수 없습니다");
      }
      const data = await fetchAnalysis(resolved);
      renderAnalysis(data);
    } catch (e) {
      showError((e && e.message) || "분석을 불러오지 못했습니다");
    } finally {
      running = false;
      setButtonLoading(false);
    }
  }

  function initialQuery() {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    const code = params.get("code");
    const name = params.get("name");
    if (q) return q;
    if (name) return name;
    if (code) return code;
    return "";
  }

  function onSubmitClick(e) {
    console.log("버튼 클릭됨");
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    runAnalysis(input ? input.value : "");
  }

  function onInputKeydown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      runAnalysis(input ? input.value : "");
    }
  }

  function onSectionClick(e) {
    const chip = e.target && e.target.closest ? e.target.closest(".ai-search-popular__chip") : null;
    if (!chip) return;
    e.preventDefault();
    runAnalysis(chip.getAttribute("data-query") || "");
  }

  function bindEvents() {
    const submitEl = document.getElementById("ai-stock-submit");
    console.log("[stock-analysis] bindEvents", {
      btnRef: !!btn,
      submitEl: !!submitEl,
      panel: !!panel,
      input: !!input,
      readyState: document.readyState,
    });

    submitEl?.addEventListener("click", () => {
      console.log("버튼 클릭됨");
    });

    if (btn) {
      btn.addEventListener("click", onSubmitClick);
    } else if (submitEl) {
      btn = submitEl;
      submitEl.addEventListener("click", onSubmitClick);
    }

    if (input) {
      input.addEventListener("keydown", onInputKeydown);
    }

    const section = document.getElementById("ai-stock-analysis");
    if (section) {
      section.addEventListener("click", onSectionClick);
    }

    document.addEventListener(
      "click",
      (e) => {
        const hit =
          e.target && e.target.closest
            ? e.target.closest("#ai-stock-submit, .ai-search-card__submit")
            : null;
        if (!hit || hit === btn) return;
        console.log("버튼 클릭됨 (delegation)");
        onSubmitClick(e);
      },
      false
    );
  }

  function init() {
    if (initialized) return;
    initialized = true;

    console.log("[stock-analysis] init start", { readyState: document.readyState });

    input = document.getElementById("ai-stock-query");
    btn = document.getElementById("ai-stock-submit");
    panel = document.getElementById("ai-analysis-panel");

    console.log("[stock-analysis] elements", {
      input: input,
      btn: btn,
      panel: panel,
      btnIsNull: btn === null,
      panelIsNull: panel === null,
    });

    if (!btn) {
      console.error("[stock-analysis] #ai-stock-submit not found — event not bound");
      return;
    }
    if (!panel) {
      console.error("[stock-analysis] #ai-analysis-panel not found — event not bound");
      return;
    }

    bindEvents();
    console.log("[stock-analysis] init complete, listeners attached");

    const boot = initialQuery();
    if (boot) {
      console.log("[stock-analysis] auto-run", boot);
      runAnalysis(boot);
    }
  }

  function bootScript() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }

  bootScript();
})();

