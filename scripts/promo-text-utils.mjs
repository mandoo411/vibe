/**
 * 카드뉴스 카피용 공통 텍스트 유틸.
 * 헤드라인/코멘트가 글자수로 강제 절단되면서 문장이 어색하게 끊기는 문제를 막기 위해,
 * "완결된 첫 문장"을 우선 찾고 그래도 너무 길면 마지막 쉼표 등 자연스러운 지점에서 자른다.
 */


/**
 * 마침표/느낌표/물음표로 끝나는 첫 완결 문장을 뽑는다.
 * 실제 문장부호(.!?)가 하나라도 있으면 그것을 최우선으로 신뢰한다.
 * 문장부호가 전혀 없는 경우에만("다"/"요"로 어미가 뭉개진 원문 등) "다"/"요" 종결어미로 대체 판단한다.
 * (2026-08-02 수정 — 사용자 피드백: "코스피가 31일... 전 거래일보다"에서 문장이 뚝 끊김.
 *  기존 코드는 "다"/"요" 뒤 공백만 있으면 무조건 문장 끝으로 오인했는데, "거래일보다"의
 *  "보다"(비교 조사, ~than)처럼 종결어미가 아닌 "다"도 공백 앞이면 걸려서 실제 문장 중간에서
 *  잘려나갔다. 원문에 마침표가 있으면 그 마침표까지를 신뢰하는 것이 훨씬 안전하다.)
 */
export function firstCompleteSentence(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  const punctMatch = s.match(/^[\s\S]*?[.!?](?=\s|$)/);
  if (punctMatch) return punctMatch[0].trim();
  const m = s.match(/^[\s\S]*?(?:[다요])(?=\s|$)/);
  return (m ? m[0] : s).trim();
}


/**
 * maxLen 안에 들어오면 그대로, 넘으면 마지막 쉼표/공백 등 자연스러운 지점에서 깔끔하게 자른다.
 * (사용자 피드백에 따라 말줄임표 "…"는 절대 붙이지 않는다)
 */
export function trimToNaturalBreak(text, maxLen) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  const slice = s.slice(0, maxLen);
  const lastBreak = Math.max(slice.lastIndexOf(", "), slice.lastIndexOf("· "), slice.lastIndexOf(" "));
  const cut = lastBreak > maxLen * 0.5 ? slice.slice(0, lastBreak) : slice;
  return cut.replace(/[,·\s]+$/, "");
}


/** 문장이 종결어미/문장부호로 끝났는지 판정한다. 조사·연결어미로 끝나면(예: "~에서", "~며")
 * 문장이 안 끝난 것으로 간주한다 — trimToNaturalBreak가 만든 절단본이 완결됐는지 검증하는 데 쓴다. */
const DANGLING_ENDINGS = ["에서", "으로", "에", "로", "와", "과", "이", "가", "은", "는", "을", "를", "고", "며", "면서", "지만", "라서", "인데", "니까"];
function looksCompleteSentence(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (/[.!?)"'」』%]$/.test(s)) return true;
  if (/[다요임음함]$/.test(s)) return true;
  if (DANGLING_ENDINGS.some((e) => s.endsWith(e))) return false;
  return false;
}


/**
 * 문단에서 "완결된 첫 문장"을 뽑고, 그래도 너무 길면 자연스럽게 잘라 붙인다.
 * (2026-08-02 수정 — 사용자 피드백: "코스피도 오늘은 기술적 반등을 시도할"에서 문장이 끊김.
 *  기존에는 trimToNaturalBreak로 자른 결과를 검증 없이 그대로 반환해서, 이미 완결된 문장이
 *  maxLen보다 길면 그 2차 절단이 문장을 용언 중간(예: "시도할")에서 끊어버렸다. 절단 결과가
 *  완결된 문장처럼 보이지 않으면 길이 제한을 포기하고 완결된 원문장을 그대로 반환한다 —
 *  짧고 미완성인 것보다 길고 완결된 문장이 낫다.)
 */
export function summarizeToSentence(text, maxLen = 90) {
  const sentence = firstCompleteSentence(text);
  if (!sentence) return "";
  if (sentence.length <= maxLen) return sentence;
  const trimmed = trimToNaturalBreak(sentence, maxLen);
  return looksCompleteSentence(trimmed) ? trimmed : sentence;
}
