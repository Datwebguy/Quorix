import type { A2mcpBillingTier } from '../config/paymentReadiness';
import type { PaymentAuthorization } from './authorization';

/**
 * x402 payment verification modes (A2MCP_PAYMENT_VERIFY_MODE).
 *
 * - facilitator: POST PAYMENT-SIGNATURE to OKX/CDP verify API — confirms on-chain settlement (production).
 * - structural:  decode header, match payTo/amount, ledger replay guard — does NOT confirm settlement.
 * - presence:    header exists only — insecure dev override; blocked when NODE_ENV=production.
 */
export type PaymentVerifyMode = 'facilitator' | 'structural' | 'presence';

/** What was actually checked before allowing metered execution. */
export type SettlementVerificationKind = 'none' | 'structural' | 'facilitator';

export interface PaymentVerifyContext {
  payTo: string;
  amountAtomic: string;
  network?: string;
  operation: string;
  /** Optional caller id for audit ledger (IP, wallet, agent address). */
  callerId?: string;
}

export interface PaymentVerifyResult {
  ok: boolean;
  mode: PaymentVerifyMode;
  /**
   * production = facilitator confirmed settlement on-chain.
   * beta       = structural checks only.
   * insecure   = presence-only (dev).
   */
  level: 'production' | 'beta' | 'insecure';
  /** True only when facilitator verify succeeded — NOT set for structural/presence. */
  settlementVerified: boolean;
  settlementVerification: SettlementVerificationKind;
  billingTier: A2mcpBillingTier;
  externallyBillable: boolean;
  reason?: string;
  payer?: string;
  transaction?: string;
  signatureDigest?: string;
  ledgerId?: string;
}

export interface PaymentVerifyOptions {
  callerId?: string;
}

export interface FacilitatorVerifyRequest {
  paymentPayload: string;
  paymentHeader: PaymentAuthorization['headerName'];
  paymentRequirements: {
    scheme: 'exact';
    network: string;
    payTo: string;
    amount: string;
    maxAmountRequired: string;
  };
  x402Version: 2;
}

export interface FacilitatorVerifyResponse {
  valid: boolean;
  payer?: string;
  transaction?: string;
  reason?: string;
}