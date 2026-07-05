import {
  assertOnchainOsOk,
  execOnchainOs,
  parseOnchainOsJson,
} from './exec';

export interface OkxCliSession {
  homeDir: string;
  agentId: string;
}

export interface OkxMarketplaceTaskRow {
  jobId: string;
  title?: string;
  description?: string;
  descriptionSummary?: string;
  status?: string | number;
  clientAgentId?: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenAmount?: string;
  createTime?: string | number;
  score?: number;
  matchedCapabilities?: string[];
}

export interface TaskSearchOptions {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: number[];
  amountMin?: number;
  amountMax?: number;
  orderBy?: 'create_time_desc' | 'create_time_asc' | 'amount_desc' | 'amount_asc';
}

export interface TaskSearchResult {
  total: number;
  page: number;
  pageSize: number;
  tasks: OkxMarketplaceTaskRow[];
}

type CliEnvelope<T> = { ok?: boolean; error?: string; data?: T };

type AgentListRow = {
  agentId?: string | number;
  role?: string | number;
  roleLabel?: string;
  name?: string;
};

function normalizeTasksPayload(data: unknown): OkxMarketplaceTaskRow[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const list = record.tasks ?? record.list ?? record.recommendations ?? record.jobs;
  if (!Array.isArray(list)) return [];
  return list.map((row) => {
    const item = row as Record<string, unknown>;
    return {
      jobId: String(item.jobId ?? item.id ?? item.taskId ?? ''),
      title: item.title != null ? String(item.title) : undefined,
      description:
        item.description != null
          ? String(item.description)
          : item.descriptionSummary != null
            ? String(item.descriptionSummary)
            : undefined,
      descriptionSummary:
        item.descriptionSummary != null ? String(item.descriptionSummary) : undefined,
      status: item.status as string | number | undefined,
      clientAgentId:
        item.clientAgentId != null
          ? String(item.clientAgentId)
          : item.clientAgent != null
            ? String(item.clientAgent)
            : undefined,
      tokenAddress: item.tokenAddress != null ? String(item.tokenAddress) : undefined,
      tokenSymbol: item.tokenSymbol != null ? String(item.tokenSymbol) : undefined,
      tokenAmount:
        item.tokenAmount != null
          ? String(item.tokenAmount)
          : item.budget != null
            ? String(item.budget)
            : undefined,
      createTime: item.createTime as string | number | undefined,
      score: typeof item.score === 'number' ? item.score : undefined,
      matchedCapabilities: Array.isArray(item.matchedCapabilities)
        ? item.matchedCapabilities.map(String)
        : undefined,
    };
  });
}

function buildSearchArgs(session: OkxCliSession, options: TaskSearchOptions): string[] {
  const args = [
    'agent',
    'task-search',
    '--agent-id',
    session.agentId,
    '--page',
    String(options.page ?? 1),
    '--page-size',
    String(options.pageSize ?? 20),
  ];
  if (options.keyword) args.push('--keyword', options.keyword);
  if (options.amountMin != null) args.push('--amount-min', String(options.amountMin));
  if (options.amountMax != null) args.push('--amount-max', String(options.amountMax));
  if (options.orderBy) args.push('--order-by', options.orderBy);
  if (options.status?.length) {
    for (const s of options.status) args.push('--status', String(s));
  }
  return args;
}

/**
 * Production OKX.AI marketplace browse — POST /priapi/v1/aieco/task/job/search
 * Requires a logged-in wallet session and an agentId owned by that wallet.
 */
export async function taskSearch(
  session: OkxCliSession,
  options: TaskSearchOptions = {}
): Promise<TaskSearchResult> {
  const args = buildSearchArgs(session, options);
  const { stdout } = await execOnchainOs(args, session.homeDir);
  const payload = parseOnchainOsJson<CliEnvelope<Record<string, unknown>>>(stdout);
  assertOnchainOsOk(payload, 'task-search');

  const data = payload.data ?? (payload as unknown as Record<string, unknown>);
  const tasks = normalizeTasksPayload(data);
  const total = Number((data as Record<string, unknown>).total ?? tasks.length);
  const page = Number((data as Record<string, unknown>).page ?? options.page ?? 1);
  const pageSize = Number(
    (data as Record<string, unknown>).pageSize ?? options.pageSize ?? tasks.length
  );

  return { total, page, pageSize, tasks };
}

/**
 * ASP skill-matched recommendations — onchainos agent recommend-task
 * Used by the A2A Task Matchmaker path (not generic marketplace browse).
 */
export async function recommendTask(
  session: OkxCliSession,
  options: { pageSize?: number } = {}
): Promise<TaskSearchResult> {
  const args = ['agent', 'recommend-task', '--agent-id', session.agentId];
  const { stdout } = await execOnchainOs(args, session.homeDir);
  const payload = parseOnchainOsJson<CliEnvelope<Record<string, unknown>>>(stdout);
  assertOnchainOsOk(payload, 'recommend-task');

  const data = payload.data ?? (payload as unknown as Record<string, unknown>);
  let tasks = normalizeTasksPayload(data);
  const pageSize = options.pageSize ?? 20;
  if (tasks.length > pageSize) tasks = tasks.slice(0, pageSize);

  const total = Number((data as Record<string, unknown>).total ?? tasks.length);
  return { total, page: 1, pageSize, tasks };
}

function pickAgentIdFromList(list: AgentListRow[]): string | null {
  if (!list.length) return null;
  const asp = list.find(
    (a) => a.roleLabel === 'ASP' || String(a.role) === '2' || String(a.role) === 'asp'
  );
  const chosen = asp ?? list[0];
  return chosen?.agentId != null ? String(chosen.agentId) : null;
}

function flattenAgentListRows(data: unknown): AgentListRow[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as { list?: unknown[] };
  if (!Array.isArray(record.list)) return [];
  const rows: AgentListRow[] = [];
  for (const entry of record.list) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as { agentList?: AgentListRow[] } & AgentListRow;
    if (Array.isArray(item.agentList)) {
      rows.push(...item.agentList);
    } else if (item.agentId != null) {
      rows.push(item);
    }
  }
  return rows;
}

async function resolveAgentIdFromGetMyAgents(homeDir: string): Promise<string | null> {
  try {
    const { stdout } = await execOnchainOs(['agent', 'get-my-agents'], homeDir);
    const payload = parseOnchainOsJson<CliEnvelope<{ list?: unknown[] }>>(stdout);
    if (payload?.ok === false) return null;
    return pickAgentIdFromList(flattenAgentListRows(payload.data));
  } catch {
    return null;
  }
}

async function resolveAgentIdFromMyAgents(homeDir: string): Promise<string | null> {
  try {
    const { stdout } = await execOnchainOs(['agent', 'my-agents'], homeDir);
    const payload = parseOnchainOsJson<CliEnvelope<AgentListRow[] | { list?: AgentListRow[] }>>(stdout);
    if (payload?.ok === false) return null;
    const raw = payload.data;
    const list = Array.isArray(raw) ? raw : raw?.list ?? [];
    return pickAgentIdFromList(list);
  } catch {
    return null;
  }
}

async function resolveConfiguredAgentId(homeDir: string): Promise<string | null> {
  const configured = process.env.AGENT_ID?.trim();
  if (!configured || !(await walletIsLoggedIn(homeDir))) return null;
  try {
    const { stdout } = await execOnchainOs(['agent', 'get', '--agent-ids', configured], homeDir);
    type AgentGetPayload = CliEnvelope<{ list?: Array<{ agentList?: AgentListRow[] }> }>;
    const payload = parseOnchainOsJson<AgentGetPayload>(stdout);
    if (payload?.ok === false) return null;
    const rows =
      payload.data?.list?.flatMap((group) => group.agentList ?? []) ?? [];
    if (rows.some((row) => String(row.agentId) === configured)) {
      return configured;
    }
  } catch {
    return null;
  }
  return null;
}

/** Resolve the first ASP agent on a wallet, falling back to any agent identity. */
export async function resolveAgentIdForSession(homeDir: string): Promise<string | null> {
  const fromGetMyAgents = await resolveAgentIdFromGetMyAgents(homeDir);
  if (fromGetMyAgents) return fromGetMyAgents;

  const fromMyAgents = await resolveAgentIdFromMyAgents(homeDir);
  if (fromMyAgents) return fromMyAgents;

  return resolveConfiguredAgentId(homeDir);
}

export async function walletIsLoggedIn(homeDir: string): Promise<boolean> {
  try {
    const { stdout } = await execOnchainOs(['wallet', 'status'], homeDir);
    const payload = parseOnchainOsJson<CliEnvelope<{ loggedIn?: boolean }>>(stdout);
    return payload?.ok === true && payload.data?.loggedIn === true;
  } catch {
    return false;
  }
}