// TotalMoney AI 카드뉴스 v2 — 공통 디자인 시스템 (다크 네이비 / 캐러셀 1080x1350)
export const CSS = `
@font-face{
  font-family:'Pretendard';
  src:url('./fonts/PretendardVariable.woff2') format('woff2-variations');
  font-weight:45 920;font-style:normal;font-display:block;
}

:root{
  --ink:#050A16;
  --navy:#0A1B34;
  --teal:#25E0C8;
  --teal-dim:#0F8387;
  --up:#FF5C5C;
  --down:#5B9BFF;
  --white:#FFFFFF;
  --dim:#9BAAC4;
  --dim-2:#6C7C97;
  --line:rgba(255,255,255,.10);
  --font:'Pretendard','Noto Sans CJK KR','Noto Sans KR',system-ui,sans-serif;
}
*{margin:0;padding:0;box-sizing:border-box;-webkit-font-smoothing:antialiased;}
body{
  width:1080px;height:1350px;overflow:hidden;
  font-family:var(--font);color:var(--white);
  background:var(--ink);position:relative;
}
.bg{position:absolute;inset:0;
  background:
    radial-gradient(900px 620px at 88% -8%, rgba(37,224,200,.20) 0%, transparent 62%),
    radial-gradient(760px 620px at -10% 108%, rgba(37,224,200,.10) 0%, transparent 60%),
    linear-gradient(158deg,#0A1B34 0%,#071122 46%,#050A16 100%);
}
.bg::after{content:'';position:absolute;inset:0;
  background-image:linear-gradient(rgba(255,255,255,.028) 1px,transparent 1px),
                   linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px);
  background-size:90px 90px;}
.slash{position:absolute;left:0;right:0;top:0;height:10px;
  background:linear-gradient(90deg,var(--teal) 0%,var(--teal-dim) 42%,transparent 100%);}
.wrap{position:relative;width:100%;height:100%;padding:70px 74px 62px;display:flex;flex-direction:column;}

.top{display:flex;align-items:center;justify-content:space-between;}
.brand{display:flex;align-items:center;gap:14px;}
.logo{width:52px;height:52px;border-radius:15px;background:linear-gradient(135deg,var(--teal) 0%,var(--teal-dim) 100%);
  display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#04121F;letter-spacing:-.5px;}
.brand-t{font-size:25px;font-weight:700;letter-spacing:-.3px;line-height:1.2;}
.brand-s{font-size:17px;color:var(--dim-2);font-weight:500;margin-top:2px;line-height:1.2;}
.slot{display:flex;align-items:center;gap:10px;font-size:19px;font-weight:600;color:var(--dim);}
.slot .dot{width:9px;height:9px;border-radius:50%;background:var(--teal);box-shadow:0 0 14px var(--teal);}

.kicker{display:inline-flex;align-items:center;gap:11px;align-self:flex-start;
  padding:11px 22px;border-radius:999px;border:1.5px solid rgba(37,224,200,.42);
  background:rgba(37,224,200,.10);font-size:21px;font-weight:700;color:var(--teal);letter-spacing:-.2px;}
.ptitle{font-size:52px;font-weight:800;letter-spacing:-1.6px;line-height:1.24;}
.psub{font-size:23px;color:var(--dim);font-weight:500;margin-top:12px;letter-spacing:-.3px;}

.foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;
  padding-top:24px;border-top:1px solid var(--line);}
.foot-l{font-size:20px;color:var(--dim-2);font-weight:500;letter-spacing:-.2px;}
.foot-r{display:flex;align-items:center;gap:11px;font-size:21px;font-weight:700;color:var(--teal);}
.pager{display:flex;gap:7px;align-items:center;}
.pager i{width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.20);display:block;}
.pager i.on{background:var(--teal);width:30px;border-radius:5px;}

.hl{color:var(--teal);}
.hl-u{background:linear-gradient(180deg,transparent 60%,rgba(37,224,200,.28) 60%);padding:0 4px;}
.up{color:var(--up);} .down{color:var(--down);}
.mono{font-variant-numeric:tabular-nums;letter-spacing:-.5px;}
`;

export const shell = (body, extraCss = "") => `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<style>${CSS}${extraCss}</style></head><body><div class="bg"></div><div class="slash"></div>${body}</body></html>`;

export const topBar = (slotLabel, dateLabel) => `
<div class="top">
  <div class="brand">
    <div class="logo">TM</div>
    <div><div class="brand-t">TotalMoney AI</div><div class="brand-s">@totalmoney_ai</div></div>
  </div>
  <div class="slot"><span class="dot"></span>${slotLabel} · ${dateLabel}</div>
</div>`;

export const pager = (n, total = 5) =>
  `<div class="pager">${Array.from({ length: total }, (_, i) => `<i class="${i === n ? "on" : ""}"></i>`).join("")}</div>`;

export const foot = (leftText, rightHTML, n) => `
<div class="foot">
  <div class="foot-l">${leftText}</div>
  ${rightHTML ? `<div class="foot-r">${rightHTML}</div>` : pager(n)}
</div>`;
