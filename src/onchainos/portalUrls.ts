export const OKX_TASKS_HOME = 'https://www.okx.ai/tasks';

/** Numeric listing IDs open a public OKX.AI task page; hex jobIds are CLI/on-chain only. */
export function isNumericPortalTaskId(id: unknown): boolean {
  return /^\d+$/.test(String(id || '').trim());
}

export function isHexJobId(id: unknown): boolean {
  return /^0x[a-fA-F0-9]+$/i.test(String(id || '').trim());
}

/** Best public task page URL when a numeric listing id is known. */
export function portalUrlForJob(jobId: string, portalTaskId?: string | null): string | undefined {
  const portal = String(portalTaskId || jobId || '').trim();
  if (isNumericPortalTaskId(portal)) return `${OKX_TASKS_HOME}/${portal}`;
  return undefined;
}

export function portalLinkHint(jobId: string, portalTaskId?: string | null): string {
  const direct = portalUrlForJob(jobId, portalTaskId);
  if (direct) return `View task on OKX.AI: ${direct}`;
  const ref = String(jobId || '').trim();
  return (
    `On-chain job ${ref.slice(0, 10)}…${ref.slice(-4)} has no public web page. ` +
    `Log in at ${OKX_TASKS_HOME}, open My Tasks, and find this job there (OKX.AI links use numeric IDs only).`
  );
}