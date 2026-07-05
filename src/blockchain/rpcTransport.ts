import { createPublicClient, fallback, http, PublicClient } from 'viem';
import { xLayer } from 'viem/chains';
import { ENV } from '../config/env';

const DEFAULT_FALLBACK_RPCS = ['https://xlayerrpc.okx.com'];

export function getXLayerRpcUrls(): string[] {
  const fromEnv = (process.env.X_LAYER_RPC_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  const primary = ENV.X_LAYER_RPC_URL?.trim();
  const urls = [...(primary ? [primary] : []), ...fromEnv, ...DEFAULT_FALLBACK_RPCS];

  return [...new Set(urls)];
}

export function createXLayerPublicClient(): PublicClient {
  const urls = getXLayerRpcUrls();
  const transports = urls.map((url) =>
    http(url, {
      timeout: 20_000,
      retryCount: 2,
      retryDelay: 750,
    })
  );

  return createPublicClient({
    chain: xLayer,
    transport: transports.length === 1 ? transports[0] : fallback(transports, { rank: false }),
  });
}

export function isTransientRpcError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err).toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('http request failed') ||
    msg.includes('rate limit') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('socket') ||
    msg.includes('503') ||
    msg.includes('429')
  );
}

export function shortenRpcError(err: unknown): string {
  const raw = String((err as { message?: string })?.message || err);
  if (raw.includes('fetch failed')) {
    return 'X Layer RPC unreachable (network or rate limit). Will retry with fallback endpoints.';
  }
  if (raw.length > 180) return raw.slice(0, 180) + '…';
  return raw;
}