import type { PaymentAuthorization } from './authorization';
import {
  decodeAuthorization,
  extractAmountAtomic,
  extractPayTo,
  extractPayer,
  normalizeAddr,
} from './decode';
import type { PaymentLedger } from './ledger';
import type { PaymentVerifyContext, PaymentVerifyResult } from './types';
import { enrichVerifyResult } from './billing';

/**
 * Structural x402 verification — IN DEVELOPMENT tier.
 *
 * Checks performed (does NOT confirm on-chain settlement):
 *   - PAYMENT-SIGNATURE minimum length
 *   - payTo matches ASP wallet (when JSON-decodable)
 *   - amount >= required atomic units (when JSON-decodable)
 *   - persistent ledger replay guard (survives restarts)
 *
 * Opaque EIP-3009 headers that are not JSON may pass length + replay only.
 * This is intentionally weaker than facilitator verify — label as in_development.
 */
export function verifyStructurally(
  auth: PaymentAuthorization,
  ctx: PaymentVerifyContext,
  ledger: PaymentLedger
): PaymentVerifyResult {
  const raw = auth.value.trim();
  if (raw.length < 16) {
    return enrichVerifyResult({
      ok: false,
      mode: 'structural',
      level: 'beta',
      reason: 'PAYMENT-SIGNATURE too short to be a valid x402 authorization.',
    });
  }

  const { digest, decoded } = decodeAuthorization(auth);

  if (ledger.hasDigest(digest)) {
    return enrichVerifyResult({
      ok: false,
      mode: 'structural',
      level: 'beta',
      signatureDigest: digest,
      reason: 'Payment signature replay detected (already recorded in payment ledger).',
    });
  }

  const expectedPayTo = normalizeAddr(ctx.payTo);
  const requiredAmount = BigInt(ctx.amountAtomic || '0');

  if (decoded) {
    const payTo = extractPayTo(decoded);
    if (payTo && payTo !== expectedPayTo) {
      return enrichVerifyResult({
        ok: false,
        mode: 'structural',
        level: 'beta',
        signatureDigest: digest,
        reason: 'Payment authorization payTo does not match this ASP wallet.',
      });
    }

    const amount = extractAmountAtomic(decoded);
    if (amount != null && requiredAmount > 0n && amount < requiredAmount) {
      return enrichVerifyResult({
        ok: false,
        mode: 'structural',
        level: 'beta',
        signatureDigest: digest,
        reason: `Payment amount ${amount} is below required ${requiredAmount} atomic units.`,
      });
    }
  }

  if (!ledger.reserveDigest(digest)) {
    return enrichVerifyResult({
      ok: false,
      mode: 'structural',
      level: 'beta',
      signatureDigest: digest,
      reason: 'Payment signature replay detected (concurrent or duplicate request).',
    });
  }

  return enrichVerifyResult({
    ok: true,
    mode: 'structural',
    level: 'beta',
    settlementVerified: false,
    signatureDigest: digest,
    payer: decoded ? extractPayer(decoded) : undefined,
    reason:
      decoded
        ? 'Structural checks passed (payTo/amount/replay). On-chain settlement NOT confirmed — facilitator verify required for production tier.'
        : 'Opaque PAYMENT-SIGNATURE passed length/replay checks only. On-chain settlement NOT confirmed.',
  });
}