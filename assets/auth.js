/**
 * TotalMoney AI — 공용 인증/구독 상태 모듈
 * 모든 페이지의 <head>에 아래 순서로 로드됩니다.
 *   1) https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2  (UMD, window.supabase 노출)
 *   2) ./assets/auth-config.js  (window.TM_AUTH_CONFIG)
 *   3) ./assets/auth.js         (이 파일)
 *
 * 제공하는 전역:
 *   window.TMAuth        — signUp/signIn/signOut/getSession 등 API
 *   window.TM_AUTH_STATE  — 동기 접근용 캐시 { loaded, isLoggedIn, email, plan, hasProAccess }
 *   "tm-auth-ready" 커스텀 이벤트 — TM_AUTH_STATE 최초 계산/갱신 시 document에서 발생
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
    status: "active",
    hasProAccess: false,
    setupPending: SETUP_PENDING,
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
      auth: { persistSession: true, autoRefreshToken: true },
    });
    return client;
  }

  async function fetchSubscription(userId, accessToken) {
    try {
      const url = `${cfg.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=plan,status,current_period_end`;
      const res = await fetch(url, {
        headers: {
          apikey: cfg.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
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
      });
      fireReady();
      return window.TM_AUTH_STATE;
    }
    const sub = await fetchSubscription(session.user.id, session.access_token);
    const active = sub.status === "active" && (sub.plan === "pro" || sub.plan === "premium");
    Object.assign(window.TM_AUTH_STATE, {
      loaded: true,
      isLoggedIn: true,
      email: session.user.email || "",
      userId: session.user.id,
      plan: sub.plan || "free",
      status: sub.status || "active",
      hasProAccess: active,
    });
    fireReady();
    return window.TM_AUTH_STATE;
  }

  async function signUp({ email, password, displayName }) {
    const c = getClient();
    if (!c) throw new Error("SETUP_PENDING");
    const { data, error } = await c.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName || "" } },
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

  async function getAccessToken() {
    const c = getClient();
    if (!c) return "";
    const { data } = await c.auth.getSession();
    return (data && data.session && data.session.access_token) || "";
  }

  function onAuthChange(cb) {
    const c = getClient();
    if (!c) return;
    c.auth.onAuthStateChange(() => {
      refreshState().then(cb);
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
    document.querySelectorAll(".home-nav__menu").forEach((menu) => {
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
  }

  document.addEventListener("tm-auth-ready", injectAuthNav);
  document.addEventListener("DOMContentLoaded", () => {
    injectAuthNav(); // 로딩 전 자리표시(로그인 링크)라도 우선 표시
  });

  window.TMAuth = {
    getClient,
    refreshState,
    signUp,
    signIn,
    signOut,
    getAccessToken,
    onAuthChange,
    isSetupPending: () => SETUP_PENDING,
  };

  // 최초 1회 세션 확인
  refreshState();
})();
