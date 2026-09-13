/**
 * build-stock-logos.mjs — 국내 종목 로고를 내려받아 정규화해서 저장소에 넣는다.
 *
 * 왜 이런 구조인가 (2026-09-13):
 *   원본(FMP)의 한국 종목 로고는 품질이 제각각이다. 상위 300종목을 실측해보니
 *   이미지는 94%가 받아지지만, 40px 동그라미에 넣어서 알아볼 수 있는 "정사각 마크"는
 *   28%뿐이었다. 나머지는 가로로 긴 워드마크(줄이면 글자가 뭉갬)거나, 아예 회사 건물
 *   사진이 올라와 있는 경우도 있었다. 그대로 붙이면 없는 것만 못하다.
 *
 *   그래서 "받아지면 다 쓴다"가 아니라 *골라서* 쓴다. 아래 판정을 통과한 것만 저장하고,
 *   나머지는 화면단에서 이니셜 배지로 그린다(assets/stock-logo.js). 배지는 항상 같은
 *   색·같은 모양으로 나오므로, 로고가 없는 종목이 "빠진 칸"처럼 보이지 않는다.
 *
 * 판정 기준 — 하나라도 걸리면 탈락(= 배지로 폴백):
 *   1) 여백을 잘라낸 뒤 가로세로비가 0.72~1.38 밖  → 워드마크
 *   2) 잉크(배경이 아닌 픽셀) 비율이 4% 미만       → 실선 몇 개뿐인 빈 이미지
 *   3) 상위 8색이 전체의 82%를 못 덮음             → 사진
 *   4) 잘라낸 뒤 한 변이 40px 미만                 → 확대하면 뭉갬
 *
 * 우선주(005935 등)는 자기 로고가 없다. 보통주(앞 5자리 + 0)의 로고를 물려받는다.
 *
 * 산출물:
 *   assets/logos/kr/<code>.webp   80x80, 흰 배경, 여백 8%
 *   assets/logos/kr-manifest.json { updatedAt, count, codes: [...] }
 *     → 화면단은 이 목록에 있는 코드만 <img>로 요청한다. 404를 아예 안 만든다.
 *
 * 실행:  node scripts/build-stock-logos.mjs [--limit N] [--force]
 *        (매주 GHA로 자동 실행 — .github/workflows/stock-logos.yml)
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_DIR = path.join(ROOT, "assets", "logos", "kr");
const MANIFEST = path.join(ROOT, "assets", "logos", "kr-manifest.json");
// 탈락 기록 — 매주 돌 때 이미 떨어진 종목을 또 받지 않기 위한 캐시.
// 판정 기준을 고치면 --force 로 통째로 다시 본다.
const REJECTS = path.join(ROOT, "assets", "logos", "kr-rejects.json");
// 손으로 지정한 배지 색 — 자동 추출이 실패하거나 엉뚱할 때만 채운다(삼성전자 등)
const TINT_OVERRIDES = path.join(ROOT, "assets", "logos", "kr-tint-overrides.json");
const CACHE = path.join(ROOT, "data", "kr-screener-cache.json");

const args = process.argv.slice(2);
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 ? Number(args[i + 1]) || Infinity : Infinity;
})();
const FORCE = args.includes("--force");

const SIZE = 80;          // 저장 크기(화면 40px의 2배)
const PAD = 0.08;         // 안쪽 여백 비율
const CONCURRENCY = 12;

// ── 판정 임계값 ────────────────────────────────────────────────────────
const AR_MIN = 0.72, AR_MAX = 1.38;
// 심볼만 떼어낸 경우엔 살짝 가로로 길어도(정사각 캔버스에 여백을 두고 앉히므로) 괜찮다
const AR_SPLIT_MAX = 1.7;
const INK_MIN = 0.04;
const TOP8_COVER_MIN = 0.82;
const MIN_SIDE = 40;

function readStocks() {
  const raw = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  const rows = Array.isArray(raw.stocks) ? raw.stocks : [];
  // 시총 큰 순 — 상위 종목일수록 화면에 자주 나오니 먼저 처리한다
  return rows
    .filter((r) => r && r.code && /^\d{6}$/.test(String(r.code)))
    .sort((a, b) => (b.marketCapEok || 0) - (a.marketCapEok || 0));
}

/** 우선주 → 보통주 코드 (005935 → 005930). 아니면 null */
function parentCode(code) {
  const last = code.slice(5);
  if (last === "0") return null;
  return code.slice(0, 5) + "0";
}

async function fetchLogo(code, market) {
  const order = market === "KOSDAQ" ? [".KQ", ".KS"] : [".KS", ".KQ"];
  for (const sfx of order) {
    try {
      const res = await fetch(`https://financialmodelingprep.com/image-stock/${code}${sfx}.png`, {
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 300) return buf;
    } catch {
      /* 다음 접미사로 */
    }
  }
  return null;
}

/**
 * 흰 배경에 합성한 뒤 "내용이 있는 사각형"을 찾는다.
 *
 * 배경색은 모서리 한 점이 아니라 *테두리 한 줄 전체에서 제일 많이 나온 색*으로 잡는다.
 * 모서리만 보면 NAVER·셀트리온처럼 "불투명한 흰 캔버스에 글자만 얹은" 이미지에서
 * 전체가 내용으로 잡혀 비율 1:1이 되고, 워드마크가 정사각 마크로 둔갑한다.
 * (실제로 그 두 종목이 그렇게 통과했었다.)
 */
async function analyse(buf) {
  const img = sharp(buf).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, CH = info.channels;
  if (!W || !H) return { reject: "크기 없음" };

  // 알파를 흰색에 합성한 RGB
  const px = (x, y) => {
    const i = (y * W + x) * CH;
    const a = CH === 4 ? data[i + 3] / 255 : 1;
    return [
      Math.round(data[i] * a + 255 * (1 - a)),
      Math.round(data[i + 1] * a + 255 * (1 - a)),
      Math.round(data[i + 2] * a + 255 * (1 - a)),
    ];
  };

  // 테두리 한 줄에서 최빈색 = 배경
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
  const ringUniform = bgN / (2 * W + 2 * H);

  const DIFF = 44; // 맨해튼 거리
  let x0 = W, y0 = H, x1 = -1, y1 = -1, ink = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px(x, y);
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) < DIFF) continue;
      ink++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { reject: "빈 이미지" };

  let cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  let ar = cw / ch;
  let inkRatio = ink / (cw * ch);
  let split = false;   // 심볼만 떼어낸 경우 — 비율 기준을 조금 느슨하게 본다

  /* 가로로 긴 로고 중 상당수는 "[심볼] 회사이름" 형태다(삼성SDI·KB금융·한화·셀트리온…).
     이런 건 통째로 줄이면 글자가 뭉개지지만, 왼쪽 심볼만 떼면 훌륭한 정사각 마크가 된다.
     심볼과 글자 사이에는 거의 항상 세로 여백(gutter)이 있으므로, 잉크가 하나도 없는
     세로줄이 연속으로 나오는 첫 지점을 찾아 거기서 자른다.
     여백이 없으면(= 글자끼리 붙어 있으면) 순수 워드마크이므로 자르지 않고 탈락시킨다. */
  if (ar > AR_MAX) {
    const colInk = new Array(cw).fill(0);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const [r, g, b] = px(x, y);
        if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) >= DIFF) colInk[x - x0]++;
      }
    }
    const gutterMin = Math.max(3, Math.round(cw * 0.03));
    let cut = -1;
    for (let i = 1; i < cw; i++) {
      if (colInk[i] !== 0) continue;
      let j = i;
      while (j < cw && colInk[j] === 0) j++;
      if (j - i >= gutterMin) { cut = i; break; }
      i = j;
    }
    if (cut > 0) {
      const sw = cut, sar = sw / ch;
      let sInk = 0;
      for (let i = 0; i < cut; i++) sInk += colInk[i];
      const sRatio = sInk / (sw * ch);
      // 왼쪽 조각이 정사각에 가깝고, 전체의 절반 이하이고, 속이 찬 경우에만 심볼로 인정
      if (sar >= 0.55 && sar <= AR_SPLIT_MAX && cut <= cw * 0.55 && sRatio >= 0.10 && Math.min(sw, ch) >= MIN_SIDE) {
        x1 = x0 + cut - 1;
        cw = sw; ar = sar; inkRatio = sRatio; split = true;
      }
    }
  }

  // 색 분포 — 사진 판별. 6비트로 뭉뚱그려 상위 8색이 몇 %를 덮는지 본다.
  const hist = new Map();
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const [r, g, b] = px(x, y);
      const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      hist.set(k, (hist.get(k) || 0) + 1);
      n++;
    }
  }
  const cover = [...hist.values()].sort((a, b) => b - a).slice(0, 8).reduce((s, v) => s + v, 0) / Math.max(n, 1);

  let reject = null;
  const arMax = split ? AR_SPLIT_MAX : AR_MAX;
  if (ar < AR_MIN || ar > arMax) reject = `워드마크(비율 ${ar.toFixed(2)})`;
  else if (Math.min(cw, ch) < MIN_SIDE) reject = `너무 작음(${cw}x${ch})`;
  else if (inkRatio < INK_MIN) reject = `내용 없음(잉크 ${(inkRatio * 100).toFixed(1)}%)`;
  else if (ringUniform < 0.55) reject = `사진 의심(테두리 ${(ringUniform * 100).toFixed(0)}%)`;
  else if (cover < TOP8_COVER_MIN) reject = `사진 의심(상위8색 ${(cover * 100).toFixed(0)}%)`;

  // 배경색이 흰색이 아니면(예: 검은 타일) 그 배경째로 잘라 써야 모양이 유지된다.
  return {
    reject,
    box: { left: x0, top: y0, width: cw, height: ch },
    bg, ar, inkRatio, cover,
    tint: pickTint(px, W, H, bg, DIFF),
  };
}

/**
 * 로고에서 "브랜드 대표색"을 뽑는다.
 *
 * 왜 필요한가: FMP의 한국 종목 로고는 대부분 가로로 긴 워드마크라 40px 원 안에 넣으면
 * 글자가 뭉갠다(그래서 위 판정에서 떨어진다). 그렇다고 그 종목만 무채색 배지로 두면
 * 삼성전자·셀트리온처럼 제일 많이 보는 이름이 오히려 밋밋해진다.
 * 토스가 하는 방식이 힌트였다 — 워드마크를 브랜드 색 타일에 얹으면, 사람은 글자가 아니라
 * *색과 덩어리*로 알아본다. 그래서 로고는 색만 빌려오고, 그림은 우리가 그린 배지를 쓴다.
 * (색 자체는 저작 대상이 아니고, 화면에 나가는 그림은 100% 우리 것이다.)
 *
 * 방법: 배경색을 뺀 나머지 픽셀을 5비트로 뭉뚱그려 최빈색을 고르고,
 * 흰 글씨가 4.5:1 대비를 넘을 때까지 어둡게 내린다.
 */
function pickTint(px, W, H, bg, DIFF) {
  const hist = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px(x, y);
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) < DIFF) continue;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max - min < 26 && max > 205) continue;          // 거의 흰색 — 배경 잔상
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
  }
  if (!hist.size) return null;
  let best = 0, bestN = -1;
  for (const [k, n] of hist) if (n > bestN) { bestN = n; best = k; }
  let r = ((best >> 10) & 31) * 8 + 4, g = ((best >> 5) & 31) * 8 + 4, b = (best & 31) * 8 + 4;

  /* 회색·검정에 가까운 색은 쓰지 않는다. 건물 사진이나 그라데이션 로고에서 뽑으면
     탁한 회색이 나오는데, 그럴 바엔 코드 해시로 고른 팔레트 색이 훨씬 낫다.
     (null을 돌려주면 화면단이 팔레트로 넘어간다.) */
  {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 40) return null;
  }

  return darkenForWhiteText(r, g, b);
}

/** 흰 글씨가 4.5:1을 넘을 때까지 색을 내린다. 자동 추출값과 손으로 지정한 값 모두 여기를 거친다. */
function darkenForWhiteText(r, g, b) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = () => 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  for (let i = 0; i < 40 && 1.05 / (lum() + 0.05) < 4.55; i++) {
    r = Math.round(r * 0.93); g = Math.round(g * 0.93); b = Math.round(b * 0.93);
  }
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

async function normalise(buf, box) {
  const inner = Math.round(SIZE * (1 - PAD * 2));
  const cropped = await sharp(buf).ensureAlpha().extract(box)
    .resize(inner, inner, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .toBuffer();
  return sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: cropped, gravity: "center" }])
    .webp({ quality: 88, effort: 6 })
    .toBuffer();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stocks = readStocks().slice(0, LIMIT === Infinity ? undefined : LIMIT);
  const accepted = new Set();
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const stats = { total: stocks.length, fetched: 0, missing: 0, accepted: 0, inherited: 0, skipped: 0 };
  const rejects = new Map();
  const prevRejects = (() => {
    if (FORCE || !fs.existsSync(REJECTS)) return new Map();
    try {
      const j = JSON.parse(fs.readFileSync(REJECTS, "utf8"));
      return new Map(Object.entries(j.codes || {}));
    } catch { return new Map(); }
  })();
  const rejectedNow = new Map();
  const tints = new Map();

  let idx = 0;
  async function worker() {
    while (idx < stocks.length) {
      const s = stocks[idx++];
      const out = path.join(OUT_DIR, `${s.code}.webp`);
      if (!FORCE && fs.existsSync(out)) { accepted.add(s.code); stats.accepted++; continue; }
      if (prevRejects.has(s.code)) { rejectedNow.set(s.code, prevRejects.get(s.code)); stats.skipped++; continue; }
      const buf = await fetchLogo(s.code, s.market);
      if (!buf) { stats.missing++; rejectedNow.set(s.code, "이미지 없음"); continue; }
      stats.fetched++;
      let a;
      try { a = await analyse(buf); } catch { a = { reject: "분석 실패" }; }
      if (a && a.tint) tints.set(s.code, a.tint);
      if (!a || a.reject) {
        const why = String(a?.reject || "분석 실패");
        const key = why.replace(/\(.*\)/, "").trim();
        rejects.set(key, (rejects.get(key) || 0) + 1);
        rejectedNow.set(s.code, key);   // 사유만 저장(수치는 빼서 파일을 가볍게)
        continue;
      }
      try {
        fs.writeFileSync(out, await normalise(buf, a.box));
        accepted.add(s.code);
        stats.accepted++;
      } catch { rejects.set("변환 실패", (rejects.get("변환 실패") || 0) + 1); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // 우선주는 보통주 로고를 물려받는다 (005935 → 005930)
  for (const s of stocks) {
    if (accepted.has(s.code)) continue;
    const p = parentCode(s.code);
    if (!p || !accepted.has(p)) continue;
    const src = path.join(OUT_DIR, `${p}.webp`);
    const dst = path.join(OUT_DIR, `${s.code}.webp`);
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
    accepted.add(s.code);
    stats.inherited++;
  }

  // 상장폐지 등으로 목록에서 빠진 코드의 파일은 지운다
  for (const f of fs.readdirSync(OUT_DIR)) {
    const code = f.replace(/\.webp$/, "");
    if (!byCode.has(code) && LIMIT === Infinity) fs.rmSync(path.join(OUT_DIR, f));
  }

  for (const s2 of stocks) {
    if (tints.has(s2.code)) continue;
    const p = parentCode(s2.code);
    if (p && tints.has(p)) tints.set(s2.code, tints.get(p));
  }

  // 손으로 지정한 색이 자동 추출값을 이긴다
  if (fs.existsSync(TINT_OVERRIDES)) {
    try {
      for (const [code, hex] of Object.entries(JSON.parse(fs.readFileSync(TINT_OVERRIDES, "utf8")))) {
        if (!/^\d{6}$/.test(code) || !/^#[0-9a-fA-F]{6}$/.test(hex)) continue;
        // 손으로 적은 색도 대비 검사를 통과하도록 한 번 걸러 넣는다
        tints.set(code, darkenForWhiteText(...hexToRgb(hex.toLowerCase())));
      }
    } catch (e) { console.warn("kr-tint-overrides.json 읽기 실패 — 무시하고 진행", e.message); }
  }

  // 우선주로 상속받은 코드는 탈락 기록에서 뺀다
  for (const c of accepted) rejectedNow.delete(c);
  fs.writeFileSync(
    REJECTS,
    JSON.stringify({ updatedAt: new Date().toISOString(), count: rejectedNow.size, codes: Object.fromEntries([...rejectedNow].sort()) }, null, 0) + "\n",
    "utf8"
  );

  const codes = [...accepted].sort();
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      count: codes.length,
      codes,
      // 로고가 없는 종목의 이니셜 배지에 쓸 브랜드색. 없으면 화면단이 코드 해시로 고른다.
      tints: Object.fromEntries([...tints].filter(([c]) => !accepted.has(c)).sort()),
    }) + "\n",
    "utf8"
  );

  const bytes = fs.readdirSync(OUT_DIR).reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0);
  console.log(`대상 ${stats.total}  받음 ${stats.fetched}  없음 ${stats.missing}  전에 탈락해서 건너뜀 ${stats.skipped}`);
  console.log(`채택 ${stats.accepted} (우선주 상속 ${stats.inherited})  → ${(bytes / 1048576).toFixed(2)}MB`);
  console.log("탈락 사유:", [...rejects.entries()].map(([k, v]) => `${k} ${v}`).join(", "));
  console.log(`manifest: 로고 ${codes.length}종목, 브랜드색 ${[...tints.keys()].filter((c) => !accepted.has(c)).length}종목`);
}

main().catch((e) => { console.error(e); process.exit(1); });
