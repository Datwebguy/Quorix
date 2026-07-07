import { Tool } from '@modelcontextprotocol/sdk/types.js';

export type McpToolStatus = 'live' | 'payment-gated';

export interface QuorixMcpToolDefinition {
  name: string;
  displayName: string;
  status: McpToolStatus;
  category: string;
  provider: string;
  summary: string;
  description: string;
  whenToUse: string;
  agentHints: string[];
  example: Record<string, unknown>;
  inputSchema: Tool['inputSchema'];
  annotations?: Tool['annotations'];
  okxService?: {
    /** Maps to OKX.AI ASP serviceType A2MCP */
    billable: boolean;
    suggestedFeeUsdt: string;
    operationId?: string;
  };
}

export const QUORIX_MCP_SERVER_INSTRUCTIONS = `QuorixASP is an OKX.AI Agent Service Provider (ASP) broker on X Layer (chainId 196).
It exposes MCP tools for agent-to-agent commerce: reputation audits, escrow monitoring, deal negotiation, task discovery, and proof verification.

Calling conventions:
- Prefer structured JSON responses (ok, tool, data, error, meta).
- All EVM addresses must be 0x-prefixed, 42-character hex strings.
- paymentUsdc / budgetWei values are USDC atomic units (6 decimals; 1 USDC = 1_000_000).
- deadlineTimestamp is a Unix epoch seconds integer.
- Rate limit: 15 calls/minute per caller (wallet address or IP).

Workflow for buyer agents:
1. match_market_tasks → discover open escrow opportunities
2. check_agent_reputation → vet counterparty ASP wallets
3. evaluate_deal_proposal → negotiate SLA before locking escrow
4. check_escrow_status → monitor payment lock state
5. verify_task_proof → confirm deliverable hashes

OKX.AI integration: register QuorixASP as an ASP with A2MCP services pointing to the public HTTPS endpoint (see /api/mcp/manifest).`;

export const QUORIX_MCP_TOOLS: QuorixMcpToolDefinition[] = [
  {
    name: 'check_agent_reputation',
    displayName: 'Check Agent Reputation',
    status: 'live',
    category: 'Trust & Safety',
    provider: 'X Layer X402Rating',
    summary: 'On-chain reputation audit for any agent wallet on X Layer.',
    description:
      'Scans X Layer TaskManager and X402Rating event logs for an agent wallet. Returns average rating, dispute rate, escrow count, approval status, and a human-readable trust summary. Use before hiring an unknown ASP or accepting a counterparty in A2A negotiation.',
    whenToUse:
      'Call when you need to vet a counterparty agent before escrow lock, task assignment, or deal acceptance.',
    agentHints: [
      'Input: agentAddress (required) — EVM wallet of the agent to audit.',
      'No history is a valid result (status: no_history), not an error.',
      'Combine with evaluate_deal_proposal for full due diligence.',
    ],
    example: { agentAddress: '0x1a80eb8d3e28e9afd87b71bdb283287d8af1ae8d' },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    okxService: { billable: true, suggestedFeeUsdt: '0.005', operationId: 'reputation_audit' },
    inputSchema: {
      type: 'object',
      properties: {
        agentAddress: {
          type: 'string',
          description: 'EVM hex address (0x + 40 hex chars) of the agent to audit.',
          pattern: '^0x[a-fA-F0-9]{40}$',
        },
      },
      required: ['agentAddress'],
    },
  },
  {
    name: 'check_escrow_status',
    displayName: 'Check Escrow Status',
    status: 'live',
    category: 'Escrow Monitor',
    provider: 'X Layer TaskManager',
    summary: 'Read escrow / settlement state for a task ID.',
    description:
      'Routes by taskId format: OKX.AI marketplace hex/numeric jobIds use live `onchainos agent status` (production path). Decimal uint256 IDs query the reference TaskManager contract (hackathon demo only). Returns settlement path, status, payment amount, and ASP next-step guidance.',
    whenToUse: 'Call after a deal is filed or when tracking whether funds are locked, released, or disputed.',
    agentHints: [
      'Input: taskId (required) — OKX.AI hex jobId (0x…) or reference TaskManager decimal uint256.',
      'Live marketplace jobs return settlementPath: okx-cli-live.',
      'Pair with verify_task_proof after deliverable submission.',
    ],
    example: { taskId: '0' },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    okxService: { billable: true, suggestedFeeUsdt: '0.005', operationId: 'escrow_check' },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'OKX.AI hex jobId (0x…) or reference TaskManager decimal uint256 string.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'verify_task_proof',
    displayName: 'Verify Task Proof',
    status: 'live',
    category: 'Proof Verification',
    provider: 'Quorix Orchestrator',
    summary: 'Verify a deliverable proof hash against the expected reference for a tracked task.',
    description:
      'Compares a submitted proofPayload (hash or reference string) against the expectedProofHash recorded when the task was filed. Returns verified, rejected, or needs-review. Used by buyer agents and evaluators at delivery acceptance.',
    whenToUse: 'Call when a provider agent submits a deliverable and you need cryptographic proof verification.',
    agentHints: [
      'Inputs: taskId + proofPayload (both required).',
      'Task must exist in QuorixASP orchestrator (file via A2A first).',
      'needs-review means no expected hash was set — escalate to evaluator.',
    ],
    example: { taskId: 'task-proposal-001', proofPayload: '0xabc123...' },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Tracked task ID from QuorixASP orchestrator.' },
        proofPayload: {
          type: 'string',
          description: 'Submitted proof hash or deliverable reference to verify.',
        },
      },
      required: ['taskId', 'proofPayload'],
    },
  },
  {
    name: 'evaluate_deal_proposal',
    displayName: 'Evaluate Deal Proposal',
    status: 'live',
    category: 'A2A Negotiation',
    provider: 'SLA Engine',
    summary: 'Evaluate a task proposal against QuorixASP SLA rules and return ACCEPTED, COUNTERED, or DECLINED.',
    description:
      'Runs the QuorixASP negotiation engine on a structured task proposal. Checks budget floor, timeline feasibility, and scope alignment. On acceptance or counter, returns a formal SLA proposal with priceWei, timelineDays, deliverables, and escrow release conditions.',
    whenToUse:
      'Call before opening OKX.AI negotiation — buyer agents send proposals; QuorixASP responds with SLA terms or counter-offers.',
    agentHints: [
      'Required: id, clientAddress, title, description, budgetWei (string), deadlineTimestamp (unix seconds).',
      'budgetWei minimum is typically 0.05 USDC (50000 atomic units, 6 decimals).',
      'On ACCEPTED: ASP contacts publisher on OKX.AI; escrow locks on publisher confirm-accept.',
    ],
    example: {
      id: 'task-proposal-001',
      clientAddress: '0x1a80eb8d3e28e9afd87b71bdb283287d8af1ae8d',
      title: 'Deploy monitoring dashboard',
      description: 'Build and deploy a React dashboard with on-chain task feed.',
      budgetWei: '50000',
      deadlineTimestamp: Math.floor(Date.now() / 1000) + 5 * 24 * 3600,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique proposal identifier from the calling agent.' },
        clientAddress: { type: 'string', description: 'Buyer agent wallet address (0x + 40 hex).' },
        title: { type: 'string', description: 'Short task title (max 100 chars).' },
        description: { type: 'string', description: 'Deliverable scope and requirements (max 1000 chars).' },
        budgetWei: { type: 'string', description: 'Offered payment in USDC atomic units (6 decimals) as a decimal string.' },
        deadlineTimestamp: { type: 'number', description: 'Unix timestamp (seconds) for delivery deadline.' },
        expectedProofHash: {
          type: 'string',
          description: 'Optional proof hash to verify at delivery.',
        },
      },
      required: ['id', 'clientAddress', 'title', 'description', 'budgetWei', 'deadlineTimestamp'],
    },
  },
  {
    name: 'match_market_tasks',
    displayName: 'Match Market Tasks',
    status: 'live',
    category: 'Task Discovery',
    provider: 'On-chain Scanner',
    summary: 'Discover and rank open TaskCreated events on X Layer matching QuorixASP capabilities.',
    description:
      'Runs onchainos agent recommend-task against the live okx.ai/tasks marketplace and ranks results by semantic capability match score (0–100). Returns job IDs, USDT budgets, client agent IDs, portal URLs, and matched capabilities. Primary A2A discovery tool for provider agents seeking work.',
    whenToUse: 'Call when a provider agent wants to find open escrow opportunities on X Layer.',
    agentHints: [
      'Optional: minScore (default 25), limit (default 20, max 50).',
      'Higher minScore returns fewer but better-matched tasks.',
      'Results may be cached up to 60s; RPC outages serve stale cache up to 10 min.',
    ],
    example: { minScore: 25, limit: 10 },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    okxService: { billable: true, suggestedFeeUsdt: '0.005', operationId: 'task_match' },
    inputSchema: {
      type: 'object',
      properties: {
        minScore: {
          type: 'number',
          description: 'Minimum capability match score 0–100. Default 25.',
          minimum: 0,
          maximum: 100,
        },
        limit: {
          type: 'number',
          description: 'Maximum tasks to return. Default 20, max 50.',
          minimum: 1,
          maximum: 50,
        },
      },
    },
  },
  {
    name: 'pay_per_call_utility',
    displayName: 'Pay Per Call Utility',
    status: 'payment-gated',
    category: 'A2MCP Billing',
    provider: 'x402 Payment Channel',
    summary: 'x402-gated micro-execution endpoint for metered A2MCP billing (in development until facilitator verify).',
    description:
      'OKX Agent Payments Protocol metered billing on QuorixASP. Unpaid POST /api/mcp/invoke returns HTTP 402 with PAYMENT-REQUIRED (x402 v2). Buyer signs via onchainos payment pay, replays with PAYMENT-SIGNATURE, and receives the delegated operation result (reputation_audit, escrow_check, or task_match). Billing integrity: production settlement requires facilitator verify on X Layer — currently structural checks only (see /api/status a2mcpBilling).',
    whenToUse: 'Call when integrating OKX.AI A2MCP pay-per-call billing. Treat as in-development until a2mcpBilling.tier is production.',
    agentHints: [
      'First call without PAYMENT-SIGNATURE → HTTP 402 + PAYMENT-REQUIRED header.',
      'Sign: onchainos payment pay --payload <base64 PAYMENT-REQUIRED>.',
      'Replay POST /api/mcp/invoke with PAYMENT-SIGNATURE and tool arguments.',
      'Settlement currencies: USDT (and USDG when configured).',
      'Check /api/status → a2mcpBilling.externallyBillable before relying on paid execution.',
    ],
    example: { operation: 'reputation_audit' },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    okxService: { billable: true, suggestedFeeUsdt: '0.005', operationId: 'metered_call' },
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: 'Billable operation identifier.',
          enum: ['reputation_audit', 'escrow_check', 'task_match'],
        },
        agentAddress: {
          type: 'string',
          description: 'Required when operation=reputation_audit — counterparty wallet to audit.',
          pattern: '^0x[a-fA-F0-9]{40}$',
        },
        taskId: {
          type: 'string',
          description: 'Required when operation=escrow_check — OKX.AI jobId or reference task ID.',
        },
        minScore: {
          type: 'number',
          description: 'Optional when operation=task_match — minimum match score 0–100.',
        },
        limit: {
          type: 'number',
          description: 'Optional when operation=task_match — max tasks to return.',
        },
      },
      required: ['operation'],
    },
  },
];

export function getToolByName(name: string): QuorixMcpToolDefinition | undefined {
  return QUORIX_MCP_TOOLS.find((t) => t.name === name);
}

export function buildMcpToolDefinitions(): Tool[] {
  return QUORIX_MCP_TOOLS.map((t) => ({
    name: t.name,
    description: `${t.summary}\n\n${t.description}\n\nWhen to use: ${t.whenToUse}`,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}

/** @deprecated Use QUORIX_MCP_TOOLS — kept for backward-compatible imports */
export const QUORIX_MCP_TOOL_META = QUORIX_MCP_TOOLS.map((t) => ({
  name: t.name,
  status: t.status,
  category: t.category,
  provider: t.provider,
  example: t.example,
  displayName: t.displayName,
  summary: t.summary,
}));