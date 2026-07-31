/** 네이버금융 "기업실적분석" 표에서 확정된(추정치 아님) 분기 매출액·영업이익·당기순이익을
 * 읽어온다. DART list.json은 공시가 "존재한다"는 사실만 알려줄 뿐 실제 수치를 안 주기
 * 때문에(2026-07-31 확인), 종목코드 기준으로 이 표를 대신 참고한다.
 *
 * 중요: 이 표의 마지막 분기 컬럼은 실제 공시 전에는 컨센서스 추정치이며 헤더에
 * "(E)"가 붙는다. 프로젝트 전체 원칙("실데이터 없으면 표시 안 함")에 따라, 대상 분기
 * 컬럼이 아직 "(E)"로 표시돼 있으면(=네이버·FnGuide 쪽 반영이 DART 공시보다 늦어
 * 아직 확정치로 안 바뀐 경우) 수치를 절대 채우지 않고 null을 반환한다.
 */

const UNIT_EOK = 100_000_000; // 억원

function stripTags(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#40;/g, "(")
    .replace(/&#41;/g, ")")
    .replace(/&amp;/g, "&")
    .trim();
}

function extractTagBlocks(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  return html.match(re) || [];
}

function parseNaverFinanceSummary(html) {
  const idx = html.indexOf("기업실적분석 테이블");
  if (idx < 0) return null;
  const tableStart = html.lastIndexOf("<table", idx);
  const tableEnd = html.indexOf("</table>", idx);
  if (tableStart < 0 || tableEnd < 0) return null;
  const table = html.slice(tableStart, tableEnd + "</table>".length);

  const theadMatch = table.match(/<thead[^>]*>[\s\S]*?<\/thead>/i);
  const tbodyMatch = table.match(/<tbody[^>]*>[\s\S]*?<\/tbody>/i);
  if (!theadMatch || !tbodyMatch) return null;

  const headRows = extractTagBlocks(theadMatch[0], "tr");
  let periodRow = null;
  for (const row of headRows) {
    const matches = row.match(/\d{4}\.\d{2}/g) || [];
    if (matches.length >= 5) {
      periodRow = row;
      break;
    }
  }
  if (!periodRow) return null;
  const periodCells = extractTagBlocks(periodRow, "th").map(stripTags);

  function findRow(label) {
    const rows = extractTagBlocks(tbodyMatch[0], "tr");
    for (const row of rows) {
      const thMatch = row.match(/<th[^>]*>([\s\S]*?)<\/th>/i);
      const rowLabel = thMatch ? stripTags(thMatch[1]) : "";
      if (rowLabel === label) {
        return extractTagBlocks(row, "td").map(stripTags);
      }
    }
    return null;
  }

  return {
    periodCells,
    revenue: findRow("매출액"),
    operatingProfit: findRow("영업이익"),
    netIncome: findRow("당기순이익"),
  };
}

/** 잠정실적 공시는 보통 분기 종료 후 2~5주 내에 나온다. 공시일 기준으로 "가장 최근에
 * 끝난 분기"를 역산한다(공시월의 전월을 기준으로 3/6/9/12월 중 가장 가까운 분기말). */
function nearestReportedQuarter(ymd) {
  const [y, m] = String(ymd || "").split("-").map(Number);
  if (!y || !m) return null;
  const cutoffMonth = m - 1 <= 0 ? 12 : m - 1;
  const cutoffYear = m - 1 <= 0 ? y - 1 : y;
  const ends = [3, 6, 9, 12];
  let best = null;
  for (const qm of ends) {
    if (qm <= cutoffMonth) best = qm;
  }
  if (best == null) return { year: cutoffYear - 1, month: 12 };
  return { year: cutoffYear, month: best };
}

function parseAmount(text) {
  const t = String(text || "").trim();
  if (!t || t === "-" || t === "N/A") return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractQuarterFigures(summary, targetLabel) {
  if (!summary?.periodCells?.length) return null;
  const idx = summary.periodCells.findIndex((cell) => {
    const clean = cell.replace(/\s*\(E\)\s*$/i, "").trim();
    return clean === targetLabel;
  });
  if (idx < 0) return null;
  const cell = summary.periodCells[idx];
  if (/\(E\)/i.test(cell)) return null; // 아직 컨센서스 추정치 — 확정 전까지 표시 안 함

  const revenue = parseAmount(summary.revenue?.[idx]);
  const operatingProfit = parseAmount(summary.operatingProfit?.[idx]);
  const netIncome = parseAmount(summary.netIncome?.[idx]);
  if (revenue == null && operatingProfit == null && netIncome == null) return null;

  return {
    periodLabel: cell,
    revenueEok: revenue,
    operatingProfitEok: operatingProfit,
    netIncomeEok: netIncome,
  };
}

export async function fetchKrEarningsActual(code, referenceDate) {
  const quarter = nearestReportedQuarter(referenceDate);
  if (!quarter) return null;
  const targetLabel = `${quarter.year}.${String(quarter.month).padStart(2, "0")}`;

  const res = await fetch(`https://finance.naver.com/item/main.naver?code=${encodeURIComponent(code)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Naver Finance HTTP ${res.status}`);
  const html = await res.text();
  const summary = parseNaverFinanceSummary(html);
  if (!summary) return null;
  return extractQuarterFigures(summary, targetLabel);
}

export function formatEokToKo(eok) {
  if (eok == null || !Number.isFinite(eok)) return "";
  const jo = eok / 10000;
  if (Math.abs(jo) >= 1) {
    return `${jo.toLocaleString("ko-KR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}조원`;
  }
  return `${Math.round(eok).toLocaleString("ko-KR")}억원`;
}

export const __internal = { parseNaverFinanceSummary, nearestReportedQuarter, extractQuarterFigures };
