import { ENV } from './env';
import { getPaymentLedger } from '../payments/ledger';
import type { SettlementVerificationKind } from '../payments/types';

/** How trustworthy the A2MCP x402 payment gate is for external buyers. */
export type A2mcpBillingTier =
  | 'production' // facilitator confirmed on-chain settlement
  | 'in_development' // structural checks only — not settlement-verified
  | 'disabled' // x402 gate off
  | 'misconfigured'; // gate on but pay-to wallet missing

export interface A2mcpPaymentReadiness {
  tier: A2mcpBillingTier;
  /** Human label for dashboards and MCP manifests */
  label: string;
  /** Whether metered calls should be advertised as billable to external agents */
  externallyBillable: boolean;
  verifyMode: string;
  facilitatorConfigured: boolean;
  payToWalletConfigured: boolean;
  x402Enabled: boolean;
  /** Best verification the server can perform today (not per-request outcome). */
  settlementVerification: SettlementVerificationKind;
  disclaimer: string;
  paymentLedger?: {
    path: string;
    entryCount: number;
    persisted: boolean;
  };
}

/**
 * Single source of truth for A2MCP billing honesty.
 * Use in /api/status, x402 challenges, and MCP tool metadata — never overclaim settlement.
 */
export function getA2mcpPaymentReadiness(): A2mcpPaymentReadiness {
  const payTo = (ENV.A2MCP_PAY_TO_WALLET || '').trim();
  const payToWalletConfigured = /^0x[a-fA-F0-9]{40}$/.test(payTo);
  const facilitatorConfigured = Boolean((ENV.X402_FACILITATOR_VERIFY_URL || '').trim());
  const verifyMode = ENV.A2MCP_PAYMENT_VERIFY_MODE;
  const x402Enabled = ENV.A2MCP_X402_ENABLED;
  const ledgerStats = getPaymentLedger().getStats();

  const baseLedger = {
    paymentLedger: {
      path: ledgerStats.path,
      entryCount: ledgerStats.entryCount,
      persisted: ledgerStats.persisted,
    },
  };

  if (!x402Enabled) {
    return {
      tier: 'disabled',
      label: 'x402_disabled',
      externallyBillable: false,
      verifyMode,
      facilitatorConfigured,
      payToWalletConfigured,
      x402Enabled,
      settlementVerification: 'none',
      disclaimer:
        'A2MCP metered billing is disabled (A2MCP_X402_ENABLED=false). pay_per_call_utility runs without payment gate.',
      ...baseLedger,
    };
  }

  if (!payToWalletConfigured) {
    return {
      tier: 'misconfigured',
      label: 'misconfigured',
      externallyBillable: false,
      verifyMode,
      facilitatorConfigured,
      payToWalletConfigured,
      x402Enabled,
      settlementVerification: 'none',
      disclaimer:
        'A2MCP x402 is enabled but A2MCP_PAY_TO_WALLET is not set. Metered billing cannot settle.',
      ...baseLedger,
    };
  }

  if (verifyMode === 'facilitator' && facilitatorConfigured) {
    return {
      tier: 'production',
      label: 'facilitator_verified',
      externallyBillable: true,
      verifyMode,
      facilitatorConfigured,
      payToWalletConfigured,
      x402Enabled,
      settlementVerification: 'facilitator',
      disclaimer:
        'Server configured for facilitator settlement verify. Per-payment billingTier=production only when facilitator returns valid=true.',
      ...baseLedger,
    };
  }

  if (verifyMode === 'presence') {
    return {
      tier: 'in_development',
      label: 'presence_only_insecure',
      externallyBillable: false,
      verifyMode,
      facilitatorConfigured,
      payToWalletConfigured,
      x402Enabled,
      settlementVerification: 'none',
      disclaimer:
        'INSECURE DEV MODE: only checks header presence. Blocked when NODE_ENV=production.',
      ...baseLedger,
    };
  }

  return {
    tier: 'in_development',
    label: verifyMode === 'facilitator' ? 'facilitator_pending' : 'structural_beta',
    externallyBillable: false,
    verifyMode,
    facilitatorConfigured,
    payToWalletConfigured,
    x402Enabled,
    settlementVerification: 'structural',
    disclaimer:
      verifyMode === 'facilitator' && !facilitatorConfigured
        ? 'Facilitator mode selected but X402_FACILITATOR_VERIFY_URL is unset. Falling back to structural checks — on-chain settlement NOT confirmed.'
        : 'IN DEVELOPMENT: structural verify only (payTo/amount/ledger replay). On-chain settlement NOT confirmed until facilitator verify is wired for X Layer (chain 196).',
    ...baseLedger,
  };
}