import crypto from 'crypto';
import type { PaymentAuthorization } from './authorization';

/** Stable SHA-256 digest of the raw authorization header value (replay key). */
export function digestSignature(value: string): string {
  return crypto.createHash('sha256').update(value.trim()).digest('hex');
}

export function decodeBase64Json(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates = [trimmed, trimmed.replace(/-/g, '+').replace(/_/g, '/')];
  for (const c of candidates) {
    try {
      const json = Buffer.from(c, 'base64').toString('utf8');
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* try next encoding */
    }
  }
  return null;
}

export function normalizeAddr(addr: unknown): string {
  return String(addr || '')
    .trim()
    .toLowerCase();
}

export function extractPayTo(payload: Record<string, unknown>): string | null {
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

export function extractAmountAtomic(payload: Record<string, unknown>): bigint | null {
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

export function extractPayer(payload: Record<string, unknown>): string | undefined {
  const from =
    payload.from ??
    payload.payer ??
    payload.wallet ??
    (payload.authorization as Record<string, unknown> | undefined)?.from;
  return from ? String(from) : undefined;
}

export function decodeAuthorization(auth: PaymentAuthorization): {
  digest: string;
  decoded: Record<string, unknown> | null;
} {
  const raw = auth.value.trim();
  return {
    digest: digestSignature(raw),
    decoded: decodeBase64Json(raw),
  };
}