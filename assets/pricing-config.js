/**
 * TotalMoney AI — 요금제 정의
 * 가격/이름/설명은 이 파일만 고치면 pricing.html 전체에 반영됩니다.
 * amount 단위는 원(KRW), 정수만 사용하세요 (포트원 결제 요청 금액).
 */
window.TM_PRICING_PLANS = [
  {
    id: "free",
    name: "무료",
    amount: 0,
    period: "",
    tagline: "기본 시세·시황 정보 이용",
    features: ["실시간시세 · 마감시황 · 미국주식 · 암호화폐", "증시 일정 · 장전 브리핑", "AI 종목분석 월 3회 체험"],
    cta: "무료로 시작",
  },
  {
    id: "pro",
    name: "Pro",
    amount: 9900,
    period: "월",
    tagline: "AI 종목분석 무제한",
    features: ["무료 플랜 전체 포함", "AI 종목분석 무제한 이용", "매매시그널 — 자연어 조건 알림"],
    cta: "Pro 구독하기",
    highlight: true,
  },
  {
    id: "premium",
    name: "Premium",
    amount: 19900,
    period: "월",
    tagline: "우선 지원 + 향후 프리미엄 기능",
    features: ["Pro 플랜 전체 포함", "신규 기능 우선 이용", "우선 문의 대응"],
    cta: "Premium 구독하기",
  },
];
