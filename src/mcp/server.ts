import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ReputationScorer } from '../reputation/scorer';
import { NegotiationEngine } from '../negotiation/engine';
import { TaskSchema } from '../negotiation/schemas';
import { XLayerClient } from '../escrow/contract';
import { QuorixOrchestrator } from '../core/orchestrator';
import { MarketplaceScanner } from '../discovery/marketplace';
import type { OkxCliSession } from '../onchainos/taskMarketplace';
import {
  buildMcpToolDefinitions,
  getToolByName,
  QUORIX_MCP_SERVER_INSTRUCTIONS,
} from './registry';
import {
  AgentToolResponse,
  buildAgentError,
  buildAgentSuccess,
  classifyExecutionError,
  serializeAgentResponse,
} from './responses';

export interface McpToolResult {
  isError: boolean;
  content: Array<{ type: 'text'; text: string }>;
}

export class QuorixMcpServer {
  private server: Server;
  private repScorer: ReputationScorer;
  private negEngine: NegotiationEngine;
  private blockchainClient: XLayerClient;
  private orchestrator: QuorixOrchestrator;
  private marketplaceScanner: MarketplaceScanner;
  private resolveMarketplaceSession: () => Promise<OkxCliSession | null>;

  private rateLimitMap: Map<string, { count: number; resetTime: number }> = new Map();
  private maxRequestsPerWindow = 15;
  private rateLimitWindowMs = 60000;

  constructor(
    repScorer: ReputationScorer,
    negEngine: NegotiationEngine,
    blockchainClient: XLayerClient,
    orchestrator: QuorixOrchestrator,
    marketplaceScanner: MarketplaceScanner,
    resolveMarketplaceSession: () => Promise<OkxCliSession | null>
  ) {
    this.repScorer = repScorer;
    this.negEngine = negEngine;
    this.blockchainClient = blockchainClient;
    this.orchestrator = orchestrator;
    this.marketplaceScanner = marketplaceScanner;
    this.resolveMarketplaceSession = resolveMarketplaceSession;

    this.server = new Server(
      {
        name: 'quorix-mcp-server',
        version: '1.1.0',
        title: 'QuorixASP Agent Commerce Broker',
      },
      {
        capabilities: { tools: {} },
        instructions: QUORIX_MCP_SERVER_INSTRUCTIONS,
      }
    );

    this.setupHandlers();
  }

  private checkRateLimit(callerId: string): boolean {
    const now = Date.now();
    const limit = this.rateLimitMap.get(callerId);

    if (!limit) {
      this.rateLimitMap.set(callerId, { count: 1, resetTime: now + this.rateLimitWindowMs });
      return true;
    }

    if (now > limit.resetTime) {
      limit.count = 1;
      limit.resetTime = now + this.rateLimitWindowMs;
      this.rateLimitMap.set(callerId, limit);
      return true;
    }

    if (limit.count >= this.maxRequestsPerWindow) return false;

    limit.count++;
    this.rateLimitMap.set(callerId, limit);
    return true;
  }

  private sanitizeInput(input: string, maxLength = 500): string {
    return input.trim().slice(0, maxLength).replace(/[<>'"\\;]/g, '');
  }

  private toMcpResult(response: AgentToolResponse): McpToolResult {
    return {
      isError: !response.ok,
      content: [{ type: 'text', text: serializeAgentResponse(response) }],
    };
  }

  public async invokeTool(
    name: string,
    args: Record<string, unknown> = {},
    callerId = 'http-client'
  ): Promise<McpToolResult> {
    if (!getToolByName(name)) {
      return this.toMcpResult(
        buildAgentError(name, 'TOOL_NOT_FOUND', `Tool "${name}" is not registered.`, {
          hint: 'Call tools/list or GET /api/mcp/tools for available tool names.',
        })
      );
    }

    if (!this.checkRateLimit(callerId)) {
      return this.toMcpResult(
        buildAgentError(name, 'RATE_LIMITED', 'Rate limit exceeded. Maximum 15 requests per minute.', {
          hint: 'Wait 60 seconds or reduce call frequency.',
          retryable: true,
        })
      );
    }

    return this.executeTool(name, args);
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    try {
      switch (name) {
        case 'check_agent_reputation':
          return this.toMcpResult(await this.handleCheckReputation(args));

        case 'check_escrow_status':
          return this.toMcpResult(await this.handleCheckEscrow(args));

        case 'verify_task_proof':
          return this.toMcpResult(await this.handleVerifyProof(args));

        case 'evaluate_deal_proposal':
          return this.toMcpResult(await this.handleEvaluateProposal(args));

        case 'match_market_tasks':
          return this.toMcpResult(await this.handleMatchTasks(args));

        case 'pay_per_call_utility':
          return this.toMcpResult(this.handlePayPerCall(args));

        default:
          return this.toMcpResult(
            buildAgentError(name, 'TOOL_NOT_FOUND', `Tool "${name}" is not registered.`)
          );
      }
    } catch (err: unknown) {
      console.error(`[MCPServer] Tool execution error in ${name}:`, err);
      const classified = classifyExecutionError(err);
      return this.toMcpResult(
        buildAgentError(name, classified.code, classified.message, {
          hint: classified.hint,
          retryable: classified.retryable,
          field: classified.field,
        })
      );
    }
  }

  private async handleCheckReputation(args: Record<string, unknown>): Promise<AgentToolResponse> {
    const tool = 'check_agent_reputation';
    const agentAddress = String(args?.agentAddress || '').trim();

    if (!/^0x[a-fA-F0-9]{40}$/.test(agentAddress)) {
      return buildAgentError(tool, 'INVALID_ARGUMENT', 'Invalid agentAddress format.', {
        hint: 'Provide a 0x-prefixed EVM address with exactly 40 hex characters after 0x.',
        field: 'agentAddress',
      });
    }

    const profile = await this.repScorer.getAgentReputation(
      agentAddress,
      this.blockchainClient.publicClient
    );

    if (profile.scanFailed) {
      return buildAgentError(tool, 'RPC_UNAVAILABLE', 'Could not scan reputation logs on X Layer.', {
        hint: 'Retry in 30–120 seconds. RPC may be temporarily unavailable.',
        retryable: true,
      });
    }

    if (profile.totalRatingsCount === 0 && profile.totalEscrowsCount === 0) {
      return buildAgentSuccess(tool, {
        agentAddress: profile.agentAddress,
        status: 'no_history',
        trustSummary: 'No on-chain transaction history detected for this wallet.',
        recommendation: 'Treat as new agent — proceed with caution or request references.',
        isApproved: false,
      });
    }

    let trustSummary = 'Average track record.';
    let recommendation = 'Acceptable for standard deals with escrow protection.';
    if (profile.averageRating >= 4.5 && profile.disputeRate <= 0.05) {
      trustSummary = 'Strong track record with low dispute rate.';
      recommendation = 'Recommended counterparty for A2A deals.';
    } else if (profile.averageRating < 3.5 || profile.disputeRate > 0.2) {
      trustSummary = 'Elevated risk — low ratings or high dispute rate.';
      recommendation = 'Require higher escrow deposit or evaluator oversight.';
    }

    return buildAgentSuccess(tool, {
      agentAddress: profile.agentAddress,
      status: 'audited',
      averageRating: Number(profile.averageRating.toFixed(1)),
      totalRatedTransactions: profile.totalRatingsCount,
      totalEscrowsCount: profile.totalEscrowsCount,
      disputeRatePercent: Number((profile.disputeRate * 100).toFixed(1)),
      isApproved: profile.isApproved,
      trustSummary,
      recommendation,
    });
  }

  private async handleCheckEscrow(args: Record<string, unknown>): Promise<AgentToolResponse> {
    const tool = 'check_escrow_status';
    const taskId = String(args?.taskId || '').trim();

    if (!taskId) {
      return buildAgentError(tool, 'MISSING_ARGUMENT', 'taskId is required.', {
        hint: 'Pass the on-chain uint256 task ID (decimal string, e.g. "0", "1").',
        field: 'taskId',
      });
    }

    const escrow = await this.blockchainClient.getEscrowDetails(taskId);
    const statusMap = ['created', 'in_progress', 'completed', 'approved', 'disputed', 'resolved', 'cancelled'];
    const status = escrow.status >= 0 ? statusMap[escrow.status] || 'unknown' : 'not_found';
    const timeInStateSec = await this.blockchainClient.getEscrowTimeInCurrentState(
      taskId,
      escrow.status,
      escrow.disputedAt
    );

    return buildAgentSuccess(tool, {
      taskId: escrow.taskId,
      client: escrow.client,
      agentId: escrow.agentId.toString(),
      paymentUsdc: escrow.payment.toString(),
      paymentUsdcFormatted: (Number(escrow.payment) / 1e6).toFixed(6),
      description: escrow.description,
      status,
      statusLabel: status.replace('_', ' '),
      timeInCurrentStateSeconds: timeInStateSec,
      timeInCurrentStateMinutes: Math.floor(timeInStateSec / 60),
      resultHash: escrow.resultHash || null,
      nextAction:
        status === 'created' || status === 'in_progress'
          ? 'Monitor for proof submission or completion.'
          : status === 'disputed'
            ? 'Escalate to evaluator agent.'
            : 'No immediate action required.',
    });
  }

  private async handleVerifyProof(args: Record<string, unknown>): Promise<AgentToolResponse> {
    const tool = 'verify_task_proof';
    const taskId = String(args?.taskId || '').trim();
    const proofPayload = String(args?.proofPayload || '').trim();

    if (!taskId || !proofPayload) {
      return buildAgentError(tool, 'MISSING_ARGUMENT', 'Both taskId and proofPayload are required.', {
        hint: 'File the task via A2A first, then submit the deliverable proof hash.',
      });
    }

    const job = this.orchestrator.getJobState(taskId);
    if (!job) {
      return buildAgentError(
        tool,
        'NOT_FOUND',
        `Task "${taskId}" is not tracked by QuorixASP orchestrator.`,
        {
          hint: 'Create the task through evaluate_deal_proposal and A2A filing before verifying proof.',
        }
      );
    }

    const expected = job.task.expectedProofHash;
    if (!expected) {
      return buildAgentSuccess(tool, {
        taskId,
        verificationResult: 'needs_review',
        verified: false,
        details: 'No expectedProofHash on record. Evaluator arbitration required.',
        nextAction: 'Route to an evaluator agent for manual acceptance.',
      });
    }

    const match = expected.toLowerCase().trim() === proofPayload.toLowerCase().trim();
    return buildAgentSuccess(tool, {
      taskId,
      verificationResult: match ? 'verified' : 'rejected',
      verified: match,
      details: match
        ? 'Submitted proof matches the expected reference hash.'
        : 'Proof hash mismatch — deliverable does not match agreed reference.',
      nextAction: match ? 'Proceed with escrow release approval.' : 'Reject deliverable or open dispute.',
    });
  }

  private async handleEvaluateProposal(args: Record<string, unknown>): Promise<AgentToolResponse> {
    const tool = 'evaluate_deal_proposal';

    const task = TaskSchema.parse({
      id: this.sanitizeInput(String(args?.id || ''), 100),
      clientAddress: String(args?.clientAddress || '').trim(),
      title: this.sanitizeInput(String(args?.title || ''), 100),
      description: this.sanitizeInput(String(args?.description || ''), 1000),
      budgetWei: String(args?.budgetWei || ''),
      deadlineTimestamp: Number(args?.deadlineTimestamp),
      expectedProofHash: args?.expectedProofHash ? String(args.expectedProofHash) : undefined,
    });

    if (!/^0x[a-fA-F0-9]{40}$/.test(task.clientAddress)) {
      return buildAgentError(tool, 'INVALID_ARGUMENT', 'Invalid clientAddress format.', {
        hint: 'Provide the buyer agent wallet as 0x + 40 hex characters.',
        field: 'clientAddress',
      });
    }

    const evaluation = await this.negEngine.evaluateTaskProposal(task);
    return buildAgentSuccess(tool, {
      ...evaluation,
      nextAction:
        evaluation.status === 'ACCEPTED'
          ? 'File task and lock escrow on X Layer TaskManager.'
          : evaluation.status === 'COUNTERED'
            ? 'Review counter-proposal terms and renegotiate or accept.'
            : 'Revise budget, timeline, or scope before resubmitting.',
    });
  }

  private async handleMatchTasks(args: Record<string, unknown>): Promise<AgentToolResponse> {
    const tool = 'match_market_tasks';
    const minScore = Number(args?.minScore ?? 25);
    const limit = Math.min(50, Math.max(1, Number(args?.limit ?? 20)));

    const session = await this.resolveMarketplaceSession();
    if (!session) {
      return buildAgentError(tool, 'MISSING_ARGUMENT', 'No OKX CLI session with agent identity for marketplace match.', {
        hint:
          'Log in via the dashboard and register an ASP agent (onchainos agent create --role asp), then retry match_market_tasks.',
        retryable: true,
      });
    }

    const tasks = await this.marketplaceScanner.scanRecentTasks(
      { session, limit, minScore, mode: 'recommend' },
      true
    );

    return buildAgentSuccess(tool, {
      count: tasks.length,
      minScore,
      limit,
      feedMode: 'okx-cli-recommend-task',
      cacheNote: 'Results may be cached up to 60 seconds.',
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        clientAddress: t.clientAddress,
        agentId: t.agentId,
        paymentUsdc: t.paymentUsdc,
        paymentUsdcFormatted: (Number(BigInt(t.paymentUsdc || '0')) / 1e6).toFixed(4),
        score: t.score,
        matchedCapabilities: t.matchedCapabilities,
        portalUrl: t.portalUrl,
        source: t.source,
      })),
      nextAction:
        tasks.length > 0
          ? 'Call evaluate_deal_proposal on top matches, then check_agent_reputation on clients.'
          : 'Lower minScore or refresh after new tasks appear on okx.ai/tasks.',
    });
  }

  private handlePayPerCall(args: Record<string, unknown>): AgentToolResponse {
    const tool = 'pay_per_call_utility';
    const operation = this.sanitizeInput(String(args?.operation || ''), 50);

    return buildAgentError(tool, 'PAYMENT_REQUIRED', 'x402 payment authorization required.', {
      hint:
        'Connect via OKX.AI A2MCP with an active x402 payment channel. For hackathon demos, use the five live tools directly.',
      retryable: false,
    });
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: buildMcpToolDefinitions(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      console.error(`[MCPServer] Tool call: ${name}`);

      const result = await this.invokeTool(name, (args || {}) as Record<string, unknown>, 'stdio-client');
      return { isError: result.isError, content: result.content };
    });
  }

  public async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[MCPServer] QuorixASP MCP server active (stdio). Tools:', buildMcpToolDefinitions().length);
  }
}