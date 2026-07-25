/**
 * Gemini(Nano Banana) 이미지 생성 모델로 릴스 배경 이미지를 만든다.
 *
 * ⚠️ 설계 원칙: 이 이미지에는 절대 텍스트/숫자/한글을 넣지 않는다. AI 이미지 생성 모델은
 * 텍스트 렌더링이 부정확해서(특히 한글·숫자), 데이터 카드에 그대로 쓰면 "틀린 정보"가
 * 나올 위험이 있다 (사용자 피드백: 문구/숫자 정확성 최우선). 지수·헤드라인·AI 코멘트 등
 * 정확해야 하는 텍스트는 지금까지처럼 HTML/CSS로 코드가 직접 그리고, 여기서는 순수
 * 배경 비주얼(그라디언트·추상 패턴)만 생성해서 그 위에 얹는다.
 *
 * GEMINI_API_KEY가 없거나 API 호출이 실패해도 릴스 발행 자체가 막히면 안 되므로,
 * 실패 시 fallbackBackgroundDataUri()로 안전하게 대체한다.
 */

const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function buildPrompt(dir) {
  const moodMap = {
    up: "warm, energetic mood with subtle crimson-red glow accents, gentle upward-flowing abstract motion",
    down: "cool, tense mood with subtle blue glow accents, gentle downward-flowing abstract motion",
    flat: "calm, balanced mood with soft neutral abstract motion",
  };
  const mood = moodMap[dir] || moodMap.flat;
  return [
    "Abstract premium fintech background art, portrait 9:16 aspect ratio, for a Korean stock market AI news brand.",
    "Deep navy (#07264b) and teal (#0f8387) as the two dominant colors, with small gold (#f59e0b) accent highlights.",
    `${mood}.`,
    "Abstract flowing lines and soft glowing particles loosely inspired by candlestick charts, cinematic depth, elegant and modern.",
    "The bottom two-thirds of the image should be visually calmer and lower-contrast so white overlay text stays readable.",
    "IMPORTANT: absolutely no text, no numbers, no letters, no words, no UI elements, no chart labels, no logos, no watermarks anywhere in the image — pure abstract background art only.",
  ].join(" ");
}

/** Gemini로 배경 이미지를 생성해 data URI(base64)로 반환한다. dir: 'up' | 'down' | 'flat' */
export async function generateReelBackground(dir = "flat") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다.");
  }

  const res = await fetch(`${API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(dir) }] }],
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

/** Gemini 우선 시도 -> 실패하면 조용히 폴백. 워크플로우 로그에 이유만 남긴다. */
export async function getReelBackground(dir = "flat") {
  try {
    return await generateReelBackground(dir);
  } catch (err) {
    console.warn(`[promo-gemini-background] Gemini 생성 실패, 폴백 배경 사용: ${err.message}`);
    return fallbackBackgroundDataUri(dir);
  }
}
