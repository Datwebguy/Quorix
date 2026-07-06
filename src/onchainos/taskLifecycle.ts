import {
  assertOnchainOsOk,
  execOnchainOs,
  isContactUserPlainSuccess,
  parseOnchainOsJson,
} from './exec';
import { portalUrlForJob } from './portalUrls';
import type { OkxCliSession } from './taskMarketplace';

export { portalLinkHint, portalUrlForJob } from './portalUrls';

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

const STATUS_NAME_TO_CODE: Record<string, number> = {
  draft: -1,
  created: 0,
  accepted: 1,
  submitted: 2,
  rejected: 3,
  refused: 3,
  disputed: 4,
  admin_stopped: 5,
  completed: 6,
  complete: 6,
  closed: 7,
  close: 7,
  expired: 8,
  failed: 9,
};

function statusCodeFromRaw(statusRaw: unknown): number | null {
  if (statusRaw == null || statusRaw === '') return null;
  if (typeof statusRaw === 'number' && Number.isFinite(statusRaw)) return statusRaw;
  const asNum = Number(statusRaw);
  if (Number.isFinite(asNum) && String(statusRaw).trim() !== '') return asNum;
  const key = String(statusRaw).trim().toLowerCase().replace(/\s+/g, '_');
  return STATUS_NAME_TO_CODE[key] ?? null;
}

export function okxStatusLabel(code: number | null | undefined): string {
  if (code == null || !Number.isFinite(code)) return 'UNKNOWN';
  return STATUS_LABELS[code] ?? `STATUS_${code}`;
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
  const statusCode = statusCodeFromRaw(statusRaw);
  const statusLabel =
    statusCode != null
      ? okxStatusLabel(statusCode)
      : statusRaw != null
        ? String(statusRaw).trim().toUpperCase()
        : 'UNKNOWN';

  const resolvedJobId = String(
    nested.jobId ?? nested.id ?? record.jobId ?? record.id ?? jobId
  );

  return {
    jobId: resolvedJobId,
    statusCode,
    statusLabel,
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

/** Parse `agent status` plain-text blocks (Task status: created, jobId: …). */
export function parsePlainTaskStatus(stdout: string, fallbackJobId: string): OkxTaskStatusSnapshot | null {
  const text = (stdout || '').trim();
  if (!text || text.startsWith('{')) return null;

  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();
    if (key && value) fields[key] = value;
  }

  const statusName =
    fields['task status']?.replace(/^task\s+status:\s*/i, '').trim() ||
    fields.status?.trim() ||
    (() => {
      const m = text.match(/task\s+status:\s*(\S+)/i);
      return m ? m[1] : '';
    })();

  if (!statusName && !fields.jobid && !fields.title) return null;

  const statusCode = statusCodeFromRaw(statusName);
  const resolvedJobId = fields.jobid || fields['job id'] || fallbackJobId;

  let tokenAmount: string | undefined;
  let tokenSymbol: string | undefined;
  const budget = fields.budget?.trim();
  if (budget) {
    const budgetMatch = budget.match(/^([\d.]+)\s*([A-Za-z]+)?$/);
    if (budgetMatch) {
      tokenAmount = budgetMatch[1];
      tokenSymbol = budgetMatch[2]?.toUpperCase();
    }
  }

  return {
    jobId: resolvedJobId,
    statusCode,
    statusLabel:
      statusCode != null
        ? okxStatusLabel(statusCode)
        : statusName
          ? statusName.toUpperCase()
          : 'UNKNOWN',
    title: fields.title,
    tokenAmount,
    tokenSymbol,
    clientAgentId: fields.user || fields.client || fields.buyer,
    providerAgentId: fields.asp || fields.provider || fields.seller,
    portalUrl: portalUrlForJob(resolvedJobId),
    aspNextStep: aspNextStepForStatus(statusCode),
    raw: text,
  };
}

/** Live OKX.AI job status via `onchainos agent status`. */
export async function fetchOkxTaskStatus(
  session: OkxCliSession,
  jobId: string
): Promise<OkxTaskStatusSnapshot> {
  const args = ['agent', 'status', String(jobId), '--agent-id', session.agentId];
  const { stdout } = await execOnchainOs(args, session.homeDir, 90_000);

  try {
    const payload = parseOnchainOsJson<CliEnvelope<unknown>>(stdout);
    assertOnchainOsOk(payload, 'agent status');
    return normalizeStatusPayload(jobId, payload.data ?? payload);
  } catch {
    const plain = parsePlainTaskStatus(stdout, jobId);
    if (plain) return plain;
    throw new Error(
      `Could not parse OKX.AI task status: ${stdout.trim().slice(0, 240)}${stdout.length > 240 ? '…' : ''}`
    );
  }
}

function summarizePlainContactOutput(stdout: string): string {
  const line =
    (stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) || '';
  if (!line) return 'Opened negotiation with the task publisher on OKX.AI.';
  if (/cold[- ]?start|cold[- ]?sta/i.test(line)) {
    return 'Cold-start opener sent to the task publisher on OKX.AI. Wait for their reply in the OKX.AI negotiation channel.';
  }
  return line.length > 280 ? `${line.slice(0, 277)}…` : line;
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
  const { stdout, stderr } = await execOnchainOs(args, session.homeDir, 120_000);

  try {
    const payload = parseOnchainOsJson<CliEnvelope<unknown>>(stdout);
    assertOnchainOsOk(payload, 'agent contact-user');
    const message =
      typeof payload.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : 'Opened negotiation with the task publisher on OKX.AI.';
    return { ok: true, message, data: payload.data };
  } catch (parseErr) {
    // contact-user failures return JSON { ok:false }; exit 0 + non-JSON = plain-text success
    if (stdout.trim() && (isContactUserPlainSuccess(stdout, stderr) || !stdout.trim().startsWith('{'))) {
      return { ok: true, message: summarizePlainContactOutput(stdout) };
    }
    throw parseErr;
  }
}

export function isRealMarketplaceJobId(id: unknown): boolean {
  const s = String(id || '').trim();
  if (!s || s.startsWith('neg-') || s.startsWith('filed-')) return false;
  return /^\d+$/.test(s) || /^0x[a-fA-F0-9]+$/i.test(s);
}