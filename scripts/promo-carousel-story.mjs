// 마감 카드뉴스 v3 "이슈 스토리" 슬라이드 (시안)
import { shell, topBar, foot } from "./promo-carousel-css.mjs";
const esc = (s) => String(s ?? "");

/* 테마. "site"는 2026-09-23 사이트 리브랜딩(바탕 #000 · 카드 #111113 · 에메랄드)과 맞춘 것 */
const THEMES = {
  navy: "",
  site: `
  :root{--ink:#000;--navy:#000;--teal:#10B981;--teal-dim:#047857;--panel:#111113;--line:#232326;
    --body:#D9DEE5;--dim:#A1A8B3;--dim-2:#7C8491;}
  .bg{background:radial-gradient(900px 620px at 88% -8%, rgba(16,185,129,.13) 0%, transparent 60%),#000 !important;}
  .bg::after{display:none;}
  .slash{background:linear-gradient(90deg,#10B981 0%,#047857 40%,transparent 100%) !important;}
  .kicker{border-color:rgba(16,185,129,.45) !important;background:rgba(16,185,129,.10) !important;}
  .chip,.mv,.sp>div,.ck>div,.st{background:#111113 !important;border-color:#232326 !important;}
  .step:last-child .tx{background:rgba(16,185,129,.08) !important;}
  .rail .dot{background:rgba(16,185,129,.08) !important;} .step:last-child .rail .dot{background:var(--teal) !important;color:#000 !important;}
  .ck>div{background:rgba(16,185,129,.06) !important;border-color:rgba(16,185,129,.25) !important;}
  .mv-t{background:rgba(16,185,129,.12) !important;}`,
};
const themeCss = (d) => THEMES[d.theme] || "";
const sh = (d, body, css) => shell(body, css + themeCss(d));
const swipe = `<span class="swipe" style="display:flex;align-items:center;gap:14px;font-size:31px;font-weight:700;color:var(--teal)">밀어서 보기 <span style="width:44px;height:44px;border-radius:50%;background:var(--teal);color:#04121F;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:800">›</span></span>`;

const CHIP_CSS = `
.chips{display:flex;flex-wrap:wrap;gap:14px;}
.chip{white-space:nowrap;padding:14px 22px;border-radius:16px;background:rgba(255,255,255,.05);
  border:1px solid var(--line);display:flex;align-items:baseline;gap:12px;}
.chip b{font-size:30px;font-weight:600;color:var(--dim);letter-spacing:-.3px;}
.chips{flex-wrap:nowrap;overflow:hidden;}
.chip s{text-decoration:none;font-size:34px;font-weight:800;letter-spacing:-.8px;}`;
const chips = (arr) => `<div class="chips">${arr.map((c) =>
  `<div class="chip"><b>${esc(c.name)}</b><s class="${c.dir} mono">${esc(c.text)}</s></div>`).join("")}</div>`;

/* 훅 한 줄이 길면 글자를 줄인다. 84px에서 한 줄은 공백 포함 약 11자 — 넘으면 "출/발,"처럼 단어가 잘린다 */
function hookSize(html) {
  const lines = String(html ?? "").split(/<br\s*\/?>/i).map((l) => l.replace(/<[^>]+>/g, "").trim());
  const max = Math.max(0, ...lines.map((l) => l.length));
  return max > 13 ? "xs" : max > 11 ? "sm" : "";
}

/* 1. 훅 — 그날의 사건을 질문으로 */
export function slideStoryHook(d) {
  const css = CHIP_CSS + `
  .hookwrap{flex:1;display:flex;flex-direction:column;justify-content:center;padding-top:20px;}
  .hk-tag{display:inline-flex;align-self:flex-start;padding:13px 26px;border-radius:999px;background:var(--up);
    font-size:30px;font-weight:800;color:#fff;margin-bottom:38px;}
  .hk{font-size:84px;font-weight:800;line-height:1.26;letter-spacing:-3.2px;}
  .hk em{font-style:normal;color:var(--teal);}
  .hk-sub{margin-top:34px;font-size:36px;line-height:1.52;color:var(--body);font-weight:500;letter-spacing:-.8px;}
  .hk-sub b{color:#fff;}
  .hk.sm{font-size:74px;letter-spacing:-2.8px;} .hk.xs{font-size:64px;letter-spacing:-2.4px;}
  .chips{margin-top:44px;flex-wrap:wrap;overflow:visible;}`;
  return sh(d, `<div class="wrap">${topBar(d.slotLabel, d.dateLabel)}
  <div class="hookwrap">
    <div class="hk-tag">${esc(d.hookTag)}</div>
    <div class="hk ${hookSize(d.hookHTML)}">${d.hookHTML}</div>
    <div class="hk-sub">${d.hookSub}</div>
    ${chips(d.indexChips)}
  </div>
  ${foot(esc(d.hookFoot || `${d.dateFull} 마감 기준`), swipe)}</div>`, css);
}

/* 2~3. 이슈 카드 — 질문 → 원인 사슬 → 움직인 종목 */
export function slideIssue(d, issue, idx) {
  const css = CHIP_CSS + `
  .ib{flex:1;display:flex;flex-direction:column;margin-top:34px;min-height:0;}
  .q{font-size:64px;font-weight:800;line-height:1.24;letter-spacing:-2px;margin-top:22px;}
  .q em{font-style:normal;color:var(--teal);}
  /* 2026-09-24: 사슬이 짧으면 가운데가 비었다 — 남은 높이를 채우도록 가운데 정렬 + 결과는 박스로 강조 */
  .chain{flex:1;display:flex;flex-direction:column;justify-content:center;padding:26px 0;}
  .step{display:flex;gap:22px;align-items:stretch;}
  .rail{flex:0 0 56px;display:flex;flex-direction:column;align-items:center;}
  .dot{width:56px;height:56px;border-radius:50%;border:2px solid var(--teal);color:var(--teal);
    display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;background:rgba(37,224,200,.08);}
  .step:last-child .dot{background:var(--teal);color:#04121F;}
  .ln{flex:1;width:2px;background:linear-gradient(var(--teal),rgba(37,224,200,.15));margin:6px 0;min-height:22px;}
  .step:last-child .ln{display:none;}
  .tx{flex:1;padding:4px 0 34px;}
  .lb{font-size:29px;font-weight:700;color:var(--dim-2);letter-spacing:-.2px;}
  .bd{margin-top:6px;font-size:39px;line-height:1.42;font-weight:600;color:var(--body);letter-spacing:-.9px;}
  .bd b{color:#fff;font-weight:800;}
  .step:last-child .tx{padding:20px 26px;border-radius:20px;background:rgba(37,224,200,.08);border:1.5px solid var(--teal);margin-top:-8px;}
  .step:last-child .lb{color:var(--teal);}
  .step:last-child .bd{color:#fff;font-weight:800;font-size:42px;}
  .who{margin-top:0;}
  .who .h{font-size:28px;font-weight:700;color:var(--dim-2);margin-bottom:14px;}`;
  const steps = issue.chain.map((s, i) => `<div class="step"><div class="rail"><div class="dot">${i === issue.chain.length - 1 ? "!" : i + 1}</div><div class="ln"></div></div>
    <div class="tx"><div class="lb">${esc(s.label)}</div><div class="bd">${s.text}</div></div></div>`).join("");
  return sh(d, `<div class="wrap">${topBar(d.slotLabel, d.dateLabel)}
  <div class="ib">
    <div class="kicker">◆ ${esc(issue.kicker)}</div>
    <div class="q">${issue.question}</div>
    <div class="chain">${steps}</div>
    ${issue.stocks?.length ? `<div class="who"><div class="h">${esc(issue.whoLabel || "이 이슈로 움직인 종목")}</div>${chips(issue.stocks.slice(0, 3))}</div>` : ""}
  </div>
  ${foot(esc(issue.source || ""), "")}</div>`, css);
}

/* 4. 급등주 — 왜 올랐나 */
export function slideMovers(d) {
  const css = `
  .mb{flex:1;display:flex;flex-direction:column;margin-top:34px;}
  .list{margin-top:34px;display:flex;flex-direction:column;gap:20px;}
  .mv{border-radius:22px;padding:28px 30px;background:rgba(255,255,255,.045);border:1px solid var(--line);}
  .mv-h{display:flex;justify-content:space-between;align-items:center;gap:16px;}
  .mv-n{font-size:44px;font-weight:800;letter-spacing:-1.2px;}
  .mv-t{margin-left:14px;padding:6px 14px;border-radius:10px;background:rgba(37,224,200,.12);color:var(--teal);font-size:28px;font-weight:700;}
  .mv-p{font-size:42px;font-weight:800;white-space:nowrap;}
  .mv-w{margin-top:16px;font-size:34px;line-height:1.48;color:var(--body);font-weight:500;letter-spacing:-.7px;}
  .mv-w b{color:#fff;}`;
  const rows = d.movers.map((m) => `<div class="mv"><div class="mv-h"><div style="display:flex;align-items:center"><span class="mv-n">${esc(m.name)}</span><span class="mv-t">${esc(m.tag)}</span></div>
    ${m.pct ? `<span class="mv-p ${m.dir} mono">${esc(m.pct)}</span>` : ""}</div><div class="mv-w">${m.why}</div></div>`).join("");
  return sh(d, `<div class="wrap">${topBar(d.slotLabel, d.dateLabel)}
  <div class="mb"><div class="kicker">◆ ${esc(d.moversKicker)}</div>
  <div class="ptitle" style="margin-top:22px">${d.moversTitle}</div>
  <div class="list">${rows}</div></div>
  ${foot(esc(d.moversFoot || "급등 뒤에는 되돌림도 큽니다 · 추격 매수는 신중하게"), "")}</div>`, css);
}

/* 5. 다음에 볼 것 + 오늘 수급 한 줄 */
export function slideNext(d) {
  const css = `
  .nb{flex:1;display:flex;flex-direction:column;margin-top:34px;}
  .sp{margin-top:30px;display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
  .sp>div{border-radius:18px;padding:20px 22px;background:rgba(255,255,255,.045);border:1px solid var(--line);}
  .sp .w{font-size:28px;color:var(--dim);font-weight:600;} .sp .a{margin-top:6px;font-size:38px;font-weight:800;letter-spacing:-1px;}
  .sp-note{margin-top:16px;font-size:31px;line-height:1.5;color:var(--body);letter-spacing:-.5px;}
  .sp-note b{color:#fff;}
  .h2{margin-top:44px;font-size:30px;font-weight:700;color:var(--dim-2);}
  .ck{margin-top:18px;display:flex;flex-direction:column;gap:16px;}
  .ck>div{display:flex;gap:18px;align-items:flex-start;padding:22px 26px;border-radius:18px;background:rgba(37,224,200,.06);border:1px solid rgba(37,224,200,.22);}
  .ck i{font-style:normal;flex:0 0 auto;font-size:30px;font-weight:800;color:var(--teal);margin-top:4px;}
  .ck p{font-size:34px;line-height:1.44;font-weight:500;color:var(--body);letter-spacing:-.6px;} .ck p b{color:#fff;}`;
  return sh(d, `<div class="wrap">${topBar(d.slotLabel, d.dateLabel)}
  <div class="nb"><div class="kicker">◆ ${esc(d.nextKicker || "오늘 누가 샀고, 다음엔 뭘 볼까")}</div>
  <div class="sp">${(d.strip || d.supply || []).map((s) => `<div><div class="w">${esc(s.who)}</div><div class="a ${s.dir} mono">${esc(s.amount)}</div></div>`).join("")}</div>
  <div class="sp-note">${d.stripNote ?? d.supplyNote ?? ""}</div>
  <div class="h2">${esc(d.nextTitle)}</div>
  <div class="ck">${d.next.map((n, i) => `<div><i>0${i + 1}</i><p>${n}</p></div>`).join("")}</div></div>
  ${foot("저장해두고 다음 장 열기 전에 다시 보세요", "")}</div>`, css);
}

/** 기존 슬라이드(CTA 등)에도 같은 테마를 입힌다 */
export function withTheme(builder) {
  return (d) => {
    const html = builder(d);
    const css = themeCss(d);
    return css ? html.replace("</style>", `${css}</style>`) : html;
  };
}
