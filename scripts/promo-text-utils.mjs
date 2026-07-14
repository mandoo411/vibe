/**
 * 카드뉴스 카피용 공통 텍스트 유틸.
 * 헤드라인/코멘트가 글자수로 강제 절단되면서 문장이 어색하게 끊기는 문제를 막기 위해,
 * "완결된 첫 문장"을 우선 찾고 그래도 너무 길면 마지막 쉼표 등 자연스러운 지점에서 자른다.
 */

/** 마침표/"다"/"요"/느낌표/물음표로 끝나는 첫 완결 문장을 뽑는다 */
export function firstCompleteSentence(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  const m = s.match(/^[\s\S]*?(?:[.!?]|[다요])(?=\s|$)/);
  return (m ? m[0] : s).trim();
}

/**
 * maxLen 안에 들어오면 그대로, 넘으면 마지막 쉼표/공백 등 자연스러운 지점에서 잘라 "…" 붙인다.
 * (완결 문장이 이미 맥락상 끝난 상태라면 굳이 "…"를 붙이지 않는다)
 */
export function trimToNaturalBreak(text, maxLen) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  const slice = s.slice(0, maxLen);
  const lastBreak = Math.max(slice.lastIndexOf(", "), slice.lastIndexOf("· "), slice.lastIndexOf(" "));
  const cut = lastBreak > maxLen * 0.5 ? slice.slice(0, lastBreak) : slice;
  return cut.replace(/[,·\s]+$/, "") + "…";
}

/** 문단에서 "완결된 첫 문장"을 뽑고, 그래도 너무 길면 자연스럽게 잘라 붙인다 */
export function summarizeToSentence(text, maxLen = 90) {
  const sentence = firstCompleteSentence(text);
  return trimToNaturalBreak(sentence, maxLen);
}
