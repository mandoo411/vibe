// TotalMoney AI 카드뉴스 v2 — 캐러셀 5장 빌더
// deck 데이터 스키마는 render.mjs 하단 참고
import { shell, topBar, foot, pager } from "./promo-carousel-css.mjs";

const esc = (s) => String(s ?? "");

/* ───────────────────────── 1. HOOK — 스크롤을 멈추게 하는 유일한 장 ───────────────────────── */
export function slideHook(d) {
  const css = `
  .hookwrap{flex:1;display:flex;flex-direction:column;justify-content:center;padding-top:26px;}
  .hk-tag{display:inline-flex;align-self:flex-start;align-items:center;gap:12px;
    padding:13px 26px;border-radius:999px;background:var(--up);
    font-size:26px;font-weight:800;letter-spacing:-.3px;color:#fff;margin-bottom:38px;}
  .hk{font-size:88px;font-weight:800;line-height:1.26;letter-spacing:-3.4px;}
  .hk em{font-style:normal;color:var(--teal);}
  .hk-sub{margin-top:34px;font-size:36px;line-height:1.52;color:var(--body);font-weight:500;letter-spacing:-.8px;}
  .hk-num{margin-top:46px;display:flex;gap:14px;}
  .chip{padding:16px 26px;border-radius:16px;background:rgba(255,255,255,.05);
    border:1px solid var(--line);display:flex;align-items:baseline;gap:12px;}
  .chip b{font-size:26px;font-weight:600;color:var(--dim);letter-spacing:-.3px;}
  .chip s{text-decoration:none;font-size:36px;font-weight:800;letter-spacing:-.8px;}
  .swipe{display:flex;align-items:center;gap:14px;font-size:28px;font-weight:700;color:var(--teal);}
  .swipe .ar{width:44px;height:44px;border-radius:50%;background:var(--teal);color:#04121F;
    display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;}
  `;
  const chips = d.indexChips.map(
    (c) => `<div class="chip"><b>${esc(c.name)}</b><s class="${c.dir} mono">${esc(c.text)}</s></div>`
  ).join("");
  return shell(`<div class="wrap">
  ${topBar(d.slotLabel, d.dateLabel)}
  <div class="hookwrap">
    <div class="hk-tag">${esc(d.hookTag)}</div>
    <div class="hk">${d.hookHTML}</div>
    <div class="hk-sub">${d.hookSub}</div>
    <div class="hk-num">${chips}</div>
  </div>
  ${foot(`${esc(d.dateFull)} 마감 기준`, `<span class="swipe">밀어서 보기 <span class="ar">›</span></span>`, 0)}
  </div>`, css);
}

/* ───────────────────────── 2. AI 한 줄 판단 — 이 계정의 존재 이유 ───────────────────────── */
export function slideVerdict(d) {
  const css = `
  .vbody{flex:1;display:flex;flex-direction:column;justify-content:center;padding-top:26px;}
  .quote{font-size:150px;line-height:.7;color:rgba(37,224,200,.28);font-weight:800;height:78px;}
  .verdict{font-size:72px;font-weight:800;line-height:1.28;letter-spacing:-2.8px;margin-top:6px;}
  .verdict em{font-style:normal;color:var(--teal);}
  .why{margin-top:52px;display:flex;flex-direction:column;gap:18px;}
  .why-row{display:flex;gap:20px;align-items:flex-start;padding:26px 28px;border-radius:20px;
    background:rgba(255,255,255,.045);border:1px solid var(--line);}
  .why-n{flex:0 0 40px;height:40px;border-radius:12px;background:rgba(37,224,200,.16);color:var(--teal);
    display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;margin-top:2px;}
  .why-t{font-size:36px;line-height:1.5;font-weight:500;letter-spacing:-.7px;color:var(--body);}
  .why-t b{font-weight:800;color:#fff;}
  `;
  const rows = d.verdictWhy.map((t, i) =>
    `<div class="why-row"><div class="why-n">${i + 1}</div><div class="why-t">${t}</div></div>`).join("");
  return shell(`<div class="wrap">
  ${topBar(d.slotLabel, d.dateLabel)}
  <div class="vbody">
    <div class="kicker" style="margin-bottom:30px;">◆ AI 오늘의 판단</div>
    <div class="quote">“</div>
    <div class="verdict">${d.verdictHTML}</div>
    <div class="why">${rows}</div>
  </div>
  ${foot("AI가 오늘 시장의 성격을 한 문장으로 규정했습니다", "", 1)}
  </div>`, css);
}

/* ───────────────────────── 3. 돈의 흐름 — 몰린 곳 vs 빠진 곳 ───────────────────────── */
export function slideFlow(d) {
  const css = `
  .fbody{flex:1;display:flex;flex-direction:column;margin-top:26px;}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:26px;}
  .col{border-radius:24px;padding:26px 24px;border:1px solid var(--line);background:rgba(255,255,255,.04);}
  .col.in{border-color:rgba(255,92,92,.38);background:linear-gradient(180deg,rgba(255,92,92,.13),rgba(255,92,92,.03));}
  .col.out{border-color:rgba(91,155,255,.34);background:linear-gradient(180deg,rgba(91,155,255,.12),rgba(91,155,255,.03));}
  .col-h{display:flex;align-items:center;gap:11px;font-size:32px;font-weight:800;letter-spacing:-.7px;margin-bottom:22px;}
  .col-h .ic{width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;
    font-size:21px;font-weight:800;}
  .in .ic{background:var(--up);color:#fff;} .out .ic{background:var(--down);color:#fff;}
  .grp{padding:17px 0;border-top:1px solid rgba(255,255,255,.09);}
  .grp:first-of-type{border-top:0;padding-top:0;}
  .grp-n{font-size:37px;font-weight:800;letter-spacing:-.9px;margin-bottom:9px;}
  .grp-d{font-size:30px;line-height:1.5;color:var(--body);font-weight:500;letter-spacing:-.5px;}
  .grp-d b{color:var(--body);font-weight:700;}
  .note{margin-top:18px;padding:20px 26px;border-radius:20px;background:rgba(37,224,200,.09);
    border:1px solid rgba(37,224,200,.28);font-size:32px;line-height:1.5;font-weight:600;letter-spacing:-.6px;color:#DFF7F3;}
  .note span{color:var(--teal);font-weight:800;}
  .sup{margin-top:20px;}
  .sup-h{font-size:27px;font-weight:700;color:var(--dim);letter-spacing:-.4px;margin-bottom:11px;}
  .sup-g{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
  .sup-c{padding:18px 16px;border-radius:18px;background:rgba(255,255,255,.045);border:1px solid var(--line);text-align:center;}
  .sup-c .w{font-size:26px;font-weight:600;color:var(--dim);letter-spacing:-.3px;}
  .sup-c .a{font-size:37px;font-weight:800;letter-spacing:-1px;margin-top:8px;}
  .sup-c .s{font-size:24px;font-weight:600;color:var(--dim-2);margin-top:5px;}
  `;
  const grp = (g) => `<div class="grp"><div class="grp-n">${esc(g.name)}</div><div class="grp-d">${g.desc}</div></div>`;
  return shell(`<div class="wrap">
  ${topBar(d.slotLabel, d.dateLabel)}
  <div class="fbody">
    <div class="kicker" style="margin-bottom:22px;">◆ 오늘 돈의 흐름</div>
    <div class="ptitle">${d.flowTitle}</div>
    <div class="cols">
      <div class="col in"><div class="col-h"><span class="ic">↑</span>돈이 몰린 곳</div>${d.flowIn.map(grp).join("")}</div>
      <div class="col out"><div class="col-h"><span class="ic">↓</span>돈이 빠진 곳</div>${d.flowOut.map(grp).join("")}</div>
    </div>
    <div class="note">${d.flowNote}</div>
    <div class="sup">
      <div class="sup-h">${esc(d.supplyTitle)}</div>
      <div class="sup-g">${d.supply.map((s) => `
        <div class="sup-c"><div class="w">${esc(s.who)}</div>
          <div class="a ${s.dir} mono">${esc(s.amount)}</div>
          <div class="s">${esc(s.label)}</div></div>`).join("")}</div>
    </div>
  </div>
  ${foot("출처 · 한국투자증권 실시간 시세 / 투자자별 매매동향", "", 2)}
  </div>`, css);
}

/* ───────────────────────── 4. 특징주 + 리스크 — 다른 계정이 절대 안 하는 것 ───────────────────────── */
export function slideStocks(d) {
  const css = `
  .sbody{flex:1;display:flex;flex-direction:column;margin-top:32px;}
  .list{margin-top:26px;display:flex;flex-direction:column;gap:17px;}
  .st{border-radius:22px;padding:26px 28px;background:rgba(255,255,255,.045);border:1px solid var(--line);}
  .st-h{display:flex;align-items:center;justify-content:space-between;gap:16px;}
  .st-l{display:flex;align-items:center;gap:13px;min-width:0;}
  .st-mk{padding:6px 13px;border-radius:8px;background:rgba(255,255,255,.10);font-size:23px;font-weight:700;color:var(--dim);}
  .st-n{font-size:42px;font-weight:800;letter-spacing:-1.1px;}
  .st-p{font-size:40px;font-weight:800;letter-spacing:-1px;white-space:nowrap;}
  .st-r{margin-top:14px;font-size:32px;line-height:1.5;color:var(--body);font-weight:500;letter-spacing:-.6px;}
  .st-risk{margin-top:15px;padding:16px 20px;border-radius:14px;background:rgba(255,92,92,.10);
    border-left:4px solid var(--up);display:flex;gap:12px;align-items:flex-start;}
  .st-risk .lb{flex:0 0 auto;font-size:25px;font-weight:800;color:var(--up);letter-spacing:-.3px;}
  .st-risk .tx{font-size:30px;line-height:1.46;color:#F2D7D7;font-weight:500;letter-spacing:-.5px;}
  `;
  const rows = d.stocks.map((s) => `
    <div class="st">
      <div class="st-h">
        <div class="st-l"><span class="st-mk">${esc(s.market)}</span><span class="st-n">${esc(s.name)}</span></div>
        <div class="st-p ${s.dir} mono">${esc(s.pct)}</div>
      </div>
      <div class="st-r">${s.reason}</div>
      ${s.risk ? `<div class="st-risk"><span class="lb">리스크</span><span class="tx">${s.risk}</span></div>` : ""}
    </div>`).join("");
  return shell(`<div class="wrap">
  ${topBar(d.slotLabel, d.dateLabel)}
  <div class="sbody">
    <div class="kicker" style="margin-bottom:22px;">◆ 오늘의 특징주</div>
    <div class="ptitle">${d.stocksTitle}</div>
    <div class="list">${rows}</div>
  </div>
  ${foot("급등 이유만 말하지 않습니다 · 리스크까지 같이 봅니다", "", 3)}
  </div>`, css);
}

/* ───────────────────────── 5. CTA — 팔로우/저장 이유를 명시 ───────────────────────── */
export function slideCTA(d) {
  const css = `
  .cbody{flex:1;display:flex;flex-direction:column;justify-content:center;padding-top:26px;}
  .ct-t{font-size:64px;font-weight:800;line-height:1.28;letter-spacing:-2.4px;}
  .ct-t em{font-style:normal;color:var(--teal);}
  .ct-s{margin-top:22px;font-size:33px;color:var(--body);font-weight:500;letter-spacing:-.6px;line-height:1.5;}
  .rs{margin-top:46px;display:flex;flex-direction:column;gap:16px;}
  .rs-row{display:flex;gap:18px;align-items:center;padding:24px 26px;border-radius:18px;
    background:rgba(255,255,255,.045);border:1px solid var(--line);}
  .rs-ic{flex:0 0 44px;height:44px;border-radius:13px;background:linear-gradient(135deg,var(--teal),var(--teal-dim));
    color:#04121F;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;}
  .rs-t{font-size:33px;font-weight:600;letter-spacing:-.7px;line-height:1.42;color:var(--body);}
  .rs-t b{font-weight:800;color:#fff;}
  .cta{margin-top:44px;display:flex;gap:16px;}
  .cta-b{flex:1;padding:28px 22px;border-radius:20px;text-align:center;}
  .cta-b.p{background:linear-gradient(135deg,var(--teal),var(--teal-dim));color:#04121F;}
  .cta-b.s{background:rgba(255,255,255,.07);border:1px solid var(--line);color:#fff;}
  .cta-b .k{font-size:25px;font-weight:700;opacity:.72;letter-spacing:-.3px;}
  .cta-b .v{font-size:34px;font-weight:800;margin-top:7px;letter-spacing:-.9px;}
  .save{margin-top:22px;padding:24px 28px;border-radius:18px;border:1.5px dashed rgba(37,224,200,.45);
    background:rgba(37,224,200,.07);display:flex;align-items:center;gap:16px;}
  .save .ic{flex:0 0 46px;height:46px;border-radius:13px;background:rgba(37,224,200,.18);
    display:flex;align-items:center;justify-content:center;font-size:24px;}
  .save .tx{font-size:32px;font-weight:600;line-height:1.44;letter-spacing:-.6px;color:#DFF7F3;}
  .save .tx b{font-weight:800;color:var(--teal);}
  `;
  const rows = d.ctaReasons.map((t, i) =>
    `<div class="rs-row"><div class="rs-ic">${i + 1}</div><div class="rs-t">${t}</div></div>`).join("");
  return shell(`<div class="wrap">
  ${topBar(d.slotLabel, d.dateLabel)}
  <div class="cbody">
    <div class="kicker" style="margin-bottom:28px;">◆ 이 계정을 팔로우하면</div>
    <div class="ct-t">${d.ctaTitle}</div>
    <div class="ct-s">${d.ctaSub}</div>
    <div class="rs">${rows}</div>
    <div class="cta">
      <div class="cta-b p"><div class="k">매일 오후 5시 업데이트</div><div class="v">팔로우 @totalmoney_ai</div></div>
      <div class="cta-b s"><div class="k">전체 리포트</div><div class="v">totalmoney.kr</div></div>
    </div>
    <div class="save"><div class="ic"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.2L5 21V4.5a1 1 0 0 1 1-1Z" fill="#25E0C8"/></svg></div><div class="tx">${d.saveNudge}</div></div>
  </div>
  ${foot("투자 참고용 정보이며 투자 판단의 책임은 본인에게 있습니다", "", 4)}
  </div>`, css);
}

export const BUILDERS = [slideHook, slideVerdict, slideFlow, slideStocks, slideCTA];

/* 지수 카드 4~5개 (모닝브리핑 2번) */
export function slideIndex(d) {
  const css = `
  .ibody{flex:1;display:flex;flex-direction:column;margin-top:32px;}
  .ig{margin-top:28px;display:grid;grid-template-columns:1fr 1fr;gap:16px;}
  .ic{padding:26px 28px;border-radius:20px;background:rgba(255,255,255,.045);border:1px solid var(--line);}
  .ic.wide{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px 28px;}
  .ic-n{font-size:28px;font-weight:600;color:var(--dim);letter-spacing:-.4px;}
  .ic-v{font-size:50px;font-weight:800;letter-spacing:-1.6px;margin-top:8px;}
  .ic-p{font-size:31px;font-weight:700;letter-spacing:-.6px;margin-top:4px;}
  .ic.wide .ic-v{font-size:36px;margin-top:0;}
  .ic.wide .ic-p{margin-top:0;font-size:24px;}
  .ic.wide .r{display:flex;align-items:baseline;gap:14px;}
  .icmt{margin-top:22px;padding:24px 28px;border-radius:20px;background:rgba(37,224,200,.09);
    border:1px solid rgba(37,224,200,.28);font-size:32px;line-height:1.5;font-weight:600;
    letter-spacing:-.6px;color:#DFF7F3;}
  .bt{margin-top:26px;}
  .bt-h{font-size:27px;font-weight:700;color:var(--dim);letter-spacing:-.4px;margin-bottom:14px;}
  .bt-g{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}
  .bt-c{padding:20px 16px;border-radius:16px;background:rgba(255,255,255,.045);
    border:1px solid var(--line);text-align:center;}
  .bt-c .s{font-size:27px;font-weight:700;color:var(--dim);letter-spacing:-.3px;}
  .bt-c .p{font-size:32px;font-weight:800;letter-spacing:-.8px;margin-top:7px;}
  `;
  const big = d.idxMain.map((c) => `
    <div class="ic"><div class="ic-n">${esc(c.name)}</div>
      <div class="ic-v mono">${esc(c.value)}</div>
      <div class="ic-p ${c.dir} mono">${esc(c.pct)}</div></div>`).join("");
  const wide = (d.idxSub || []).map((c) => `
    <div class="ic wide"><div class="ic-n">${esc(c.name)}</div>
      <div class="r"><span class="ic-v mono">${esc(c.value)}</span><span class="ic-p ${c.dir} mono">${esc(c.pct)}</span></div></div>`).join("");
  return shell(`<div class="wrap">
  ${topBar(d.slotLabel, d.dateLabel)}
  <div class="ibody">
    <div class="kicker" style="margin-bottom:22px;">◆ 간밤 미국 시장</div>
    <div class="ptitle">${d.idxTitle}</div>
    <div class="ig">${big}${wide}</div>
    <div class="icmt">${d.idxComment}</div>
    <div class="bt"><div class="bt-h">${esc(d.btTitle)}</div>
      <div class="bt-g">${(d.bigTech || []).map((b) => `
        <div class="bt-c"><div class="s">${esc(b.name)}</div><div class="p ${b.dir} mono">${esc(b.pct)}</div></div>`).join("")}</div></div>
  </div>
  ${foot("현지 종가 기준 · 출처 Yahoo Finance", "", 1)}
  </div>`, css);
}

/* 오늘 볼 것 체크리스트 (모닝브리핑 4번) */
export function slideWatch(d) {
  const css = `
  .wbody{flex:1;display:flex;flex-direction:column;margin-top:32px;}
  .wl{margin-top:28px;display:flex;flex-direction:column;gap:18px;}
  .wr{display:flex;gap:20px;align-items:flex-start;padding:30px 30px;border-radius:20px;
    background:rgba(255,255,255,.045);border:1px solid var(--line);}
  .wr.hot{border-color:rgba(245,196,81,.4);background:rgba(245,196,81,.09);}
  .wc{flex:0 0 42px;height:42px;border-radius:13px;background:rgba(37,224,200,.16);color:var(--teal);
    display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;}
  .wr.hot .wc{background:rgba(245,196,81,.2);color:#F5C451;}
  .wt{font-size:36px;font-weight:800;letter-spacing:-.9px;}
  .wd{font-size:31px;line-height:1.5;color:var(--body);font-weight:500;letter-spacing:-.5px;margin-top:8px;}
  .wd b{color:var(--body);font-weight:700;}
  .sec-tags{margin-top:26px;display:flex;flex-wrap:wrap;gap:12px;}
  .sec-tags span{padding:17px 26px;border-radius:15px;background:rgba(255,255,255,.06);
    border:1px solid var(--line);font-size:31px;font-weight:700;letter-spacing:-.5px;}
  .sec-h2{font-size:28px;font-weight:700;color:var(--dim);letter-spacing:-.4px;margin-top:auto;padding-top:30px;}
  `;
  const rows = d.watchRows.map((w, i) => `
    <div class="wr ${w.hot ? "hot" : ""}"><div class="wc">${w.hot ? "!" : i + 1}</div>
      <div><div class="wt">${esc(w.title)}</div><div class="wd">${w.desc}</div></div></div>`).join("");
  return shell(`<div class="wrap">
  ${topBar(d.slotLabel, d.dateLabel)}
  <div class="wbody">
    <div class="kicker" style="margin-bottom:22px;">◆ 오늘 이것만 보면 됩니다</div>
    <div class="ptitle">${d.watchTitle}</div>
    <div class="wl">${rows}</div>
    <div class="sec-h2">오늘 눈여겨볼 업종</div>
    <div class="sec-tags">${(d.watchSectors || []).map((s) => `<span>${esc(s)}</span>`).join("")}</div>
  </div>
  ${foot("장 시작 전 확인용 · 매매 권유가 아닙니다", "", 3)}
  </div>`, css);
}

/* 글로벌 시총 랭킹 표 */
export function slideRank(d) {
  const css = `
  .rbody{flex:1;display:flex;flex-direction:column;margin-top:30px;}
  .rl{margin-top:22px;display:flex;flex-direction:column;gap:9px;}
  .rr{display:grid;grid-template-columns:56px 1fr auto 128px;align-items:center;gap:18px;
    padding:15px 22px;border-radius:15px;background:rgba(255,255,255,.045);border:1px solid var(--line);}
  .rr.top{background:linear-gradient(90deg,rgba(37,224,200,.14),rgba(37,224,200,.04));
    border-color:rgba(37,224,200,.34);}
  .rr.kr{background:linear-gradient(90deg,rgba(255,92,92,.13),rgba(255,92,92,.03));
    border-color:rgba(255,92,92,.34);}
  .rn{font-size:30px;font-weight:800;color:var(--dim-2);text-align:center;}
  .rr.top .rn{color:var(--teal);} .rr.kr .rn{color:var(--up);}
  .rnm{font-size:35px;font-weight:700;letter-spacing:-.8px;}
  .rnm small{font-size:23px;font-weight:600;color:var(--dim-2);margin-left:9px;letter-spacing:0;}
  .rmc{font-size:33px;font-weight:800;letter-spacing:-.7px;text-align:right;white-space:nowrap;}
  .rpc{font-size:28px;font-weight:700;text-align:right;letter-spacing:-.5px;}
  `;
  const rows = d.rankRows.map((r) => `
    <div class="rr ${r.kr ? "kr" : r.rank <= 3 ? "top" : ""}">
      <div class="rn">${esc(r.rank)}</div>
      <div class="rnm">${esc(r.name)}${r.tag ? `<small>${esc(r.tag)}</small>` : ""}</div>
      <div class="rmc mono">${esc(r.cap)}</div>
      <div class="rpc ${r.dir} mono">${esc(r.pct)}</div>
    </div>`).join("");
  return shell(`<div class="wrap">
  ${topBar(d.slotLabel, d.dateLabel)}
  <div class="rbody">
    <div class="kicker" style="margin-bottom:20px;">◆ ${esc(d.rankKicker)}</div>
    <div class="ptitle">${d.rankTitle}</div>
    <div class="rl">${rows}</div>
  </div>
  ${foot(esc(d.rankFoot), "", 1)}
  </div>`, css);
}

/* 국내 기업이 세계에서 어디쯤인지 — 막대 비교 */
export function slideKrRank(d) {
  const css = `
  .kbody{flex:1;display:flex;flex-direction:column;margin-top:30px;}
  .kb{margin-top:28px;display:flex;flex-direction:column;gap:22px;}
  .kbar{}
  .kbar-h{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:11px;}
  .kbar-l{display:flex;align-items:baseline;gap:13px;}
  .kbar-r{font-size:26px;font-weight:700;padding:5px 13px;border-radius:8px;
    background:rgba(255,255,255,.09);color:var(--dim);letter-spacing:-.3px;}
  .kbar.me .kbar-r{background:rgba(255,92,92,.18);color:var(--up);}
  .kbar-n{font-size:38px;font-weight:800;letter-spacing:-1px;}
  .kbar-v{font-size:34px;font-weight:800;letter-spacing:-.8px;}
  .kbar-t{height:26px;border-radius:8px;background:rgba(255,255,255,.06);overflow:hidden;}
  .kbar-f{height:100%;border-radius:8px;background:linear-gradient(90deg,rgba(255,255,255,.30),rgba(255,255,255,.16));}
  .kbar.me .kbar-f{background:linear-gradient(90deg,var(--up),rgba(255,92,92,.45));}
  .kbar.ref .kbar-f{background:linear-gradient(90deg,var(--teal),rgba(37,224,200,.35));}
  .gap{margin-top:28px;padding:26px 30px;border-radius:20px;background:rgba(37,224,200,.09);
    border:1px solid rgba(37,224,200,.28);}
  .gap-t{font-size:28px;font-weight:700;color:var(--teal);letter-spacing:-.4px;}
  .gap-v{font-size:48px;font-weight:800;letter-spacing:-1.4px;margin-top:8px;}
  .gap-d{font-size:31px;line-height:1.5;color:#DFF7F3;font-weight:500;margin-top:9px;letter-spacing:-.5px;}
  `;
  const bar = (b) => `
    <div class="kbar ${b.me ? "me" : b.ref ? "ref" : ""}">
      <div class="kbar-h">
        <div class="kbar-l"><span class="kbar-n">${esc(b.name)}</span><span class="kbar-r">세계 ${esc(b.rank)}위</span></div>
        <div class="kbar-v mono">${esc(b.cap)}</div>
      </div>
      <div class="kbar-t"><div class="kbar-f" style="width:${b.w}%"></div></div>
    </div>`;
  return shell(`<div class="wrap">
  ${topBar(d.slotLabel, d.dateLabel)}
  <div class="kbody">
    <div class="kicker" style="margin-bottom:20px;">◆ 한국 기업의 자리</div>
    <div class="ptitle">${d.krTitle}</div>
    <div class="kb">${d.krBars.map(bar).join("")}</div>
    <div class="gap">
      <div class="gap-t">${esc(d.gapLabel)}</div>
      <div class="gap-v mono">${esc(d.gapValue)}</div>
      <div class="gap-d">${d.gapDesc}</div>
    </div>
  </div>
  ${foot("TOP100 전체 순위는 totalmoney.kr 글로벌랭킹", "", 2)}
  </div>`, css);
}

/* ───────── 훅의 답 — 그 두 종목이 무엇이고 얼마나 쏠렸는지 (마감시황 2번) ─────────
   1번 카드에서 "딱 두 종목"이라고 던졌으면 바로 다음 장에서 이름과 금액을 줘야 한다.
   답을 뒤쪽 카드에 작게 숨겨두면 훅이 낚시가 되고, 그건 계정 신뢰를 깎는다. */
export function slideFocus(d) {
  const css = `
  .fcbody{flex:1;display:flex;flex-direction:column;margin-top:30px;}
  .fc2{margin-top:28px;display:grid;grid-template-columns:1fr 1fr;gap:16px;}
  .fcc{padding:28px 28px 26px;border-radius:22px;
    background:linear-gradient(180deg,rgba(255,92,92,.13),rgba(255,92,92,.03));
    border:1px solid rgba(255,92,92,.34);}
  .fcc .mk{font-size:24px;font-weight:700;color:var(--dim-2);letter-spacing:-.3px;}
  .fcc .nm{font-size:44px;font-weight:800;letter-spacing:-1.3px;margin-top:6px;}
  .fcc .amt{font-size:54px;font-weight:800;letter-spacing:-1.8px;margin-top:16px;color:var(--up);}
  .fcc .lb{font-size:24px;font-weight:600;color:var(--dim);margin-top:4px;letter-spacing:-.3px;}
  .fcc .pc{margin-top:14px;display:inline-block;padding:7px 15px;border-radius:9px;
    background:rgba(255,92,92,.18);font-size:28px;font-weight:800;color:var(--up);letter-spacing:-.5px;}
  .shr{margin-top:26px;}
  .shr-h{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:13px;}
  .shr-t{font-size:27px;font-weight:700;color:var(--dim);letter-spacing:-.4px;}
  .shr-v{font-size:38px;font-weight:800;color:var(--up);letter-spacing:-1px;}
  .shr-b{height:46px;border-radius:12px;overflow:hidden;display:flex;background:rgba(255,255,255,.06);}
  .shr-b i{display:flex;align-items:center;padding:0 18px;font-size:25px;font-weight:700;
    letter-spacing:-.3px;font-style:normal;white-space:nowrap;}
  .shr-b i.a{background:linear-gradient(90deg,var(--up),rgba(255,92,92,.55));color:#fff;}
  .shr-b i.b{color:var(--dim-2);}
  .fcn{margin-top:26px;padding:24px 28px;border-radius:20px;background:rgba(37,224,200,.09);
    border:1px solid rgba(37,224,200,.28);font-size:32px;line-height:1.5;font-weight:600;
    letter-spacing:-.6px;color:#DFF7F3;}
  .fcn span{color:var(--teal);font-weight:800;}
  .fcx{margin-top:auto;padding-top:26px;display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
  .fcx-c{padding:20px 22px;border-radius:17px;background:rgba(255,255,255,.045);border:1px solid var(--line);}
  .fcx-c .k{font-size:25px;font-weight:600;color:var(--dim);letter-spacing:-.3px;}
  .fcx-c .v{font-size:35px;font-weight:800;letter-spacing:-.9px;margin-top:6px;}
  .fcx-c .p{font-size:26px;font-weight:700;letter-spacing:-.4px;margin-top:3px;}
  `;
  const card = (c) => `
    <div class="fcc"><div class="mk">거래대금 ${esc(c.rank)}위 · ${esc(c.market)}</div>
      <div class="nm">${esc(c.name)}</div>
      <div class="amt mono">${esc(c.amount)}</div>
      <div class="lb">오늘 거래대금</div>
      <div class="pc mono">${esc(c.pct)}</div></div>`;
  return shell(`<div class="wrap">
  ${topBar(d.slotLabel, d.dateLabel)}
  <div class="fcbody">
    <div class="kicker" style="margin-bottom:20px;">◆ 그 두 종목은</div>
    <div class="ptitle">${d.focusTitle}</div>
    <div class="fc2">${d.focusPair.map(card).join("")}</div>
    <div class="shr">
      <div class="shr-h"><div class="shr-t">${esc(d.shareLabel)}</div><div class="shr-v mono">${esc(d.sharePct)}</div></div>
      <div class="shr-b"><i class="a" style="width:${d.shareWidth}%">두 종목 ${esc(d.shareA)}</i><i class="b">나머지 ${esc(d.shareB)}</i></div>
    </div>
    <div class="fcn">${d.focusNote}</div>
    <div class="fcx">${(d.focusIndexes || []).map((x) => `
      <div class="fcx-c"><div class="k">${esc(x.name)}</div>
        <div class="v mono">${esc(x.value)}</div>
        <div class="p ${x.dir} mono">${esc(x.pct)}</div></div>`).join("")}</div>
  </div>
  ${foot("출처 · 한국투자증권 실시간 시세 · 거래대금 상위 30종목 기준", "", 1)}
  </div>`, css);
}
