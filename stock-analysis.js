(function () {
  "use strict";

  // Access control now lives in site-shell.js (window.tmHasAnalysisAccess / tmOpenAnalysisGate)

  let input = null;
  let btn = null;
  let panel = null;
  let stockList = [];
  let running = false;
  let loadingTimer = null;
  let progressTimer = null;
  let lwChartsPromise = null;
  let aiChartBundle = null;
  const acState = { open: false, items: [], active: -1 };

  const LOADING_STEPS = [
    "최신 뉴스 및 재료 수집 중...",
    "기술적 지표 분석 중...",
    "재료 강도 평가 중...",
    "AI 시나리오 시뮬레이션 중...",
    "최종 투자 판단 생성 중...",
  ];

  const CSP_SAFE = true; // eval/new Function 미사용, JSON.parse만 사용

  /**
   * 2026-07-10: AI 종목분석에 미국주식·암호화폐 지원 추가.
   * 예전엔 6자리 국내 종목코드만 받아서(runAnalysis의 /^\d{6}$/ 하드 게이트) 그 외
   * 입력은 전부 "종목을 찾을 수 없습니다"로 막혔다. 이제는 이 두 정적 별칭 테이블로
   * 한글/영문 이름·티커·심볼을 먼저 매칭해서 market("US"|"CRYPTO")까지 함께 넘긴다.
   * (KR은 기존 stockList 그대로 사용, 변경 없음)
   */
  const CRYPTO_ALIASES = [
    { symbol: "BTC", name: "비트코인", aliases: ["비트코인", "bitcoin", "btc"] },
    { symbol: "ETH", name: "이더리움", aliases: ["이더리움", "ethereum", "eth"] },
    { symbol: "XRP", name: "리플", aliases: ["리플", "ripple", "xrp"] },
    { symbol: "SOL", name: "솔라나", aliases: ["솔라나", "solana", "sol"] },
    { symbol: "BNB", name: "바이낸스코인", aliases: ["바이낸스코인", "바이낸스 코인", "binance coin", "bnb"] },
    { symbol: "DOGE", name: "도지코인", aliases: ["도지코인", "도지 코인", "dogecoin", "doge"] },
    { symbol: "ADA", name: "에이다", aliases: ["에이다", "카르다노", "cardano", "ada"] },
    { symbol: "TRX", name: "트론", aliases: ["트론", "tron", "trx"] },
    { symbol: "TON", name: "톤코인", aliases: ["톤코인", "톤 코인", "toncoin", "ton"] },
    { symbol: "AVAX", name: "아발란체", aliases: ["아발란체", "avalanche", "avax"] },
    { symbol: "LINK", name: "체인링크", aliases: ["체인링크", "chainlink", "link"] },
    { symbol: "SHIB", name: "시바이누", aliases: ["시바이누", "시바 이누", "shiba inu", "shib"] },
    { symbol: "DOT", name: "폴카닷", aliases: ["폴카닷", "polkadot", "dot"] },
    { symbol: "MATIC", name: "폴리곤", aliases: ["폴리곤", "polygon", "matic"] },
    { symbol: "LTC", name: "라이트코인", aliases: ["라이트코인", "라이트 코인", "litecoin", "ltc"] },
    { symbol: "BCH", name: "비트코인캐시", aliases: ["비트코인캐시", "비트코인 캐시", "bitcoin cash", "bch"] },
    { symbol: "ICP", name: "인터넷컴퓨터", aliases: ["인터넷컴퓨터", "인터넷 컴퓨터", "internet computer", "icp"] },
    { symbol: "ETC", name: "이더리움클래식", aliases: ["이더리움클래식", "이더리움 클래식", "ethereum classic", "etc"] },
    { symbol: "NEAR", name: "니어프로토콜", aliases: ["니어프로토콜", "니어 프로토콜", "near protocol", "near"] },
    { symbol: "UNI", name: "유니스왑", aliases: ["유니스왑", "uniswap", "uni"] },
    { symbol: "ATOM", name: "코스모스", aliases: ["코스모스", "cosmos", "atom"] },
    { symbol: "XLM", name: "스텔라루멘", aliases: ["스텔라루멘", "스텔라", "stellar", "xlm"] },
    { symbol: "HBAR", name: "헤데라", aliases: ["헤데라", "hedera", "hbar"] },
    { symbol: "SUI", name: "수이", aliases: ["수이", "sui"] },
    { symbol: "APT", name: "앱토스", aliases: ["앱토스", "aptos", "apt"] },
    { symbol: "USDT", name: "테더", aliases: ["테더", "tether", "usdt"] },
    { symbol: "USDC", name: "USD코인", aliases: ["usd코인", "usd 코인", "usdc", "usd coin"] },
  ];

  const US_ALIASES = [
    { symbol: "NVDA", name: "엔비디아", aliases: ["엔비디아", "nvidia"] },
    { symbol: "AAPL", name: "애플", aliases: ["애플", "apple"] },
    { symbol: "MSFT", name: "마이크로소프트", aliases: ["마이크로소프트", "microsoft"] },
    { symbol: "GOOGL", name: "알파벳(구글)", aliases: ["알파벳", "구글", "google", "alphabet"] },
    { symbol: "AMZN", name: "아마존", aliases: ["아마존", "amazon"] },
    { symbol: "META", name: "메타", aliases: ["메타", "페이스북", "facebook", "meta"] },
    { symbol: "TSLA", name: "테슬라", aliases: ["테슬라", "tesla"] },
    { symbol: "AVGO", name: "브로드컴", aliases: ["브로드컴", "broadcom"] },
    { symbol: "AMD", name: "AMD", aliases: ["amd"] },
    { symbol: "INTC", name: "인텔", aliases: ["인텔", "intel"] },
    { symbol: "MU", name: "마이크론", aliases: ["마이크론", "micron"] },
    { symbol: "ASML", name: "ASML", aliases: ["asml"] },
    { symbol: "ORCL", name: "오라클", aliases: ["오라클", "oracle"] },
    { symbol: "CRM", name: "세일즈포스", aliases: ["세일즈포스", "salesforce"] },
    { symbol: "ADBE", name: "어도비", aliases: ["어도비", "adobe"] },
    { symbol: "NFLX", name: "넷플릭스", aliases: ["넷플릭스", "netflix"] },
    { symbol: "PLTR", name: "팔란티어", aliases: ["팔란티어", "palantir"] },
    { symbol: "COIN", name: "코인베이스", aliases: ["코인베이스", "coinbase"] },
    { symbol: "RGTI", name: "리게티컴퓨팅", aliases: ["리게티", "리게티컴퓨팅", "rigetti"] },
    { symbol: "IONQ", name: "아이온큐", aliases: ["아이온큐", "ionq"] },
    { symbol: "SMCI", name: "슈퍼마이크로컴퓨터", aliases: ["슈퍼마이크로", "super micro"] },
    { symbol: "QCOM", name: "퀄컴", aliases: ["퀄컴", "qualcomm"] },
    { symbol: "TXN", name: "텍사스인스트루먼트", aliases: ["텍사스인스트루먼트", "texas instruments"] },
    { symbol: "JPM", name: "JP모건", aliases: ["jp모건", "jpmorgan", "jp morgan"] },
    { symbol: "V", name: "비자", aliases: ["비자", "visa"] },
    { symbol: "MA", name: "마스터카드", aliases: ["마스터카드", "mastercard"] },
    { symbol: "WMT", name: "월마트", aliases: ["월마트", "walmart"] },
    { symbol: "KO", name: "코카콜라", aliases: ["코카콜라", "coca cola", "coca-cola"] },
    { symbol: "DIS", name: "디즈니", aliases: ["디즈니", "disney"] },
    { symbol: "BA", name: "보잉", aliases: ["보잉", "boeing"] },
    { symbol: "XOM", name: "엑슨모빌", aliases: ["엑슨모빌", "exxon mobil", "exxon"] },
    { symbol: "CVX", name: "셰브론", aliases: ["셰브론", "chevron"] },
    { symbol: "PFE", name: "화이자", aliases: ["화이자", "pfizer"] },
    { symbol: "JNJ", name: "존슨앤존슨", aliases: ["존슨앤존슨", "johnson"] },
    { symbol: "UNH", name: "유나이티드헬스", aliases: ["유나이티드헬스", "unitedhealth"] },
    { symbol: "LLY", name: "일라이릴리", aliases: ["일라이릴리", "eli lilly"] },
    { symbol: "COST", name: "코스트코", aliases: ["코스트코", "costco"] },
    { symbol: "HD", name: "홈디포", aliases: ["홈디포", "home depot"] },
    { symbol: "NKE", name: "나이키", aliases: ["나이키", "nike"] },
    { symbol: "SBUX", name: "스타벅스", aliases: ["스타벅스", "starbucks"] },
    { symbol: "UBER", name: "우버", aliases: ["우버", "uber"] },
    { symbol: "ABNB", name: "에어비앤비", aliases: ["에어비앤비", "airbnb"] },
    { symbol: "SNOW", name: "스노우플레이크", aliases: ["스노우플레이크", "snowflake"] },
    { symbol: "SHOP", name: "쇼피파이", aliases: ["쇼피파이", "shopify"] },
    { symbol: "PYPL", name: "페이팔", aliases: ["페이팔", "paypal"] },
    { symbol: "ARM", name: "ARM홀딩스", aliases: ["arm홀딩스", "arm holdings", "arm"] },
    { symbol: "MRVL", name: "마벨테크놀로지", aliases: ["마벨", "marvell"] },
    { symbol: "TSM", name: "TSMC", aliases: ["tsmc", "대만반도체"] },
  ];

  function findAliasMatch(list, qRaw) {
    const q = String(qRaw || "").trim().toLowerCase();
    if (!q) return null;
    const bySymbol = list.find((x) => x.symbol.toLowerCase() === q);
    if (bySymbol) return bySymbol;
    const byAliasExact = list.find((x) => x.aliases.some((a) => a === q));
    if (byAliasExact) return byAliasExact;
    const partial = list.filter((x) => x.aliases.some((a) => a.includes(q) || q.includes(a)));
    if (partial.length === 1) return partial[0];
    return null;
  }

  function looksLikeUsTicker(q) {
    return /^[A-Za-z]{1,5}(\.[A-Za-z])?$/.test(String(q || "").trim());
  }

  function resolveNonKrAsset(qRaw) {
    const q = String(qRaw || "").trim();
    if (!q) return null;
    const crypto = findAliasMatch(CRYPTO_ALIASES, q);
    if (crypto) return { code: crypto.symbol, name: crypto.name, market: "CRYPTO" };
    const us = findAliasMatch(US_ALIASES, q);
    if (us) return { code: us.symbol, name: us.name, market: "US" };
    // 티커 형태인데 별칭 테이블에 없는 경우의 최종 판별(암호화폐 동적 조회 포함)은
    // resolveForAnalysis에서 처리한다 (2026-07-11, CoinMarketCap 전종목 지원).
    return null;
  }

  /** 2026-07-11: 정적 별칭 테이블(메이저 코인 ~27개)에 없는 티커도 분석할 수 있도록,
   * CoinMarketCap 전체 코인 목록에 실제로 존재하는지 서버(api/crypto.js)에 물어본다.
   * 존재하면 암호화폐로, 아니면(혹은 조회 실패 시) 기존처럼 미국주식으로 취급한다. */
  async function resolveCryptoDynamic(qRaw) {
    const symbol = String(qRaw || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!symbol) return null;
    try {
      const ctrl = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null;
      const res = await fetch(`/api/crypto-data?action=resolve&symbol=${encodeURIComponent(symbol)}`, {
        cache: "no-store",
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      const data = safeParseJson(await res.text()) || {};
      if (!res.ok || !data.found) return null;
      return { code: symbol, name: data.name || symbol, market: "CRYPTO" };
    } catch (err) {
      console.warn("[AI분석] 암호화폐 동적 조회 실패", err);
      return null;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toNum(v) {
    const n = Number(String(v == null ? "" : v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function safeParseJson(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function normalizeNameKey(name) {
    return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[()·•.,/\\'"]/g, "")
      .replace(/주식회사|㈜/g, "");
  }

  function code6Maybe(s) {
    const digits = String(s || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length === 6) return digits;
    if (digits.length < 6) return digits.padStart(6, "0");
    return digits.slice(-6);
  }

  async function loadStockList() {
    if (stockList.length) return stockList;
    try {
      const res = await fetch("/assets/stock-list.json?t=" + Date.now(), { cache: "no-store" });
      const data = safeParseJson(await res.text());
      if (Array.isArray(data)) {
        stockList = data
          .filter((x) => x && x.code && x.name)
          .map((x) => ({
            code: code6Maybe(x.code),
            name: String(x.name || "").trim(),
            market: String(x.market || "").toUpperCase() === "KOSDAQ" ? "KOSDAQ" : "KOSPI",
          }))
          .filter((x) => /^\d{6}$/.test(x.code) && x.name);
      }
    } catch (err) {
      console.error("[AI분석] stock-list 로드 실패", err);
    }
    return stockList;
  }

  function resolveQueryLocal(qRaw) {
    const q = String(qRaw || "").trim();
    if (!q) return null;
    const code6 = code6Maybe(q);
    if (/^\d{6}$/.test(code6)) {
      const hit = stockList.find((x) => x.code === code6);
      return { code: code6, name: hit ? hit.name : code6, market: "KR" };
    }
    const key = normalizeNameKey(q);
    const exact = stockList.find((x) => normalizeNameKey(x.name) === key);
    if (exact) return { code: exact.code, name: exact.name, market: "KR" };
    const partial = stockList.filter((x) => {
      const nk = normalizeNameKey(x.name);
      return nk.includes(key) || key.includes(nk);
    });
    if (partial.length === 1) return { code: partial[0].code, name: partial[0].name, market: "KR" };
    // 국내 종목에서 못 찾으면 미국주식/암호화폐 별칭 테이블에서 시도.
    return resolveNonKrAsset(q);
  }

  function acHost() {
    return document.getElementById("ai-stock-ac");
  }

  function setAutocompleteExpanded(open) {
    if (input) input.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeAutocomplete() {
    const host = acHost();
    acState.open = false;
    acState.items = [];
    acState.active = -1;
    if (host) host.hidden = true;
    setAutocompleteExpanded(false);
  }

  function renderAutocomplete(items, total) {
    const host = acHost();
    if (!host) return;
    if (!items || !items.length) {
      closeAutocomplete();
      return;
    }
    acState.open = true;
    acState.items = items;
    if (acState.active >= items.length) acState.active = items.length - 1;
    if (acState.active < 0) acState.active = 0;
    host.hidden = false;
    setAutocompleteExpanded(true);
    host.innerHTML =
      items
        .map((it, idx) => {
          const activeCls = idx === acState.active ? " is-active" : "";
          return `<div class="rt-ac-item${activeCls}" data-ac-idx="${idx}" role="option" tabindex="-1">
            <div class="rt-ac-item__main">
              <span class="rt-ac-item__name">${escapeHtml(it.name)}</span>
              <span class="rt-ac-item__code">${escapeHtml(it.code)}</span>
            </div>
            <span class="rt-ac-item__badge">${escapeHtml(it.market)}</span>
          </div>`;
        })
        .join("") +
      (total > items.length ? `<div class="rt-ac-more">외 ${escapeHtml(String(total - items.length))}개 더 있습니다</div>` : "");
  }

  function moveAutocomplete(delta) {
    if (!acState.open || !acState.items.length) return;
    const next = Math.max(0, Math.min(acState.items.length - 1, (acState.active || 0) + delta));
    acState.active = next;
    renderAutocomplete(acState.items, acState.items.length);
  }

  function pickActiveAutocomplete() {
    if (!acState.open || !acState.items.length) return null;
    const idx = acState.active;
    return idx >= 0 && idx < acState.items.length ? acState.items[idx] : null;
  }

  function filterStocksForAutocomplete(q) {
    const lc = q.toLowerCase();
    const kr = (stockList || []).filter((x) => {
      const name = String(x.name || "").toLowerCase();
      const code = String(x.code || "");
      return name.includes(lc) || code.includes(q) || code.includes(lc);
    });
    const nonKr = [];
    for (const x of CRYPTO_ALIASES) {
      if (x.symbol.toLowerCase().includes(lc) || x.aliases.some((a) => a.includes(lc))) {
        nonKr.push({ code: x.symbol, name: x.name, market: "CRYPTO" });
      }
    }
    for (const x of US_ALIASES) {
      if (x.symbol.toLowerCase().includes(lc) || x.aliases.some((a) => a.includes(lc))) {
        nonKr.push({ code: x.symbol, name: x.name, market: "US" });
      }
    }
    return kr.concat(nonKr);
  }

  function pickStockItem(item) {
    if (!item || !input) return;
    input.value = item.code;
    closeAutocomplete();
    runAnalysis(item.code);
  }

  async function resolveForAnalysis(qRaw) {
    await loadStockList();
    const q = String(qRaw || "").trim();
    if (!q) return null;

    const params = new URLSearchParams(window.location.search);
    const urlCode = code6Maybe(params.get("code") || "");
    const urlName = String(params.get("name") || "").trim();
    if (/^\d{6}$/.test(urlCode) && (q === urlCode || q === urlName || !params.get("q"))) {
      return { code: urlCode, name: urlName || q, market: "KR" };
    }

    const local = resolveQueryLocal(q);
    if (local) return local;

    // 국내 종목·별칭 테이블 어디에도 없고 티커 모양이면, 미국주식으로 단정하기 전에
    // CoinMarketCap에 있는 코인인지 먼저 확인한다(2026-07-11).
    if (looksLikeUsTicker(q)) {
      const dynCrypto = await resolveCryptoDynamic(q);
      if (dynCrypto) return dynCrypto;
      return { code: q.toUpperCase(), name: q.toUpperCase(), market: "US" };
    }
    return null;
  }

  function fmtPrice(n, market) {
    const v = toNum(n);
    if (v == null || v === 0) return "—";
    if (market === "US" || market === "CRYPTO") {
      const abs = Math.abs(v);
      const decimals = abs < 1 ? 6 : abs < 10 ? 4 : abs < 1000 ? 2 : 0;
      return `$${v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
    }
    return `${Math.round(v).toLocaleString("ko-KR")}원`;
  }

  function resolveOpinionPrices(op, currentPrice) {
    const o = op && typeof op === "object" ? op : {};
    const cp = toNum(currentPrice) || 0;
    let entry = toNum(o.entry);
    let stop = toNum(o.stop);
    let target = toNum(o.target);

    if (!entry || entry <= 0) {
      entry = cp > 0 ? cp : null;
    }
    if (entry && (!stop || stop <= 0)) {
      stop = Math.round(entry * 0.95);
    }
    if (entry && (!target || target <= 0)) {
      target = Math.round(entry * 1.15);
    }

    return {
      entry: entry ?? (cp > 0 ? cp : 0),
      stop: stop ?? 0,
      target: target ?? 0,
    };
  }

  function formatEventDate(raw) {
    const s = String(raw || "").trim();
    if (!s) return "일정 미정";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{4}년\s*(상반기|하반기)\s*예정/.test(s)) return s;
    if (/^\d{4}년\s*\d{1,2}월\s*예정/.test(s)) return s;
    const iso = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (iso) {
      const mm = String(iso[2]).padStart(2, "0");
      const dd = String(iso[3]).padStart(2, "0");
      return `${iso[1]}-${mm}-${dd}`;
    }
    const monthOnly = s.match(/(\d{4})\s*년?\s*(\d{1,2})\s*월/);
    if (monthOnly && !/\d{1,2}\s*일/.test(s)) {
      return `${monthOnly[1]}년 ${Number(monthOnly[2])}월 예정`;
    }
    const half = s.match(/(\d{4})\s*년?\s*(상반기|하반기)/);
    if (half) return `${half[1]}년 ${half[2]} 예정`;
    return s;
  }

  function lwChartPriceFormatter(price) {
    if (price >= 10000) return `${(price / 10000).toFixed(0)}만`;
    return Math.round(price).toLocaleString("ko-KR");
  }

  function fmtPct(n) {
    const v = toNum(n);
    if (v == null) return "—";
    const sign = v > 0 ? "+" : "";
    return `${sign}${v.toFixed(2)}%`;
  }

  function chgClass(n) {
    const v = toNum(n);
    if (v == null || v === 0) return "";
    return v > 0 ? "is-up" : "is-down";
  }

  function emphasizeMetrics(text) {
    return String(text || "").replace(
      /(\d[\d,]*(?:\.\d+)?)\s*(%|원|주|억|조|배)/g,
      '<span class="ai-em">$1$2</span>'
    );
  }

  function formatProseText(text, emptyMsg) {
    const raw = String(text || "").trim();
    if (!raw) return `<p class="ai-prose-empty">${escapeHtml(emptyMsg || "내용이 없습니다.")}</p>`;
    const paras = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    return paras
      .map((p) => `<p class="ai-prose-p">${emphasizeMetrics(escapeHtml(p))}</p>`)
      .join("");
  }

  function normalizeStrength(strength) {
    const s = String(strength || "").trim();
    if (s === "상" || s === "강") return "상";
    if (s === "하") return "하";
    return "중";
  }

  function strengthLabel(strength) {
    const n = normalizeStrength(strength);
    if (n === "상") return "강";
    if (n === "하") return "하";
    return "중";
  }
  function signalBadgeClass(signal) {
    if (signal === "매수") return "ai-summary-badge--buy";
    if (signal === "회피") return "ai-summary-badge--avoid";
    return "ai-summary-badge--hold";
  }

  function setButtonLoading(on) {
    if (!btn) return;
    if (on) {
      btn.classList.add("is-loading");
      btn.disabled = true;
      btn.innerHTML = '<span class="ai-btn-spinner" aria-hidden="true"></span>분석 중…';
    } else {
      btn.classList.remove("is-loading");
      btn.disabled = false;
      btn.textContent = "AI 분석";
    }
  }

  function skeletonCardsHtml() {
    const skelBody =
      '<div class="ai-skel-line ai-skel-line--mid"></div><div class="ai-skel-line"></div><div class="ai-skel-line ai-skel-line--short"></div>';
    const titles = [
      "한눈에 요약",
      "왜 지금 이 가격인가",
      "수급 분석",
      "다가오는 이벤트",
      "재료 분석",
      "차트 흐름 분석",
      "AI 주관적 판단",
    ];
    return titles
      .map((title, i) => {
        const extra = i === 0 ? " ai-card--summary" : "";
        const chart = i === 5 ? " ai-card--chart" : "";
        const opinion = i === 6 ? " ai-card--opinion" : "";
        const materials = i === 4 ? " ai-card--materials" : "";
        const half = i === 1 || i === 2 ? " ai-card--half" : "";
        return `<article class="ai-card is-skeleton${extra}${half}${chart}${opinion}${materials}"><h3 class="ai-card__title"><span class="ai-card__num">${i + 1}</span>${escapeHtml(title)}</h3><div class="ai-card__body">${skelBody}</div></article>`;
      })
      .join("");
  }

  function clearLoadingTimer() {
    if (loadingTimer) {
      clearInterval(loadingTimer);
      loadingTimer = null;
    }
  }

  function updateLoadingMessage(msg) {
    const el = document.getElementById("ai-loading-msg");
    if (el) el.textContent = msg;
  }

  function formatMarketCapPretty(raw) {
    const n = toNum(raw);
    if (n == null) return "—";
    if (n >= 10000) return `${(n / 10000).toFixed(1)}조`;
    if (n >= 1) return `${Math.round(n).toLocaleString("ko-KR")}억`;
    return `${Math.round(n).toLocaleString("ko-KR")}`;
  }

  function clearProgressTimer() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  function setProgressPct(pct) {
    const bar = document.getElementById("ai-loading-progress-bar");
    const label = document.getElementById("ai-loading-progress-pct");
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    if (bar) bar.style.width = `${v}%`;
    if (label) label.textContent = `${v}%`;
  }

  function startProgressAnimation() {
    clearProgressTimer();
    setProgressPct(0);
    let pct = 0;
    progressTimer = setInterval(() => {
      if (pct >= 95) return;
      pct += pct < 60 ? 2 : pct < 85 ? 1 : 0.5;
      setProgressPct(Math.min(95, pct));
    }, 400);
  }

  async function fetchQuickQuote(code) {
    try {
      const res = await fetch(`/api/kis-stock-quote?code=${encodeURIComponent(code)}`, { cache: "no-store" });
      const data = safeParseJson(await res.text()) || {};
      if (!res.ok) return null;
      const raw1 = data.raw1 || {};
      return {
        stockName: data.stockName || "",
        stockCode: data.stockCode || code,
        market: data.market || "",
        currentPrice: data.currentPrice,
        changeRate: data.changeRate,
        high52w: toNum(raw1.w52_hgpr),
        low52w: toNum(raw1.w52_lwpr),
        marketCapRaw: data.marketCapRaw || raw1.hts_avls || raw1.stck_avls || "",
        pbr: toNum(raw1.pbr ?? data.financials?.pbr),
      };
    } catch (err) {
      console.warn("[AI분석] quick quote 실패", err);
      return null;
    }
  }

  function fmtPbr(n) {
    const v = toNum(n);
    if (v == null) return "—";
    return v.toFixed(1);
  }

  function renderMetaGrid(opts) {
    const o = opts || {};
    const assetType = o.assetType || "KR";
    const cells = [
      ["52주 고점", fmtPrice(o.high52w, assetType)],
      ["52주 저점", fmtPrice(o.low52w, assetType)],
      ["시가총액", formatMarketCapPretty(o.marketCapRaw)],
      ["PBR", fmtPbr(o.pbr)],
    ];
    return (
      `<div class="ai-stock-meta">` +
      cells
        .map(
          ([label, val]) =>
            `<div class="ai-stock-meta__cell"><span class="ai-stock-meta__label">${escapeHtml(label)}</span><span class="ai-stock-meta__value">${escapeHtml(val)}</span></div>`
        )
        .join("") +
      `</div>`
    );
  }

  function renderStockHeader(data) {
    const priceCls = chgClass(data.changeRate);
    const market = String(data.market || "").trim();
    return (
      `<header class="ai-stock-header">` +
      `<div class="ai-stock-header__top">` +
      `<div class="ai-stock-header__identity">` +
      `<h2 class="ai-stock-header__name">${escapeHtml(data.stockName || "")}</h2>` +
      `<div class="ai-stock-header__sub">` +
      `<span class="ai-stock-header__code">${escapeHtml(data.stockCode || "")}</span>` +
      (market ? `<span class="ai-stock-header__market">${escapeHtml(market)}</span>` : "") +
      `</div></div>` +
      `<div class="ai-stock-header__quote ${priceCls}">` +
      `<div class="ai-stock-header__price">${escapeHtml(fmtPrice(data.currentPrice, data.assetType))}</div>` +
      `<div class="ai-stock-header__chg">${escapeHtml(fmtPct(data.changeRate))}</div>` +
      `</div></div>` +
      renderMetaGrid(data) +
      `</header>`
    );
  }

  function renderLoadingQuoteHeader(quote, fallbackName, fallbackCode) {
    const payload = {
      stockName: (quote && quote.stockName) || fallbackName || "",
      stockCode: (quote && quote.stockCode) || fallbackCode || "",
      market: quote && quote.market,
      currentPrice: quote && quote.currentPrice,
      changeRate: quote && quote.changeRate,
      high52w: quote && quote.high52w,
      low52w: quote && quote.low52w,
      marketCapRaw: quote && quote.marketCapRaw,
      pbr: quote && quote.pbr,
    };
    return renderStockHeader(payload);
  }

  function chartDotClass(line) {
    const t = String(line || "");
    if (/엘리어트|파동/i.test(t)) return "ai-chart-dot--green";
    if (/전고|전저|52주/i.test(t)) return "ai-chart-dot--gray";
    if (/지지|저항/i.test(t)) return "ai-chart-dot--yellow";
    if (/일목|구름/i.test(t)) return "ai-chart-dot--purple";
    if (/RSI/i.test(t)) return "ai-chart-dot--blue";
    if (/이동평균|MA|20일|60일|120일|200일/i.test(t)) return "ai-chart-dot--red";
    return "ai-chart-dot--gray";
  }

  function parseChartLine(line) {
    const raw = String(line || "").trim();
    const m = raw.match(/^[①②③④⑤⑥⑦⑧⑨]?\s*([^:：—\-]+?)[:：—\-]\s*(.+)$/);
    if (m) return { title: m[1].trim(), body: m[2].trim() };
    return { title: "", body: raw };
  }

  function renderChartText(text) {
    const raw = String(text || "").trim();
    if (!raw) return `<p class="ai-chart-text-empty">차트 분석이 없습니다.</p>`;
    const lines = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (lines.length <= 1 && !/①|②|③/.test(raw)) {
      return (
        `<div class="ai-chart-text">` +
        `<div class="ai-chart-item"><span class="ai-chart-dot ai-chart-dot--gray"></span><div class="ai-chart-item__content"><span>${escapeHtml(raw)}</span></div></div>` +
        `</div>`
      );
    }
    return (
      `<div class="ai-chart-text">` +
      lines
        .map((line) => {
          const parsed = parseChartLine(line);
          const dotCls = chartDotClass(parsed.title || line);
          const titleHtml = parsed.title
            ? `<span class="ai-chart-item__title">${escapeHtml(parsed.title)}</span>`
            : "";
          const bodyHtml = emphasizeMetrics(escapeHtml(parsed.body));
          return `<div class="ai-chart-item"><span class="ai-chart-dot ${dotCls}"></span><div class="ai-chart-item__content">${titleHtml}<span>${bodyHtml}</span></div></div>`;
        })
        .join("") +
      `</div>`
    );
  }

  function materialBorderClass(strength) {
    const n = normalizeStrength(strength);
    if (n === "상") return "ai-mat-card--high";
    if (n === "하") return "ai-mat-card--low";
    return "ai-mat-card--mid";
  }

  function reflectBarClass(pct) {
    if (pct <= 30) return "ai-mat-reflect__bar--low";
    if (pct <= 60) return "ai-mat-reflect__bar--mid";
    return "ai-mat-reflect__bar--high";
  }

  function isDomesticCode(code) {
    const digits = String(code || "").replace(/\D/g, "");
    return /^\d{6}$/.test(digits.length <= 6 ? digits.padStart(6, "0") : digits.slice(-6));
  }

  function getAiChartHeight() {
    return window.matchMedia("(max-width: 768px)").matches ? 260 : 400;
  }

  function extractChartIndicators(chartData) {
    if (!chartData) return {};
    const pickLast = (arr) => {
      if (!Array.isArray(arr)) return null;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] != null) return arr[i];
      }
      return null;
    };
    return {
      ma20: pickLast(chartData.ma20),
      ma60: pickLast(chartData.ma60),
      ma120: pickLast(chartData.ma120),
      ma200: pickLast(chartData.ma200),
      rsi14: chartData.rsi14 == null ? null : chartData.rsi14,
    };
  }

  async function fetchKisChart(code, period) {
    const res = await fetch(
      `/api/kis-stock-quote?code=${encodeURIComponent(code)}&chart=1&period=${encodeURIComponent(period || "D")}`,
      { cache: "no-store" }
    );
    const data = safeParseJson(await res.text()) || {};
    if (!res.ok) throw new Error(data.error || `차트 HTTP ${res.status}`);
    if (!Array.isArray(data.candles) || !data.candles.length) throw new Error("차트 데이터가 없습니다");
    return data;
  }

  /** 2026-07-10: 미국주식·암호화폐도 국내주식과 동일한 자체 캔들+이동평균선 차트를 쓴다.
   * 백엔드(api/kis-stock-quote.js)가 market=US면 KIS 해외 기간별시세를, market=CRYPTO면
   * Binance 공개 klines를 조회해서 국내주식과 같은 {candles, ma20, ma60, ma120, ma200, rsi14}
   * 형태로 돌려준다. 실패하면(드문 티커·스테이블코인 등) 호출부에서 TradingView로 대체한다. */
  async function fetchNonKrChart(code, market, period) {
    const params = new URLSearchParams({ market, code, chart: "1", period: period || "D" });
    const res = await fetch(`/api/kis-stock-quote?${params.toString()}`, { cache: "no-store" });
    const data = safeParseJson(await res.text()) || {};
    if (!res.ok) throw new Error(data.error || `차트 HTTP ${res.status}`);
    if (!Array.isArray(data.candles) || !data.candles.length) throw new Error("차트 데이터가 없습니다");
    return data;
  }

  function ensureLightweightCharts() {
    if (window.LightweightCharts && typeof window.LightweightCharts.createChart === "function") {
      return Promise.resolve(window.LightweightCharts);
    }
    if (!lwChartsPromise) {
      lwChartsPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.async = true;
        s.src = "https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js";
        s.crossOrigin = "anonymous";
        s.onload = () => {
          if (window.LightweightCharts && typeof window.LightweightCharts.createChart === "function") {
            resolve(window.LightweightCharts);
          } else {
            lwChartsPromise = null;
            reject(new Error("차트 라이브러리를 불러오지 못했습니다."));
          }
        };
        s.onerror = () => {
          lwChartsPromise = null;
          reject(new Error("차트 라이브러리를 불러오지 못했습니다."));
        };
        document.head.appendChild(s);
      });
    }
    return lwChartsPromise;
  }

  function disposeAiChart() {
    if (aiChartBundle) {
      try {
        if (aiChartBundle.ro) aiChartBundle.ro.disconnect();
        if (aiChartBundle.chart) aiChartBundle.chart.remove();
      } catch (_) {}
      aiChartBundle = null;
    }
  }

  function getLwTheme() {
    const dark = isDarkTheme();
    return {
      bg: dark ? "#131722" : "#ffffff",
      text: dark ? "#aaaaaa" : "#555555",
      grid: dark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.06)",
    };
  }

  function buildMaLineData(candles, maArr) {
    const out = [];
    for (let i = 0; i < candles.length; i++) {
      const v = maArr && maArr[i];
      if (v != null) out.push({ time: candles[i].time, value: v });
    }
    return out;
  }

  function lwChartPriceFormatterFor(market) {
    if (market !== "US" && market !== "CRYPTO") return lwChartPriceFormatter;
    return (price) => {
      const abs = Math.abs(price);
      const decimals = abs < 1 ? 6 : abs < 10 ? 4 : abs < 1000 ? 2 : 0;
      return `$${price.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
    };
  }

  async function mountAiLwChart(hostEl, chartData, market) {
    if (!hostEl || !chartData || !Array.isArray(chartData.candles) || !chartData.candles.length) return;
    disposeAiChart();
    const LC = await ensureLightweightCharts();
    hostEl.innerHTML = "";
    const h = getAiChartHeight();
    const w = Math.max(hostEl.clientWidth, 280);
    const t = getLwTheme();
    const chart = LC.createChart(hostEl, {
      width: w,
      height: h,
      layout: { background: { type: "solid", color: t.bg }, textColor: t.text },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      localization: {
        priceFormatter: lwChartPriceFormatterFor(market),
      },
    });
    const UP_COLOR = "#e24b4a";
    const DOWN_COLOR = "#3b82f6";
    const candleOpts = {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      borderDownColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
    };
    let candleSeries;
    if (LC.CandlestickSeries && typeof chart.addSeries === "function") {
      candleSeries = chart.addSeries(LC.CandlestickSeries, candleOpts);
    } else if (typeof chart.addCandlestickSeries === "function") {
      candleSeries = chart.addCandlestickSeries(candleOpts);
    } else {
      throw new Error("캔들 시리즈를 초기화하지 못했습니다.");
    }
    candleSeries.setData(chartData.candles);

    // 2026-07-11: 캔들 밑에 거래량 바 추가. 색상은 일봉 캔들과 동일하게 상승/하락 색을 맞춘다.
    // priceScaleId를 별도(overlay)로 두고 scaleMargins로 하단 20%만 차지하게 해서 가격 차트와
    // 같은 패널 안에서 아래쪽에 거래량이 표시되도록 한다(국내/미국/암호화폐 공통).
    const volumeData = chartData.candles
      .filter((cd) => cd && cd.volume != null)
      .map((cd) => ({
        time: cd.time,
        value: Math.max(0, Number(cd.volume) || 0),
        color: cd.close >= cd.open ? UP_COLOR : DOWN_COLOR,
      }));
    if (volumeData.length) {
      const volumeOpts = { priceFormat: { type: "volume" }, priceScaleId: "ai-volume", lastValueVisible: false, priceLineVisible: false };
      let volumeSeries;
      if (LC.HistogramSeries && typeof chart.addSeries === "function") {
        volumeSeries = chart.addSeries(LC.HistogramSeries, volumeOpts);
      } else if (typeof chart.addHistogramSeries === "function") {
        volumeSeries = chart.addHistogramSeries(volumeOpts);
      }
      if (volumeSeries) {
        volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        volumeSeries.setData(volumeData);
      }
    }

    // 2026-07-11: 이평선 색상/두께 변경 — 20일 빨강, 60일 파랑(도저블루), 120일 초록, 200일 검정.
    // 두께는 200일선만 2, 나머지는 1. 다크 테마에서는 200일선(검정)이 배경색과 거의 같아
    // 안 보이므로 다크 테마일 때만 흰색으로 바꿔서 가독성을 유지한다.
    const isDark = isDarkTheme();
    const specs = [
      [chartData.ma20, "#FF0000", 1],
      [chartData.ma60, "#1E90FF", 1],
      [chartData.ma120, "#008000", 1],
      [chartData.ma200, isDark ? "#f5f5f5" : "#000000", 2],
    ];
    for (const [arr, color, lineWidth] of specs) {
      const lineData = buildMaLineData(chartData.candles, arr);
      if (!lineData.length) continue;
      const lineOpts = { color, lineWidth, priceLineVisible: false, lastValueVisible: false };
      let line;
      if (LC.LineSeries && typeof chart.addSeries === "function") {
        line = chart.addSeries(LC.LineSeries, lineOpts);
      } else {
        line = chart.addLineSeries(lineOpts);
      }
      line.setData(lineData);
    }
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      const nw = hostEl.clientWidth;
      if (nw > 0) {
        chart.applyOptions({ width: nw, height: getAiChartHeight() });
        chart.timeScale().fitContent();
      }
    });
    ro.observe(hostEl);
    aiChartBundle = { chart, ro };
  }

  function applyAiChartTheme() {
    if (!aiChartBundle || !aiChartBundle.chart) return;
    const t = getLwTheme();
    aiChartBundle.chart.applyOptions({
      layout: { background: { type: "solid", color: t.bg }, textColor: t.text },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    });
  }

  function renderChartShell(stockCode, stockName, chartText, useTradingView, market) {
    if (useTradingView) {
      const sym = tradingViewSymbol(stockCode, stockName, market);
      return (
        `<div class="ai-chart-block">` +
        `<div class="ai-chart-tv"><iframe class="ai-tv-widget" data-symbol="${escapeHtml(sym)}" title="${escapeHtml(stockName || stockCode)} TradingView chart" src="${escapeHtml(tradingViewUrl(sym))}" loading="lazy" allowtransparency="true" scrolling="no"></iframe></div>` +
        renderChartText(chartText) +
        `</div>`
      );
    }
    return (
      `<div class="ai-chart-block">` +
      `<div class="ai-lw-chart-wrap" data-ai-chart-code="${escapeHtml(stockCode)}">` +
      `<div class="ai-chart-toolbar" role="toolbar" aria-label="캔들 주기">` +
      `<button type="button" class="rt-chart-interval-btn ai-chart-period-btn" data-ai-period="D" aria-pressed="true">일봉</button>` +
      `<button type="button" class="rt-chart-interval-btn ai-chart-period-btn" data-ai-period="W" aria-pressed="false">주봉</button>` +
      `<button type="button" class="rt-chart-interval-btn ai-chart-period-btn" data-ai-period="M" aria-pressed="false">월봉</button>` +
      `</div>` +
      `<div class="ai-chart-legend">` +
      `<span class="ai-chart-legend__item"><i class="ai-chart-legend__dot" style="background:#FF0000"></i>20일</span>` +
      `<span class="ai-chart-legend__item"><i class="ai-chart-legend__dot" style="background:#1E90FF"></i>60일</span>` +
      `<span class="ai-chart-legend__item"><i class="ai-chart-legend__dot" style="background:#008000"></i>120일</span>` +
      `<span class="ai-chart-legend__item"><i class="ai-chart-legend__dot ai-chart-legend__dot--ma200" style="background:#000000"></i>200일</span>` +
      `</div>` +
      `<div class="ai-lw-chart-host" role="region" aria-label="캔들 차트"></div>` +
      `</div>` +
      renderChartText(chartText) +
      `</div>`
    );
  }

  function wireAiChart(stockCode, chartData, activePeriod, market) {
    const wrap = panel && panel.querySelector(".ai-lw-chart-wrap");
    if (!wrap) return;
    const host = wrap.querySelector(".ai-lw-chart-host");
    const period = activePeriod || "D";
    if (host && chartData) void mountAiLwChart(host, chartData, market);

    wrap.querySelectorAll(".ai-chart-period-btn").forEach((btn) => {
      const p = btn.getAttribute("data-ai-period") || "D";
      btn.setAttribute("aria-pressed", p === period ? "true" : "false");
      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", async () => {
        const next = btn.getAttribute("data-ai-period") || "D";
        wrap.querySelectorAll(".ai-chart-period-btn").forEach((b) =>
          b.setAttribute("aria-pressed", b === btn ? "true" : "false")
        );
        try {
          const data =
            market === "US" || market === "CRYPTO"
              ? await fetchNonKrChart(stockCode, market, next)
              : await fetchKisChart(stockCode, next);
          await mountAiLwChart(host, data, market);
        } catch (err) {
          console.error("[AI분석] 차트 주기 변경 실패", err);
        }
      });
    });
  }

  function showLoading(resolved) {
    if (!panel) return;
    clearLoadingTimer();
    clearProgressTimer();
    panel.hidden = false;
    let step = 0;
    const header =
      `<div id="ai-loading-quote-host" class="ai-loading-quote-host">` +
      `<div class="ai-loading-quote ai-loading-quote--pending"><p class="ai-loading-quote__pending">${escapeHtml(resolved.name || "")} · ${escapeHtml(resolved.code || "")} — 시세 불러오는 중…</p></div></div>`;
    panel.innerHTML =
      header +
      `<div class="ai-loading-panel" role="status" aria-live="polite">` +
      `<div class="ai-loading-progress"><div class="ai-loading-progress__track"><div id="ai-loading-progress-bar" class="ai-loading-progress__bar"></div></div><span id="ai-loading-progress-pct" class="ai-loading-progress__pct">0%</span></div>` +
      `<p id="ai-loading-msg" class="ai-loading-panel__msg">${escapeHtml(LOADING_STEPS[0])}</p>` +
      `<p class="ai-loading-panel__hint">보통 15~25초 소요됩니다</p>` +
      `</div>`;
    startProgressAnimation();
    loadingTimer = setInterval(() => {
      step = (step + 1) % LOADING_STEPS.length;
      updateLoadingMessage(LOADING_STEPS[step]);
    }, 3000);
  }

  function finishLoadingProgress() {
    clearProgressTimer();
    setProgressPct(100);
  }

  function showError(msg) {
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = `<div class="ai-analysis-error" role="alert">${escapeHtml(msg || "분석을 불러오지 못했습니다")}</div>`;
  }

  function renderEvents(events) {
    if (!Array.isArray(events) || !events.length) {
      return '<p class="ai-card__body ai-event-empty">현재 확인된 예정 이벤트 없음</p>';
    }
    return (
      "<ul class=\"ai-event-list\">" +
      events
          .map((e) => {
          const type = String(e.type || "");
          const badgeCls =
            type === "악재"
              ? "ai-event__badge--bad"
              : type === "neutral"
                ? "ai-event__badge--neutral"
                : "ai-event__badge--good";
          const badgeLabel = type === "neutral" ? "정보" : escapeHtml(type || "호재");
          const dateLabel = formatEventDate(e.date);
          return `<li class="ai-event"><span class="ai-event__badge ${badgeCls}">${badgeLabel}</span><span class="ai-event__content">${escapeHtml(e.content)}</span><span class="ai-event__date">${escapeHtml(dateLabel)}</span></li>`;
        })
        .join("") +
      "</ul>"
    );
  }

  function isDarkTheme() {
    return (
      document.documentElement.getAttribute("data-theme") === "dark" ||
      document.body.classList.contains("dark-mode") ||
      document.body.classList.contains("dark")
    );
  }

  function tradingViewSymbol(stockCode, stockName, market) {
    const code = String(stockCode || "").replace(/\D/g, "");
    if (/^\d{6}$/.test(code) && market !== "US" && market !== "CRYPTO") return `KRX:${code}`;
    const ticker = String(stockCode || stockName || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9.]/g, "");
    if (!ticker) return "KRX:005930";
    if (market === "CRYPTO") return `BINANCE:${ticker}USDT`;
    const nyseTickers = new Set(["BRK.B", "BRK.A", "JPM", "V", "WMT", "XOM", "BAC", "DIS", "T", "KO", "PFE"]);
    const prefix = nyseTickers.has(ticker) ? "NYSE" : "NASDAQ";
    return `${prefix}:${ticker}`;
  }

  function tradingViewMaStudies() {
    return [20, 60, 120, 200].map((length) => ({
      id: "MASimple@tv-basicstudies",
      inputs: { length, source: "close" },
    }));
  }

  function tradingViewUrl(symbol) {
    // 2026-07-11: theme.js의 공용 헬퍼(tmTradingViewWidgetEmbedUrl)로 위임한다 — 이 헬퍼는
    // 거래량 스터디를 항상 명시적으로 추가하고 studies_overrides로 캔들과 같은 색을 입혀서,
    // 이 페이지에서만 따로 만들었던(거래량 색 오버라이드가 빠진) 구현보다 정확하다.
    if (typeof window.tmTradingViewWidgetEmbedUrl === "function") {
      return window.tmTradingViewWidgetEmbedUrl(symbol, { interval: "D", studies: tradingViewMaStudies() });
    }
    const isDark = isDarkTheme();
    const theme = isDark ? "dark" : "light";
    const chartBg = isDark ? "#131722" : "#ffffff";
    const params = new URLSearchParams({
      symbol,
      interval: "D",
      timezone: "Asia/Seoul",
      theme,
      style: "1",
      locale: "kr",
      toolbar_bg: chartBg,
      bgcolor: chartBg,
      gridcolor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
      hide_side_toolbar: "0",
      allow_symbol_change: "1",
      save_image: "0",
      calendar: "0",
      withdateranges: "1",
      hideideas: "1",
      studies: JSON.stringify(tradingViewMaStudies()),
      up_color: "#e24b4a",
      down_color: "#3b82f6",
      border_up_color: "#e24b4a",
      border_down_color: "#3b82f6",
      wick_up_color: "#e24b4a",
      wick_down_color: "#3b82f6",
    });
    if (typeof window.tmTradingViewCandleOverrides === "function") {
      params.set("overrides", JSON.stringify(window.tmTradingViewCandleOverrides(isDark)));
    }
    return `https://www.tradingview.com/widgetembed/?${params.toString()}`;
  }

  function refreshTradingViewCharts() {
    document.querySelectorAll(".ai-tv-widget").forEach((iframe) => {
      const sym = iframe.getAttribute("data-symbol");
      if (sym) iframe.src = tradingViewUrl(sym);
    });
  }

  function renderChartSection(stockCode, stockName, chartText, market, hasChartData) {
    // 2026-07-10: 예전엔 국내주식이 아니면 무조건 TradingView(단일 색 이평선만 지원)를 썼다.
    // 이제는 미국주식·암호화폐도 자체 캔들+4색 이평선 차트 데이터를 받아올 수 있으므로,
    // 실제로 그 데이터 확보에 성공했는지(hasChartData)를 기준으로 삼는다. 실패했을 때만
    // (드문 티커, 스테이블코인처럼 Binance 페어가 없는 경우 등) TradingView로 대체한다.
    const useTv = !hasChartData;
    return renderChartShell(stockCode, stockName, chartText, useTv, market);
  }

  function scenarioCardClass(label, type) {
    const t = String(type || label || "").toUpperCase();
    if (label === "A" || t.includes("강")) return "ai-scenario--bull";
    if (label === "C" || t.includes("약")) return "ai-scenario--bear";
    return "ai-scenario--neutral";
  }

  function renderMaterials(materials) {
    const m = materials && typeof materials === "object" ? materials : {};
    const items = Array.isArray(m.items) ? m.items.slice(0, 4) : [];
    const cards = items.length
      ? items
          .map((it) => {
            const strength = normalizeStrength(it.strength || "중");
            const strengthCls =
              strength === "상"
                ? "ai-mat-strength--high"
                : strength === "하"
                  ? "ai-mat-strength--low"
                  : "ai-mat-strength--mid";
            const pct = Math.max(0, Math.min(100, toNum(it.reflectionPct) || 0));
            const note = it.reflectionNote || (pct ? `${pct}% 반영` : "");
            const borderCls = materialBorderClass(strength);
            const barCls = reflectBarClass(pct);
            return (
              `<article class="ai-mat-card ${borderCls}">` +
              `<div class="ai-mat-card__head"><strong class="ai-mat-card__name">${escapeHtml(it.name)}</strong><span class="ai-mat-strength ${strengthCls}">${escapeHtml(strengthLabel(it.strength))}</span></div>` +
              `<div class="ai-mat-reflect"><div class="ai-mat-reflect__track"><div class="ai-mat-reflect__bar ${barCls}" style="width:${pct}%"></div></div><span class="ai-mat-reflect__label">${escapeHtml(note)}</span></div>` +
              `<p class="ai-mat-card__judgment">${escapeHtml(it.judgment || "")}</p>` +
              `</article>`
            );
          })
          .join("")
      : '<p class="ai-mat-empty">확인된 핵심 재료가 없습니다.</p>';
    const unreflected = m.unreflected
      ? `<div class="ai-mat-unreflected"><span class="ai-mat-unreflected__label">미반영 핵심 재료</span>${formatProseText(m.unreflected)}</div>`
      : "";
    const summary = m.summary
      ? `<div class="ai-mat-summary"><span class="ai-mat-summary__label">AI 재료 종합 판단</span>${formatProseText(m.summary)}</div>`
      : "";
    return `<div class="ai-mat-grid">${cards}</div>${unreflected}${summary}`;
  }

  function renderScenarioCard(s, assetType) {
    const label = escapeHtml(s.label || "?");
    const type = escapeHtml(s.type || "");
    const cls = scenarioCardClass(s.label, s.type);
    const prob = toNum(s.probability);
    const probText = prob == null ? "—" : `${Math.round(prob)}%`;
    const isBear = String(s.label) === "C" || String(s.type).includes("약");
    // 2026-07-07: 약세(C) 시나리오도 A/B와 동일하게 진입가/목표가/손절가를 보여주고,
    // 대응전략은 참고용 코멘트로 추가 표시한다 (전에는 C만 가격이 아예 안 보였음).
    // 2026-07-10: 약세(C) 시나리오의 "목표가"는 지지선 붕괴 후 재진입을 노리는 반등 목표가이고
    // "목표 하단"은 지지선이 추가로 무너졌을 때의 하방 목표라 성격이 다르다. 둘 다 "목표가"로만
    // 표기하면 약세 시나리오인데 상방 숫자만 보이는 것처럼 오해할 수 있어 라벨을 구분한다.
    const lines = [
      ["조건", s.condition],
      ["진입가", s.entry != null ? fmtPrice(s.entry, assetType) : null],
      [isBear ? "반등 목표가" : "목표가", s.target != null ? fmtPrice(s.target, assetType) : null],
      ["손절가", s.stop != null ? fmtPrice(s.stop, assetType) : null],
      isBear && s.targetLow != null ? ["추가 하락 시 목표 하단", fmtPrice(s.targetLow, assetType)] : null,
      isBear ? ["대응전략", s.strategy] : null,
    ]
      .filter(Boolean)
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<div class="ai-scenario-row"><span class="ai-scenario-row__k">${escapeHtml(k)}</span><span class="ai-scenario-row__v">${escapeHtml(String(v))}</span></div>`
      )
      .join("");
    return `<article class="ai-scenario ${cls}"><header class="ai-scenario__head"><span class="ai-scenario__label">${label}안 (${type})</span><span class="ai-scenario__prob">${probText}</span></header><div class="ai-scenario__body">${lines || "<p>—</p>"}</div></article>`;
  }

  function renderOpinion(op, currentPrice, assetType) {
    const o = op && typeof op === "object" ? op : {};
    const prices = resolveOpinionPrices(o, currentPrice);
    const outlooks = [
      ["단기 (1-2주)", o.short],
      ["중기 (1-3개월)", o.mid],
      ["장기 (6개월-1년)", o.long],
    ]
      .filter(([, t]) => t)
      .map(
        ([label, text]) =>
          `<div class="ai-outlook-card"><span class="ai-outlook-card__label">${escapeHtml(label)}</span>${formatProseText(text)}</div>`
      )
      .join("");
    const priceRows = [
      ["진입가", prices.entry],
      ["손절가", prices.stop],
      ["목표가", prices.target],
    ]
      .map(
        ([label, val]) =>
          `<div class="ai-opinion-price"><span class="ai-opinion-price__label">${escapeHtml(label)}</span><span class="ai-opinion-price__value">${escapeHtml(fmtPrice(val, assetType))}</span></div>`
      )
      .join("");
    const scenarios = Array.isArray(o.scenarios) && o.scenarios.length ? o.scenarios : [];
    const scenarioHtml = scenarios.length
      ? scenarios.map((s) => renderScenarioCard(s, assetType)).join("")
      : '<p class="ai-scenario-empty">시나리오 정보가 없습니다.</p>';
    const comment = o.comment
      ? `<div class="ai-opinion-comment"><span class="ai-opinion-comment__label">종합 의견</span>${formatProseText(o.comment)}</div>`
      : "";
    return (
      `<div class="ai-opinion-layout">` +
      `<div class="ai-opinion-col ai-opinion-col--left">` +
      `<div class="ai-outlook-stack">${outlooks || "<p class=\"ai-outlook-empty\">전망 정보가 없습니다.</p>"}</div>` +
      `<div class="ai-opinion-prices">${priceRows}</div>` +
      `${comment}` +
      `</div>` +
      `<div class="ai-opinion-col ai-opinion-col--right">${scenarioHtml}</div>` +
      `</div>`
    );
  }

  function renderAnalysis(data, chartData, chartPeriod) {
    if (!panel) return;
    disposeAiChart();
    let analysis = data && data.analysis;
    if (typeof analysis === "string") analysis = safeParseJson(analysis);
    if (!analysis || typeof analysis !== "object") {
      showError("분석을 불러오지 못했습니다");
      return;
    }

    const summary = analysis.summary && typeof analysis.summary === "object" ? analysis.summary : {};
    const signal = summary.signal || "관망";
    const prob = toNum(summary.probability);
    const probText = prob == null ? "—" : `${prob}%`;
    const errBanner =
      analysis._error && data.analysisError
        ? `<div class="ai-analysis-error" style="margin-bottom:12px">${escapeHtml(data.analysisError)}</div>`
        : "";

    panel.hidden = false;
    panel.innerHTML =
      errBanner +
      renderStockHeader(data) +
      `<div class="ai-analysis-cards">
        <article class="ai-card ai-card--summary"><h3 class="ai-card__title"><span class="ai-card__num">1</span>한눈에 요약</h3><div class="ai-card__body"><div class="ai-summary-left"><span class="ai-summary-badge ${signalBadgeClass(signal)}">${escapeHtml(signal)}</span><div class="ai-summary-prob"><span class="ai-summary-prob__label">상승 확률</span><span class="ai-summary-prob__value">${escapeHtml(probText)}</span><span class="ai-summary-prob__note">강세(A) 시나리오 실현 확률 기준</span></div></div><p class="ai-summary-desc">${escapeHtml(summary.description || "")}</p></div></article>
        <article class="ai-card ai-card--half"><h3 class="ai-card__title"><span class="ai-card__num">2</span>왜 지금 이 가격인가</h3><div class="ai-card__body">${formatProseText(analysis.story, "분석 내용이 없습니다.")}</div></article>
        <article class="ai-card ai-card--half"><h3 class="ai-card__title"><span class="ai-card__num">3</span>수급 분석</h3><div class="ai-card__body">${formatProseText(analysis.supply, "수급 정보가 없습니다.")}</div></article>
        <article class="ai-card"><h3 class="ai-card__title"><span class="ai-card__num">4</span>다가오는 이벤트</h3>${renderEvents(analysis.events)}</article>
        <article class="ai-card ai-card--materials"><h3 class="ai-card__title"><span class="ai-card__num">5</span>재료 분석</h3><div class="ai-card__body">${renderMaterials(analysis.materials)}</div></article>
        <article class="ai-card ai-card--chart"><h3 class="ai-card__title"><span class="ai-card__num">6</span>차트 흐름 분석</h3><div class="ai-card__body">${renderChartSection(data.stockCode, data.stockName, analysis.chart, data.assetType, !!chartData)}</div></article>
        <article class="ai-card ai-card--opinion"><h3 class="ai-card__title"><span class="ai-card__num">7</span>AI 주관적 판단</h3><div class="ai-card__body">${renderOpinion(analysis.opinion, data.currentPrice, data.assetType)}</div></article>
      </div>
      <p class="ai-disclaimer"><strong>투자 유의사항.</strong> 본 분석은 AI가 공개된 시세·뉴스 데이터를 바탕으로 생성한 참고 자료이며 투자 권유가 아닙니다. 진입가·목표가·손절가를 포함한 모든 수치는 확정적 예측이 아니므로, 실제 투자 판단과 그 결과에 대한 책임은 투자자 본인에게 있습니다.</p>`;

    if (chartData) {
      wireAiChart(data.stockCode, chartData, chartPeriod || "D", data.assetType);
    } else {
      refreshTradingViewCharts();
    }
  }

  async function fetchAnalysis(code, name, indicators, market) {
    console.log("[AI분석] fetch 시작", { code, name, indicators, market });
    const ind = indicators && typeof indicators === "object" ? indicators : {};
    const authToken = window.TMAuth ? await window.TMAuth.getAccessToken().catch(() => "") : "";
    let res;
    try {
      res = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          code,
          name,
          market: market || "KR",
          ma20: ind.ma20,
          ma60: ind.ma60,
          ma120: ind.ma120,
          ma200: ind.ma200,
          rsi14: ind.rsi14,
        }),
        cache: "no-store",
      });
    } catch (err) {
      console.error("[AI분석] 실패", err);
      throw err;
    }

    const text = await res.text();
    const data = safeParseJson(text) || {};
    console.log("[AI분석] 응답", res.status, data.analysisError || "ok");

    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.error) throw new Error(data.error);
    if (!data.analysis) throw new Error("분석 데이터가 없습니다");
    return data;
  }

  async function runAnalysis(qRaw) {
    const q = String(qRaw || "").trim();
    if (!q) {
      if (input) input.focus();
      return;
    }
    if (running) return;

    if (freePlanRemaining !== null && freePlanRemaining <= 0) {
      showError("무료 플랜은 이번 달 AI 종목분석 체험 횟수를 모두 사용했습니다. 요금제 페이지로 이동합니다…");
      setTimeout(() => {
        window.location.href = "./pricing.html";
      }, 1200);
      return;
    }

    closeAutocomplete();
    running = true;
    setButtonLoading(true);

    try {
      const resolved = await resolveForAnalysis(q);
      if (!resolved || !resolved.code) {
        throw new Error("종목을 찾을 수 없습니다. 종목명, 티커, 또는 6자리 코드를 입력해 주세요. (예: 삼성전자, AAPL, 비트코인)");
      }

      if (input) input.value = resolved.name || resolved.code;
      showLoading(resolved);

      const isDomestic = isDomesticCode(resolved.code) && (resolved.market || "KR") === "KR";
      const nonKrMarket = resolved.market === "US" || resolved.market === "CRYPTO" ? resolved.market : "";
      // fetchQuickQuote는 KIS 국내 시세 전용이라 미국주식·암호화폐에는 쓸 수 없다 — 그 경우
      // 로딩 헤더는 계속 스켈레톤을 보여주다가 최종 분석 응답으로 채워진다.
      if (isDomestic) {
        void fetchQuickQuote(resolved.code).then((quote) => {
          const host = document.getElementById("ai-loading-quote-host");
          if (!host) return;
          host.innerHTML = renderLoadingQuoteHeader(quote, resolved.name, resolved.code);
        });
      }

      // 2026-07-10: 미국주식·암호화폐도 국내주식과 동일한 자체 캔들+이동평균선 차트를 쓴다
      // (fetchNonKrChart — KIS 해외 기간별시세 / Binance klines). 실패하면 null을 반환해
      // renderAnalysis가 TradingView로 대체한다.
      const chartPromise = isDomestic
        ? fetchKisChart(resolved.code, "D").catch((err) => {
            console.warn("[AI분석] chart fetch 실패", err);
            return null;
          })
        : nonKrMarket
          ? fetchNonKrChart(resolved.code, nonKrMarket, "D").catch((err) => {
              console.warn("[AI분석] chart fetch 실패", err);
              return null;
            })
          : Promise.resolve(null);

      const analyzePromise = chartPromise.then((chartData) =>
        fetchAnalysis(resolved.code, resolved.name, extractChartIndicators(chartData), resolved.market)
      );

      const [chartData, data] = await Promise.all([chartPromise, analyzePromise]);
      finishLoadingProgress();
      renderAnalysis(data, chartData, "D");
      if (freePlanRemaining !== null) freePlanRemaining = Math.max(0, freePlanRemaining - 1);
    } catch (err) {
      console.error("[AI분석] 실패", err);
      showError((err && err.message) || "분석을 불러오지 못했습니다");
    } finally {
      clearLoadingTimer();
      clearProgressTimer();
      running = false;
      setButtonLoading(false);
    }
  }

  async function onAnalyzeClick() {
    await loadStockList();
    const q = input ? String(input.value || "").trim() : "";
    const resolved = q ? await resolveForAnalysis(q) : null;
    const code = resolved && resolved.code ? resolved.code : "";
    const name = resolved && resolved.name ? resolved.name : q;
    console.log("[AI분석] 버튼 클릭됨", code, name);
    runAnalysis(q);
  }

  let analysisUiBound = false;
  let analysisInitSafetyTimer = null;
  /** 무료 회원의 이번 달 잔여 체험 횟수. null = 해당 없음(비로그인/Pro/베타키). */
  let freePlanRemaining = null;
  /** 서버(api/analyze.js)의 FREE_MONTHLY_LIMIT 과 반드시 맞춰서 수정할 것 */
  const FREE_MONTHLY_LIMIT = 3;

  function currentMonthKeySeoulClient() {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}`;
  }

  /** 클라이언트에서 Supabase REST로 이번 달 사용횟수를 직접 조회 (서버리스 함수 추가 없이). */
  async function fetchRemainingFreeAnalysis(userId) {
    const cfg = window.TM_AUTH_CONFIG || {};
    if (!userId || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.TMAuth) return FREE_MONTHLY_LIMIT;
    try {
      const token = await window.TMAuth.getAccessToken();
      const monthKey = currentMonthKeySeoulClient();
      const url = `${cfg.SUPABASE_URL}/rest/v1/analysis_usage?user_id=eq.${userId}&month=eq.${monthKey}&select=count`;
      const res = await fetch(url, {
        headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return FREE_MONTHLY_LIMIT;
      const rows = await res.json();
      const used = rows && rows[0] ? Number(rows[0].count) || 0 : 0;
      return Math.max(0, FREE_MONTHLY_LIMIT - used);
    } catch (e) {
      // 조회 실패 시에도 실제 호출 한도는 서버(api/analyze.js)가 최종 강제하므로 열어준다.
      console.warn("[AI분석] 잔여 체험 횟수 조회 실패", e);
      return FREE_MONTHLY_LIMIT;
    }
  }

  /** 무료 회원 방문 시마다 보여주는 "잔여 N회" 확인 팝업. 확인을 눌러야 페이지가 활성화된다. */
  function showFreeUsageConfirmGate(remaining, onConfirm) {
    if (typeof window.tmEnsureAnalysisGate === "function") window.tmEnsureAnalysisGate();
    const gate = document.getElementById("ai-access-gate");
    if (!gate) {
      onConfirm();
      return;
    }
    const titleEl = gate.querySelector("#ai-access-gate-title");
    const textEl = gate.querySelector("#ai-access-gate-text");
    const btnEl = gate.querySelector("#ai-access-gate-btn");
    const secondaryEl = gate.querySelector("#ai-access-gate-secondary");
    if (titleEl) titleEl.textContent = "AI 종목분석 이용 안내";
    if (textEl) {
      textEl.innerHTML = `무료 플랜은 이번 달 <strong>${escapeHtml(String(remaining))}회</strong> 이용 가능합니다.<br>Pro로 업그레이드하면 무제한 이용하실 수 있습니다.`;
    }
    if (secondaryEl) {
      secondaryEl.hidden = false;
      secondaryEl.innerHTML = '<a href="./pricing.html">요금제 보기</a>';
    }
    if (btnEl) {
      btnEl.textContent = "확인";
      btnEl.setAttribute("href", "#");
      // 이전에 붙어있었을 수 있는 리스너 제거를 위해 노드를 복제해 교체한다.
      const fresh = btnEl.cloneNode(true);
      btnEl.replaceWith(fresh);
      fresh.addEventListener("click", (e) => {
        e.preventDefault();
        onConfirm();
      });
    }
    gate.hidden = false;
    document.body.classList.add("ai-access-gate-open");
  }

  function showAnalysisLoadingGateMessage(title, text) {
    const gate = document.getElementById("ai-access-gate");
    if (!gate) return;
    const titleEl = gate.querySelector("#ai-access-gate-title");
    const textEl = gate.querySelector("#ai-access-gate-text");
    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = text;
  }

  function activateAnalysisPage() {
    const gateEl = document.getElementById("ai-access-gate");
    if (gateEl) {
      gateEl.hidden = true;
      gateEl.remove();
      document.body.classList.remove("ai-access-gate-open");
    }
    bindAnalyzeUi();
  }

  async function init() {
    const state = window.TM_AUTH_STATE;
    if (!state || !state.loaded) {
      document.addEventListener("tm-auth-ready", init, { once: true });
      if (!analysisInitSafetyTimer) {
        analysisInitSafetyTimer = setTimeout(init, 4000);
      }
      return;
    }
    if (analysisInitSafetyTimer) {
      clearTimeout(analysisInitSafetyTimer);
      analysisInitSafetyTimer = null;
    }

    const allowed = typeof window.tmHasAnalysisAccess === "function" ? window.tmHasAnalysisAccess() : true;
    if (!allowed) {
      if (typeof window.tmOpenAnalysisGate === "function") window.tmOpenAnalysisGate();
      document.addEventListener("tm-auth-ready", init, { once: true });
      return;
    }

    if (state.isLoggedIn && !state.hasProAccess) {
      showAnalysisLoadingGateMessage("이용 가능 여부 확인 중", "잠시만 기다려 주세요…");
      const remaining = await fetchRemainingFreeAnalysis(state.userId);
      if (remaining <= 0) {
        window.location.replace("./pricing.html");
        return;
      }
      freePlanRemaining = remaining;
      showFreeUsageConfirmGate(remaining, activateAnalysisPage);
      return;
    }

    activateAnalysisPage();
  }

  function bindAnalyzeUi() {
    if (analysisUiBound) return;
    analysisUiBound = true;

    input = document.getElementById("ai-stock-query");
    btn = document.getElementById("analyzeBtn");
    panel = document.getElementById("ai-analysis-panel");

    console.log("[AI분석] init", {
      input: !!input,
      btn: !!btn,
      panel: !!panel,
      btnIsNull: btn === null,
      readyState: document.readyState,
      cspSafe: CSP_SAFE,
    });

    if (!btn) {
      console.error("[AI분석] #analyzeBtn 없음 — 리스너 미등록");
      return;
    }
    if (!panel) {
      console.error("[AI분석] #ai-analysis-panel 없음");
      return;
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      onAnalyzeClick();
    });

    if (input) {
      input.addEventListener("input", async () => {
        const q = String(input.value || "").trim();
        if (q.length < 2) {
          closeAutocomplete();
          return;
        }
        await loadStockList();
        const matches = filterStocksForAutocomplete(q);
        renderAutocomplete(matches.slice(0, 8), matches.length);
      });

      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          if (acState.open) {
            e.preventDefault();
            moveAutocomplete(1);
          }
          return;
        }
        if (e.key === "ArrowUp") {
          if (acState.open) {
            e.preventDefault();
            moveAutocomplete(-1);
          }
          return;
        }
        if (e.key === "Enter") {
          const picked = pickActiveAutocomplete();
          if (picked) {
            e.preventDefault();
            pickStockItem(picked);
            return;
          }
          e.preventDefault();
          onAnalyzeClick();
          return;
        }
        if (e.key === "Escape") {
          closeAutocomplete();
        }
      });
    }

    const ac = acHost();
    if (ac && !ac.dataset.wired) {
      ac.dataset.wired = "1";
      ac.addEventListener("mousemove", (e) => {
        const it = e.target && e.target.closest ? e.target.closest("[data-ac-idx]") : null;
        if (!it) return;
        const idx = Number(it.getAttribute("data-ac-idx") || "-1");
        if (Number.isFinite(idx) && idx >= 0) {
          acState.active = idx;
          renderAutocomplete(acState.items, acState.items.length);
        }
      });
      ac.addEventListener("mousedown", (e) => {
        const it = e.target && e.target.closest ? e.target.closest("[data-ac-idx]") : null;
        if (!it) return;
        e.preventDefault();
        const idx = Number(it.getAttribute("data-ac-idx") || "-1");
        const picked = idx >= 0 && idx < acState.items.length ? acState.items[idx] : null;
        if (picked) pickStockItem(picked);
      });
    }

    if (!document.body.dataset.aiAcOutside) {
      document.body.dataset.aiAcOutside = "1";
      document.addEventListener("mousedown", (e) => {
        const host = acHost();
        if (!host || host.hidden) return;
        const t = e.target;
        if (host.contains(t) || (input && input.contains(t))) return;
        closeAutocomplete();
      });
    }

    void loadStockList();

    const themeBtn = document.getElementById("theme-toggle");
    if (themeBtn && !themeBtn.dataset.aiTvThemeBound) {
      themeBtn.dataset.aiTvThemeBound = "1";
      themeBtn.addEventListener("click", () => {
        setTimeout(() => {
          refreshTradingViewCharts();
          applyAiChartTheme();
        }, 0);
      });
    }

    document.getElementById("ai-stock-analysis")?.addEventListener("click", (e) => {
      const chip = e.target && e.target.closest ? e.target.closest(".ai-search-popular__chip") : null;
      if (!chip) return;
      e.preventDefault();
      const query = chip.getAttribute("data-query") || "";
      console.log("[AI분석] 인기종목 클릭", query);
      runAnalysis(query);
    });

    const params = new URLSearchParams(window.location.search);
    const boot = params.get("q") || params.get("name") || params.get("code") || "";
    if (boot) {
      console.log("[AI분석] URL 자동 실행", boot);
      runAnalysis(boot);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // 2026-07-11: 모바일 브라우저의 bfcache(뒤로가기 캐시)로 이 페이지가 복원되면 예전에
  // 게이트가 이미 풀렸던 DOM 상태(분석 UI가 이미 바인딩된 상태)가 그대로 보일 수 있다.
  // UI를 다시 바인딩하면 이벤트 리스너가 중복 등록될 수 있으므로 손대지 않고, 세션만 새로
  // 확인해서 더 이상 접근 권한이 없으면 게이트만 다시 띄운다.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    const recheck = () => {
      const allowed = typeof window.tmHasAnalysisAccess === "function" ? window.tmHasAnalysisAccess() : true;
      if (!allowed && typeof window.tmOpenAnalysisGate === "function") window.tmOpenAnalysisGate();
    };
    if (window.TMAuth && typeof window.TMAuth.refreshState === "function") {
      window.TMAuth.refreshState().then(recheck);
    } else {
      recheck();
    }
  });
})();
