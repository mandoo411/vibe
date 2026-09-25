/**
 * 2026-09-25 홈 섹터 히트맵 — 코스피 / 코스닥 / 미국주식 / 암호화폐
 *
 * - 네모 크기 = 시가총액, 색 = 등락률(국내 관례: 상승 빨강, 하락 파랑)
 * - 섹터: 국내 = WICS(data/kr-sector-map.json, 주 1회 자동 갱신), 미국 = GICS(data/us-sector-map.json),
 *   암호화폐 = 아래 COIN_GROUP(스테이블코인·래핑 토큰은 제외)
 * - 섹터 머리글: 섹터 등락률(시총 가중 평균) + "급등10 평균"(섹터 안에서 가장 많이 오른 10개의 평균)
 * - 실데이터가 없는 칸은 만들지 않는다(지어내지 않음). 배치 계산(squarify)은 이 파일 안에서 직접 한다.
 */
(function () {
  "use strict";

  const TABS = [
    { id: "KOSPI", label: "코스피" },
    { id: "KOSDAQ", label: "코스닥" },
    { id: "US", label: "미국" },
    { id: "CRYPTO", label: "암호화폐" },
  ];
  const REFRESH_MS = { KOSPI: 60000, KOSDAQ: 60000, US: 300000, CRYPTO: 120000 };

  // 암호화폐 분류(시총 상위권 위주). 목록에 없으면 "기타".
  const COIN_GROUP = (() => {
    const g = {
      "비트코인계열": "BTC BCH LTC BSV",
      "스마트컨트랙트": "ETH SOL ADA TRX AVAX SUI DOT NEAR APT TON HBAR ICP ETC ATOM ALGO SEI KAS HYPE CC XDC VET EGLD MNT CRO",
      "결제·프라이버시": "XRP XLM ZEC XMR DASH",
      "거래소 토큰": "BNB LEO OKB GT KCS WBT BGB HT",
      "밈": "DOGE SHIB PEPE TRUMP BONK WIF FLOKI PENGU FARTCOIN SPX",
      "DeFi·인프라": "LINK UNI AAVE ONDO ENA JUP LDO MKR SKY RENDER FET TAO WLD ARB OP POL FIL INJ QNT PENDLE CRV STX IMX GRT JASMY KAIA",
    };
    const m = {};
    Object.keys(g).forEach((k) => g[k].split(/\s+/).forEach((s) => (m[s] = k)));
    return m;
  })();
  const COIN_EXCLUDE = new Set(
    "USDT USDC DAI USDE USD1 FDUSD PYUSD USDS TUSD USDD USDTB BUIDL USYC USDF RLUSD USDG USD0 GHO FRAX LUSD USTC EURC XAUT PAXG WBTC WETH STETH WSTETH WBETH WEETH CBBTC LBTC SOLVBTC BTCB JITOSOL BNSOL METH RETH EZETH RSETH SUSDE SUSDS".split(" ")
  );

  const state = {
    tab: "KOSPI",
    cache: {}, // tab -> { items, sectors, meta, at }
    krMap: null,
    usMap: null,
    timer: null,
    ro: null,
  };

  const $ = (id) => document.getElementById(id);
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  async function getJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }
  async function getDataFile(path) {
    const t = Date.now();
    try {
      return await getJson(`./${path}?t=${Math.floor(t / 3600000)}`);
    } catch (_) {
      return getJson(`/api/repo-data?path=${encodeURIComponent(path)}&t=${t}`);
    }
  }

  /* ───────── 데이터 ───────── */
  async function loadKr(market) {
    if (!state.krMap) state.krMap = await getDataFile("data/kr-sector-map.json");
    const secNames = state.krMap.sectors || {};
    const map = state.krMap.map || {};
    const j = await getJson(`/api/kis-realtime-data?action=heatmap&market=${market}`);
    const items = [];
    for (const r of j.rows || []) {
      const [code, name, capEok, pct] = r;
      let sc = map[code];
      // 우선주는 보통주(끝자리 0) 섹터를 따른다
      if (!sc && /우[A-Z]?$|우\(전환\)$/.test(name)) sc = map[code.slice(0, 5) + "0"];
      if (!sc) continue;
      items.push({ id: code, label: name, name, cap: capEok, pct, sector: secNames[sc] || sc, link: `./realtime.html?q=${code}` });
    }
    const t = j.tradedAt ? new Date(j.tradedAt) : null;
    let meta = "";
    if (t && !isNaN(t)) {
      const d = `${t.getMonth() + 1}/${t.getDate()}`;
      meta = j.status === "OPEN" ? `${d} 장중 · 1분마다 갱신` : `${d} 장 마감 기준`;
    }
    return { items, meta };
  }

  async function loadUs() {
    if (!state.usMap) state.usMap = (await getDataFile("data/us-sector-map.json")).map || {};
    let stocks = [];
    let updatedAt = "";
    try {
      const j = await getJson("/api/us-market-data?action=market-cap");
      stocks = j.stocks || [];
      updatedAt = j.updatedAt || "";
    } catch (_) {
      const j = await getDataFile("data/us-market-cap.json");
      stocks = j.stocks || [];
      updatedAt = j.updatedAt || "";
    }
    const skip = new Set(["GOOG", "BRK/A"]); // 같은 회사 중복 상장분
    const items = [];
    for (const s of stocks) {
      const tk = String(s.ticker || "");
      if (!tk || skip.has(tk) || s.marketCap == null || s.changePct == null) continue;
      const sector = state.usMap[tk];
      if (!sector && /ETF|TRUST|FUND|INDEX/i.test(String(s.name || "") + " " + tk)) continue;
      items.push({ id: tk, label: tk.replace("/", "."), name: s.name || tk, cap: s.marketCap, pct: s.changePct, sector: sector || "기타", link: `./us-market.html?q=${encodeURIComponent(tk)}` });
    }
    let meta = "";
    const t = updatedAt ? new Date(updatedAt) : null;
    if (t && !isNaN(t)) meta = `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")} 기준`;
    return { items, meta };
  }

  async function loadCrypto() {
    const j = await getJson("/api/crypto-data?action=listings&sparks=0");
    const items = [];
    for (const c of j.coins || []) {
      const sym = String(c.symbol || "").toUpperCase();
      if (!sym || COIN_EXCLUDE.has(sym) || /^USD/.test(sym)) continue;
      const cap = c.marketCapUsd;
      if (cap == null || cap <= 0 || c.change24h == null) continue;
      items.push({ id: sym, label: sym, name: c.name || sym, cap, pct: c.change24h, sector: COIN_GROUP[sym] || "기타", link: "./crypto.html" });
      if (items.length >= 80) break;
    }
    return { items, meta: "24시간 등락률 · 2분마다 갱신" };
  }

  /* ───────── 배치(squarify) ───────── */
  function worst(sum, mn, mx, side) {
    const s2 = sum * sum;
    const l2 = side * side;
    return Math.max((l2 * mx) / s2, s2 / (l2 * mn));
  }
  function squarify(values, x, y, w, h) {
    const out = values.map(() => ({ x, y, w: 0, h: 0 }));
    const total = values.reduce((a, b) => a + b, 0);
    if (!(total > 0) || w <= 0 || h <= 0) return out;
    const k = (w * h) / total;
    const areas = values.map((v) => v * k);
    let i = 0;
    while (i < areas.length) {
      const side = Math.min(w, h);
      let sum = areas[i];
      let mn = sum;
      let mx = sum;
      let wr = worst(sum, mn, mx, side);
      let j = i + 1;
      while (j < areas.length) {
        const a = areas[j];
        const w2 = worst(sum + a, Math.min(mn, a), Math.max(mx, a), side);
        if (w2 > wr) break;
        sum += a;
        mn = Math.min(mn, a);
        mx = Math.max(mx, a);
        wr = w2;
        j++;
      }
      if (w >= h) {
        const cw = sum / h;
        let yy = y;
        for (let t = i; t < j; t++) {
          const hh = areas[t] / cw;
          out[t] = { x, y: yy, w: cw, h: hh };
          yy += hh;
        }
        x += cw;
        w -= cw;
      } else {
        const rh = sum / w;
        let xx = x;
        for (let t = i; t < j; t++) {
          const ww = areas[t] / rh;
          out[t] = { x: xx, y, w: ww, h: rh };
          xx += ww;
        }
        y += rh;
        h -= rh;
      }
      i = j;
    }
    return out;
  }

  /* ───────── 색·숫자 ───────── */
  function tileColor(p) {
    if (p == null || !isFinite(p)) return "rgb(70,76,90)";
    const a = Math.min(Math.abs(p) / 3, 1);
    if (Math.abs(p) < 0.05) return "rgb(70,76,90)";
    const base = [70, 76, 90];
    const tgt = p > 0 ? [214, 40, 40] : [37, 99, 235];
    const t = 0.28 + 0.72 * a;
    const c = base.map((b, i) => Math.round(b + (tgt[i] - b) * t));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function pctText(p) {
    if (p == null || !isFinite(p)) return "";
    return `${p > 0 ? "+" : ""}${Number(p).toFixed(2)}%`;
  }
  function pctCls(p) {
    return p > 0 ? "is-up" : p < 0 ? "is-down" : "";
  }
  function capText(tab, cap) {
    if (tab === "KOSPI" || tab === "KOSDAQ") {
      const jo = cap / 10000;
      return jo >= 1 ? `${jo >= 100 ? Math.round(jo).toLocaleString("ko-KR") : jo.toFixed(1)}조원` : `${Math.round(cap).toLocaleString("ko-KR")}억원`;
    }
    if (cap >= 1e12) return `$${(cap / 1e12).toFixed(2)}T`;
    if (cap >= 1e9) return `$${(cap / 1e9).toFixed(1)}B`;
    return `$${Math.round(cap / 1e6).toLocaleString("en-US")}M`;
  }

  /* ───────── 그리기 ───────── */
  function buildModel(items, maxTiles, boxArea) {
    // 섹터 통계는 받은 종목 전체로, 화면에 그리는 네모는 시총 상위 위주로
    const bySec = new Map();
    for (const it of items) {
      if (!bySec.has(it.sector)) bySec.set(it.sector, []);
      bySec.get(it.sector).push(it);
    }
    const sorted = items.slice().sort((a, b) => b.cap - a.cap);
    const shown = new Set(sorted.slice(0, maxTiles));
    bySec.forEach((arr) => {
      arr.sort((a, b) => b.cap - a.cap);
      arr.slice(0, 2).forEach((x) => shown.add(x)); // 섹터마다 최소 2칸
    });
    const sectors = [];
    bySec.forEach((arr, name) => {
      const capSum = arr.reduce((s, x) => s + x.cap, 0);
      const wPct = capSum > 0 ? arr.reduce((s, x) => s + x.cap * x.pct, 0) / capSum : null;
      const topN = arr.map((x) => x.pct).sort((a, b) => b - a).slice(0, 10);
      const surge = arr.length >= 5 ? { n: topN.length, avg: topN.reduce((s, v) => s + v, 0) / topN.length } : null;
      const tiles = arr.filter((x) => shown.has(x));
      if (!tiles.length) return;
      sectors.push({ name, pct: wPct, surge, tiles, weight: tiles.reduce((s, x) => s + x.cap, 0) });
    });
    // 글자가 안 들어갈 만큼 작은 칸(약 34×34px 미만)은 그리지 않는다 — 이름 없는 조각만 늘어나 지저분해진다.
    // 섹터 통계(등락률·급등10 평균)는 위에서 전체 종목으로 이미 계산했으므로 영향 없음.
    if (boxArea > 0) {
      const tot0 = sectors.reduce((s, x) => s + x.weight, 0) || 1;
      const k = boxArea / tot0;
      sectors.forEach((sec) => {
        sec.tiles = sec.tiles.filter((t, i) => i === 0 || t.cap * k >= 1600);
        sec.weight = sec.tiles.reduce((s, x) => s + x.cap, 0);
      });
    }
    sectors.sort((a, b) => b.weight - a.weight);
    // 너무 작은 섹터도 머리글이 들어가도록 최소 면적 보장
    const tot = sectors.reduce((s, x) => s + x.weight, 0);
    const minShare = boxArea > 0 && boxArea < 330000 ? 0.06 : 0.035; // 좁은(모바일) 화면은 작은 섹터를 조금 더 크게
    sectors.forEach((s) => (s.area = Math.max(s.weight, tot * minShare)));
    return sectors;
  }

  function render() {
    const box = $("hm-map");
    const layer = $("hm-layer");
    if (!box || !layer) return;
    const pack = state.cache[state.tab];
    if (!pack) return;
    const W = box.clientWidth;
    const H = box.clientHeight;
    if (W < 50 || H < 50) return;
    const small = W < 700;
    const maxTiles = state.tab === "US" ? 60 : state.tab === "CRYPTO" ? 50 : small ? 45 : 90;
    const sectors = buildModel(pack.items, maxTiles, W * H * 0.86);
    if (!sectors.length) {
      layer.innerHTML = '<p class="hm__empty">표시할 데이터가 없습니다.</p>';
      return;
    }
    const G = 3; // 섹터 사이 간격
    const rects = squarify(sectors.map((s) => s.area), 0, 0, W, H);
    let html = "";
    sectors.forEach((s, si) => {
      const r = rects[si];
      const x = r.x + G / 2;
      const y = r.y + G / 2;
      const w = Math.max(0, r.w - G);
      const h = Math.max(0, r.h - G);
      const roomy = w >= 150 && h >= 90;
      const hh = roomy && s.surge ? 38 : 20;
      html += `<div class="hm-sec" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">`;
      html += `<div class="hm-sec__head" style="height:${hh}px"><div class="hm-sec__row"><b>${esc(s.name)}</b> <span class="${pctCls(s.pct)}">${esc(pctText(s.pct))}</span></div>`;
      if (hh > 20) html += `<div class="hm-sec__surge">급등${s.surge.n === 10 ? "10" : s.surge.n} 평균 <span class="${pctCls(s.surge.avg)}">${esc(pctText(s.surge.avg))}</span></div>`;
      html += `</div>`;
      const trs = squarify(s.tiles.map((t) => t.cap), 0, hh, w, Math.max(0, h - hh));
      s.tiles.forEach((t, ti) => {
        const q = trs[ti];
        const tw = Math.max(0, q.w - 2);
        const th = Math.max(0, q.h - 2);
        if (tw < 3 || th < 3) return;
        const fs = Math.max(10, Math.min(28, Math.sqrt(tw * th) / 6.5));
        const showName = tw >= 34 && th >= 18;
        const showPct = showName && th >= fs * 2.5;
        html += `<a class="hm-tile" href="${esc(t.link)}" data-i="${esc(t.id)}" style="left:${q.x + 1}px;top:${q.y + 1}px;width:${tw}px;height:${th}px;background:${tileColor(t.pct)};font-size:${fs.toFixed(1)}px">`;
        if (showName) html += `<span class="hm-tile__n">${esc(t.label)}</span>`;
        if (showPct) html += `<span class="hm-tile__p">${esc(pctText(t.pct))}</span>`;
        html += `</a>`;
      });
      html += `</div>`;
    });
    layer.innerHTML = html;
    const metaEl = $("hm-meta");
    if (metaEl) metaEl.textContent = pack.meta || "";
  }

  /* ───────── 툴팁 ───────── */
  function wireTooltip() {
    const box = $("hm-map");
    const tip = $("hm-tip");
    if (!box || !tip) return;
    box.addEventListener("mousemove", (e) => {
      const a = e.target.closest(".hm-tile");
      const pack = state.cache[state.tab];
      if (!a || !pack) {
        tip.hidden = true;
        return;
      }
      const it = pack.items.find((x) => x.id === a.getAttribute("data-i"));
      if (!it) {
        tip.hidden = true;
        return;
      }
      tip.innerHTML = `<b>${esc(it.name)}</b>${it.label !== it.name ? ` <span class="hm-tip__id">${esc(it.label)}</span>` : ""}<div class="hm-tip__sec">${esc(it.sector)}</div><div class="hm-tip__row"><span>등락률</span><b class="${pctCls(it.pct)}">${esc(pctText(it.pct))}</b></div><div class="hm-tip__row"><span>시가총액</span><b>${esc(capText(state.tab, it.cap))}</b></div>`;
      tip.hidden = false;
      const br = box.getBoundingClientRect();
      let lx = e.clientX - br.left + 14;
      let ly = e.clientY - br.top + 14;
      if (lx + tip.offsetWidth > br.width) lx = e.clientX - br.left - tip.offsetWidth - 14;
      if (ly + tip.offsetHeight > br.height) ly = e.clientY - br.top - tip.offsetHeight - 14;
      tip.style.transform = `translate(${Math.max(0, lx)}px, ${Math.max(0, ly)}px)`;
    });
    box.addEventListener("mouseleave", () => (tip.hidden = true));
  }

  /* ───────── 탭·갱신 ───────── */
  async function load(tab, force) {
    const cur = state.cache[tab];
    if (cur && !force && Date.now() - cur.at < REFRESH_MS[tab]) return cur;
    const fn = tab === "US" ? loadUs : tab === "CRYPTO" ? loadCrypto : () => loadKr(tab);
    const pack = await fn();
    pack.at = Date.now();
    state.cache[tab] = pack;
    return pack;
  }

  async function show(tab, force) {
    state.tab = tab;
    document.querySelectorAll("[data-hm-tab]").forEach((b) => {
      const on = b.getAttribute("data-hm-tab") === tab;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    const box = $("hm-layer");
    if (!state.cache[tab] && box) box.innerHTML = '<p class="hm__empty">불러오는 중…</p>';
    try {
      await load(tab, force);
      if (state.tab === tab) render();
    } catch (e) {
      if (state.tab === tab && !state.cache[tab] && box) box.innerHTML = '<p class="hm__empty">잠시 후 다시 시도해주세요.</p>';
    }
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (document.visibilityState === "visible") show(state.tab, true);
      else state.timer = setTimeout(() => show(state.tab, true), REFRESH_MS[state.tab]);
    }, REFRESH_MS[tab]);
  }

  function init() {
    const root = $("home-heatmap");
    if (!root) return;
    const tabs = $("hm-tabs");
    if (tabs) {
      tabs.innerHTML = TABS.map(
        (t) => `<button type="button" role="tab" class="hm__tab" data-hm-tab="${t.id}" aria-selected="false">${t.label}</button>`
      ).join("");
      tabs.addEventListener("click", (e) => {
        const b = e.target.closest("[data-hm-tab]");
        if (b) show(b.getAttribute("data-hm-tab"));
      });
    }
    wireTooltip();
    let raf = 0;
    state.ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(render);
    });
    state.ro.observe($("hm-map"));
    show("KOSPI");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
