/**
 * 공용 자체 캔들 차트 (Lightweight Charts) — 캔들 + 캔들과 동일한 상승/하락 색의 거래량
 * 히스토그램 + 4색 이동평균선(20/60/120/200일). AI 종목분석(stock-analysis.js)에서 이미
 * 검증된 구현을 us-market.html/crypto.html의 "차트 보기"에서도 그대로 쓸 수 있도록 분리했다.
 *
 * 2026-07-11: 이 두 페이지는 원래 TradingView 위젯(iframe)을 썼는데, 거래량 바 색상을
 * 캔들과 맞추는 시도를 두 번(studies_overrides, hide_volume) 했지만 iframe 위젯 자체의
 * 한계로 계속 실패했다(두 번째 시도는 거래량 자체가 사라짐). 이미 완성된 자체 차트로
 * 교체하는 게 근본적인 해결책이라 판단해서 공용 모듈로 뽑아냈다.
 *
 * 사용법:
 *   const handle = await window.tmMountCandleChart(hostEl, chartData, { market: "US" });
 *   // chartData = { candles, ma20, ma60, ma120, ma200 } (/api/kis-stock-quote?...&chart=1 응답과 동일)
 *   window.tmDisposeCandleChart(handle); // 언마운트 시
 */
(function () {
  "use strict";

  let lwChartsPromise = null;

  function ensureLightweightCharts() {
    if (window.LightweightCharts && typeof window.LightweightCharts.createChart === "function") {
      return Promise.resolve(window.LightweightCharts);
    }
    if (!lwChartsPromise) {
      lwChartsPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.async = true;
        s.src = "https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js";
        s.crossOrigin = "anonymous";
        s.onload = () => resolve(window.LightweightCharts);
        s.onerror = () => reject(new Error("lightweight-charts 로드 실패"));
        document.head.appendChild(s);
      });
    }
    return lwChartsPromise;
  }

  function isDarkTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }

  function getLwTheme() {
    const dark = isDarkTheme();
    return {
      bg: dark ? "#131722" : "#ffffff",
      text: dark ? "#d1d4dc" : "#131722",
      grid: dark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.06)",
    };
  }

  function priceFormatterFor(market) {
    if (market === "US" || market === "CRYPTO") {
      return (price) => {
        const abs = Math.abs(price);
        const decimals = abs < 1 ? 6 : abs < 10 ? 4 : abs < 1000 ? 2 : 0;
        return `$${price.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
      };
    }
    return (price) => {
      if (price >= 10000) return `${(price / 10000).toFixed(0)}만`;
      return Math.round(price).toLocaleString("ko-KR");
    };
  }

  function buildMaLineData(candles, maArr) {
    const out = [];
    for (let i = 0; i < candles.length; i++) {
      const v = maArr && maArr[i];
      if (v != null) out.push({ time: candles[i].time, value: v });
    }
    return out;
  }

  function defaultHeight() {
    return window.matchMedia("(max-width: 768px)").matches ? 260 : 400;
  }

  async function mountCandleChart(hostEl, chartData, opts) {
    if (!hostEl || !chartData || !Array.isArray(chartData.candles) || !chartData.candles.length) return null;
    const options = opts || {};
    const market = options.market || "KR";
    const LC = await ensureLightweightCharts();
    hostEl.innerHTML = "";
    const height = options.height || defaultHeight();
    const width = Math.max(hostEl.clientWidth, 280);
    const t = getLwTheme();
    const chart = LC.createChart(hostEl, {
      width,
      height,
      layout: { background: { type: "solid", color: t.bg }, textColor: t.text },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      localization: { priceFormatter: priceFormatterFor(market) },
    });

    const UP_COLOR = "#e24b4a";
    const DOWN_COLOR = "#3b82f6";
    const candleOpts = {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      borderDownColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
    };
    let candleSeries;
    if (LC.CandlestickSeries && typeof chart.addSeries === "function") {
      candleSeries = chart.addSeries(LC.CandlestickSeries, candleOpts);
    } else if (typeof chart.addCandlestickSeries === "function") {
      candleSeries = chart.addCandlestickSeries(candleOpts);
    } else {
      throw new Error("캔들 시리즈를 초기화하지 못했습니다.");
    }
    candleSeries.setData(chartData.candles);

    // 거래량 히스토그램 — 캔들과 동일한 상승/하락 색을 그대로 써서 절대 어긋나지 않는다
    // (TradingView 위젯처럼 별도 색상 오버라이드에 의존하지 않음).
    const volumeData = chartData.candles
      .filter((cd) => cd && cd.volume != null)
      .map((cd) => ({
        time: cd.time,
        value: Math.max(0, Number(cd.volume) || 0),
        color: cd.close >= cd.open ? UP_COLOR : DOWN_COLOR,
      }));
    if (volumeData.length) {
      const volumeOpts = {
        priceFormat: { type: "volume" },
        priceScaleId: "tm-volume",
        lastValueVisible: false,
        priceLineVisible: false,
      };
      let volumeSeries;
      if (LC.HistogramSeries && typeof chart.addSeries === "function") {
        volumeSeries = chart.addSeries(LC.HistogramSeries, volumeOpts);
      } else if (typeof chart.addHistogramSeries === "function") {
        volumeSeries = chart.addHistogramSeries(volumeOpts);
      }
      if (volumeSeries) {
        // 거래량은 하단 18%만 차지하게 해서 캔들과 절대 겹치지 않도록 한다.
        volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        volumeSeries.setData(volumeData);
      }
    }

    const isDark = isDarkTheme();
    const specs = [
      [chartData.ma20, "#FF0000", 1],
      [chartData.ma60, "#1E90FF", 1],
      [chartData.ma120, "#008000", 1],
      [chartData.ma200, isDark ? "#f5f5f5" : "#000000", 2],
    ];
    for (const [arr, color, lineWidth] of specs) {
      const lineData = buildMaLineData(chartData.candles, arr);
      if (!lineData.length) continue;
      const lineOpts = { color, lineWidth, priceLineVisible: false, lastValueVisible: false };
      let line;
      if (LC.LineSeries && typeof chart.addSeries === "function") {
        line = chart.addSeries(LC.LineSeries, lineOpts);
      } else {
        line = chart.addLineSeries(lineOpts);
      }
      line.setData(lineData);
    }
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      const nw = hostEl.clientWidth;
      if (nw > 0) {
        chart.applyOptions({ width: nw, height: options.height || defaultHeight() });
        chart.timeScale().fitContent();
      }
    });
    ro.observe(hostEl);

    return { chart, ro, hostEl };
  }

  function disposeCandleChart(handle) {
    if (!handle) return;
    try {
      handle.ro && handle.ro.disconnect();
    } catch (e) {
      /* noop */
    }
    try {
      handle.chart && handle.chart.remove();
    } catch (e) {
      /* noop */
    }
  }

  function applyCandleChartTheme(handle) {
    if (!handle || !handle.chart) return;
    const t = getLwTheme();
    handle.chart.applyOptions({
      layout: { background: { type: "solid", color: t.bg }, textColor: t.text },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    });
  }

  window.tmMountCandleChart = mountCandleChart;
  window.tmDisposeCandleChart = disposeCandleChart;
  window.tmApplyCandleChartTheme = applyCandleChartTheme;
})();
