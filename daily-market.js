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

  async function fetchArchiveDayJson(ymd) {
    const path = `data/daily/${ymd}.json`;
    const t = Date.now();
    const urls = [`/api/repo-data?path=${encodeURIComponent(path)}&t=${t}`, `./${path}?t=${t}`, `${RAW_BASE}/${path}?t=${t}`];
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) return res.json();
      } catch (_) {
        /* try next */
      }
    }
    return null;
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

  const STOCK_TABS = ["gainers", "losers", "tv"];
  const KIS_RT_API = "/api/kis-realtime-data";
  const LIVE_FETCH_TIMEOUT_MS = 15000;
  const LIVE_TOP_N = 30;

  /** 저장된 거래대금 TOP이 거래량순위 오염 등으로 대형주가 빠진 경우 */
  function isTopTradingValueLikelyWrong(rows) {
    if (!Array.isArray(rows) || rows.length < 8) return true;
    const codes = new Set(
      rows.slice(0, 15).map((r) => String((r && r.code) || "").replace(/\D/g, "").padStart(6, "0").slice(-6))
    );
    return !codes.has("005930") && !codes.has("000660");
  }

  function hasValidTopTradingValue(day) {
    const rows = day && day.topTradingValue;
    return Array.isArray(rows) && rows.length > 0 && !isTopTradingValueLikelyWrong(rows);
  }

  let liveLoadPromise = null;
  const mcapCacheByCode = new Map();
  let mcapEnrichGen = 0;

  const state = {
    meta: { title: "마감시황", timezoneNote: "" },
    jsonDate: null,
    days: {},
    selected: null,
    todayYmd: null,
    defaultYmd: null,
    missingYmd: null,
    liveMode: false,
    liveRowsByTab: { gainers: [], losers: [], tv: [] },
    mainTab: "ai",
    stockSubTab: "gainers",
    krTv: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    title: $("masthead-title"),
    dmAiContent: $("dm-ai-content"),
    dmAnalysis: $("dm-analysis"),
    dmFeatured: $("dm-featured"),
    dmWatchlist: $("dm-watchlist"),
    dmStockTbody: $("dm-stock-tbody"),
    dmStockThead: $("dm-stock-thead-row"),
    dmStockHeaderRow: $("dm-stock-header-row"),
    dmStockTable: $("dm-stock-table"),
    dmPreparing: $("dm-preparing"),
    dmPreparingTitle: $("dm-preparing-title"),
    dmPreparingHint: $("dm-preparing-hint"),
    dmTabBar: $("dm-tab-bar"),
    dmTabsRow: $("dm-tabs-row"),
    dmTabPanels: $("dm-tab-panels"),
    dmDateLabel: $("dm-date-label"),
    dmDatePrev: $("dm-date-prev"),
    dmDateNext: $("dm-date-next"),
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

  function isWeekendYmd(ymd) {
    const w = ymdWeekday(ymd);
    return w === 0 || w === 6;
  }

  function skipWeekendPrev(ymd) {
    let d = addDaysYmd(ymd, -1);
    while (isWeekendYmd(d)) d = addDaysYmd(d, -1);
    return d;
  }

  function skipWeekendNext(ymd) {
    let d = addDaysYmd(ymd, 1);
    while (isWeekendYmd(d)) d = addDaysYmd(d, 1);
    return d;
  }

  function shortDateLabel(ymd) {
    if (!YMD_RE.test(ymd)) return "—";
    const { m, d } = ymdParts(ymd);
    return `${m}월 ${d}일 (${weekdayKo(ymd)})`;
  }

  function latestPublishedYmd() {
    const today = state.todayYmd || seoulYmd();
    const keys = Object.keys(state.days || {})
      .filter((k) => YMD_RE.test(k) && k <= today)
      .sort();
    for (let i = keys.length - 1; i >= 0; i--) {
      const d = state.days[keys[i]];
      if (!d || isDayEmpty(d)) continue;
      return keys[i];
    }
    return null;
  }

  function resolveDefaultYmd() {
    const today = state.todayYmd || seoulYmd();
    if (isTodayReportPublished()) return today;
    const latest = latestPublishedYmd();
    if (latest) return latest;
    return today;
  }

  function selectedYmd() {
    const y = state.selected;
    if (y && YMD_RE.test(y)) return y;
    return state.defaultYmd || state.todayYmd || seoulYmd();
  }

  /** 오늘 리포트(AI+마감 TOP30)가 아직 발행되지 않은 거래일 */
  function isTodayReportPending(ymd) {
    if (ymd !== state.todayYmd) return false;
    if (!isDomesticTradingDay(ymd)) return false;
    return !isTodayReportPublished();
  }

  function getJsonReportDate() {
    const root = sanitizeStr(state.jsonDate);
    if (YMD_RE.test(root)) return root;
    const metaDate = sanitizeStr(state.meta && state.meta.date);
    if (YMD_RE.test(metaDate)) return metaDate;
    return null;
  }

  function getTodayDayEntry() {
    const today = state.todayYmd;
    if (!today) return null;
    return state.days[today] || null;
  }

  function hasPartialStockLists(day) {
    if (!day || typeof day !== "object") return false;
    return (
      (Array.isArray(day.topGainers) && day.topGainers.length > 0) ||
      (Array.isArray(day.topDecliners) && day.topDecliners.length > 0) ||
      (Array.isArray(day.topLosers) && day.topLosers.length > 0) ||
      (Array.isArray(day.topTradingValue) && day.topTradingValue.length > 0)
    );
  }

  function hasLiveStockRows() {
    return STOCK_TABS.some((t) => Array.isArray(state.liveRowsByTab[t]) && state.liveRowsByTab[t].length > 0);
  }

  /** 오늘 리포트 + TOP30 종목 데이터까지 반영된 경우만 true */
  function isTodayReportPublished() {
    const today = state.todayYmd;
    if (!today) return false;
    const todayDay = getTodayDayEntry();
    if (todayDay) {
      const dayDate = getDayDateYmd(todayDay, "");
      if (dayDate === today) {
        return hasClosingStockData(todayDay, today) && hasAiReportContent(todayDay);
      }
      if (dayDate && dayDate !== today) return false;
    }
    const jsonDate = getJsonReportDate();
    if (jsonDate && jsonDate === today) {
      const day = getDay(today);
      return hasClosingStockData(day, today) && hasAiReportContent(day);
    }
    return false;
  }

  /** AI 리포트 본문·특징주 데이터가 있으면 준비중 해제 */
  function hasAiReportContent(day) {
    if (!day || typeof day !== "object") return false;
    if (sanitizeStr(day.analysis).length > 10) return true;
    if (sanitizeStr(day.summary).length > 10) return true;
    if (Array.isArray(day.issueStocks) && day.issueStocks.length > 0) return true;
    if (Array.isArray(day.notableStocks) && day.notableStocks.length > 0) return true;
    return false;
  }

  /** AI 시황분석 탭: 오늘만 준비중; 과거 날짜는 아카이브 데이터 그대로 표시 */
  function isAiTabPreparing(ymd) {
    const today = state.todayYmd;
    if (!today || ymd !== today) return false;
    const day = getDay(ymd);
    if (hasAiReportContent(day)) return false;
    return !isTodayReportPublished();
  }

  /** 휴장·업로드 전 — 탭/본문 숨기고 준비중 메시지만 표시 */
  function isPageContentReady(ymd) {
    const closed = marketClosedReason(ymd);
    if (closed) return false;
    if (isTodayReportPending(ymd)) return false;
    if (state.missingYmd === ymd) return false;
    const day = getDay(ymd);
    if (!day || isDayEmpty(day)) return false;
    if (ymd === state.todayYmd) {
      return isTodayReportPublished() || (hasClosingStockData(day, ymd) && hasAiReportContent(day));
    }
    return hasPartialStockLists(day) || hasAiReportContent(day);
  }

  function getPreparingCopy(ymd) {
    const closedReason = marketClosedReason(ymd);
    if (closedReason) {
      return {
        title: `${closedReason} 휴장입니다`,
        hint: "국내 증시가 열리지 않아 장마감 리포트가 생성되지 않습니다.",
        icon: "ti-calendar-off",
      };
    }
    if (isTodayReportPending(ymd)) {
      const afterClose = isAfterMarketCloseKst();
      return {
        title: "오늘 마감시황 준비 중",
        hint: afterClose
          ? "장 마감 데이터를 수집하고 AI 분석 중입니다 · 완료 예상 17:00 전후"
          : "장 마감 후 자동으로 업데이트됩니다 · 완료 예상 17:00 전후",
        icon: "ti-sparkles",
      };
    }
    if (state.missingYmd === ymd) {
      return {
        title: "데이터 없음",
        hint: "해당 날짜의 마감시황이 아직 없습니다. 이전 날짜를 선택해 보세요.",
        icon: "ti-file-off",
      };
    }
    return {
      title: "데이터 준비중",
      hint: "장 마감 후 TOP30·AI 분석이 자동 업데이트됩니다",
      icon: "ti-clock-hour-4",
    };
  }

  function getRenderableDay(ymd) {
    if (state.missingYmd === ymd) return null;
    return getDay(ymd);
  }

  function normalizeArchiveDay(raw, ymd) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.days && typeof raw.days === "object" && raw.days[ymd]) return raw.days[ymd];
    const copy = { ...raw };
    delete copy.meta;
    if (Object.keys(copy).length <= 0) return null;
    if (!copy.date) copy.date = ymd;
    return copy;
  }

  function resolveSelectedYmd() {
    const h = (location.hash || "").replace("#", "");
    if (YMD_RE.test(h)) return h;
    return state.defaultYmd || resolveDefaultYmd();
  }

  function syncHash(ymd) {
    const base = state.defaultYmd || state.todayYmd || seoulYmd();
    const nextHash = ymd && ymd !== base ? `#${ymd}` : "";
    const cur = location.hash || "";
    if (cur !== nextHash) {
      const page = location.pathname.split("/").pop() || "daily-market.html";
      history.replaceState(null, "", nextHash ? `${page}${nextHash}` : page);
    }
  }

  function updateDateNav() {
    const today = state.todayYmd || seoulYmd();
    const ymd = selectedYmd();
    if (els.dmDateLabel) els.dmDateLabel.textContent = shortDateLabel(ymd);
    if (els.dmDatePrev) els.dmDatePrev.disabled = false;
    if (els.dmDateNext) {
      const next = skipWeekendNext(ymd);
      els.dmDateNext.disabled = ymd >= today || next > today;
    }
  }

  function renderBootState() {
    if (els.dmTabsRow) els.dmTabsRow.hidden = true;
    if (els.dmTabPanels) els.dmTabPanels.hidden = true;
    if (els.dmPreparing) {
      els.dmPreparing.hidden = false;
      els.dmPreparing.classList.remove("dm-preparing--today");
      els.dmPreparing.classList.add("dm-preparing--boot");
      if (els.dmPreparingTitle) els.dmPreparingTitle.textContent = "불러오는 중";
      if (els.dmPreparingHint) els.dmPreparingHint.textContent = "마감시황 데이터를 가져오고 있습니다";
      const iconEl = els.dmPreparing.querySelector(".dm-preparing__icon i");
      if (iconEl) iconEl.className = "ti ti-loader";
    }
    if (els.dmDateLabel) els.dmDateLabel.textContent = "불러오는 중…";
    if (els.dmDatePrev) els.dmDatePrev.disabled = true;
    if (els.dmDateNext) els.dmDateNext.disabled = true;
  }

  async function ensureDayLoaded(ymd, opts) {
    const deferLive = !!(opts && opts.deferLive);
    if (!YMD_RE.test(ymd)) return false;
    if (state.days[ymd] && !isDayEmpty(state.days[ymd])) {
      state.missingYmd = state.missingYmd === ymd ? null : state.missingYmd;
      if (needsLiveRealtime(ymd)) {
        if (deferLive) void loadLiveStockData();
        else await loadLiveStockData();
      } else state.liveMode = false;
      return true;
    }
    const archive = await fetchArchiveDayJson(ymd);
    const normalized = normalizeArchiveDay(archive, ymd);
    if (normalized && !isDayEmpty(normalized)) {
      state.days[ymd] = normalized;
      state.missingYmd = state.missingYmd === ymd ? null : state.missingYmd;
      if (needsLiveRealtime(ymd)) {
        if (deferLive) void loadLiveStockData();
        else await loadLiveStockData();
      } else state.liveMode = false;
      return true;
    }
    if (ymd === state.todayYmd) {
      state.missingYmd = state.missingYmd === ymd ? null : state.missingYmd;
      if (needsLiveRealtime(ymd)) {
        if (deferLive) void loadLiveStockData();
        else await loadLiveStockData();
        return true;
      }
      return true;
    }
    state.missingYmd = ymd;
    state.liveMode = false;
    return false;
  }

  async function navigateDate(direction) {
    const today = state.todayYmd || seoulYmd();
    const ymd =
      direction === "prev"
        ? skipWeekendPrev(state.selected)
        : skipWeekendNext(state.selected);
    if (direction === "next" && (state.selected >= today || ymd > today)) return;
    state.selected = ymd;
    syncHash(ymd);
    await ensureDayLoaded(ymd);
    updateDateNav();
    render();
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

  function isDomesticTradingDay(ymd) {
    return !marketClosedReason(ymd);
  }

  function seoulHourMinute(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return { hour, minute };
  }

  function isAfterMarketCloseKst(now = new Date()) {
    const { hour, minute } = seoulHourMinute(now);
    return hour > 15 || (hour === 15 && minute >= 30);
  }

  function hasAnyStockTabData(day, ymd) {
    if (hasLiveStockRows()) return true;
    if (hasClosingStockData(day, ymd)) return true;
    if (day && getDayDateYmd(day, ymd) === ymd && hasPartialStockLists(day)) return true;
    return false;
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

  function numFromMoneyish(v) {
    const n = Number(String(v == null ? "" : v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  /** 거래량: 만 단위 (realtime-board.js formatVolumeMan 동일) */
  function formatVolumeMan(raw) {
    const n = Number(String(raw == null ? "" : raw).replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n < 10000) return n.toLocaleString("ko-KR");
    const man = Math.round(n / 1000) / 10;
    return `${man.toFixed(1)}만`;
  }

  /** 원 단위 → X.X조 / XXX.X억 (realtime formatWonJoEok 동일) */
  function formatWonJoEok(n) {
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1e12) return `${(n / 1e12).toFixed(1)}조`;
    const eok = n / 1e8;
    if (eok >= 10000) return `${(eok / 10000).toFixed(1)}조`;
    if (eok >= 100) return `${eok.toFixed(1)}억`;
    const eokR = Math.round(eok);
    if (eokR <= 0) return "—";
    return `${eokR}억`;
  }

  function readStckAvlsRaw(r) {
    if (!r) return null;
    const keys = ["stck_avls", "hts_avls", "mcap", "mcapEok", "marketCap", "marcap"];
    for (const k of keys) {
      const v = r[k];
      if (v != null && String(v).trim() !== "") return v;
    }
    return null;
  }

  function formatStckAvls(raw) {
    const n = numFromMoneyish(raw);
    if (n == null || n <= 0) return "—";
    if (n >= 1e8) return formatWonJoEok(n);
    const eok = Math.round(n);
    if (eok >= 10000) return `${Math.round(eok / 10000)}조`;
    if (eok >= 100) return `${eok.toLocaleString("ko-KR")}억`;
    return `${eok}억`;
  }

  function hasClosingStockData(day, ymd) {
    if (!day || typeof day !== "object") return false;
    if (getDayDateYmd(day, ymd) !== ymd) return false;
    const hasG = Array.isArray(day.topGainers) && day.topGainers.length > 0;
    const hasD =
      (Array.isArray(day.topDecliners) && day.topDecliners.length > 0) ||
      (Array.isArray(day.topLosers) && day.topLosers.length > 0);
    const hasTv = hasValidTopTradingValue(day);
    return hasG && hasD && hasTv;
  }

  function needsLiveRealtime(ymd) {
    if (ymd !== state.todayYmd) return false;
    const day = getDay(ymd);
    if (hasClosingStockData(day, ymd)) return false;
    if (!day) return true;
    const dayDate = getDayDateYmd(day, ymd);
    if (dayDate !== state.todayYmd) return true;
    const hasG = Array.isArray(day.topGainers) && day.topGainers.length > 0;
    const hasD =
      (Array.isArray(day.topDecliners) && day.topDecliners.length > 0) ||
      (Array.isArray(day.topLosers) && day.topLosers.length > 0);
    const hasTv = hasValidTopTradingValue(day);
    return !(hasG && hasD && hasTv);
  }

  function mapKisRtRowToDaily(r, i) {
    return normalizeDailyStockRow(
      {
        rank: r.rank != null ? r.rank : i + 1,
        code: r.code,
        name: r.name,
        currentPrice: r.price != null ? r.price : r.currentPrice,
        change: r.changePct != null ? r.changePct : r.change,
        prevDelta: r.changeAmt != null ? r.changeAmt : r.prevDelta,
        volume: r.volume,
        tradingValue: r.tradingValue,
        tradingValueRaw: r.tradingValue,
        stck_avls: readStckAvlsRaw(r),
        hts_avls: r.hts_avls || r.stck_avls || r.mcapEok,
        market: r.tvBoard || r.market,
      },
      i
    );
  }

  async function fetchKisRealtimePage(action, page, pageSize = 25) {
    const qs = new URLSearchParams({
      action,
      page: String(page),
      pageSize: String(pageSize),
    });
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), LIVE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${KIS_RT_API}?${qs.toString()}`, {
        cache: "no-store",
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      return Array.isArray(data.stocks) ? data.stocks : [];
    } finally {
      clearTimeout(tid);
    }
  }

  async function fetchKisRealtimeTop(action, limit = LIVE_TOP_N) {
    const pageSize = 25;
    const pages = limit <= pageSize ? [1] : [1, 2];
    const merged = [];
    for (const page of pages) {
      const part = await fetchKisRealtimePage(action, page, pageSize);
      merged.push(...part);
    }
    return merged.slice(0, limit).map(mapKisRtRowToDaily);
  }

  async function fetchKisRealtimeLosers(limit = LIVE_TOP_N) {
    try {
      return await fetchKisRealtimeTop("losers", limit);
    } catch (e) {
      console.warn("[daily-market] losers API fallback", e && e.message);
    }
    try {
      const gainers = await fetchKisRealtimeTop("gainers", 100);
      return gainers
        .filter((r) => {
          const ch = parseChange(r.change);
          return ch != null && ch < 0;
        })
        .sort((a, b) => (parseChange(a.change) || 0) - (parseChange(b.change) || 0))
        .slice(0, limit)
        .map((r, i) => ({ ...r, rank: i + 1 }));
    } catch (e2) {
      console.warn("[daily-market] losers gainers-filter fallback", e2 && e2.message);
      return [];
    }
  }

  async function loadLiveStockData() {
    if (!needsLiveRealtime(state.selected)) {
      state.liveMode = false;
      return;
    }
    if (liveLoadPromise) return liveLoadPromise;
    liveLoadPromise = (async () => {
      try {
        state.liveMode = true;
        const [gainers, losers, tv] = await Promise.all([
          fetchKisRealtimeTop("gainers", LIVE_TOP_N),
          fetchKisRealtimeLosers(LIVE_TOP_N),
          fetchKisRealtimeTop("trading-value", LIVE_TOP_N),
        ]);
        state.liveRowsByTab = { gainers, losers, tv };
        render();
      } catch (e) {
        console.warn("[daily-market] live stock load failed", e && e.message);
      } finally {
        liveLoadPromise = null;
      }
    })();
    return liveLoadPromise;
  }

  async function fetchMcapLookup(codes) {
    const missing = [...new Set((codes || []).filter((c) => c && !mcapCacheByCode.has(c)))];
    if (!missing.length) return;
    for (let i = 0; i < missing.length; i += 30) {
      const chunk = missing.slice(i, i + 30);
      const qs = new URLSearchParams({ action: "mcap-lookup", codes: chunk.join(",") });
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), LIVE_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`${KIS_RT_API}?${qs.toString()}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) continue;
        const items = Array.isArray(data.items) ? data.items : [];
        for (const it of items) {
          if (it && it.code && it.stck_avls) mcapCacheByCode.set(String(it.code), it.stck_avls);
        }
      } catch (e) {
        console.warn("[daily-market] mcap lookup failed", e && e.message);
      } finally {
        clearTimeout(tid);
      }
    }
  }

  function applyMcapCache(rows) {
    return (rows || []).map((r) => {
      const m = readStckAvlsRaw(r) || mcapCacheByCode.get(r.code);
      return m ? { ...r, stck_avls: m } : r;
    });
  }

  async function enrichRowsMcapIfNeeded(rows) {
    const need = (rows || []).filter((r) => r && r.code && !readStckAvlsRaw(r)).map((r) => r.code);
    if (!need.length) return rows;
    const gen = ++mcapEnrichGen;
    await fetchMcapLookup(need);
    if (gen !== mcapEnrichGen) return rows;
    return applyMcapCache(rows);
  }

  function calcTradeValFromPriceVol(priceRaw, volRaw) {
    const p = numFromMoneyish(priceRaw);
    const v = numFromMoneyish(volRaw);
    if (p == null || v == null || p <= 0 || v <= 0) return null;
    const x = p * v;
    if (!Number.isFinite(x) || x <= 0) return null;
    return Math.round(x);
  }

  function formatRowTradeVal(r) {
    const tvRaw = r && r.tradingValueRaw != null ? numFromMoneyish(r.tradingValueRaw) : null;
    if (tvRaw != null && tvRaw > 0) return formatTradeVal(String(tvRaw));
    const calc = calcTradeValFromPriceVol(r && (r.currentPrice || r.price), r && r.volume);
    if (calc != null) return formatTradeVal(String(calc));
    return formatStockTv(r && r.tradingValue);
  }

  function formatVsCell(r) {
    const n =
      r && r.prevDelta != null
        ? Number(r.prevDelta)
        : calcChangeAmt(r && (r.currentPrice || r.price), parseChange(r && (r.change != null ? r.change : r.changePct)));
    if (n == null || !Number.isFinite(n)) return { html: "—", cls: "" };
    return { html: escapeHtml(fmtChangeAmt(n)), cls: vsClass(n) };
  }

  function stockTheadHtml(subTab) {
    const base = [
      '<th class="rt-td-rank">순위</th>',
      '<th class="rt-td-name">종목명</th>',
      '<th class="num rt-td-price">가격</th>',
      '<th class="num rt-td-vs">대비</th>',
      '<th class="num rt-td-chg">등락률</th>',
      '<th class="num rt-td-vol">거래량</th>',
    ];
    if (subTab === "tv") {
      base.push('<th class="num rt-td-mcap">시가총액</th>');
      base.push('<th class="num rt-td-tv">거래대금</th>');
    } else {
      base.push('<th class="num rt-td-tv">거래대금</th>');
      base.push('<th class="num rt-td-mcap">시가총액</th>');
    }
    return base.join("");
  }

  function isMobileLayout() {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 768px)").matches
    );
  }

  function mobileLastColumnLabel(subTab) {
    return subTab === "tv" ? "거래대금" : "시가총액";
  }

  function syncMobileHeaderRow(subTab) {
    const last = els.dmStockHeaderRow && els.dmStockHeaderRow.querySelector(".rt-col-last");
    if (last) last.textContent = mobileLastColumnLabel(subTab);
  }

  function syncStockThead(subTab) {
    if (els.dmStockTable) els.dmStockTable.setAttribute("data-dm-stock-tab", subTab || "gainers");
    if (els.dmStockThead) els.dmStockThead.innerHTML = stockTheadHtml(subTab);
    syncMobileHeaderRow(subTab);
  }

  function normalizeDailyStockRow(r, i) {
    const price = r.currentPrice != null ? r.currentPrice : r.price;
    const tvRaw =
      r.tradingValueRaw != null
        ? r.tradingValueRaw
        : numFromMoneyish(r.tradingValue) != null && !/[억조]/.test(String(r.tradingValue || ""))
          ? r.tradingValue
          : null;
    return {
      rank: r.rank != null ? r.rank : i + 1,
      code: r.code,
      name: r.name || r.code || "—",
      currentPrice: price,
      change: r.change != null ? r.change : r.changePct,
      prevDelta: r.prevDelta != null ? r.prevDelta : r.changeAmt,
      volume: r.volume,
      tradingValue: r.tradingValue,
      tradingValueRaw: tvRaw,
      stck_avls: readStckAvlsRaw(r),
      market: r.market,
    };
  }

  function formatStockTv(raw) {
    if (raw == null || raw === "") return "—";
    const s = String(raw).trim();
    if (/[억조]/.test(s)) return s;
    return formatTradeVal(s);
  }

  function tvSortValue(r) {
    if (r.tradingValueRaw != null) {
      const n = numFromMoneyish(r.tradingValueRaw);
      if (n != null) return n;
    }
    const calc = calcTradeValFromPriceVol(r.currentPrice, r.volume);
    if (calc != null) return calc;
    return parseTvSortValue(r.tradingValue);
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
      hasArr("topTradingValue") ||
      hasArr("volumeLeaders")
    );
  }

  function getFeaturedStocks(day) {
    if (!day) return [];
    // featured_stocks(그룹A/B 선정 기준으로 큐레이션된 최신 데이터)가 있으면 그것만 사용.
    // issueStocks/notableStocks는 구버전 파이프라인의 잔존 필드라 섞으면 옛 종목이 중복 노출됨.
    if (Array.isArray(day.featured_stocks) && day.featured_stocks.length) return day.featured_stocks;
    const issue = Array.isArray(day.issueStocks) ? day.issueStocks : [];
    const notable = Array.isArray(day.notableStocks) ? day.notableStocks : [];
    if (issue.length || notable.length) {
      const seen = new Set();
      const merged = [];
      for (const row of [...issue, ...notable]) {
        if (!row || !row.name) continue;
        const key = sanitizeStr(row.code) || sanitizeStr(row.name);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(row);
      }
      return merged;
    }
    return [];
  }

  /** analysis 본문에서 특징주·총평 섹션 제거 (하단 카드와 중복 방지) */
  function stripFeaturedFromAnalysis(text) {
    const raw = sanitizeStr(text);
    if (!raw) return "";
    const cutPatterns = [
      /\n(?:#{1,3}\s*)?오늘의?\s*특징주\b/i,
      /\n(?:#{1,3}\s*)?특징주\s*분석\b/i,
      /\n(?:#{1,3}\s*)?향후\s*전략\b/i,
      /\n(?:#{1,3}\s*)?내일\s*주목(?:할)?\s*변수\b/i,
    ];
    let cutAt = raw.length;
    for (const re of cutPatterns) {
      const m = re.exec(raw);
      if (m && m.index < cutAt) cutAt = m.index;
    }
    return raw.slice(0, cutAt).trim();
  }

  function getAnalysisDisplayText(day) {
    if (!day) return "";
    const raw = sanitizeStr(day.analysis) || sanitizeStr(day.summary) || "";
    return stripFeaturedFromAnalysis(raw);
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
      code: r.code,
      name: r.name || r.code || "—",
      currentPrice: r.price != null ? r.price : r.currentPrice,
      change: r.changePct != null ? r.changePct : r.change,
      prevDelta: r.changeAmt != null ? r.changeAmt : r.prevDelta,
      volume: r.volume,
      tradingValue: r.tradingValue,
      tradingValueRaw: r.tradingValue,
      stck_avls: r.stck_avls || r.mcapEok,
      market: r.tvBoard || r.market,
    };
  }

  function getStockRows(day, subTab) {
    if (
      state.liveMode &&
      state.selected === state.todayYmd &&
      STOCK_TABS.includes(subTab) &&
      Array.isArray(state.liveRowsByTab[subTab]) &&
      state.liveRowsByTab[subTab].length
    ) {
      return state.liveRowsByTab[subTab].slice(0, LIVE_TOP_N);
    }
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
      const ymd = state.selected;
      if (hasValidTopTradingValue(day)) {
        rows = [...day.topTradingValue];
      } else if (ymd === state.todayYmd && state.krTv && state.krTv.length) {
        rows = state.krTv.map(normalizeKrTvRow);
      } else if (Array.isArray(day.volumeLeaders) && day.volumeLeaders.length) {
        rows = day.volumeLeaders.map((r, i) => ({
          rank: r.rank != null ? r.rank : i + 1,
          name: r.name,
          code: r.code,
          currentPrice: r.currentPrice || r.price,
          change: r.change,
          prevDelta: r.prevDelta,
          volume: r.volume,
          tradingValue: r.tradingValue,
          tradingValueRaw: r.tradingValueRaw,
          stck_avls: readStckAvlsRaw(r),
        }));
      } else if (Array.isArray(day.topTradingValue) && day.topTradingValue.length) {
        rows = [...day.topTradingValue];
      }
      rows.sort((a, b) => tvSortValue(b) - tvSortValue(a));
    }
    return rows.slice(0, 30).map(normalizeDailyStockRow);
  }

  function syncTabChromeVisibility(ymd) {
    const y = ymd || state.selected;
    const ready = isPageContentReady(y);
    if (els.dmTabsRow) els.dmTabsRow.hidden = !ready;
    if (els.dmTabPanels) els.dmTabPanels.hidden = !ready;
    if (els.dmPreparing) {
      els.dmPreparing.hidden = ready;
      els.dmPreparing.classList.remove("dm-preparing--boot");
      els.dmPreparing.classList.toggle("dm-preparing--today", isTodayReportPending(y));
      if (!ready) {
        const copy = getPreparingCopy(y);
        if (els.dmPreparingTitle) els.dmPreparingTitle.textContent = copy.title;
        if (els.dmPreparingHint) els.dmPreparingHint.textContent = copy.hint;
        const iconEl = els.dmPreparing.querySelector(".dm-preparing__icon i");
        if (iconEl && copy.icon) {
          iconEl.className = `ti ${copy.icon}`;
        }
      }
    }
    return ready;
  }

  function setMainTab(tabId) {
    state.mainTab = tabId;
    if (STOCK_TABS.includes(tabId)) {
      state.stockSubTab = tabId;
    }
    document.querySelectorAll("[data-dm-tab]").forEach((btn) => {
      const on = btn.dataset.dmTab === tabId;
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    const ready = syncTabChromeVisibility();
    document.querySelectorAll("[data-dm-panel]").forEach((panel) => {
      const panelId = panel.dataset.dmPanel;
      const on =
        ready &&
        (panelId === tabId || (STOCK_TABS.includes(tabId) && panelId === "stocks"));
      panel.hidden = !on;
      panel.classList.toggle("is-active", on);
    });
    if (!ready) return;
    if (STOCK_TABS.includes(tabId)) {
      syncStockThead(state.stockSubTab);
      if (needsLiveRealtime(state.selected)) {
        void loadLiveStockData().then(() => {
          renderStockTable();
        });
      } else {
        renderStockTable();
      }
    } else {
      renderAiPanels();
    }
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

  function paintStockTableBody(rows, subTab) {
    const tbody = els.dmStockTbody;
    if (!tbody) return;
    const colSpan = 8;

    if (!rows.length) {
      const label =
        subTab === "gainers" ? "상승률" : subTab === "losers" ? "하락률" : "거래대금";
      tbody.innerHTML = `<tr class="dm-stock-row rt-stock-row"><td colspan="${colSpan}" class="dm-stock-empty">${label} TOP30 데이터 준비중</td></tr>`;
      return;
    }

    if (isMobileLayout()) {
      tbody.innerHTML = rows
        .map((r) => {
          const chg = parseChange(r.change);
          const cls = deltaClass(chg);
          const lastVal =
            subTab === "tv"
              ? escapeHtml(formatRowTradeVal(r))
              : escapeHtml(formatStckAvls(r.stck_avls));
          const row = [
            `<div class="rt-mobile-row dm-mobile-row">`,
            `  <span class="rt-col-rank">${escapeHtml(r.rank != null ? String(r.rank) : "—")}</span>`,
            `  <span class="rt-col-name"><span class="rt-name-text">${escapeHtml(r.name)}</span></span>`,
            `  <span class="rt-col-price">${escapeHtml(fmtNum(r.currentPrice))}</span>`,
            `  <span class="rt-col-change"><span class="delta ${cls}">${escapeHtml(formatChange(chg))}</span></span>`,
            `  <span class="rt-col-last">${lastVal}</span>`,
            `</div>`,
          ].join("");
          return `<tr class="dm-stock-row rt-stock-row"><td colspan="${colSpan}">${row}</td></tr>`;
        })
        .join("");
      return;
    }

    tbody.innerHTML = rows
      .map((r) => {
        const chg = parseChange(r.change);
        const cls = deltaClass(chg);
        const vs = formatVsCell(r);
        const vol = escapeHtml(formatVolumeMan(r.volume));
        const tv = escapeHtml(formatRowTradeVal(r));
        const mcap = escapeHtml(formatStckAvls(r.stck_avls));
        const common = [
          `<td class="num rt-td-rank">${escapeHtml(r.rank != null ? String(r.rank) : "—")}</td>`,
          `<td class="rt-td-name"><span class="rt-name-text">${escapeHtml(r.name)}</span></td>`,
          `<td class="num rt-td-price">${escapeHtml(fmtNum(r.currentPrice))}</td>`,
          `<td class="num rt-td-vs"><span class="${escapeHtml(vs.cls)}">${vs.html}</span></td>`,
          `<td class="num rt-td-chg"><span class="delta ${cls}">${escapeHtml(formatChange(chg))}</span></td>`,
          `<td class="num rt-td-vol">${vol}</td>`,
        ];
        const tail =
          subTab === "tv"
            ? [
                `<td class="num rt-td-mcap">${mcap}</td>`,
                `<td class="num rt-td-tv">${tv}</td>`,
              ]
            : [
                `<td class="num rt-td-tv">${tv}</td>`,
                `<td class="num rt-td-mcap">${mcap}</td>`,
              ];
        return `<tr>${common.join("")}${tail.join("")}</tr>`;
      })
      .join("");
  }

  function renderStockTable() {
    const subTab = state.stockSubTab;
    syncStockThead(subTab);
    const day = getDay(state.selected);
    const ymd = state.selected;
    let rows = applyMcapCache(getStockRows(day, subTab));
    paintStockTableBody(rows, subTab);
    if (rows.some((r) => r && r.code && !readStckAvlsRaw(r))) {
      void enrichRowsMcapIfNeeded(rows).then((enriched) => {
        if (state.stockSubTab !== subTab || state.selected !== ymd) return;
        paintStockTableBody(enriched, subTab);
      });
    }
  }

  function renderAiPanels() {
    const ymd = selectedYmd();
    const day = getRenderableDay(ymd);
    if (els.dmAnalysis) {
      const analysisText = sanitizeUserCopy(getAnalysisDisplayText(day), "AI 분석을 준비 중입니다");
      els.dmAnalysis.innerHTML = analysisText
        ? `<div class="dm-analysis__body">${renderMarkdownBold(analysisText)}</div>`
        : '<p class="empty-line">종합분석 없음</p>';
    }
    if (els.dmFeatured) els.dmFeatured.innerHTML = renderFeatured(getFeaturedStocks(day));
    if (els.dmWatchlist) els.dmWatchlist.innerHTML = renderWatchlist(getWatchlist(day));
  }

  function syncTabPanelsForMainTab() {
    const ready = isPageContentReady(state.selected);
    const tabId = state.mainTab;
    document.querySelectorAll("[data-dm-panel]").forEach((panel) => {
      const panelId = panel.dataset.dmPanel;
      const on =
        ready &&
        (panelId === tabId || (STOCK_TABS.includes(tabId) && panelId === "stocks"));
      panel.hidden = !on;
      panel.classList.toggle("is-active", on);
    });
  }

  function render() {
    const ymd = selectedYmd();
    const day = getRenderableDay(ymd);
    const ready = syncTabChromeVisibility(ymd);
    const displayYmd = getDayDateYmd(day, ymd);

    if (els.title) els.title.textContent = "마감시황";
    updateDateNav();

    try {
      document.title = `${state.meta.title || "마감시황"} · ${headlineKo(displayYmd)}`;
    } catch (_) {
      /* ignore */
    }

    if (!ready) return;

    syncTabPanelsForMainTab();
    renderAiPanels();
    renderStockTable();
  }

  function bindEvents() {
    document.querySelectorAll("[data-dm-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setMainTab(btn.dataset.dmTab));
    });

    if (els.dmDatePrev) {
      els.dmDatePrev.addEventListener("click", () => navigateDate("prev"));
    }
    if (els.dmDateNext) {
      els.dmDateNext.addEventListener("click", () => navigateDate("next"));
    }

    window.addEventListener("hashchange", async () => {
      const h = (location.hash || "").replace("#", "");
      if (!YMD_RE.test(h)) {
        const base = state.defaultYmd || state.todayYmd;
        if (state.selected !== base) {
          state.selected = base;
          await ensureDayLoaded(state.selected);
          render();
        }
        return;
      }
      if (h !== state.selected) {
        state.selected = h;
        await ensureDayLoaded(h);
        render();
      }
    });

    function onLayoutModeChange() {
      if (!isPageContentReady(state.selected)) return;
      if (STOCK_TABS.includes(state.mainTab)) renderStockTable();
      else renderAiPanels();
    }

    let resizeTid;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTid);
      resizeTid = setTimeout(onLayoutModeChange, 150);
    });

    if (typeof window.matchMedia === "function") {
      const mobileMq = window.matchMedia("(max-width: 768px)");
      const onMq = () => onLayoutModeChange();
      if (typeof mobileMq.addEventListener === "function") {
        mobileMq.addEventListener("change", onMq);
      } else if (typeof mobileMq.addListener === "function") {
        mobileMq.addListener(onMq);
      }
    }
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
      if (raw && typeof raw.date === "string") {
        state.jsonDate = raw.date.slice(0, 10);
      }
      if (raw && raw.days && typeof raw.days === "object") state.days = raw.days;
    } catch (e) {
      console.warn("daily-market.json 불러오기 실패:", e);
    }
  }

  async function main() {
    state.todayYmd = seoulYmd();
    renderBootState();
    bindEvents();
    try {
      await Promise.all([loadData(), loadKrTv()]);
      state.defaultYmd = resolveDefaultYmd();
      state.selected = resolveSelectedYmd();
      if (!YMD_RE.test(state.selected)) state.selected = state.defaultYmd;
      syncHash(state.selected);
      await ensureDayLoaded(state.selected, { deferLive: true });
    } catch (e) {
      console.warn("daily-market init failed", e && e.message);
    }
    render();
  }

  main();
})();
