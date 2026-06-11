/** 경제 캘린더 정규화·이전값 보강 (weekly-schedule / UI 공용) */

export function economicRowsFromResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.economicCalendar)) return data.economicCalendar;
  return [];
}

export function pickEconValue(row, ...keys) {
  for (const key of keys) {
    if (!row || !(key in row)) continue;
    const v = row[key];
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && !v.trim()) continue;
    return v;
  }
  return "";
}

export function mapEconomicRow(row) {
  const timeRaw = String(row.time || row.date || "");
  const date = String(row.date || timeRaw).slice(0, 10);
  const timeMatch = timeRaw.match(/(\d{2}:\d{2})/);
  const time = timeMatch ? timeMatch[1] : String(row.time || "").slice(11, 16) || "";
  const impact = row.impact ?? "";
  const importance = row.importance ?? (String(impact).toLowerCase() === "high" ? 3 : "");
  return {
    date,
    event: row.event || "",
    country: row.country || "",
    time,
    impact: impact || "high",
    importance,
    actual: pickEconValue(row, "actual"),
    previous: pickEconValue(row, "previous", "prev", "prior", "previousValue"),
    estimate: pickEconValue(row, "estimate", "forecast", "consensus"),
    unit: row.unit || "",
  };
}

/** 같은 국가·지표의 직전 발표 actual/이전값을 다음 일정의 이전값으로 채움 */
export function enrichEconomicPrevious(rows) {
  const sorted = [...rows].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : String(a.time).localeCompare(String(b.time));
  });
  const lastValue = new Map();
  for (const row of sorted) {
    const key = `${row.country}|${row.event}`;
    if (row.previous === "" && lastValue.has(key)) {
      row.previous = lastValue.get(key);
    }
    if (row.actual !== "") lastValue.set(key, row.actual);
    else if (row.previous !== "") lastValue.set(key, row.previous);
  }
  return sorted;
}

export function formatEconDisplay(value, unit) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" && !value.trim()) return "—";
  const n = Number(value);
  let text;
  if (Number.isFinite(n)) {
    text = Math.abs(n) >= 1000 ? n.toLocaleString("en-US") : String(n);
  } else {
    text = String(value).trim();
  }
  const u = String(unit || "").trim();
  if (!u || text.endsWith(u)) return text;
  if (u === "%" || u === "％") return `${text}%`;
  return `${text} ${u}`;
}
