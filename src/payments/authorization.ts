/**
 * OKX Agent Payments Protocol — buyer authorization header extraction.
 *
 * v2 clients send PAYMENT-SIGNATURE; legacy v1 clients send X-PAYMENT.
 * QuorixASP gates metered A2MCP calls on header presence until OKX publishes
 * a server-side facilitator verify CLI we can call from the broker daemon.
 */

export type PaymentAuthHeaderName = 'PAYMENT-SIGNATURE' | 'X-PAYMENT';

export interface PaymentAuthorization {
  headerName: PaymentAuthHeaderName;
  value: string;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0]?.trim() || '';
  return String(raw || '').trim();
}

/** Extract a non-empty payment authorization from inbound HTTP headers. */
export function extractPaymentAuthorization(
  headers: Record<string, string | string[] | undefined>
): PaymentAuthorization | null {
  const v2 = headerValue(headers, 'payment-signature');
  if (v2) return { headerName: 'PAYMENT-SIGNATURE', value: v2 };

  const v1 = headerValue(headers, 'x-payment');
  if (v1) return { headerName: 'X-PAYMENT', value: v1 };

  return null;
}

export function hasPaymentAuthorization(
  headers: Record<string, string | string[] | undefined>
): boolean {
  return extractPaymentAuthorization(headers) !== null;
}