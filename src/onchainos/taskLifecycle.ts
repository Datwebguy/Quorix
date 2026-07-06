import {
  assertOnchainOsOk,
  execOnchainOs,
  parseOnchainOsJson,
} from './exec';
import type { OkxCliSession } from './taskMarketplace';

type CliEnvelope<T> = { ok?: boolean; error?: string; data?: T; message?: string };

export interface OkxTaskStatusSnapshot {
  jobId: string;
  statusCode: number | null;
  statusLabel: string;
  title?: string;
  tokenAmount?: string;
  tokenSymbol?: string;
  clientAgentId?: string;
  providerAgentId?: string;
  portalUrl?: string;
  aspNextStep: string;
  raw?: unknown;
}

const STATUS_LABELS: Record<number, string> = {
  [-1]: 'DRAFT',
  0: 'CREATED',
  1: 'ACCEPTED',
  2: 'SUBMITTED',
  3: 'REFUSED',
  4: 'DISPUTED',
  5: 'ADMIN_STOPPED',
  6: 'COMPLETED',
  7: 'CLOSED',
  8: 'EXPIRED',
  9: 'FAILED',
};

export function okxStatusLabel(code: number | null | undefined): string {
  if (code == null || !Number.isFinite(code)) return 'UNKNOWN';
  return STATUS_LABELS[code] ?? `STATUS_${code}`;
}

export function portalUrlForJob(jobId: string): string | undefined {
  const id = String(jobId || '').trim();
  if (/^\d+$/.test(id)) return `https://www.okx.ai/tasks/${id}`;
  if (/^0x[a-fA-F0-9]+$/i.test(id)) return `https://www.okx.ai/tasks/${id}`;
  return undefined;
}

/** ASP-facing guidance keyed to OKX.AI on-chain status codes. */
export function aspNextStepForStatus(statusCode: number | null | undefined): string {
  switch (statusCode) {
    case -1:
      return 'Task is still a draft on OKX.AI and is not open for providers yet.';
    case 0:
      return 'Negotiation channel opened. The task publisher must review your proposal, designate you as provider, and fund escrow on OKX.AI before work starts.';
    case 1:
      return 'Client accepted and escrow is locked. You may begin deliverables on OKX.AI.';
    case 2:
      return 'Deliverable submitted. Waiting for the client to review and release payment on OKX.AI.';
    case 3:
      return 'The client refused this delivery. Review the negotiation thread on OKX.AI.';
    case 4:
      return 'Task is in dispute on OKX.AI. Follow the arbitration flow there.';
    case 5:
      return 'Task was stopped by OKX.AI admin. No further action from QuorixASP.';
    case 6:
      return 'Task completed on OKX.AI. Payment has been released to the provider.';
    case 7:
      return 'Task closed on OKX.AI. Funds were returned to the client.';
    case 8:
      return 'Task expired on OKX.AI before completion.';
    case 9:
      return 'Task failed on OKX.AI (arbitration ruled for the client).';
    default:
      return 'Check this job on OKX.AI for the latest marketplace status.';
  }
}

function normalizeStatusPayload(jobId: string, data: unknown): OkxTaskStatusSnapshot {
  const record =
    data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const nested =
    record.task && typeof record.task === 'object'
      ? (record.task as Record<string, unknown>)
      : record;

  const statusRaw =
    nested.statusCode ??
    nested.status ??
    record.statusCode ??
    record.status;
  const statusCode =
    statusRaw != null && statusRaw !== '' && Number.isFinite(Number(statusRaw))
      ? Number(statusRaw)
      : null;

  const resolvedJobId = String(
    nested.jobId ?? nested.id ?? record.jobId ?? record.id ?? jobId
  );

  return {
    jobId: resolvedJobId,
    statusCode,
    statusLabel: okxStatusLabel(statusCode),
    title: nested.title != null ? String(nested.title) : undefined,
    tokenAmount:
      nested.tokenAmount != null
        ? String(nested.tokenAmount)
        : nested.budget != null
          ? String(nested.budget)
          : undefined,
    tokenSymbol: nested.tokenSymbol != null ? String(nested.tokenSymbol) : undefined,
    clientAgentId:
      nested.clientAgentId != null
        ? String(nested.clientAgentId)
        : nested.buyerAgentId != null
          ? String(nested.buyerAgentId)
          : undefined,
    providerAgentId:
      nested.providerAgentId != null
        ? String(nested.providerAgentId)
        : nested.aspAgentId != null
          ? String(nested.aspAgentId)
          : undefined,
    portalUrl: portalUrlForJob(resolvedJobId),
    aspNextStep: aspNextStepForStatus(statusCode),
    raw: data,
  };
}

/** Live OKX.AI job status via `onchainos agent status`. */
export async function fetchOkxTaskStatus(
  session: OkxCliSession,
  jobId: string
): Promise<OkxTaskStatusSnapshot> {
  const args = ['agent', 'status', String(jobId), '--agent-id', session.agentId];
  const { stdout } = await execOnchainOs(args, session.homeDir, 90_000);
  const payload = parseOnchainOsJson<CliEnvelope<unknown>>(stdout);
  assertOnchainOsOk(payload, 'agent status');
  return normalizeStatusPayload(jobId, payload.data ?? payload);
}

/** Start real ASP negotiation — `onchainos agent contact-user`. */
export async function contactUserForTask(
  session: OkxCliSession,
  jobId: string
): Promise<{ ok: true; message: string; data?: unknown }> {
  const args = [
    'agent',
    'contact-user',
    String(jobId),
    '--agent-id',
    session.agentId,
  ];
  const { stdout } = await execOnchainOs(args, session.homeDir, 120_000);
  const payload = parseOnchainOsJson<CliEnvelope<unknown>>(stdout);
  assertOnchainOsOk(payload, 'agent contact-user');
  const message =
    typeof payload.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : 'Opened negotiation with the task publisher on OKX.AI.';
  return { ok: true, message, data: payload.data };
}

export function isRealMarketplaceJobId(id: unknown): boolean {
  const s = String(id || '').trim();
  if (!s || s.startsWith('neg-') || s.startsWith('filed-')) return false;
  return /^\d+$/.test(s) || /^0x[a-fA-F0-9]+$/i.test(s);
}