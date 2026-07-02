/** Investing.com 경제·실적 캘린더 (Finnhub 대체) */

const INVESTING_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/javascript, */*; q=0.01",
};

const COUNTRY_BY_FLAG_TITLE = {
  "United States": "US",
  "Euro Zone": "EU",
  Australia: "AU",
  China: "CN",
  Germany: "DE",
  Japan: "JP",
  "United Kingdom": "GB",
  Canada: "CA",
  "South Korea": "KR",
  Korea: "KR",
  Mexico: "MX",
  Brazil: "BR",
  India: "IN",
  France: "FR",
  Italy: "IT",
  Spain: "ES",
  Switzerland: "CH",
  Sweden: "SE",
  Norway: "NO",
  "New Zealand": "NZ",
  Singapore: "SG",
  "Hong Kong": "HK",
  Taiwan: "TW",
  Russia: "RU",
  Turkey: "TR",
  "South Africa": "ZA",
  Indonesia: "ID",
  Malaysia: "MY",
  Thailand: "TH",
  Philippines: "PH",
  Vietnam: "VN",
  Poland: "PL",
  Netherlands: "NL",
  Belgium: "BE",
  Austria: "AT",
  Ireland: "IE",
  Portugal: "PT",
  Greece: "GR",
  "Czech Republic": "CZ",
  Hungary: "HU",
  Romania: "RO",
  Chile: "CL",
  Colombia: "CO",
  Argentina: "AR",
  Israel: "IL",
  "Saudi Arabia": "SA",
  UAE: "AE",
};

const CURRENCY_TO_COUNTRY = {
  USD: "US",
  EUR: "EU",
  AUD: "AU",
  CNY: "CN",
  JPY: "JP",
  GBP: "GB",
  CAD: "CA",
  KRW: "KR",
  MXN: "MX",
  BRL: "BR",
  INR: "IN",
  CHF: "CH",
  SEK: "SE",
  NOK: "NO",
  NZD: "NZ",
  SGD: "SG",
  HKD: "HK",
  TWD: "TW",
  RUB: "RU",
  TRY: "TR",
  ZAR: "ZA",
};

function decodeHtml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function investingImpactFromRow(html) {
  const title = (html.match(/class="left textNum sentiment[^"]*"[^>]*title="([^"]*)"/i) || [])[1] || "";
  const bulls = (html.match(/grayFullBullishIcon/gi) || []).length;
  if (/high volatility/i.test(title) || bulls >= 3) return { impact: "high", importance: 3 };
  if (/moderate|medium volatility/i.test(title) || bulls === 2) return { impact: "medium", importance: 2 };
  return { impact: "low", importance: 1 };
}

function countryFromEconomicRow(html) {
  const flagTitle = (html.match(/<span[^>]*title="([^"]+)"[^>]*class="[^"]*ceFlags/i) || [])[1] || "";
  if (COUNTRY_BY_FLAG_TITLE[flagTitle]) return COUNTRY_BY_FLAG_TITLE[flagTitle];
  const currency = (html.match(/class="left flagCur[^"]*"[^>]*>[\s\S]*?ceFlags[^>]*>[\s\S]*?<\/span>\s*([A-Z]{3})\b/i) ||
    [])[1];
  if (currency && CURRENCY_TO_COUNTRY[currency]) return CURRENCY_TO_COUNTRY[currency];
  return flagTitle.slice(0, 2).toUpperCase() || currency || "";
}

function parseInvestingDateTime(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!match) return { date: "", time: "" };
  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    time: `${match[4]}:${match[5]}`,
  };
}

function parseEconomicValue(html, kind) {
  const re = new RegExp(`class="[^"]*event-[^"]*-${kind}[^"]*"[^>]*>([\\s\\S]*?)<\\/td>`, "i");
  const cell = (html.match(re) || [])[1] || "";
  return stripTags(cell).replace(/^\/\s*/, "").trim();
}

export function parseInvestingEconomicRows(html) {
  const rows = [];
  const trs = String(html || "").match(/<tr[^>]*id="eventRowId[^"]*"[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trs) {
    if (/class="theDay"/i.test(tr) || /Holiday/i.test(tr)) continue;
    const { date, time } = parseInvestingDateTime(
      (tr.match(/data-event-datetime="([^"]+)"/i) || [])[1]
    );
    if (!date) continue;
    const eventCell = (tr.match(/<td class="left event"[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || "";
    const event = stripTags(eventCell).replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (!event) continue;
    const { impact, importance } = investingImpactFromRow(tr);
    rows.push({
      date,
      time,
      event,
      country: countryFromEconomicRow(tr),
      impact,
      importance,
      actual: parseEconomicValue(tr, "actual"),
      estimate: parseEconomicValue(tr, "forecast"),
      previous: parseEconomicValue(tr, "previous"),
      unit: "",
    });
  }
  return rows;
}

function earningsHourFromRow(html) {
  const tip = (html.match(/data-tooltip="([^"]+)"/i) || [])[1] || "";
  if (/before market/i.test(tip)) return "bmo";
  if (/after market/i.test(tip)) return "amc";
  if (/during market/i.test(tip)) return "dmh";
  return "";
}

function cleanEstimateValue(value) {
  const text = String(value || "")
    .replace(/^\/\s*/, "")
    .trim();
  return text && text !== "--" ? text : "";
}

function parseEarningsPidDate(html) {
  const match = html.match(/pid-\d+-(\d{4}-\d{2}-\d{2})-/i);
  return match ? match[1] : "";
}

export function parseInvestingEarningsRows(html) {
  const rows = [];
  const trs = String(html || "").match(/<tr[\s\S]*?<\/tr>/gi) || [];
  let currentDate = "";
  for (const tr of trs) {
    const dayMatch = tr.match(/class="theDay"[^>]*>([^<]+)</i);
    if (dayMatch) {
      const parsed = new Date(`${stripTags(dayMatch[1])} 12:00:00 UTC`);
      if (!Number.isNaN(parsed.getTime())) {
        currentDate = parsed.toISOString().slice(0, 10);
      }
      continue;
    }
    if (!tr.includes("earnCalCompany")) continue;
    const symbol = stripTags((tr.match(/target="_blank">([^<]+)</i) || [])[1] || "").toUpperCase();
    if (!symbol) continue;
    const company = stripTags((tr.match(/class="earnCalCompanyName[^"]*"[^>]*>([^<]+)</i) || [])[1] || "");
    const date = parseEarningsPidDate(tr) || currentDate;
    if (!date) continue;
    const cells = [];
    const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(tr)) !== null) {
      cells.push(stripTags(cellMatch[1]));
    }
    rows.push({
      date,
      symbol,
      company,
      hour: earningsHourFromRow(tr),
      epsEstimate: cleanEstimateValue(cells[3]),
      revenueEstimate: cleanEstimateValue(cells[5]),
    });
  }
  return rows;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isYmdInRange(ymd, from, to) {
  return ymd && ymd >= from && ymd <= to;
}

function isoToKstParts(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { date: "", time: "" };
  return {
    date: new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date),
    time: new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date),
  };
}

async function fetchWithRetry(label, fn, { retries = 3, delayMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        console.log(`⚠️ ${label} 재시도 ${attempt}/${retries - 1}: ${error.message}`);
        await sleep(delayMs * attempt);
      }
    }
  }
  throw lastError;
}

async function fetchInvestingHtml(endpoint, referer, fromYmd, toYmd, extraParams = {}) {
  const params = new URLSearchParams({
    dateFrom: fromYmd,
    dateTo: toYmd,
    currentTab: "custom",
    limit_from: "0",
    ...extraParams,
  });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...INVESTING_HEADERS,
      Referer: referer,
      Origin: "https://www.investing.com",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok || text.startsWith("<!DOCTYPE") || text.includes("Just a moment")) {
    throw new Error(`Investing HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Investing invalid JSON: ${text.slice(0, 120)}`);
  }
  return String(payload.data || "");
}

export function parseForexFactoryRows(rows, fromYmd, toYmd) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((row) => {
      const { date, time } = isoToKstParts(row.date);
      if (!isYmdInRange(date, fromYmd, toYmd)) return null;
      const impactRaw = String(row.impact || "");
      const high = impactRaw.toLowerCase() === "high";
      return {
        date,
        time,
        event: String(row.title || "").trim(),
        country: CURRENCY_TO_COUNTRY[String(row.country || "").toUpperCase()] || String(row.country || "").slice(0, 2),
        impact: high ? "high" : impactRaw.toLowerCase() || "medium",
        importance: high ? 3 : impactRaw.toLowerCase() === "medium" ? 2 : 1,
        actual: String(row.actual || "").trim(),
        estimate: String(row.forecast || "").trim(),
        previous: String(row.previous || "").trim(),
        unit: "",
      };
    })
    .filter(Boolean);
}

export async function fetchForexFactoryEconomicCalendar(fromYmd, toYmd) {
  const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
    headers: { accept: "application/json", "user-agent": "TotalMoneyAI/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok || !text.trim().startsWith("[")) {
    throw new Error(`ForexFactory HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  const rows = parseForexFactoryRows(JSON.parse(text), fromYmd, toYmd);
  console.log(`✅ ForexFactory 경제캘린더 ${fromYmd}~${toYmd} (${rows.length}건)`);
  return rows;
}

function addDaysYmd(ymd, days) {
  const date = new Date(`${ymd}T12:00:00+09:00`);
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function fetchInvestingEconomicChunk(fromYmd, toYmd) {
  const html = await fetchWithRetry(`Investing 경제 ${fromYmd}~${toYmd}`, () =>
    fetchInvestingHtml(
      "https://www.investing.com/economic-calendar/Service/getCalendarFilteredData",
      "https://www.investing.com/economic-calendar/",
      fromYmd,
      toYmd,
      { timeZone: "88", timeFilter: "timeRemain" }
    )
  );
  return parseInvestingEconomicRows(html);
}

export async function fetchInvestingEconomicCalendar(fromYmd, toYmd) {
  const CHUNK_DAYS = 14;
  const all = [];
  let cursor = fromYmd;
  while (cursor <= toYmd) {
    const chunkEnd = addDaysYmd(cursor, CHUNK_DAYS - 1);
    const end = chunkEnd > toYmd ? toYmd : chunkEnd;
    try {
      const rows = await fetchInvestingEconomicChunk(cursor, end);
      all.push(...rows);
      console.log(`✅ Investing 경제캘린더 ${cursor}~${end} (${rows.length}건)`);
    } catch (error) {
      console.log(`❌ Investing 경제캘린더 ${cursor}~${end} 실패: ${error.message}`);
    }
    if (end >= toYmd) break;
    cursor = addDaysYmd(end, 1);
    await sleep(400);
  }
  const merged = mergeEconomicRows(all);
  console.log(`✅ Investing 경제캘린더 합계 ${fromYmd}~${toYmd} (${merged.length}건)`);
  if (!merged.length) throw new Error("Investing 경제캘린더 수집 실패");
  return merged;
}

export async function fetchFMPEconomicCalendar(fromYmd, toYmd, apiKey) {
  if (!apiKey) throw new Error("FMP_API_KEY not set");
  const url = `https://financialmodelingprep.com/stable/economic-calendar?from=${fromYmd}&to=${toYmd}&apikey=${apiKey}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "TotalMoneyAI/1.0" },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FMP HTTP ${res.status}: ${text.slice(0, 120)}`);
  let rows;
  try { rows = JSON.parse(text); } catch { throw new Error(`FMP invalid JSON: ${text.slice(0, 120)}`); }
  if (!Array.isArray(rows)) throw new Error(`FMP unexpected response: ${text.slice(0, 120)}`);
  const IMPACT = { High: "high", Medium: "medium", Low: "low" };
  const IMP_NUM = { High: 3, Medium: 2, Low: 1 };
  const result = rows.map((row) => {
    // FMP date: "2026-07-02 08:30:00" — treat as UTC
    const iso = String(row.date || "").replace(" ", "T") + (String(row.date || "").includes("T") ? "" : "Z");
    const { date, time } = isoToKstParts(iso);
    if (!date) return null;
    const impRaw = String(row.impact || "Low");
    return {
      date,
      time,
      event: String(row.event || "").trim(),
      country: String(row.country || "").trim(),
      impact: IMPACT[impRaw] || "low",
      importance: IMP_NUM[impRaw] || 1,
      actual: String(row.actual ?? "").trim(),
      estimate: String(row.estimate ?? "").trim(),
      previous: String(row.previous ?? "").trim(),
      unit: "",
    };
  }).filter(Boolean);
  console.log(`✅ FMP 경제캘린더 ${fromYmd}~${toYmd} (${result.length}건)`);
  return result;
}

function economicRowKey(row) {
  const date = String(row?.date || row?.time || "").slice(0, 10);
  return `${date}|${row?.country || ""}|${row?.event || ""}`;
}

function mergeEconomicRows(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      if (!row?.date || !row?.event) continue;
      const key = economicRowKey(row);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, row);
        continue;
      }
      // Prefer row with more filled forecast/actual fields
      const score = (r) =>
        [r.actual, r.estimate, r.previous].filter((v) => v != null && String(v).trim()).length;
      if (score(row) > score(prev)) byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : String(a.time || "").localeCompare(String(b.time || ""));
  });
}

export async function fetchEconomicCalendar(fromYmd, toYmd) {
  const batches = [];
  const fmpKey = process.env.FMP_API_KEY;
  if (fmpKey) {
    try {
      batches.push(await fetchFMPEconomicCalendar(fromYmd, toYmd, fmpKey));
    } catch (error) {
      console.log(`❌ FMP 경제캘린더 실패: ${error.message}`);
    }
  }
  try {
    batches.push(await fetchInvestingEconomicCalendar(fromYmd, toYmd));
  } catch (error) {
    console.log(`❌ Investing 경제캘린더 실패: ${error.message}`);
  }
  try {
    batches.push(await fetchForexFactoryEconomicCalendar(fromYmd, toYmd));
  } catch (error) {
    console.log(`❌ ForexFactory 경제캘린더 실패: ${error.message}`);
  }
  const merged = mergeEconomicRows(...batches);
  if (!merged.length) {
    console.log("❌ 경제캘린더: 모든 소스 실패");
  } else {
    console.log(`✅ 경제캘린더 병합 ${fromYmd}~${toYmd} (${merged.length}건, 소스 ${batches.length}개)`);
  }
  return merged;
}

export async function fetchInvestingEarningsCalendar(fromYmd, toYmd) {
  const text = await fetchWithRetry("Investing 실적", async () => {
    const params = { timeZone: "88", timeFilter: "timeRemain" };
    const body = new URLSearchParams({
      dateFrom: fromYmd,
      dateTo: toYmd,
      currentTab: "custom",
      limit_from: "0",
      ...params,
    });
    body.append("country[]", "5");
    const res = await fetch("https://www.investing.com/earnings-calendar/Service/getCalendarFilteredData", {
      method: "POST",
      headers: {
        ...INVESTING_HEADERS,
        Referer: "https://www.investing.com/earnings-calendar/",
        Origin: "https://www.investing.com",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30000),
    });
    const raw = await res.text();
    if (!res.ok || raw.startsWith("<!DOCTYPE")) {
      throw new Error(`Investing earnings HTTP ${res.status}: ${raw.slice(0, 120)}`);
    }
    return raw;
  });
  const payload = JSON.parse(text);
  const rows = parseInvestingEarningsRows(String(payload.data || ""));
  console.log(`✅ Investing 실적캘린더 ${fromYmd}~${toYmd} (${rows.length}건, US)`);
  return rows;
}
