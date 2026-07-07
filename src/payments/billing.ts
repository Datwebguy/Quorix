import type { A2mcpBillingTier } from '../config/paymentReadiness';
import type { PaymentVerifyMode, PaymentVerifyResult, SettlementVerificationKind } from './types';

/**
 * Map a verification outcome to billing tier flags.
 * Structural success is NEVER externally billable — only facilitator settlement is.
 */
export function billingFlagsFromVerification(
  ok: boolean,
  mode: PaymentVerifyMode,
  settlementVerified: boolean
): Pick<PaymentVerifyResult, 'billingTier' | 'externallyBillable' | 'settlementVerification'> {
  if (!ok) {
    return {
      billingTier: 'in_development',
      externallyBillable: false,
      settlementVerification: 'none',
    };
  }

  if (settlementVerified && mode === 'facilitator') {
    return {
      billingTier: 'production',
      externallyBillable: true,
      settlementVerification: 'facilitator',
    };
  }

  const settlementVerification: SettlementVerificationKind =
    mode === 'structural' ? 'structural' : 'none';

  return {
    billingTier: 'in_development',
    externallyBillable: false,
    settlementVerification,
  };
}

export function enrichVerifyResult(
  partial: Omit<
    PaymentVerifyResult,
    'settlementVerified' | 'billingTier' | 'externallyBillable' | 'settlementVerification'
  > & { settlementVerified?: boolean }
): PaymentVerifyResult {
  const settlementVerified = partial.settlementVerified ?? partial.level === 'production';
  const flags = billingFlagsFromVerification(partial.ok, partial.mode, settlementVerified);

  return {
    ...partial,
    settlementVerified,
    ...flags,
  };
}

export function verificationLevelLabel(result: PaymentVerifyResult): string {
  if (result.settlementVerified) return 'facilitator_settlement_verified';
  if (result.level === 'beta') return 'structural_only_not_settlement';
  if (result.level === 'insecure') return 'presence_only_insecure';
  return 'not_verified';
}

export function billingTierLabel(tier: A2mcpBillingTier): string {
  switch (tier) {
    case 'production':
      return 'production_settlement_verified';
    case 'in_development':
      return 'in_development_structural_only';
    case 'disabled':
      return 'x402_disabled';
    case 'misconfigured':
      return 'misconfigured';
    default:
      return tier;
  }
}