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
  const DASHBOARD_API = "/api/dashboard-data";
  const LIVE_FETCH_TIMEOUT_MS = 15000;
  const LIVE_TOP_N = 30;

  let liveLoadPromise = null;
  let dashboardLoadGen = 0;
  const dashboardState = {
    supplyMarket: "KOSPI",
    jointTab: "buy",
    jointData: null,
  };

  const state = {
    meta: { title: "마감시황", timezoneNote: "" },
    jsonDate: null,
    days: {},
    selected: null,
    todayYmd: null,
    defaultYmd: null,
    dataMissing: false,
    liveMode: false,
    liveRowsByTab: { gainers: [], losers: [], tv: [] },
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
    dmIndexes: $("dm-indexes"),
    dmMarketExtras: $("dm-market-extras"),
    dmAnalysis: $("dm-analysis"),
    dmFeatured: $("dm-featured"),
    dmWatchlist: $("dm-watchlist"),
    dmStockTbody: $("dm-stock-tbody"),
    dmStockThead: $("dm-stock-thead-row"),
    dmStockTable: $("dm-stock-table"),
    dmMissing: $("dm-missing"),
    dmTabPanels: $("dm-tab-panels"),
    dmDateLabel: $("dm-date-label"),
    dmDatePrev: $("dm-date-prev"),
    dmDateNext: $("dm-date-next"),
    dmLiveBadge: $("dm-live-badge"),
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
    const { m, d } = ymdParts(ymd);
    return `${m}월 ${d}일`;
  }

  function resolveDefaultYmd() {
    return state.todayYmd || seoulYmd();
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

  /** daily-market.json date(또는 days[오늘].date)가 KST 오늘과 같으면 AI 리포트 반영 완료 */
  function isTodayReportPublished() {
    const today = state.todayYmd;
    if (!today) return false;
    const todayDay = getTodayDayEntry();
    if (todayDay) {
      const dayDate = getDayDateYmd(todayDay, "");
      if (dayDate === today) return true;
      if (dayDate && dayDate !== today) return false;
    }
    const jsonDate = getJsonReportDate();
    if (jsonDate) return jsonDate === today;
    return false;
  }

  /** AI 리포트 본문·특징주 데이터가 있으면 준비중 해제 */
  function hasAiReportContent(day) {
    if (!day || typeof day !== "object") return false;
    if (sanitizeStr(day.analysis || day.summary || day.marketSummary).length > 0) return true;
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
    const ymd = state.selected;
    const day = state.dataMissing ? null : getDay(ymd);
    const displayYmd = getDayDateYmd(day, ymd);
    if (els.dmDateLabel) els.dmDateLabel.textContent = shortDateLabel(displayYmd);
    if (els.dmDateNext) {
      const next = skipWeekendNext(ymd);
      els.dmDateNext.disabled = ymd >= today || next > today;
    }
  }

  async function ensureDayLoaded(ymd) {
    if (state.days[ymd] && !isDayEmpty(state.days[ymd])) {
      state.dataMissing = false;
      if (needsLiveRealtime(ymd)) await loadLiveStockData();
      else state.liveMode = false;
      return true;
    }
    const archive = await fetchArchiveDayJson(ymd);
    const normalized = normalizeArchiveDay(archive, ymd);
    if (normalized && !isDayEmpty(normalized)) {
      state.days[ymd] = normalized;
      state.dataMissing = false;
      if (needsLiveRealtime(ymd)) await loadLiveStockData();
      else state.liveMode = false;
      return true;
    }
    if (ymd === state.todayYmd) {
      state.dataMissing = false;
      if (needsLiveRealtime(ymd)) {
        await loadLiveStockData();
        return true;
      }
    }
    state.dataMissing = true;
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
    const hasTv = Array.isArray(day.topTradingValue) && day.topTradingValue.length > 0;
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
    const hasTv = Array.isArray(day.topTradingValue) && day.topTradingValue.length > 0;
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
      } catch (e) {
        console.warn("[daily-market] live stock load failed", e && e.message);
      } finally {
        liveLoadPromise = null;
      }
    })();
    return liveLoadPromise;
  }

  function updateLiveBadge() {
    if (!els.dmLiveBadge) return;
    const show =
      state.liveMode &&
      state.selected === state.todayYmd &&
      !state.dataMissing &&
      (STOCK_TABS.includes(state.mainTab) || STOCK_TABS.some((t) => (state.liveRowsByTab[t] || []).length));
    els.dmLiveBadge.hidden = !show;
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

  function syncStockThead(subTab) {
    if (els.dmStockTable) els.dmStockTable.setAttribute("data-dm-stock-tab", subTab || "gainers");
    if (els.dmStockThead) els.dmStockThead.innerHTML = stockTheadHtml(subTab);
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
      if (Array.isArray(day.topTradingValue) && day.topTradingValue.length) {
        rows = [...day.topTradingValue];
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
      } else if (state.krTv && state.krTv.length) {
        rows = state.krTv.map(normalizeKrTvRow);
      }
      rows.sort((a, b) => tvSortValue(b) - tvSortValue(a));
    }
    return rows.slice(0, 30).map(normalizeDailyStockRow);
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
    document.querySelectorAll("[data-dm-panel]").forEach((panel) => {
      const panelId = panel.dataset.dmPanel;
      const on = panelId === tabId || (STOCK_TABS.includes(tabId) && panelId === "stocks");
      panel.hidden = !on;
      panel.classList.toggle("is-active", on);
    });
    if (STOCK_TABS.includes(tabId)) {
      syncStockThead(state.stockSubTab);
      if (needsLiveRealtime(state.selected)) {
        void loadLiveStockData().then(() => {
          renderStockTable();
          updateLiveBadge();
        });
      } else {
        renderStockTable();
      }
    }
    if (tabId === "dashboard") refreshDashboardLive();
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
    const subTab = state.stockSubTab;
    syncStockThead(subTab);
    const day = getDay(state.selected);
    const rows = getStockRows(day, subTab);
    const tbody = els.dmStockTbody;
    if (!tbody) return;
    const colSpan = 8;

    if (!rows.length) {
      const label =
        subTab === "gainers" ? "상승률" : subTab === "losers" ? "하락률" : "거래대금";
      tbody.innerHTML = `<tr><td colspan="${colSpan}" class="dm-stock-empty">${label} TOP30 데이터 준비중</td></tr>`;
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

  function formatEokJoEok(n0) {
    const n = Math.abs(Number(String(n0).replace(/,/g, "")));
    if (!Number.isFinite(n) || n === 0) return "0억";
    if (n >= 10000) return `${(n / 10000).toFixed(1)}조`;
    if (n >= 100) return `${n.toFixed(1)}억`;
    return `${Math.round(n)}억`;
  }

  function formatSignedEok(n) {
    if (n == null || !Number.isFinite(n)) return { text: "—", cls: "" };
    if (n === 0) return { text: "0억", cls: "" };
    const sign = n > 0 ? "+" : "-";
    return {
      text: `${sign}${formatEokJoEok(Math.abs(n))}`,
      cls: n > 0 ? "dm-up" : "dm-down",
    };
  }

  function signedEokClass(n) {
    if (n == null || !Number.isFinite(n) || n === 0) return "";
    return n > 0 ? "dm-up" : "dm-down";
  }

  function formatSignedEokPlain(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n === 0) return "0억";
    const sign = n > 0 ? "+" : "-";
    return `${sign}${formatEokJoEok(Math.abs(n))}`;
  }

  function isDashboardLiveDay() {
    return state.selected === state.todayYmd;
  }

  function dashboardErrHtml() {
    return '<p class="dm-dash-err">데이터를 불러올 수 없습니다</p>';
  }

  function dashboardPastDayHtml() {
    return '<p class="dm-dash-err">오늘 날짜에서만 실시간 조회됩니다</p>';
  }

  function fundSkeletonHtml() {
    return `<div class="dm-skeleton" aria-hidden="true">
      <span class="dm-skeleton__line dm-skeleton__line--lg"></span>
      <span class="dm-skeleton__line dm-skeleton__line--sm"></span>
    </div>`;
  }

  function investorSkeletonHtml() {
    return `<div class="dm-investor-grid">${[0, 1, 2]
      .map(
        () =>
          `<div class="dm-investor-item"><span class="dm-skeleton__line dm-skeleton__line--sm"></span><span class="dm-skeleton__line dm-skeleton__line--lg"></span></div>`
      )
      .join("")}</div>`;
  }

  function jointSkeletonHtml() {
    return `<div class="dm-skeleton" aria-hidden="true">${[0, 1, 2, 3, 4]
      .map(() => `<span class="dm-skeleton__line dm-skeleton__line--row"></span>`)
      .join("")}</div>`;
  }

  async function fetchDashboard(action, extra = {}) {
    const params = new URLSearchParams({ action });
    Object.entries(extra).forEach(([k, v]) => {
      if (v != null && v !== "") params.set(k, String(v));
    });
    const res = await fetch(`${DASHBOARD_API}?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP");
    const data = await res.json();
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  function renderFundPanel(mode, data) {
    const deposit = $("dm-fund-deposit-body");
    const credit = $("dm-fund-credit-body");
    if (!deposit || !credit) return;
    if (!isDashboardLiveDay()) {
      deposit.innerHTML = dashboardPastDayHtml();
      credit.innerHTML = dashboardPastDayHtml();
      return;
    }
    if (mode === "loading") {
      deposit.innerHTML = fundSkeletonHtml();
      credit.innerHTML = fundSkeletonHtml();
      return;
    }
    if (mode === "error" || !data) {
      deposit.innerHTML = dashboardErrHtml();
      credit.innerHTML = dashboardErrHtml();
      return;
    }
    const depVal = formatEokJoEok(data.custDepositEok);
    const depChg = formatSignedEok(data.custDepositChangeEok);
    deposit.innerHTML = `<span class="dm-fund-card__value">${escapeHtml(depVal)}</span>
      <span class="dm-fund-card__delta ${escapeHtml(depChg.cls)}">전일대비 ${escapeHtml(depChg.text)}</span>`;

    const crVal = formatEokJoEok(data.creditLoanEok);
    const crChg = formatSignedEok(data.creditLoanChangeEok);
    credit.innerHTML = `<span class="dm-fund-card__value">${escapeHtml(crVal)}</span>
      <span class="dm-fund-card__delta ${escapeHtml(crChg.cls)}">전일대비 ${escapeHtml(crChg.text)}</span>`;
  }

  function renderInvestorPanel(mode, data) {
    const panel = $("dm-investor-panel");
    if (!panel) return;
    if (!isDashboardLiveDay()) {
      panel.innerHTML = dashboardPastDayHtml();
      return;
    }
    if (mode === "loading") {
      panel.innerHTML = investorSkeletonHtml();
      return;
    }
    if (mode === "error" || !data) {
      panel.innerHTML = dashboardErrHtml();
      return;
    }
    const items = [
      { label: "외국인", val: data.foreign },
      { label: "기관", val: data.institution },
      { label: "개인", val: data.individual },
    ];
    panel.innerHTML = `<div class="dm-investor-grid">${items
      .map((item) => {
        const cls = signedEokClass(item.val);
        return `<div class="dm-investor-item">
          <span class="dm-investor-item__label">${escapeHtml(item.label)}</span>
          <span class="dm-investor-item__value ${escapeHtml(cls)}">${escapeHtml(formatSignedEokPlain(item.val))}</span>
        </div>`;
      })
      .join("")}</div>`;
  }

  function renderJointPanel(mode, data) {
    const panel = $("dm-joint-panel");
    if (!panel) return;
    if (!isDashboardLiveDay()) {
      panel.innerHTML = dashboardPastDayHtml();
      return;
    }
    if (mode === "loading") {
      panel.innerHTML = jointSkeletonHtml();
      return;
    }
    if (mode === "error" || !data) {
      panel.innerHTML = dashboardErrHtml();
      return;
    }
    const tab = dashboardState.jointTab;
    const rows = Array.isArray(tab === "buy" ? data.buy : data.sell) ? (tab === "buy" ? data.buy : data.sell) : [];
    if (!rows.length) {
      panel.innerHTML = '<p class="dm-dash-err">표시할 종목이 없습니다</p>';
      return;
    }
    panel.innerHTML = `<div class="dm-table-wrap"><table class="dm-table">
      <thead><tr>
        <th>종목</th>
        <th class="num">외국인</th>
        <th class="num">기관</th>
        <th class="num">합계</th>
      </tr></thead>
      <tbody>${rows
        .map((row, i) => {
          const fCls = signedEokClass(row.foreignEok);
          const iCls = signedEokClass(row.institutionEok);
          const tCls = signedEokClass(row.totalEok);
          return `<tr>
            <td><span class="dm-rank">${i + 1}</span> <span class="dm-qname">${escapeHtml(row.name || "—")}</span></td>
            <td class="num ${escapeHtml(fCls)}">${escapeHtml(formatSignedEokPlain(row.foreignEok))}</td>
            <td class="num ${escapeHtml(iCls)}">${escapeHtml(formatSignedEokPlain(row.institutionEok))}</td>
            <td class="num ${escapeHtml(tCls)}">${escapeHtml(formatSignedEokPlain(row.totalEok))}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table></div>`;
  }

  async function loadDashboardFunds(gen) {
    renderFundPanel("loading");
    try {
      const data = await fetchDashboard("mktfunds");
      if (gen !== dashboardLoadGen) return;
      renderFundPanel("ok", data);
    } catch (e) {
      console.warn("dashboard mktfunds:", e);
      if (gen !== dashboardLoadGen) return;
      renderFundPanel("error");
    }
  }

  async function loadDashboardInvestor(market, gen) {
    renderInvestorPanel("loading");
    try {
      const data = await fetchDashboard("investor", { market });
      if (gen !== dashboardLoadGen) return;
      renderInvestorPanel("ok", data);
    } catch (e) {
      console.warn("dashboard investor:", e);
      if (gen !== dashboardLoadGen) return;
      renderInvestorPanel("error");
    }
  }

  async function loadDashboardJoint(gen) {
    renderJointPanel("loading");
    try {
      const data = await fetchDashboard("joint-trading");
      if (gen !== dashboardLoadGen) return;
      dashboardState.jointData = data;
      renderJointPanel("ok", data);
    } catch (e) {
      console.warn("dashboard joint-trading:", e);
      if (gen !== dashboardLoadGen) return;
      dashboardState.jointData = null;
      renderJointPanel("error");
    }
  }

  function refreshDashboardLive() {
    if (state.mainTab !== "dashboard") return;
    const gen = ++dashboardLoadGen;
    if (!isDashboardLiveDay()) {
      renderFundPanel("ok");
      renderInvestorPanel("ok");
      renderJointPanel("ok");
      return;
    }
    void Promise.all([
      loadDashboardFunds(gen),
      loadDashboardInvestor(dashboardState.supplyMarket, gen),
      loadDashboardJoint(gen),
    ]);
  }

  function render() {
    const ymd = state.selected;
    const day = state.dataMissing ? null : getDay(ymd);
    const aiPreparing = !state.dataMissing && isAiTabPreparing(ymd);
    const displayYmd = getDayDateYmd(day, ymd);

    if (els.title) els.title.textContent = "마감시황";
    updateDateNav();
    updateLiveBadge();

    if (els.dmMissing) els.dmMissing.hidden = !state.dataMissing;
    if (els.dmTabPanels) els.dmTabPanels.hidden = state.dataMissing;

    try {
      document.title = `${state.meta.title || "마감시황"} · ${headlineKo(displayYmd)}`;
    } catch (_) {
      /* ignore */
    }

    if (state.dataMissing) {
      if (els.dayPrep) els.dayPrep.hidden = true;
      if (els.dmAiContent) els.dmAiContent.hidden = true;
      return;
    }

    if (els.dayPrep) {
      els.dayPrep.hidden = !aiPreparing;
      if (aiPreparing) {
        const closedReason = marketClosedReason(ymd);
        if (els.dayPrepTitle) {
          els.dayPrepTitle.textContent = closedReason
            ? `${closedReason} 휴장입니다`
            : "오늘의 시황을 준비하고 있어요";
        }
        if (els.dayPrepHint) {
          els.dayPrepHint.textContent = closedReason
            ? "국내 증시가 열리지 않아 장마감 리포트가 생성되지 않습니다."
            : "장 마감 후(약 17:00) 자동으로 업데이트됩니다";
        }
      }
    }
    if (els.dmAiContent) els.dmAiContent.hidden = aiPreparing;

    if (els.dmIndexes) els.dmIndexes.innerHTML = renderIndexes(day && day.indexes);
    if (els.dmMarketExtras) els.dmMarketExtras.innerHTML = renderMarketExtras(day && day.marketExtras);

    if (aiPreparing) {
      if (els.dmAnalysis) els.dmAnalysis.innerHTML = "";
      if (els.dmFeatured) els.dmFeatured.innerHTML = "";
      if (els.dmWatchlist) els.dmWatchlist.innerHTML = "";
    } else {
      if (els.dmAnalysis) {
        const analysisText = sanitizeUserCopy(day && (day.analysis || day.summary), "AI 분석을 준비 중입니다");
        els.dmAnalysis.innerHTML = analysisText
          ? `<div class="dm-analysis__body">${renderMarkdownBold(analysisText)}</div>`
          : '<p class="empty-line">종합분석 없음</p>';
      }
      if (els.dmFeatured) els.dmFeatured.innerHTML = renderFeatured(getFeaturedStocks(day));
      if (els.dmWatchlist) els.dmWatchlist.innerHTML = renderWatchlist(getWatchlist(day));
    }
    renderStockTable();
    if (state.mainTab === "dashboard") refreshDashboardLive();
  }

  function bindEvents() {
    document.querySelectorAll("[data-dm-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setMainTab(btn.dataset.dmTab));
    });

    document.querySelectorAll("[data-dm-supply]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-dm-supply]").forEach((b) => {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-selected", on ? "true" : "false");
        });
        dashboardState.supplyMarket = btn.dataset.dmSupply || "KOSPI";
        if (state.mainTab === "dashboard" && isDashboardLiveDay()) {
          const gen = ++dashboardLoadGen;
          void loadDashboardInvestor(dashboardState.supplyMarket, gen);
        }
      });
    });

    document.querySelectorAll("[data-dm-joint]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-dm-joint]").forEach((b) => {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-selected", on ? "true" : "false");
        });
        dashboardState.jointTab = btn.dataset.dmJoint === "sell" ? "sell" : "buy";
        if (dashboardState.jointData) renderJointPanel("ok", dashboardState.jointData);
        else if (state.mainTab === "dashboard" && isDashboardLiveDay()) refreshDashboardLive();
      });
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
    await Promise.all([loadData(), loadKrTv()]);
    state.defaultYmd = resolveDefaultYmd();
    state.selected = resolveSelectedYmd();
    syncHash(state.selected);
    await ensureDayLoaded(state.selected);
    bindEvents();
    setMainTab(state.mainTab);
    render();
  }

  main();
})();
