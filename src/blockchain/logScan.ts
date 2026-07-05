import { PublicClient } from 'viem';

export const LOG_CHUNK_BLOCKS = 99n;

export async function fetchLogsChunked(
  publicClient: PublicClient,
  params: {
    address: `0x${string}`;
    event: unknown;
    args?: Record<string, unknown>;
  },
  fromBlock: bigint,
  toBlock: bigint,
  delayMs = 150
): Promise<Awaited<ReturnType<PublicClient['getLogs']>>> {
  if (fromBlock > toBlock) return [];

  const results: Awaited<ReturnType<PublicClient['getLogs']>> = [];
  let cursor = fromBlock;

  while (cursor <= toBlock) {
    const chunkEnd = cursor + LOG_CHUNK_BLOCKS > toBlock ? toBlock : cursor + LOG_CHUNK_BLOCKS;
    const chunk = await publicClient.getLogs({
      address: params.address,
      event: params.event,
      ...(params.args ? { args: params.args } : {}),
      fromBlock: cursor,
      toBlock: chunkEnd,
    } as Parameters<PublicClient['getLogs']>[0]);
    results.push(...chunk);
    cursor = chunkEnd + 1n;
    if (cursor <= toBlock) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}