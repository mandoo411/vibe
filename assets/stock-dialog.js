/* 종목 클릭 공용 대화상자 (2026-10-16)
 * - tmConfirmAnalysis({ name, code, note }) → Promise<boolean>
 *     AI 분석 1회 = 실제 비용. 종목을 누르거나 검색하자마자 분석이 돌던 것을 막는 확인 팝업.
 * - tmStockActions({ name, code, quoteHref, aiHref }) → 시세 보기 / AI 분석 선택 시트
 * PC는 가운데 카드, 모바일(≤560px)은 아래에서 올라오는 시트. 스타일은 이 파일이 스스로 주입한다. */
(function () {
  if (window.tmConfirmAnalysis) return;

  const CSS = `
.tmsd{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px}
.tmsd__bg{position:absolute;inset:0;background:rgba(0,0,0,.55);opacity:0;transition:opacity .16s ease}
.tmsd__card{position:relative;width:min(100%,360px);background:var(--bg-primary,#fff);color:var(--text-primary,#09090b);
  border:1px solid var(--border-color,#e4e4e7);border-radius:16px;padding:22px 20px 18px;box-shadow:0 24px 48px rgba(0,0,0,.28);
  transform:translateY(8px) scale(.98);opacity:0;transition:transform .18s ease,opacity .18s ease;font-family:inherit}
[data-theme="dark"] .tmsd__card{background:var(--panel-surface,#161616);border-color:rgba(255,255,255,.1)}
.tmsd__card:focus{outline:none}
.tmsd.is-open .tmsd__bg{opacity:1}
.tmsd.is-open .tmsd__card{transform:none;opacity:1}
.tmsd__stock{display:flex;align-items:baseline;gap:6px;margin:0 0 6px;font-size:13px;color:var(--text-secondary,#71717a)}
.tmsd__stock b{font-size:15px;font-weight:700;color:var(--text-primary,#09090b)}
[data-theme="dark"] .tmsd__stock b{color:var(--text-title,#f4f4f5)}
.tmsd__title{margin:0;font-size:18px;font-weight:700;line-height:1.4;letter-spacing:-.01em}
.tmsd__note{margin:8px 0 0;font-size:13.5px;line-height:1.6;color:var(--text-secondary,#71717a)}
.tmsd__note strong{color:var(--accent-brand,#059669);font-weight:700}
.tmsd__row{display:flex;gap:8px;margin-top:20px}
.tmsd__btn{flex:1;height:46px;border-radius:10px;border:0;font:inherit;font-size:15px;font-weight:600;cursor:pointer;
  -webkit-tap-highlight-color:transparent}
.tmsd__btn--ghost{background:var(--bg-tertiary,#f4f4f5);color:var(--text-primary,#09090b)}
[data-theme="dark"] .tmsd__btn--ghost{background:#262626;color:#e4e4e7}
.tmsd__btn--main{background:var(--accent-brand,#059669);color:#fff}
.tmsd__btn:hover{filter:brightness(1.06)}
.tmsd__btn:focus-visible,.tmsd__opt:focus-visible{outline:2px solid var(--accent-brand,#059669);outline-offset:2px}
.tmsd__opts{display:flex;flex-direction:column;gap:8px;margin-top:14px}
.tmsd__opt{display:flex;align-items:center;gap:12px;width:100%;padding:14px;border-radius:12px;text-decoration:none;
  border:1px solid var(--border-color,#e4e4e7);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
[data-theme="dark"] .tmsd__opt{border-color:rgba(255,255,255,.1)}
.tmsd__opt:hover{background:var(--bg-tertiary,#f4f4f5)}
[data-theme="dark"] .tmsd__opt:hover{background:#1f1f1f}
.tmsd__ico{flex:none;display:grid;place-items:center;width:38px;height:38px;border-radius:10px;font-size:20px;
  background:rgba(5,150,105,.12);color:var(--accent-brand,#059669)}
.tmsd__ico--q{background:rgba(59,130,246,.12);color:#3b82f6}
.tmsd__opt-t{display:block;font-size:15px;font-weight:700}
.tmsd__opt-d{display:block;margin-top:2px;font-size:12.5px;color:var(--text-secondary,#71717a)}
.tmsd__opt .ti-chevron-right{margin-left:auto;color:var(--text-secondary,#a1a1aa)}
.tmsd__cancel{display:block;width:100%;margin-top:10px;height:42px;border:0;background:transparent;font:inherit;font-size:14px;
  color:var(--text-secondary,#71717a);cursor:pointer}
@media (max-width:560px){
  .tmsd{align-items:flex-end;padding:0}
  .tmsd__card{width:100%;border-radius:18px 18px 0 0;border-bottom:0;padding:20px 18px calc(14px + env(safe-area-inset-bottom));
    transform:translateY(100%)}
}
body.tmsd-lock{overflow:hidden}`;

  function ensureCss() {
    if (document.getElementById("tmsd-css")) return;
    const s = document.createElement("style");
    s.id = "tmsd-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function stockLine(name, code) {
    const n = String(name || "").trim();
    const c = String(code || "").trim();
    if (!n && !c) return "";
    return '<p class="tmsd__stock"><b>' + esc(n || c) + "</b>" + (n && c && n !== c ? "<span>" + esc(c) + "</span>" : "") + "</p>";
  }

  /** 열고, 닫힐 때 resolve(value). build(card, close)가 내용을 채운다. */
  function open(inner, wire) {
    ensureCss();
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const root = document.createElement("div");
      root.className = "tmsd";
      root.innerHTML = '<div class="tmsd__bg" data-x="1"></div><div class="tmsd__card" role="dialog" aria-modal="true" tabindex="-1">' + inner + "</div>";
      document.body.appendChild(root);
      document.body.classList.add("tmsd-lock");
      let done = false;
      function close(val) {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey, true);
        root.classList.remove("is-open");
        document.body.classList.remove("tmsd-lock");
        setTimeout(() => root.remove(), 180);
        try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); } catch (_) {}
        resolve(val);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); close(false); }
      }
      document.addEventListener("keydown", onKey, true);
      root.addEventListener("click", (e) => {
        if (e.target && e.target.getAttribute && e.target.getAttribute("data-x")) close(false);
      });
      wire(root, close);
      requestAnimationFrame(() => {
        root.classList.add("is-open");
        const card = root.querySelector(".tmsd__card");
        if (card) card.focus({ preventScroll: true });
      });
    });
  }

  window.tmConfirmAnalysis = function (opts) {
    const o = opts || {};
    const inner =
      stockLine(o.name, o.code) +
      '<h2 class="tmsd__title">AI 분석을 시작할까요?</h2>' +
      (o.note ? '<p class="tmsd__note">' + o.note + "</p>" : "") +
      '<div class="tmsd__row"><button type="button" class="tmsd__btn tmsd__btn--ghost" data-x="1">취소</button>' +
      '<button type="button" class="tmsd__btn tmsd__btn--main" data-ok="1">분석 시작</button></div>';
    return open(inner, (root, close) => {
      root.querySelector("[data-ok]").addEventListener("click", () => close(true));
    });
  };

  window.tmStockActions = function (opts) {
    const o = opts || {};
    const inner =
      stockLine(o.name, o.code) +
      '<h2 class="tmsd__title">무엇을 볼까요?</h2>' +
      '<div class="tmsd__opts">' +
      '<a class="tmsd__opt" href="' + esc(o.quoteHref) + '"><span class="tmsd__ico tmsd__ico--q"><i class="ti ti-chart-line" aria-hidden="true"></i></span>' +
      '<span><span class="tmsd__opt-t">시세 보기</span><span class="tmsd__opt-d">실시간 시세와 차트</span></span><i class="ti ti-chevron-right" aria-hidden="true"></i></a>' +
      '<a class="tmsd__opt" href="' + esc(o.aiHref) + '"><span class="tmsd__ico"><i class="ti ti-robot" aria-hidden="true"></i></span>' +
      '<span><span class="tmsd__opt-t">AI 분석</span><span class="tmsd__opt-d">AI 종목분석 리포트</span></span><i class="ti ti-chevron-right" aria-hidden="true"></i></a>' +
      "</div>" +
      '<button type="button" class="tmsd__cancel" data-x="1">닫기</button>';
    return open(inner, () => {});
  };
})();
