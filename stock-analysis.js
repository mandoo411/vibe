(function () {
  "use strict";

  let input = null;
  let btn = null;
  let panel = null;
  let stockList = [];
  let running = false;
  let loadingTimer = null;

  const LOADING_STEPS = [
    "KIS 시세 불러오는 중...",
    "최신 뉴스 검색 중...",
    "AI가 분석하는 중...",
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
      "차트 흐름 분석",
      "AI 주관적 판단",
      "신호 요약",
    ];
    return titles
      .map((title, i) => {
        const extra = i === 0 || i === 6 ? " ai-card--summary" : "";
        const sig = i === 6 ? " ai-card--signals" : "";
        return `<article class="ai-card is-skeleton${extra}${sig}"><h3 class="ai-card__title"><span class="ai-card__num">${i + 1}</span>${escapeHtml(title)}</h3><div class="ai-card__body">${skelBody}</div></article>`;
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

  function showLoading() {
    if (!panel) return;
    clearLoadingTimer();
    panel.hidden = false;
    let step = 0;
    panel.innerHTML =
      '<div class="ai-analysis-status" role="status" aria-live="polite">' +
      '<span class="ai-analysis-status__spinner" aria-hidden="true"></span>' +
      `<span id="ai-loading-msg">${escapeHtml(LOADING_STEPS[0])}</span></div>` +
      `<div class="ai-analysis-cards">${skeletonCardsHtml()}</div>`;
    loadingTimer = setInterval(() => {
      step = (step + 1) % LOADING_STEPS.length;
      updateLoadingMessage(LOADING_STEPS[step]);
    }, 2500);
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

  function renderOpinion(op) {
    const o = op && typeof op === "object" ? op : {};
    const rows = [
      ["단기", o.short],
      ["중기", o.mid],
      ["장기", o.long],
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
    const comment = o.comment ? `<div class="ai-opinion-comment">"${escapeHtml(o.comment)}"</div>` : "";
    return `<div class="ai-opinion-grid">${rows || "<p>시나리오 정보가 없습니다.</p>"}</div><div class="ai-opinion-prices">${prices}</div>${comment}`;
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
        <article class="ai-card"><h3 class="ai-card__title"><span class="ai-card__num">5</span>차트 흐름 분석</h3><div class="ai-card__body">${escapeHtml(analysis.chart || "차트 분석이 없습니다.")}</div></article>
        <article class="ai-card"><h3 class="ai-card__title"><span class="ai-card__num">6</span>AI 주관적 판단</h3><div class="ai-card__body">${renderOpinion(analysis.opinion)}</div></article>
        <article class="ai-card ai-card--signals"><h3 class="ai-card__title"><span class="ai-card__num">7</span>신호 요약</h3><div class="ai-card__body">${renderSignals(analysis.signals)}</div></article>
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

    running = true;
    if (input) input.value = q;
    setButtonLoading(true);
    showLoading();

    try {
      const resolved = await resolveForAnalysis(q);
      if (!resolved || !/^\d{6}$/.test(resolved.code)) {
        throw new Error("종목을 찾을 수 없습니다. 한국 상장 종목명 또는 6자리 코드를 입력해 주세요.");
      }

      const data = await fetchAnalysis(resolved.code, resolved.name);
      renderAnalysis(data);
    } catch (err) {
      console.error("[AI분석] 실패", err);
      showError((err && err.message) || "분석을 불러오지 못했습니다");
    } finally {
      clearLoadingTimer();
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
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onAnalyzeClick();
        }
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
