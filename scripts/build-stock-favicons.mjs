/**
 * 국내 종목 아이콘 — 회사 공식 홈페이지 파비콘에서 정사각 브랜드 마크를 만든다.
 *
 * 왜 필요한가
 *   FMP 로고(build-stock-logos.mjs)는 2,700종목 중 13%만 쓸 만하다. 삼성전자·NAVER·카카오·
 *   현대차처럼 화면에 제일 자주 나오는 종목이 전부 "가로로 긴 워드마크"라 탈락해서,
 *   이니셜 배지(삼·현·기)로 떨어졌다. 진짜 로고 옆에 배지가 섞이니 조악해 보였다.
 *   회사 파비콘은 정의상 정사각이고 브랜드 컬러를 쓴다 — 이 빈자리를 메우는 데 딱 맞다.
 *
 * 왜 구글 파비콘 서비스를 쓰는가
 *   회사 서버의 /favicon.ico를 직접 때리면 404·리다이렉트·봇 차단이 뒤섞여 실패한다(실측).
 *   구글이 그 해석을 대신 해 주고 최대 128px PNG를 준다. 받아온 이미지는 우리 저장소에
 *   저장해서 쓰므로 런타임에 외부 의존이 없다(= 남의 CDN을 핫링크하지 않는다).
 *   ⚠️ 질의는 반드시 전체 URL 형태여야 한다. `domain=example.com`은 404, 
 *      `domain=https://www.example.com`은 200. 이것 때문에 처음에 67개가 실패했다.
 *
 * 입력  assets/logos/kr-domains.json   { "005930": "samsung.com", ... }  ← 손으로 관리
 * 출력  assets/logos/kr/<code>.webp    (build-stock-logos.mjs와 같은 폴더 = 화면단 수정 불필요)
 *       assets/logos/kr-curated.json   { codes:[...], tints:{}, updatedAt }
 *                                      ← 주간 FMP 재빌드가 이 코드들을 건드리지 않게 하는 표식
 *
 * 실행  node scripts/build-stock-favicons.mjs [--force] [--only 005930,000660]
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DOMAINS = path.join(ROOT, "assets", "logos", "kr-domains.json");
const OUT_DIR = path.join(ROOT, "assets", "logos", "kr");
const CURATED = path.join(ROOT, "assets", "logos", "kr-curated.json");
const TINT_OVERRIDES = path.join(ROOT, "assets", "logos", "kr-tint-overrides.json");
const SKIP = path.join(ROOT, "assets", "logos", "kr-favicon-skip.json");

const FORCE = process.argv.includes("--force");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i > 0 && process.argv[i + 1] ? new Set(process.argv[i + 1].split(",")) : null;
})();

/* 판정 기준 — 배지보다 나은 것만 통과시킨다.
   MIN_SIDE 32: 화면 표시 크기가 26~30px이라 32px 원본이면 육안으로 충분하다.
   16px짜리만 있는 회사(삼성SDI·LG화학 등)는 확대하면 뭉개지므로 배지로 남긴다. */
const MIN_SIDE = 32;
/* 파비콘은 FMP 로고와 달리 "정사각 캔버스에 그려진" 자산이다. 그래서 여백을 잘라낸
   비율로 탈락시키면 안 된다 — 현대차의 H 엠블럼(가로로 납작한 타원)이 비율 1.92로
   걸려 버린다. 캔버스가 정사각이면 자르지 않고 그대로 쓰고, 잘라낸 비율은
   "이건 그냥 글자다"를 걸러내는 용도로만 본다(기아 4.0, KT&G 3.2 = 순수 워드마크). */
const AR_MIN = 0.45;
const AR_MAX = 2.2;
const CANVAS_SQUARE = 0.12; // 원본 캔버스가 이 정도 안이면 정사각으로 본다
const INK_MIN = 0.03;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFavicon(domain) {
  // www 붙인 형태를 먼저 — 대부분의 국내 기업 사이트가 www로 리다이렉트된다
  for (const origin of [`https://www.${domain}`, `https://${domain}`]) {
    const url =
      "https://www.google.com/s2/favicons?sz=128&domain=" + encodeURIComponent(origin);
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 150) return buf;
    } catch {
      /* 다음 형태로 */
    }
    await sleep(80);
  }
  return null;
}

/** 여백을 잘라낸 뒤 정사각 마크인지 판정하고, 대표색(tint)을 뽑는다. */
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

  // 배경색 = 테두리 한 줄의 최빈색 (모서리 한 점만 보면 흰 캔버스 워드마크를 놓친다)
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
  if (ar < AR_MIN || ar > AR_MAX) return { reject: `워드마크 비율 ${ar.toFixed(2)}` };
  if (ink / (cw * chh) < INK_MIN) return { reject: "잉크 부족" };

  // 캔버스가 정사각이면 원본 그대로(디자이너가 잡아 둔 여백을 살린다), 아니면 내용만 잘라 쓴다
  const canvasSquare = Math.abs(W / H - 1) <= CANVAS_SQUARE;
  const box = canvasSquare ? [0, 0, W, H] : [x0, y0, cw, chh];

  // 대표색: 무채색을 뺀 최빈색. 없으면 배경색이 유채색일 때 그걸 쓴다(KB 노랑 타일 같은 경우).
  let tint = null, best = -1;
  for (const [k, n] of hist) {
    const r = ((k >> 10) & 31) << 3, g = ((k >> 5) & 31) << 3, b = (k & 31) << 3;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 30 || mx > 236) continue;
    if (n > best) { best = n; tint = [r, g, b]; }
  }
  if (!tint) {
    const mx = Math.max(...bg), mn = Math.min(...bg);
    if (mx - mn >= 30 && mx <= 236) tint = bg;
  }
  return { box, tint, size: Math.min(W, H), trimmed: !canvasSquare };
}

const hex = ([r, g, b]) =>
  "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");

/** 흰 글씨가 4.5:1을 넘을 때까지 어둡게 — 배지 폴백과 같은 규칙 */
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
  const domains = JSON.parse(fs.readFileSync(DOMAINS, "utf8"));
  const overrides = fs.existsSync(TINT_OVERRIDES) ? JSON.parse(fs.readFileSync(TINT_OVERRIDES, "utf8")) : {};
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 같은 도메인을 여러 종목이 공유한다(삼성전자/삼성전자우). 다운로드는 도메인당 한 번.
  /* 파비콘이 로고가 아니거나 26px에서 안 읽히는 종목은 손으로 제외한다.
     기계 판정으로는 "브랜드사이트 배너"나 "문서 아이콘"을 걸러낼 수 없어서, 만든 뒤
     눈으로 보고 걸러낸 목록이다. 제외된 종목은 기존 이니셜 배지로 남는다. */
  const skip = fs.existsSync(SKIP) ? JSON.parse(fs.readFileSync(SKIP, "utf8")) : {};
  const byDomain = new Map();
  for (const [code, d] of Object.entries(domains)) {
    if (ONLY && !ONLY.has(code)) continue;
    if (skip[code]) { const f = path.join(OUT_DIR, `${code}.webp`); if (fs.existsSync(f)) fs.rmSync(f); continue; }
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(code);
  }

  const codes = [];
  const tints = {};
  const rejects = {};
  let fetched = 0;

  for (const [domain, codeList] of byDomain) {
    const needed = FORCE ? codeList : codeList.filter((c) => !fs.existsSync(path.join(OUT_DIR, `${c}.webp`)));
    // 이미 파일이 있으면 그대로 인정(FMP 로고든 파비콘이든 화면에는 이미 나가고 있다)
    for (const c of codeList) if (!needed.includes(c)) codes.push(c);
    if (!needed.length) continue;

    const buf = await fetchFavicon(domain);
    if (!buf) { for (const c of needed) rejects[c] = `파비콘 없음(${domain})`; continue; }
    fetched++;

    let a;
    try { a = await analyse(buf); } catch (e) { a = { reject: "디코드 실패" }; }
    if (a.reject) { for (const c of needed) rejects[c] = `${a.reject} (${domain})`; continue; }

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

    for (const c of needed) {
      fs.writeFileSync(path.join(OUT_DIR, `${c}.webp`), png);
      codes.push(c);
      const t = overrides[c] ? null : a.tint;
      if (t) tints[c] = hex(darkenForWhiteText(t));
    }
    await sleep(120);
  }

  const prev = fs.existsSync(CURATED) ? JSON.parse(fs.readFileSync(CURATED, "utf8")) : {};
  const merged = Array.from(new Set([...(prev.codes || []), ...codes])).sort();
  fs.writeFileSync(
    CURATED,
    JSON.stringify({ updatedAt: new Date().toISOString(), count: merged.length, codes: merged, tints: { ...(prev.tints || {}), ...tints } }, null, 0) + "\n"
  );

  console.log(`도메인 ${byDomain.size}개 / 새로 받은 것 ${fetched}개 / 채택 ${codes.length}종목 / 탈락 ${Object.keys(rejects).length}종목`);
  for (const [c, r] of Object.entries(rejects)) console.log(`  - ${c}: ${r}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
