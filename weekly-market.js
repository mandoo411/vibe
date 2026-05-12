(function () {
  const DATA_URL = "./data/weekly-schedule.json";
  const WD_KO = ["일", "월", "화", "수", "목", "금", "토"];
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

  const els = {
    mastheadTitle: document.getElementById("masthead-title"),
    mastheadRange: document.getElementById("masthead-range"),
    mastheadUpdated: document.getElementById("masthead-updated"),
    mastheadTz: document.getElementById("masthead-tz"),
    mastheadNotice: document.getElementById("masthead-notice"),
    tabs: document.getElementById("tabs"),
    panels: document.getElementById("panels"),
  };

  function seoulYmd(anchor) {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(anchor);
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

  /** 해당 날짜가 속한 주의 월요일(Seoul 달력 기준) YYYY-MM-DD */
  function mondayYmdFor(ymd) {
    const d = new Date(ymd + "T12:00:00+09:00");
    const jsDay = d.getUTCDay();
    const diffToMon = jsDay === 0 ? -6 : 1 - jsDay;
    return addDaysYmd(ymd, diffToMon);
  }

  function mondayYmdThisWeek(anchor) {
    return mondayYmdFor(seoulYmd(anchor));
  }

  /** 증시 주간 일정: 토·일에는 이번 주가 사실상 끝난 뒤이므로 다음 주 월요일(KST) 기준 */
  function tradingWeekMondayYmd(anchor) {
    const ymd = seoulYmd(anchor);
    const d = new Date(ymd + "T12:00:00+09:00");
    const jsDay = d.getUTCDay();
    const mon = mondayYmdThisWeek(anchor);
    if (jsDay === 0 || jsDay === 6) {
      return addDaysYmd(mon, 7);
    }
    return mon;
  }

  function headlineForYmd(ymd) {
    const d = new Date(ymd + "T12:00:00+09:00");
    const wd = WD_KO[d.getUTCDay()];
    const [, m, day] = ymd.split("-");
    return `${Number(m)}월 ${Number(day)}일 (${wd})`;
  }

  function weekRangeLabelKo(mondayYmd, fridayYmd) {
    const [y1, m1, d1] = mondayYmd.split("-").map(Number);
    const [y2, m2, d2] = fridayYmd.split("-").map(Number);
    if (y1 === y2) {
      return `${y1}년 ${m1}월 ${d1}일 ~ ${m2}월 ${d2}일`;
    }
    return `${y1}년 ${m1}월 ${d1}일 ~ ${y2}년 ${m2}월 ${d2}일`;
  }

  function buildSkeletonWeek(mondayYmd) {
    const days = [];
    for (let i = 0; i < 5; i++) {
      const id = addDaysYmd(mondayYmd, i);
      const d = new Date(id + "T12:00:00+09:00");
      days.push({
        id,
        weekdayKo: WD_KO[d.getUTCDay()],
        headline: headlineForYmd(id),
        events: [],
        themes: [],
        earnings: [],
      });
    }
    return days;
  }

  function mergeWeekContent(skeleton, contentDays) {
    if (!contentDays || !contentDays.length) return skeleton;
    return skeleton.map((sk, i) => {
      const c = contentDays[i];
      if (!c || typeof c !== "object") return sk;
      return {
        ...sk,
        events: c.events !== undefined ? c.events : sk.events,
        themes: c.themes !== undefined ? c.themes : sk.themes,
        earnings: c.earnings !== undefined ? c.earnings : sk.earnings,
      };
    });
  }

  /** 레거시: 최상위 days만 있는 JSON을 weeks로 승격 */
  function normalizeData(data) {
    const weeks = { ...(data.weeks && typeof data.weeks === "object" ? data.weeks : {}) };
    if (data.days && data.days.length && !Object.keys(weeks).length) {
      const firstId = data.days[0].id;
      if (firstId && YMD_RE.test(firstId)) {
        const mon = mondayYmdFor(firstId);
        weeks[mon] = { meta: data.meta || {}, days: data.days };
      }
    }
    return { ...data, weeks };
  }

  function pickWeekBundle(weeks, mondayKey) {
    if (weeks[mondayKey]) {
      return { bundle: weeks[mondayKey], dataMonday: mondayKey, mode: "exact" };
    }
    const keys = Object.keys(weeks)
      .filter((k) => YMD_RE.test(k))
      .sort();
    const prev = keys.filter((k) => k <= mondayKey);
    if (prev.length) {
      const k = prev[prev.length - 1];
      return { bundle: weeks[k], dataMonday: k, mode: "past" };
    }
    const next = keys.find((k) => k > mondayKey);
    if (next) {
      return { bundle: weeks[next], dataMonday: next, mode: "future" };
    }
    return { bundle: { meta: {}, days: [] }, dataMonday: null, mode: "empty" };
  }

  function resolveMondayKeyFromQuery() {
    try {
      const q = new URLSearchParams(window.location.search).get("week");
      if (q && YMD_RE.test(q)) return mondayYmdFor(q);
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** YYYY-MM-DD → M.D */
  function shortDateDot(ymd) {
    if (!ymd || !YMD_RE.test(ymd)) return "—";
    const [, m, d] = ymd.split("-");
    return `${Number(m)}.${Number(d)}`;
  }

  function renderEvents(events) {
    if (!events || !events.length) {
      return '<p class="day-empty">일정 없음</p>';
    }
    return `<ul class="event-list">${events
      .map((e) => {
        const nStars = Math.min(2, Math.max(0, Number(e.stars) || (e.key ? 1 : 0)));
        const starHtml =
          nStars >= 2 ? '<span class="event__star" aria-hidden="true">★★</span>' : nStars === 1 ? '<span class="event__star" aria-hidden="true">★</span>' : "";
        const url = typeof e.url === "string" && /^https?:\/\//i.test(e.url) ? e.url : "";
        const link = url
          ? `<a class="event__link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">참고</a>`
          : "";
        const tag = (e.tag || "").trim();
        const time = (e.time || "").trim();
        const row1 =
          tag || time
            ? `<div class="event__row1">
          ${tag ? `<span class="event__tag">${escapeHtml(tag)}</span>` : ""}
          ${time ? `<span class="event__time">${escapeHtml(time)}</span>` : ""}
        </div>`
            : "";
        const detail = (e.detail || "").trim();
        const detailHtml = detail ? `<p class="event__detail">${escapeHtml(detail)}</p>` : "";
        return `<li class="event${nStars ? " event--key" : ""}">
        ${row1}
        <div class="event__row2">
          ${starHtml}
          <p class="event__title">${escapeHtml(e.title || "")}</p>
          ${link}
        </div>
        ${detailHtml}
      </li>`;
      })
      .join("")}</ul>`;
  }

  function renderThemes(themes) {
    if (!themes || !themes.length) {
      return '<p class="day-empty">테마 없음</p>';
    }
    return `<div class="theme-list">${themes
      .map((t) => {
        const line = (t.stocks || []).map((s) => escapeHtml(s)).join(" · ");
        return `<div class="theme">
        <div class="theme__line1">
          <span class="theme__name">${escapeHtml(t.name)}</span>
          ${t.summary ? `<span class="theme__sep">·</span><span class="theme__summary">${escapeHtml(t.summary)}</span>` : ""}
        </div>
        ${line ? `<p class="theme__stocks">${line}</p>` : ""}
      </div>`;
      })
      .join("")}</div>`;
  }

  function renderEarnings(rows) {
    if (!rows || !rows.length) {
      return '<p class="day-empty">실적 일정 없음</p>';
    }
    return `<ul class="earn-list">${rows
      .map(
        (r) => `<li class="earn-list__item">
        <span class="earn-list__name">${escapeHtml(r.name)}</span>
        <span class="earn-list__meta"><span class="earn-list__seg">${escapeHtml(r.segment || "—")}</span><span class="earn-list__dot">·</span><span class="earn-list__note">${escapeHtml(r.note || "—")}</span></span>
      </li>`
      )
      .join("")}</ul>`;
  }

  function renderDay(day, index) {
    const h = escapeHtml(day.headline || day.id);
    const id = escapeHtml(day.id);
    return `<section class="panel" role="tabpanel" id="panel-${day.id}" aria-labelledby="tab-${day.id}" data-index="${index}">
      <h2 class="u-visually-hidden">${h}</h2>
      <article class="day-sheet">
        <aside class="day-rail" aria-hidden="true">
          <span class="day-rail__md">${escapeHtml(shortDateDot(day.id))}</span>
          <span class="day-rail__dow">${escapeHtml(day.weekdayKo || "")}</span>
        </aside>
        <div class="day-body">
          <section class="day-block" aria-labelledby="lbl-ev-${id}">
            <h3 class="day-block__label" id="lbl-ev-${id}">주요 이벤트</h3>
            ${renderEvents(day.events)}
          </section>
          ${
            day.themes && day.themes.length
              ? `<section class="day-block" aria-labelledby="lbl-th-${id}">
            <h3 class="day-block__label" id="lbl-th-${id}">테마 · 관련 종목</h3>
            ${renderThemes(day.themes)}
          </section>`
              : ""
          }
          <section class="day-block" aria-labelledby="lbl-er-${id}">
            <h3 class="day-block__label" id="lbl-er-${id}">국내 기업 실적</h3>
            ${renderEarnings(day.earnings)}
          </section>
        </div>
      </article>
    </section>`;
  }

  function bindTabs(days) {
    const tabButtons = els.tabs.querySelectorAll(".tab");
    const panels = els.panels.querySelectorAll(".panel");

    function activate(i) {
      tabButtons.forEach((btn, j) => {
        btn.setAttribute("aria-selected", j === i ? "true" : "false");
      });
      panels.forEach((p, j) => {
        p.classList.toggle("is-active", j === i);
      });
      try {
        history.replaceState(null, "", `#${days[i].id}`);
      } catch (_) {
        /* ignore */
      }
    }

    tabButtons.forEach((btn, i) => {
      btn.addEventListener("click", () => activate(i));
    });

    const hash = (location.hash || "").replace("#", "");
    const idx = days.findIndex((d) => d.id === hash);
    activate(idx >= 0 ? idx : 0);
  }

  function showError(msg) {
    els.tabs.innerHTML = "";
    els.panels.innerHTML = `<div class="load-error"><strong>데이터를 불러오지 못했습니다.</strong><br/>${escapeHtml(
      msg
    )}</div>`;
  }

  function setNotice(text) {
    if (!els.mastheadNotice) return;
    if (!text) {
      els.mastheadNotice.hidden = true;
      els.mastheadNotice.textContent = "";
      return;
    }
    els.mastheadNotice.hidden = false;
    els.mastheadNotice.textContent = text;
  }

  async function load() {
    try {
      const res = await fetch(DATA_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const data = normalizeData(raw);

      const queryMonday = resolveMondayKeyFromQuery();
      const mondayKey = queryMonday || tradingWeekMondayYmd(new Date());
      const fridayYmd = addDaysYmd(mondayKey, 4);

      const skeleton = buildSkeletonWeek(mondayKey);
      const { bundle } = pickWeekBundle(data.weeks || {}, mondayKey);

      const contentDays = (bundle.days || []).map((row) =>
        row && typeof row === "object"
          ? { events: row.events, themes: row.themes, earnings: row.earnings }
          : {}
      );

      const days = mergeWeekContent(skeleton, contentDays);

      const globalMeta = data.meta || {};
      const weekMeta = bundle.meta || {};
      const meta = { ...globalMeta, ...weekMeta };

      els.mastheadTitle.textContent = meta.title || "주간 증시 일정";
      els.mastheadRange.innerHTML = `<strong>${escapeHtml(weekRangeLabelKo(mondayKey, fridayYmd))}</strong>`;
      els.mastheadUpdated.textContent = weekMeta.lastUpdated ? `업데이트: ${weekMeta.lastUpdated}` : "";
      els.mastheadTz.textContent = meta.timezoneNote || "";

      if (queryMonday) {
        setNotice(`미리보기: week=${mondayKey} (URL 파라미터)`);
      } else {
        setNotice("");
      }

      try {
        document.title = `${meta.title || "주간 증시 일정"} · ${weekRangeLabelKo(mondayKey, fridayYmd)}`;
      } catch (_) {
        /* ignore */
      }

      els.tabs.innerHTML = days
        .map((d, i) => {
          const sub = d.id ? d.id.slice(5).replace("-", "/") : "";
          return `<button type="button" class="tab" role="tab" id="tab-${escapeHtml(d.id)}" aria-controls="panel-${escapeHtml(
            d.id
          )}" aria-selected="${i === 0}">
            <span>${escapeHtml(sub)}</span>
            <span class="tab__dow">${escapeHtml(d.weekdayKo || "")}</span>
          </button>`;
        })
        .join("");

      els.panels.innerHTML = days.map((d, i) => renderDay(d, i)).join("");
      bindTabs(days);
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  }

  load();
})();
