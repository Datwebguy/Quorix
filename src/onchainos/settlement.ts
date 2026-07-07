import type { EscrowDetails } from '../escrow/contract';
import { isRealMarketplaceJobId, fetchOkxTaskStatus, okxStatusLabel } from './taskLifecycle';
import type { OkxCliSession } from './taskMarketplace';

export type EscrowSettlementPath = 'okx-cli-live' | 'reference-taskmanager';

export interface UnifiedEscrowSnapshot {
  settlementPath: EscrowSettlementPath;
  taskId: string;
  status: string;
  statusLabel: string;
  client?: string;
  agentId?: string;
  paymentAtomic?: string;
  paymentFormatted?: string;
  tokenSymbol?: string;
  description?: string;
  portalUrl?: string;
  aspNextStep?: string;
  okxStatusCode?: number | null;
  referenceEscrow?: EscrowDetails;
}

/**
 * Small decimal uint256 IDs map to the hackathon reference TaskManager demo.
 * Large numeric IDs (portal-scale OKX.AI listing ids) use the live CLI path instead.
 */
export function isReferenceTaskManagerId(taskId: string): boolean {
  const trimmed = taskId.trim();
  if (!trimmed || trimmed.startsWith('0x')) return false;
  if (!/^\d+$/.test(trimmed)) return false;
  try {
    return BigInt(trimmed) < 1000n;
  } catch {
    return false;
  }
}

function mapOkxStatusToEscrowLabel(statusCode: number | null | undefined): string {
  switch (statusCode) {
    case 0:
      return 'created';
    case 1:
      return 'in_progress';
    case 2:
      return 'completed';
    case 4:
      return 'disputed';
    case 6:
      return 'approved';
    case 7:
      return 'cancelled';
    case 3:
    case 8:
    case 9:
      return 'resolved';
    default:
      return 'unknown';
  }
}

function formatTokenAmount(amount?: string, symbol?: string): string | undefined {
  if (!amount) return undefined;
  const sym = (symbol || 'USDT').toUpperCase();
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${sym}`;
  return `${n.toFixed(sym === 'OKB' ? 4 : 2)} ${sym}`;
}

/**
 * Live OKX.AI marketplace escrow/settlement read via `onchainos agent status`.
 * Used for hex jobIds and numeric portal IDs — not the reference TaskManager contract.
 */
export async function fetchLiveOkxEscrowSnapshot(
  session: OkxCliSession,
  jobId: string
): Promise<UnifiedEscrowSnapshot> {
  const snapshot = await fetchOkxTaskStatus(session, jobId);
  const status = mapOkxStatusToEscrowLabel(snapshot.statusCode);

  return {
    settlementPath: 'okx-cli-live',
    taskId: snapshot.jobId,
    status,
    statusLabel: snapshot.statusLabel || okxStatusLabel(snapshot.statusCode),
    client: snapshot.clientAgentId,
    agentId: snapshot.providerAgentId,
    paymentAtomic: snapshot.tokenAmount,
    paymentFormatted: formatTokenAmount(snapshot.tokenAmount, snapshot.tokenSymbol),
    tokenSymbol: snapshot.tokenSymbol,
    description: snapshot.title,
    portalUrl: snapshot.portalUrl,
    aspNextStep: snapshot.aspNextStep,
    okxStatusCode: snapshot.statusCode,
  };
}

export function snapshotFromReferenceEscrow(escrow: EscrowDetails): UnifiedEscrowSnapshot {
  const statusMap = [
    'created',
    'in_progress',
    'completed',
    'approved',
    'disputed',
    'resolved',
    'cancelled',
  ];
  const status = escrow.status >= 0 ? statusMap[escrow.status] || 'unknown' : 'not_found';

  return {
    settlementPath: 'reference-taskmanager',
    taskId: escrow.taskId,
    status,
    statusLabel: status.replace('_', ' '),
    client: escrow.client,
    agentId: escrow.agentId.toString(),
    paymentAtomic: escrow.payment.toString(),
    paymentFormatted: (Number(escrow.payment) / 1e6).toFixed(6) + ' USDC',
    tokenSymbol: 'USDC',
    description: escrow.description,
    referenceEscrow: escrow,
  };
}

export function requiresLiveOkxSettlementPath(taskId: string): boolean {
  if (!isRealMarketplaceJobId(taskId)) return false;
  const trimmed = String(taskId || '').trim();
  if (/^0x[a-fA-F0-9]+$/i.test(trimmed)) return true;
  if (/^\d+$/.test(trimmed)) {
    try {
      return BigInt(trimmed) >= 1000n;
    } catch {
      return false;
    }
  }
  return false;
}