/**
 * 카드뉴스 v2 — 공통 디자인 시스템 (1080x1350)
 *
 * ⚠️ 타이포 크기를 줄이지 말 것.
 * 인스타 피드에서 1080px 카드는 iPhone 화면 약 390pt로 축소된다(배율 0.36).
 * 즉 카드의 24px 글자는 손에서 8.7pt로 보이고, 이건 확대해야 읽히는 크기다.
 * 읽기 편한 본문 하한을 13pt로 잡으면 카드 기준 36px이 된다. 아래 스케일은 그 계산에서 나왔다.
 *   본문 34~36px → 12.3~13.0pt / 항목 제목 36~40px → 13~14.4pt / 각주 26px → 9.4pt
 *
 * ⚠️ 우상단에 요소를 두지 말 것.
 * 인스타 캐러셀은 이미지 우상단에 자체 페이지 배지(1/6)를 덮어 그린다.
 * 그래서 브랜드·슬롯·날짜를 전부 좌측 블록으로 모았다.
 */
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
  --up:#FF6B6B;
  --down:#6BA5FF;
  --white:#FFFFFF;
  /* 본문 색. 이전(#9BAAC4)은 어두운 배경에서 대비가 모자라 피로했다 */
  --body:#DCE6F5;
  --dim:#B6C5DC;
  --dim-2:#8FA0BC;
  --line:rgba(255,255,255,.13);
  --panel:rgba(255,255,255,.055);
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
    radial-gradient(900px 620px at 88% -8%, rgba(37,224,200,.18) 0%, transparent 62%),
    radial-gradient(760px 620px at -10% 108%, rgba(37,224,200,.09) 0%, transparent 60%),
    linear-gradient(158deg,#0A1B34 0%,#071122 46%,#050A16 100%);
}
.bg::after{content:'';position:absolute;inset:0;
  background-image:linear-gradient(rgba(255,255,255,.026) 1px,transparent 1px),
                   linear-gradient(90deg,rgba(255,255,255,.026) 1px,transparent 1px);
  background-size:90px 90px;}
.slash{position:absolute;left:0;right:0;top:0;height:10px;
  background:linear-gradient(90deg,var(--teal) 0%,var(--teal-dim) 42%,transparent 100%);}
.wrap{position:relative;width:100%;height:100%;padding:64px 68px 58px;display:flex;flex-direction:column;}

/* ── 상단: 좌측 한 블록으로 모음. 우상단은 인스타 페이지 배지 자리라 비워 둔다 ── */
.top{display:flex;align-items:center;gap:18px;padding-right:190px;}
.logo{flex:0 0 auto;width:62px;height:62px;border-radius:18px;
  background:linear-gradient(135deg,var(--teal) 0%,var(--teal-dim) 100%);
  display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;
  color:#04121F;letter-spacing:-.5px;}
.brand-t{font-size:31px;font-weight:700;letter-spacing:-.5px;line-height:1.18;}
.brand-s{display:flex;align-items:center;gap:11px;margin-top:5px;
  font-size:23px;font-weight:600;color:var(--dim);letter-spacing:-.3px;line-height:1.2;}
.brand-s .dot{width:9px;height:9px;border-radius:50%;background:var(--teal);
  box-shadow:0 0 14px var(--teal);flex:0 0 auto;}

/* ── 페이지 라벨 ── */
.kicker{display:inline-flex;align-items:center;gap:11px;align-self:flex-start;
  padding:13px 26px;border-radius:999px;border:1.5px solid rgba(37,224,200,.45);
  background:rgba(37,224,200,.12);font-size:26px;font-weight:700;color:var(--teal);letter-spacing:-.3px;}
.ptitle{font-size:58px;font-weight:800;letter-spacing:-1.9px;line-height:1.22;}
.psub{font-size:28px;color:var(--body);font-weight:500;margin-top:12px;letter-spacing:-.4px;}

/* ── 하단: 인스타가 하단 중앙에 자체 인디케이터를 그리므로 점은 넣지 않는다 ── */
.foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:20px;
  padding-top:24px;border-top:1px solid var(--line);}
.foot-l{font-size:24px;color:var(--dim-2);font-weight:500;letter-spacing:-.3px;}
.foot-r{display:flex;align-items:center;gap:12px;font-size:26px;font-weight:700;color:var(--teal);
  white-space:nowrap;}

.hl{color:var(--teal);}
.up{color:var(--up);} .down{color:var(--down);}
.mono{font-variant-numeric:tabular-nums;letter-spacing:-.5px;}
`;

export const shell = (body, extraCss = "") => `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<style>${CSS}${extraCss}</style></head><body><div class="bg"></div><div class="slash"></div>${body}</body></html>`;

export const topBar = (slotLabel, dateLabel) => `
<div class="top">
  <div class="logo">TM</div>
  <div>
    <div class="brand-t">TotalMoney AI</div>
    <div class="brand-s"><span class="dot"></span>${slotLabel} · ${dateLabel}</div>
  </div>
</div>`;

/* 페이지 인디케이터는 인스타가 그려 준다. 호환을 위해 시그니처만 남긴다. */
export const PAGER = { i: 0, n: 5 };
export const setPager = (i, n) => { PAGER.i = i; PAGER.n = n; };
export const pager = () => "";

export const foot = (leftText, rightHTML) => `
<div class="foot">
  <div class="foot-l">${leftText}</div>
  ${rightHTML ? `<div class="foot-r">${rightHTML}</div>` : ""}
</div>`;
