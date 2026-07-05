export type McpErrorCode =
  | 'INVALID_ARGUMENT'
  | 'MISSING_ARGUMENT'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'PAYMENT_REQUIRED'
  | 'RPC_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'TOOL_NOT_FOUND';

export interface AgentToolError {
  code: McpErrorCode;
  message: string;
  hint?: string;
  retryable?: boolean;
  field?: string;
}

export interface AgentToolResponse<T = unknown> {
  ok: boolean;
  tool: string;
  data: T | null;
  error: AgentToolError | null;
  meta: {
    provider: string;
    chain: string;
    chainId: number;
    timestamp: string;
    version: string;
  };
}

const SERVER_VERSION = '1.1.0';

export function buildAgentSuccess<T>(tool: string, data: T): AgentToolResponse<T> {
  return {
    ok: true,
    tool,
    data,
    error: null,
    meta: {
      provider: 'QuorixASP',
      chain: 'X Layer',
      chainId: 196,
      timestamp: new Date().toISOString(),
      version: SERVER_VERSION,
    },
  };
}

export function buildAgentError(
  tool: string,
  code: McpErrorCode,
  message: string,
  options: { hint?: string; retryable?: boolean; field?: string } = {}
): AgentToolResponse<null> {
  return {
    ok: false,
    tool,
    data: null,
    error: { code, message, ...options },
    meta: {
      provider: 'QuorixASP',
      chain: 'X Layer',
      chainId: 196,
      timestamp: new Date().toISOString(),
      version: SERVER_VERSION,
    },
  };
}

export function serializeAgentResponse(response: AgentToolResponse): string {
  return JSON.stringify(response, null, 2);
}

export function parseLegacyPayload(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function classifyExecutionError(err: unknown): AgentToolError {
  const msg = String((err as { message?: string })?.message || err);

  if (msg.includes('Rate limit')) {
    return {
      code: 'RATE_LIMITED',
      message: 'Rate limit exceeded. Maximum 15 tool calls per minute per caller.',
      hint: 'Wait 60 seconds before retrying, or batch reputation checks.',
      retryable: true,
    };
  }
  if (msg.includes('Invalid EVM') || msg.includes('Invalid client address')) {
    return {
      code: 'INVALID_ARGUMENT',
      message: msg,
      hint: 'Pass a checksummed or lowercase 0x-prefixed EVM address (42 characters).',
      field: 'agentAddress',
    };
  }
  if (msg.includes('Missing taskId') || msg.includes('Missing taskId or proofPayload')) {
    return {
      code: 'MISSING_ARGUMENT',
      message: msg,
      hint: 'Provide all required fields listed in the tool inputSchema.',
    };
  }
  if (msg.includes('not found in the local orchestrator')) {
    return {
      code: 'NOT_FOUND',
      message: msg,
      hint: 'Task must be filed through QuorixASP orchestrator before proof verification.',
    };
  }
  if (msg.includes('Requested tool not found')) {
    return {
      code: 'TOOL_NOT_FOUND',
      message: msg,
      hint: 'Call GET /api/mcp/tools or tools/list to see available tool names.',
    };
  }
  if (msg.toLowerCase().includes('fetch failed') || msg.toLowerCase().includes('rpc')) {
    return {
      code: 'RPC_UNAVAILABLE',
      message: 'X Layer RPC temporarily unavailable.',
      hint: 'Retry in 30–120 seconds. Cached data may still be served for market scans.',
      retryable: true,
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: msg || 'Unexpected tool execution failure.',
    hint: 'Check broker logs or retry with corrected arguments.',
    retryable: false,
  };
}