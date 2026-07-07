import { ENV } from '../config/env';
import type { PaymentAuthorization } from './authorization';
import { X_LAYER_CAIP2 } from './x402Challenge';

export type PaymentVerifyMode = 'facilitator' | 'structural' | 'presence';

export interface PaymentVerifyContext {
  payTo: string;
  amountAtomic: string;
  network?: string;
  operation: string;
}

export interface PaymentVerifyResult {
  ok: boolean;
  mode: PaymentVerifyMode;
  /** production = facilitator confirmed; beta = structural checks; insecure = presence only */
  level: 'production' | 'beta' | 'insecure';
  reason?: string;
  payer?: string;
  transaction?: string;
}

/** Replay protection — signature digest → first-seen timestamp */
const usedSignatureDigests = new Map<string, number>();
const REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

function pruneReplayCache(): void {
  const now = Date.now();
  for (const [digest, seenAt] of usedSignatureDigests) {
    if (now - seenAt > REPLAY_TTL_MS) usedSignatureDigests.delete(digest);
  }
}

function digestSignature(value: string): string {
  // Lightweight stable digest without importing crypto-heavy deps at module load
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return `${value.length}:${h.toString(16)}`;
}

function decodeBase64Json(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates = [trimmed, trimmed.replace(/-/g, '+').replace(/_/g, '/')];
  for (const c of candidates) {
    try {
      const json = Buffer.from(c, 'base64').toString('utf8');
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  return null;
}

function normalizeAddr(addr: unknown): string {
  return String(addr || '')
    .trim()
    .toLowerCase();
}

function extractPayTo(payload: Record<string, unknown>): string | null {
  const direct =
    payload.payTo ??
    payload.pay_to ??
    payload.recipient ??
    (payload.authorization as Record<string, unknown> | undefined)?.to;
  if (direct) return normalizeAddr(direct);

  const nested = payload.payload as Record<string, unknown> | undefined;
  if (nested?.authorization && typeof nested.authorization === 'object') {
    const auth = nested.authorization as Record<string, unknown>;
    if (auth.to) return normalizeAddr(auth.to);
  }
  return null;
}

function extractAmountAtomic(payload: Record<string, unknown>): bigint | null {
  const candidates = [
    payload.amount,
    payload.value,
    payload.maxAmountRequired,
    (payload.authorization as Record<string, unknown> | undefined)?.value,
  ];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    try {
      return BigInt(String(c));
    } catch {
      /* continue */
    }
  }
  const nested = payload.payload as Record<string, unknown> | undefined;
  if (nested?.authorization && typeof nested.authorization === 'object') {
    const v = (nested.authorization as Record<string, unknown>).value;
    if (v != null) {
      try {
        return BigInt(String(v));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function extractPayer(payload: Record<string, unknown>): string | undefined {
  const from =
    payload.from ??
    payload.payer ??
    payload.wallet ??
    (payload.authorization as Record<string, unknown> | undefined)?.from;
  return from ? String(from) : undefined;
}

async function verifyViaFacilitator(
  auth: PaymentAuthorization,
  ctx: PaymentVerifyContext
): Promise<PaymentVerifyResult | null> {
  const url = (ENV.X402_FACILITATOR_VERIFY_URL || '').trim();
  if (!url) return null;

  const paymentRequirements = {
    scheme: 'exact',
    network: ctx.network || X_LAYER_CAIP2,
    payTo: ctx.payTo,
    amount: ctx.amountAtomic,
    maxAmountRequired: ctx.amountAtomic,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentPayload: auth.value,
        paymentHeader: auth.headerName,
        paymentRequirements,
        x402Version: 2,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return {
        ok: false,
        mode: 'facilitator',
        level: 'production',
        reason: `Facilitator verify HTTP ${res.status}`,
      };
    }

    const body = (await res.json()) as Record<string, unknown>;
    const valid = body.valid === true || body.isValid === true || body.ok === true;
    return {
      ok: valid,
      mode: 'facilitator',
      level: 'production',
      reason: valid ? undefined : String(body.reason || body.error || 'Facilitator rejected payment'),
      payer: body.payer ? String(body.payer) : undefined,
      transaction: body.transaction ? String(body.transaction) : undefined,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      mode: 'facilitator',
      level: 'production',
      reason: `Facilitator verify failed: ${(err as Error)?.message || err}`,
    };
  }
}

function verifyStructurally(
  auth: PaymentAuthorization,
  ctx: PaymentVerifyContext
): PaymentVerifyResult {
  const raw = auth.value.trim();
  if (raw.length < 16) {
    return {
      ok: false,
      mode: 'structural',
      level: 'beta',
      reason: 'PAYMENT-SIGNATURE too short to be a valid x402 authorization.',
    };
  }

  pruneReplayCache();
  const digest = digestSignature(raw);
  if (usedSignatureDigests.has(digest)) {
    return {
      ok: false,
      mode: 'structural',
      level: 'beta',
      reason: 'Payment signature replay detected (already used for a metered call).',
    };
  }

  const decoded = decodeBase64Json(raw);
  const expectedPayTo = normalizeAddr(ctx.payTo);
  const requiredAmount = BigInt(ctx.amountAtomic || '0');

  if (decoded) {
    const payTo = extractPayTo(decoded);
    if (payTo && payTo !== expectedPayTo) {
      return {
        ok: false,
        mode: 'structural',
        level: 'beta',
        reason: 'Payment authorization payTo does not match this ASP wallet.',
      };
    }

    const amount = extractAmountAtomic(decoded);
    if (amount != null && requiredAmount > 0n && amount < requiredAmount) {
      return {
        ok: false,
        mode: 'structural',
        level: 'beta',
        reason: `Payment amount ${amount} is below required ${requiredAmount} atomic units.`,
      };
    }
  }

  // Opaque EIP-3009 / assembled headers may not be JSON — still gate on length + replay
  usedSignatureDigests.set(digest, Date.now());

  return {
    ok: true,
    mode: 'structural',
    level: 'beta',
    payer: decoded ? extractPayer(decoded) : undefined,
    reason:
      decoded
        ? 'Structural x402 checks passed (payTo/amount/replay). Facilitator settlement not confirmed.'
        : 'Opaque PAYMENT-SIGNATURE accepted after replay/length checks. Facilitator settlement not confirmed.',
  };
}

function verifyPresenceOnly(): PaymentVerifyResult {
  return {
    ok: true,
    mode: 'presence',
    level: 'insecure',
    reason:
      'INSECURE: A2MCP_PAYMENT_VERIFY_MODE=presence — header existence only, no settlement verify.',
  };
}

/**
 * Verify buyer payment authorization before executing metered MCP calls.
 *
 * Modes (A2MCP_PAYMENT_VERIFY_MODE):
 *   facilitator — POST to X402_FACILITATOR_VERIFY_URL (production when URL supports X Layer)
 *   structural  — beta: decode header, match payTo/amount, anti-replay (default)
 *   presence    — insecure: header exists only (dev emergency override)
 */
export async function verifyPaymentAuthorization(
  auth: PaymentAuthorization | null | undefined,
  ctx: PaymentVerifyContext
): Promise<PaymentVerifyResult> {
  if (!auth?.value?.trim()) {
    return {
      ok: false,
      mode: ENV.A2MCP_PAYMENT_VERIFY_MODE,
      level: 'beta',
      reason: 'Missing PAYMENT-SIGNATURE or X-PAYMENT header.',
    };
  }

  const mode = ENV.A2MCP_PAYMENT_VERIFY_MODE;

  if (mode === 'presence') {
    return verifyPresenceOnly();
  }

  if (mode === 'facilitator') {
    const facilitator = await verifyViaFacilitator(auth, ctx);
    if (facilitator) {
      if (facilitator.ok) return facilitator;
      // Fall through to structural when facilitator rejects or misconfigured network
      if (ENV.X402_FACILITATOR_VERIFY_URL) return facilitator;
    }
  }

  return verifyStructurally(auth, ctx);
}

export function verificationLevelLabel(result: PaymentVerifyResult): string {
  if (result.level === 'production') return 'facilitator_verified';
  if (result.level === 'beta') return 'structural_beta';
  return 'presence_only_insecure';
}