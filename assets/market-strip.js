/**
 * 시장 요약 스트립 (공통 컴포넌트)
 * ------------------------------------------------------------------
 * 2026-09-02 사이트 감사: 실시간시세·미국주식·암호화폐·글로벌랭킹 네 페이지가
 * 50~100행짜리 원시 표만 보여줘서 무료 시세 사이트와 차별점이 없다는 지적.
 * 표 위에 "지금 시장이 어떤 상태인지" 한 줄로 요약하는 공통 스트립을 얹는다.
 *
 * 원칙(프로젝트 규칙):
 *  - 실데이터가 없으면 지어내지 않고 해당 블록을 통째로 생략한다.
 *  - 표본이 전체 시장이 아니면 무엇을 센 것인지 반드시 라벨로 밝힌다
 *    (예: "거래대금 상위 100종목 기준"). 전체 시장인 척하지 않는다.
 *  - 새 API를 만들지 않는다 (Vercel Hobby 서버리스 함수 12개 한도 소진 상태).
 *    각 페이지가 이미 받아 둔 데이터로만 계산한다.
 *
 * 사용:
 *   TMStrip.render("rt-summary-strip", {
 *     indices:    [{ label:"코스피", value:"3,210.11", changePct: 0.62 }],
 *     breadth:    { up: 41, flat: 3, down: 56, sampleLabel: "거래대금 상위 100종목 기준" },
 *     highlights: [{ label:"거래대금 1위", name:"삼성전자", changePct: 1.2 }],
 *     note:       "장중 5초 간격 갱신",
 *   });
 */
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function num(v) {
    if (v == null || v === "") return null;
    var n = Number(String(v).replace(/[,%\s+]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function fmtPct(v) {
    var n = num(v);
    if (n == null) return "—";
    return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
  }

  function tone(v) {
    var n = num(v);
    if (n == null) return "flat";
    if (n > 0) return "up";
    if (n < 0) return "down";
    return "flat";
  }

  function indexChip(ix) {
    var t = tone(ix.changePct);
    return (
      '<div class="tms-idx">' +
      '<span class="tms-idx__name">' + esc(ix.label) + "</span>" +
      '<span class="tms-idx__val">' + esc(ix.value == null || ix.value === "" ? "—" : ix.value) + "</span>" +
      '<span class="tms-delta tms-delta--' + t + '">' + esc(fmtPct(ix.changePct)) + "</span>" +
      "</div>"
    );
  }

  function breadthBlock(b) {
    var up = Math.max(0, Number(b.up) || 0);
    var down = Math.max(0, Number(b.down) || 0);
    var flat = Math.max(0, Number(b.flat) || 0);
    var total = up + down + flat;
    if (!total) return "";
    var pu = (up / total) * 100;
    var pf = (flat / total) * 100;
    var pd = (down / total) * 100;
    var label = b.sampleLabel ? '<span class="tms-breadth__sample">' + esc(b.sampleLabel) + "</span>" : "";
    return (
      '<div class="tms-breadth">' +
      '<div class="tms-breadth__head">' +
      '<span class="tms-breadth__lbl">등락 종목</span>' +
      label +
      "</div>" +
      '<div class="tms-breadth__bar" role="img" aria-label="상승 ' + up + "종목, 보합 " + flat + "종목, 하락 " + down + '종목">' +
      '<span class="tms-seg tms-seg--up" style="width:' + pu.toFixed(2) + '%"></span>' +
      '<span class="tms-seg tms-seg--flat" style="width:' + pf.toFixed(2) + '%"></span>' +
      '<span class="tms-seg tms-seg--down" style="width:' + pd.toFixed(2) + '%"></span>' +
      "</div>" +
      '<div class="tms-breadth__legend">' +
      '<span class="tms-delta tms-delta--up">상승 ' + up + "</span>" +
      (flat ? '<span class="tms-delta tms-delta--flat">보합 ' + flat + "</span>" : "") +
      '<span class="tms-delta tms-delta--down">하락 ' + down + "</span>" +
      "</div>" +
      "</div>"
    );
  }

  function highlightChip(h) {
    if (!h || !h.name) return "";
    var right = "";
    if (h.changePct != null && h.changePct !== "") {
      right = '<span class="tms-delta tms-delta--' + tone(h.changePct) + '">' + esc(fmtPct(h.changePct)) + "</span>";
    } else if (h.value) {
      right = '<span class="tms-hi__val">' + esc(h.value) + "</span>";
    }
    return (
      '<div class="tms-hi">' +
      '<span class="tms-hi__lbl">' + esc(h.label || "") + "</span>" +
      '<span class="tms-hi__name">' + esc(h.name) + "</span>" +
      right +
      "</div>"
    );
  }

  function render(target, model) {
    var el = typeof target === "string" ? document.getElementById(target) : target;
    if (!el) return;
    model = model || {};
    var indices = (model.indices || []).filter(function (x) {
      return x && x.label;
    });
    var hi = (model.highlights || []).filter(function (x) {
      return x && x.name;
    });
    var b = model.breadth && (Number(model.breadth.up) || Number(model.breadth.down) || Number(model.breadth.flat)) ? model.breadth : null;

    // 보여줄 실데이터가 하나도 없으면 빈 껍데기를 남기지 않고 통째로 감춘다.
    if (!indices.length && !hi.length && !b) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }

    var parts = [];
    if (indices.length) parts.push('<div class="tms-indices">' + indices.map(indexChip).join("") + "</div>");
    if (b) parts.push(breadthBlock(b));
    if (hi.length) parts.push('<div class="tms-highlights">' + hi.map(highlightChip).join("") + "</div>");

    el.hidden = false;
    el.className = "tms" + (el.dataset && el.dataset.tmsVariant ? " tms--" + el.dataset.tmsVariant : "");
    el.innerHTML =
      '<div class="tms__row">' + parts.join('<span class="tms__div" aria-hidden="true"></span>') + "</div>" +
      (model.note ? '<p class="tms__note">' + esc(model.note) + "</p>" : "");
  }

  /** 행 배열에서 등락 브레드스를 센다. pick(row) → 등락률(숫자/문자열) */
  function countBreadth(rows, pick) {
    var up = 0,
      down = 0,
      flat = 0;
    (rows || []).forEach(function (r) {
      var n = num(pick ? pick(r) : r && r.changePct);
      if (n == null) return;
      if (n > 0) up += 1;
      else if (n < 0) down += 1;
      else flat += 1;
    });
    return { up: up, down: down, flat: flat };
  }

  window.TMStrip = { render: render, countBreadth: countBreadth, fmtPct: fmtPct };
})();
