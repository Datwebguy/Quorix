import { ENV } from '../config/env';
import type { PaymentAuthorization } from './authorization';
import { X_LAYER_CAIP2 } from './x402Challenge';
import type {
  FacilitatorVerifyRequest,
  FacilitatorVerifyResponse,
  PaymentVerifyContext,
} from './types';

/**
 * OKX / CDP x402 facilitator verify client.
 *
 * Production path: POST signed PAYMENT-SIGNATURE + paymentRequirements to the
 * facilitator verify endpoint. A `valid: true` response means on-chain settlement
 * was confirmed — the only tier that qualifies as externallyBillable.
 *
 * When X402_FACILITATOR_VERIFY_URL is empty, returns null and the service layer
 * falls back to structural verification (in_development tier).
 *
 * TODO (when OKX publishes X Layer endpoint):
 *   1. Set X402_FACILITATOR_VERIFY_URL (e.g. CDP /v2/x402/verify with network eip155:196)
 *   2. Set A2MCP_PAYMENT_VERIFY_MODE=facilitator
 *   3. Run E2E test: 402 challenge → onchainos payment pay → replay → ledger entry with settlementVerified=true
 */
export class FacilitatorVerifier {
  constructor(private readonly verifyUrl: string = ENV.X402_FACILITATOR_VERIFY_URL) {}

  isConfigured(): boolean {
    return Boolean(this.verifyUrl.trim());
  }

  buildRequest(auth: PaymentAuthorization, ctx: PaymentVerifyContext): FacilitatorVerifyRequest {
    return {
      paymentPayload: auth.value,
      paymentHeader: auth.headerName,
      paymentRequirements: {
        scheme: 'exact',
        network: ctx.network || X_LAYER_CAIP2,
        payTo: ctx.payTo,
        amount: ctx.amountAtomic,
        maxAmountRequired: ctx.amountAtomic,
      },
      x402Version: 2,
    };
  }

  parseResponse(body: Record<string, unknown>): FacilitatorVerifyResponse {
    const valid = body.valid === true || body.isValid === true || body.ok === true;
    return {
      valid,
      payer: body.payer ? String(body.payer) : undefined,
      transaction: body.transaction ? String(body.transaction) : undefined,
      reason: valid ? undefined : String(body.reason || body.error || 'Facilitator rejected payment'),
    };
  }

  async verify(
    auth: PaymentAuthorization,
    ctx: PaymentVerifyContext
  ): Promise<FacilitatorVerifyResponse | null> {
    const url = this.verifyUrl.trim();
    if (!url) return null;

    const request = this.buildRequest(auth, ctx);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        return {
          valid: false,
          reason: `Facilitator verify HTTP ${res.status}`,
        };
      }

      const body = (await res.json()) as Record<string, unknown>;
      return this.parseResponse(body);
    } catch (err: unknown) {
      return {
        valid: false,
        reason: `Facilitator verify failed: ${(err as Error)?.message || err}`,
      };
    }
  }
}

export const defaultFacilitatorVerifier = new FacilitatorVerifier();