// 마감 카드뉴스 v3 "이슈 스토리" 슬라이드 (시안)
import { shell, topBar, foot } from "./promo-carousel-css.mjs";
const esc = (s) => String(s ?? "");
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
  .chips{margin-top:44px;}`;
  return shell(`<div class="wrap">${topBar(d.slotLabel, d.dateLabel)}
  <div class="hookwrap">
    <div class="hk-tag">${esc(d.hookTag)}</div>
    <div class="hk">${d.hookHTML}</div>
    <div class="hk-sub">${d.hookSub}</div>
    ${chips(d.indexChips)}
  </div>
  ${foot(`${esc(d.dateFull)} 마감 기준`, swipe)}</div>`, css);
}

/* 2~3. 이슈 카드 — 질문 → 원인 사슬 → 움직인 종목 */
export function slideIssue(d, issue, idx) {
  const css = CHIP_CSS + `
  .ib{flex:1;display:flex;flex-direction:column;margin-top:34px;}
  .q{font-size:62px;font-weight:800;line-height:1.24;letter-spacing:-2px;margin-top:22px;}
  .q em{font-style:normal;color:var(--teal);}
  .chain{margin-top:40px;display:flex;flex-direction:column;}
  .step{display:flex;gap:22px;align-items:stretch;}
  .rail{flex:0 0 56px;display:flex;flex-direction:column;align-items:center;}
  .dot{width:56px;height:56px;border-radius:50%;border:2px solid var(--teal);color:var(--teal);
    display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;background:rgba(37,224,200,.08);}
  .step:last-child .dot{background:var(--teal);color:#04121F;}
  .ln{flex:1;width:2px;background:linear-gradient(var(--teal),rgba(37,224,200,.15));margin:6px 0;min-height:22px;}
  .step:last-child .ln{display:none;}
  .tx{padding:4px 0 24px;}
  .lb{font-size:28px;font-weight:700;color:var(--dim-2);letter-spacing:-.2px;}
  .bd{margin-top:6px;font-size:36px;line-height:1.46;font-weight:600;color:var(--body);letter-spacing:-.8px;}
  .bd b{color:#fff;font-weight:800;}
  .step:last-child .bd{color:#fff;font-weight:800;}
  .who{margin-top:auto;}
  .who .h{font-size:28px;font-weight:700;color:var(--dim-2);margin-bottom:14px;}`;
  const steps = issue.chain.map((s, i) => `<div class="step"><div class="rail"><div class="dot">${i === issue.chain.length - 1 ? "!" : i + 1}</div><div class="ln"></div></div>
    <div class="tx"><div class="lb">${esc(s.label)}</div><div class="bd">${s.text}</div></div></div>`).join("");
  return shell(`<div class="wrap">${topBar(d.slotLabel, d.dateLabel)}
  <div class="ib">
    <div class="kicker">◆ ${esc(issue.kicker)}</div>
    <div class="q">${issue.question}</div>
    <div class="chain">${steps}</div>
    ${issue.stocks?.length ? `<div class="who"><div class="h">이 이슈로 움직인 종목</div>${chips(issue.stocks.slice(0, 3))}</div>` : ""}
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
    <span class="mv-p ${m.dir} mono">${esc(m.pct)}</span></div><div class="mv-w">${m.why}</div></div>`).join("");
  return shell(`<div class="wrap">${topBar(d.slotLabel, d.dateLabel)}
  <div class="mb"><div class="kicker">◆ ${esc(d.moversKicker)}</div>
  <div class="ptitle" style="margin-top:22px">${d.moversTitle}</div>
  <div class="list">${rows}</div></div>
  ${foot("급등 뒤에는 되돌림도 큽니다 · 추격 매수는 신중하게", "")}</div>`, css);
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
  return shell(`<div class="wrap">${topBar(d.slotLabel, d.dateLabel)}
  <div class="nb"><div class="kicker">◆ 오늘 누가 샀고, 다음엔 뭘 볼까</div>
  <div class="sp">${d.supply.map((s) => `<div><div class="w">${esc(s.who)}</div><div class="a ${s.dir} mono">${esc(s.amount)}</div></div>`).join("")}</div>
  <div class="sp-note">${d.supplyNote}</div>
  <div class="h2">${esc(d.nextTitle)}</div>
  <div class="ck">${d.next.map((n, i) => `<div><i>0${i + 1}</i><p>${n}</p></div>`).join("")}</div></div>
  ${foot("저장해두고 다음 장 열기 전에 다시 보세요", "")}</div>`, css);
}
