/**
 * OKX.AI Agent Ecosystem — A2MCP Service Exposure
 *
 * OKX.AI ASPs (Agent Service Providers) register on-chain via ERC-8004 on X Layer.
 * API services use serviceType "A2MCP" with a public HTTPS endpoint and USDT fee.
 *
 * Integration path for QuorixASP:
 * 1. Deploy broker daemon to a public HTTPS host (not localhost).
 * 2. Register ASP identity: `onchainos agent create --role asp`
 * 3. Add A2MCP services with endpoints from buildOkxServiceManifest().
 * 4. Activate ASP listing so buyer agents can discover via `onchainos agent search`.
 * 5. Buyer agents call POST /api/mcp/invoke with tool + arguments.
 *    pay_per_call_utility returns HTTP 402 + PAYMENT-REQUIRED until buyer replays with PAYMENT-SIGNATURE.
 *
 * MCP stdio transport is for local agent runtimes (Cursor, Claude Desktop).
 * HTTP bridge (/api/mcp/*) is for OKX.AI platform and remote agent callers.
 *
 * @see https://web3.okx.com/onchainos/dev-docs (X Layer agent identity & A2MCP)
 */

import { ENV } from '../config/env';
import { QUORIX_MCP_SERVER_INSTRUCTIONS, QUORIX_MCP_TOOLS } from './registry';

export interface OkxA2mcpServiceTemplate {
  serviceName: string;
  serviceDescription: string;
  serviceType: 'A2MCP';
  fee: string;
  endpoint: string;
}

export interface QuorixMcpManifest {
  schema: 'quorix-mcp-manifest/v1';
  server: {
    name: string;
    version: string;
    instructions: string;
    provider: string;
    chain: string;
    chainId: number;
  };
  transports: {
    stdio: { command: string; args: string[] };
    http: {
      toolsList: string;
      toolInvoke: string;
      manifest: string;
      health: string;
    };
  };
  okxAi: {
    integrationStatus: 'ready' | 'pending-deployment' | 'payment-gated';
    aspRole: 'asp';
    serviceType: 'A2MCP';
    registrationHint: string;
    suggestedServices: OkxA2mcpServiceTemplate[];
  };
  tools: Array<{
    name: string;
    displayName: string;
    status: string;
    category: string;
    summary: string;
    whenToUse: string;
    agentHints: string[];
    inputSchema: unknown;
    example: Record<string, unknown>;
  }>;
  rateLimit: { maxPerMinute: number; scope: string };
}

function resolvePublicBaseUrl(): string {
  const configured = process.env.PUBLIC_BASE_URL || process.env.QUORIX_PUBLIC_URL || '';
  if (configured) return configured.replace(/\/$/, '');
  return `http://localhost:${ENV.PORT}`;
}

export function buildOkxServiceTemplates(baseUrl?: string): OkxA2mcpServiceTemplate[] {
  const base = (baseUrl || resolvePublicBaseUrl()).replace(/\/$/, '');
  const invokeEndpoint = `${base}/api/mcp/invoke`;

  return [
    {
      serviceName: 'Quorix Reputation Audit',
      serviceDescription:
        'On-chain agent reputation audit on X Layer.\n' +
        'User provides: 1. agent wallet address (0x...)',
      serviceType: 'A2MCP',
      fee: '0.005',
      endpoint: invokeEndpoint,
    },
    {
      serviceName: 'Quorix Escrow Monitor',
      serviceDescription:
        'Read escrow / settlement status for an OKX.AI marketplace job or reference TaskManager task.\n' +
        'User provides: 1. task ID (hex jobId or decimal reference taskId)',
      serviceType: 'A2MCP',
      fee: '0.005',
      endpoint: invokeEndpoint,
    },
    {
      serviceName: 'Quorix Metered Utility (x402)',
      serviceDescription:
        'Pay-per-call x402 gateway delegating to reputation_audit, escrow_check, or task_match.\n' +
        'User provides: 1. operation name 2. PAYMENT-SIGNATURE header from onchainos payment pay',
      serviceType: 'A2MCP',
      fee: '0.005',
      endpoint: invokeEndpoint,
    },
    {
      serviceName: 'Quorix Task Matcher',
      serviceDescription:
        'Discover open TaskCreated events ranked by capability match.\n' +
        'User provides: 1. minimum match score (optional) 2. result limit (optional)',
      serviceType: 'A2MCP',
      fee: '0.005',
      endpoint: invokeEndpoint,
    },
  ];
}

export function buildQuorixMcpManifest(baseUrl?: string): QuorixMcpManifest {
  const base = (baseUrl || resolvePublicBaseUrl()).replace(/\/$/, '');
  const isLocal = base.includes('localhost') || base.includes('127.0.0.1');

  return {
    schema: 'quorix-mcp-manifest/v1',
    server: {
      name: 'quorix-mcp-server',
      version: '1.1.0',
      instructions: QUORIX_MCP_SERVER_INSTRUCTIONS,
      provider: 'QuorixASP',
      chain: 'X Layer',
      chainId: 196,
    },
    transports: {
      stdio: {
        command: 'node',
        args: ['dist/src/index.js'],
      },
      http: {
        toolsList: `${base}/api/mcp/tools`,
        toolInvoke: `${base}/api/mcp/invoke`,
        manifest: `${base}/api/mcp/manifest`,
        health: `${base}/api/mcp/health`,
      },
    },
    okxAi: {
      integrationStatus: isLocal ? 'pending-deployment' : 'ready',
      aspRole: 'asp',
      serviceType: 'A2MCP',
      registrationHint: isLocal
        ? 'Deploy to a public HTTPS URL, set PUBLIC_BASE_URL in .env, then register ASP services via OKX.AI agent identity (onchainos agent create --role asp).'
        : 'Register ASP on OKX.AI with A2MCP services from suggestedServices. Point endpoint to /api/mcp/invoke.',
      suggestedServices: buildOkxServiceTemplates(base),
    },
    tools: QUORIX_MCP_TOOLS.map((t) => ({
      name: t.name,
      displayName: t.displayName,
      status: t.status,
      category: t.category,
      summary: t.summary,
      whenToUse: t.whenToUse,
      agentHints: t.agentHints,
      inputSchema: t.inputSchema,
      example: t.example,
    })),
    rateLimit: {
      maxPerMinute: 15,
      scope: 'per caller wallet (x-agent-address header) or IP',
    },
  };
}