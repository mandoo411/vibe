/**
 * 카드뉴스 덱 생성 공통부 — AI 호출 이중화, 문장 정리, 캡션 조립.
 * 마감시황·아침브리핑·글로벌랭킹 세 빌더가 같은 규칙을 쓰도록 여기 모았다.
 */
import Anthropic from "@anthropic-ai/sdk";

export function parseJson(text) {
  const s = String(text ?? "");
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSON을 찾지 못했습니다");
  return JSON.parse(m[0]);
}

/** 태그를 살린 채 첫 문장만 남긴다. 모델이 훅에 문장을 덧붙이는 걸 코드가 잘라낸다. */
export function firstSentence(html) {
  const s = String(html ?? "");
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "<") depth++;
    else if (c === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "." || c === "!" || c === "?")) {
      // "4.60%" 처럼 숫자 사이의 마침표는 문장 끝이 아니다.
      // (이걸 빼먹어 훅이 "한국 ETF가 ▲ 4." 로 잘린 적이 있다)
      if (c === "." && /\d/.test(s[i - 1] || "") && /\d/.test(s[i + 1] || "")) continue;
      const rest = s.slice(i + 1).replace(/<br\s*\/?>/gi, "").trim();
      if (rest.length > 0) return s.slice(0, i + 1);
    }
  }
  return s;
}

export async function callClaude(system, prompt, apiKey = process.env.ANTHROPIC_API_KEY) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY 없음");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  const client = new Anthropic({ apiKey: key, maxRetries: 3, timeout: 120_000 });
  const res = await client.messages.create({
    model, max_tokens: 4000, system, messages: [{ role: "user", content: prompt }],
  });
  const text = (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return parseJson(text);
}

export async function callOpenAI(system, prompt, apiKey = process.env.OPENAI_API_KEY) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("OPENAI_API_KEY 없음");
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, temperature: 0.6, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status} ${String(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return parseJson(data?.choices?.[0]?.message?.content ?? "");
}

/**
 * 캡션 조립. 첫 두 줄이 '더 보기' 전에 보이는 전부라, 1번 카드의 훅을 그대로 반복한다.
 * 해시태그는 대형 3 / 중형 6 / 그날 테마 3~4 / 브랜드 1 비율로 섞는다 —
 * 과포화 키워드만 쓰면 작은 계정은 노출이 잡히지 않는다.
 */
const TAGS_BIG = ["주식", "재테크", "주식투자"];
const TAGS_MID = ["주식초보", "국내주식", "증시브리핑", "종목분석", "경제공부", "주식공부중"];
const TAG_BRAND = "토탈머니";

export function composeCaption({ hook, sub, lines = [], themeTags = [], saveLine, ctaLine, extraTags = [] }) {
  // <br>을 그냥 지우면 단어가 붙는다. 줄바꿈 태그는 공백으로 바꾼다.
  const strip = (s) => String(s ?? "")
    .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

  const clean = (t) => String(t).replace(/[^가-힣A-Za-z0-9]/g, "");
  const tags = [...new Set([
    ...TAGS_BIG, ...TAGS_MID,
    ...extraTags.map(clean).filter(Boolean),
    ...themeTags.map(clean).filter(Boolean).slice(0, 4),
    TAG_BRAND,
  ])];

  return [
    strip(hook),
    strip(sub),
    "",
    ...lines.slice(0, 3).map((l) => `· ${strip(l)}`).filter((l) => l !== "· "),
    "",
    saveLine,
    ctaLine,
    "전체 리포트 → totalmoney.kr",
    "",
    "※ 투자 참고용 정보이며, 투자 판단 및 그 결과에 대한 책임은 투자자 본인에게 있습니다.",
    "",
    tags.map((t) => `#${t}`).join(" "),
  ].join("\n");
}
