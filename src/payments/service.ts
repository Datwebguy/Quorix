/**
 * QuorixASP x402 payment verification service.
 *
 * Entry point: verifyPayment()
 *
 * Verification pipeline (production-minded):
 *   1. Extract & validate PAYMENT-SIGNATURE header
 *   2. If mode=facilitator and URL configured → facilitator verify (settlement)
 *   3. Else if mode=structural → structural verify (no settlement)
 *   4. On success → append PaymentLedgerEntry for audit + replay protection
 *
 * Current limitation:
 *   Without X402_FACILITATOR_VERIFY_URL for X Layer (chain 196), all successful
 *   verifications are structural-only (billingTier=in_development, externallyBillable=false).
 *
 * To reach production tier:
 *   - Obtain OKX/CDP facilitator verify URL supporting eip155:196
 *   - Set A2MCP_PAYMENT_VERIFY_MODE=facilitator
 *   - Set X402_FACILITATOR_VERIFY_URL=<endpoint>
 *   - E2E test with onchainos payment pay
 */
import { ENV } from '../config/env';
import type { PaymentAuthorization } from './authorization';
import { enrichVerifyResult } from './billing';
import { decodeAuthorization } from './decode';
import { defaultFacilitatorVerifier } from './facilitator';
import { getPaymentLedger, type PaymentLedger } from './ledger';
import { verifyStructurally } from './structural';
import type {
  PaymentVerifyContext,
  PaymentVerifyOptions,
  PaymentVerifyResult,
} from './types';

function verifyPresenceOnly(): PaymentVerifyResult {
  return enrichVerifyResult({
    ok: true,
    mode: 'presence',
    level: 'insecure',
    settlementVerified: false,
    reason:
      'INSECURE: A2MCP_PAYMENT_VERIFY_MODE=presence — header existence only, no settlement verify.',
  });
}

async function verifyViaFacilitator(
  auth: PaymentAuthorization,
  ctx: PaymentVerifyContext,
  ledger: PaymentLedger
): Promise<PaymentVerifyResult | null> {
  const verifier = defaultFacilitatorVerifier;
  if (!verifier.isConfigured()) return null;

  const { digest } = decodeAuthorization(auth);

  if (ledger.hasDigest(digest)) {
    return enrichVerifyResult({
      ok: false,
      mode: 'facilitator',
      level: 'production',
      signatureDigest: digest,
      reason: 'Payment signature replay detected (already recorded in payment ledger).',
    });
  }

  const response = await verifier.verify(auth, ctx);
  if (!response) return null;

  if (!response.valid) {
    return enrichVerifyResult({
      ok: false,
      mode: 'facilitator',
      level: 'production',
      signatureDigest: digest,
      reason: response.reason || 'Facilitator rejected payment',
      payer: response.payer,
      transaction: response.transaction,
    });
  }

  if (!ledger.reserveDigest(digest)) {
    return enrichVerifyResult({
      ok: false,
      mode: 'facilitator',
      level: 'production',
      signatureDigest: digest,
      reason: 'Payment signature replay detected (concurrent request).',
    });
  }

  const entry = await ledger.record({
    signatureDigest: digest,
    payer: response.payer,
    payTo: ctx.payTo,
    amountAtomic: ctx.amountAtomic,
    operation: ctx.operation,
    verifyMode: 'facilitator',
    settlementVerified: true,
    transaction: response.transaction,
    callerId: ctx.callerId,
  });

  return enrichVerifyResult({
    ok: true,
    mode: 'facilitator',
    level: 'production',
    settlementVerified: true,
    signatureDigest: digest,
    ledgerId: entry.id,
    payer: response.payer,
    transaction: response.transaction,
    reason: 'Facilitator confirmed on-chain settlement.',
  });
}

async function recordStructuralSuccess(
  result: PaymentVerifyResult,
  ctx: PaymentVerifyContext,
  ledger: PaymentLedger
): Promise<PaymentVerifyResult> {
  if (!result.ok || !result.signatureDigest) return result;

  const entry = await ledger.record({
    signatureDigest: result.signatureDigest,
    payer: result.payer,
    payTo: ctx.payTo,
    amountAtomic: ctx.amountAtomic,
    operation: ctx.operation,
    verifyMode: 'structural',
    settlementVerified: false,
    callerId: ctx.callerId,
  });

  return { ...result, ledgerId: entry.id };
}

/**
 * Verify buyer x402 payment before executing metered MCP tools.
 *
 * @param auth - PAYMENT-SIGNATURE or X-PAYMENT header value
 * @param ctx  - payTo, amountAtomic, operation, optional callerId for audit
 */
export async function verifyPayment(
  auth: PaymentAuthorization | null | undefined,
  ctx: PaymentVerifyContext,
  options?: PaymentVerifyOptions
): Promise<PaymentVerifyResult> {
  const ledger = getPaymentLedger();
  const fullCtx: PaymentVerifyContext = {
    ...ctx,
    callerId: options?.callerId || ctx.callerId,
  };

  if (!auth?.value?.trim()) {
    return enrichVerifyResult({
      ok: false,
      mode: ENV.A2MCP_PAYMENT_VERIFY_MODE,
      level: 'beta',
      reason: 'Missing PAYMENT-SIGNATURE or X-PAYMENT header.',
    });
  }

  const mode = ENV.A2MCP_PAYMENT_VERIFY_MODE;

  if (mode === 'presence') {
    if (process.env.NODE_ENV === 'production') {
      return enrichVerifyResult({
        ok: false,
        mode: 'presence',
        level: 'insecure',
        reason: 'presence verify mode is disabled in production. Use structural or facilitator.',
      });
    }
    return verifyPresenceOnly();
  }

  if (mode === 'facilitator') {
    const facilitatorResult = await verifyViaFacilitator(auth, fullCtx, ledger);
    if (facilitatorResult) {
      return facilitatorResult;
    }
    // URL not configured — fall through to structural with honest in_development tier
  }

  const structural = verifyStructurally(auth, fullCtx, ledger);
  if (structural.ok) {
    return recordStructuralSuccess(structural, fullCtx, ledger);
  }

  // Release reserved digest on failure (structural reserves before returning ok)
  return structural;
}

/** @deprecated Use verifyPayment — kept for backward-compatible imports */
export async function verifyPaymentAuthorization(
  auth: PaymentAuthorization | null | undefined,
  ctx: PaymentVerifyContext
): Promise<PaymentVerifyResult> {
  return verifyPayment(auth, ctx);
}

export { verificationLevelLabel } from './billing';