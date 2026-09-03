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
    if (v == null || v === "") return null;
    const n = Number(String(v).replace(/,/g, ""));
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

  /** 공식 상장명과 실제 검색어(약칭·구 사명·영문표기 등)가 달라서 매칭이 안 되는
   * 케이스 보정용 별칭 테이블. realtime-board.js(실시간 시세)에서 "현대차"로 검색해도
   * 상장명이 "현대자동차"라 안 걸리던 문제를 고치면서 추가한 것과 동일한 테이블 —
   * AI 종목분석 검색창은 별도 구현이라 여기도 똑같이 반영해야 한다(2026-08-21).
   * key: 별칭, value: 실제 stock-list.json name과 정확히 일치해야 하는 문자열 배열. */
  const STOCK_NAME_ALIASES = {
    현대차: ["현대자동차"],
    기아자동차: ["기아"],
    네이버: ["NAVER"],
    엔씨소프트: ["NC"],
    엔씨: ["NC"],
    포스코: ["POSCO홀딩스"],
    포스코홀딩스: ["POSCO홀딩스"],
    KT: ["케이티"],
    한전: ["한국전력공사"],
    신한금융지주: ["신한지주"],
    신한금융: ["신한지주"],
    LG생건: ["LG생활건강"],
    삼전: ["삼성전자"],
    하이닉스: ["SK하이닉스"],
    두산중공업: ["두산에너빌리티"],
    빅히트: ["하이브"],
    빅히트엔터테인먼트: ["하이브"],
    다음카카오: ["카카오"],
  };
  const STOCK_NAME_ALIAS_TARGETS = (() => {
    const map = new Map();
    for (const [alias, targets] of Object.entries(STOCK_NAME_ALIASES)) {
      const key = normalizeNameKey(alias);
      if (!key) continue;
      const set = map.get(key) || new Set();
      for (const t of targets) set.add(normalizeNameKey(t));
      map.set(key, set);
    }
    return map;
  })();

  function code6Maybe(s) {
    // 우선주(예: 삼성물산우B=02826K, SK우=03473K)는 6자리 영숫자 코드를 쓴다.
    // 숫자만 남기고 깎으면 실제로 존재하지 않는 엉뚱한 코드로 뭉개지므로,
    // 이미 6자리 영숫자 형태면 그대로 통과시킨다(realtime-board.js와 동일 로직).
    const raw = String(s || "").trim().toUpperCase();
    if (/^[0-9A-Z]{6}$/.test(raw)) return raw;
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
          .filter((x) => /^[0-9A-Z]{6}$/.test(x.code) && x.name);
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
    if (/^[0-9A-Z]{6}$/.test(code6)) {
      const hit = stockList.find((x) => x.code === code6);
      return { code: code6, name: hit ? hit.name : code6, market: "KR" };
    }
    const key = normalizeNameKey(q);
    const exact = stockList.find((x) => normalizeNameKey(x.name) === key);
    if (exact) return { code: exact.code, name: exact.name, market: "KR" };
    const aliasTargets = STOCK_NAME_ALIAS_TARGETS.get(key);
    if (aliasTargets) {
      const aliasHit = stockList.find((x) => aliasTargets.has(normalizeNameKey(x.name)));
      if (aliasHit) return { code: aliasHit.code, name: aliasHit.name, market: "KR" };
    }
    // 우선주는 보통주 이름 + "우" 형태라(예: 삼성물산 -> 삼성물산우B), 아래 양방향 includes만
    // 쓰면 "삼성물산우"를 입력했을 때 "삼성물산"(보통주)과 "삼성물산우B"(우선주) 둘 다 부분
    // 일치로 걸려 개수가 2개가 되어버려 못 찾은 것으로 처리됐다. startsWith로 먼저 더 좁혀서
    // 유일하게 하나만 남으면 그걸 우선 채택한다.
    const startsWithHits = stockList.filter((x) => normalizeNameKey(x.name).startsWith(key));
    if (startsWithHits.length === 1) return { code: startsWithHits[0].code, name: startsWithHits[0].name, market: "KR" };
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
    const activeEl = host.querySelector(".rt-ac-item.is-active");
    if (activeEl && typeof activeEl.scrollIntoView === "function") {
      activeEl.scrollIntoView({ block: "nearest" });
    }
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

  const AC_DISPLAY_LIMIT = 50; // 드롭다운에 스크롤로 노출할 최대 개수(기존 8 하드컷 폐지)

  function filterStocksForAutocomplete(q) {
    const lc = q.toLowerCase();
    const key = normalizeNameKey(q);
    const aliasTargets = STOCK_NAME_ALIAS_TARGETS.get(key);
    // 2026-08-26: 관련성 순위 없이 stockList 원본 순서대로 substring 필터만 하던 방식이라
    // "삼성전자" 검색 시 이름에 "삼성전자"가 포함된 파생상품(예: OOO삼성전자SK하이닉스채권혼합50
    // 같은 채권혼합형 ETF)이 실제 삼성전자(005930)보다 먼저 노출되고, 정작 삼성전자는 8개 슬라이스
    // 밖으로 밀려 드롭다운에서 선택조차 안 되던 문제(사용자 제보). realtime-board.js의
    // findStockMatches와 동일한 점수 체계(정확일치>시작일치>포함)로 통일한다 — 두 파일이 검색
    // 로직을 각자 구현하고 있어(normalizeNameKey 주석 참고) 반드시 같이 맞춰야 함.
    const scored = (stockList || [])
      .map((x) => {
        if (!x || !x.name) return null;
        const name = String(x.name);
        const nameLc = name.toLowerCase();
        const code = String(x.code || "");
        const nk = normalizeNameKey(name);
        let score = 0;
        if (nk === key) score = 100;
        else if (aliasTargets && aliasTargets.has(nk)) score = 100;
        else if (nameLc === lc) score = 95;
        else if (code === q) score = 90;
        else if (nk.startsWith(key)) score = 80;
        else if (nameLc.startsWith(lc)) score = 75;
        else if (code.startsWith(q)) score = 70;
        else if (nk.includes(key)) score = 60;
        else if (nameLc.includes(lc)) score = 55;
        else if (code.includes(q) || code.includes(lc)) score = 50;
        else return null;
        return { item: x, score, len: name.length };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.len - b.len || a.item.code.localeCompare(b.item.code));
    const kr = scored.map((row) => row.item);
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
    if (/^[0-9A-Z]{6}$/.test(urlCode) && (q === urlCode || q === urlName || !params.get("q"))) {
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

  // 사용자 피드백 — 차트 축/십자선 가격이 "24만"처럼 만원 단위로 뭉개져서 표시되면
  // 아래 분석 수치(진입가·목표가 등 원 단위 정확한 숫자)와 대조해서 보기 어렵다.
  // 항상 원 단위 그대로, 쉼표만 넣어서 정확히 표시한다(예: 253,950).
  function lwChartPriceFormatter(price) {
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

  // 2026-08-26: 드물게 모델 응답이 문장 단위가 아니라 단어/글자 단위로 개행되어 와서
  // (제보: "수급 분석" 카드가 세로로 한 글자씩 쪼개져 렌더링됨) <p> 태그가 글자 수만큼
  // 생겨 화면이 깨지는 문제가 있었다. 문장부호로 끝나지 않았거나 너무 짧은 조각은 진짜
  // 문단 구분이 아니라고 보고 이전 조각에 이어붙여서 방어한다.
  const PROSE_SENTENCE_END = /[.!?)\]"'」』〉》]$|[다요음임함됨슴갔음]\.?$/;
  function mergeFragmentedParagraphs(rawParas) {
    // 글자/음절 단위로 통째로 쪼개진 극단적인 경우(평균 조각 길이가 2자 이하)엔 애초에
    // 문단 구분이 아니었을 가능성이 높으므로 구분자 없이 그대로 이어붙인다 — 그렇지 않고
    // 아래 문장부호 기반 병합을 쓰면 글자 사이마다 공백이 끼어 어색해진다.
    if (rawParas.length > 1) {
      const avgLen = rawParas.reduce((sum, s) => sum + s.length, 0) / rawParas.length;
      if (avgLen <= 2) return [rawParas.join("")];
    }
    const paras = [];
    for (const frag of rawParas) {
      const prevIdx = paras.length - 1;
      const prev = prevIdx >= 0 ? paras[prevIdx] : null;
      const shouldMerge = prev != null && (frag.length <= 6 || !PROSE_SENTENCE_END.test(prev));
      if (shouldMerge) {
        paras[prevIdx] = /\s$/.test(prev) ? prev + frag : `${prev} ${frag}`;
      } else {
        paras.push(frag);
      }
    }
    return paras;
  }

  // 2026-08-26: ai-summary-desc는 formatProseText를 거치지 않고 white-space:pre-line
  // CSS로 그대로 렌더링되는 필드라(요약 카드 디자인상 짧은 한 문단이어야 함), 서버가
  // sanitizeOneLineText로 이미 정리해서 내려주지만 프론트에서도 한 번 더 방어한다.
  // 2026-08-26 재수정: 기존엔 "\n"(LF)만 검사해서, 모델/네트워크 경로에서 드물게
  // \r(CR) 단독이나 유니코드 줄바꿈(U+2028/U+2029)으로 개행이 오면 감지를 못 하고
  // 원문을 그대로 통과시켰다 — 실제 라이브에서 이 경로로 세로깨짐이 재발한 걸 확인
  // (avgLen 로직 자체는 정상 동작했지만애초에 개행으로 인식을 못 했음). 개행으로 볼
  // 수 있는 문자를 모두 잡도록 정규식을 넓혔다.
  const ONE_LINE_BREAK_RE = /\r\n|[\r\n\u2028\u2029]+/;
  function sanitizeOneLineText(raw) {
    const s = String(raw || "").trim();
    if (!ONE_LINE_BREAK_RE.test(s)) return s;
    const parts = s.split(ONE_LINE_BREAK_RE).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return "";
    const avgLen = parts.reduce((sum, p) => sum + p.length, 0) / parts.length;
    return avgLen <= 2 ? parts.join("") : parts.join(" ");
  }

  function formatProseText(text, emptyMsg) {
    const raw = String(text || "").trim();
    if (!raw) return `<p class="ai-prose-empty">${escapeHtml(emptyMsg || "내용이 없습니다.")}</p>`;
    const rawParas = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const paras = mergeFragmentedParagraphs(rawParas);
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
    if (signal === "매수") return "buy";
    if (signal === "회피") return "avoid";
    return "hold";
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

  function formatMarketCapPretty(raw, assetType) {
    const n = toNum(raw);
    if (n == null) return "—";
    if (assetType === "US" || assetType === "CRYPTO") {
      const abs = Math.abs(n);
      if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
      if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
      if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
      if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
      return `$${Math.round(n).toLocaleString("en-US")}`;
    }
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
    // 암호화폐는 PBR(주가순자산비율) 개념 자체가 없으므로 대신 24시간 거래대금을 보여준다.
    const fourthCell =
      assetType === "CRYPTO"
        ? ["거래대금(24H)", formatMarketCapPretty(o.volume, assetType)]
        : ["PBR", fmtPbr(o.pbr)];
    const cells = [
      ["52주 고점", fmtPrice(o.high52w, assetType)],
      ["52주 저점", fmtPrice(o.low52w, assetType)],
      ["시가총액", formatMarketCapPretty(o.marketCapRaw, assetType)],
      fourthCell,
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

  // 2026-07-15: "6번 차트 흐름 분석"을 소제목 박스로 구조화해서 보여주기 위한 섹션 정의.
  // AI가 ①②③ 마커/줄바꿈 없이 하나의 flowing text로 응답해도(기존 캐시된 분석 포함)
  // 문장 단위로 키워드를 매칭해 소제목별 박스로 재구성한다.
  // 배열 순서 = 매칭 우선순위(위에 있을수록 더 구체적인 키워드 → 먼저 검사).
  const CHART_SECTIONS = [
    { key: "hilo", title: "전고점·전저점(52주)", color: "gray", re: /52주|전고점|전저점/ },
    { key: "elliott", title: "엘리어트 파동", color: "green", re: /엘리어트|파동|조정\s*국면/ },
    {
      key: "mtf",
      title: "멀티 타임프레임 정합성",
      color: "indigo",
      re: /멀티\s*타임프레임|일봉[·,\s]*주봉[·,\s]*월봉|같은\s*방향으로/,
    },
    { key: "weekly", title: "주봉 흐름", color: "teal", re: /주봉/ },
    { key: "monthly", title: "월봉 흐름", color: "orange", re: /월봉/ },
    { key: "rsi", title: "RSI", color: "blue", re: /RSI/i },
    {
      key: "ict",
      title: "ICT(스마트머니) 관점",
      color: "pink",
      re: /ICT|유동성|스마트머니|오더블록|order\s*block|FVG/i,
    },
    {
      key: "sr",
      title: "지지선·저항선",
      color: "yellow",
      re: /지지선|저항선|지지대|저항대|1차\s*저항|2차\s*저항|1차\s*지지|2차\s*지지/,
    },
    {
      key: "ma",
      title: "이동평균선(일봉)",
      color: "red",
      re: /이동평균|이평선|20일선|60일선|120일선|200일선|정배열|역배열/,
    },
  ];

  /* 2026-09-03: 일목균형표 서술 제거.
   * 전환선·기준선·선행스팬 값은 애초에 서버가 AI에 넘기지 않는다 — 그래서 이 항목은
   * "수치가 확인되지 않는다"거나 보이지도 않는 구름대를 지어내는 문장만 반복됐다.
   * 프롬프트에서 금지했지만 ①이미 저장된 과거 리포트 ②모델이 습관적으로 끼워 넣는 경우가
   * 남으므로, 화면에서도 해당 문장을 통째로 버린다(제목 없는 회색 문단으로 흘러가지 않게). */
  const CHART_DROP_RE = /일목|전환선|기준선|구름대|선행스팬|후행스팬/;

  function isDroppedChartLine(text) {
    return CHART_DROP_RE.test(String(text || ""));
  }

  function chartSectionFor(text) {
    const t = String(text || "");
    for (const sec of CHART_SECTIONS) {
      if (sec.re.test(t)) return sec;
    }
    return null;
  }

  function chartDotClass(line) {
    const sec = chartSectionFor(line);
    return `ai-chart-dot--${sec ? sec.color : "gray"}`;
  }

  function parseChartLine(line) {
    const raw = String(line || "").trim();
    const m = raw.match(/^[①②③④⑤⑥⑦⑧⑨⑩]?\s*([^:：—\-]+?)[:：—\-]\s*(.+)$/);
    if (m) return { title: m[1].trim(), body: m[2].trim() };
    return { title: "", body: raw };
  }

  /** 종결어미(다/요/음/함/임/됨) + 마침표/물음표/느낌표 뒤 공백(또는 끝)을 문장 경계로 인정해서 분리.
   * 경계가 되는 종결 패턴의 "끝 위치"만 찾고 그 사이 구간은 통째로 슬라이스하기 때문에
   * "48.02%" 같은 문장 중간의 소수점에 걸려 텍스트가 유실되는 일이 없다. */
  function splitChartSentences(text) {
    const s = String(text || "").trim();
    if (!s) return [];
    const enderRe = /[다요음함임됨][.!?]+(?=\s|$)/g;
    const out = [];
    let lastEnd = 0;
    let m;
    while ((m = enderRe.exec(s))) {
      const end = m.index + m[0].length;
      const piece = s.slice(lastEnd, end).trim();
      if (piece) out.push(piece);
      lastEnd = end;
    }
    const rest = s.slice(lastEnd).trim();
    if (rest) out.push(rest);
    return out;
  }

  /** 줄바꿈이 전혀 없는 하나의 서술형 문단을 소제목별 문단(박스)으로 재구성.
   * AI가 마커 없이 flowing text로 응답한 경우(가장 흔한 케이스)를 위한 안전망. */
  function groupChartSections(text) {
    const sentences = splitChartSentences(text).filter((sent) => !isDroppedChartLine(sent));
    const groups = [];
    let current = null;
    sentences.forEach((sent) => {
      const sec = chartSectionFor(sent);
      if (sec && (!current || current.key !== sec.key)) {
        current = { key: sec.key, title: sec.title, parts: [] };
        groups.push(current);
      } else if (!current) {
        current = { key: null, title: "", parts: [] };
        groups.push(current);
      }
      current.parts.push(sent);
    });
    return groups.filter((g) => g.parts.length).map((g) => ({ title: g.title, body: g.parts.join(" ") }));
  }

  function renderChartText(text) {
    const raw = String(text || "").trim();
    if (!raw) return `<p class="ai-chart-text-empty">차트 분석이 없습니다.</p>`;

    let items;
    if (/\n/.test(raw)) {
      items = raw
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((line) => !isDroppedChartLine(line))
        .map((line) => parseChartLine(line));
    } else {
      items = groupChartSections(raw);
    }
    // 전부 걸러졌으면 원문을 통째로 되살리지 않는다 — 그러면 방금 버린 일목 문장이
    // 제목 없는 회색 문단으로 되돌아온다.
    if (!items.length) {
      if (isDroppedChartLine(raw)) return `<p class="ai-chart-text-empty">차트 분석이 없습니다.</p>`;
      items = [{ title: "", body: raw }];
    }

    return (
      `<div class="ai-chart-text">` +
      items
        .map(({ title, body }) => {
          const sec = chartSectionFor(title || body);
          const color = sec ? sec.color : "gray";
          const titleHtml = title
            ? `<div class="ai-chart-box__head"><span class="ai-chart-dot ai-chart-dot--${color}"></span><span class="ai-chart-box__title">${escapeHtml(title)}</span></div>`
            : "";
          const bodyHtml = emphasizeMetrics(escapeHtml(body));
          return `<div class="ai-chart-box ai-chart-box--${color}">${titleHtml}<p class="ai-chart-box__body">${bodyHtml}</p></div>`;
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
    const raw = String(code || "").trim().toUpperCase();
    if (/^[0-9A-Z]{6}$/.test(raw)) return true;
    const digits = raw.replace(/\D/g, "");
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

  /** 2026-07-11: 크로스헤어에 시가/고가/저가/종가/거래량을 보여주는 툴팁 박스 —
   * us-market/crypto의 자체 캔들 차트(assets/lw-candle-chart.js)와 동일한 구현. 이평선 위에
   * 뜨던 동그란 마커는 각 라인 시리즈에서 꺼서 없애고 이 박스로 정보를 대신 보여준다. */
  function ensureAiOhlcTooltipStyle() {
    if (document.getElementById("tm-lw-ohlc-tooltip-style")) return;
    const style = document.createElement("style");
    style.id = "tm-lw-ohlc-tooltip-style";
    style.textContent =
      ".tm-lw-ohlc-tooltip{position:absolute;z-index:50;left:0;top:0;display:none;" +
      "min-width:150px;max-width:min(260px,92vw);padding:9px 11px;pointer-events:none;" +
      "background:var(--bg-secondary,#fff);border:1px solid var(--border-strong,rgba(0,0,0,.12));" +
      "border-radius:var(--radius,6px);box-shadow:var(--sheet-shadow,0 6px 20px rgba(30,40,90,.12));" +
      'font-family:"Noto Sans KR",-apple-system,sans-serif;font-size:11px;line-height:1.45;' +
      "color:var(--text-primary,#131722);}" +
      ".tm-lw-ohlc-tooltip__dt{margin:0 0 7px;padding-bottom:6px;" +
      "border-bottom:1px solid var(--border,rgba(0,0,0,.08));font-weight:600;" +
      "color:var(--accent-brand);letter-spacing:.02em;}" +
      ".tm-lw-ohlc-tooltip__row{display:flex;justify-content:space-between;gap:12px;margin:2px 0;}" +
      ".tm-lw-ohlc-tooltip__row span:first-child{color:var(--text-secondary,#5d606b);flex-shrink:0;}" +
      ".tm-lw-ohlc-tooltip__row span:last-child{color:var(--text-primary,#131722);" +
      "text-align:right;font-variant-numeric:tabular-nums;}" +
      '[data-theme="dark"] .tm-lw-ohlc-tooltip{background:rgba(28,32,48,.98);' +
      "border-color:rgba(255,255,255,.12);box-shadow:0 6px 20px rgba(0,0,0,.55);}" +
      '[data-theme="dark"] .tm-lw-ohlc-tooltip__dt{color:var(--accent-bright,var(--accent-brand));' +
      "border-bottom-color:rgba(255,255,255,.08);}" +
      '[data-theme="dark"] .tm-lw-ohlc-tooltip__row span:first-child{color:var(--text-secondary,#787b86);}' +
      '[data-theme="dark"] .tm-lw-ohlc-tooltip__row span:last-child{color:var(--text-primary,#d1d4dc);}';
    document.head.appendChild(style);
  }

  function aiOhlcDateLabel(time) {
    const s = String(time || "");
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return s;
    return `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일`;
  }

  function fmtAiOhlcVol(n) {
    if (n == null || !Number.isFinite(Number(n))) return "—";
    return Math.round(Number(n)).toLocaleString("ko-KR");
  }

  function wireAiOhlcTooltip(hostEl, chart, candles, formatPrice) {
    ensureAiOhlcTooltipStyle();
    if (getComputedStyle(hostEl).position === "static") hostEl.style.position = "relative";
    const tip = document.createElement("div");
    tip.className = "tm-lw-ohlc-tooltip";
    tip.setAttribute("aria-hidden", "true");
    hostEl.appendChild(tip);

    const byTime = new Map(candles.map((c) => [String(c.time), c]));

    chart.subscribeCrosshairMove((param) => {
      if (!param || param.time == null || !param.point) {
        tip.style.display = "none";
        return;
      }
      const row = byTime.get(String(param.time));
      if (!row || row.open == null) {
        tip.style.display = "none";
        return;
      }
      tip.innerHTML =
        `<div class="tm-lw-ohlc-tooltip__dt">${aiOhlcDateLabel(row.time)}</div>` +
        `<div class="tm-lw-ohlc-tooltip__row"><span>시가</span><span>${formatPrice(row.open)}</span></div>` +
        `<div class="tm-lw-ohlc-tooltip__row"><span>고가</span><span>${formatPrice(row.high)}</span></div>` +
        `<div class="tm-lw-ohlc-tooltip__row"><span>저가</span><span>${formatPrice(row.low)}</span></div>` +
        `<div class="tm-lw-ohlc-tooltip__row"><span>종가</span><span>${formatPrice(row.close)}</span></div>` +
        `<div class="tm-lw-ohlc-tooltip__row"><span>거래량</span><span>${fmtAiOhlcVol(row.volume)}</span></div>`;
      tip.style.display = "block";
      const hostRect = hostEl.getBoundingClientRect();
      const pad = 8;
      let x = param.point.x + 14;
      let y = param.point.y + 14;
      tip.style.visibility = "hidden";
      const tw = tip.offsetWidth || 160;
      const th = tip.offsetHeight || 110;
      tip.style.visibility = "visible";
      if (x + tw + pad > hostRect.width) x = Math.max(pad, param.point.x - tw - 14);
      if (y + th + pad > hostRect.height) y = Math.max(pad, param.point.y - th - 14);
      tip.style.left = `${Math.max(pad, x)}px`;
      tip.style.top = `${Math.max(pad, y)}px`;
    });
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
      // 2026-07-11: 이평선 위에 뜨는 동그란 크로스헤어 마커는 끄고, 대신 OHLC 툴팁 박스로
      // 시가/고가/저가/종가/거래량을 한 번에 보여준다(아래 wireAiOhlcTooltip).
      const lineOpts = {
        color,
        lineWidth,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      };
      let line;
      if (LC.LineSeries && typeof chart.addSeries === "function") {
        line = chart.addSeries(LC.LineSeries, lineOpts);
      } else {
        line = chart.addLineSeries(lineOpts);
      }
      line.setData(lineData);
    }
    wireAiOhlcTooltip(hostEl, chart, chartData.candles, lwChartPriceFormatterFor(market));
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
    const rawCode = String(stockCode || "").trim().toUpperCase();
    const code = /^[0-9A-Z]{6}$/.test(rawCode) ? rawCode : String(stockCode || "").replace(/\D/g, "");
    if (/^[0-9A-Z]{6}$/.test(code) && market !== "US" && market !== "CRYPTO") return `KRX:${code}`;
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

  /**
   * 2026-09-03: 차트 카드가 "① 이동평균선 …" 문단 8개 나열이라 읽기 전에 지치는 화면이었다.
   * 카드 맨 위에 코드가 계산한 도표 두 개(이평 이격 다이버징 막대 + RSI 게이지)를 얹어,
   * 글을 읽기 전에 "지금 어디에 서 있는지"가 먼저 보이게 한다. 값은 전부 실제 지표다.
   */
  function renderTechSnapshot(currentPrice, ind, assetType) {
    const price = toNum(currentPrice);
    const i = ind && typeof ind === "object" ? ind : {};
    const mas = [
      ["20일선", toNum(i.ma20)],
      ["60일선", toNum(i.ma60)],
      ["120일선", toNum(i.ma120)],
      ["200일선", toNum(i.ma200)],
    ].filter(([, v]) => v != null && v > 0);
    const rsi = toNum(i.rsi14);
    if ((!price || mas.length < 2) && rsi == null) return "";

    let maBlock = "";
    if (price && mas.length >= 2) {
      const gaps = mas.map(([label, v]) => [label, v, ((price - v) / v) * 100]);
      // 눈금 상한은 실제 최대 이격(최소 10%)으로 잡는다 — 2% 차이가 화면 끝까지 뻗지 않게.
      const scale = Math.max(10, ...gaps.map(([, , g]) => Math.abs(g)));
      const rows = gaps
        .map(([label, v, gap]) => {
          const w = Math.min(50, (Math.abs(gap) / scale) * 50);
          const side = gap >= 0 ? "is-plus" : "is-minus";
          const style = gap >= 0 ? `left:50%;width:${w.toFixed(1)}%` : `right:50%;width:${w.toFixed(1)}%`;
          const sign = gap >= 0 ? "+" : "";
          return `<li class="techsnap__row">
            <span class="techsnap__k">${escapeHtml(label)}</span>
            <span class="techsnap__v">${escapeHtml(fmtPrice(v, assetType))}</span>
            <b class="techsnap__bar"><i class="${side}" style="${style}"></i></b>
            <span class="techsnap__d ${side}">${sign}${gap.toFixed(1)}%</span>
          </li>`;
        })
        .join("");
      // 정배열/역배열은 이동평균끼리의 순서로 코드가 직접 판정한다(AI 서술과 무관).
      const vals = mas.map(([, v]) => v);
      let order = "혼조";
      if (vals.every((v, k) => k === 0 || vals[k - 1] > v)) order = "정배열";
      else if (vals.every((v, k) => k === 0 || vals[k - 1] < v)) order = "역배열";
      const aboveCount = gaps.filter(([, , g]) => g >= 0).length;
      maBlock = `<section class="techsnap__col">
        <h4 class="techsnap__title">이동평균선 대비 이격<span class="techsnap__cap">${escapeHtml(order)} · ${aboveCount}/${gaps.length}개 선 위</span></h4>
        <ul class="techsnap__list">${rows}</ul>
      </section>`;
    }

    let rsiBlock = "";
    if (rsi != null) {
      const pos = Math.max(0, Math.min(100, rsi));
      const state = rsi >= 70 ? ["과열", "is-plus"] : rsi <= 30 ? ["과매도", "is-minus"] : ["중립", "is-neu"];
      rsiBlock = `<section class="techsnap__col">
        <h4 class="techsnap__title">RSI (14)<span class="techsnap__cap">30 이하 과매도 · 70 이상 과열</span></h4>
        <div class="techsnap__rsi">
          <div class="techsnap__rsi-num ${state[1]}">${rsi.toFixed(1)}<em>${escapeHtml(state[0])}</em></div>
          <div class="techsnap__rsi-track">
            <span class="techsnap__rsi-zone techsnap__rsi-zone--under"></span>
            <span class="techsnap__rsi-zone techsnap__rsi-zone--over"></span>
            <i class="techsnap__rsi-dot" style="left:${pos.toFixed(1)}%"></i>
          </div>
          <div class="techsnap__rsi-scale"><span>0</span><span>30</span><span>70</span><span>100</span></div>
        </div>
      </section>`;
    }
    if (!maBlock && !rsiBlock) return "";
    return `<div class="techsnap">${maBlock}${rsiBlock}</div>`;
  }

  function renderChartSection(stockCode, stockName, chartText, market, hasChartData, techSnapshotHtml) {
    // 2026-07-10: 예전엔 국내주식이 아니면 무조건 TradingView(단일 색 이평선만 지원)를 썼다.
    // 이제는 미국주식·암호화폐도 자체 캔들+4색 이평선 차트 데이터를 받아올 수 있으므로,
    // 실제로 그 데이터 확보에 성공했는지(hasChartData)를 기준으로 삼는다. 실패했을 때만
    // (드문 티커, 스테이블코인처럼 Binance 페어가 없는 경우 등) TradingView로 대체한다.
    const useTv = !hasChartData;
    return (techSnapshotHtml || "") + renderChartShell(stockCode, stockName, chartText, useTv, market);
  }

  /** 2026-08-26: GPT 리포트 지적사항 "상승확률 40%의 산출 방법이 없다"에 대한 보완 —
   * AI의 정성적 확률과는 별개로, 이동평균 위치·RSI·거래량·수급만으로 서버가 기계적으로
   * 계산한 참고 점수(-2~+2 x 4항목)를 함께 보여준다. scoreCard가 없으면(데이터 부족) 생략.
   * 2026-08-26 UI 리디자인: 우측 2x2 필 그리드(pillsHtml)와 하단 종합점수+설명 풋터
   * (footerHtml)를 분리해서 반환 — 카드1 템플릿에서 서로 다른 위치(grid 안 / grid 밖
   * 카드 전체 폭)에 각각 배치한다. */
  function buildScoreCardParts(scoreCard) {
    const empty = { pillsHtml: "", footerHtml: "" };
    if (!scoreCard || typeof scoreCard !== "object") return empty;
    const labels = { trend: "추세", momentum: "모멘텀", volume: "거래량", supply: "수급" };
    const activeKeys = Object.keys(labels).filter((k) => scoreCard[k] != null);
    if (!activeKeys.length) return empty;
    const pills = activeKeys
      .map((k) => {
        const v = scoreCard[k];
        const sign = v > 0 ? "+" : "";
        const cls = v > 0 ? "sum2-pill--pos" : v < 0 ? "sum2-pill--neg" : "sum2-pill--neu";
        return `<div class="sum2-pill ${cls}"><span class="k">${escapeHtml(labels[k])}</span><span class="v">${sign}${v}</span></div>`;
      })
      .join("");
    const totalV = toNum(scoreCard.total);
    const totalSign = totalV > 0 ? "+" : "";
    // GPT 리포트 지적사항 — "종합 +3"만 보면 상단 "상승확률 35%"와 같은 척도처럼 오해할 수
    // 있어, 이게 몇 점 만점 중 몇 점인지(-8~+8처럼 항목 수×2) 분모를 같이 보여준다.
    const maxAbs = activeKeys.length * 2;
    return {
      pillsHtml: `<div class="sum2-pills">${pills}</div>`,
      footerHtml:
        `<div class="sum2-footer">` +
        `<span class="sum2-total">종합 ${totalV != null ? `${totalSign}${totalV}/${maxAbs}` : "—"}</span>` +
        `<p class="sum2-footnote">${escapeHtml(scoreCard.note || "")}</p>` +
        `</div>`,
    };
  }

  // GPT 리포트 지적사항 — "AI가 지어낸 말"과 실제 KIS 데이터를 한눈에 구분하고 싶다는
  // 요청 + "하루 수급만으론 부족하다"는 지적에 대응. 1일/5일/20일 순매수는 서버가 KIS
  // 실데이터를 그대로 집계한 값(analysis.supplyFlow)이라 여기서는 절대 가공/추정하지
  // 않고 그대로 표로 보여준다. 그 아래 AI 해석(analysis.supply, 프로즈)과 시각적으로
  // 분리해서 "사실"과 "AI 해석"을 헷갈리지 않게 한다.
  function fmtSharesSigned(n) {
    if (n == null) return "—";
    const v = Math.round(n);
    const sign = v > 0 ? "+" : "";
    return `${sign}${v.toLocaleString("ko-KR")}주`;
  }

  // 서버(api/analyze.js)의 formatKoreanWon()과 동일한 로직 — "20,397.1억원" 같은
  // 어색한 소수점 표기 대신 "2조 397억원" 형태의 한국식 조/억 단위로 통일한다.
  function fmtWonEokSigned(n) {
    if (n == null) return "";
    const sign = n < 0 ? "-" : "+";
    const abs = Math.abs(n);
    const JO = 1e12, EOK = 1e8, MAN = 1e4;
    if (abs < EOK) {
      const man = Math.round(abs / MAN);
      if (man <= 0) return "";
      return `${sign}${man.toLocaleString("ko-KR")}만원`;
    }
    let jo = Math.floor(abs / JO);
    let eok = Math.round((abs % JO) / EOK);
    if (eok >= 10000) {
      jo += 1;
      eok -= 10000;
    }
    const parts = [];
    if (jo > 0) parts.push(`${jo.toLocaleString("ko-KR")}조`);
    parts.push(`${eok.toLocaleString("ko-KR")}억`);
    return `${sign}${parts.join(" ")}원`;
  }

  /** 순매수(+)=상승색(빨강) / 순매도(-)=하락색(파랑). 0이거나 값 없으면 색 없음. */
  function signClass(n) {
    if (n == null || n === 0) return "";
    return n > 0 ? "is-plus" : "is-minus";
  }

  function renderSupplyFlowFact(supplyFlow) {
    if (!supplyFlow || typeof supplyFlow !== "object") return "";
    const rows = [
      ["외국인", supplyFlow.foreign, supplyFlow.foreignDivergent],
      ["기관", supplyFlow.institution, supplyFlow.institutionDivergent],
    ].filter(([, v]) => v && (v.d1 != null || v.d5 != null || v.d20 != null));
    if (!rows.length) return "";
    // 2026-09-03: 숫자만 있으면 1일·5일·20일의 크기 차이가 안 읽힌다. 여섯 값의 최대 절댓값을
    // 기준으로 가운데에서 좌(순매도·파랑)/우(순매수·빨강)로 뻗는 다이버징 막대를 함께 그린다.
    let maxAbs = 0;
    for (const [, v] of rows) {
      for (const k of ["d1", "d5", "d20"]) {
        const n = toNum(v[k]);
        if (n != null) maxAbs = Math.max(maxAbs, Math.abs(n));
      }
    }
    const flowBar = (val) => {
      const n = toNum(val);
      if (n == null || !maxAbs) return "";
      const w = Math.min(50, (Math.abs(n) / maxAbs) * 50);
      const side = n >= 0 ? "is-plus" : "is-minus";
      const style = n >= 0 ? `left:50%;width:${w.toFixed(1)}%` : `right:50%;width:${w.toFixed(1)}%`;
      return `<b class="ai-supply-fact__bar"><i class="${side}" style="${style}"></i></b>`;
    };
    const body = rows
      .map(([label, v, divergent]) => {
        const eok = fmtWonEokSigned(v.d1WonApprox);
        const warn = divergent
          ? `<span class="ai-supply-fact__warn">오늘·20일 추세 반대</span>`
          : "";
        // 2026-08-28: 순매수/순매도를 숫자만 보고 부호를 찾아 읽어야 했던 걸,
        // 한국 시장 관습대로 순매수(+)=빨강 / 순매도(-)=파랑으로 색 구분한다.
        // 막대는 세 기간의 맨 아래에 나란히 오도록 환산액(small) 뒤에 붙인다 —
        // 중간에 끼우면 1일 칸만 막대 높이가 달라져 열이 어긋난다.
        const cell = (period, val, extra) =>
          `<span class="ai-supply-fact__cell ${signClass(val)}"><em>${period}</em>${escapeHtml(fmtSharesSigned(val))}${extra || ""}${flowBar(val)}</span>`;
        return (
          `<div class="ai-supply-fact__row">` +
          `<span class="ai-supply-fact__label">${escapeHtml(label)}</span>` +
          cell("1일", v.d1, eok ? `<small>(현재가 기준 환산 약 ${escapeHtml(eok)})</small>` : "") +
          cell("5일", v.d5, "") +
          cell("20일", v.d20, "") +
          warn +
          `</div>`
        );
      })
      .join("");
    return (
      // 2026-09-03 사용자 피드백: "사실"/"AI 해석" 같은 출처 배지는 구독자에게 필요 없고,
      // 오히려 "그럼 배지 없는 건 거짓인가"라는 의심을 만든다 — 전부 제거했다.
      `<div class="ai-supply-fact">` +
      body +
      `</div>`
    );
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
            // 2026-08-26: certainty(확정성 배지)·reflectionBasis(반영도 근거) — GPT 리포트 지적사항
            // "40%라는 숫자의 근거가 없다"에 대한 대응. 값이 없으면 그냥 생략(지어내지 않음).
            const certaintyBadge = it.certainty
              ? `<span class="ai-mat-certainty ai-mat-certainty--${escapeHtml(it.certainty)}">${escapeHtml(it.certainty)}</span>`
              : "";
            const basisLine = it.reflectionBasis
              ? `<p class="ai-mat-card__basis"><span class="ai-mat-card__basis-label">근거</span>${escapeHtml(it.reflectionBasis)}</p>`
              : "";
            return (
              `<article class="ai-mat-card ${borderCls}">` +
              `<div class="ai-mat-card__head"><strong class="ai-mat-card__name">${escapeHtml(it.name)}</strong><span class="ai-mat-card__badges"><span class="ai-mat-strength ${strengthCls}">${escapeHtml(strengthLabel(it.strength))}</span>${certaintyBadge}</span></div>` +
              `<div class="ai-mat-reflect"><div class="ai-mat-reflect__track"><div class="ai-mat-reflect__bar ${barCls}" style="width:${pct}%"></div></div><span class="ai-mat-reflect__label">${escapeHtml(note)}</span></div>` +
              basisLine +
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

  /** A/B/C 시나리오 확률을 100% 스택 막대 하나로. 합이 100이 아니면 정규화해서 그린다. */
  function renderScenarioProbBar(scenarios) {
    const list = (Array.isArray(scenarios) ? scenarios : [])
      .map((s) => ({ label: String(s.label || "").trim(), type: String(s.type || "").trim(), prob: toNum(s.probability) }))
      .filter((s) => s.label && s.prob != null && s.prob > 0);
    if (list.length < 2) return "";
    const total = list.reduce((a, b) => a + b.prob, 0);
    if (!total) return "";
    const segs = list
      .map((s) => {
        const w = (s.prob / total) * 100;
        const cls = scenarioCardClass(s.label, s.type).replace("ai-scenario--", "");
        return `<span class="ai-probbar__seg ai-probbar__seg--${cls}" style="width:${w.toFixed(2)}%"><em>${escapeHtml(s.label)}</em><b>${Math.round(s.prob)}%</b></span>`;
      })
      .join("");
    const legend = list
      .map((s) => {
        const cls = scenarioCardClass(s.label, s.type).replace("ai-scenario--", "");
        return `<span class="ai-probbar__leg"><i class="ai-probbar__chip ai-probbar__chip--${cls}"></i>${escapeHtml(s.label)}안 ${escapeHtml(s.type || "")}</span>`;
      })
      .join("");
    return `<div class="ai-probbar"><div class="ai-probbar__title">시나리오 확률</div><div class="ai-probbar__track">${segs}</div><div class="ai-probbar__legend">${legend}</div></div>`;
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
    // 2026-08-26: 손익비(R:R)는 서버(api/analyze.js)가 확정된 entry/stop/target으로 직접
    // 계산해서 내려준 값 — AI가 던진 숫자가 아니라 검증 가능한 산수 결과다.
    // 사용자 피드백 — "R:R 2"는 무슨 뜻인지 바로 안 와닿으니 "손익비 1:2"처럼 위험 1에
    // 대한 기대수익 배수로 읽히게 표기한다.
    const rr = toNum(s.rr);
    const rrText = rr != null ? `손익비 1:${rr}` : "";
    // 2026-08-28: 진입/목표/손절은 성격이 다른 숫자라 라벨만으로는 한눈에 안 들어온다.
    // 한국식 색 관습(상승=빨강, 하락=파랑)에 맞춰 목표=빨강 / 손절=파랑 / 진입=중립 앰버로
    // 구분하고, 서술형 행(조건·대응전략·확률 근거)은 라벨을 위로 올린 블록 레이아웃으로 나눈다.
    const rows = [
      ["조건", s.condition, "cond"],
      ["진입가", s.entry != null ? fmtPrice(s.entry, assetType) : null, "entry"],
      [
        isBear ? "반등 목표가" : "목표가",
        s.target != null ? fmtPrice(s.target, assetType) : null,
        "target",
      ],
      ["손절가", s.stop != null ? fmtPrice(s.stop, assetType) : null, "stop"],
      isBear && s.targetLow != null
        ? ["추가 하락 시 목표 하단", fmtPrice(s.targetLow, assetType), "targetlow"]
        : null,
      isBear ? ["대응전략", s.strategy, "strategy"] : null,
      s.basis ? ["확률 근거", s.basis, "basis"] : null,
    ];
    const lines = rows
      .filter(Boolean)
      .filter(([, v]) => v)
      .map(
        ([k, v, kind]) =>
          `<div class="ai-scenario-row ai-scenario-row--${kind}"><span class="ai-scenario-row__k">${escapeHtml(k)}</span><span class="ai-scenario-row__v">${escapeHtml(String(v))}</span></div>`
      )
      .join("");
    const rrBadge = rrText ? `<span class="ai-scenario__rr">${escapeHtml(rrText)}</span>` : "";
    return `<article class="ai-scenario ${cls}"><header class="ai-scenario__head"><span class="ai-scenario__label">${label}안 (${type})</span><span class="ai-scenario__prob">${probText}</span>${rrBadge}</header><div class="ai-scenario__body">${lines || "<p>—</p>"}</div></article>`;
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
    // 2026-08-26: target2(2차 목표가)·rr(손익비)는 서버가 실제 주봉/월봉 스윙 저항과
    // 확정된 entry/stop/target으로 계산해서 내려준 값 — AI가 지어낸 숫자가 아니다.
    const target2 = toNum(o.target2);
    const target2IsLongTerm = !!o.target2IsLongTerm;
    const rrVal = toNum(o.rr);
    // 2026-08-28: 매매 흐름 그대로(진입 → 목표 → 손절) 읽히도록 순서를 시나리오 카드와
    // 통일하고, 종류별 색상 클래스를 붙여 목표=빨강 / 손절=파랑 / 진입=앰버로 구분한다.
    const priceRows = [
      ["진입가", fmtPrice(prices.entry, assetType), "entry"],
      [target2 != null ? "목표가(1차)" : "목표가", fmtPrice(prices.target, assetType), "target"],
      ["손절가", fmtPrice(prices.stop, assetType), "stop"],
      // GPT 리포트 지적사항 — target1과 15% 이상 떨어진 target2를 "2차 목표"로 나란히
      // 보여주면 단기에 도달 가능한 목표처럼 오인될 수 있어 "장기 잠재 목표"로 구분한다.
      target2 != null
        ? [
            target2IsLongTerm ? "장기 잠재 목표" : "목표가(2차)",
            fmtPrice(target2, assetType),
            "target2",
          ]
        : null,
    ]
      .filter(Boolean)
      .map(
        ([label, val, kind]) =>
          `<div class="ai-opinion-price ai-opinion-price--${kind}"><span class="ai-opinion-price__label">${escapeHtml(label)}</span><span class="ai-opinion-price__value">${escapeHtml(String(val))}</span></div>`
      )
      .join("");
    // 손익비는 가격이 아니라 가격들의 관계라서 같은 크기 블록으로 나열하면 오히려 눈이
    // 분산된다. 그리드 아래 한 줄 캡션으로 내려 "위험 1 : 기대수익 N"으로 풀어 쓴다.
    const rrLine =
      rrVal != null
        ? `<p class="ai-opinion-rr">손절까지의 위험 <b>1</b> 대비 1차 목표까지의 기대수익 <b>${escapeHtml(String(rrVal))}</b></p>`
        : "";
    const scenarios = Array.isArray(o.scenarios) && o.scenarios.length ? o.scenarios : [];
    // 2026-09-03: A/B/C 확률을 숫자 세 개로만 흩어 놓으면 어느 쪽에 무게가 실렸는지 한눈에
    // 안 들어온다. 카드 위에 100% 스택 막대 하나로 먼저 보여주고, 상세는 아래 카드가 맡는다.
    const scenarioBar = renderScenarioProbBar(scenarios);
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
      `<div class="ai-opinion-prices">${priceRows}</div>${rrLine}` +
      `${comment}` +
      `</div>` +
      `<div class="ai-opinion-col ai-opinion-col--right">${scenarioBar}${scenarioHtml}</div>` +
      `</div>`
    );
  }

  function compute52wHighLowFromChart(chartData) {
    if (!chartData || !Array.isArray(chartData.candles) || !chartData.candles.length) return null;
    const recent = chartData.candles.slice(-365);
    let hi = -Infinity;
    let lo = Infinity;
    for (const c of recent) {
      const h = toNum(c && c.high);
      const l = toNum(c && c.low);
      if (h != null && h > hi) hi = h;
      if (l != null && l < lo) lo = l;
    }
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
    return { high52w: hi, low52w: lo };
  }

  /**
   * 2026-09-03 신설: "시장 대비 위치" 카드.
   * 서버(api/analyze.js)가 전종목 지표 캐시에서 **코드로 직접 집계**한 백분위만 그린다 —
   * AI가 만든 문장이 아니라 실측 순위라서, 이 카드에는 할루시네이션이 끼어들 여지가 없다.
   * marketPosition이 없으면(해외·암호화폐, 캐시 미수록 종목) 카드 자체를 만들지 않는다.
   */
  /**
   * 2026-09-03 신설 → 같은 날 사용자 피드백("제일 번잡스럽다")으로 타일형 재설계.
   * 지표 8개를 한 줄씩 나열하지 않고 밸류에이션 / 주가 성과 / 규모·수급 3묶음으로 나눠,
   * 각 지표를 "값 + 위치 눈금(0=비교군 최소, 100=최대)" 타일 하나로 압축한다.
   * 숫자는 서버가 전종목 지표 캐시에서 직접 집계한 실측 순위이므로 추정이 섞이지 않는다.
   */
  function renderMarketPosition(mp) {
    if (!mp || !Array.isArray(mp.items) || !mp.items.length) return "";
    const groups = Array.isArray(mp.groups) && mp.groups.length ? mp.groups : [{ id: null, title: "", caption: "" }];

    const tile = (it) => {
      const pos = Math.max(1, Math.min(99, Number(it.barPct) || 50));
      const tone = String(it.tone || "mid").replace(/[^a-z]/g, "") || "mid";
      return `<div class="mpos-tile mpos-tile--${tone}">
        <div class="mpos-tile__top"><span class="mpos-tile__name">${escapeHtml(it.label)}</span><span class="mpos-tile__rank">${escapeHtml(it.rankText)}</span></div>
        <div class="mpos-tile__value">${escapeHtml(it.valueText)}</div>
        <div class="mpos-tile__scale" role="img" aria-label="${escapeHtml(it.label)} ${escapeHtml(it.rankText)}">
          <span class="mpos-tile__mid"></span>
          <span class="mpos-tile__dot" style="left:${pos}%"></span>
        </div>
        <div class="mpos-tile__foot"><span>종목 중앙값 ${escapeHtml(it.medianText)}</span></div>
      </div>`;
    };

    const sections = groups
      .map((g) => {
        const list = mp.items.filter((it) => (g.id ? it.group === g.id : true));
        if (!list.length) return "";
        const cap = g.caption ? `<span class="mpos-group__cap">${escapeHtml(g.caption)}</span>` : "";
        return `<section class="mpos-group">
          <h4 class="mpos-group__title">${escapeHtml(g.title || "")}${cap}</h4>
          <div class="mpos-group__tiles">${list.map(tile).join("")}</div>
        </section>`;
      })
      .join("");

    const head = `${escapeHtml(mp.peerLabel || "시장 전체")} ${Number(mp.peerCount || 0).toLocaleString("ko-KR")}개 종목 중 위치`;
    const asOf = mp.asOfDate ? `<span class="mpos__asof">${escapeHtml(mp.asOfDate)} 종가</span>` : "";
    const headline = mp.headline ? `<p class="mpos__headline">${escapeHtml(mp.headline)}</p>` : "";
    return `<div class="mpos">
      <div class="mpos__head"><span class="mpos__peer">${head}</span>${asOf}</div>
      ${headline}
      ${sections}
      <p class="mpos__note">눈금은 비교군 안에서의 위치다. 왼쪽이 가장 작고 오른쪽이 가장 크다.<br>종목 중앙값은 비교군을 <b>한 종목당 한 표</b>로 세어 정가운데에 오는 값이다. 뉴스에 나오는 <b>코스피 PBR(지수 PBR)</b>은 시가총액으로 가중한 값이라 대형주 영향이 커서 이 숫자보다 훨씬 높게 나온다 — 서로 다른 지표다.</p>
    </div>`;
  }

  /* ───────────────── 실적 추이 (2026-09-03 신설, DART 원본 공시) ─────────────────
   * 그동안 분기·연간 실적은 AI가 web_search로 "추측"하던 유일한 구간이었다
   * (검증 불가·할루시네이션 위험 1순위). 이제 서버(lib/dart-financials.js)가 DART
   * 전자공시 단일회사 주요계정에서 직접 파싱한 숫자만 그린다 — 값이 없으면
   * 채우지 않고 그 기간·그 항목을 통째로 생략한다.
   */

  /** 억원 단위 정수를 한국식 "N조 N,NNN억원"으로. 소수점은 붙이지 않는다(표기 규칙). */
  function finFmtEok(eok) {
    if (eok == null || !Number.isFinite(eok)) return "";
    const neg = eok < 0;
    const abs = Math.abs(Math.round(eok));
    let text;
    if (abs >= 10000) {
      const jo = Math.floor(abs / 10000);
      const rest = abs % 10000;
      text = rest > 0 ? `${jo.toLocaleString("ko-KR")}조 ${rest.toLocaleString("ko-KR")}억원` : `${jo.toLocaleString("ko-KR")}조원`;
    } else {
      text = `${abs.toLocaleString("ko-KR")}억원`;
    }
    return neg ? `-${text}` : text;
  }

  const FIN_METRICS = [
    { key: "revenue", label: "매출액" },
    { key: "operatingProfit", label: "영업이익" },
    { key: "netProfit", label: "당기순이익" },
  ];

  function renderFinancials(fin) {
    if (!fin) return "";
    const annual = Array.isArray(fin.annual) ? fin.annual : [];
    const q = fin.quarter || null;
    if (!annual.length && !q) return "";

    // 최근 분기 — 전년 동기 대비. 한국 관습대로 증가=빨강, 감소=파랑.
    let quarterHtml = "";
    if (q) {
      const tiles = FIN_METRICS.map((m) => {
        const cur = q.current ? q.current[m.key] : null;
        if (cur == null) return "";
        const yoy = q.yoy ? q.yoy[m.key] : null;
        const loss = cur < 0;
        let badge = "";
        if (yoy != null) {
          const up = yoy > 0;
          badge = `<span class="fin-yoy fin-yoy--${up ? "up" : yoy < 0 ? "down" : "flat"}">${up ? "+" : ""}${yoy}%</span>`;
        } else if (loss) {
          badge = `<span class="fin-yoy fin-yoy--loss">적자</span>`;
        }
        const prev = q.previous ? q.previous[m.key] : null;
        const prevText = prev != null ? `<span class="fin-q__prev">전년 ${finFmtEok(prev)}</span>` : "";
        return `<div class="fin-q__tile${loss ? " fin-q__tile--loss" : ""}">
          <span class="fin-q__name">${escapeHtml(m.label)}</span>
          <span class="fin-q__val">${escapeHtml(finFmtEok(cur))}</span>
          <span class="fin-q__meta">${badge}${prevText}</span>
        </div>`;
      }).join("");
      if (tiles) {
        quarterHtml = `<section class="fin-group">
          <h4 class="fin-group__title">최근 실적 <span class="fin-group__cap">${escapeHtml(q.label)} · ${escapeHtml(q.prevLabel)} 대비</span></h4>
          <div class="fin-q__grid">${tiles}</div>
        </section>`;
      }
    }

    // 연간 3개년 — 항목별 가로 막대. 스케일은 항목 안에서만 정규화한다
    // (매출과 영업이익을 같은 자로 재면 이익 막대가 항상 안 보인다).
    let annualHtml = "";
    if (annual.length >= 2) {
      const rows = FIN_METRICS.map((m) => {
        const vals = annual.map((p) => (p[m.key] == null ? null : p[m.key]));
        if (vals.every((v) => v == null)) return "";
        const max = Math.max(...vals.filter((v) => v != null).map((v) => Math.abs(v)), 1);
        const bars = annual
          .map((p, i) => {
            const v = vals[i];
            if (v == null) {
              return `<div class="fin-a__bar"><span class="fin-a__yr">${escapeHtml(p.label)}</span><span class="fin-a__track"></span><span class="fin-a__num fin-a__num--none">—</span></div>`;
            }
            const w = Math.max(2, Math.round((Math.abs(v) / max) * 100));
            const neg = v < 0;
            return `<div class="fin-a__bar"><span class="fin-a__yr">${escapeHtml(p.label)}</span><span class="fin-a__track"><i class="fin-a__fill${neg ? " fin-a__fill--neg" : ""}" style="width:${w}%"></i></span><span class="fin-a__num${neg ? " fin-a__num--neg" : ""}">${escapeHtml(finFmtEok(v))}</span></div>`;
          })
          .join("");
        return `<div class="fin-a__row"><span class="fin-a__name">${escapeHtml(m.label)}</span><div class="fin-a__bars">${bars}</div></div>`;
      }).join("");
      if (rows) {
        annualHtml = `<section class="fin-group">
          <h4 class="fin-group__title">연간 추이 <span class="fin-group__cap">${escapeHtml(annual[0].label)}~${escapeHtml(annual[annual.length - 1].label)}년</span></h4>
          <div class="fin-a">${rows}</div>
        </section>`;
      }
    }

    if (!quarterHtml && !annualHtml) return "";
    const basis = fin.fsLabel ? `${fin.fsLabel} 기준` : "";
    const head = [basis, "단위 억원"].filter(Boolean).join(" · ");
    return `<div class="fin">
      <div class="fin__head"><span class="fin__basis">${escapeHtml(head)}</span><span class="fin__src">DART 전자공시</span></div>
      ${quarterHtml}
      ${annualHtml}
      <p class="fin__note">금융감독원 전자공시(DART)에 실제 제출된 보고서의 숫자다. 공시되지 않은 기간·항목은 추정하지 않고 비워 둔다.</p>
    </div>`;
  }

  function renderAnalysis(data, chartData, chartPeriod, archive) {
    if (!panel) return;
    disposeAiChart();
    if (data && chartData && (data.high52w == null || data.low52w == null)) {
      const wl = compute52wHighLowFromChart(chartData);
      if (wl) {
        if (data.high52w == null) data.high52w = wl.high52w;
        if (data.low52w == null) data.low52w = wl.low52w;
      }
    }
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

    // 2026-08-26 UI 리디자인: 카드1(한눈에 요약)을 grid 기반 3분할(좌 신호카드 /
    // 중앙 본문 / 우 2x2 지표 필) + 하단 종합점수 풋터로 재구성. buildScoreCardParts가
    // pillsHtml(grid 안)과 footerHtml(카드 전체 폭, grid 밖)을 분리해서 반환한다.
    const signalCls = signalBadgeClass(signal);
    const scoreParts = buildScoreCardParts(analysis.scoreCard);

    // 2026-09-03: "시장 대비 위치" 카드가 국내 종목에만 붙기 때문에 카드 번호를 하드코딩할
    // 수 없게 됐다(해외·암호화폐는 7장, 국내는 8장). 배열로 만들고 번호는 순서대로 매긴다.
    const marketPositionHtml = renderMarketPosition(data.marketPosition);
    const financialsHtml = renderFinancials(data.financials);
    const cardDefs = [
      {
        cls: "ai-card--summary",
        title: "한눈에 요약",
        body: `<div class="ai-card__body"><div class="sum2-grid"><div class="sum2-left sum2-left--${signalCls}"><span class="sum2-signal sum2-signal--${signalCls}">${escapeHtml(signal)}</span><div class="sum2-prob"><span class="sum2-prob__label">상승 확률</span><span class="sum2-prob__value">${escapeHtml(probText)}</span></div><p class="sum2-prob__note">강세(A) 시나리오 실현 확률 기준</p></div><p class="sum2-desc">${escapeHtml(sanitizeOneLineText(summary.description || ""))}</p>${scoreParts.pillsHtml}</div>${scoreParts.footerHtml}</div>`,
      },
      marketPositionHtml
        ? { cls: "ai-card--mpos", title: "시장 대비 위치", body: `<div class="ai-card__body">${marketPositionHtml}</div>` }
        : null,
      financialsHtml
        ? { cls: "ai-card--fin", title: "실적 추이", body: `<div class="ai-card__body">${financialsHtml}</div>` }
        : null,
      {
        cls: "ai-card--half",
        title: "왜 지금 이 가격인가",
        body: `<div class="ai-card__body">${formatProseText(analysis.story, "분석 내용이 없습니다.")}</div>`,
      },
      {
        cls: "ai-card--half",
        title: "수급 분석",
        body: `<div class="ai-card__body">${renderSupplyFlowFact(analysis.supplyFlow)}${formatProseText(analysis.supply, "수급 정보가 없습니다.")}</div>`,
      },
      { cls: "ai-card--events", title: "다가오는 이벤트", body: renderEvents(analysis.events) },
      {
        cls: "ai-card--materials",
        title: "재료 분석",
        body: `<div class="ai-card__body">${renderMaterials(analysis.materials)}</div>`,
      },
      {
        cls: "ai-card--chart",
        title: "차트 흐름 분석",
        body: `<div class="ai-card__body">${renderChartSection(data.stockCode, data.stockName, analysis.chart, data.assetType, !!chartData, renderTechSnapshot(data.currentPrice, data.indicators, data.assetType))}</div>`,
      },
      {
        cls: "ai-card--opinion",
        title: "AI 주관적 판단",
        body: `<div class="ai-card__body">${renderOpinion(analysis.opinion, data.currentPrice, data.assetType)}</div>`,
      },
    ].filter(Boolean);
    const cardsHtml = `<div class="ai-analysis-cards">${cardDefs
      .map(
        (c, i) =>
          `<article class="ai-card ${c.cls}"><h3 class="ai-card__title"><span class="ai-card__num">${i + 1}</span>${escapeHtml(c.title)}</h3>${c.body}</article>`
      )
      .join("")}</div>`;

    panel.hidden = false;
    panel.innerHTML =
      errBanner +
      renderArchiveBanner(archive) +
      renderStockHeader(data) +
      cardsHtml +
      `<p class="ai-disclaimer"><strong>투자 유의사항.</strong> 본 분석은 AI가 공개된 시세·뉴스 데이터를 바탕으로 생성한 참고 자료이며 투자 권유가 아닙니다. 진입가·목표가·손절가를 포함한 모든 수치는 확정적 예측이 아니므로, 실제 투자 판단과 그 결과에 대한 책임은 투자자 본인에게 있습니다.</p>`;

    if (chartData) {
      wireAiChart(data.stockCode, chartData, chartPeriod || "D", data.assetType);
    } else {
      refreshTradingViewCharts();
    }
  }

  /* ───────────── 리포트 저장 · 사후 추적 (2026-09-03 신설, 로드맵 E) ─────────────
   * 분석이 끝나면 요약·가격·재료를 서버에 남긴다. 목적은 두 가지 —
   * ①"지난번에 뭘 봤더라"로 다시 들어올 이유를 만든다 ②그때 판단이 맞았는지를
   * 나중에 숫자로 보여준다. 수익률은 AI가 회고하는 게 아니라 저장된 시점 가격과
   * 현재 종가로 **코드가** 계산한다(서버에서 전종목 캐시로 처리 — 신규 API 호출 0).
   */

  async function tmAuthHeader() {
    const token = window.TMAuth ? await window.TMAuth.getAccessToken().catch(() => "") : "";
    return token ? { Authorization: `Bearer ${token}` } : null;
  }

  /** 저장은 부가 기능이다 — 실패해도 분석 화면에 아무 영향을 주지 않는다(조용히 넘어감). */
  async function saveReport(data) {
    try {
      const auth = await tmAuthHeader();
      if (!auth || !data || !data.analysis) return;
      const res = await fetch("/api/analyze?feature=reports", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({
          market: data.market || "KR",
          stockCode: data.stockCode,
          stockName: data.stockName,
          currency: data.currency,
          currentPrice: data.currentPrice,
          analysis: data.analysis,
          // 2026-09-03: 원문을 함께 저장한다. 이게 없으면 목록에서 눌러도 그때 리포트를
          // 다시 못 읽고 새 분석이 돌아가서(무료 3회 한도까지 소모) 재방문 이유가 안 된다.
          report: data,
        }),
        cache: "no-store",
      });
      const out = await res.json().catch(() => ({}));
      if (out && out.saved) loadReports();
    } catch (err) {
      console.warn("[리포트] 저장 건너뜀", err && err.message);
    }
  }

  /** 저장된 리포트를 AI 호출 없이 그대로 다시 그린다.
   *  차트는 저장하지 않으므로(용량) 현재 차트가 대신 붙는다 — 배너로 그 점을 밝힌다. */
  async function openSavedReport(id) {
    try {
      const auth = await tmAuthHeader();
      if (!auth || !id) return;
      const res = await fetch(`/api/analyze?feature=reports&id=${encodeURIComponent(id)}`, {
        headers: auth,
        cache: "no-store",
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      if (!out.report) {
        showError(out.reason || "저장된 리포트 원문이 없습니다.");
        return;
      }
      // 캔들 데이터는 용량 때문에 저장하지 않는다. 그렇다고 null로 넘기면 TradingView
      // 폴백이 뜨는데, KRX 심볼은 무료 위젯이 못 그려서 "TradingView에서만 제공되는
      // 심볼입니다" 경고창과 빈 차트가 뜬다(시우님 제보). 그래서 여기서 KIS 차트를
      // 새로 받아 자체 캔들차트로 그린다 — AI 호출이 아니라 시세 조회라 크레딧과 무관하다.
      const saved = out.report || {};
      const savedMarket = String(saved.market || "KR").toUpperCase();
      const savedCode = saved.stockCode || "";
      let chartData = null;
      try {
        if (savedCode) {
          chartData =
            savedMarket === "KR"
              ? await fetchKisChart(savedCode, "D")
              : await fetchNonKrChart(savedCode, savedMarket, "D");
        }
      } catch (chartErr) {
        console.warn("[리포트] 차트 조회 실패 — 차트 없이 표시", chartErr && chartErr.message);
        chartData = null;
      }
      renderAnalysis(saved, chartData, "D", out.archive || null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      console.error("[리포트] 열기 실패", err);
      showError((err && err.message) || "리포트를 불러오지 못했습니다.");
    }
  }

  /** 보관 리포트 상단 배너 — "언제 쓴 글인지"와 "그 뒤 주가가 어떻게 됐는지"를 먼저 밝힌다.
   *  이걸 안 보여주면 오래된 판단을 오늘 판단으로 오해할 수 있다. */
  function renderArchiveBanner(archive) {
    if (!archive) return "";
    const d = new Date(archive.createdAt);
    const date = Number.isNaN(d.getTime())
      ? ""
      : `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
    const cur = String(archive.currency || "KRW");
    const fmt = (v) =>
      v == null || !Number.isFinite(Number(v))
        ? ""
        : cur === "KRW"
          ? `${Math.round(Number(v)).toLocaleString("ko-KR")}원`
          : `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    let since = "";
    if (archive.tracked && archive.tracked.returnPct != null) {
      const v = archive.tracked.returnPct;
      const cls = v > 0 ? "up" : v < 0 ? "down" : "flat";
      since = `<span class="ai-archive__since">그 이후 <b class="ai-archive__ret ai-archive__ret--${cls}">${v > 0 ? "+" : ""}${v}%</b>
        <span class="ai-archive__prices">${escapeHtml(fmt(archive.priceAtReport))} → ${escapeHtml(fmt(archive.tracked.price))}</span>
        <span class="ai-archive__asof">${escapeHtml(archive.tracked.asOfDate || "")} 종가 기준</span></span>`;
    }
    return `<div class="ai-archive">
      <div class="ai-archive__row">
        <span class="ai-archive__tag">보관 리포트</span>
        <span class="ai-archive__date">${escapeHtml(date)}에 작성</span>
        ${since}
      </div>
      <p class="ai-archive__note">작성 당시 내용을 그대로 보여줍니다. 차트만 현재 시세입니다. 지금 시점으로 다시 보려면
        <button type="button" class="ai-archive__rerun" data-query="${escapeHtml(archive.stockName || "")}">새로 분석</button>하세요.</p>
    </div>`;
  }

  function reportReturnBadge(r) {
    // 값이 없으면 0%로 속이지 않고 "추적 대기"로 둔다(국내 종목만 캐시에 있다).
    if (r.trackedReturnPct == null) return `<span class="airp-item__pending">추적 대기</span>`;
    const v = r.trackedReturnPct;
    const cls = v > 0 ? "up" : v < 0 ? "down" : "flat";
    return `<span class="airp-item__ret airp-item__ret--${cls}">${v > 0 ? "+" : ""}${v}%</span>`;
  }

  function renderReports(reports) {
    const section = document.getElementById("ai-reports");
    const list = document.getElementById("ai-reports-list");
    if (!section || !list) return;
    if (!Array.isArray(reports) || !reports.length) {
      section.hidden = true;
      list.innerHTML = "";
      return;
    }
    const fmtDate = (iso) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
    };
    const fmtPrice = (v, cur) => {
      if (v == null || !Number.isFinite(Number(v))) return "";
      const n = Number(v);
      if (String(cur || "KRW") === "KRW") return `${Math.round(n).toLocaleString("ko-KR")}원`;
      return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    };

    list.innerHTML = reports
      .map((r) => {
        const sig = escapeHtml(r.signal || "");
        const sigCls = signalBadgeClass(r.signal || "");
        const priceLine =
          r.trackedPrice != null
            ? `${escapeHtml(fmtPrice(r.priceAtReport, r.currency))} → ${escapeHtml(fmtPrice(r.trackedPrice, r.currency))}`
            : escapeHtml(fmtPrice(r.priceAtReport, r.currency));
        const asOf = r.trackedAsOf ? `<span class="airp-item__asof">${escapeHtml(r.trackedAsOf)} 종가 기준</span>` : "";
        const mats = Array.isArray(r.materials)
          ? r.materials
              .filter((m) => m && m.name)
              .slice(0, 3)
              .map((m) => `<span class="airp-item__mat">${escapeHtml(m.name)}</span>`)
              .join("")
          : "";
        return `<article class="airp-item">
          <div class="airp-item__top">
            <button type="button" class="airp-item__name" data-open="${escapeHtml(r.id || "")}">${escapeHtml(r.stockName || "")}</button>
            ${sig ? `<span class="airp-item__sig airp-item__sig--${sigCls}">${sig}</span>` : ""}
            <span class="airp-item__date">${escapeHtml(fmtDate(r.createdAt))}</span>
            ${reportReturnBadge(r)}
          </div>
          <div class="airp-item__price">${priceLine}${asOf}</div>
          ${mats ? `<div class="airp-item__mats">${mats}</div>` : ""}
          <div class="airp-item__acts">
            <button type="button" class="airp-item__act" data-open="${escapeHtml(r.id || "")}">리포트 열기</button>
            <button type="button" class="airp-item__act airp-item__act--ghost" data-query="${escapeHtml(r.stockName || "")}">새로 분석</button>
          </div>
        </article>`;
      })
      .join("");
    section.hidden = false;

    // 기본 동작은 "저장된 리포트 열기"다 — 크레딧을 쓰지 않고 즉시 열린다.
    // 다시 돌리고 싶을 때만 '새로 분석'을 누르게 분리했다.
    list.querySelectorAll("[data-open]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-open") || "";
        if (id) void openSavedReport(id);
      });
    });
    list.querySelectorAll("[data-query]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const q = btn.getAttribute("data-query") || "";
        if (!q) return;
        if (input) input.value = q;
        runAnalysis(q);
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }

  async function loadReports() {
    try {
      const auth = await tmAuthHeader();
      if (!auth) return;
      const res = await fetch("/api/analyze?feature=reports", { headers: auth, cache: "no-store" });
      if (!res.ok) return;
      const out = await res.json().catch(() => ({}));
      renderReports(out && out.reports);
    } catch (err) {
      console.warn("[리포트] 목록 실패", err && err.message);
    }
  }

  async function fetchAnalysis(code, name, indicators, market) {
    console.log("[AI분석] fetch 시작", { code, name, indicators, market });
    const ind = indicators && typeof indicators === "object" ? indicators : {};
    // 2026-07-11: 탭을 오래 열어두면 Supabase access_token이 만료돼서, 로그인 게이트를
    // 통과했던(TM_AUTH_STATE가 최초 1회 캐시된) 상태에서도 실제로는 만료된 토큰을 보내
    // 서버가 401을 주는 경우가 있었다(로그인/Pro 상태인데 "로그인이 필요합니다" 오류).
    // 요청 직전에 세션을 한 번 새로고침해서 최신 토큰을 쓰도록 한다.
    if (window.TMAuth && typeof window.TMAuth.refreshState === "function") {
      await window.TMAuth.refreshState().catch(() => {});
    }
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

    if (res.status === 401) {
      // 세션 새로고침 후에도 서버가 로그인 안 된 것으로 판단했다면 진짜로 세션이 끊긴 것 —
      // 단순 에러 텍스트만 보여주지 않고 원래 로그인 게이트(팝업)를 다시 띄워 재로그인을 유도한다.
      if (typeof window.tmOpenAnalysisGate === "function") window.tmOpenAnalysisGate();
      throw new Error("로그인 세션이 만료되었습니다. 다시 로그인해 주세요.");
    }

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
      // 저장은 화면 렌더를 막지 않도록 기다리지 않는다(실패해도 분석은 그대로 보인다).
      void saveReport(data);
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

  /** 비로그인 방문자용 랜딩. 모달로 막기만 하면 제품을 하나도 못 보고 이탈하므로,
   *  무엇을 받게 되는지(카드 7종 구성·데이터 출처)를 먼저 보여주고 가입을 권한다. */
  function showAnalysisLanding() {
    const landing = document.getElementById("ai-landing");
    if (!landing) return false;
    const gateEl = document.getElementById("ai-access-gate");
    if (gateEl) {
      gateEl.hidden = true;
      gateEl.remove();
    }
    document.body.classList.remove("ai-access-gate-open");
    landing.hidden = false;
    const section = document.getElementById("ai-stock-analysis");
    if (section) section.hidden = true;
    return true;
  }

  function hideAnalysisLanding() {
    const landing = document.getElementById("ai-landing");
    if (landing) landing.hidden = true;
    const section = document.getElementById("ai-stock-analysis");
    if (section) section.hidden = false;
  }

  function activateAnalysisPage() {
    const gateEl = document.getElementById("ai-access-gate");
    if (gateEl) {
      gateEl.hidden = true;
      gateEl.remove();
      document.body.classList.remove("ai-access-gate-open");
    }
    hideAnalysisLanding();
    bindAnalyzeUi();
  }

  /** 2026-07-11: site-shell.js(게이트 로직이 실제로 들어있는 파일)가 아직 로드/실행되지
   * 않았을 때, window.tmHasAnalysisAccess가 없다는 이유로 "허용"으로 새는(fail-open) 버그가
   * 있었다 — 비로그인 상태에서도 검색창이 그냥 보이는 문제의 원인. 최대 2초(100ms x 20회)
   * 정도 재시도하며 site-shell.js 로딩을 기다리고, 그래도 없으면 반드시 차단(fail-closed)한다. */
  let analysisGateFnWaitCount = 0;
  const ANALYSIS_GATE_FN_MAX_WAIT = 20;

  /** site-shell.js 자체가 끝내 로드되지 않아 게이트 UI(window.tmOpenAnalysisGate)조차 띄울
   * 수 없는 최악의 경우를 대비한 최소한의 자체 차단 — 검색 UI가 그냥 노출되는 일은 없게 한다. */
  function fallbackBlockAnalysisUi() {
    const searchInput = document.getElementById("ai-stock-query");
    const analyzeBtn = document.getElementById("analyzeBtn");
    if (searchInput) searchInput.disabled = true;
    if (analyzeBtn) analyzeBtn.disabled = true;
    const card = document.querySelector(".ai-search-card, main");
    if (card && !document.getElementById("ai-fallback-block-msg")) {
      const msg = document.createElement("p");
      msg.id = "ai-fallback-block-msg";
      msg.style.cssText = "margin-top:12px;padding:12px;border-radius:8px;background:#fee2e2;color:#991b1b;font-size:13px;";
      msg.textContent = "페이지를 불러오는 중 문제가 발생했습니다. 새로고침해 주세요.";
      card.appendChild(msg);
    }
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

    if (typeof window.tmHasAnalysisAccess !== "function" && analysisGateFnWaitCount < ANALYSIS_GATE_FN_MAX_WAIT) {
      analysisGateFnWaitCount++;
      setTimeout(init, 100);
      return;
    }

    // fail-closed: window.tmHasAnalysisAccess가 끝내 없으면(스크립트 로드 실패 등) "허용"이
    // 아니라 "차단"으로 처리한다 — 절대 로그인 게이트를 건너뛰게 하지 않는다.
    const allowed = typeof window.tmHasAnalysisAccess === "function" ? window.tmHasAnalysisAccess() : false;
    if (!allowed) {
      // 비로그인(정식 서비스 준비중이 아닌 경우)은 모달 대신 소개 랜딩을 보여준다
      if (!state.isLoggedIn && !state.setupPending && showAnalysisLanding()) {
        document.addEventListener("tm-auth-ready", init, { once: true });
        return;
      }
      if (typeof window.tmOpenAnalysisGate === "function") {
        window.tmOpenAnalysisGate();
      } else {
        console.error("[AI분석] tmOpenAnalysisGate 없음 — site-shell.js 로드 실패로 추정, 자체 차단");
        fallbackBlockAnalysisUi();
      }
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

    // 보관 리포트 배너의 '새로 분석' 버튼 — 패널은 매번 innerHTML로 갈리므로
    // 개별 리스너 대신 패널에 위임 핸들러를 한 번만 건다.
    panel.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(".ai-archive__rerun") : null;
      if (!btn) return;
      const q = btn.getAttribute("data-query") || "";
      if (!q) return;
      if (input) input.value = q;
      runAnalysis(q);
    });

    // 2026-09-03(로드맵 E): 로그인 사용자면 지난 리포트 목록을 불러온다.
    // 저장분이 없으면 renderReports가 섹션을 숨긴 채로 두므로 빈 껍데기가 보이지 않는다.
    void loadReports();

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
        // 2026-08-26: 8개로 하드컷하고 '외 N개 더 있습니다'로 막던 걸 스크롤 가능한 목록으로 전환
        // (사용자 제보: 선택하고 싶어도 목록 밖으로 밀린 종목은 고를 수가 없었음).
        renderAutocomplete(matches.slice(0, AC_DISPLAY_LIMIT), matches.length);
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
