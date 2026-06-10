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

  // ─── State ────────────────────────────────────────────────
  const state = {
    meta: { title: "마감시황", timezoneNote: "" },
    days: {},
    archiveAnchor: null,
    selected: null,
  };

  // ─── DOM ──────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    title: $("masthead-title"),
    range: $("masthead-range"),
    updated: $("masthead-updated"),
    notice: $("masthead-notice"),
    navPrev: $("nav-prev"),
    navNext: $("nav-next"),
    navDate: $("nav-date"),
    navDateLabel: $("nav-date-label"),
    navToday: $("nav-today"),
    railMd: $("rail-md"),
    railDow: $("rail-dow"),
    dayBody: $("day-body"),
    dayPrep: $("day-prep"),
    dayPrepTitle: $("day-prep-title"),
    dayPrepHint: $("day-prep-hint"),
    headline: $("day-headline"),
    summary: $("day-summary"),
    supply: $("day-supply"),
    supplyComment: $("day-supply-comment"),
    issueStocks: $("day-issue-stocks"),
    sectorFlow: $("day-sector-flow"),
    checkpoints: $("day-checkpoints"),
    verdict: $("day-verdict"),
    indexes: $("day-indexes"),
    marketExtras: $("day-market-extras"),
    notable: $("day-notable"),
    topGainers: $("day-topgainers"),
    topGainersMeta: $("day-topgainers-meta"),
    themes: $("day-themes"),
    archivePrev: $("archive-prev"),
    archiveNext: $("archive-next"),
    archiveTitle: $("archive-title"),
    archiveGrid: $("archive-grid"),
  };

  // ─── Date helpers ─────────────────────────────────────────
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

  function formatNavDate(ymd) {
    if (!YMD_RE.test(ymd)) return "—";
    return `${ymd} (${weekdayKo(ymd)})`;
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

  function shortDateDot(ymd) {
    if (!ymd || !YMD_RE.test(ymd)) return "—";
    const { m, d } = ymdParts(ymd);
    return `${m}.${d}`;
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

  // ─── Utils ────────────────────────────────────────────────
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

  function getDay(ymd) {
    return state.days[ymd] || null;
  }

  function isDayEmpty(day) {
    if (!day || typeof day !== "object") return true;
    const hasSummary = sanitizeStr(day.summary).length > 0;
    const hasArr = (k) => Array.isArray(day[k]) && day[k].length > 0;

    // topGainers는 모든 종목의 등락률이 0%이면 장 마감 전 더미 데이터로 간주
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
      hasArr("notableStocks") ||
      hasMeaningfulTopGainers ||
      hasArr("themes")
    );
  }

  // ─── Render: detail ───────────────────────────────────────
  function render() {
    const ymd = state.selected;
    const day = getDay(ymd);
    const empty = isDayEmpty(day);

    if (els.title) els.title.textContent = "마감시황";
    els.railMd.textContent = shortDateDot(ymd);
    els.railDow.textContent = weekdayKo(ymd);
    if (els.navDateLabel) els.navDateLabel.textContent = formatNavDate(ymd);
    els.range.innerHTML = `<strong>${escapeHtml(headlineKo(ymd))}</strong>`;
    els.updated.textContent = !empty && day && day.updatedAt ? `업데이트: ${day.updatedAt}` : "";

    try {
      document.title = `${state.meta.title || "마감시황"} · ${headlineKo(ymd)}`;
    } catch (_) {
      /* ignore */
    }

    if (els.dayBody) {
      els.dayBody.classList.toggle("is-empty", empty);
    }
    if (els.dayPrep) {
      els.dayPrep.hidden = !empty;
      if (empty && els.dayPrepTitle) {
        const closedReason = marketClosedReason(ymd);
        els.dayPrep.classList.toggle("day-prep--closed", Boolean(closedReason));
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

    if (empty) {
      if (els.headline) els.headline.textContent = "";
      els.summary.textContent = "";
      if (els.supply) els.supply.innerHTML = "";
      if (els.supplyComment) els.supplyComment.textContent = "";
      if (els.issueStocks) els.issueStocks.innerHTML = "";
      if (els.sectorFlow) els.sectorFlow.innerHTML = "";
      if (els.checkpoints) els.checkpoints.innerHTML = "";
      if (els.verdict) els.verdict.textContent = "";
      els.indexes.innerHTML = "";
      if (els.marketExtras) els.marketExtras.innerHTML = "";
      els.notable.innerHTML = "";
      if (els.topGainers) els.topGainers.innerHTML = "";
      if (els.topGainersMeta) els.topGainersMeta.textContent = "";
      els.themes.innerHTML = "";
    } else {
      if (els.headline) {
        els.headline.textContent =
          sanitizeUserCopy(day.headlineIssue) || sanitizeUserCopy(day.summary, "AI 분석을 준비 중입니다");
      }
      els.summary.textContent = sanitizeUserCopy(day && day.summary, "");
      if (els.supply) els.supply.innerHTML = renderSupply(day && day.supply);
      if (els.supplyComment) {
        els.supplyComment.textContent = sanitizeUserCopy(day.supplyComment, "수급 현황을 불러오는 중입니다");
      }
      if (els.issueStocks) els.issueStocks.innerHTML = renderIssueStocks(day && day.issueStocks);
      if (els.sectorFlow) els.sectorFlow.innerHTML = renderSectorFlow(day && day.sectorFlow);
      if (els.checkpoints) els.checkpoints.innerHTML = renderCheckpoints(day && day.tomorrowCheckpoints);
      if (els.verdict) els.verdict.textContent = sanitizeUserCopy(day.oneLineVerdict, "");
      els.indexes.innerHTML = renderIndexes(day && day.indexes);
      if (els.marketExtras) els.marketExtras.innerHTML = renderMarketExtras(day && day.marketExtras);
      els.notable.innerHTML = renderNotable(day && day.notableStocks);
      if (els.topGainers) {
        els.topGainers.innerHTML = renderTopGainers(day && day.topGainers);
      }
      if (els.topGainersMeta) {
        const ts = day && day.topGainersUpdatedAt;
        els.topGainersMeta.textContent = ts ? `갱신: ${ts}` : "";
      }
      els.themes.innerHTML = renderThemes(day && day.themes);
    }

    renderArchive();
  }

  function renderTopGainers(arr) {
    if (!Array.isArray(arr) || !arr.length) {
      return '<p class="empty-line">기록 없음</p>';
    }
    const showTv = arr.some((s) => sanitizeStr(s && s.tradingValue));
    const rows = arr
      .map((s) => {
        const chg = parseChange(s && s.change);
        const reason = sanitizeUserCopy(s && s.reason, "");
        const theme = sanitizeStr(s && s.theme);
        const market = sanitizeStr(s && s.market);
        const code = sanitizeStr(s && s.code);
        const tv = sanitizeStr(s && s.tradingValue);
        return `<tr>
          <td class="topgainers__rank">${escapeHtml(s && s.rank != null ? s.rank : "")}</td>
          <td>
            <span class="topgainers__name">${escapeHtml(s && s.name)}</span>
            ${market ? `<span class="topgainers__market">${escapeHtml(market)}</span>` : ""}
            ${code ? `<span class="topgainers__code">${escapeHtml(code)}</span>` : ""}
            ${reason ? `<span class="topgainers__reason">${escapeHtml(reason)}</span>` : ""}
          </td>
          <td class="num"><span class="delta ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span></td>
          ${showTv ? `<td class="num">${escapeHtml(tv || "—")}</td>` : ""}
          <td>${theme ? `<span class="theme-chip">${escapeHtml(theme)}</span>` : ""}</td>
        </tr>`;
      })
      .join("");
    return `<table class="topgainers-table">
      <thead>
        <tr>
          <th>#</th>
          <th>종목</th>
          <th class="num">등락률</th>
          ${showTv ? '<th class="num">거래대금</th>' : ""}
          <th>테마</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function fmtEok(n) {
    if (n == null || !Number.isFinite(Number(n))) return "—";
    const v = Number(n);
    const sign = v > 0 ? "+" : "";
    if (Math.abs(v) >= 10000) return `${sign}${(v / 10000).toFixed(1)}조`;
    return `${sign}${Math.round(v).toLocaleString("ko-KR")}억`;
  }

  function renderSupply(arr) {
    if (!Array.isArray(arr) || !arr.length) return '<p class="empty-line">수급 데이터 없음</p>';
    return arr
      .map((row) => {
        const market = escapeHtml(row.market || "시장");
        return `<div class="supply-card">
          <span class="supply-card__market">${market}</span>
          <div class="supply-card__grid">
            <span><em>외국인</em>${escapeHtml(fmtEok(row.foreign))}</span>
            <span><em>기관</em>${escapeHtml(fmtEok(row.institution))}</span>
            <span><em>개인</em>${escapeHtml(fmtEok(row.retail))}</span>
          </div>
        </div>`;
      })
      .join("");
  }

  function renderIssueStocks(arr) {
    if (!Array.isArray(arr) || !arr.length) return '<p class="empty-line">이슈 종목 분석 없음</p>';
    return `<ul class="issue-stock-list">${arr
      .map((row) => {
        const chg = parseChange(row.change);
        return `<li class="issue-stock-card">
          <div class="issue-stock-card__head">
            <strong>${escapeHtml(row.name)}</strong>
            <span class="delta ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span>
          </div>
          ${row.entryReason ? `<p><strong>진입 이유:</strong> ${escapeHtml(sanitizeUserCopy(row.entryReason))}</p>` : ""}
          ${row.background ? `<p><strong>배경:</strong> ${escapeHtml(sanitizeUserCopy(row.background, "분석 준비 중"))}</p>` : ""}
        </li>`;
      })
      .join("")}</ul>`;
  }

  function renderSectorFlow(flow) {
    if (!flow || typeof flow !== "object") return '<p class="empty-line">섹터 데이터 없음</p>';
    const strong = Array.isArray(flow.strong) ? flow.strong : [];
    const weak = Array.isArray(flow.weak) ? flow.weak : [];
    const block = (title, rows) =>
      rows.length
        ? `<div class="sector-block"><h5>${title}</h5><ul>${rows
            .map((r) => {
              const chg = parseChange(r.changePct);
              return `<li><strong>${escapeHtml(r.name)}</strong> <span class="delta ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span>${r.reason ? ` — ${escapeHtml(r.reason)}` : ""}</li>`;
            })
            .join("")}</ul></div>`
        : "";
    const summary = sanitizeUserCopy(flow.summary, "");
    return `${block("강한 섹터", strong)}${block("약한 섹터", weak)}${summary ? `<p class="sector-summary">${escapeHtml(summary)}</p>` : ""}`;
  }

  function renderCheckpoints(arr) {
    if (!Array.isArray(arr) || !arr.length) return '<li class="empty-line">체크포인트 없음</li>';
    return arr.map((p) => `<li>${escapeHtml(sanitizeUserCopy(p))}</li>`).join("");
  }

  function renderIndexes(arr) {
    if (!Array.isArray(arr) || !arr.length) return "";
    return arr
      .map((row) => {
        const name = escapeHtml(row && row.name);
        const value = escapeHtml(row && row.value != null ? row.value : "");
        const chg = parseChange(row && row.change);
        const chgHtml = chg == null
          ? ""
          : `<span class="delta ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span>`;
        const tv = row && row.tradingValue ? `<small class="index-chip__tv">거래대금 ${escapeHtml(row.tradingValue)}</small>` : "";
        return `<span class="index-chip"><span class="index-chip__name">${name}</span><span class="index-chip__value">${value || "—"}</span>${chgHtml}${tv}</span>`;
      })
      .join("");
  }

  function renderMarketExtras(arr) {
    if (!Array.isArray(arr) || !arr.length) return '<p class="empty-line">데이터 없음</p>';
    return arr
      .map((row) => {
        const chg = parseChange(row && row.changePct);
        const comment = sanitizeStr(row && row.comment);
        return `<span class="index-chip index-chip--extra"><span class="index-chip__name">${escapeHtml(row && row.label)}</span><span class="index-chip__value">${escapeHtml(row && row.valueFormatted || row && row.value || "—")}</span>${chg == null ? "" : `<span class="delta ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span>`}${comment ? `<small>${escapeHtml(comment)}</small>` : ""}</span>`;
      })
      .join("");
  }

  function renderNotable(arr) {
    if (!Array.isArray(arr) || !arr.length) {
      return '<p class="empty-line">기록 없음</p>';
    }
    const showTv = arr.some((row) => sanitizeStr(row && row.tradingValue));
    const rows = arr
      .map((row) => {
        const chgRaw = parseChange(row && row.change);
        /* JSON에 잘못 들어간 0%는 등락률 미상으로 표시(스크립트는 null로 저장) */
        const chg = chgRaw === 0 ? null : chgRaw;
        const note = sanitizeUserCopy(row && row.note, "");
        return `<tr>
          <td>
            <span class="notable-table__name">${escapeHtml(row && row.name)}</span>
            ${note ? `<span class="notable-table__note">${escapeHtml(note)}</span>` : ""}
          </td>
          <td class="num"><span class="delta ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span></td>
          ${showTv ? `<td class="num">${escapeHtml((row && row.tradingValue) || "—")}</td>` : ""}
        </tr>`;
      })
      .join("");
    return `<table class="notable-table">
      <thead>
        <tr><th>종목</th><th class="num">등락률</th>${showTv ? '<th class="num">거래대금</th>' : ""}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function renderThemes(arr) {
    if (!Array.isArray(arr) || !arr.length) {
      return '<p class="empty-line">기록 없음</p>';
    }
    return arr
      .map((t) => {
        const leaders = Array.isArray(t && t.leaders) ? t.leaders : [];
        const leadersHtml = leaders.length
          ? `<ul class="theme__leaders">${leaders
              .map((l) => {
                const chg = parseChange(l && l.change);
                const reason = sanitizeUserCopy(l && l.reason, "");
                return `<li class="theme__leader${reason ? " theme__leader--with-reason" : ""}">
                  <span class="theme__leader-line">
                    <span class="theme__leader-name">${escapeHtml(l && l.name)}</span>
                    ${chg == null ? "" : `<span class="delta ${deltaClass(chg)}">${escapeHtml(formatChange(chg))}</span>`}
                  </span>
                  ${reason ? `<span class="theme__leader-reason">${escapeHtml(reason)}</span>` : ""}
                </li>`;
              })
              .join("")}</ul>`
          : "";
        return `<div class="theme">
          <div class="theme__line1">
            <span class="theme__name">${escapeHtml(t && t.name)}</span>
            ${t && t.note ? `<span class="theme__sep">·</span><span class="theme__summary">${escapeHtml(sanitizeUserCopy(t.note))}</span>` : ""}
          </div>
          ${leadersHtml}
        </div>`;
      })
      .join("");
  }

  // ─── Render: archive calendar ─────────────────────────────
  function renderArchive() {
    const anchor = state.archiveAnchor;
    const first = firstOfMonth(anchor);
    const total = daysInMonth(anchor);
    const firstWd = ymdWeekday(first);
    const todayYmd = seoulYmd();
    const days = state.days || {};

    els.archiveTitle.textContent = monthLabel(anchor);

    const cells = [];
    for (let i = 0; i < firstWd; i++) {
      cells.push(`<div class="cell cell--blank" role="presentation"></div>`);
    }
    for (let d = 1; d <= total; d++) {
      const { y, m } = ymdParts(anchor);
      const ymd = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const wd = ymdWeekday(ymd);
      const hasData = !isDayEmpty(days[ymd]);
      const isToday = ymd === todayYmd;
      const isSelected = ymd === state.selected;
      const cls = [
        "cell",
        wd === 0 ? "cell--sun" : "",
        hasData ? "cell--has" : "",
        isToday ? "cell--today" : "",
        isSelected ? "cell--selected" : "",
      ]
        .filter(Boolean)
        .join(" ");
      cells.push(
        `<button type="button" class="${cls}" role="gridcell" data-ymd="${ymd}" aria-label="${escapeHtml(headlineKo(ymd))}${hasData ? ", 기록 있음" : ""}">${d}</button>`
      );
    }
    const totalCells = firstWd + total;
    const trailing = (7 - (totalCells % 7)) % 7;
    for (let i = 0; i < trailing; i++) {
      cells.push(`<div class="cell cell--blank" role="presentation"></div>`);
    }
    els.archiveGrid.innerHTML = cells.join("");

    els.archiveGrid.querySelectorAll(".cell[data-ymd]").forEach((btn) => {
      btn.addEventListener("click", () => {
        select(btn.dataset.ymd, { syncArchive: false });
        if (window.innerWidth <= 768 && typeof window.closeDailyCalendar === "function") {
          window.closeDailyCalendar();
        }
      });
    });
  }

  // ─── Selection / navigation ───────────────────────────────
  function select(ymd, opts = {}) {
    if (!YMD_RE.test(ymd)) return;
    state.selected = ymd;
    if (opts.syncArchive !== false) {
      state.archiveAnchor = firstOfMonth(ymd);
    } else {
      const cur = ymdParts(state.archiveAnchor);
      const sel = ymdParts(ymd);
      if (cur.y !== sel.y || cur.m !== sel.m) {
        state.archiveAnchor = firstOfMonth(ymd);
      }
    }
    els.navDate.value = ymd;
    try {
      history.replaceState(null, "", `#${ymd}`);
    } catch (_) {
      /* ignore */
    }
    render();
  }

  // ─── Events ───────────────────────────────────────────────
  function bindEvents() {
    els.navPrev.addEventListener("click", () => select(addDaysYmd(state.selected, -1)));
    els.navNext.addEventListener("click", () => select(addDaysYmd(state.selected, 1)));
    els.navToday.addEventListener("click", () => select(seoulYmd()));
    els.navDate.addEventListener("change", () => {
      if (YMD_RE.test(els.navDate.value)) select(els.navDate.value);
    });

    els.archivePrev.addEventListener("click", () => {
      state.archiveAnchor = addMonths(state.archiveAnchor, -1);
      renderArchive();
    });
    els.archiveNext.addEventListener("click", () => {
      state.archiveAnchor = addMonths(state.archiveAnchor, 1);
      renderArchive();
    });

    window.addEventListener("hashchange", () => {
      const h = (location.hash || "").replace("#", "");
      if (YMD_RE.test(h) && h !== state.selected) select(h);
    });
  }

  function initialYmd() {
    const h = (location.hash || "").replace("#", "");
    if (YMD_RE.test(h)) return h;
    return seoulYmd();
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
    await loadData();

    state.selected = initialYmd();
    state.archiveAnchor = firstOfMonth(state.selected);
    els.navDate.value = state.selected;

    bindEvents();
    render();
  }

  main();
})();
