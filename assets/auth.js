/**
 * TotalMoney AI — 공용 인증/구독 상태 모듈
 * 모든 페이지의 <head>에 아래 순서로 로드됩니다.
 *   1) https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2  (UMD, window.supabase 노출)
 *   2) ./assets/auth-config.js  (window.TM_AUTH_CONFIG)
 *   3) ./assets/auth.js         (이 파일)
 *
 * 제공하는 전역:
 *   window.TMAuth        — signUp/signIn/signOut/getSession 등 API
 *   window.TM_AUTH_STATE  — 동기 접근용 캐시 { loaded, isLoggedIn, email, plan, hasProAccess, hasPremiumAccess }
 *
 * 2026-09-02: Premium이 Pro와 코드상 완전히 동일해서(hasProAccess 하나로만 갈림) 2배 가격을
 * 정당화할 근거가 없다는 감사 지적 → 등급을 구분하는 hasPremiumAccess를 추가했다.
 * 게이팅을 새로 만들 때는 hasProAccess(Pro 이상)와 hasPremiumAccess(Premium만)를 구분해서 쓸 것.
 *   "tm-auth-ready" 커스텀 이벤트 — TM_AUTH_STATE 최초 계산/갱신 시 document에서 발생
 *
 * 2026-09-03: 회원가입/로그인 강화.
 *   - 소셜 로그인 3종(구글·카카오·네이버). 구글/카카오는 Supabase 기본 provider,
 *     네이버는 Supabase 미지원이라 Supabase Edge Function(naver-auth)을 경유한다.
 *     (Vercel Hobby 서버리스 함수가 12/12로 꽉 차서 Vercel에 새 API를 못 만든다)
 *   - 비밀번호 정책: 8자 이상 + 영문/숫자 조합. validatePassword()가 단일 기준점이며
 *     Supabase 대시보드(Authentication → Policies)의 서버 측 정책과 값을 맞춰둬야 한다.
 *   - 비밀번호 재설정(resetPasswordForEmail → reset-password.html)
 *   - 약관/개인정보/만14세 동의를 user_metadata에 기록. 동의 이력이 없는 계정은
 *     consent.html 로 유도한다(소셜 최초 가입자 대응).
 */
(function () {
  "use strict";

  const cfg = window.TM_AUTH_CONFIG || {};
  const SETUP_PENDING = !!cfg.SETUP_PENDING;

  window.TM_AUTH_STATE = {
    loaded: false,
    isLoggedIn: false,
    email: "",
    userId: "",
    plan: "free",
    hasPremiumAccess: false,
    status: "active",
    hasProAccess: false,
    setupPending: SETUP_PENDING,
    provider: "",
    hasConsent: true,
    marketingAgreed: false,
  };

  function fireReady() {
    document.dispatchEvent(new CustomEvent("tm-auth-ready", { detail: window.TM_AUTH_STATE }));
  }

  let client = null;
  function getClient() {
    if (client) return client;
    if (SETUP_PENDING) return null;
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      console.warn("[TMAuth] supabase-js 가 로드되지 않았습니다.");
      return null;
    }
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    return client;
  }

  /* ==========================================================================
   * 비밀번호 정책
   * 기준: 8자 이상 + 영문·숫자 조합 (국내 대부분 서비스가 쓰는 수준)
   * ⚠️ Supabase 대시보드 Authentication → Policies 의
   *    "Minimum password length = 8", "Required characters = Letters and digits"
   *    설정과 반드시 값을 맞춰둘 것. 여기(클라이언트)만 고치면 서버는 안 막는다.
   * ========================================================================== */
  const PASSWORD_POLICY = {
    minLength: 8,
    requireLetter: true,
    requireDigit: true,
  };

  /**
   * @returns {{ok:boolean, reason:string, score:number, level:string, checks:object}}
   *   score 0~4, level: "weak" | "fair" | "good" | "strong"
   */
  function validatePassword(pw) {
    const s = String(pw || "");
    const checks = {
      length: s.length >= PASSWORD_POLICY.minLength,
      letter: /[A-Za-z]/.test(s),
      digit: /[0-9]/.test(s),
      long: s.length >= 12,
      special: /[^A-Za-z0-9]/.test(s),
      mixedCase: /[a-z]/.test(s) && /[A-Z]/.test(s),
    };

    let reason = "";
    if (!checks.length) reason = "비밀번호는 " + PASSWORD_POLICY.minLength + "자 이상이어야 합니다.";
    else if (PASSWORD_POLICY.requireLetter && !checks.letter) reason = "영문자를 1자 이상 포함해주세요.";
    else if (PASSWORD_POLICY.requireDigit && !checks.digit) reason = "숫자를 1자 이상 포함해주세요.";

    const ok = !reason;

    // 강도 점수(필수 조건 통과 후 가산점)
    let score = 0;
    if (s.length >= 6) score = 1;
    if (ok) score = 2;
    if (ok && (checks.long || checks.special || checks.mixedCase)) score = 3;
    if (ok && checks.long && (checks.special || checks.mixedCase)) score = 4;
    if (!s) score = 0;

    const level = ["none", "weak", "fair", "good", "strong"][score];
    return { ok, reason, score, level, checks };
  }

  /* ==========================================================================
   * 구독 상태
   * ========================================================================== */
  async function fetchSubscription(userId, accessToken) {
    try {
      const url = cfg.SUPABASE_URL + "/rest/v1/subscriptions?user_id=eq." + userId + "&select=plan,status,current_period_end";
      const res = await fetch(url, {
        headers: {
          apikey: cfg.SUPABASE_ANON_KEY,
          Authorization: "Bearer " + accessToken,
        },
      });
      if (!res.ok) return { plan: "free", status: "active" };
      const rows = await res.json();
      return rows && rows[0] ? rows[0] : { plan: "free", status: "active" };
    } catch (e) {
      console.warn("[TMAuth] subscription 조회 실패", e);
      return { plan: "free", status: "active" };
    }
  }

  async function refreshState() {
    const c = getClient();
    if (!c) {
      window.TM_AUTH_STATE.loaded = true;
      fireReady();
      return window.TM_AUTH_STATE;
    }
    const { data } = await c.auth.getSession();
    const session = data && data.session;
    if (!session) {
      Object.assign(window.TM_AUTH_STATE, {
        loaded: true,
        isLoggedIn: false,
        email: "",
        userId: "",
        plan: "free",
        status: "active",
        hasProAccess: false,
        hasPremiumAccess: false,
        provider: "",
        hasConsent: true,
        marketingAgreed: false,
      });
      fireReady();
      return window.TM_AUTH_STATE;
    }
    const meta = (session.user && session.user.user_metadata) || {};
    const appMeta = (session.user && session.user.app_metadata) || {};
    const sub = await fetchSubscription(session.user.id, session.access_token);
    const active = sub.status === "active" && (sub.plan === "pro" || sub.plan === "premium");
    const premium = sub.status === "active" && sub.plan === "premium";
    Object.assign(window.TM_AUTH_STATE, {
      loaded: true,
      isLoggedIn: true,
      email: session.user.email || "",
      userId: session.user.id,
      plan: sub.plan || "free",
      status: sub.status || "active",
      hasProAccess: active,
      hasPremiumAccess: premium,
      provider: meta.tm_provider || appMeta.provider || "email",
      hasConsent: !!meta.terms_agreed_at,
      marketingAgreed: !!meta.marketing_agreed,
    });
    fireReady();
    return window.TM_AUTH_STATE;
  }

  /* ==========================================================================
   * 이메일 가입 / 로그인
   * ========================================================================== */
  function consentMetadata(consent) {
    const now = new Date().toISOString();
    const c = consent || {};
    return {
      terms_agreed_at: now,
      privacy_agreed_at: now,
      age14_agreed_at: now,
      marketing_agreed: !!c.marketing,
      marketing_agreed_at: c.marketing ? now : null,
      consent_version: cfg.CONSENT_VERSION || "2026-09-03",
    };
  }

  async function signUp({ email, password, displayName, consent }) {
    const c = getClient();
    if (!c) throw new Error("SETUP_PENDING");

    const v = validatePassword(password);
    if (!v.ok) throw new Error(v.reason);

    const { data, error } = await c.auth.signUp({
      email,
      password,
      options: {
        data: Object.assign({ display_name: displayName || "", tm_provider: "email" }, consentMetadata(consent)),
        emailRedirectTo: window.location.origin + "/login.html",
      },
    });
    if (error) throw error;
    return data;
  }

  async function signIn({ email, password }) {
    const c = getClient();
    if (!c) throw new Error("SETUP_PENDING");
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await refreshState();
    return data;
  }

  async function signOut() {
    const c = getClient();
    if (!c) return;
    await c.auth.signOut();
    await refreshState();
  }

  /* ==========================================================================
   * 비밀번호 재설정
   * ========================================================================== */
  async function requestPasswordReset(email) {
    const c = getClient();
    if (!c) throw new Error("SETUP_PENDING");
    const { error } = await c.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + "/reset-password.html",
    });
    if (error) throw error;
    return true;
  }

  async function updatePassword(newPassword) {
    const c = getClient();
    if (!c) throw new Error("SETUP_PENDING");
    const v = validatePassword(newPassword);
    if (!v.ok) throw new Error(v.reason);
    const { error } = await c.auth.updateUser({ password: newPassword });
    if (error) throw error;
    await refreshState();
    return true;
  }

  /**
   * 소셜 최초 가입자처럼 동의 이력이 없는 계정에 동의를 기록한다.
   */
  async function saveConsent(consent) {
    const c = getClient();
    if (!c) throw new Error("SETUP_PENDING");
    const { error } = await c.auth.updateUser({ data: consentMetadata(consent) });
    if (error) throw error;
    await refreshState();
    return true;
  }

  /**
   * 마케팅 수신 동의만 변경한다(마이페이지용). 필수 동의 이력은 건드리지 않는다.
   */
  async function setMarketingConsent(agreed) {
    const c = getClient();
    if (!c) throw new Error("SETUP_PENDING");
    const { error } = await c.auth.updateUser({
      data: {
        marketing_agreed: !!agreed,
        marketing_agreed_at: agreed ? new Date().toISOString() : null,
      },
    });
    if (error) throw error;
    await refreshState();
    return true;
  }

  /* ==========================================================================
   * 소셜 로그인
   * ========================================================================== */
  function safeNext(next) {
    // 오픈 리다이렉트 방지: 같은 사이트의 절대경로만 허용
    if (typeof next !== "string") return "";
    if (!next.startsWith("/") || next.startsWith("//")) return "";
    return next;
  }

  function randomState() {
    const a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  /**
   * 구글·카카오: Supabase 기본 provider (서버 코드 불필요)
   * 네이버: Supabase Edge Function 경유
   */
  async function signInWithProvider(provider, opts) {
    const next = safeNext((opts && opts.next) || "") || "/mypage.html";

    if (provider === "naver") return signInWithNaver({ next: next });

    const c = getClient();
    if (!c) throw new Error("SETUP_PENDING");
    const { data, error } = await c.auth.signInWithOAuth({
      provider: provider, // "google" | "kakao"
      options: {
        redirectTo: window.location.origin + "/auth-callback.html?next=" + encodeURIComponent(next),
      },
    });
    if (error) throw error;
    return data;
  }

  function signInWithNaver(o) {
    if (!cfg.NAVER_CLIENT_ID || !cfg.NAVER_AUTH_ENDPOINT) {
      throw new Error("네이버 로그인은 아직 준비 중입니다.");
    }
    const nonce = randomState();
    try {
      sessionStorage.setItem("tm_naver_state", nonce);
    } catch (e) {
      /* 사파리 프라이빗 모드 등 — state 검증만 생략된다 */
    }
    const state = btoa(JSON.stringify({ n: nonce, next: (o && o.next) || "/mypage.html" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const url =
      "https://nid.naver.com/oauth2.0/authorize?response_type=code" +
      "&client_id=" + encodeURIComponent(cfg.NAVER_CLIENT_ID) +
      "&redirect_uri=" + encodeURIComponent(cfg.NAVER_AUTH_ENDPOINT) +
      "&state=" + encodeURIComponent(state);
    window.location.href = url;
    return { url: url };
  }

  /**
   * 네이버 Edge Function이 돌려준 1회용 토큰으로 세션을 연다.
   * auth-callback.html 에서 호출.
   */
  async function completeNaverLogin(tokenHash, stateRaw) {
    const c = getClient();
    if (!c) throw new Error("SETUP_PENDING");

    let next = "/mypage.html";
    if (stateRaw) {
      try {
        const json = JSON.parse(atob(stateRaw.replace(/-/g, "+").replace(/_/g, "/")));
        let saved = "";
        try {
          saved = sessionStorage.getItem("tm_naver_state") || "";
        } catch (e) {
          /* noop */
        }
        if (saved && json.n && saved !== json.n) throw new Error("STATE_MISMATCH");
        next = safeNext(json.next) || next;
      } catch (e) {
        if (e && e.message === "STATE_MISMATCH") throw new Error("로그인 요청이 변조되었습니다. 다시 시도해주세요.");
      }
    }
    try {
      sessionStorage.removeItem("tm_naver_state");
    } catch (e) {
      /* noop */
    }

    const { error } = await c.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
    if (error) throw error;
    await refreshState();
    return { next: next };
  }

  async function getAccessToken() {
    const c = getClient();
    if (!c) return "";
    const { data } = await c.auth.getSession();
    return (data && data.session && data.session.access_token) || "";
  }

  function onAuthChange(cb) {
    const c = getClient();
    if (!c) return;
    c.auth.onAuthStateChange(function () {
      refreshState().then(cb);
    });
  }

  /* ==========================================================================
   * 소셜 로그인 버튼 렌더러 (login/signup/consent에서 공유)
   * 각 사의 버튼 가이드에 맞춘 색상·심볼을 코드로 그린다(이미지 파일 불필요).
   * ========================================================================== */
  const SOCIAL_ICONS = {
    google:
      '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">' +
      '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>' +
      '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>' +
      '<path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/>' +
      '<path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>' +
      "</svg>",
    kakao:
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="#000000" d="M12 3C6.9 3 2.8 6.24 2.8 10.24c0 2.55 1.68 4.79 4.21 6.07-.19.68-.68 2.47-.78 2.85-.12.48.18.47.37.34.15-.1 2.41-1.63 3.39-2.3.65.1 1.32.15 2.01.15 5.1 0 9.2-3.24 9.2-7.11C21.2 6.24 17.1 3 12 3z"/>' +
      "</svg>",
    naver:
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
      '<path fill="#FFFFFF" d="M14.02 12.63 9.6 6.2H5.5v11.6h4.48v-6.43l4.42 6.43h4.1V6.2h-4.48v6.43z"/>' +
      "</svg>",
  };

  const SOCIAL_META = [
    { id: "google", label: "구글", cls: "tm-social-btn--google" },
    { id: "kakao", label: "카카오", cls: "tm-social-btn--kakao" },
    { id: "naver", label: "네이버", cls: "tm-social-btn--naver" },
  ];

  /**
   * @param {HTMLElement} container
   * @param {{mode, next, beforeClick, onError}} options
   *   beforeClick 이 false 를 반환하면 소셜 로그인을 중단한다(회원가입 페이지의 필수동의 체크용).
   */
  function renderSocialButtons(container, options) {
    if (!container) return;
    const opts = options || {};
    const verb = opts.mode === "signup" ? "로 시작하기" : "로 로그인";
    // SOCIAL_ENABLED 에서 켜둔 것만 노출한다(설정이 없으면 과거 동작대로 전부 노출).
    const flags = cfg.SOCIAL_ENABLED || null;
    const enabled = SOCIAL_META.filter(function (m) {
      if (m.id === "naver" && !cfg.NAVER_CLIENT_ID) return false;
      if (flags && flags[m.id] !== true) return false;
      return true;
    });
    if (!enabled.length) {
      container.innerHTML = "";
      return;
    }

    container.innerHTML =
      '<div class="tm-social-divider"><span>또는</span></div>' +
      '<div class="tm-social-list">' +
      enabled
        .map(function (m) {
          return (
            '<button type="button" class="tm-social-btn ' + m.cls + '" data-provider="' + m.id + '" aria-label="' + m.label + verb + '">' +
            '<span class="tm-social-btn__icon">' + SOCIAL_ICONS[m.id] + "</span>" +
            '<span class="tm-social-btn__label">' + m.label + verb + "</span>" +
            "</button>"
          );
        })
        .join("") +
      "</div>";

    container.querySelectorAll(".tm-social-btn").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        if (SETUP_PENDING) {
          if (opts.onError) opts.onError(new Error("아직 로그인 기능 설정 중입니다. 잠시 후 다시 시도해주세요."));
          return;
        }
        if (typeof opts.beforeClick === "function" && opts.beforeClick() === false) return;
        const provider = btn.getAttribute("data-provider");
        container.querySelectorAll(".tm-social-btn").forEach(function (b) {
          b.disabled = true;
        });
        try {
          await signInWithProvider(provider, { next: opts.next });
        } catch (err) {
          container.querySelectorAll(".tm-social-btn").forEach(function (b) {
            b.disabled = false;
          });
          if (opts.onError) opts.onError(err);
          else console.error(err);
        }
      });
    });
  }

  /* -------------------- 네비게이션 로그인/마이페이지 버튼 주입 -------------------- */
  function buildAuthNavHtml(state) {
    if (!state.loaded) return "";
    if (state.isLoggedIn) {
      return '<a class="home-nav__link home-nav__auth-link" href="./mypage.html"><i class="ti ti-user-circle" aria-hidden="true"></i> 마이페이지</a>';
    }
    return '<a class="home-nav__link home-nav__auth-link" href="./login.html"><i class="ti ti-login" aria-hidden="true"></i> 로그인</a>';
  }

  function injectAuthNav() {
    document.querySelectorAll(".home-nav__menu").forEach(function (menu) {
      let el = menu.querySelector(".home-nav__auth-link");
      const themeBtn = menu.querySelector(".home-nav__theme");
      if (!el) {
        el = document.createElement("a");
        el.className = "home-nav__link home-nav__auth-link";
        if (themeBtn) menu.insertBefore(el, themeBtn);
        else menu.appendChild(el);
      }
      const html = buildAuthNavHtml(window.TM_AUTH_STATE);
      if (html) {
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        const fresh = tmp.firstElementChild;
        el.replaceWith(fresh);
      }
    });
    if (typeof window.tmReorderGnbAnalysisLink === "function") window.tmReorderGnbAnalysisLink();
  }

  document.addEventListener("tm-auth-ready", injectAuthNav);
  document.addEventListener("DOMContentLoaded", function () {
    injectAuthNav(); // 로딩 전 자리표시(로그인 링크)라도 우선 표시
  });

  /* -------------------- 비밀번호 입력 UX(표시토글·강도바) 헬퍼 -------------------- */
  function attachPasswordToggle(input) {
    if (!input || input.dataset.tmToggle === "1") return;
    input.dataset.tmToggle = "1";
    // input 만 감싸는 전용 래퍼를 만든다.
    // (필드 div를 그대로 쓰면 아래에 붙는 강도바·안내문 높이만큼 토글 버튼이 밀린다)
    const wrap = document.createElement("div");
    wrap.className = "tm-auth-pwwrap";
    input.parentElement.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tm-auth-pwtoggle";
    btn.setAttribute("aria-label", "비밀번호 표시");
    btn.innerHTML = '<i class="ti ti-eye" aria-hidden="true"></i>';
    btn.addEventListener("click", function () {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.innerHTML = '<i class="ti ti-eye' + (show ? "-off" : "") + '" aria-hidden="true"></i>';
      btn.setAttribute("aria-label", show ? "비밀번호 숨기기" : "비밀번호 표시");
    });
    wrap.appendChild(btn);
  }

  function attachStrengthMeter(input, meterEl) {
    if (!input || !meterEl) return;
    const LABEL = { none: "", weak: "약함", fair: "보통", good: "양호", strong: "강함" };
    function paint() {
      const v = validatePassword(input.value);
      meterEl.dataset.level = v.level;
      const bar = meterEl.querySelector(".tm-pwmeter__fill");
      const txt = meterEl.querySelector(".tm-pwmeter__text");
      if (bar) bar.style.width = (v.score / 4) * 100 + "%";
      if (txt) txt.textContent = input.value ? v.reason || LABEL[v.level] : "";
      meterEl.classList.toggle("is-error", !!input.value && !v.ok);
    }
    input.addEventListener("input", paint);
    paint();
  }

  window.TMAuth = {
    getClient,
    refreshState,
    signUp,
    signIn,
    signOut,
    getAccessToken,
    onAuthChange,
    isSetupPending: function () {
      return SETUP_PENDING;
    },
    // 2026-09-03 추가분
    PASSWORD_POLICY,
    validatePassword,
    signInWithProvider,
    completeNaverLogin,
    requestPasswordReset,
    updatePassword,
    saveConsent,
    setMarketingConsent,
    renderSocialButtons,
    attachPasswordToggle,
    attachStrengthMeter,
    safeNext,
  };

  // 최초 1회 세션 확인
  refreshState();
})();
