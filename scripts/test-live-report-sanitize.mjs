#!/usr/bin/env node
/** 로컬 검증: node scripts/test-live-report-sanitize.mjs */

function sanitizeUnicode(value) {
  const s = String(value ?? "");
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(new TextEncoder().encode(s));
  } catch {
    return s.replace(/[\uD800-\uDFFF]/g, "");
  }
}

function compactText(value, limit = 150) {
  let clean = sanitizeUnicode(String(value)).replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  clean = sanitizeUnicode(clean.slice(0, limit - 1));
  return `${clean}…`;
}

function ensureJsonSafe(value, maxLen = 80_000) {
  let s = sanitizeUnicode(value);
  if (s.length > maxLen) s = `${sanitizeUnicode(s.slice(0, maxLen - 1))}…`;
  JSON.parse(JSON.stringify({ t: s }));
  return s;
}

const cases = [
  "plain text",
  "emoji \uD83D\uDE00 end",
  "\uD83D only high",
  "\uDE00 only low",
  "가".repeat(200) + "\uD83D\uDE00" + "나".repeat(200),
];

let ok = 0;
for (const c of cases) {
  const compact = compactText(c, 105);
  ensureJsonSafe(compact);
  ensureJsonSafe(c);
  ok++;
}
console.log(`OK ${ok}/${cases.length} sanitize cases`);
