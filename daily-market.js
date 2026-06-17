/* global document, window */
(function () {
  "use strict";

  const state = {
    day: null,
    dayKey: "",
    krTv: null, // kr-realtime tabs.tv (거래대금 실데이터)
    activeTab: "dashboard",
    flowMarket: "kospi",
    dualMode: "buy",
    quoteType: "gainers",
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toNum(v) {
    if (v == null) return null;
    const n = Number(String(v).replace(/,/g, "").replace(/[^\d.+-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function fmtPct(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
  }

  function deltaClass(n) {
    if (n == null || !Number.isFinite(n)) return "";
    return n > 0 ? "dm-up" : n < 0 ? "dm-down" : "";
  }

  // 원 단위 큰 금액 → 조/억 포맷
  function fmtWon(v) {
    const n = toNum(v);
    if (n == null || n === 0) return "—";
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2).replace(/\.?0+$/, "")}조`;
    if (abs >= 1e8) return `${sign}${Math.round(abs / 1e8).toLocaleString()}억`;
    if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString()}만`;
    return `${sign}${Math.round(abs).toLocaleString()}`;
  }

  function fmtPrice(v) {
    const n = toNum(v);
    if (n == null) return "—";
    return `${n.toLocaleString()}원`;
  }

  function emptyCard(msg) {
    return `<div class="dm-card dm-card--empty"><i class="ti ti-clock-hour-4" aria-hidden="true"></i><p class="dm-empty">${esc(msg)}</p></div>`;
  }

  /* ---------------- 대시보드 ---------------- */

  function renderIndexes() {
    const host = $("dm-indexes");
    if (!host) return;
    const rows = (state.day && state.day.indexes) || [];
    if (!rows.length) {
      host.innerHTML = emptyCard("지수 데이터 준비 중");
      return;
    }
    host.innerHTML = rows
      .map((r) => {
        const val = toNum(r.value);
        const pct = toNum(r.change);
        let diff = null;
        if (val != null && pct != null && pct !== -100) {
          const prev = val / (1 + pct / 100);
          diff = val - prev;
        }
        const cls = deltaClass(pct);
        const diffStr = diff == null ? "" : `${diff > 0 ? "▲" : diff < 0 ? "▼" : ""} ${Math.abs(diff).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
        return `<div class="dm-card dm-card--index">
          <div class="dm-card__label">${esc(r.name)}</div>
          <div class="dm-card__value ${cls}">${esc(r.value)}</div>
          <div class="dm-card__delta ${cls}">${esc(diffStr)} <span>${esc(fmtPct(pct))}</span></div>
        </div>`;
      })
      .join("");
  }

  function renderFunds() {
    const host = $("dm-funds");
    if (!host) return;
    const f = state.day && state.day.marketFunds;
    if (!f || (!f.customerDeposit && !f.creditLoan)) {
      host.innerHTML = emptyCard("증시자금(고객예탁금·신용융자) 데이터 준비 중");
      return;
    }
    const card = (label, obj) => {
      const v = obj && obj.value;
      const c = obj && toNum(obj.change);
      const cls = deltaClass(c);
      return `<div class="dm-card">
        <div class="dm-card__label">${esc(label)}</div>
        <div class="dm-card__value">${esc(fmtWon(v))}</div>
        <div class="dm-card__delta ${cls}">전일대비 ${esc(fmtWon(c))}</div>
      </div>`;
    };
    host.innerHTML = card("고객예탁금", f.customerDeposit) + card("신용융자잔고", f.creditLoan);
  }

  function renderFlow() {
    const host = $("dm-flow");
    if (!host) return;
    const flow = state.day && state.day.investorFlow && state.day.investorFlow[state.flowMarket];
    if (!flow) {
      host.innerHTML = emptyCard("매매주체별 순매수 데이터 준비 중");
      return;
    }
    const card = (label, amt) => {
      const n = toNum(amt);
      const cls = deltaClass(n);
      return `<div class="dm-card dm-card--flow">
        <div class="dm-card__label">${esc(label)}</div>
        <div class="dm-card__value ${cls}">${esc(fmtWon(amt))}</div>
        <div class="dm-card__sub">순매수</div>
      </div>`;
    };
    host.innerHTML = card("외국인", flow.foreign) + card("기관", flow.institution) + card("개인", flow.individual);
  }

  // 외국인/기관 종목별 순매수 리스트의 교집합 Top5 (프론트엔드 계산)
  function computeDual(mode) {
    const day = state.day || {};
    const fList = (mode === "buy" ? day.foreignNetBuy : day.foreignNetSell) || [];
    const iList = (mode === "buy" ? day.instNetBuy : day.instNetSell) || [];
    if (!fList.length || !iList.length) return null;
    const keyOf = (r) => String(r.code || r.name || "").toUpperCase();
    const iMap = new Map(iList.map((r) => [keyOf(r), r]));
    const rows = [];
    for (const f of fList) {
      const hit = iMap.get(keyOf(f));
      if (!hit) continue;
      const fa = toNum(f.amount) || 0;
      const ia = toNum(hit.amount) || 0;
      rows.push({ name: f.name || hit.name, foreign: fa, inst: ia, sum: fa + ia });
    }
    rows.sort((a, b) => (mode === "buy" ? b.sum - a.sum : a.sum - b.sum));
    return rows.slice(0, 5);
  }

  function renderDual() {
    const host = $("dm-dual");
    if (!host) return;
    const rows = computeDual(state.dualMode);
    if (!rows || !rows.length) {
      host.innerHTML = `<tbody><tr><td class="dm-empty" colspan="4">기관·외국인 종목별 순매매 데이터 준비 중</td></tr></tbody>`;
      return;
    }
    const cls = state.dualMode === "buy" ? "dm-up" : "dm-down";
    host.innerHTML =
      `<thead><tr><th>종목</th><th class="num">외국인</th><th class="num">기관</th><th class="num">합계</th></tr></thead><tbody>` +
      rows
        .map(
          (r) => `<tr>
            <td>${esc(r.name)}</td>
            <td class="num ${cls}">${esc(fmtWon(r.foreign))}</td>
            <td class="num ${cls}">${esc(fmtWon(r.inst))}</td>
            <td class="num ${cls}">${esc(fmtWon(r.sum))}</td>
          </tr>`
        )
        .join("") +
      `</tbody>`;
  }

  function renderExtras() {
    const host = $("dm-extras");
    if (!host) return;
    const rows = (state.day && state.day.marketExtras) || [];
    if (!rows.length) {
      host.innerHTML = emptyCard("원자재·환율 데이터 준비 중");
      return;
    }
    host.innerHTML = rows
      .map((r) => {
        const cls = deltaClass(toNum(r.changePct));
        const pct = r.changePct == null ? "" : fmtPct(toNum(r.changePct));
        return `<div class="dm-card dm-card--extra">
          <div class="dm-card__label">${esc(r.label)}</div>
          <div class="dm-card__value">${esc(r.valueFormatted ?? r.value)}</div>
          <div class="dm-card__delta ${cls}">${esc(pct)}</div>
        </div>`;
      })
      .join("");
  }

  /* ---------------- AI 시황분석 ---------------- */

  function renderAI() {
    const day = state.day || {};
    const headline = $("dm-headline");
    if (headline) headline.textContent = day.headlineIssue || "";
    const summary = $("dm-summary");
    if (summary) {
      const text = day.summary || "AI 시황 요약을 준비 중입니다.";
      summary.innerHTML = String(text)
        .split(/\n{2,}|\n/)
        .filter(Boolean)
        .map((p) => `<p>${esc(p)}</p>`)
        .join("");
    }
    const verdict = $("dm-verdict");
    if (verdict) verdict.textContent = day.oneLineVerdict || "";

    const issuesHost = $("dm-issues");
    if (issuesHost) {
      const issues = (day.issueStocks && day.issueStocks.length ? day.issueStocks : day.notableStocks) || [];
      if (!issues.length) {
        issuesHost.innerHTML = `<p class="dm-empty">특징주 데이터 준비 중</p>`;
      } else {
        issuesHost.innerHTML = issues
          .map((s) => {
            const c = toNum(s.change);
            const cls = deltaClass(c);
            const desc = s.background || s.note || s.entryReason || "";
            return `<div class="dm-issue">
              <div class="dm-issue__head">
                <span class="dm-issue__name">${esc(s.name)}</span>
                <span class="dm-issue__chg ${cls}">${esc(fmtPct(c))}</span>
              </div>
              ${s.entryReason ? `<div class="dm-issue__tag">${esc(s.entryReason)}</div>` : ""}
              ${desc ? `<p class="dm-issue__desc">${esc(desc)}</p>` : ""}
            </div>`;
          })
          .join("");
      }
    }
  }

  /* ---------------- 종목시세 ---------------- */

  function quoteRows(type) {
    const day = state.day || {};
    if (type === "gainers") return (day.topGainers || []).slice(0, 30);
    if (type === "losers") return (day.topDecliners || []).slice(0, 30);
    if (type === "value") {
      if (state.krTv && state.krTv.length) return state.krTv.slice(0, 30);
      return (day.volumeLeaders || []).slice(0, 30);
    }
    return [];
  }

  function renderQuotes() {
    const host = $("dm-quotes");
    if (!host) return;
    const type = state.quoteType;
    const rows = quoteRows(type);
    if (!rows.length) {
      const labels = { gainers: "상승률", losers: "하락률", value: "거래대금" };
      host.innerHTML = `<tbody><tr><td class="dm-empty" colspan="5">${esc(labels[type] || "")} TOP30 데이터 준비 중</td></tr></tbody>`;
      return;
    }
    host.innerHTML =
      `<thead><tr><th class="num">순위</th><th>종목명</th><th class="num">현재가</th><th class="num">등락률</th><th class="num">거래대금</th></tr></thead><tbody>` +
      rows
        .map((r, i) => {
          const rank = r.rank != null ? r.rank : i + 1;
          const name = r.name || r.code || "—";
          const price = fmtPrice(r.currentPrice != null ? r.currentPrice : r.price);
          const chg = toNum(r.change != null ? r.change : r.changePct);
          const cls = deltaClass(chg);
          const tv = fmtWon(r.tradingValue);
          return `<tr>
            <td class="num dm-rank">${esc(String(rank))}</td>
            <td class="dm-qname">${esc(name)}</td>
            <td class="num">${esc(price)}</td>
            <td class="num ${cls}">${esc(fmtPct(chg))}</td>
            <td class="num">${esc(tv)}</td>
          </tr>`;
        })
        .join("") +
      `</tbody>`;
  }

  /* ---------------- 탭 전환 ---------------- */

  function showTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll("[data-dm-tab]").forEach((b) => {
      b.setAttribute("aria-selected", b.getAttribute("data-dm-tab") === tab ? "true" : "false");
    });
    [["dashboard", "dm-panel-dashboard"], ["ai", "dm-panel-ai"], ["quotes", "dm-panel-quotes"]].forEach(([t, id]) => {
      const el = $(id);
      if (el) el.hidden = t !== tab;
    });
  }

  function wireTabs() {
    document.querySelectorAll("[data-dm-tab]").forEach((btn) => {
      btn.addEventListener("click", () => showTab(btn.getAttribute("data-dm-tab")));
    });
    document.querySelectorAll("[data-dm-flow]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.flowMarket = btn.getAttribute("data-dm-flow");
        document.querySelectorAll("[data-dm-flow]").forEach((b) => b.setAttribute("aria-selected", b === btn ? "true" : "false"));
        renderFlow();
      });
    });
    document.querySelectorAll("[data-dm-dual]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.dualMode = btn.getAttribute("data-dm-dual");
        document.querySelectorAll("[data-dm-dual]").forEach((b) => b.setAttribute("aria-selected", b === btn ? "true" : "false"));
        renderDual();
      });
    });
    document.querySelectorAll("[data-dm-quote]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.quoteType = btn.getAttribute("data-dm-quote");
        document.querySelectorAll("[data-dm-quote]").forEach((b) => b.setAttribute("aria-selected", b === btn ? "true" : "false"));
        renderQuotes();
      });
    });
  }

  function renderAll() {
    renderIndexes();
    renderFunds();
    renderFlow();
    renderDual();
    renderExtras();
    renderAI();
    renderQuotes();
  }

  async function loadJson(path) {
    if (typeof window.tmFetchJson === "function") return window.tmFetchJson(path);
    const res = await fetch(`./${path}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  }

  async function init() {
    wireTabs();
    showTab("dashboard");
    const errEl = $("dm-error");
    try {
      const data = await loadJson("data/daily-market.json");
      const days = (data && data.days) || {};
      const keys = Object.keys(days).sort();
      const key = keys[keys.length - 1];
      state.day = key ? days[key] : null;
      state.dayKey = key || "";
      const dateEl = $("dm-date");
      if (dateEl) dateEl.textContent = key ? `${key} 마감 기준` : "";
      const updEl = $("dm-updated");
      if (updEl) updEl.textContent = state.day && state.day.topGainersUpdatedAt ? `업데이트 ${state.day.topGainersUpdatedAt}` : "";
      if (!state.day) throw new Error("표시할 마감 데이터가 없습니다.");
    } catch (e) {
      console.error("[daily-market]", e);
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = e && e.message ? e.message : "데이터를 불러오지 못했습니다.";
      }
    }
    // 거래대금 실데이터(kr-realtime tabs.tv) — 베스트에포트
    try {
      const kr = await loadJson("data/kr-realtime.json");
      if (kr && kr.tabs && Array.isArray(kr.tabs.tv)) state.krTv = kr.tabs.tv;
    } catch (e) {
      /* 없으면 day.volumeLeaders 폴백 */
    }
    renderAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
