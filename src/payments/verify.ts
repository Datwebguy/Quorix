/**
 * x402 payment verification — public API surface.
 *
 * Implementation lives in service.ts (orchestration), structural.ts, facilitator.ts, ledger.ts.
 */
export type {
  PaymentVerifyMode,
  PaymentVerifyContext,
  PaymentVerifyResult,
  PaymentVerifyOptions,
  SettlementVerificationKind,
} from './types';

export { verifyPayment, verifyPaymentAuthorization, verificationLevelLabel } from './service';
export { getPaymentLedger, resetPaymentLedgerForTests, type PaymentLedgerEntry } from './ledger';
export { defaultFacilitatorVerifier, FacilitatorVerifier } from './facilitator';
export { billingTierLabel, billingFlagsFromVerification } from './billing';