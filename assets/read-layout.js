/**
 * 2026-09-26 읽는 페이지(오전브리핑·마감시황) 넓은 화면 배치 — 왼쪽 숫자판 고정 + 오른쪽 본문만 스크롤
 *
 * 왜: 전체 너비로 바꾼 뒤(9/25) 본문 한 줄이 1,800px까지 늘어나 시선이 줄 끝을 못 따라갔다(시우 지적).
 * 어떻게: 화면 폭 1200px 이상에서만, 페이지가 그린 섹션 중 "숫자 카드" 섹션(지수·환율·시장 온도)을
 *   왼쪽 칸(rd-rail)으로 옮기고, 나머지는 오른쪽 본문 칸(rd-main)에 둔다. 왼쪽 칸은 스크롤해도 따라온다(sticky).
 * - 페이지 스크립트는 그대로 둔다. 페이지가 다시 그리면(날짜 이동 등) MutationObserver가 알아채고 다시 나눈다.
 * - 옮긴 섹션 자리에는 표시(span.rd-ph)를 남겨, 좁은 화면으로 바뀌면 원래 자리로 돌려놓는다.
 * - 1200px 미만(모바일 포함)은 아무것도 바꾸지 않는다.
 * 스타일: assets/read-layout.css
 */
(function () {
  "use strict";
  var MQ = window.matchMedia("(min-width: 1200px)");
  var PAGES = [
    // 오전브리핑
    { host: "bfx-deck", scope: "bfx-deck", block: "section.bfx-block", title: ".bfx-block__title",
      rail: ["간밤 미국시장 마감", "환율 · 원자재 · 크립토", "간밤 시장 온도"] },
    // 마감시황(AI 시황분석 탭)
    { host: "dm-ai-content", scope: "dm-analysis", block: "section.dmx-block", title: ".dmx-block__title",
      rail: ["지수 마감", "오늘의 시장 온도"] },
  ];

  function titleOf(sec, sel) {
    var t = sec.querySelector(sel);
    return t ? t.textContent.replace(/\s+/g, " ").trim() : "";
  }

  function setup(cfg) {
    var host = document.getElementById(cfg.host);
    if (!host) return;
    var busy = false;
    var obs = new MutationObserver(function () { if (!busy) schedule(); });
    var queued = false;
    function schedule() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; run(); });
    }
    function watch() { obs.observe(host, { childList: true, subtree: true }); }

    function teardown() {
      var grid = host.querySelector(":scope > .rd-grid");
      if (!grid) return;
      var rail = grid.querySelector(":scope > .rd-rail");
      var main = grid.querySelector(":scope > .rd-main");
      Array.prototype.slice.call(rail.children).forEach(function (el) {
        var ph = el._rdPh;
        if (ph && ph.isConnected) ph.replaceWith(el);
      });
      while (main.firstChild) host.insertBefore(main.firstChild, grid);
      grid.remove();
      host.querySelectorAll(".rd-ph").forEach(function (ph) { ph.remove(); });
      host.classList.remove("rd-host");
    }

    function build() {
      var grid = host.querySelector(":scope > .rd-grid");
      var rail, main;
      if (!grid) {
        grid = document.createElement("div");
        grid.className = "rd-grid";
        rail = document.createElement("aside");
        rail.className = "rd-rail";
        rail.setAttribute("aria-label", "주요 수치");
        main = document.createElement("div");
        main.className = "rd-main";
        grid.appendChild(rail);
        grid.appendChild(main);
        while (host.firstChild) main.appendChild(host.firstChild);
        host.appendChild(grid);
        host.classList.add("rd-host");
      } else {
        rail = grid.querySelector(":scope > .rd-rail");
        main = grid.querySelector(":scope > .rd-main");
        // 페이지가 host에 새로 붙인 것은 본문 칸으로
        Array.prototype.slice.call(host.childNodes).forEach(function (n) { if (n !== grid) main.appendChild(n); });
      }
      // 다시 그려져서 원래 자리가 사라진 옛 섹션은 버린다
      Array.prototype.slice.call(rail.children).forEach(function (el) {
        if (!el._rdPh || !el._rdPh.isConnected) el.remove();
      });
      var scope = cfg.scope === cfg.host ? main : document.getElementById(cfg.scope);
      if (scope) {
        var found = {};
        Array.prototype.slice.call(scope.children).forEach(function (sec) {
          if (!sec.matches(cfg.block)) return;
          var t = titleOf(sec, cfg.title);
          for (var i = 0; i < cfg.rail.length; i++) {
            if (t.indexOf(cfg.rail[i]) === 0) { found[i] = sec; break; }
          }
        });
        cfg.rail.forEach(function (_, i) {
          var sec = found[i];
          if (!sec) return;
          var ph = document.createElement("span");
          ph.className = "rd-ph";
          ph.hidden = true;
          sec.parentNode.insertBefore(ph, sec);
          sec._rdPh = ph;
          rail.appendChild(sec);
        });
        // 순서 유지(설정 순서대로)
        Array.prototype.slice.call(rail.children)
          .sort(function (a, b) { return idx(a) - idx(b); })
          .forEach(function (el) { rail.appendChild(el); });
      }
      grid.classList.toggle("rd-norail", !rail.children.length);
    }
    function idx(el) {
      var t = titleOf(el, cfg.title);
      for (var i = 0; i < cfg.rail.length; i++) if (t.indexOf(cfg.rail[i]) === 0) return i;
      return 99;
    }

    function run() {
      busy = true;
      obs.disconnect();
      try {
        if (MQ.matches) build(); else teardown();
      } catch (e) {
        try { teardown(); } catch (_) {}
      }
      obs.takeRecords();
      watch();
      busy = false;
    }

    run();
    if (MQ.addEventListener) MQ.addEventListener("change", run); else if (MQ.addListener) MQ.addListener(run);
  }

  // 고정 머리줄(메뉴+시세띠) 높이만큼 왼쪽 칸을 내려서 붙인다
  function setTop() {
    var top = 0;
    document.querySelectorAll(".home-top, .site-header, header").forEach(function (el) {
      var cs = getComputedStyle(el);
      if (cs.position === "sticky" || cs.position === "fixed") top = Math.max(top, el.getBoundingClientRect().height);
    });
    document.documentElement.style.setProperty("--rd-top", Math.round(top + 16) + "px");
  }

  function init() {
    setTop();
    PAGES.forEach(setup);
    window.addEventListener("resize", setTop);
    setTimeout(setTop, 1500); // 시세띠가 늦게 그려지는 경우
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
