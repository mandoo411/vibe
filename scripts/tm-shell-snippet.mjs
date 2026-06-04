/** NAV/TICKER/FOOTER/BOTTOM snippets — apply-site-shell.mjs 에서 사용 */

export function shellHeader(activeHref) {
  const links = [
    { href: "./index.html", label: "홈", home: true },
    { href: "./stock-analysis.html", label: "AI 종목분석" },
    { href: "./briefing.html", label: "브리핑" },
    { href: "./daily-market.html", label: "마감시황" },
    { href: "./realtime.html", label: "실시간시세" },
    { href: "./us-market.html", label: "미국시장" },
    { href: "./crypto.html", label: "암호화폐" },
    { href: "./world-market.html", label: "글로벌 랭킹" },
    { href: "./weekly-market.html", label: "일정" },
  ];

  const menu = links
    .map((l) => {
      const cur = l.href === activeHref || (activeHref === "/stock-analysis.html" && l.href === "./stock-analysis.html");
      const cls = l.home ? "home-nav__link home-nav__home-btn" : "home-nav__link";
      const inner = l.home ? '<i class="ti ti-home" aria-hidden="true"></i>' : l.label;
      const aria = cur ? ' aria-current="page"' : "";
      return `<a class="${cls}" href="${l.href}"${aria}${l.home ? ' title="홈"' : ""}>${inner}</a>`;
    })
    .join("\n          ");

  return `      <header class="home-nav" aria-label="주요 메뉴">
        <a class="home-nav__logo" href="./index.html" aria-label="TotalMoney AI 홈">
          <div class="home-nav__logo-box" aria-hidden="true">
            <span>TM</span>
            <span>AI</span>
          </div>
          <div>
            <div class="home-nav__brand-name">TotalMoney</div>
            <div class="home-nav__brand-sub">
              <span>powered by</span>
              <span class="home-nav__ai-badge">AI</span>
            </div>
          </div>
        </a>
        <button type="button" class="home-nav__toggle" aria-label="메뉴 열기" aria-expanded="false">
          <i class="ti ti-menu-2" aria-hidden="true"></i>
        </button>
        <nav class="home-nav__menu">
          ${menu}
          <button type="button" class="home-nav__theme" id="theme-toggle" aria-label="테마 전환" title="테마 전환">
            <i class="ti ti-moon" id="theme-icon" aria-hidden="true"></i>
          </button>
        </nav>
      </header>

      <div class="home-ticker" id="home-ticker" aria-label="실시간 시장 지표" aria-live="polite">
        <span class="home-empty">시장 지표 로딩 중…</span>
      </div>

      <main class="tm-main">`;
}

export const shellFooter = `      </main>

      <footer class="home-footer">
        <div class="home-footer__top">
          <div>
            <div class="home-footer__brand-name">TotalMoney AI</div>
            <div class="home-footer__slogan">실시간 시장을 AI로 분석하세요</div>
          </div>
          <div class="home-footer__divider" aria-hidden="true"></div>
          <a class="home-footer__tg" href="https://t.me/mandoo_market_bot" target="_blank" rel="noopener noreferrer">텔레그램봇 @mandoo_market_bot</a>
          <div class="home-footer__sns">
            <a href="#" aria-label="Instagram"><i class="ti ti-brand-instagram"></i></a>
            <a href="#" aria-label="YouTube"><i class="ti ti-brand-youtube"></i></a>
            <a href="#" aria-label="X"><i class="ti ti-brand-x"></i></a>
          </div>
        </div>
        <div class="home-footer__bottom">
          <span>© 2026 TotalMoney AI</span>
          <div class="home-footer__links">
            <a href="#">이용약관</a>
            <a href="#">개인정보처리방침</a>
            <a href="mailto:contact@totalmoney.ai">문의하기</a>
          </div>
          <span>Data by KIS · FMP · CMC</span>
        </div>
      </footer>

      <nav class="tm-bottom-nav" aria-label="모바일 빠른 이동">
        <a class="tm-bottom-nav__item" href="./index.html" data-tm-tab="home"><i class="ti ti-home" aria-hidden="true"></i><span>홈</span></a>
        <a class="tm-bottom-nav__item" href="./realtime.html" data-tm-tab="realtime"><i class="ti ti-activity" aria-hidden="true"></i><span>실시간시세</span></a>
        <a class="tm-bottom-nav__item" href="./crypto.html" data-tm-tab="crypto"><i class="ti ti-currency-bitcoin" aria-hidden="true"></i><span>암호화폐</span></a>
        <a class="tm-bottom-nav__item" href="./weekly-market.html" data-tm-tab="schedule"><i class="ti ti-calendar" aria-hidden="true"></i><span>일정</span></a>
        <a class="tm-bottom-nav__item" href="./stock-analysis.html" data-tm-tab="analysis"><i class="ti ti-robot" aria-hidden="true"></i><span>AI분석</span></a>
      </nav>
    </div>`;
