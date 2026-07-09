/**
 * 서버 전용 포트원(PortOne) V2 결제 검증 헬퍼.
 * PORTONE_API_SECRET은 절대 클라이언트에 노출하지 말 것 (Vercel 환경변수 전용).
 *
 * 참고: PortOne V2 REST API 응답 필드는 변경될 수 있으니, 실제 연동 전
 * https://developers.portone.io/api/rest-v2/payment 문서에서 최신 스펙을 다시 확인하세요.
 */

function apiSecret() {
  return process.env.PORTONE_API_SECRET || "";
}

function isConfigured() {
  return !!apiSecret();
}

/** paymentId로 포트원 서버에 결제건을 단건 조회해 실제 결제 상태/금액을 확인한다. */
async function fetchPayment(paymentId) {
  if (!isConfigured()) throw new Error("PORTONE_API_SECRET 미설정");
  const res = await fetch(`https://api.portone.io/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `PortOne ${apiSecret()}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`포트원 결제 조회 실패 (${res.status}) ${text}`);
  }
  return res.json();
}

/**
 * 결제가 실제로 "완료(PAID)" 상태이고 금액이 기대값과 일치하는지 검증.
 * @param {string} paymentId
 * @param {number} expectedAmount
 */
async function verifyPaidPayment(paymentId, expectedAmount) {
  const payment = await fetchPayment(paymentId);
  const status = payment && payment.status;
  const total = payment && payment.amount && payment.amount.total;
  const ok = status === "PAID" && Number(total) === Number(expectedAmount);
  return { ok, payment, status, total };
}

module.exports = { fetchPayment, verifyPaidPayment, isConfigured };
