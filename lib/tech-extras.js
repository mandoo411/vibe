/**
 * AI 종목분석 보조지표 — 2026-09-26 신설 (리뷰 지적: "MACD·볼린저·거래량 이평이 없고 RSI 해석이 얕다").
 * 서버가 이미 받아 둔 4년 일봉(fetchKisDailyHistory)으로 코드가 직접 계산한다. AI는 해석만 한다.
 */
const { computeMacd, computeBollinger } = require("./kis-indicators");

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

function computeTechExtras(candles) {
  if (!Array.isArray(candles) || candles.length < 140) return null;
  const rows = candles.filter((c) => c && Number(c.close) > 0);
  if (rows.length < 140) return null;
  const closes = rows.map((c) => Number(c.close));
  const n = closes.length;
  const last = n - 1;
  const out = { asOf: rows[last].time };

  // MACD(12,26,9)
  const { macdLine, signalLine, histogram } = computeMacd(closes);
  if (macdLine[last] != null && signalLine[last] != null) {
    let crossAgo = null;
    let crossType = null;
    for (let i = last; i > last - 10 && i > 0; i--) {
      const h = histogram[i];
      const hp = histogram[i - 1];
      if (h == null || hp == null) break;
      if (hp <= 0 && h > 0) { crossAgo = last - i; crossType = "golden"; break; }
      if (hp >= 0 && h < 0) { crossAgo = last - i; crossType = "dead"; break; }
    }
    const h0 = histogram[last];
    const h3 = histogram[last - 3];
    out.macd = {
      above: macdLine[last] > signalLine[last],
      zeroAbove: macdLine[last] > 0,
      histTrend: h0 != null && h3 != null ? (Math.abs(h0) > Math.abs(h3) ? "widening" : "narrowing") : null,
      crossType,
      crossAgo,
    };
  }

  // 볼린저밴드(20,2): %B와 밴드폭(최근 120일 중 백분위 → 수축/확장)
  const bb = computeBollinger(closes);
  if (bb.upper[last] != null && bb.lower[last] != null && bb.upper[last] > bb.lower[last]) {
    const pctB = ((closes[last] - bb.lower[last]) / (bb.upper[last] - bb.lower[last])) * 100;
    const widths = bb.width.slice(-120).filter((v) => v != null);
    const w0 = bb.width[last];
    const rank = widths.length ? (widths.filter((v) => v <= w0).length / widths.length) * 100 : null;
    out.bollinger = {
      upper: Math.round(bb.upper[last]),
      mid: Math.round(bb.mid[last]),
      lower: Math.round(bb.lower[last]),
      pctB: Math.round(pctB),
      widthPct: r2(w0),
      widthRank120: rank == null ? null : Math.round(rank),
    };
  }

  // 추세 사실(코드 확정) — 리뷰: "20일선<60일선 역배열인데 본문은 단기·중기 우상향"
  const smaAt = (p) => (n >= p ? closes.slice(-p).reduce((a, v) => a + v, 0) / p : null);
  const m20 = smaAt(20), m60 = smaAt(60), m120 = smaAt(120);
  if (m20 && m60) {
    out.trend = {
      ma20: Math.round(m20),
      ma60: Math.round(m60),
      ma120: m120 ? Math.round(m120) : null,
      order: m120 ? (m20 > m60 && m60 > m120 ? "up" : m20 < m60 && m60 < m120 ? "down" : "mixed") : m20 > m60 ? "up" : "down",
      ma20AboveMa60: m20 > m60,
      close: closes[last],
      ret63: n > 63 ? r2(((closes[last] - closes[last - 63]) / closes[last - 63]) * 100) : null,
      ret21: n > 21 ? r2(((closes[last] - closes[last - 21]) / closes[last - 21]) * 100) : null,
    };
  }

  // 거래량: 오늘 / 20일 평균, 5일 평균 / 20일 평균 (장중이면 오늘 값은 누적 진행 중)
  const vols = rows.map((c) => Number(c.volume) || 0);
  if (vols.slice(-21).every((v) => v > 0)) {
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const v20 = avg(vols.slice(-21, -1));
    const v5 = avg(vols.slice(-5));
    out.volume = {
      todayVs20: r2(vols[last] / v20),
      avg5Vs20: r2(v5 / v20),
      upDayVolShare20: (() => {
        let up = 0, all = 0;
        for (let i = n - 20; i < n; i++) {
          all += vols[i];
          if (closes[i] > closes[i - 1]) up += vols[i];
        }
        return all ? Math.round((up / all) * 100) : null;
      })(),
    };
  }
  // ATR(14, Wilder) — 하루 평균 변동폭. 목표가·손절가 거리를 "변동폭의 몇 배"로 재는 잣대(GPT 리뷰: 목표가 산식 부재)
  const hl = rows.map((c, i) => {
    const h = Number(c.high), l = Number(c.low);
    if (!(h > 0 && l > 0) || i === 0) return null;
    const pc = closes[i - 1];
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
  const trs = hl.slice(-60).filter((v) => v != null);
  if (trs.length >= 30) {
    let atr = trs.slice(0, 14).reduce((a, v) => a + v, 0) / 14;
    for (let i = 14; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;
    out.atr = { value: Math.round(atr), pct: r2((atr / closes[last]) * 100) };
  }
  return out.macd || out.bollinger || out.volume || out.atr ? out : null;
}

function techExtrasPromptBlock(tx, fmtPrice) {
  if (!tx) return "";
  const f = typeof fmtPrice === "function" ? fmtPrice : (v) => `${Number(v).toLocaleString("ko-KR")}원`;
  const lines = ["", `[보조지표 — 코드가 실제 일봉(~${tx.asOf})으로 직접 계산. 추정이 아니다]`];
  if (tx.trend) {
    const t = tx.trend;
    const orderTxt = t.order === "up" ? "정배열(20일>60일>120일, 상승 추세)" : t.order === "down" ? "역배열(20일<60일<120일, 하락 추세)" : "혼조(이동평균선 순서가 섞임)";
    lines.push(
      `[추세 사실 — 코드 확정, 반드시 이와 맞게 서술] 20일선 ${f(t.ma20)} ${t.ma20AboveMa60 ? ">" : "<"} 60일선 ${f(t.ma60)}${t.ma120 ? `, 120일선 ${f(t.ma120)}` : ""} → ${orderTxt}. 최근 1개월 수익률 ${t.ret21 != null ? t.ret21 + "%" : "—"}, 최근 3개월 ${t.ret63 != null ? t.ret63 + "%" : "—"}.`,
      t.ma20AboveMa60
        ? "중기 배열은 위쪽이다."
        : "20일선이 60일선 아래이므로 '단기·중기 우상향', '중기 골격이 강하다'처럼 쓰지 않는다. 주가가 20일선 위라면 '단기 반등 중이지만 중기 추세는 아직 회복 전'처럼 쓴다."
    );
    // 2026-09-26: '20일선이 60일선 아래'(선끼리 순서)를 '주가가 60일선 아래'로 바꿔 쓰는 오류가 나왔다 → 주가 위치를 따로 못 박는다.
    if (t.close) {
      const pos = (m, lb) => (m ? `${lb} ${t.close > m ? "위" : "아래"}` : null);
      lines.push(
        `[주가 위치 — 코드 확정] 최근 종가 ${f(t.close)}는 ${[pos(t.ma20, "20일선"), pos(t.ma60, "60일선"), pos(t.ma120, "120일선")].filter(Boolean).join(", ")}에 있다. 선끼리의 순서(20일선과 60일선 중 어느 쪽이 위인지)와 주가의 위치를 섞어 쓰지 않는다. 예: 주가가 60일선 위인데 '주가가 60일선 아래라'고 쓰면 오류다.`
      );
    }
  }
  if (tx.macd) {
    const m = tx.macd;
    const cross =
      m.crossType && m.crossAgo != null
        ? `, 최근 ${m.crossAgo === 0 ? "오늘" : m.crossAgo + "거래일 전"} ${m.crossType === "golden" ? "골든크로스(시그널선 상향 돌파)" : "데드크로스(시그널선 하향 돌파)"}`
        : ", 최근 10거래일 교차 없음";
    lines.push(
      `MACD(12,26,9): MACD선이 시그널선 ${m.above ? "위" : "아래"}, 0선 ${m.zeroAbove ? "위" : "아래"}, 히스토그램 ${m.histTrend === "widening" ? "확대 중(추세 힘 강해짐)" : m.histTrend === "narrowing" ? "축소 중(추세 힘 약해짐)" : "—"}${cross}`
    );
  }
  if (tx.bollinger) {
    const b = tx.bollinger;
    lines.push(
      `볼린저밴드(20,2): 상단 ${f(b.upper)} · 중심 ${f(b.mid)} · 하단 ${f(b.lower)}, 현재가 위치 %B ${b.pctB}(0=하단, 100=상단, 100 초과=상단 돌파), 밴드폭 ${b.widthPct}%` +
        (b.widthRank120 != null ? ` — 최근 120거래일 밴드폭 백분위 ${b.widthRank120}(0=가장 좁음, 100=가장 넓음) → ${b.widthRank120 <= 20 ? "수축: 큰 움직임 전 단계일 수 있음" : b.widthRank120 >= 80 ? "확장: 이미 크게 움직이는 중" : "보통"}` : "")
    );
  }
  if (tx.volume) {
    const v = tx.volume;
    lines.push(
      `거래량: 오늘 거래량은 20일 평균의 ${v.todayVs20}배(장중이면 아직 누적 중), 최근 5일 평균은 20일 평균의 ${v.avg5Vs20}배, 최근 20일 거래량 중 상승일 비중 ${v.upDayVolShare20}%`
    );
  }
  if (tx.atr) {
    lines.push(
      `ATR(14, 하루 평균 변동폭): ${f(tx.atr.value)} (현재가의 ${tx.atr.pct}%)`,
      "[목표가·손절가 산식 — 반드시 준수] 강세·중립 시나리오의 목표가는 진입가 위의 첫 저항(1·2차 저항, 스윙 고점, 볼린저 상단 중 하나)으로 잡고, 그 저항이 진입가보다 ATR 1.5배 미만으로 가까우면 다음 저항을 쓴다. 손절가는 진입가 아래 첫 지지에서 ATR 0.5배를 더 뺀 자리로 잡는다. 각 시나리오 condition 또는 basis 끝에 '목표 근거: ○○ 저항(ATR 약 N배)'처럼 어떤 레벨을 썼는지 한 번 밝힌다. 다른 곳의 '진입가 +5~8%', '-3~5%' 같은 고정 퍼센트 지시보다 이 산식을 우선하되, 손익비(목표 거리÷손절 거리)는 1.5 이상을 유지한다. 화면에는 목표·손절 거리가 ATR 몇 배인지 코드가 따로 표시한다."
    );
  }
  lines.push(
    "이 블록을 차트 흐름 분석에 반영한다: RSI 항목 바로 다음 줄에 '보조지표 교차 확인: …' 한 줄을 추가해, RSI·MACD·볼린저·거래량이 같은 방향을 가리키는지 엇갈리는지를 판단하고 엇갈리면 어느 쪽을 더 믿는지와 이유를 쓴다. 결론을 먼저 쉬운 말로 쓰고 숫자는 하나만 인용하며, 지표 이름에는 처음 한 번 괄호로 쉬운 뜻을 붙인다. 이 블록에 없는 지표 값은 만들지 않는다."
  );
  return lines.join("\n");
}

module.exports = { computeTechExtras, techExtrasPromptBlock };
