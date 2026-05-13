/* global document, window, fetch, WebSocket, Intl, setInterval, clearInterval, requestAnimationFrame */
(function () {
  "use strict";

  const API = "/api/kis-realtime-data";

  const CCNL_COLS = [
    "MKSC_SHRN_ISCD",
    "STCK_CNTG_HOUR",
    "STCK_PRPR",
    "PRDY_VRSS_SIGN",
    "PRDY_VRSS",
    "PRDY_CTRT",
    "WGHN_AVRG_STCK_PRC",
    "STCK_OPRC",
    "STCK_HGPR",
    "STCK_LWPR",
    "ASKP1",
    "BIDP1",
    "CNTG_VOL",
    "ACML_VOL",
    "ACML_TR_PBMN",
    "SELN_CNTG_CSNU",
    "SHNU_CNTG_CSNU",
    "NTBY_CNTG_CSNU",
    "CTTR",
    "SELN_CNTG_SMTN",
    "SHNU_CNTG_SMTN",
    "CCLD_DVSN",
    "SHNU_RATE",
    "PRDY_VOL_VRSS_ACML_VOL_RATE",
    "OPRC_HOUR",
    "OPRC_VRSS_PRPR_SIGN",
    "OPRC_VRSS_PRPR",
    "HGPR_HOUR",
    "HGPR_VRSS_PRPR_SIGN",
    "HGPR_VRSS_PRPR",
    "LWPR_HOUR",
    "LWPR_VRSS_PRPR_SIGN",
    "LWPR_VRSS_PRPR",
    "BSOP_DATE",
    "NEW_MKOP_CLS_CODE",
    "TRHT_YN",
    "ASKP_RSQN1",
    "BIDP_RSQN1",
    "TOTAL_ASKP_RSQN",
    "TOTAL_BIDP_RSQN",
    "VOL_TNRT",
    "PRDY_SMNS_HOUR_ACML_VOL",
    "PRDY_SMNS_HOUR_ACML_VOL_RATE",
    "HOUR_CLS_CODE",
    "MRKT_TRTM_CLS_CODE",
    "VI_STND_PRC",
  ];

  const MKOP_LABEL = {
    "11": "장전 동시호가",
    "21": "장중 매매",
    "31": "장종료 후 시간외",
    "41": "시간외 단일가",
    "51": "NXT 매매",
    "61": "NXT 종료",
  };

  const state = {
    tab: "cap",
    capRows: [],
    gainerRows: [],
    indexes: [],
    clockSession: null,
    marketTime: null,
    ws: null,
    wsMode: "off",
    pollRest: null,
    approvalKey: null,
    wsUrl: null,
    marketStatusWs: null,
    codesSubscribed: new Set(),
    tvWidget: null,
    tvScriptPromise: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function fmtNum(s) {
    if (s == null || s === "") return "—";
    const n = Number(String(s).replace(/,/g, ""));
    if (!Number.isFinite(n)) return String(s);
    return n.toLocaleString("ko-KR");
  }

  function fmtPct(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  }

  /** 누적 거래대금(원) → 조·억 등 */
  function formatTradeVal(raw) {
    const n = Number(String(raw == null ? "" : raw).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1e12) {
      const jo = n / 1e12;
      return `${jo.toFixed(2).replace(/\.?0+$/, "")}조`;
    }
    if (n >= 1e8) {
      return `${Math.round(n / 1e8).toLocaleString("ko-KR")}억`;
    }
    if (n >= 1e4) {
      return `${Math.round(n / 1e4).toLocaleString("ko-KR")}만`;
    }
    return n.toLocaleString("ko-KR");
  }

  function deltaClass(pct) {
    if (pct == null || !Number.isFinite(pct)) return "delta--flat";
    if (pct > 0) return "delta--pos";
    if (pct < 0) return "delta--neg";
    return "delta--flat";
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** TradingView 국내주식: 코스피 KSE:, 코스닥 KOSDAQ: */
  function tvDomesticSymbol(code, exchange) {
    const digits = String(code || "").replace(/\D/g, "");
    if (!digits) return "";
    const six = digits.length <= 6 ? digits.padStart(6, "0") : digits.slice(-6);
    const ex = exchange === "KOSDAQ" ? "KOSDAQ" : "KSE";
    return `${ex}:${six}`;
  }

  /** 시총 탭=코스피(KSE), 상승률 탭=행의 market(KOSPI|KOSDAQ) */
  function rowTvExchange(row, tab) {
    if (tab === "cap") return "KSE";
    const m = String(row && row.market ? row.market : "").toUpperCase();
    return m === "KOSDAQ" ? "KOSDAQ" : "KSE";
  }

  function loadTradingViewScript() {
    if (typeof window !== "undefined" && window.TradingView && window.TradingView.widget) {
      return Promise.resolve();
    }
    if (state.tvScriptPromise) return state.tvScriptPromise;
    state.tvScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://s3.tradingview.com/tv.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        state.tvScriptPromise = null;
        reject(new Error("TradingView 스크립트를 불러오지 못했습니다."));
      };
      document.head.appendChild(s);
    });
    return state.tvScriptPromise;
  }

  function destroyTvWidget() {
    if (state.tvWidget && typeof state.tvWidget.remove === "function") {
      try {
        state.tvWidget.remove();
      } catch (_) {
        /* ignore */
      }
    }
    state.tvWidget = null;
    const el = $("tv_chart_container");
    if (el) el.innerHTML = "";
  }

  function onChartModalKeydown(ev) {
    const modal = $("rt-chart-modal");
    if (!modal || modal.hidden) return;
    if (ev.key === "Escape") closeChartModal();
  }

  function closeChartModal() {
    destroyTvWidget();
    const modal = $("rt-chart-modal");
    if (modal) {
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onChartModalKeydown);
  }

  async function openChartModal(rawCode, displayName, tvExchange) {
    const symbol = tvDomesticSymbol(rawCode, tvExchange);
    if (!symbol) return;
    const modal = $("rt-chart-modal");
    const title = $("rt-chart-modal-title");
    const container = $("tv_chart_container");
    if (!modal || !container) return;

    destroyTvWidget();
    if (title) title.textContent = `${(displayName || "").trim() || symbol} · 차트`;

    modal.hidden = false;
    modal.removeAttribute("aria-hidden");
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onChartModalKeydown);

    try {
      await loadTradingViewScript();
    } catch (e) {
      const errEl = $("rt-error");
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = e.message || String(e);
      }
      closeChartModal();
      return;
    }

    const TV = typeof window !== "undefined" ? window.TradingView : null;
    if (!TV || typeof TV.widget !== "function") {
      const errEl = $("rt-error");
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = "TradingView 위젯 API를 사용할 수 없습니다.";
      }
      closeChartModal();
      return;
    }

    try {
      state.tvWidget = new TV.widget({
        autosize: true,
        symbol,
        interval: "D",
        timezone: "Asia/Seoul",
        theme: "dark",
        style: "1",
        locale: "kr",
        toolbar_bg: "#12100c",
        enable_publishing: false,
        allow_symbol_change: false,
        container_id: "tv_chart_container",
      });
    } catch (e) {
      const errEl = $("rt-error");
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = e.message || "차트를 열지 못했습니다.";
      }
      closeChartModal();
      return;
    }

    const closeBtn = $("rt-chart-close");
    if (closeBtn) closeBtn.focus();
  }

  function setupChartModal() {
    const tbody = $("rt-tbody");
    if (tbody) {
      tbody.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".rt-name-btn");
        if (!btn) return;
        const tr = btn.closest("tr[data-code]");
        const code = tr && tr.getAttribute("data-code");
        if (!code) return;
        ev.preventDefault();
        const exRaw = (tr.getAttribute("data-tv-exchange") || "KSE").toUpperCase();
        const tvExchange = exRaw === "KOSDAQ" ? "KOSDAQ" : "KSE";
        openChartModal(code, (btn.textContent || "").trim(), tvExchange);
      });
    }
    const modal = $("rt-chart-modal");
    if (modal) {
      modal.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-rt-chart-close]")) closeChartModal();
      });
    }
    const closeBtn = $("rt-chart-close");
    if (closeBtn) closeBtn.addEventListener("click", () => closeChartModal());
  }

  async function fetchJson(action) {
    const res = await fetch(`${API}?action=${encodeURIComponent(action)}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function parsePipeFrame(raw) {
    const s = String(raw).trim();
    if (!s.length || (s[0] !== "0" && s[0] !== "1")) return null;
    const parts = s.split("|");
    if (parts.length < 4) return null;
    const trId = parts[1];
    const payload = parts[3];
    const cells = payload.split("^");
    return { trId, cells };
  }

  function rowFromCcnl(cells) {
    const o = {};
    CCNL_COLS.forEach((k, i) => {
      o[k] = cells[i] != null ? cells[i] : "";
    });
    const code = String(o.MKSC_SHRN_ISCD || "").trim();
    const price = String(o.STCK_PRPR || "").trim();
    const changePct = Number(String(o.PRDY_CTRT || "").replace(/,/g, ""));
    const vol = String(o.ACML_VOL || "").trim();
    const tv = String(o.ACML_TR_PBMN || "").trim();
    const hourCls = String(o.HOUR_CLS_CODE || "").trim();
    const mrkt = String(o.MRKT_TRTM_CLS_CODE || "").trim();
    return {
      code,
      price,
      changePct: Number.isFinite(changePct) ? changePct : null,
      volume: vol,
      tradingValue: tv,
      hourCls,
      mrkt,
    };
  }

  function rowFromIndexCcnl(cells) {
    const pr = cells[2];
    const chg = cells[9] != null ? Number(String(cells[9]).replace(/,/g, "")) : null;
    return {
      value: pr != null ? String(pr).trim() : "",
      changePct: Number.isFinite(chg) ? chg : null,
    };
  }

  function rowFromMarketStatus(cells) {
    return {
      mkop: String(cells[3] || "").trim(),
      antc: String(cells[4] || "").trim(),
      mrkt: String(cells[5] || "").trim(),
    };
  }

  function mergeStockRow(list, patch) {
    if (!patch.code) return;
    const i = list.findIndex((r) => r.code === patch.code);
    if (i < 0) return;
    const cur = { ...list[i] };
    if (patch.price != null && patch.price !== "") cur.price = patch.price;
    if (patch.changePct != null) cur.changePct = patch.changePct;
    if (patch.volume) cur.volume = patch.volume;
    if (patch.tradingValue != null && patch.tradingValue !== "") cur.tradingValue = patch.tradingValue;
    if (patch.hourCls) cur.hourCls = patch.hourCls;
    if (patch.mrkt) cur.mrktCls = patch.mrkt;
    list[i] = cur;
  }

  function renderIndexes() {
    const el = $("rt-indexes");
    if (!el) return;
    el.innerHTML = state.indexes
      .map((ix) => {
        const ch = ix.changePct;
        const cls = deltaClass(ch);
        return `<div class="rt-index-chip">
          <span class="rt-index-chip__name">${escapeHtml(ix.label)}</span>
          <span class="rt-index-chip__val">${escapeHtml(ix.value || "—")}</span>
          <span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span>
        </div>`;
      })
      .join("");
  }

  function sessionBadge() {
    const mk = state.marketStatusWs || {};
    const clock = state.clockSession || { label: "—", detail: "" };
    let sub = clock.detail || "";
    if (mk.mkop) {
      sub = MKOP_LABEL[mk.mkop] || `운영코드 ${mk.mkop}`;
    }
    return `<span class="rt-session rt-session--${escapeHtml(clock.key || "na")}">${escapeHtml(
      clock.label || "—"
    )}</span><span class="rt-session__sub">${escapeHtml(sub)}</span>`;
  }

  function renderMeta() {
    const el = $("rt-meta");
    if (el) el.innerHTML = sessionBadge();
    const conn = $("rt-conn");
    if (conn) {
      const m =
        state.wsMode === "live"
          ? "WebSocket 실시간"
          : state.wsMode === "rest"
            ? "REST 고속 갱신"
            : "대기";
      conn.textContent = m;
    }
  }

  function renderTable() {
    const body = $("rt-tbody");
    const title = $("rt-table-title");
    if (!body) return;
    const rows = state.tab === "cap" ? state.capRows : state.gainerRows;
    if (title) {
      title.textContent =
        state.tab === "cap" ? "코스피 시가총액 상위 30" : "코스피·코스닥 통합 상승률 상위 50";
    }
    body.innerHTML = rows
      .map((r) => {
        const ch = r.changePct;
        const cls = deltaClass(ch);
        const tv = formatTradeVal(r.tradingValue);
        const vol = fmtNum(r.volume);
        const nm = escapeHtml(r.name);
        const tvEx = rowTvExchange(r, state.tab);
        return `<tr data-code="${escapeHtml(r.code)}" data-tv-exchange="${tvEx}">
          <td class="num rt-td-rank">${r.rank != null ? escapeHtml(String(r.rank)) : "—"}</td>
          <td class="rt-td-name"><button type="button" class="rt-name-btn" aria-label="${nm} 차트">${nm}</button></td>
          <td class="num rt-td-price">${escapeHtml(fmtNum(r.price))}</td>
          <td class="num rt-td-chg"><span class="delta ${cls}">${escapeHtml(fmtPct(ch))}</span></td>
          <td class="num rt-td-vol">${escapeHtml(vol)}</td>
          <td class="num rt-td-tv">${escapeHtml(tv)}</td>
        </tr>`;
      })
      .join("");
  }

  function renderAll() {
    renderIndexes();
    renderMeta();
    renderTable();
  }

  function applySnapshot(data) {
    state.clockSession = data.clock || null;
    state.marketTime = data.marketTime || null;
    state.indexes = (data.indexes || []).map((x) => ({
      id: x.id,
      label: x.label,
      value: x.value,
      changePct: x.changePct,
    }));
    state.capRows = (data.marketCap || []).map((r) => ({ ...r, tab: "cap" }));
    state.gainerRows = (data.gainers || []).map((r) => ({ ...r, tab: "gainers" }));
  }

  function makeWsPayload(trType, trId, trKey) {
    return JSON.stringify({
      header: {
        approval_key: state.approvalKey,
        custtype: "P",
        tr_type: trType,
        "content-type": "utf-8",
      },
      body: {
        input: {
          tr_id: trId,
          tr_key: trKey,
        },
      },
    });
  }

  function handleWsMessage(raw) {
    const s = String(raw).trim();
    if (s.startsWith("{")) {
      let j;
      try {
        j = JSON.parse(s);
      } catch {
        return;
      }
      const tid = j && j.header && j.header.tr_id;
      if (tid === "PINGPONG" && state.ws && state.ws.readyState === 1) {
        state.ws.send(s);
      }
      return;
    }
    const frame = parsePipeFrame(s);
    if (!frame) return;
    const { trId, cells } = frame;
    if (trId === "H0UPCNT0") {
      const p = rowFromIndexCcnl(cells);
      const ub = String(cells[0] || "").trim();
      const i1 = state.indexes.findIndex((x) => x.id === "0001");
      const i2 = state.indexes.findIndex((x) => x.id === "1001");
      if (ub === "0001" || ub === "001") {
        if (i1 >= 0 && p.value) {
          state.indexes[i1].value = p.value;
          if (p.changePct != null) state.indexes[i1].changePct = p.changePct;
        }
      } else if (ub === "1001") {
        if (i2 >= 0 && p.value) {
          state.indexes[i2].value = p.value;
          if (p.changePct != null) state.indexes[i2].changePct = p.changePct;
        }
      }
      renderIndexes();
      return;
    }
    if (trId === "H0STMKO0") {
      const st = rowFromMarketStatus(cells);
      state.marketStatusWs = st;
      renderMeta();
      return;
    }
    if (trId === "H0UNCNT0" || trId === "H0STCNT0" || trId === "H0NXCNT0") {
      const row = rowFromCcnl(cells);
      mergeStockRow(state.capRows, row);
      mergeStockRow(state.gainerRows, row);
      renderTable();
    }
  }

  function subscribeStocks(codes) {
    if (!state.ws || state.ws.readyState !== 1) return;
    const limit = state.tab === "cap" ? 30 : 50;
    const list = codes.slice(0, limit);
    for (const c of list) {
      if (state.codesSubscribed.has(c)) continue;
      state.ws.send(makeWsPayload("1", "H0UNCNT0", c));
      state.codesSubscribed.add(c);
    }
  }

  function unsubscribeAll() {
    if (!state.ws || state.ws.readyState !== 1) return;
    for (const c of state.codesSubscribed) {
      state.ws.send(makeWsPayload("0", "H0UNCNT0", c));
    }
    state.codesSubscribed.clear();
    state.ws.send(makeWsPayload("0", "H0UPCNT0", "0001"));
    state.ws.send(makeWsPayload("0", "H0UPCNT0", "1001"));
    state.ws.send(makeWsPayload("0", "H0STMKO0", "005930"));
  }

  function wireWs() {
    if (!state.wsUrl || !state.approvalKey) return;
    try {
      state.ws = new WebSocket(state.wsUrl);
    } catch (e) {
      state.wsMode = "rest";
      return;
    }
    state.ws.binaryType = "arraybuffer";
    state.ws.onopen = () => {
      state.wsMode = "live";
      state.ws.send(makeWsPayload("1", "H0UPCNT0", "0001"));
      state.ws.send(makeWsPayload("1", "H0UPCNT0", "1001"));
      state.ws.send(makeWsPayload("1", "H0STMKO0", "005930"));
      const rows = state.tab === "cap" ? state.capRows : state.gainerRows;
      subscribeStocks(rows.map((r) => r.code));
      renderMeta();
    };
    state.ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      handleWsMessage(raw);
    };
    state.ws.onerror = () => {
      state.wsMode = "rest";
      renderMeta();
    };
    state.ws.onclose = () => {
      if (state.wsMode === "live") state.wsMode = "rest";
      renderMeta();
    };
  }

  async function tryConnectWs() {
    if (location.protocol === "https:") {
      state.wsMode = "rest";
      renderMeta();
      return;
    }
    try {
      const ap = await fetchJson("approval");
      state.approvalKey = ap.approval_key;
      state.wsUrl = ap.wsUrl || "ws://ops.koreainvestment.com:21000";
      wireWs();
    } catch {
      state.wsMode = "rest";
      renderMeta();
    }
  }

  async function refreshSnapshot() {
    const data = await fetchJson("snapshot");
    applySnapshot(data);
    renderAll();
    if (state.ws && state.ws.readyState === 1) {
      unsubscribeAll();
      const rows = state.tab === "cap" ? state.capRows : state.gainerRows;
      subscribeStocks(rows.map((r) => r.code));
    }
  }

  async function refreshPartial() {
    try {
      if (state.tab === "gainers") {
        const { stocks } = await fetchJson("gainers");
        state.gainerRows = stocks.map((r) => ({ ...r, tab: "gainers" }));
      } else {
        const { stocks } = await fetchJson("market-cap");
        state.capRows = stocks.map((r) => ({ ...r, tab: "cap" }));
      }
      const { indexes } = await fetchJson("index");
      state.indexes = (indexes || []).map((x) => ({
        id: x.id,
        label: x.label,
        value: x.value,
        changePct: x.changePct,
      }));
      const { clock, marketTime } = await fetchJson("session");
      state.clockSession = clock;
      state.marketTime = marketTime;
      renderAll();
      if (state.ws && state.ws.readyState === 1) {
        unsubscribeAll();
        const rows = state.tab === "cap" ? state.capRows : state.gainerRows;
        subscribeStocks(rows.map((r) => r.code));
      }
    } catch (e) {
      const err = $("rt-error");
      if (err) {
        err.hidden = false;
        err.textContent = e.message || String(e);
      }
    }
  }

  function setupTabs() {
    document.querySelectorAll("[data-rt-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.getAttribute("data-rt-tab");
        state.tab = t === "gainers" ? "gainers" : "cap";
        document.querySelectorAll("[data-rt-tab]").forEach((b) => {
          b.setAttribute("aria-selected", b.getAttribute("data-rt-tab") === state.tab ? "true" : "false");
        });
        renderTable();
        startPolling();
        if (state.ws && state.ws.readyState === 1) {
          unsubscribeAll();
          const rows = state.tab === "cap" ? state.capRows : state.gainerRows;
          subscribeStocks(rows.map((r) => r.code));
        }
      });
    });
  }

  function startPolling() {
    if (state.pollRest) clearInterval(state.pollRest);
    state.pollRest = setInterval(() => {
      refreshPartial().catch(() => {});
    }, state.tab === "gainers" ? 5000 : 12000);
  }

  async function init() {
    setupTabs();
    setupChartModal();
    const err = $("rt-error");
    if (err) err.hidden = true;
    try {
      await refreshSnapshot();
      startPolling();
      await tryConnectWs();
    } catch (e) {
      if (err) {
        err.hidden = false;
        err.textContent = e.message || String(e);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
