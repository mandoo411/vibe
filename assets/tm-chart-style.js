/**
 * 2026-09-25 사이트 공용 캔들 차트 마무리 규칙 — 차트 코드가 네 군데(국내주식·미국/암호화폐·AI 종목분석·매매시그널)에
 * 따로 있어서 한 곳을 고치면 다른 곳이 그대로 남는 일이 반복됐다. 공통 규칙은 여기 한 곳에서만 정한다.
 *
 *   TMChartStyle.fit(chart, candles, market)
 *     - 가로·세로 격자선 제거
 *     - 가격 눈금: 국내는 콤마 정수(286,500), 미국·코인은 $와 자릿수 자동
 *     - 거래량이 깔리는 차트 아래쪽에 "-40,000" 같은 음수·무의미한 가격 눈금이 찍히던 것:
 *       실제 최저가보다 아래 값의 눈금은 비워 둔다(크로스헤어 값 표시는 실제 가격 범위라 영향 없음)
 *   캔들 데이터를 넣을 때마다(기간 전환 포함) 다시 부르면 된다.
 *
 *   TMChartStyle.recent(chart)
 *     - fitContent 대신 사용. 일봉 400개를 한 화면에 다 넣으면 캔들이 납작한 선이 되므로
 *       차트 폭에 맞춰(약 8px당 1봉, 최소 60봉) 최근 구간만 보여주고 과거는 드래그/휠로 본다.
 *       봉 수가 적은 주봉·월봉은 그대로 전체가 보인다.
 */
(function () {
  "use strict";
  function guessMarket(candles) {
    const last = candles && candles.length ? Number(candles[candles.length - 1].close) : NaN;
    if (!Number.isFinite(last)) return "KR";
    return Math.round(last) !== last || last < 1000 ? "US" : "KR";
  }
  function baseFormatter(market) {
    if (market === "US" || market === "CRYPTO") {
      return (p) => {
        const a = Math.abs(p);
        const d = a < 1 ? 5 : a < 10 ? 3 : a < 1000 ? 2 : 0;
        return "$" + p.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
      };
    }
    return (p) => Math.round(p).toLocaleString("ko-KR");
  }
  function fit(chart, candles, market) {
    if (!chart || typeof chart.applyOptions !== "function") return;
    const list = Array.isArray(candles) ? candles : [];
    const mk = market || guessMarket(list);
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of list) {
      const l = Number(c && (c.low != null ? c.low : c.close));
      const h = Number(c && (c.high != null ? c.high : c.close));
      if (Number.isFinite(l) && l < lo) lo = l;
      if (Number.isFinite(h) && h > hi) hi = h;
    }
    chart.__tmBars = list.length;
    const fmt = baseFormatter(mk);
    const floor = Number.isFinite(lo) && Number.isFinite(hi) ? lo - (hi - lo) * 0.04 : -Infinity;
    chart.applyOptions({
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      localization: {
        priceFormatter: (p) => (p < floor || p < 0 ? "" : fmt(p)),
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });
  }
  function recent(chart) {
    if (!chart || typeof chart.timeScale !== "function") return;
    const ts = chart.timeScale();
    // 봉 수는 fit()이 기록해 둔 값(차트가 아직 그려지기 전이라 화면 범위를 못 읽는 경우가 있음)
    const n = Number(chart.__tmBars) || 0;
    let w = 0;
    try { w = (typeof ts.width === "function" && ts.width()) || 0; } catch (e) { w = 0; }
    if (!w) { try { w = Number(chart.options().width) || 0; } catch (e) { w = 0; } }
    if (!w) w = 800;
    const show = Math.max(60, Math.round(w / 8));
    if (n > show + 10) ts.setVisibleLogicalRange({ from: n - show, to: n + 1 });
    else ts.fitContent();
  }
  window.TMChartStyle = { fit, recent, formatter: baseFormatter };
})();
