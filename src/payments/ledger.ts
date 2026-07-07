import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ENV } from '../config/env';
import type { PaymentVerifyMode } from './types';

/**
 * Append-only audit log for successful x402 verifications.
 *
 * Survives process restarts (Fly volume at /data) and backs replay protection.
 * Each line is a JSON PaymentLedgerEntry.
 *
 * Limitation: file-based ledger is adequate for single-instance Fly deploys.
 * For horizontal scale, migrate to SQLite/Postgres with unique index on signatureDigest.
 */
export interface PaymentLedgerEntry {
  id: string;
  signatureDigest: string;
  payer?: string;
  payTo: string;
  amountAtomic: string;
  operation: string;
  verifyMode: PaymentVerifyMode;
  settlementVerified: boolean;
  transaction?: string;
  callerId?: string;
  verifiedAt: string;
}

export interface PaymentLedgerStats {
  path: string;
  entryCount: number;
  persisted: boolean;
}

function defaultLedgerPath(): string {
  const configured = (process.env.PAYMENT_LEDGER_PATH || '').trim();
  if (configured) return configured;

  const dataDir = '/data';
  if (fs.existsSync(dataDir)) {
    return path.join(dataDir, 'payment-ledger.jsonl');
  }

  return path.join(process.cwd(), '.data', 'payment-ledger.jsonl');
}

export class PaymentLedger {
  private readonly digests = new Set<string>();
  private entryCount = 0;

  constructor(private readonly filePath: string = defaultLedgerPath()) {
    this.loadExisting();
  }

  private loadExisting(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as PaymentLedgerEntry;
          if (entry.signatureDigest) {
            this.digests.add(entry.signatureDigest);
            this.entryCount++;
          }
        } catch {
          /* skip corrupt lines */
        }
      }
    } catch (err) {
      console.warn('[PaymentLedger] Failed to load ledger:', err);
    }
  }

  hasDigest(digest: string): boolean {
    return this.digests.has(digest);
  }

  /**
   * Reserve digest before execution completes — prevents concurrent double-spend.
   * Call only after all other verification checks pass.
   */
  reserveDigest(digest: string): boolean {
    if (this.digests.has(digest)) return false;
    this.digests.add(digest);
    return true;
  }

  async record(entry: Omit<PaymentLedgerEntry, 'id' | 'verifiedAt'>): Promise<PaymentLedgerEntry> {
    const full: PaymentLedgerEntry = {
      ...entry,
      id: crypto.randomUUID(),
      verifiedAt: new Date().toISOString(),
    };

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await fs.promises.appendFile(this.filePath, `${JSON.stringify(full)}\n`, 'utf8');
    this.entryCount++;
    this.digests.add(full.signatureDigest);
    return full;
  }

  getStats(): PaymentLedgerStats {
    return {
      path: this.filePath,
      entryCount: this.entryCount,
      persisted: fs.existsSync(this.filePath),
    };
  }

  listRecent(limit = 20): PaymentLedgerEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim());
      const entries: PaymentLedgerEntry[] = [];
      for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
        try {
          entries.push(JSON.parse(lines[i]) as PaymentLedgerEntry);
        } catch {
          /* skip */
        }
      }
      return entries;
    } catch {
      return [];
    }
  }
}

let ledgerSingleton: PaymentLedger | null = null;

export function getPaymentLedger(): PaymentLedger {
  if (!ledgerSingleton) {
    ledgerSingleton = new PaymentLedger(
      (process.env.PAYMENT_LEDGER_PATH || '').trim() || defaultLedgerPath()
    );
  }
  return ledgerSingleton;
}

/** Test helper — reset singleton and optionally point at a temp file. */
export function resetPaymentLedgerForTests(filePath?: string): PaymentLedger {
  ledgerSingleton = new PaymentLedger(filePath || path.join(process.cwd(), '.data', 'test-ledger.jsonl'));
  return ledgerSingleton;
}