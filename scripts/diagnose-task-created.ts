/**
 * One-time diagnostic: has TaskCreated EVER fired on the TaskManager contract?
 * Scans from deployment estimate to latest in chunks (not for regular polling).
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { createPublicClient, parseAbiItem, keccak256, toBytes, formatEther } from 'viem';
import { createXLayerPublicClient, getXLayerRpcUrls } from '../src/blockchain/rpcTransport';
import { ENV } from '../src/config/env';

const CONTRACT = ENV.ESCROW_CONTRACT_ADDRESS as `0x${string}`;
const CHUNK = 99n;

// QuorixASP currently uses (LIKELY WRONG — see AgentsMarketplace TaskManager.sol):
const QUORIX_EVENT =
  'event TaskCreated(bytes32 indexed taskId, address indexed client, address indexed provider, uint256 budget)';

// Official AgentsMarketplace TaskManager.sol (X Layer mainnet 0x599e23...):
const OFFICIAL_EVENT =
  'event TaskCreated(uint256 indexed taskId, address indexed client, uint256 indexed agentId, uint256 payment)';

const EVENT_CANDIDATES = [
  OFFICIAL_EVENT,
  QUORIX_EVENT,
  'event TaskCreated(bytes32 indexed taskId, address indexed client, address indexed provider, uint256 budget, uint256 deadline)',
  'event TaskCreated(bytes32 indexed taskId, address indexed client, address indexed provider, uint256 budgetWei)',
];

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function findFirstLogBlock(
  client: ReturnType<typeof createXLayerPublicClient>,
  event: ReturnType<typeof parseAbiItem>,
  fromBlock: bigint,
  toBlock: bigint
): Promise<{ count: number; first?: { block: bigint; tx: string; args: unknown }; last?: { block: bigint; tx: string } }> {
  let total = 0;
  let first: { block: bigint; tx: string; args: unknown } | undefined;
  let last: { block: bigint; tx: string } | undefined;
  let cursor = fromBlock;

  while (cursor <= toBlock) {
    const end = cursor + CHUNK > toBlock ? toBlock : cursor + CHUNK;
    try {
      const logs = await client.getLogs({
        address: CONTRACT,
        event,
        fromBlock: cursor,
        toBlock: end,
      } as Parameters<typeof client.getLogs>[0]);
      for (const log of logs) {
        total++;
        if (!first) {
          first = { block: log.blockNumber!, tx: log.transactionHash!, args: (log as { args?: unknown }).args };
        }
        last = { block: log.blockNumber!, tx: log.transactionHash! };
      }
    } catch (err: any) {
      console.error(`  chunk ${cursor}-${end} error: ${err.message?.slice(0, 120)}`);
    }
    cursor = end + 1n;
    if (cursor <= toBlock) await sleep(150);
  }
  return { count: total, first, last };
}

async function estimateDeploymentBlock(client: ReturnType<typeof createXLayerPublicClient>): Promise<bigint> {
  // Binary search for first block with contract code (coarse steps then refine)
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
    await sleep(80);
  }
  return firstWithCode;
}

async function main() {
  console.log('=== TaskCreated Diagnostic ===\n');
  console.log('Chain: X Layer mainnet (chainId 196)');
  console.log('RPC endpoints:', getXLayerRpcUrls().join(', '));
  console.log('Contract:', CONTRACT);
  console.log('Configured ESCROW_CONTRACT_ADDRESS:', ENV.ESCROW_CONTRACT_ADDRESS);

  const client = createXLayerPublicClient();
  const chainId = await client.getChainId();
  const latest = await client.getBlockNumber();
  const latestBlock = await client.getBlock({ blockNumber: latest });
  const code = await client.getBytecode({ address: CONTRACT });

  console.log('\n--- Network / contract sanity ---');
  console.log('chainId:', chainId, chainId === 196 ? '(OK: mainnet)' : '(WARN: not 196)');
  console.log('latest block:', latest.toString());
  console.log('latest block time:', new Date(Number(latestBlock.timestamp) * 1000).toISOString());
  console.log('contract has bytecode:', !!(code && code !== '0x'), code ? `(${code.length} hex chars)` : '');

  console.log('\n--- Event topic hashes (for explorer cross-check) ---');
  for (const sig of EVENT_CANDIDATES) {
    const hash = keccak256(toBytes(sig));
    console.log(`  ${hash}  ${sig}`);
  }

  const quorixEvent = parseAbiItem(QUORIX_EVENT);
  const officialEvent = parseAbiItem(OFFICIAL_EVENT);
  const quorixTopic = keccak256(toBytes(QUORIX_EVENT));
  const officialTopic = keccak256(toBytes(OFFICIAL_EVENT));
  console.log('\nQuorixASP topic0 (current):', quorixTopic);
  console.log('Official topic0 (TaskManager.sol):', officialTopic);

  console.log('\n--- Estimating contract deployment block (binary search) ---');
  const deployBlock = await estimateDeploymentBlock(client);
  const deployBlockData = await client.getBlock({ blockNumber: deployBlock });
  console.log('Estimated deployment block:', deployBlock.toString());
  console.log('Deployment approx time:', new Date(Number(deployBlockData.timestamp) * 1000).toISOString());
  const blocksSinceDeploy = latest - deployBlock;
  console.log('Blocks since deployment:', blocksSinceDeploy.toString());

  // On-chain task count via official view function
  const TASK_COUNT_ABI = [
    { name: 'getTaskCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { name: 'getMarketStats', type: 'function', stateMutability: 'view', inputs: [], outputs: [
      { name: 'totalTasks', type: 'uint256' }, { name: 'approvedTasks', type: 'uint256' }, { name: 'volume', type: 'uint256' }
    ]},
  ] as const;
  try {
    const taskCount = await client.readContract({ address: CONTRACT, abi: TASK_COUNT_ABI, functionName: 'getTaskCount' });
    const stats = await client.readContract({ address: CONTRACT, abi: TASK_COUNT_ABI, functionName: 'getMarketStats' });
    console.log('\n--- On-chain getTaskCount() / getMarketStats() ---');
    console.log('getTaskCount():', taskCount.toString());
    console.log('getMarketStats():', { totalTasks: stats[0].toString(), approvedTasks: stats[1].toString(), volume: stats[2].toString() });
  } catch (e: any) {
    console.log('\n--- getTaskCount() failed (contract may use different ABI) ---', e.message?.slice(0, 120));
  }

  console.log('\n--- Full-history scan: OFFICIAL event signature ---');
  console.log(`Scanning blocks ${deployBlock} → ${latest} (${blocksSinceDeploy} blocks)`);
  const t0 = Date.now();
  const fullOfficial = await findFirstLogBlock(client, officialEvent, deployBlock, latest);
  console.log(`Official scan done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('Total TaskCreated logs (official signature):', fullOfficial.count);
  const full = fullOfficial;
  if (full.first) {
    const ageBlocks = latest - full.first.block;
    const firstBlock = await client.getBlock({ blockNumber: full.first.block });
    console.log('First event block:', full.first.block.toString(), new Date(Number(firstBlock.timestamp) * 1000).toISOString());
    console.log('First event tx:', full.first.tx);
    console.log('First event args:', JSON.stringify(full.first.args));
  }
  if (full.last && full.count > 1) {
    const ageBlocks = latest - full.last.block;
    const lastBlock = await client.getBlock({ blockNumber: full.last.block });
    console.log('Most recent event block:', full.last.block.toString(), new Date(Number(lastBlock.timestamp) * 1000).toISOString());
    console.log('Blocks ago:', ageBlocks.toString(), `(~${(Number(ageBlocks) * 2 / 3600).toFixed(1)} hours at 2s/block)`);
    console.log('Most recent tx:', full.last.tx);
  }

  console.log('\n--- Alternate event signatures (same block range) ---');
  for (let i = 1; i < EVENT_CANDIDATES.length; i++) {
    const ev = parseAbiItem(EVENT_CANDIDATES[i]);
    const r = await findFirstLogBlock(client, ev, deployBlock, latest);
    console.log(`  [${r.count}] ${EVENT_CANDIDATES[i]}`);
  }

  console.log('\n--- Full-history scan: QUORIX (wrong?) event signature ---');
  const t1 = Date.now();
  const fullQuorix = await findFirstLogBlock(client, quorixEvent, deployBlock, latest);
  console.log(`Quorix scan done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log('Total TaskCreated logs (Quorix signature):', fullQuorix.count);

  console.log('\n=== Done ===');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});