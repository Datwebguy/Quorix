/**
 * REFERENCE / HACKATHON CONTRACT SCANNER — NOT THE LIVE OKX.AI MARKETPLACE PATH
 *
 * Demonstrates on-chain escrow discovery by scanning TaskCreated logs on
 * TaskManager 0x599e23D6073426eBe357d03056258eEAa217e01D (X Layer).
 *
 * Production okx.ai/tasks listings are served by OKX's aieco backend via
 * `onchainos agent task-search` / `recommend-task` — see marketplace.ts.
 *
 * This contract has getTaskCount()=0 in production; kept for hackathon competency demo.
 */
import { PublicClient, parseAbiItem } from 'viem';
import { fetchLogsChunked } from '../blockchain/logScan';
import { isTransientRpcError, shortenRpcError } from '../blockchain/rpcTransport';
import { ENV } from '../config/env';
import { logErrorOnce } from '../utils/logDedupe';
import { SemanticMatcher } from './matching';
import type { DiscoveredMarketTask } from './marketplace';

const TASK_CREATED_EVENT = parseAbiItem(
  'event TaskCreated(uint256 indexed taskId, address indexed client, uint256 indexed agentId, uint256 payment)'
);

export class ReferenceOnChainMarketplaceScanner {
  constructor(private matcher: SemanticMatcher) {}

  async scanReferenceTasks(
    publicClient: PublicClient,
    limit = 30,
    minScore = 0
  ): Promise<DiscoveredMarketTask[]> {
    try {
      const latestBlock = await publicClient.getBlockNumber();
      const lookbackBlocks = BigInt(process.env.MARKETPLACE_LOOKBACK_BLOCKS || '1800');
      const fromBlock = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;

      const logs = await fetchLogsChunked(
        publicClient,
        {
          address: ENV.ESCROW_CONTRACT_ADDRESS as `0x${string}`,
          event: TASK_CREATED_EVENT,
        },
        fromBlock,
        latestBlock,
        200
      );

      const discovered: DiscoveredMarketTask[] = [];

      for (const log of logs) {
        const args = (log as { args?: Record<string, unknown> }).args || {};
        const taskId = String(args.taskId ?? '');
        const client = String(args.client || '').toLowerCase();
        const agentId = String(args.agentId ?? '');
        const payment = BigInt((args.payment as bigint | number | string | undefined) || 0n);
        if (!taskId || !client) continue;

        const description =
          `[Reference/hackathon] On-chain TaskCreated on X Layer TaskManager. ` +
          `Client ${client}, agent #${agentId}, payment ${payment.toString()} USDC (6 decimals).`;

        const match = this.matcher.matchTask({
          id: taskId,
          title: `Escrow Task #${taskId}`,
          description,
          clientAddress: client,
          budgetWei: payment.toString(),
          deadlineTimestamp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        });

        const paymentUsdc = payment.toString();
        discovered.push({
          id: taskId,
          title: `Escrow Task #${taskId}`,
          description,
          clientAddress: client,
          agentId,
          tokenAmount: (Number(payment) / 1e6).toFixed(2),
          tokenSymbol: 'USDC',
          paymentUsdc,
          budgetWei: paymentUsdc,
          providerAddress: agentId,
          deadlineTimestamp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
          marketplaceStatusLabel: 'CREATED',
          status: 'DISCOVERED',
          score: match.score,
          matchedCapabilities: match.matchedCapabilities,
          source: 'reference-on-chain',
          blockNumber: log.blockNumber?.toString() || '0',
          txHash: log.transactionHash || '',
          portalUrl: undefined,
        });
      }

      discovered.sort((a, b) => Number(BigInt(b.blockNumber || '0') - BigInt(a.blockNumber || '0')));
      return discovered.filter((t) => t.score >= minScore).slice(0, limit);
    } catch (err: unknown) {
      logErrorOnce(
        'reference-marketplace-scan',
        `[ReferenceMarketplace] Scan failed: ${shortenRpcError(err)}`
      );
      if (isTransientRpcError(err)) return [];
      throw err;
    }
  }
}