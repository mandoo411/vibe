(function () {
  const RAW_BASE = "https://raw.githubusercontent.com/mandoo411/vibe/main";
  async function fetchDataJson() {
    if (typeof tmFetchJson === "function") return tmFetchJson("data/daily-market.json");
    const path = "data/daily-market.json";
    const t = Date.now();
    const urls = [`/api/repo-data?path=${encodeURIComponent(path)}&t=${t}`, `./${path}?t=${t}`, `${RAW_BASE}/${path}?t=${t}`];
    for (const url of urls) {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return res.json();
    }
    throw new Error("HTTP");
  }

  const WD_KO = ["일", "월", "화", "수", "목", "금", "토"];
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

  const AI_COPY_REPLACEMENTS = [
    [/Claude API[^\n]*/gi, "AI 분석을 준비 중입니다"],
    [/수급 데이터 기준 요약\s*\(AI 분석 대기\)/gi, "수급 현황을 불러오는 중입니다"],
    [/Claude 분석 일시 중단/gi, "분석 준비 중"],
    [/\(AI 분석 대기\)/gi, ""],
    [/KIS\+Naver\+Claude/gi, ""],
    [/KIS\+Naver\+Telegram\+Claude/gi, ""],
  ];

  const TECHNICAL_MSG_RE =
    /(?:Claude|Anthropic|OpenAI|API\s*(?:key|error|크레딧)|billing|HTTP\s*\d{3}|rt_cd|stack\s*trace|Error:|ECONNREFUSED|timeout|unavailable)/i;

  const state = {
    meta: { title: "마감시황", timezoneNote: "" },
    days: {},
    selected: null,
    mainTab: "dashboard",
    stockSubTab: "gainers",
    krTv: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    title: $("masthead-title"),
    dayPrep: $("day-prep"),
    dayPrepTitle: $("day-prep-title"),
    dayPrepHint: $("day-prep-hint"),
    dmAiContent: $("dm-ai-content"),
    dmDateSubtitle: $("dm-date-subtitle"),
    dmDateSubtitleText: $("dm-date-subtitle-text"),
    dmIndexes: $("dm-indexes"),
    dmMarketExtras: $("dm-market-extras"),
    dmAnalysis: $("dm-analysis"),
    dmFeatured: $("dm-featured"),
    dmWatchlist: $("dm-watchlist"),
    dmStockTbody: $("dm-stock-tbody"),
  };

  function seoulYmd(d = new Date()) {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }

  function addDaysYmd(ymd, n) {
    const t = new Date(ymd + "T12:00:00+09:00").getTime() + n * 86400000;
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(t));
  }

  function ymdParts(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    return { y, m, d };
  }

  function ymdWeekday(ymd) {
    if (!YMD_RE.test(ymd)) return 0;
    const d = new Date(ymd + "T12:00:00+09:00");
    const w = d.getDay();
    return Number.isFinite(w) ? w : 0;
  }

  function weekdayKo(ymd) {
    return WD_KO[ymdWeekday(ymd)] || "—";
  }

  function resolveSelectedYmd() {
    const h = (location.hash || "").replace("#", "");
    if (YMD_RE.test(h) && state.days[h]) return h;
    const keys = Object.keys(state.days || {}).sort();
    if (!keys.length) return seoulYmd();
    for (let i = keys.length - 1; i >= 0; i--) {
      if (!isDayEmpty(state.days[keys[i]])) return keys[i];
    }
    return keys[keys.length - 1];
  }
  function setDateSubtitle(ymd) {
    const text = formatClosingSubtitle(ymd);
    if (els.dmDateSubtitleText) {
      els.dmDateSubtitleText.textContent = text;
      els.dmDateSubtitleText.classList.add("is-ready");
    }
    if (els.dmDateSubtitle) els.dmDateSubtitle.dataset.date = ymd;
  }

  function formatClosingSubtitle(ymd) {
    if (!YMD_RE.test(ymd)) return "—";
    const { m, d } = ymdParts(ymd);
    return `${m}월 ${d}일 마감시황`;
  }

  function sanitizeUserCopy(v, fallback = "") {
    let t = sanitizeStr(v);
    if (!t) return fallback;
    for (const [re, rep] of AI_COPY_REPLACEMENTS) {
      t = t.replace(re, rep).trim();
    }
    if (TECHNICAL_MSG_RE.test(t)) return fallback || "AI 분석을 준비 중입니다";
    if (/^error\b/i.test(t) || (t.includes(" at ") && t.includes(".js:"))) {
      return fallback || "AI 분석을 준비 중입니다";
    }
    return t;
  }

  function headlineKo(ymd) {
    const { y, m, d } = ymdParts(ymd);
    const w = weekdayKo(ymd);
    return `${y}년 ${m}월 ${d}일 (${w})`;
  }

  function holidayName(ymd) {
    const md = String(ymd || "").slice(5);
    const fixedHolidays = {
      "01-01": "신정",
      "03-01": "삼일절",
      "05-05": "어린이날",
      "06-06": "현충일",
      "08-15": "광복절",
      "10-03": "개천절",
      "10-09": "한글날",
      "12-25": "성탄절",
    };
    return fixedHolidays[md] || "";
  }

  function marketClosedReason(ymd) {
    const day = ymdWeekday(ymd);
    if (day === 0) return "주말(일요일)";
    if (day === 6) return "주말(토요일)";
    return holidayName(ymd);
  }

  function monthLabel(ymd) {
    const { y, m } = ymdParts(ymd);
    return `${y}년 ${m}월`;
  }

  function firstOfMonth(ymd) {
    const { y, m } = ymdParts(ymd);
    return `${y}-${String(m).padStart(2, "0")}-01`;
  }

  function addMonths(ymd, n) {
    const { y, m } = ymdParts(ymd);
    const total = y * 12 + (m - 1) + n;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return `${ny}-${String(nm).padStart(2, "0")}-01`;
  }

  function daysInMonth(ymd) {
    const { y, m } = ymdParts(ymd);
    return new Date(y, m, 0).getDate();
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sanitizeStr(v) {
    return v == null ? "" : String(v).trim();
  }

  function parseChange(v) {
    if (v === "" || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function formatChange(v) {
    if (v == null || !Number.isFinite(v)) return "—";
    const sign = v > 0 ? "+" : "";
    return `${sign}${v.toFixed(2)}%`;
  }

  function deltaClass(v) {
    if (v == null || !Number.isFinite(v) || v === 0) return "delta--flat";
    return v > 0 ? "delta--pos" : "delta--neg";
  }

  function vsClass(v) {
    if (v == null || !Number.isFinite(v) || v === 0) return "";
    return v > 0 ? "rt-vs-pos" : "rt-vs-neg";
  }

  function fmtNum(s) {
    if (s == null || s === "") return "—";
    const n = Number(String(s).replace(/,/g, ""));
    if (!Number.isFinite(n)) return String(s);
    return n.toLocaleString("ko-KR");
  }

  function fmtChangeAmt(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n === 0) return "0";
    const sign = n > 0 ? "+" : "";
    return `${sign}${Math.round(n).toLocaleString("ko-KR")}`;
  }

  function calcChangeAmt(priceRaw, changePct) {
    const p = Number(String(priceRaw || "").replace(/,/g, ""));
    const c = Number(changePct);
    if (!Number.isFinite(p) || !Number.isFinite(c) || c === 0) return null;
    return Math.round((p * c) / (100 + c));
  }

  /** 거래대금(원) — realtime.html formatTradeVal 동일 */
  function formatTradeVal(raw) {
    const n = Number(String(raw == null ? "" : raw).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1e12) return `${(n / 1e12).toFixed(1)}조`;
    const eok = Math.round(n / 1e8);
    if (eok <= 0) return "—";
    if (n >= 1e11) return `${eok.toLocaleString("ko-KR")}억`;
    return `${eok}억`;
  }

  function formatStockTv(raw) {
    if (raw == null || raw === "") return "—";
    const s = String(raw).trim();
    if (/[억조]/.test(s)) return s;
    return formatTradeVal(s);
  }

  function parseTvSortValue(raw) {
    if (raw == null || raw === "") return 0;
    const s = String(raw).trim();
    const jo = s.match(/([\d,.]+)\s*조/);
    if (jo) return Number(jo[1].replace(/,/g, "")) * 1e12;
    const eok = s.match(/([\d,.]+)\s*억/);
    if (eok) return Number(eok[1].replace(/,/g, "")) * 1e8;
    const n = Number(s.replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
  }

  function renderMarkdownBold(text) {
    const safe = escapeHtml(sanitizeUserCopy(text, ""));
    return safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function getDay(ymd) {
    return state.days[ymd] || null;
  }

  function getDayDateYmd(day, fallbackYmd) {
    const raw = sanitizeStr(day && day.date);
    if (YMD_RE.test(raw)) return raw;
    if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    return fallbackYmd;
  }

  function isDayEmpty(day) {
    if (!day || typeof day !== "object") return true;
    const hasSummary = sanitizeStr(day.analysis || day.summary).length > 0;
    const hasArr = (k) => Array.isArray(day[k]) && day[k].length > 0;
    const hasMeaningfulTopGainers =
      Array.isArray(day.topGainers) &&
      day.topGainers.length > 0 &&
      day.topGainers.some((s) => {
        const chg = parseChange(s && s.change);
        return chg != null && chg !== 0;
      });
    const hasHeadline = sanitizeStr(day.headlineIssue).length > 0;
    return !(
      hasHeadline ||
      hasSummary ||
      hasArr("indexes") ||
      hasArr("marketExtras") ||
      hasArr("featured_stocks") ||
      hasArr("issueStocks") ||
      hasArr("watchlist") ||
      hasArr("tomorrowCheckpoints") ||
      hasMeaningfulTopGainers ||
      hasArr("topDecliners") ||
      hasArr("topLosers") ||
      hasArr("topTradingValue")
    );
  }

  function getFeaturedStocks(day) {
    if (!day) return [];
    if (Array.isArray(day.featured_stocks) && day.featured_stocks.length) return day.featured_stocks;
    if (Array.isArray(day.issueStocks) && day.issueStocks.length) return day.issueStocks;
    return [];
  }

  function getWatchlist(day) {
    if (!day) return [];
    if (Array.isArray(day.watchlist) && day.watchlist.length) return day.watchlist;
    if (Array.isArray(day.tomorrowCheckpoints) && day.tomorrowCheckpoints.length) return day.tomorrowCheckpoints;
    return [];
  }

  function normalizeKrTvRow(r, i) {
    return {
      rank: r.rank != null ? r.rank : i + 1,
      name: r.name || r.code || "—",
      currentPrice: r.price != null ? r.price : r.currentPrice,
      change: r.changePct != null ? r.changePct : r.change,
      prevDelta: r.changeAmt != null ? r.changeAmt : r.prevDelta,
      tradingValue: r.tradingValue,
      code: r.code,
    };
  }

  function getStockRows(day, subTab) {
    if (!day) return [];
    let rows = [];
    if (subTab === "gainers") {
      rows = Array.isArray(day.topGainers) ? [...day.topGainers] : [];
      rows.sort((a, b) => (parseChange(b.change) || 0) - (parseChange(a.change) || 0));
    } else if (subTab === "losers") {
      rows = Array.isArray(day.topDecliners)
        ? [...day.topDecliners]
        : Array.isArray(day.topLosers)
          ? [...day.topLosers]
          : [];
      rows.sort((a, b) => (parseChange(a.change) || 0) - (parseChange(b.change) || 0));
    } else if (subTab === "tv") {
      if (state.krTv && state.krTv.length) {
        rows = state.krTv.map(normalizeKrTvRow);
      } else if (Array.isArray(day.topTradingValue) && day.topTradingValue.length) {
        rows = [...day.topTradingValue];
      } else if (Array.isArray(day.volumeLeaders) && day.volumeLeaders.length) {
        rows = day.volumeLeaders.map((r, i) => ({
          rank: i + 1,
          name: r.name,
          currentPrice: r.currentPrice || r.price,
          change: r.change,
          prevDelta: r.prevDelta,
          tradingValue: r.tradingValue,
        }));
      }
      rows.sort((a, b) => parseTvSortValue(b.tradingValue) - parseTvSortValue(a.tradingValue));
    }
    return rows.slice(0, 30).map((r, i) => ({ ...r, rank: r.rank != null ? r.rank : i + 1 }));
  }

  function setMainTab(tabId) {
    state.mainTab = tabId;
    document.querySelectorAll("[data-dm-tab]").forEach((btn) => {
      const on = btn.dataset.dmTab === tabId;
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll("[data-dm-panel]").forEach((panel) => {
      const on = panel.dataset.dmPanel === tabId;
      panel.hidden = !on;
      panel.classList.toggle("is-active", on);
    });
  }

  function setStockSubTab(subTab) {
    state.stockSubTab = subTab;
    document.querySelectorAll("[data-dm-stock]").forEach((btn) => {
      const on = btn.dataset.dmStock === subTab;
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    renderStockTable();
  }

  function renderIndexes(arr) {
    if (!Array.isArray(arr) || !arr.length) {
      return '<p class="empty-line">데이터 없음</p>';
    }
    return arr
      .map((row) => {
        const name = escapeHtml(row && row.name);
        const value = escapeHtml(row && row.value != null ? row.value : "");
        const chg = parseChange(row && row.change);
        const chgHtml = chg == null
          ? ""
          : `<span class="delta ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span>`;
        const tv = row && row.tradingValue ? `<small class="dm-index-card__tv">거래대금 ${escapeHtml(row.tradingValue)}</small>` : "";
        return `<div class="dm-index-card">
          <span class="dm-index-card__name">${name}</span>
          <span class="dm-index-card__value">${value || "—"}</span>
          ${chgHtml}
          ${tv}
        </div>`;
      })
      .join("");
  }

  function renderMarketExtras(arr) {
    if (!Array.isArray(arr) || !arr.length) {
      return '<p class="empty-line">데이터 없음</p>';
    }
    return arr
      .map((row) => {
        const chg = parseChange(row && row.changePct);
        const comment = sanitizeStr(row && row.comment);
        return `<div class="dm-index-card dm-index-card--extra">
          <span class="dm-index-card__name">${escapeHtml(row && row.label)}</span>
          <span class="dm-index-card__value">${escapeHtml((row && row.valueFormatted) || (row && row.value) || "—")}</span>
          ${chg == null ? "" : `<span class="delta ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span>`}
          ${comment ? `<small class="dm-index-card__note">${escapeHtml(comment)}</small>` : ""}
        </div>`;
      })
      .join("");
  }

  function renderFeatured(arr) {
    if (!Array.isArray(arr) || !arr.length) {
      return '<p class="empty-line">특징주 분석 없음</p>';
    }
    return arr
      .map((row) => {
        const chg = parseChange(row.change);
        const isUp = row.type === "급등" || (row.type !== "급락" && (chg == null || chg >= 0));
        const badgeClass = isUp ? "dm-badge--up" : "dm-badge--down";
        const badgeLabel = isUp ? "급등종목" : "급락종목 ⚠️";
        const reason = sanitizeUserCopy(row.reason || row.entryReason, "");
        const point = sanitizeUserCopy(row.point || row.background, "");
        return `<article class="dm-featured-card">
          <header class="dm-featured-card__head">
            <div class="dm-featured-card__title">
              <span class="dm-badge ${badgeClass}">${badgeLabel}</span>
              <strong class="dm-featured-card__name">${escapeHtml(row.name)}</strong>
            </div>
            <span class="delta ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span>
          </header>
          ${reason ? `<p class="dm-featured-card__reason"><em>재료</em> ${escapeHtml(reason)}</p>` : ""}
          ${point ? `<p class="dm-featured-card__point"><em>투자포인트</em> ${escapeHtml(point)}</p>` : ""}
        </article>`;
      })
      .join("");
  }

  function renderWatchlist(arr) {
    if (!Array.isArray(arr) || !arr.length) {
      return '<li class="empty-line">내일 주목할 변수 없음</li>';
    }
    return arr.map((p) => `<li>${escapeHtml(sanitizeUserCopy(p))}</li>`).join("");
  }

  function renderStockTable() {
    const day = getDay(state.selected);
    const rows = getStockRows(day, state.stockSubTab);
    const tbody = els.dmStockTbody;
    if (!tbody) return;

    if (!rows.length) {
      const label =
        state.stockSubTab === "gainers"
          ? "상승률"
          : state.stockSubTab === "losers"
            ? "하락률"
            : "거래대금";
      tbody.innerHTML = `<tr><td colspan="6" class="dm-stock-empty">${label} TOP30 데이터 준비중</td></tr>`;
      return;
    }

    tbody.innerHTML = rows
      .map((r) => {
        const chg = parseChange(r.change != null ? r.change : r.changePct);
        const vsAmt = r.prevDelta != null ? Number(r.prevDelta) : calcChangeAmt(r.currentPrice, chg);
        const vsCls = vsClass(vsAmt);
        return `<tr>
          <td class="num rt-td-rank">${escapeHtml(r.rank != null ? String(r.rank) : "—")}</td>
          <td class="rt-td-name"><span class="rt-name-text">${escapeHtml(r.name)}</span></td>
          <td class="num rt-td-price">${escapeHtml(fmtNum(r.currentPrice))}</td>
          <td class="num rt-td-vs"><span class="${escapeHtml(vsCls)}">${escapeHtml(fmtChangeAmt(vsAmt))}</span></td>
          <td class="num rt-td-chg"><span class="delta ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span></td>
          <td class="num rt-td-tv">${escapeHtml(formatStockTv(r.tradingValue))}</td>
        </tr>`;
      })
      .join("");
  }

  function render() {
    const ymd = state.selected;
    const day = getDay(ymd);
    const empty = isDayEmpty(day);
    const displayYmd = getDayDateYmd(day, ymd);

    if (els.title) els.title.textContent = "마감시황";
    setDateSubtitle(displayYmd);

    try {
      document.title = `${state.meta.title || "마감시황"} · ${headlineKo(displayYmd)}`;
    } catch (_) {
      /* ignore */
    }

    if (els.dayPrep) {
      els.dayPrep.hidden = !empty;
      if (empty && els.dayPrepTitle) {
        const closedReason = marketClosedReason(ymd);
        els.dayPrepTitle.textContent = closedReason
          ? `${closedReason} 휴장입니다`
          : "오늘의 시황을 준비하고 있어요";
        if (els.dayPrepHint) {
          els.dayPrepHint.textContent = closedReason
            ? "국내 증시가 열리지 않아 장마감 리포트가 생성되지 않습니다."
            : "장 마감 후 자동으로 업데이트됩니다";
        }
      }
    }
    if (els.dmAiContent) els.dmAiContent.hidden = empty;

    if (empty) {
      if (els.dmIndexes) els.dmIndexes.innerHTML = "";
      if (els.dmMarketExtras) els.dmMarketExtras.innerHTML = "";
      if (els.dmAnalysis) els.dmAnalysis.innerHTML = "";
      if (els.dmFeatured) els.dmFeatured.innerHTML = "";
      if (els.dmWatchlist) els.dmWatchlist.innerHTML = "";
      if (els.dmStockTbody) els.dmStockTbody.innerHTML = "";
    } else {
      if (els.dmIndexes) els.dmIndexes.innerHTML = renderIndexes(day && day.indexes);
      if (els.dmMarketExtras) els.dmMarketExtras.innerHTML = renderMarketExtras(day && day.marketExtras);
      if (els.dmAnalysis) {
        const analysisText = sanitizeUserCopy(day.analysis || day.summary, "AI 분석을 준비 중입니다");
        els.dmAnalysis.innerHTML = analysisText
          ? `<div class="dm-analysis__body">${renderMarkdownBold(analysisText)}</div>`
          : '<p class="empty-line">종합분석 없음</p>';
      }
      if (els.dmFeatured) els.dmFeatured.innerHTML = renderFeatured(getFeaturedStocks(day));
      if (els.dmWatchlist) els.dmWatchlist.innerHTML = renderWatchlist(getWatchlist(day));
      renderStockTable();
    }
  }

  function bindEvents() {
    document.querySelectorAll("[data-dm-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setMainTab(btn.dataset.dmTab));
    });

    document.querySelectorAll("[data-dm-stock]").forEach((btn) => {
      btn.addEventListener("click", () => setStockSubTab(btn.dataset.dmStock));
    });

    document.querySelectorAll("[data-dm-supply]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-dm-supply]").forEach((b) => {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-selected", on ? "true" : "false");
        });
      });
    });

    window.addEventListener("hashchange", () => {
      const h = (location.hash || "").replace("#", "");
      if (YMD_RE.test(h) && h !== state.selected && state.days[h]) {
        state.selected = h;
        render();
      }
    });
  }

  async function loadKrTv() {
    try {
      const kr = typeof tmFetchJson === "function"
        ? await tmFetchJson("data/kr-realtime.json")
        : await (async () => {
            const res = await fetch(`./data/kr-realtime.json?t=${Date.now()}`, { cache: "no-store" });
            if (!res.ok) throw new Error("kr-realtime");
            return res.json();
          })();
      if (kr && kr.tabs && Array.isArray(kr.tabs.tv)) {
        state.krTv = kr.tabs.tv;
      }
    } catch (e) {
      console.warn("kr-realtime 거래대금 데이터 불러오기 실패:", e);
    }
  }

  async function loadData() {
    try {
      const raw = await fetchDataJson();
      if (raw && raw.meta) {
        state.meta = { ...state.meta, ...raw.meta };
        if (state.meta.title === "장마감 리포트") state.meta.title = "마감시황";
      }
      if (raw && raw.days && typeof raw.days === "object") state.days = raw.days;
    } catch (e) {
      console.warn("daily-market.json 불러오기 실패:", e);
    }
  }

  async function main() {
    await Promise.all([loadData(), loadKrTv()]);
    state.selected = resolveSelectedYmd();
    bindEvents();
    setMainTab(state.mainTab);
    setStockSubTab(state.stockSubTab);
    render();
  }

  main();
})();
