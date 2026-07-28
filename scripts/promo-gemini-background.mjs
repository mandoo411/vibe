/**
 * Gemini(Nano Banana) 이미지 생성 모델로 릴스 배경 이미지를 만든다.
 *
 * ⚠️ 설계 원칙: 이 이미지에는 절대 텍스트/숫자/한글을 넣지 않는다. AI 이미지 생성 모델은
 * 텍스트 렌더링이 부정확해서(특히 한글·숫자), 데이터 카드에 그대로 쓰면 "틀린 정보"가
 * 나올 위험이 있다 (사용자 피드백: 문구/숫자 정확성 최우선). 지수·헤드라인·AI 코멘트 등
 * 정확해야 하는 텍스트는 지금까지처럼 HTML/CSS로 코드가 직접 그리고, 여기서는 순수
 * 배경 비주얼(그라디언트·추상 패턴)만 생성해서 그 위에 얹는다.
 *
 * 우선순위: Gemini -> (실패 시) OpenAI GPT Image -> (그마저 실패 시) 순수 CSS 그라디언트.
 * 어느 단계에서 실패하든 릴스 발행 자체가 막히면 안 되므로 항상 마지막엔
 * fallbackBackgroundDataUri()로 안전하게 대체한다.
 */

const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const OPENAI_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const OPENAI_API_URL = "https://api.openai.com/v1/images/generations";

function buildPrompt(dir) {
  const moodMap = {
    up: {
      scene:
        "the mascot beaming with an ecstatic, triumphant grin, both arms raised in celebration, eyes sparkling with joy, a couple of small hand-drawn gold coins and a simple upward arrow doodle floating near it",
      glow: "warm golden-red glow",
    },
    down: {
      scene:
        "the mascot sweating anxiously with a nervous, worried frown, one hand wiping a sweat drop from its forehead, shoulders slumped, a simple downward arrow doodle and a couple of falling-coin sketches floating near it",
      glow: "cool tense blue glow",
    },
    flat: {
      scene:
        "the mascot with a calm, neutral shrugging expression, arms held slightly out to the sides, looking thoughtfully at a simple flat-line doodle floating near it",
      glow: "soft neutral glow",
    },
  };
  const m = moodMap[dir] || moodMap.flat;
  return [
    "Satirical editorial-cartoon illustration (시사 만평 style), portrait 9:16 aspect ratio, for a Korean stock market AI news brand mascot.",
    "Main subject: an original, brand-new cartoon frog mascot character — this is NOT Pepe the Frog and must not resemble any existing copyrighted meme character or franchise mascot. Design it from scratch: simple rounded body, smooth green skin, big round expressive eyes, wearing a small necktie, friendly and professional-looking but with an exaggerated caricature expression reacting to today's stock market news.",
    `${m.scene}.`,
    "Deep navy (#07264b) and teal (#0f8387) as the two dominant background colors, with small gold (#f59e0b) accents, matching a premium fintech brand look.",
    `${m.glow} lighting around the character.`,
    "Compose the mascot and its doodles in the upper half of the frame only — the lower two-thirds of the image must stay visually calm, empty, and low-contrast so white overlay text stays readable.",
    "Clean flat-cartoon illustration style, bold outlines, simple cel shading, modern and playful yet professional — not photorealistic.",
    "IMPORTANT: absolutely no text, no numbers, no letters, no words, no logos, no watermarks, no chart axis labels anywhere in the image — pure illustration only, no readable characters of any kind.",
  ].join(" ");
}

/** Gemini로 배경 이미지를 생성해 data URI(base64)로 반환한다.
 * dir: 'up' | 'down' | 'flat'. promptText를 직접 넘기면 buildPrompt(만평 마스코트) 대신 그 프롬프트를 사용한다
 * (마감 시황 릴스 포맷별로 다른 프롬프트를 쓸 수 있도록 — 예: 시가총액 TOP10 포맷은 buildCyberSpacePrompt 사용). */
export async function generateReelBackground(dir = "flat", promptText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다.");
  }

  const res = await fetch(`${API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText || buildPrompt(dir) }] }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: "9:16" },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini 이미지 생성 실패 (HTTP ${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p?.inlineData?.data);
  if (!imgPart) {
    throw new Error("Gemini 응답에서 이미지 데이터를 찾지 못했습니다: " + JSON.stringify(data).slice(0, 300));
  }
  const mime = imgPart.inlineData.mimeType || "image/png";
  return `data:${mime};base64,${imgPart.inlineData.data}`;
}

/** Gemini가 실패했을 때(무료 할당량 초과 등) 쓰는 2차 폴백: OpenAI GPT Image로 배경을 생성한다.
 * 9:16에 가장 가까운 세로 규격(1024x1536)을 사용 — 어차피 .bg-art는 object-fit: cover라
 * 정확히 1080x1920이 아니어도 화면을 꽉 채운다. */
export async function generateOpenAIBackground(dir = "flat", promptText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY 환경변수가 설정되어 있지 않습니다.");
  }

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      prompt: promptText || buildPrompt(dir),
      size: "1024x1536",
      quality: "medium",
      n: 1,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI 이미지 생성 실패 (HTTP ${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI 응답에서 이미지 데이터를 찾지 못했습니다: " + JSON.stringify(data).slice(0, 300));
  }
  return `data:image/png;base64,${b64}`;
}

/** Gemini 우선(키 미설정, 요금 초과, 네트워크 오류 등) 시 안전하게 쓰는 순수 CSS 그라디언트 배경.
 * 기존 카드뉴스와 동일한 브랜드 컬러 톤을 사용해 최소한 톤앤매너는 어긋나지 않게 한다. */
export function fallbackBackgroundDataUri(dir = "flat") {
  const colorMap = {
    up: ["#3a0d0d", "#07264b"],
    down: ["#07264b", "#0f8387"],
    flat: ["#1a2b3d", "#0f8387"],
  };
  const [c1, c2] = colorMap[dir] || colorMap.flat;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
    </linearGradient></defs>
    <rect width="1080" height="1920" fill="url(#g)"/>
    <circle cx="850" cy="300" r="380" fill="#ffffff" opacity="0.05"/>
    <circle cx="150" cy="1600" r="300" fill="#ffffff" opacity="0.06"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** Gemini 우선 시도 -> 실패하면 OpenAI(GPT Image) 시도 -> 그마저 실패하면 조용히 CSS 폴백.
 * 워크플로우 로그에 각 단계 실패 이유만 남긴다. */
export async function getReelBackground(dir = "flat") {
  try {
    return await generateReelBackground(dir);
  } catch (geminiErr) {
    console.warn(`[promo-gemini-background] Gemini 생성 실패: ${geminiErr.message}`);
    try {
      const img = await generateOpenAIBackground(dir);
      console.warn("[promo-gemini-background] OpenAI(GPT Image)로 폴백 생성 성공");
      return img;
    } catch (openaiErr) {
      console.warn(`[promo-gemini-background] OpenAI 폴백도 실패, CSS 그라디언트 사용: ${openaiErr.message}`);
      return fallbackBackgroundDataUri(dir);
    }
  }
}

/**
 * "시가총액 TOP10" 마감 시황 릴스용 배경 — 사이버틱 + 우주 컨셉.
 * 만평(개구리 마스코트) 포맷과 달리 캐릭터가 없다: 별/성운/고리 행성/사이버 그리드 같은
 * 추상 비주얼만 생성한다 (원칙은 동일 — 텍스트/숫자/한글 절대 금지, 정확한 데이터는 코드가 그림).
 */
function buildCyberSpacePrompt(dir) {
  const moodMap = {
    up: { glow: "warm crimson-and-gold nebula glow, energetic upward-streaking light trails" },
    down: { glow: "cool electric-blue nebula glow, tense downward-drifting light particles" },
    flat: { glow: "balanced teal-and-violet nebula glow, calm drifting particles" },
  };
  const m = moodMap[dir] || moodMap.flat;
  return [
    "Abstract cyberpunk-meets-outer-space digital background illustration, portrait 9:16 aspect ratio, for a premium Korean fintech AI brand.",
    "Deep space scene: a dark navy-to-teal gradient sky filled with a starfield of small twinkling stars, a few soft glowing nebula clouds, and one small distant ringed planet in the upper area.",
    "A faint neon cyber grid horizon (thin glowing perspective grid lines) crosses the lower third of the frame, like a retro-futuristic digital landscape.",
    `${m.glow}.`,
    "Dominant palette: deep navy (#07264b), teal (#0f8387), with small gold (#d4af37) accents and the glow color described above — premium fintech, not garish.",
    "The lower two-thirds of the frame must stay visually calm, low-contrast and uncluttered so white/light overlay text and UI cards stay easily readable on top of it.",
    "Clean modern digital-art style, smooth gradients, subtle glow and bloom, no photorealistic textures.",
    "IMPORTANT: absolutely no text, no numbers, no letters, no words, no logos, no watermarks, no UI elements, no characters or mascots of any kind — pure abstract background art only.",
  ].join(" ");
}

/** Gemini 우선 -> OpenAI -> (JS로 직접 그리는) 사이버+우주 SVG 그라디언트 순으로 시도. */
export async function getMarketcapReelBackground(dir = "flat") {
  const prompt = buildCyberSpacePrompt(dir);
  try {
    return await generateReelBackground(dir, prompt);
  } catch (geminiErr) {
    console.warn(`[promo-gemini-background] (marketcap) Gemini 생성 실패: ${geminiErr.message}`);
    try {
      const img = await generateOpenAIBackground(dir, prompt);
      console.warn("[promo-gemini-background] (marketcap) OpenAI(GPT Image)로 폴백 생성 성공");
      return img;
    } catch (openaiErr) {
      console.warn(`[promo-gemini-background] (marketcap) OpenAI 폴백도 실패, SVG 사이버 배경 사용: ${openaiErr.message}`);
      return fallbackCyberSpaceBackgroundDataUri(dir);
    }
  }
}

/** API가 전부 실패했을 때 쓰는 최종 폴백 — 코드로 직접 그리는 사이버+우주 SVG (별/성운/고리행성/그리드). */
export function fallbackCyberSpaceBackgroundDataUri(dir = "flat") {
  const glowMap = {
    up: "#f2545b",
    down: "#3b82f6",
    flat: "#7c6bf2",
  };
  const glow = glowMap[dir] || glowMap.flat;

  // 결정적(seeded) 의사난수 — 매번 같은 배치를 그리되 외부 라이브러리 의존 없이 구현.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 10000) / 10000;
  };

  const W = 1080, H = 1920;
  let stars = "";
  for (let i = 0; i < 180; i++) {
    const x = (rand() * W).toFixed(1);
    const y = (rand() * H).toFixed(1);
    const r = (0.5 + rand() * 1.8).toFixed(2);
    const op = (0.25 + rand() * 0.65).toFixed(2);
    stars += `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="${op}"/>`;
  }

  const horizonY = H * 0.62;
  let grid = "";
  for (let i = 0; i < 12; i++) {
    const t = i / 11;
    const y = horizonY + t * t * (H - horizonY) * 1.15;
    const op = (0.2 * (1 - t) + 0.03).toFixed(3);
    grid += `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="#5be3d8" stroke-width="1.2" opacity="${op}"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#020a17"/>
        <stop offset="38%" stop-color="#07264b"/>
        <stop offset="72%" stop-color="#0b3a52"/>
        <stop offset="100%" stop-color="#0f8387"/>
      </linearGradient>
      <radialGradient id="glow1" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="${glow}" stop-opacity="0.42"/>
        <stop offset="100%" stop-color="${glow}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="glowGold" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#d4af37" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#d4af37" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="planetBody" cx="35%" cy="32%" r="70%">
        <stop offset="0%" stop-color="#bff4ec"/>
        <stop offset="45%" stop-color="#28b3a6"/>
        <stop offset="100%" stop-color="#052a3a"/>
      </radialGradient>
      <filter id="blurL"><feGaussianBlur stdDeviation="55"/></filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#sky)"/>
    <ellipse cx="120" cy="260" rx="360" ry="300" fill="url(#glow1)" filter="url(#blurL)"/>
    <ellipse cx="950" cy="120" rx="300" ry="260" fill="url(#glowGold)" filter="url(#blurL)"/>
    <ellipse cx="880" cy="1500" rx="380" ry="340" fill="url(#glow1)" filter="url(#blurL)"/>
    ${stars}
    <circle cx="945" cy="195" r="72" fill="url(#planetBody)" opacity="0.9"/>
    <ellipse cx="945" cy="195" rx="118" ry="20" fill="none" stroke="#8be9e0" stroke-width="4" opacity="0.55" transform="rotate(-18 945 195)"/>
    ${grid}
    <line x1="0" y1="${horizonY.toFixed(1)}" x2="${W}" y2="${horizonY.toFixed(1)}" stroke="#5be3d8" stroke-width="1.6" opacity="0.28"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
