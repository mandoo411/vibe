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
    datePickerOpen: false,
    calendarMonthYmd: null,
    krTv: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    title: $("masthead-title"),
    dmAiContent: $("dm-ai-content"),
    dmAnalysis: $("dm-analysis"),
    dmStrategy: $("dm-strategy"),
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
    dmTabDate: $("dm-tab-date"),
    dmDateLabel: $("dm-date-label"),
    dmDateLabelShort: $("dm-date-label-short"),
    dmDatePicker: $("dm-date-picker"),
    dmCalGrid: $("dm-cal-grid"),
    dmCalMonth: $("dm-cal-month"),
    dmCalPrev: $("dm-cal-prev"),
    dmCalNext: $("dm-cal-next"),
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

  function shortDateLabelShort(ymd) {
    if (!YMD_RE.test(ymd)) return "—";
    const { m, d } = ymdParts(ymd);
    return `${m}/${d}`;
  }

  function listSelectableDates() {
    const today = state.todayYmd || seoulYmd();
    const set = new Set();
    for (const ymd of Object.keys(state.days || {})) {
      if (!YMD_RE.test(ymd) || ymd > today) continue;
      const day = state.days[ymd];
      if (day && !isDayEmpty(day)) set.add(ymd);
    }
    if (today) set.add(today);
    return [...set].sort();
  }

  function isDateSelectable(ymd) {
    if (!YMD_RE.test(ymd)) return false;
    const today = state.todayYmd || seoulYmd();
    if (ymd > today) return false;
    if (ymd === today) return true;
    if (marketClosedReason(ymd)) return false;
    const day = state.days[ymd];
    return !!(day && !isDayEmpty(day));
  }

  function calendarMonthYmd() {
    const ymd = selectedYmd();
    if (state.calendarMonthYmd && YMD_RE.test(state.calendarMonthYmd)) return state.calendarMonthYmd;
    return `${ymd.slice(0, 7)}-01`;
  }

  function setCalendarMonth(ymd) {
    if (!YMD_RE.test(ymd)) return;
    state.calendarMonthYmd = `${ymd.slice(0, 7)}-01`;
  }

  function monthLabelKo(ymd) {
    const { y, m } = ymdParts(ymd);
    return `${y}년 ${m}월`;
  }

  function closeDatePicker() {
    state.datePickerOpen = false;
    if (els.dmDatePicker) els.dmDatePicker.hidden = true;
    if (els.dmTabDate) {
      els.dmTabDate.setAttribute("aria-expanded", "false");
      els.dmTabDate.classList.remove("is-active");
    }
  }

  function toggleDatePicker() {
    if (state.datePickerOpen) {
      closeDatePicker();
      return;
    }
    setCalendarMonth(selectedYmd());
    state.datePickerOpen = true;
    if (els.dmDatePicker) els.dmDatePicker.hidden = false;
    if (els.dmTabDate) {
      els.dmTabDate.setAttribute("aria-expanded", "true");
      els.dmTabDate.classList.add("is-active");
    }
    renderDatePicker();
  }

  function renderDatePicker() {
    if (!els.dmCalGrid || !state.datePickerOpen) return;
    const today = state.todayYmd || seoulYmd();
    const monthStart = calendarMonthYmd();
    const { y, m } = ymdParts(monthStart);
    if (els.dmCalMonth) els.dmCalMonth.textContent = monthLabelKo(monthStart);

    const selected = selectedYmd();
    const firstDow = ymdWeekday(monthStart);
    const daysInMonth = new Date(y, m, 0).getDate();

    const earliest = listSelectableDates().filter((d) => d !== today)[0] || today;
    const earliestMonth = earliest.slice(0, 7);
    const todayMonth = today.slice(0, 7);
    const curMonth = monthStart.slice(0, 7);
    if (els.dmCalPrev) els.dmCalPrev.disabled = curMonth <= earliestMonth;
    if (els.dmCalNext) els.dmCalNext.disabled = curMonth >= todayMonth;

    const cells = [];
    for (let i = 0; i < firstDow; i++) {
      cells.push('<span class="dm-date-picker__cell dm-date-picker__cell--blank" role="presentation"></span>');
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dd = String(day).padStart(2, "0");
      const ymd = `${y}-${String(m).padStart(2, "0")}-${dd}`;
      const w = ymdWeekday(ymd);
      const isSun = w === 0;
      const isSelectable = isDateSelectable(ymd);
      const isSelected = ymd === selected;
      const isToday = ymd === today;
      let cls = "dm-date-picker__cell";
      if (isSun) cls += " dm-date-picker__cell--sun";
      if (isToday) cls += " dm-date-picker__cell--today";
      if (isSelected) cls += " dm-date-picker__cell--active";
      if (!isSelectable) cls += " dm-date-picker__cell--disabled";
      if (isSelectable) {
        cells.push(
          `<button type="button" class="${cls}" data-ymd="${ymd}" role="gridcell" aria-label="${shortDateLabel(ymd)}"${isSelected ? ' aria-current="date"' : ""}>${day}</button>`
        );
      } else {
        cells.push(`<span class="${cls}" role="presentation">${day}</span>`);
      }
    }
    els.dmCalGrid.innerHTML = cells.join("");
  }

  async function selectDate(ymd) {
    if (!isDateSelectable(ymd)) return;
    closeDatePicker();
    if (ymd === state.selected) {
      updateDateNav();
      return;
    }
    const prev = state.selected;
    state.selected = ymd;
    state.missingYmd = null;
    try {
      await ensureDayLoaded(ymd);
      if (state.missingYmd === ymd && ymd !== state.todayYmd) {
        state.selected = prev;
        state.missingYmd = null;
      }
      syncHash(state.selected);
      updateDateNav();
      render();
    } catch (e) {
      console.warn("selectDate failed", e && e.message);
      state.selected = prev;
      state.missingYmd = null;
      render();
    }
  }

  function shiftCalendarMonth(delta) {
    const cur = calendarMonthYmd();
    const { y, m } = ymdParts(cur);
    const dt = new Date(y, m - 1 + delta, 1);
    const next = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-01`;
    state.calendarMonthYmd = next;
    renderDatePicker();
  }

  function resolveInitialYmd() {
    return state.todayYmd || seoulYmd();
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
    const ymd = selectedYmd();
    if (els.dmDateLabel) els.dmDateLabel.textContent = shortDateLabel(ymd);
    if (els.dmDateLabelShort) els.dmDateLabelShort.textContent = shortDateLabelShort(ymd);
    if (els.dmTabDate) {
      els.dmTabDate.setAttribute("aria-expanded", state.datePickerOpen ? "true" : "false");
      els.dmTabDate.classList.toggle("is-active", state.datePickerOpen);
    }
    if (state.datePickerOpen) renderDatePicker();
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
    if (els.dmDateLabelShort) els.dmDateLabelShort.textContent = "—";
    closeDatePicker();
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

  /** analysis 본문에서 특징주(카드와 중복) · 내일 주목할 변수(리스트와 중복) 섹션만
   *  골라서 제거한다. "향후 전략 및 총평"은 다른 곳에 표시되는 곳이 없으므로
   *  본문에 그대로 남겨둔다(과거에는 이 섹션도 잘려서 어디에도 안 보이는 문제가 있었음).
   *  주의: 한글은 JS 정규식의 \w(ASCII word char)에 포함되지 않으므로 한글 뒤에 붙는
   *  \b(word boundary)는 절대 매칭되지 않는다(한글→비단어 전환은 "비단어→비단어"로
   *  처리됨). 그래서 과거 \b 버전은 이모지 유무와 무관하게 단 한 번도 매칭된 적이
   *  없었고, 그 결과 특징주 전체 목록과 내일 주목할 변수 목록이 카드/리스트와
   *  중복으로 종합분석 본문에 그대로 노출되는 버그가 있었다. */
  // 줄간격 정리(2026-06-24): 섹션 간 3줄 공백→2줄, 투자자별 매매동향 코스피/코스닥/핵심 사이 공백 추가
  function stripFeaturedFromAnalysis(text) {
    const raw = sanitizeStr(text);
    if (!raw) return "";
    const headerRe = /\n[^\n]{0,24}(오늘의?\s*특징주|특징주\s*분석|향후\s*전략|내일\s*주목(?:할)?\s*변수)/gi;
    const matches = [...raw.matchAll(headerRe)];
    if (!matches.length) return raw.trim();
    const bounds = matches.map((m, i) => ({
      start: m.index,
      end: i + 1 < matches.length ? matches[i + 1].index : raw.length,
      label: m[1],
    }));
    let result = raw;
    for (let i = bounds.length - 1; i >= 0; i--) {
      const b = bounds[i];
      const drop = /특징주/.test(b.label) || /내일\s*주목/.test(b.label);
      if (drop) result = result.slice(0, b.start) + result.slice(b.end);
    }
    return result.trim();
  }

  function getAnalysisDisplayText(day) {
    if (!day) return "";
    const raw = sanitizeStr(day.analysis) || sanitizeStr(day.summary) || "";
    return stripFeaturedFromAnalysis(raw);
  }

  function parseWatchlistFromAnalysis(text) {
    const raw = sanitizeStr(text);
    if (!raw) return [];
    const m = raw.match(/(?:🔭\s*)?내일\s*주목(?:할)?\s*변수\s*\n([\s\S]*?)(?:\n\n|$)/i);
    if (!m) return [];
    const items = [];
    for (const line of m[1].split("\n")) {
      const t = line.replace(/^[\s\-•*]+/, "").trim();
      if (t) items.push(t);
    }
    return items;
  }

  function getWatchlist(day) {
    if (!day) return [];
    if (Array.isArray(day.watchlist) && day.watchlist.length) return day.watchlist;
    if (Array.isArray(day.tomorrowCheckpoints) && day.tomorrowCheckpoints.length) return day.tomorrowCheckpoints;
    return parseWatchlistFromAnalysis(day.analysis || day.summary || "");
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
    closeDatePicker();
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


  // ══════════════════════════════════════════════════════════════════
  // 2026-09-01: 마감시황 "브리핑 덱" 렌더러
  //
  // 기존에는 analysis(한 덩어리 텍스트)를 <div> 하나에 그대로 쏟아부어서
  // 메모장에 갈겨 쓴 것처럼 보였다. 이제 텍스트를 섹션 단위로 파싱하고,
  // 구조화 데이터(indexes / investor_trend / sectors / topGainers 등)로
  // 카드·차트를 코드가 직접 그린다.
  //
  // 원칙: 차트에 들어가는 숫자는 전부 실데이터에서만 온다. 값이 없으면
  // 그 블록 자체를 그리지 않는다(추정치로 채우지 않는다).
  // ══════════════════════════════════════════════════════════════════

  const DMX_SECTION_TITLES = [
    ["headline", /^핵심\s*한\s*줄$/],
    ["index", /^지수$/],
    ["flow", /^시장\s*흐름\s*분석$/],
    ["investor", /^투자자별\s*매매\s*동향$/],
    ["featured", /^오늘의?\s*특징주$/],
    ["strategy", /^향후\s*전략(\s*및\s*총평)?$/],
    ["watch", /^내일\s*주목(할)?\s*변수$/],
  ];

  /** 이모지·기호를 떼고 남은 제목 문자열 (섹션 헤더 판별용) */
  function dmxStripLeadSymbols(line) {
    return String(line || "")
      .replace(/^[\s​]*[^\p{L}\p{N}]{0,4}\s*/u, "")
      .replace(/[\s:：]+$/, "")
      .trim();
  }

  function dmxMatchSectionKey(line) {
    const t = dmxStripLeadSymbols(line);
    if (!t || t.length > 20) return null;
    for (const [key, re] of DMX_SECTION_TITLES) {
      if (re.test(t)) return key;
    }
    return null;
  }

  /** analysis 텍스트를 섹션별로 분해. 헤더를 하나도 못 찾으면 null → 기존 렌더링 폴백 */
  function dmxParseAnalysis(text) {
    const raw = sanitizeStr(text);
    if (!raw) return null;
    const lines = raw.split(/\r?\n/);
    const out = {};
    let cur = null;
    let buf = [];
    let found = 0;
    const flush = () => {
      if (cur) out[cur] = (out[cur] ? out[cur] + "\n" : "") + buf.join("\n").trim();
      buf = [];
    };
    for (const line of lines) {
      const key = dmxMatchSectionKey(line);
      if (key) {
        flush();
        cur = key;
        found += 1;
        continue;
      }
      // 리포트 제목 블록·구분선은 화면 상단 헤더가 대신하므로 버린다
      if (/^[─—–-]{4,}$/.test(line.trim())) continue;
      if (!cur && /TOTAL\s*MONEY\s*AI/i.test(line)) continue;
      if (!cur && /^\d{4}년\s*\d{1,2}월\s*\d{1,2}일/.test(line.trim())) continue;
      if (cur) buf.push(line);
    }
    flush();
    if (found < 2) return null;
    return out;
  }

  /** "-6,399억(순매도)" / "+1조5,000억" / "12,710억원" → 억 단위 숫자 (부호 유지) */
  function dmxParseEok(v) {
    const s = String(v == null ? "" : v).replace(/\s/g, "");
    if (!s) return null;
    let sign = 1;
    if (/^-|순매도/.test(s)) sign = -1;
    if (/^\+/.test(s)) sign = 1;
    const jo = s.match(/([\d,.]+)조/);
    const eok = s.match(/(?:조)?\s*([\d,]+)억/);
    let total = 0;
    let hit = false;
    if (jo) {
      total += parseFloat(jo[1].replace(/,/g, "")) * 10000;
      hit = true;
    }
    if (eok) {
      total += parseFloat(eok[1].replace(/,/g, ""));
      hit = true;
    }
    if (!hit) {
      const bare = s.match(/-?[\d,]+(?:\.\d+)?/);
      if (!bare) return null;
      total = Math.abs(parseFloat(bare[0].replace(/,/g, "")));
    }
    if (!Number.isFinite(total)) return null;
    return sign * total;
  }

  /** 억 단위 숫자를 "1조 5,000억" / "6,399억" 형태로 (소수점 없이) */
  function dmxFmtEok(n) {
    if (n == null || !Number.isFinite(n)) return "";
    const sign = n < 0 ? "-" : "+";
    const abs = Math.round(Math.abs(n));
    if (abs >= 10000) {
      const jo = Math.floor(abs / 10000);
      const rest = abs % 10000;
      return `${sign}${jo}조${rest ? " " + rest.toLocaleString("ko-KR") + "억" : ""}`;
    }
    return `${sign}${abs.toLocaleString("ko-KR")}억`;
  }

  function dmxNum(v) {
    if (v == null) return null;
    const cleaned = String(v).replace(/[^0-9.\-]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === ".") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function dmxSignClass(n) {
    if (n == null || n === 0) return "is-flat";
    return n > 0 ? "is-up" : "is-down";
  }

  function dmxPct(n, digits = 2) {
    if (n == null || !Number.isFinite(n)) return "—";
    const s = n > 0 ? "+" : "";
    return `${s}${n.toFixed(digits)}%`;
  }

  // ── 1) 히어로 (핵심 한 줄) ────────────────────────────────────────
  function dmxRenderHero(day, ymd, sec) {
    const line =
      sanitizeUserCopy(sec && sec.headline ? sec.headline.split(/\n\s*\n/)[0] : "", "") ||
      sanitizeUserCopy(day && day.summary, "");
    if (!line) return "";
    const kospi = day && day.indexes && day.indexes.kospi;
    const pct = kospi ? dmxNum(kospi.changePercent) : null;
    const tone = sanitizeUserCopy((day && day.marketTone) || "", "");
    const dir = pct == null ? "flat" : pct > 0 ? "up" : pct < 0 ? "down" : "flat";
    const dateLabel = ymd ? `${ymdParts(ymd).m}월 ${ymdParts(ymd).d}일 (${weekdayKo(ymd)})` : "";
    return `<section class="dmx-hero dmx-hero--${dir}">
      <div class="dmx-hero__meta">
        <span class="dmx-hero__date">${escapeHtml(dateLabel)} 장마감</span>
        ${tone ? `<span class="dmx-hero__tone">${escapeHtml(tone)}</span>` : ""}
      </div>
      <p class="dmx-hero__line">${escapeHtml(line.replace(/\s+/g, " ").trim())}</p>
    </section>`;
  }

  // ── 2) 지수 카드 (+ 장중 레인지 바) ───────────────────────────────
  function dmxIndexRangeBar(d) {
    const low = dmxNum(d.low);
    const close = dmxNum(d.close);
    const open = dmxNum(d.open);
    let high = dmxNum(d.high);
    const hasHigh = high != null;
    // 장중 고가가 확인되지 않는 날이 많다. 그럴 땐 지어내지 말고 시가·종가 중 큰 값을
    // 오른쪽 끝으로 삼아 "저점 → 종가" 구간만 보여주고, 라벨도 '종'으로 정직하게 쓴다.
    if (!hasHigh) high = Math.max(close == null ? -Infinity : close, open == null ? -Infinity : open);
    if (low == null || close == null || high == null || !Number.isFinite(high) || high <= low) return "";
    const pos = (v) => ((v - low) / (high - low)) * 100;
    const closePos = Math.max(0, Math.min(100, pos(close)));
    const openPos = open == null ? null : Math.max(0, Math.min(100, pos(open)));
    const fmt = (v) => v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    return `<div class="dmx-range" role="img" aria-label="장중 저가 ${fmt(low)}, 고가 ${fmt(high)}, 종가 ${fmt(close)}">
      <div class="dmx-range__track">
        <span class="dmx-range__fill" style="width:${closePos.toFixed(1)}%"></span>
        ${openPos == null ? "" : `<span class="dmx-range__open" style="left:${openPos.toFixed(1)}%" title="시가 ${fmt(open)}"></span>`}
        <span class="dmx-range__close" style="left:${closePos.toFixed(1)}%"></span>
      </div>
      <div class="dmx-range__ends">
        <span>저 ${fmt(low)}</span>
        ${open == null ? "" : `<span class="dmx-range__mid">시 ${fmt(open)}</span>`}
        <span>${hasHigh ? "고" : "종"} ${fmt(high)}</span>
      </div>
    </div>`;
  }

  function dmxRenderIndexCards(day) {
    const idx = day && day.indexes;
    if (!idx || typeof idx !== "object") return "";
    const detail = (day && day.indexDetail) || {};
    const specs = [
      ["kospi", "코스피"],
      ["kosdaq", "코스닥"],
    ];
    const cards = [];
    for (const [key, label] of specs) {
      const d = idx[key];
      if (!d) continue;
      const close = dmxNum(d.close);
      const chg = dmxNum(d.change);
      const pct = dmxNum(d.changePercent != null ? d.changePercent : d.pct);
      if (close == null) continue;
      const cls = dmxSignClass(pct);
      const merged = Object.assign({ close }, detail[key] || {}, {
        low: (detail[key] && detail[key].low) != null ? detail[key].low : d.low,
        high: (detail[key] && detail[key].high) != null ? detail[key].high : d.high,
        open: (detail[key] && detail[key].open) != null ? detail[key].open : d.open,
        close,
      });
      cards.push(`<article class="dmx-idx ${cls}">
        <span class="dmx-idx__label">${escapeHtml(label)}</span>
        <strong class="dmx-idx__value">${close.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
        <span class="dmx-idx__delta">${chg == null ? "" : (chg > 0 ? "+" : "") + chg.toFixed(2)}<em>${escapeHtml(dmxPct(pct))}</em></span>
        ${dmxIndexRangeBar(merged)}
      </article>`);
    }
    const fx = idx.usdkrw;
    if (fx) {
      const rate = dmxNum(fx.rate);
      const fxChg = dmxNum(fx.change);
      if (rate != null) {
        // 환율은 하락(원화 강세)이 증시엔 우호적이라 등락 색을 지수와 반대로 쓰지 않고
        // 중립 톤으로 두되, 방향 화살표만 표시한다.
        cards.push(`<article class="dmx-idx is-fx">
          <span class="dmx-idx__label">원/달러</span>
          <strong class="dmx-idx__value">${rate.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
          <span class="dmx-idx__delta">${fxChg == null ? "" : (fxChg > 0 ? "▲ " : fxChg < 0 ? "▼ " : "") + Math.abs(fxChg).toFixed(2) + "원"}</span>
          ${fx.note ? `<p class="dmx-idx__note">${escapeHtml(sanitizeUserCopy(fx.note, ""))}</p>` : ""}
        </article>`);
      }
    }
    if (!cards.length) return "";
    return `<section class="dmx-block">
      <h4 class="dmx-block__title">지수 마감</h4>
      <div class="dmx-idx-grid">${cards.join("")}</div>
    </section>`;
  }

  // ── 3) 시장 스코어보드 (전부 코드가 실데이터로 계산) ─────────────
  function dmxRenderScoreboard(day) {
    if (!day) return "";
    const gainers = Array.isArray(day.topGainers) ? day.topGainers : [];
    const losers = Array.isArray(day.topDecliners) ? day.topDecliners : [];
    const tv = Array.isArray(day.topTradingValue) ? day.topTradingValue : [];
    if (!gainers.length && !losers.length && !tv.length) return "";
    const chg = (r) => dmxNum(r && r.change);
    const limitUp = gainers.filter((r) => (chg(r) || 0) >= 29.5).length;
    const limitDown = losers.filter((r) => (chg(r) || 0) <= -29.5).length;
    const over20 = gainers.filter((r) => (chg(r) || 0) >= 20).length;
    const tv10 = tv.slice(0, 10);
    const tvUp = tv10.filter((r) => (chg(r) || 0) > 0).length;
    const items = [];
    const cap = (n, total) => (n >= total && total >= 30 ? `${n}+` : String(n));
    if (gainers.length) items.push(["상한가", cap(limitUp, gainers.length) + "종목", limitUp > 0 ? "is-up" : "is-flat"]);
    if (gainers.length) items.push(["+20% 이상", cap(over20, gainers.length) + "종목", over20 > 0 ? "is-up" : "is-flat"]);
    if (losers.length) items.push(["하한가", cap(limitDown, losers.length) + "종목", limitDown > 0 ? "is-down" : "is-flat"]);
    if (tv10.length) items.push(["거래대금 TOP10 중 상승", `${tvUp} / ${tv10.length}`, tvUp * 2 > tv10.length ? "is-up" : "is-down"]);
    if (tv.length && tv[0]) items.push(["거래대금 1위", sanitizeUserCopy(tv[0].name, "—"), "is-flat"]);
    if (!items.length) return "";
    return `<section class="dmx-block">
      <h4 class="dmx-block__title">오늘의 시장 온도<span class="dmx-block__tag">실데이터 집계</span></h4>
      <div class="dmx-score">${items
        .map(
          ([k, v, cls]) =>
            `<div class="dmx-score__item ${cls}"><span class="dmx-score__k">${escapeHtml(k)}</span><strong class="dmx-score__v">${escapeHtml(v)}</strong></div>`
        )
        .join("")}</div>
      <p class="dmx-note">상승률·하락률·거래대금 TOP30 마감 데이터에서 집계한 값입니다. TOP30을 넘는 구간은 "30+"로 표시합니다.</p>
    </section>`;
  }

  // ── 4) 투자자 수급 다이버징 차트 ──────────────────────────────────
  const DMX_INVESTOR_ROWS = [
    ["individual", "개인"],
    ["foreign", "외국인"],
    ["institution", "기관"],
    ["etc", "기타법인"],
  ];

  function dmxSupplyRows(obj) {
    if (!obj || typeof obj !== "object") return [];
    const rows = [];
    for (const [key, name] of DMX_INVESTOR_ROWS) {
      const v = dmxParseEok(obj[key]);
      if (v == null) continue;
      rows.push({ name, value: v });
    }
    return rows;
  }

  function dmxSupplyGroup(label, rows, sharedMax) {
    if (!rows || !rows.length) return null;
    const max = sharedMax || Math.max(...rows.map((r) => Math.abs(r.value)), 1);
    const bars = rows
      .map((r) => {
        const w = (Math.abs(r.value) / max) * 50;
        const side = r.value >= 0 ? "right" : "left";
        return `<div class="dmx-bar-row">
          <span class="dmx-bar-row__name">${escapeHtml(r.name)}</span>
          <span class="dmx-bar-row__track">
            <span class="dmx-bar dmx-bar--${side} ${r.value >= 0 ? "is-up" : "is-down"}" style="width:${w.toFixed(1)}%"></span>
          </span>
          <span class="dmx-bar-row__val ${r.value >= 0 ? "is-up" : "is-down"}">${escapeHtml(dmxFmtEok(r.value))}</span>
        </div>`;
      })
      .join("");
    return `<div class="dmx-supply-group">
      <h5 class="dmx-supply-group__title">${escapeHtml(label)}</h5>
      <div class="dmx-bars">${bars}</div>
    </div>`;
  }

  function dmxRenderSupply(day, sec) {
    const t = day && day.investor_trend;
    const groups = [];
    if (t) {
      const kospiRows = dmxSupplyRows(t.kospi);
      const kosdaqRows = dmxSupplyRows(t.kosdaq);
      const sharedMax = Math.max(
        ...kospiRows.concat(kosdaqRows).map((r) => Math.abs(r.value)),
        1
      );
      const a = dmxSupplyGroup("코스피", kospiRows, sharedMax);
      const b = dmxSupplyGroup("코스닥", kosdaqRows, sharedMax);
      if (a) groups.push(a);
      if (b) groups.push(b);
    }
    // 수급 섹션 본문에서 숫자 나열 줄은 버리고 해석 문장만 남긴다
    // (같은 숫자를 차트와 문장이 두 번 말하면 지면만 잡아먹는다)
    let comment = sanitizeUserCopy(day && day.supplyComment, "");
    if (!comment && sec && sec.investor) {
      comment = sec.investor
        .split(/\r?\n/)
        .filter((l) => {
          const s = l.trim();
          if (!s) return false;
          if (/^(코스피|코스닥)$/.test(s)) return false;
          if (/^(개인|외국인|기관|기타법인)\s/.test(s)) return false;
          return true;
        })
        .join(" ")
        .replace(/^핵심\s*[:：]\s*/, "")
        .trim();
    }
    if (!groups.length && !comment) return "";
    return `<section class="dmx-block">
      <h4 class="dmx-block__title">투자자별 매매 동향</h4>
      ${groups.length ? `<div class="dmx-supply">${groups.join("")}</div><p class="dmx-note">코스피·코스닥 막대는 같은 기준으로 그려 서로 크기를 직접 비교할 수 있습니다.</p>` : ""}
      ${comment ? `<p class="dmx-callout">${escapeHtml(comment)}</p>` : ""}
    </section>`;
  }

  // ── 5) 업종별 등락 랭킹 ───────────────────────────────────────────
  function dmxRenderSectors(day) {
    const arr = Array.isArray(day && day.sectors) ? day.sectors : [];
    const rows = arr
      .map((s) => ({
        name: sanitizeUserCopy(s && s.name, ""),
        value: dmxNum(s && (s.change_pct != null ? s.change_pct : s.changePercent)),
      }))
      .filter((r) => r.name && r.value != null);
    if (rows.length < 2) return "";
    rows.sort((a, b) => b.value - a.value);
    const ups = rows.filter((r) => r.value > 0).slice(0, 5);
    const downs = rows.filter((r) => r.value < 0).slice(-5).reverse();
    const max = Math.max(...rows.map((r) => Math.abs(r.value)), 0.1);
    const bar = (r) =>
      `<div class="dmx-bar-row">
        <span class="dmx-bar-row__name">${escapeHtml(r.name)}</span>
        <span class="dmx-bar-row__track dmx-bar-row__track--single">
          <span class="dmx-bar ${r.value >= 0 ? "is-up" : "is-down"}" style="width:${((Math.abs(r.value) / max) * 100).toFixed(1)}%"></span>
        </span>
        <span class="dmx-bar-row__val ${r.value >= 0 ? "is-up" : "is-down"}">${escapeHtml(dmxPct(r.value))}</span>
      </div>`;
    return `<section class="dmx-block">
      <h4 class="dmx-block__title">업종별 등락</h4>
      <div class="dmx-sector">
        ${ups.length ? `<div class="dmx-sector__col"><h5 class="dmx-sector__title is-up">강세 업종</h5><div class="dmx-bars">${ups.map(bar).join("")}</div></div>` : ""}
        ${downs.length ? `<div class="dmx-sector__col"><h5 class="dmx-sector__title is-down">약세 업종</h5><div class="dmx-bars">${downs.map(bar).join("")}</div></div>` : ""}
      </div>
    </section>`;
  }

  // ── 6) 외국인·기관 순매수 상위 ────────────────────────────────────
  function dmxLeaderCol(label, arr) {
    const rows = (Array.isArray(arr) ? arr : [])
      .map((r) => ({ name: sanitizeUserCopy(r && r.name, ""), amount: sanitizeUserCopy(r && r.amount, "") }))
      .filter((r) => r.name)
      .slice(0, 5);
    if (!rows.length) return "";
    return `<div class="dmx-leader__col">
      <h5 class="dmx-leader__title">${escapeHtml(label)} 순매수 상위</h5>
      <ol class="dmx-leader__list">${rows
        .map(
          (r, i) =>
            `<li><span class="dmx-leader__rank">${i + 1}</span><span class="dmx-leader__name">${escapeHtml(r.name)}</span><span class="dmx-leader__amt">${escapeHtml(r.amount)}</span></li>`
        )
        .join("")}</ol>
    </div>`;
  }

  function dmxRenderLeaders(day) {
    const l = day && day.netBuyLeaders;
    if (!l || typeof l !== "object") return "";
    const cols = [dmxLeaderCol("외국인", l.foreign), dmxLeaderCol("기관", l.institution)].filter(Boolean);
    if (!cols.length) return "";
    return `<section class="dmx-block">
      <h4 class="dmx-block__title">기관·외국인이 담은 종목</h4>
      <div class="dmx-leader">${cols.join("")}</div>
    </section>`;
  }

  // ── 7) 시장 흐름 분석 (문단 카드 + 인용) ─────────────────────────
  function dmxRenderFlow(sec) {
    const text = sec && sec.flow ? sec.flow : "";
    const paras = String(text)
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
      .filter(Boolean);
    if (!paras.length) return "";
    const html = paras
      .map((p, i) => {
        const isQuote = /(연구원|애널리스트|위원|센터장)[은는이가]?\s*["“]/.test(p) || /["”]\s*(라)?고\s*(설명|밝혔|말했|전했)/.test(p);
        if (isQuote) return `<blockquote class="dmx-quote">${renderMarkdownBold(p)}</blockquote>`;
        return `<p class="dmx-para"><span class="dmx-para__idx" aria-hidden="true">${i + 1}</span>${renderMarkdownBold(p)}</p>`;
      })
      .join("");
    return `<section class="dmx-block">
      <h4 class="dmx-block__title">시장 흐름</h4>
      <div class="dmx-flow">${html}</div>
    </section>`;
  }

  // ── 8) 향후 전략 ──────────────────────────────────────────────────
  function dmxRenderStrategy(day, sec) {
    const st = (day && day.strategy) || {};
    const kospi = sanitizeUserCopy(st.kospi, "");
    const kosdaq = sanitizeUserCopy(st.kosdaq, "");
    let body = "";
    if (kospi || kosdaq) {
      body = `<div class="dmx-strat">
        ${kospi ? `<div class="dmx-strat__col"><h5 class="dmx-strat__title">코스피</h5><p>${renderMarkdownBold(kospi)}</p></div>` : ""}
        ${kosdaq ? `<div class="dmx-strat__col"><h5 class="dmx-strat__title">코스닥</h5><p>${renderMarkdownBold(kosdaq)}</p></div>` : ""}
      </div>`;
    } else if (sec && sec.strategy) {
      const paras = String(sec.strategy)
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
        .filter(Boolean);
      if (!paras.length) return "";
      body = `<div class="dmx-flow">${paras.map((p) => `<p class="dmx-para dmx-para--plain">${renderMarkdownBold(p)}</p>`).join("")}</div>`;
    }
    if (!body) return "";
    const tag = sanitizeUserCopy(st.market_type, "");
    return `<section class="dmx-block">
      <h4 class="dmx-block__title">향후 전략${tag ? `<span class="dmx-block__tag">${escapeHtml(tag)}</span>` : ""}</h4>
      ${body}
    </section>`;
  }

  // ── 9) 특징주 (급등/급락 분리 + 등락률 바 + 리스크 한 줄) ─────────
  function dmxFeaturedCard(row, maxAbs) {
    const chg = parseChange(row.change);
    const isUp = row.type === "급등" || (row.type !== "급락" && (chg == null || chg >= 0));
    const reason = sanitizeUserCopy(row.reason || row.entryReason, "");
    const point = sanitizeUserCopy(row.point || row.background, "");
    const risk = sanitizeUserCopy(row.risk, "");
    const priceText = row.price != null && row.price !== "" ? sanitizeUserCopy(String(row.price), "") : "";
    const priceLabel = priceText ? (/원\s*$/.test(priceText) ? priceText : `${priceText}원`) : "";
    const code = sanitizeUserCopy(row.code, "");
    const w = chg == null || !maxAbs ? 0 : Math.min(100, (Math.abs(chg) / maxAbs) * 100);
    return `<article class="dmx-stock ${isUp ? "is-up" : "is-down"}">
      <header class="dmx-stock__head">
        <div class="dmx-stock__id">
          <strong class="dmx-stock__name">${escapeHtml(sanitizeUserCopy(row.name, ""))}</strong>
          ${code ? `<span class="dmx-stock__code">${escapeHtml(code)}</span>` : ""}
        </div>
        <div class="dmx-stock__nums">
          ${priceLabel ? `<span class="dmx-stock__price">${escapeHtml(priceLabel)}</span>` : ""}
          <span class="dmx-stock__chg ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span>
        </div>
      </header>
      <div class="dmx-stock__bar"><span style="width:${w.toFixed(1)}%"></span></div>
      ${reason ? `<p class="dmx-stock__row"><em>재료</em><span>${escapeHtml(reason)}</span></p>` : ""}
      ${point ? `<p class="dmx-stock__row"><em>포인트</em><span>${escapeHtml(point)}</span></p>` : ""}
      ${risk ? `<p class="dmx-stock__row dmx-stock__row--risk"><em>리스크</em><span>${escapeHtml(risk)}</span></p>` : ""}
    </article>`;
  }

  function dmxRenderFeatured(arr) {
    if (!Array.isArray(arr) || !arr.length) {
      return '<p class="empty-line">특징주 분석 없음</p>';
    }
    const withChg = arr.map((r) => ({ row: r, chg: parseChange(r.change) }));
    const maxAbs = Math.max(...withChg.map((x) => Math.abs(x.chg == null ? 0 : x.chg)), 1);
    const ups = withChg.filter((x) => x.row.type === "급등" || (x.row.type !== "급락" && (x.chg == null || x.chg >= 0)));
    const downs = withChg.filter((x) => !ups.includes(x));
    const group = (label, list, cls) =>
      list.length
        ? `<div class="dmx-stock-group">
             <h5 class="dmx-stock-group__title ${cls}">${escapeHtml(label)}<span>${list.length}종목</span></h5>
             <div class="dmx-stock-grid">${list.map((x) => dmxFeaturedCard(x.row, maxAbs)).join("")}</div>
           </div>`
        : "";
    return group("급등", ups, "is-up") + group("급락", downs, "is-down");
  }

  // ── 10) 내일 주목할 변수 ──────────────────────────────────────────
  function dmxRenderWatchlist(arr) {
    if (!Array.isArray(arr) || !arr.length) {
      return '<p class="empty-line">내일 주목할 변수 없음</p>';
    }
    // "1. ~ 2. ~ 3. ~"이 한 항목에 뭉쳐 들어온 경우 번호 기준으로 다시 쪼갠다
    // (생성 프롬프트에서도 줄 분리를 지시했지만, 과거 데이터까지 살리기 위한 방어)
    const items = [];
    for (const raw of arr) {
      const t = sanitizeUserCopy(raw, "");
      if (!t) continue;
      const parts = t.split(/(?=(?:^|\s)[1-9][.)]\s)/).map((x) => x.trim()).filter(Boolean);
      if (parts.length > 1) items.push(...parts);
      else items.push(t);
    }
    if (!items.length) return '<p class="empty-line">내일 주목할 변수 없음</p>';
    // 번호도 줄바꿈도 없이 한 문단으로 들어온 과거 데이터 방어 — 문장 경계에서만 끊어
    // 비슷한 길이의 덩어리로 재조립한다(내용을 바꾸지 않고 나누기만 한다).
    if (items.length === 1 && items[0].length > 220) {
      const sentences = items[0].match(/[^.!?]+[.!?]+\s*/g) || [];
      if (sentences.length >= 4) {
        const target = Math.ceil(sentences.length / Math.min(4, Math.ceil(sentences.length / 2)));
        const chunks = [];
        for (let i = 0; i < sentences.length; i += target) {
          chunks.push(sentences.slice(i, i + target).join("").trim());
        }
        if (chunks.length > 1) items.length = 0, items.push(...chunks);
      }
    }
    return `<ol class="dmx-watch">${items
      .slice(0, 6)
      .map((t) => `<li class="dmx-watch__item">${escapeHtml(t.replace(/^[1-9][.)]\s*/, ""))}</li>`)
      .join("")}</ol>`;
  }

  // ── 조립 ──────────────────────────────────────────────────────────
  /**
   * 2026-09-02: 섹션 헤더가 없는 구형 analysis(예: 2026-07-01)는 dmxParseAnalysis가 null을 반환해
   * 시장 흐름/전략 같은 본문 블록이 통째로 비는데, 지수·수급 같은 구조화 블록은 그대로 그려지는 바람에
   * 덱이 "비어있지 않다"고 판정돼 상위의 줄글 폴백 경로까지 막혀 본문이 화면에서 사라졌다.
   * 파싱 실패 시에는 원문 줄글을 덱 안에 한 블록으로 넣어 어떤 경우에도 본문이 유실되지 않게 한다.
   */
  function dmxRenderProseFallback(day, sec) {
    if (sec) return "";
    const text = sanitizeUserCopy(getAnalysisDisplayText(day), "");
    if (!text) return "";
    return `<section class="dmx-block">
      <h4 class="dmx-block__title">AI 종합분석</h4>
      <div class="dmx-prose">${renderMarkdownBold(text)}</div>
    </section>`;
  }

  function dmxRenderDeck(day, ymd) {
    const sec = dmxParseAnalysis(day && day.analysis);
    const parts = [
      dmxRenderHero(day, ymd, sec),
      dmxRenderIndexCards(day),
      dmxRenderScoreboard(day),
      dmxRenderFlow(sec),
      dmxRenderProseFallback(day, sec),
      dmxRenderSupply(day, sec),
      dmxRenderSectors(day),
      dmxRenderLeaders(day),
    ].filter(Boolean);
    if (!parts.length) return "";
    return parts.join("");
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
        const priceText = row.price != null && row.price !== "" ? sanitizeUserCopy(String(row.price), "") : "";
        const priceLabel = priceText ? (/원\s*$/.test(priceText) ? priceText : `${priceText}원`) : "";
        return `<article class="dm-featured-card">
          <header class="dm-featured-card__head">
            <div class="dm-featured-card__title">
              <span class="dm-badge ${badgeClass}">${badgeLabel}</span>
              <strong class="dm-featured-card__name">${escapeHtml(row.name)}</strong>
            </div>
            <span class="dm-featured-card__metrics">
              ${priceLabel ? `<span class="dm-featured-card__price">${escapeHtml(priceLabel)}</span>` : ""}
              <span class="delta ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span>
            </span>
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

  /* 2026-09-02: 모바일에서 마감시황 AI 탭이 6,300px(7.5화면)까지 늘어났다.
     브리핑과 같은 방식으로, 핵심 두 블록만 펼쳐 두고 나머지는 제목만 남기는 접이식으로
     바꾼다. 내용을 잘라내는 게 아니라 탭하면 그대로 펼쳐지고, 데스크톱은 종전대로 전부 펼침. */
  const DMX_OPEN_ON_MOBILE = /(지수 마감|오늘의 시장 온도)/;

  function dmxIsMobile() {
    return window.matchMedia("(max-width: 768px)").matches;
  }

  function dmxFoldOne(box, title, openRe, mobile) {
    if (!box || !title) return;
    if (box.dataset.foldReady !== "1") {
      const rest = [...box.children].filter((el) => el !== title);
      if (!rest.length) return;
      const wrap = document.createElement("div");
      wrap.className = "dmx-fold";
      rest.forEach((el) => wrap.appendChild(el));
      box.appendChild(wrap);
      const chev = document.createElement("span");
      chev.className = "dmx-chev";
      chev.setAttribute("aria-hidden", "true");
      chev.textContent = "\u2304";
      title.appendChild(chev);
      title.classList.add("dmx-toggle");
      title.setAttribute("role", "button");
      title.setAttribute("tabindex", "0");
      const toggle = () => {
        if (!dmxIsMobile()) return;
        const folded = box.classList.toggle("is-folded");
        title.setAttribute("aria-expanded", folded ? "false" : "true");
      };
      title.addEventListener("click", toggle);
      title.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
      box.dataset.foldReady = "1";
    }
    const keepOpen = !mobile || openRe.test(title.textContent || "");
    box.classList.toggle("is-folded", !keepOpen);
    title.setAttribute("aria-expanded", keepOpen ? "true" : "false");
  }

  function dmxApplyFolds() {
    const mobile = dmxIsMobile();
    document.querySelectorAll(".dm-tab-panel[data-dm-panel='ai'] .dmx-block").forEach((box) => {
      dmxFoldOne(box, box.querySelector(".dmx-block__title"), DMX_OPEN_ON_MOBILE, mobile);
    });
    document.querySelectorAll(".dm-tab-panel[data-dm-panel='ai'] .dm-section").forEach((box) => {
      const title = box.querySelector(":scope > .dm-section__title");
      if (!title) return;
      dmxFoldOne(box, title, DMX_OPEN_ON_MOBILE, mobile);
    });
  }

  function renderAiPanels() {
    const ymd = selectedYmd();
    const day = getRenderableDay(ymd);
    if (els.dmAnalysis) {
      // 2026-09-01: 섹션 파싱에 성공하면 브리핑 덱으로, 실패하면 기존 줄글 렌더링으로 폴백.
      // 과거 데이터(섹션 헤더가 없던 시절)도 깨지지 않게 하기 위한 이중 경로다.
      let deck = "";
      try {
        deck = dmxRenderDeck(day, ymd);
      } catch (err) {
        console.warn("[마감시황] 덱 렌더 실패 — 줄글로 폴백", err);
        deck = "";
      }
      if (deck) {
        els.dmAnalysis.innerHTML = deck;
        els.dmAnalysis.classList.add("dmx-on");
      } else {
        els.dmAnalysis.classList.remove("dmx-on");
        const analysisText = sanitizeUserCopy(getAnalysisDisplayText(day), "AI 분석을 준비 중입니다");
        els.dmAnalysis.innerHTML = analysisText
          ? `<div class="dm-analysis__body">${renderMarkdownBold(analysisText)}</div>`
          : '<p class="empty-line">종합분석 없음</p>';
      }
    }
    if (els.dmFeatured) {
      let html = "";
      try {
        html = dmxRenderFeatured(getFeaturedStocks(day));
      } catch (err) {
        console.warn("[마감시황] 특징주 렌더 실패 — 기존 카드로 폴백", err);
        html = renderFeatured(getFeaturedStocks(day));
      }
      els.dmFeatured.innerHTML = html;
    }
    if (els.dmWatchlist) {
      let html = "";
      try {
        html = dmxRenderWatchlist(getWatchlist(day));
      } catch (err) {
        console.warn("[마감시황] 내일 변수 렌더 실패 — 기존 목록으로 폴백", err);
        html = `<ol>${renderWatchlist(getWatchlist(day))}</ol>`;
      }
      els.dmWatchlist.innerHTML = html;
    }
    if (els.dmStrategy) {
      let html = "";
      try {
        html = dmxRenderStrategy(day, dmxParseAnalysis(day && day.analysis));
      } catch (err) {
        console.warn("[마감시황] 전략 렌더 실패", err);
        html = "";
      }
      els.dmStrategy.innerHTML = html;
      const wrap = els.dmStrategy.closest(".dm-section");
      if (wrap) wrap.hidden = !html;
    }
    dmxApplyFolds();
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

  (function bindDmxFoldResize() {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = () => dmxApplyFolds();
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", handler);
    else if (typeof mq.addListener === "function") mq.addListener(handler);
  })();

  function bindEvents() {
    document.querySelectorAll("[data-dm-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setMainTab(btn.dataset.dmTab));
    });

    if (els.dmTabDate) {
      els.dmTabDate.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleDatePicker();
      });
    }

    if (els.dmCalGrid) {
      els.dmCalGrid.addEventListener("click", (e) => {
        const cell = e.target.closest("[data-ymd]");
        if (cell && cell.dataset.ymd) void selectDate(cell.dataset.ymd);
      });
    }

    if (els.dmCalPrev) {
      els.dmCalPrev.addEventListener("click", (e) => {
        e.stopPropagation();
        shiftCalendarMonth(-1);
      });
    }
    if (els.dmCalNext) {
      els.dmCalNext.addEventListener("click", (e) => {
        e.stopPropagation();
        shiftCalendarMonth(1);
      });
    }

    document.addEventListener("click", (e) => {
      if (!state.datePickerOpen) return;
      if (els.dmTabDate && els.dmTabDate.contains(e.target)) return;
      if (els.dmDatePicker && els.dmDatePicker.contains(e.target)) return;
      closeDatePicker();
      updateDateNav();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.datePickerOpen) {
        closeDatePicker();
        updateDateNav();
      }
    });

    window.addEventListener("hashchange", async () => {
      const h = (location.hash || "").replace("#", "");
      if (!YMD_RE.test(h) || !isDateSelectable(h)) {
        const page = location.pathname.split("/").pop() || "daily-market.html";
        history.replaceState(null, "", page);
        return;
      }
      if (h !== state.selected) await selectDate(h);
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
    if (location.hash) {
      const page = location.pathname.split("/").pop() || "daily-market.html";
      history.replaceState(null, "", page);
    }
    renderBootState();
    bindEvents();
    try {
      await Promise.all([loadData(), loadKrTv()]);
      state.defaultYmd = resolveDefaultYmd();
      state.selected = resolveInitialYmd();
      state.mainTab = "ai";
      state.calendarMonthYmd = `${state.selected.slice(0, 7)}-01`;
      syncHash(state.selected);
      await ensureDayLoaded(state.selected, { deferLive: true });
    } catch (e) {
      console.warn("daily-market init failed", e && e.message);
    }
    setMainTab("ai");
    render();
  }

  main();
})();
