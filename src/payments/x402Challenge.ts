import { ENV } from '../config/env';

/** X Layer mainnet — CAIP-2 network id for x402 v2 accepts entries. */
export const X_LAYER_CAIP2 = 'eip155:196';

export interface X402ChallengeOptions {
  /** Public base URL of this broker (for resource.url in the challenge). */
  baseUrl: string;
  /** Billable operation id (registry operationId / pay_per_call operation enum). */
  operation: string;
  /** Human-readable price in USDT (e.g. "0.005"). */
  priceUsdt?: string;
  /** Override payee wallet; defaults to ENV.A2MCP_PAY_TO_WALLET. */
  payTo?: string;
}

export interface X402Challenge {
  x402Version: 2;
  paymentRequiredHeader: string;
  body: {
    x402Version: 2;
    error: string;
    resource: {
      url: string;
      description: string;
      mimeType: string;
    };
    accepts: Array<Record<string, unknown>>;
    operation: string;
    hint: string;
    verificationGap: string;
  };
}

function usdtToAtomic(priceUsdt: string): string {
  const trimmed = priceUsdt.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid A2MCP price: ${priceUsdt}`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fracPadded);
  return atomic.toString();
}

function buildAcceptEntry(
  payTo: string,
  amountAtomic: string,
  asset: string,
  symbol: string,
  name: string
): Record<string, unknown> {
  return {
    scheme: 'exact',
    network: X_LAYER_CAIP2,
    asset,
    payTo,
    amount: amountAtomic,
    maxAmountRequired: amountAtomic,
    extra: {
      name,
      version: '2',
      symbol,
      chainId: 196,
    },
    outputSchema: {
      input: {
        type: 'http',
        method: 'POST',
        bodyType: 'json',
        body: {
          tool: { type: 'string', required: true },
          arguments: { type: 'object', required: true },
        },
        headers: {
          'PAYMENT-SIGNATURE': { type: 'string', required: true },
        },
      },
    },
  };
}

/**
 * Build an x402 v2 PAYMENT-REQUIRED challenge for metered `pay_per_call_utility`.
 * Buyers sign via `onchainos payment pay --payload <base64>` and replay with PAYMENT-SIGNATURE.
 */
export function buildPayPerCallChallenge(options: X402ChallengeOptions): X402Challenge {
  const payTo = (options.payTo || ENV.A2MCP_PAY_TO_WALLET || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(payTo)) {
    throw new Error(
      'A2MCP_PAY_TO_WALLET is not configured — set the ASP wallet that receives metered x402 payments.'
    );
  }

  const priceUsdt = options.priceUsdt || ENV.A2MCP_CALL_PRICE_USDT;
  const amountAtomic = usdtToAtomic(priceUsdt);
  const invokeUrl = `${options.baseUrl.replace(/\/$/, '')}/api/mcp/invoke`;
  const operation = options.operation || 'metered_call';

  const accepts = [
    buildAcceptEntry(
      payTo,
      amountAtomic,
      ENV.USDT_TOKEN_ADDRESS,
      'USDT',
      'Tether USD'
    ),
  ];

  if (ENV.USDG_TOKEN_ADDRESS) {
    accepts.push(
      buildAcceptEntry(
        payTo,
        amountAtomic,
        ENV.USDG_TOKEN_ADDRESS,
        'USDG',
        'Global Dollar'
      )
    );
  }

  const payload = {
    x402Version: 2 as const,
    resource: {
      url: invokeUrl,
      description: `QuorixASP metered A2MCP operation: ${operation}`,
      mimeType: 'application/json',
    },
    accepts,
  };

  const paymentRequiredHeader = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

  return {
    x402Version: 2,
    paymentRequiredHeader,
    body: {
      x402Version: 2,
      error: 'Payment required',
      resource: payload.resource,
      accepts,
      operation,
      hint:
        'Sign with onchainos payment pay --payload <PAYMENT-REQUIRED value>, then replay POST /api/mcp/invoke with PAYMENT-SIGNATURE.',
      verificationGap:
        'QuorixASP currently gates on PAYMENT-SIGNATURE presence. Facilitator settlement verification is not yet wired server-side.',
    },
  };
}

export function priceUsdtForOperation(operation: string): string {
  const op = operation.trim().toLowerCase();
  const toolMeta = ENV.A2MCP_OPERATION_PRICES[op];
  return toolMeta || ENV.A2MCP_CALL_PRICE_USDT;
}