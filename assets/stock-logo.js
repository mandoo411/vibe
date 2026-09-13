/**
 * stock-logo.js — 국내 종목 아이콘(로고 또는 이니셜 배지)을 그린다.
 *
 * 배경 (2026-09-13):
 *   표가 글자만 빽빽하면 눈이 줄을 못 잡는다. 그래서 종목마다 앞에 아이콘을 붙인다.
 *   다만 국내 종목은 쓸만한 로고 이미지가 전체의 13%뿐이라(scripts/build-stock-logos.mjs 주석 참고),
 *   "로고 있으면 로고, 없으면 빈칸"으로 가면 표가 더 지저분해진다.
 *   그래서 없는 종목은 *브랜드 색 이니셜 배지*로 채운다 — 모양이 같으니 빠진 칸으로 안 보인다.
 *
 *   이미지 요청은 manifest에 있는 코드에만 보낸다. 404를 아예 만들지 않으므로
 *   콘솔이 깨끗하고, 네트워크 탭에 실패 요청이 쌓이지 않는다.
 *
 * 쓰는 법:
 *   <script src="./assets/stock-logo.js" defer></script>
 *   await TMStockLogo.ready();                 // manifest 로드(한 번만, 이후 캐시)
 *   el.innerHTML = TMStockLogo.html(code, name);
 *   // 또는 manifest를 기다리지 않고 먼저 그린 뒤
 *   TMStockLogo.upgrade(container);            // 로드되면 배지 → 로고로 교체
 */
(function (global) {
  "use strict";

  const MANIFEST_URL = "./assets/logos/kr-manifest.json";
  const LOGO_DIR = "./assets/logos/kr/";

  /* 코드 해시로 고르는 기본 팔레트 — 브랜드색을 모를 때 쓴다.
     전부 흰 글씨 대비 4.5:1 이상으로 맞춰 뒀다(대비 검사에 걸리지 않게). */
  const PALETTE = [
    "#2b5ce6", "#0e7a7e", "#ca3646", "#7a4bd1", "#b45b0d",
    "#1f7a4d", "#2e5f8a", "#b03c8c", "#5a6472", "#945a1f",
  ];

  let codes = null;          // Set — 로고 이미지가 있는 코드
  let tints = null;          // { code: "#rrggbb" }
  let loading = null;

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h;
  }

  /** 회사명에서 배지에 쓸 글자. 한글은 1자, 영문·숫자는 2자. */
  function initials(name, code) {
    let n = String(name || "").trim();
    n = n.replace(/\(주\)|주식회사|㈜/g, "").trim();
    // "삼성전자우" 같은 우선주 꼬리표는 떼고 본체로 판단
    n = n.replace(/[0-9]*우[BC]?$/, "") || n;
    if (!n) return String(code || "?").slice(0, 2);
    const c = n.charAt(0);
    if (c >= "가" && c <= "힣") return c;        // 한글 1자
    return n.slice(0, 2).toUpperCase();                   // 영문·숫자 2자
  }

  function tintOf(code) {
    const t = tints && tints[code];
    if (t) return t;
    return PALETTE[hash(String(code || "")) % PALETTE.length];
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function badgeHtml(code, name, cls) {
    const txt = initials(name, code);
    const long = txt.length > 1 ? " tm-logo--2" : "";
    return (
      `<span class="tm-logo tm-logo--badge${long}${cls ? " " + cls : ""}" ` +
      `style="background:${esc(tintOf(code))}" data-code="${esc(code)}" data-name="${esc(name)}" ` +
      `aria-hidden="true">${esc(txt)}</span>`
    );
  }

  function imgHtml(code, name, cls) {
    return (
      `<img class="tm-logo${cls ? " " + cls : ""}" src="${LOGO_DIR}${esc(code)}.webp" ` +
      `alt="" loading="lazy" decoding="async" width="40" height="40" data-code="${esc(code)}" ` +
      `onerror="TMStockLogo.fail(this,'${esc(name).replace(/'/g, "&#39;")}')">`
    );
  }

  function html(code, name, cls) {
    const c = String(code || "").trim();
    if (!/^\d{6}$/.test(c)) return badgeHtml(c, name, cls);
    if (codes && codes.has(c)) return imgHtml(c, name, cls);
    return badgeHtml(c, name, cls);
  }

  /** 이미지가 깨지면 배지로 되돌린다(배포 사이 시차 등) */
  function fail(img, name) {
    const code = img.getAttribute("data-code") || "";
    const cls = [...img.classList].filter((x) => x !== "tm-logo").join(" ");
    img.outerHTML = badgeHtml(code, name || "", cls);
  }

  function ready() {
    if (loading) return loading;
    loading = fetch(MANIFEST_URL, { cache: "force-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        codes = new Set(Array.isArray(j && j.codes) ? j.codes : []);
        tints = (j && j.tints) || {};
        /* manifest가 오기 전에 이미 그려진 줄들이 있다. (표는 보통 데이터가 오는 즉시
           그리므로 첫 페인트는 거의 항상 manifest보다 빠르다.) 그대로 두면 로고가 있는
           종목까지 배지로 남으므로, 도착하는 즉시 한 번 훑어서 바꿔 준다. */
        if (typeof document !== "undefined") {
          const run = () => upgrade(document);
          if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
          else run();
        }
      })
      .catch(() => {
        // manifest를 못 받아도 화면은 그대로 돌아간다 — 전부 배지로 나온다
        codes = new Set();
        tints = {};
      });
    return loading;
  }

  /**
   * manifest보다 먼저 그려진 배지를 로고로 바꿔 준다.
   * 종목명은 배지 텍스트가 아니라 data-name에서 읽는다(이니셜만 남아 있으므로).
   */
  function upgrade(root) {
    if (!codes || !codes.size) return;
    const scope = root || document;
    scope.querySelectorAll(".tm-logo--badge[data-code]").forEach((el) => {
      const code = el.getAttribute("data-code");
      if (codes.has(code)) {
        const cls = [...el.classList]
          .filter((x) => x !== "tm-logo" && x !== "tm-logo--badge" && x !== "tm-logo--2")
          .join(" ");
        el.outerHTML = imgHtml(code, el.getAttribute("data-name") || "", cls);
        return;
      }
      /* 로고는 없지만 브랜드색이 새로 생긴 경우 — 먼저 그려질 땐 코드 해시 팔레트로
         칠해졌으므로, manifest가 온 뒤 실제 브랜드색으로 바꿔 준다.
         (이걸 안 하면 삼성 계열이 전부 제각각 색으로 남는다.) */
      const t = tints && tints[code];
      if (t && el.style.background !== t) el.style.background = t;
    });
  }

  global.TMStockLogo = { ready, html, fail, upgrade, initials, tintOf, badgeHtml };

  // 페이지가 쓰기 전에 미리 받아 둔다
  if (typeof document !== "undefined") ready();
})(typeof window !== "undefined" ? window : globalThis);
