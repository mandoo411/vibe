/**
 * 미국·해외 종목 아이콘 — FMP 로고를 받아 우리 저장소에 정사각 WebP로 저장한다.
 *
 * 왜 필요한가
 *   home.js가 `financialmodelingprep.com/image-stock/{TICKER}.png`를 **화면에서 직접 링크**하고
 *   있었다. 남의 CDN이 막히거나 느려지면 전 종목 아이콘이 동시에 깨진다(국내 쪽에서 이미
 *   같은 이유로 자체 호스팅으로 옮겼다). 받아서 우리가 들고 있으면 런타임 의존이 없다.
 *
 * 국내와 다른 점
 *   FMP의 미국 로고는 대부분 **정사각 캔버스에 앉힌 심볼**이라 국내(13%)와 달리 쓸 만한 비율이 높다.
 *   그래서 국내처럼 깐깐하게 거르지 않고, "그냥 글자 덩어리"만 걸러낸다.
 *   탈락한 종목은 **티커 배지**로 떨어지는데, 미국 종목은 티커(AAPL·COST·CSCO)가 곧 이름이라
 *   국내 이니셜 배지보다 훨씬 잘 읽힌다 — 굳이 무리해서 로고를 붙일 이유가 없다.
 *
 * 입력  data/us-market-*.json, data/world-market-cache.json, assets/logos/us-extra.json
 * 출력  assets/logos/us/<TICKER>.webp, assets/logos/us-manifest.json
 *
 * 실행  node scripts/build-us-logos.mjs [--force]
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_DIR = path.join(ROOT, "assets", "logos", "us");
const MANIFEST = path.join(ROOT, "assets", "logos", "us-manifest.json");
const EXTRA = path.join(ROOT, "assets", "logos", "us-extra.json");
const SKIP = path.join(ROOT, "assets", "logos", "us-skip.json");
const FORCE = process.argv.includes("--force");

const MIN_SIDE = 32;
const AR_MAX = 2.2;      // 이보다 납작하면 "심볼"이 아니라 "글자"다 → 티커 배지가 낫다
const AR_MIN = 0.45;
const CANVAS_SQUARE = 0.12;
const INK_MIN = 0.03;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 화면에 실제로 나오는 종목들을 모은다. 안 나오는 종목까지 받을 이유가 없다. */
function universe() {
  const out = new Map();
  const add = (t, n) => {
    const k = String(t || "").trim().toUpperCase();
    if (/^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(k) && !out.has(k)) out.set(k, n || k);
  };
  for (const f of ["us-market-cap.json", "us-market-gainers.json", "us-market-volume.json"]) {
    const p = path.join(ROOT, "data", f);
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      const rows = Array.isArray(j) ? j : j.stocks || j.data || [];
      for (const r of rows) add(r.ticker || r.symbol, r.name);
    } catch { /* 무시 */ }
  }
  const w = path.join(ROOT, "data", "world-market-cache.json");
  if (fs.existsSync(w)) {
    try {
      const j = JSON.parse(fs.readFileSync(w, "utf8"));
      for (const [t, v] of Object.entries(j.entries || {})) add(t, v && v.name);
    } catch { /* 무시 */ }
  }
  if (fs.existsSync(EXTRA)) {
    try {
      for (const [t, n] of Object.entries(JSON.parse(fs.readFileSync(EXTRA, "utf8")))) {
        if (!t.startsWith("_")) add(t, n);
      }
    } catch { /* 무시 */ }
  }
  return out;
}

async function fetchLogo(ticker) {
  const url = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(ticker)}.png`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 200 ? buf : null;
  } catch {
    return null;
  }
}

async function analyse(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, CH = info.channels;
  if (!W || !H) return { reject: "크기 없음" };
  if (Math.min(W, H) < MIN_SIDE) return { reject: `저해상도 ${W}x${H}` };

  const px = (x, y) => {
    const i = (y * W + x) * CH;
    const a = CH === 4 ? data[i + 3] / 255 : 1;
    return [
      Math.round(data[i] * a + 255 * (1 - a)),
      Math.round(data[i + 1] * a + 255 * (1 - a)),
      Math.round(data[i + 2] * a + 255 * (1 - a)),
    ];
  };

  const ring = new Map();
  const bump = (x, y) => {
    const [r, g, b] = px(x, y);
    const k = (r << 16) | (g << 8) | b;
    ring.set(k, (ring.get(k) || 0) + 1);
  };
  for (let x = 0; x < W; x++) { bump(x, 0); bump(x, H - 1); }
  for (let y = 0; y < H; y++) { bump(0, y); bump(W - 1, y); }
  let bgKey = 0, bgN = -1;
  for (const [k, n] of ring) if (n > bgN) { bgN = n; bgKey = k; }
  const bg = [(bgKey >> 16) & 255, (bgKey >> 8) & 255, bgKey & 255];

  const DIFF = 44;
  let x0 = W, y0 = H, x1 = -1, y1 = -1, ink = 0;
  const hist = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px(x, y);
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) < DIFF) continue;
      ink++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
  }
  if (x1 < 0) return { reject: "빈 이미지" };

  const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
  const ar = cw / chh;

  /* 대표색은 탈락해도 뽑아 둔다 — 로고가 안 붙는 종목의 티커 배지를 브랜드색으로 칠하기 위해서다.
     (이 순서를 안 지키면 아마존이 팔레트 해시색으로 칠해진다. 실제로 그랬다.) */
  let tint = null, best = -1;
  for (const [k, n] of hist) {
    const r = ((k >> 10) & 31) << 3, g = ((k >> 5) & 31) << 3, b = (k & 31) << 3;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    /* 무채색만 거른다. 아마존 주황(#FF9900)·캐터필러 노랑처럼 밝은 브랜드색을
       "너무 밝다"고 빼면 배지가 팔레트 해시색으로 떨어진다 — 대비는 아래 darkenForWhiteText가 잡는다. */
    if (mx - mn < 30) continue;
    if (n > best) { best = n; tint = [r, g, b]; }
  }
  if (!tint) {
    const mx = Math.max(...bg), mn = Math.min(...bg);
    if (mx - mn >= 30) tint = bg;
  }

  if (ar < AR_MIN || ar > AR_MAX) return { reject: `워드마크 비율 ${ar.toFixed(2)}`, tint };
  if (ink / (cw * chh) < INK_MIN) return { reject: "잉크 부족", tint };

  const canvasSquare = Math.abs(W / H - 1) <= CANVAS_SQUARE;
  const box = canvasSquare ? [0, 0, W, H] : [x0, y0, cw, chh];
  return { box, tint, trimmed: !canvasSquare };
}

const hex = ([r, g, b]) =>
  "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");

function darkenForWhiteText(rgb) {
  const lum = (c) => {
    const s = c.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
  };
  let c = [...rgb];
  for (let i = 0; i < 24 && (1.05 / (lum(c) + 0.05)) < 4.5; i++) c = c.map((v) => Math.round(v * 0.9));
  return c;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const uni = universe();
  const skip = fs.existsSync(SKIP) ? JSON.parse(fs.readFileSync(SKIP, "utf8")) : {};
  const prev = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : {};
  const tints = new Map(Object.entries(prev.tints || {}));

  const accepted = new Set();
  const rejects = {};
  let fetched = 0;

  for (const [t] of uni) {
    const out = path.join(OUT_DIR, `${t}.webp`);
    if (skip[t]) { if (fs.existsSync(out)) fs.rmSync(out); rejects[t] = `손으로 제외: ${skip[t]}`; continue; }
    if (!FORCE && fs.existsSync(out)) { accepted.add(t); continue; }

    const buf = await fetchLogo(t);
    if (!buf) { rejects[t] = "이미지 없음"; continue; }
    fetched++;

    let a;
    try { a = await analyse(buf); } catch { a = { reject: "디코드 실패" }; }
    if (a.reject) {
      rejects[t] = a.reject;
      if (a.tint) tints.set(t, hex(darkenForWhiteText(a.tint)));
      continue;
    }

    const [bx, by, bw, bh] = a.box;
    const pad = a.trimmed ? Math.round(80 * 0.08) : 0;
    const png = await sharp(buf)
      .ensureAlpha()
      .extract({ left: bx, top: by, width: bw, height: bh })
      .resize(80 - pad * 2, 80 - pad * 2, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .flatten({ background: "#ffffff" })
      .webp({ quality: 88 })
      .toBuffer();
    fs.writeFileSync(out, png);
    accepted.add(t);
    if (a.tint) tints.set(t, hex(darkenForWhiteText(a.tint)));
    await sleep(60);
  }

  // 목록에서 빠진 티커의 파일은 정리한다
  for (const f of fs.readdirSync(OUT_DIR)) {
    const t = f.replace(/\.webp$/, "");
    if (!uni.has(t)) fs.rmSync(path.join(OUT_DIR, f));
  }

  const tickers = [...accepted].sort();
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      count: tickers.length,
      tickers,
      // 로고가 없는 종목의 티커 배지 색
      tints: Object.fromEntries([...tints].filter(([t]) => !accepted.has(t)).sort()),
    }) + "\n",
    "utf8"
  );

  console.log(`대상 ${uni.size}  새로 받음 ${fetched}  채택 ${tickers.length}  탈락 ${Object.keys(rejects).length}`);
  for (const [t, r] of Object.entries(rejects)) console.log(`  - ${t}: ${r}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
