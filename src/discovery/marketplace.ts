import { logErrorOnce, logWarnOnce } from '../utils/logDedupe';
import { SemanticMatcher } from './matching';
import { portalUrlForJob } from '../onchainos/portalUrls';
import {
  OkxCliSession,
  recommendTask,
  resolveAgentIdForSession,
  taskSearch,
  type OkxMarketplaceTaskRow,
} from '../onchainos/taskMarketplace';

export type MarketplaceFeedMode = 'search' | 'recommend';

export interface DiscoveredMarketTask {
  id: string;
  title: string;
  description: string;
  clientAddress: string;
  agentId: string;
  /** Human-readable payment from task-search (e.g. "3.3" / "USDT"). */
  tokenAmount: string;
  tokenSymbol: string;
  paymentUsdc: string;
  /** @deprecated Use tokenAmount+tokenSymbol — 6-decimal atomic USDT units, NOT 18-decimal OKB wei. */
  budgetWei: string;
  /** @deprecated Use agentId — kept for dashboard compatibility. */
  providerAddress: string;
  /** Unix seconds from API createTime when available. */
  createTime?: number;
  deadlineTimestamp: number;
  /** OKX marketplace job status code (0=created, 1=accepted, …). */
  marketplaceStatus?: number;
  marketplaceStatusLabel: string;
  /** Broker pipeline status for tasks QuorixASP has not yet touched. */
  status: 'DISCOVERED';
  score: number;
  matchedCapabilities: string[];
  /** Production feed uses okx-cli; reference hackathon scanner uses reference-on-chain. */
  source: 'okx-cli' | 'okx-cli-recommend' | 'reference-on-chain';
  blockNumber: string;
  txHash: string;
  portalUrl?: string;
  /** Numeric OKX.AI listing id for public /tasks/{id} pages (separate from hex jobId). */
  portalTaskId?: string;
}

export interface MarketplaceScanOptions {
  session: OkxCliSession | null;
  limit?: number;
  minScore?: number;
  mode?: MarketplaceFeedMode;
  keyword?: string;
  status?: number[];
}

function logWarnOnceStaleCache(): void {
  logWarnOnce(
    'marketplace-stale-cache',
    '[Marketplace] OKX CLI unavailable — serving last cached marketplace list.'
  );
}

function usdtAmountToAtomic(amount: string | undefined): string {
  if (!amount) return '0';
  const trimmed = amount.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const [whole, frac = ''] = trimmed.split('.');
  const padded = (frac + '000000').slice(0, 6);
  return `${whole || '0'}${padded}`.replace(/^0+(?=\d)/, '') || '0';
}

function parseCreateTime(value: string | number | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** OKX task-search status codes → display labels (per okx-agent-task state machine). */
function marketplaceStatusLabel(status: string | number | undefined): string {
  const code = Number(status);
  if (!Number.isFinite(code)) return 'UNKNOWN';
  const labels: Record<number, string> = {
    0: 'CREATED',
    1: 'ACCEPTED',
    2: 'SUBMITTED',
    3: 'REFUSED',
    4: 'DISPUTED',
    5: 'CLOSED',
    6: 'COMPLETED',
    7: 'CANCELLED',
    8: 'FAILED',
    9: 'EXPIRED',
  };
  return labels[code] ?? `STATUS_${code}`;
}

function dedupeByJobId(tasks: DiscoveredMarketTask[]): DiscoveredMarketTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = task.id.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mapCliRow(
  row: OkxMarketplaceTaskRow,
  matcher: SemanticMatcher,
  source: DiscoveredMarketTask['source']
): DiscoveredMarketTask {
  const title = row.title || `OKX.AI Task ${row.jobId}`;
  const description =
    row.description ||
    row.descriptionSummary ||
    `Public task on OKX.AI marketplace (job ${row.jobId}).`;

  const tokenAmount = row.tokenAmount?.trim() || '0';
  const tokenSymbol = row.tokenSymbol?.trim() || 'USDT';
  const paymentAtomic = usdtAmountToAtomic(tokenAmount);
  const createTime = parseCreateTime(row.createTime);
  const marketplaceStatus =
    row.status != null && row.status !== '' ? Number(row.status) : undefined;

  const portalTaskId = (() => {
    const candidates = [row.portalTaskId, row.taskId, row.id].filter((v) => v != null && v !== '');
    for (const c of candidates) {
      const s = String(c).trim();
      if (/^\d+$/.test(s) && s !== row.jobId) return s;
    }
    return /^\d+$/.test(row.jobId) ? row.jobId : undefined;
  })();

  const match = matcher.matchTask({
    id: row.jobId,
    title,
    description,
    clientAddress: row.clientAgentId || '0x0000000000000000000000000000000000000000',
    budgetWei: paymentAtomic,
    deadlineTimestamp: createTime ?? Math.floor(Date.now() / 1000),
  });

  const score =
    typeof row.score === 'number' ? Math.round(row.score) : match.score;

  return {
    id: row.jobId,
    title,
    description,
    clientAddress: row.clientAgentId || '',
    agentId: row.clientAgentId || '',
    tokenAmount,
    tokenSymbol,
    paymentUsdc: paymentAtomic,
    budgetWei: paymentAtomic,
    providerAddress: row.clientAgentId || '',
    createTime,
    deadlineTimestamp: createTime ?? Math.floor(Date.now() / 1000),
    marketplaceStatus: Number.isFinite(marketplaceStatus) ? marketplaceStatus : undefined,
    marketplaceStatusLabel: marketplaceStatusLabel(row.status),
    status: 'DISCOVERED',
    score,
    matchedCapabilities: row.matchedCapabilities?.length
      ? row.matchedCapabilities
      : match.matchedCapabilities,
    source,
    blockNumber: '',
    txHash: '',
    portalTaskId,
    portalUrl: portalUrlForJob(row.jobId, portalTaskId),
  };
}

export class MarketplaceScanner {
  private cache: { tasks: DiscoveredMarketTask[]; fetchedAt: number; total: number } | null = null;
  private cacheTtlMs = 60_000;
  private staleCacheTtlMs = 10 * 60_000;
  private scanInFlight: Promise<DiscoveredMarketTask[]> | null = null;
  private lastFailureAt = 0;
  private failureCooldownMs = 120_000;
  private consecutiveFailures = 0;
  private lastAuthError: string | null = null;

  constructor(private matcher: SemanticMatcher) {}

  getLastAuthError(): string | null {
    return this.lastAuthError;
  }

  clearLastAuthError(): void {
    this.lastAuthError = null;
  }

  private filterTasks(tasks: DiscoveredMarketTask[], limit: number, minScore: number) {
    return tasks.filter((t) => t.score >= minScore).slice(0, limit);
  }

  getCachedTasks(limit = 30, minScore = 0): DiscoveredMarketTask[] {
    if (!this.cache) return [];
    return this.filterTasks(this.cache.tasks, limit, minScore);
  }

  getCachedTotal(): number {
    return this.cache?.total ?? 0;
  }

  isCacheFresh(): boolean {
    return !!this.cache && Date.now() - this.cache.fetchedAt < this.cacheTtlMs;
  }

  hasStaleCache(): boolean {
    return !!this.cache && Date.now() - this.cache.fetchedAt < this.staleCacheTtlMs;
  }

  isInFailureCooldown(): boolean {
    return !!this.lastFailureAt && Date.now() - this.lastFailureAt < this.failureCooldownMs;
  }

  isScanInProgress(): boolean {
    return this.scanInFlight !== null;
  }

  private recordScanFailure(err: unknown, context: string): DiscoveredMarketTask[] {
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();
    this.failureCooldownMs = Math.min(300_000, 60_000 + this.consecutiveFailures * 30_000);

    const stdout = typeof (err as { stdout?: string })?.stdout === 'string'
      ? (err as { stdout: string }).stdout
      : '';
    let message = err instanceof Error ? err.message : String(err);
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout.trim()) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        if (stdout.length < 500) message = stdout;
      }
    }
    if (/session expired|not bound to the current user|auth fail|please login/i.test(message)) {
      this.lastAuthError = message;
    }

    logErrorOnce(`marketplace-scan-${context}`, `[Marketplace] ${context}: ${message}`);

    if (this.cache && Date.now() - this.cache.fetchedAt < this.staleCacheTtlMs) {
      logWarnOnceStaleCache();
      return this.cache.tasks;
    }
    return [];
  }

  private recordScanSuccess(tasks: DiscoveredMarketTask[], total: number): DiscoveredMarketTask[] {
    this.consecutiveFailures = 0;
    this.lastFailureAt = 0;
    this.failureCooldownMs = 120_000;
    this.lastAuthError = null;
    this.cache = { tasks, fetchedAt: Date.now(), total };
    return tasks;
  }

  private shouldAttemptScan(): boolean {
    if (this.isCacheFresh()) return false;
    if (this.scanInFlight) return false;
    if (this.lastFailureAt && Date.now() - this.lastFailureAt < this.failureCooldownMs) {
      return false;
    }
    return true;
  }

  triggerBackgroundScan(session: OkxCliSession | null, mode: MarketplaceFeedMode = 'search'): void {
    if (!this.shouldAttemptScan()) return;
    this.scanInFlight = this.scanFromCli({ session, mode })
      .catch((err) => this.recordScanFailure(err, 'Background CLI scan failed'))
      .finally(() => {
        this.scanInFlight = null;
      });
  }

  /**
   * Production marketplace feed — wraps `onchainos agent task-search` or `recommend-task`.
   * @param waitForScan when false, returns cache immediately and refreshes in background.
   */
  async scanRecentTasks(
    options: MarketplaceScanOptions,
    waitForScan = true
  ): Promise<DiscoveredMarketTask[]> {
    const limit = options.limit ?? 30;
    const minScore = options.minScore ?? 0;

    if (this.isCacheFresh()) {
      return this.filterTasks(this.cache!.tasks, limit, minScore);
    }

    if (!waitForScan) {
      this.triggerBackgroundScan(options.session, options.mode);
      return this.getCachedTasks(limit, minScore);
    }

    if (this.isInFailureCooldown() && this.hasStaleCache()) {
      return this.filterTasks(this.cache!.tasks, limit, minScore);
    }

    if (this.scanInFlight) {
      const shared = await this.scanInFlight;
      return this.filterTasks(shared, limit, minScore);
    }

    if (!this.shouldAttemptScan()) {
      return this.getCachedTasks(limit, minScore);
    }

    this.scanInFlight = this.scanFromCli(options)
      .catch((err) => this.recordScanFailure(err, 'CLI scan failed'))
      .finally(() => {
        this.scanInFlight = null;
      });

    const discovered = await this.scanInFlight;
    return this.filterTasks(discovered, limit, minScore);
  }

  private async scanFromCli(options: MarketplaceScanOptions): Promise<DiscoveredMarketTask[]> {
    const session = options.session;
    if (!session?.homeDir || !session.agentId) {
      throw new Error(
        'Marketplace CLI scan requires a logged-in wallet session with at least one agent identity (onchainos agent get-my-agents).'
      );
    }

    const limit = options.limit ?? 30;
    const mode = options.mode ?? 'search';

    const result =
      mode === 'recommend'
        ? await recommendTask(session, { pageSize: limit })
        : await taskSearch(session, {
            page: 1,
            pageSize: limit,
            keyword: options.keyword,
            status: options.status ?? [0],
            orderBy: 'create_time_desc',
          });

    const source: DiscoveredMarketTask['source'] =
      mode === 'recommend' ? 'okx-cli-recommend' : 'okx-cli';

    const mapped = dedupeByJobId(
      result.tasks.map((row) => mapCliRow(row, this.matcher, source))
    );
    mapped.sort((a, b) => b.score - a.score);

    return this.recordScanSuccess(mapped, result.total);
  }

  /** Helper used by the daemon when only homeDir is known (resolves agentId via CLI). */
  async resolveSession(homeDir: string): Promise<OkxCliSession | null> {
    const agentId = await resolveAgentIdForSession(homeDir);
    if (agentId) return { homeDir, agentId };
    const configured = process.env.AGENT_ID?.trim();
    if (configured) return { homeDir, agentId: configured };
    return null;
  }
}