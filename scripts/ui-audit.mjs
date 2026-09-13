/**
 * ui-audit.mjs — 전 페이지 UI 자동 검사 (2026-09-13 신설)
 *
 * 왜: 흰 배경 리프레시 과정에서 "어두운 배경 전제로 흰 글씨였던 요소"가 흰 배경에
 * 얹혀 글자가 사라지는 사고가 눈으로만 보다가 다섯 번 났다(홈 날짜·코스피 숫자·
 * AI 피드·버튼 아이콘·AI종목분석 히어로). 사람이 보는 방식으로는 계속 놓친다.
 *
 * 무엇을 잡나 — 실제 렌더된 값을 브라우저에서 측정한다:
 *   1) 대비 부족: 글자색 vs "유효 배경색"(투명이면 부모로 올라가 합성)을 WCAG 공식으로
 *      계산. 큰 글자 3:1, 작은 글자 4.5:1 기준. 흰 글씨가 흰 배경에 있으면 1.00이 나온다.
 *   2) 남은 그라데이션: 리프레시에서 걷어내야 할 장식 배경
 *   3) 가로 넘침: 모바일에서 화면 밖으로 나가는 요소
 *   4) 터치 영역 36px 미만 / 11.5px 미만 글자
 *
 * 실행(컨테이너):
 *   python3 -m http.server 8899   # 저장소 루트에서
 *   npm i playwright && node scripts/ui-audit.mjs
 *   → audit-report.json 생성. 배포 전에 돌려서 contrast 건수가 늘지 않았는지 본다.
 *
 * 주의: 하단 탭바 라벨(11px)과 로고 마크(10.5px)는 관례라 의도적으로 남겨둔 값이다.
 */
/* 전 페이지 UI 자동 검사 — 대비·오버플로·터치영역·글자크기·잔존 그라데이션·팔레트 이탈 */
import { chromium } from "playwright";
import fs from "node:fs";

const PAGES = ["index.html","realtime.html","stock-analysis.html","trade-signal.html","market.html",
  "close-betting.html","daily-market.html","briefing.html","crypto.html","us-market.html",
  "weekly-market.html","world-market.html","pricing.html","mypage.html","login.html","signup.html"];

const AUDIT = () => {
  // ── 유틸 ──────────────────────────────────────────────────────────
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [x, y] = l1 > l2 ? [l1, l2] : [l2, l1]; return (x + 0.05) / (y + 0.05); };
  const sig = (el) => {
    const cls = (el.className && typeof el.className === "string" ? el.className : "").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + (el.id ? "#" + el.id : "");
  };
  const visible = (el, r) => {
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.05 && r.width > 0 && r.height > 0;
  };
  // 유효 배경색(투명이면 부모로 올라간다). 배경 이미지가 있으면 판정 보류.
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return { c: null, img: true };
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0.92) return { c, img: false };
      if (c && c.a > 0) { // 반투명 — 부모와 합성
        const p = bgOf(n.parentElement || document.body);
        if (p.c) return { c: over(c, p.c), img: p.img };
      }
      n = n.parentElement;
    }
    return { c: { r: 255, g: 255, b: 255, a: 1 }, img: false };
  };

  const out = { contrast: [], overflow: [], tap: [], tiny: [], gradient: [], palette: {} };
  const seen = new Set();
  const W = window.innerWidth;

  document.querySelectorAll("*").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) return;
    const cs = getComputedStyle(el);

    // 잔존 그라데이션(리프레시에서 걷어내야 할 장식)
    if (cs.backgroundImage.includes("gradient") && r.width > 60 && r.height > 24) {
      out.gradient.push({ sig: sig(el), w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundImage.slice(0, 70) });
    }

    // 가로 오버플로(모바일에서 화면 밖으로 나가는 요소)
    if (r.width > 4 && (r.right > W + 2 || r.left < -2) && cs.position !== "fixed") {
      const po = el.parentElement ? getComputedStyle(el.parentElement).overflowX : "visible";
      if (po === "visible") out.overflow.push({ sig: sig(el), left: Math.round(r.left), right: Math.round(r.right), vw: W });
    }

    // 직접 텍스트를 가진 요소만 대비 검사
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(" ");
    if (!own) return;
    const fs = parseFloat(cs.fontSize);
    const fw = parseInt(cs.fontWeight) || 400;

    if (fs < 11.5) out.tiny.push({ sig: sig(el), size: fs, text: own.slice(0, 20) });

    const fg0 = parse(cs.color);
    if (!fg0) return;
    const bg = bgOf(el);
    if (bg.img || !bg.c) return;
    const fg = over(fg0, bg.c);
    const cr = ratio(fg, bg.c);
    const large = fs >= 18.66 || (fs >= 14 && fw >= 700);
    const need = large ? 3 : 4.5;
    if (cr < need) {
      const k = sig(el) + "|" + Math.round(cr * 10);
      if (!seen.has(k)) {
        seen.add(k);
        out.contrast.push({ sig: sig(el), ratio: +cr.toFixed(2), need, size: fs, weight: fw,
          color: cs.color, bg: `rgb(${Math.round(bg.c.r)},${Math.round(bg.c.g)},${Math.round(bg.c.b)})`, text: own.slice(0, 28) });
      }
    }
    // 팔레트 집계(텍스트 색)
    const key = `rgb(${fg0.r},${fg0.g},${fg0.b})`;
    out.palette[key] = (out.palette[key] || 0) + 1;
  });

  // 터치 영역(모바일만 의미) — 링크/버튼 높이
  if (W <= 768) {
    document.querySelectorAll("a,button,[role=button]").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!visible(el, r)) return;
      if (r.height < 36 && r.width > 8 && el.closest("nav,.home-footer") === null) {
        out.tap.push({ sig: sig(el), h: Math.round(r.height), w: Math.round(r.width), text: (el.textContent || "").trim().slice(0, 18) });
      }
    });
  }
  return out;
};

(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const report = {};
  for (const f of PAGES) {
    report[f] = {};
    for (const [w, tag] of [[390, "mobile"], [1280, "desktop"]]) {
      const ctx = await b.newContext({ viewport: { width: w, height: 1000 } });
      const p = await ctx.newPage();
      await p.route(/(googleapis|gstatic|doubleclick|google\.com|supabase\.co|jsdelivr)/, (r) => r.abort());
      await p.route("**/api/repo-data**", async (route) => {
        const u = new URL(route.request().url()); const path = decodeURIComponent(u.searchParams.get("path") || "");
        try { const j = JSON.parse(require("fs").readFileSync("./vibe/" + path, "utf8")); route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) }); }
        catch (e) { route.fulfill({ status: 404, body: "{}" }); }
      });
      await p.route("**/api/**", (r) => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
      try { await p.goto("http://127.0.0.1:8899/" + f, { waitUntil: "commit", timeout: 15000 }); } catch (e) {}
      await p.waitForTimeout(2600);
      try { report[f][tag] = await p.evaluate(AUDIT); } catch (e) { report[f][tag] = { error: String(e).slice(0, 80) }; }
      await ctx.close();
    }
    process.stdout.write(".");
  }
  await b.close();
  fs.writeFileSync("audit-report.json", JSON.stringify(report, null, 1));
  console.log("\n저장: audit-report.json");
})();
