/**
 * Cross-check getTaskCount() against full-history TaskCreated log scan (official signature).
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { parseAbiItem } from 'viem';
import { createXLayerPublicClient } from '../src/blockchain/rpcTransport';
import { fetchLogsChunked } from '../src/blockchain/logScan';
import { ENV } from '../src/config/env';
import { TASK_MANAGER_ABI } from '../src/escrow/contract';

const CONTRACT = ENV.ESCROW_CONTRACT_ADDRESS as `0x${string}`;
const OFFICIAL_EVENT = parseAbiItem(
  'event TaskCreated(uint256 indexed taskId, address indexed client, uint256 indexed agentId, uint256 payment)'
);

async function estimateDeploymentBlock(client: ReturnType<typeof createXLayerPublicClient>): Promise<bigint> {
  const latest = await client.getBlockNumber();
  let low = 0n;
  let high = latest;
  let firstWithCode = latest;

  while (low <= high) {
    const mid = (low + high) / 2n;
    const code = await client.getBytecode({ address: CONTRACT, blockNumber: mid });
    if (code && code !== '0x') {
      firstWithCode = mid;
      if (mid === 0n) break;
      high = mid - 1n;
    } else {
      low = mid + 1n;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return firstWithCode;
}

async function main() {
  const client = createXLayerPublicClient();
  const latest = await client.getBlockNumber();
  const deployBlock = await estimateDeploymentBlock(client);

  const taskCount = await client.readContract({
    address: CONTRACT,
    abi: TASK_MANAGER_ABI,
    functionName: 'getTaskCount',
  });

  console.log('=== Task Count Verification ===');
  console.log('Contract:', CONTRACT);
  console.log('Latest block:', latest.toString());
  console.log('Deployment block:', deployBlock.toString());
  console.log('getTaskCount():', taskCount.toString());

  const t0 = Date.now();
  const logs = await fetchLogsChunked(
    client,
    { address: CONTRACT, event: OFFICIAL_EVENT },
    deployBlock,
    latest,
    150
  );
  console.log(`Full-history TaskCreated scan: ${logs.length} events (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const match = logs.length === Number(taskCount);
  console.log('Counts match:', match ? 'YES' : `NO (getTaskCount=${taskCount}, logs=${logs.length})`);

  if (logs.length > 0) {
    const last = logs[logs.length - 1];
    console.log('Most recent event args:', (last as { args?: unknown }).args);
  }

  if (!match) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});