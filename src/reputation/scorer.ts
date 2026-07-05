import { PublicClient, parseAbiItem } from 'viem';
import { fetchLogsChunked } from '../blockchain/logScan';
import { ENV } from '../config/env';

export interface ReputationProfile {
  agentAddress: string;
  averageRating: number;
  totalRatingsCount: number;
  totalEscrowsCount: number;
  disputedEscrowsCount: number;
  disputeRate: number;
  isApproved: boolean;
  scanFailed?: boolean;
  error?: string;
  noHistory?: boolean;
}

const AGENT_RATED_EVENT = parseAbiItem(
  'event AgentRated(address indexed rater, address indexed ratee, uint8 rating, string comment)'
);
const RATING_SUBMITTED_EVENT = parseAbiItem(
  'event RatingSubmitted(address indexed rater, address indexed ratee, uint8 rating, string comment)'
);
const TASK_CREATED_EVENT = parseAbiItem(
  'event TaskCreated(uint256 indexed taskId, address indexed client, uint256 indexed agentId, uint256 payment)'
);
const TASK_DISPUTED_EVENT = parseAbiItem(
  'event TaskDisputed(uint256 indexed taskId, address indexed client)'
);

export class ReputationScorer {
  private maxRetries = 3;
  private retryDelayMs = 2000;
  private cache = new Map<string, { profile: ReputationProfile; fetchedAt: number }>();
  private cacheTtlMs = 60_000;

  constructor() {
    console.log(
      `[ReputationScorer] Monitoring: TaskManager=${ENV.ESCROW_CONTRACT_ADDRESS}, X402Rating=${ENV.RATING_CONTRACT_ADDRESS}`
    );
  }

  private async queryLogsWithRetry(
    publicClient: PublicClient,
    params: { address: `0x${string}`; event: unknown; args?: Record<string, unknown> },
    fromBlock: bigint,
    toBlock: bigint,
    attempt = 1
  ): Promise<Awaited<ReturnType<PublicClient['getLogs']>>> {
    try {
      return await fetchLogsChunked(publicClient, params, fromBlock, toBlock);
    } catch (err: any) {
      if (attempt < this.maxRetries) {
        const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
        console.warn(
          `[ReputationScorer] Log query failed (Attempt ${attempt}/${this.maxRetries}). Retrying in ${delay}ms... Error: ${err.message || err}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.queryLogsWithRetry(publicClient, params, fromBlock, toBlock, attempt + 1);
      }
      throw err;
    }
  }

  public async getAgentReputation(agentAddress: string, publicClient: PublicClient): Promise<ReputationProfile> {
    const formattedAddress = agentAddress.toLowerCase();
    const cached = this.cache.get(formattedAddress);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.profile;
    }

    console.log(`[ReputationScorer] Auditing reputation logs for ${formattedAddress} on X Layer...`);

    try {
      const latestBlock = await publicClient.getBlockNumber();
      const lookback = BigInt(process.env.REPUTATION_LOOKBACK_BLOCKS || '400');
      const fromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;
      const toBlock = latestBlock;

      const ratingLogs1 = await this.queryLogsWithRetry(
        publicClient,
        {
          address: ENV.RATING_CONTRACT_ADDRESS as `0x${string}`,
          event: AGENT_RATED_EVENT,
          args: { ratee: formattedAddress },
        },
        fromBlock,
        toBlock
      );

      const ratingLogs2 = await this.queryLogsWithRetry(
        publicClient,
        {
          address: ENV.RATING_CONTRACT_ADDRESS as `0x${string}`,
          event: RATING_SUBMITTED_EVENT,
          args: { ratee: formattedAddress },
        },
        fromBlock,
        toBlock
      );

      const lockLogs = await this.queryLogsWithRetry(
        publicClient,
        {
          address: ENV.ESCROW_CONTRACT_ADDRESS as `0x${string}`,
          event: TASK_CREATED_EVENT,
          args: { client: formattedAddress },
        },
        fromBlock,
        toBlock
      );

      const disputeLogs = await this.queryLogsWithRetry(
        publicClient,
        {
          address: ENV.ESCROW_CONTRACT_ADDRESS as `0x${string}`,
          event: TASK_DISPUTED_EVENT,
        },
        fromBlock,
        toBlock
      );

      let totalRatingsCount = 0;
      let ratingSum = 0;

      const processRatings = (logs: Awaited<ReturnType<PublicClient['getLogs']>>) => {
        for (const log of logs) {
          const rating = (log as { args?: { rating?: number } }).args?.rating;
          if (rating !== undefined) {
            ratingSum += Number(rating);
            totalRatingsCount++;
          }
        }
      };

      processRatings(ratingLogs1);
      processRatings(ratingLogs2);

      const clientTaskIds = new Set<string>();
      for (const log of lockLogs) {
        const taskId = (log as { args?: { taskId?: bigint | number | string } }).args?.taskId;
        if (taskId !== undefined) clientTaskIds.add(String(taskId));
      }

      let disputedCount = 0;
      for (const log of disputeLogs) {
        const taskId = (log as { args?: { taskId?: bigint | number | string } }).args?.taskId;
        if (taskId !== undefined && clientTaskIds.has(String(taskId))) disputedCount++;
      }

      const totalEscrows = clientTaskIds.size;
      const disputeRate = totalEscrows > 0 ? disputedCount / totalEscrows : 0.0;
      const noHistory = totalRatingsCount === 0 && totalEscrows === 0;
      const averageRating = totalRatingsCount > 0 ? ratingSum / totalRatingsCount : 0;
      const isApproved =
        !noHistory && averageRating >= ENV.MIN_REPUTATION_SCORE && disputeRate <= ENV.MAX_DISPUTE_RATE;

      const profile: ReputationProfile = {
        agentAddress,
        averageRating,
        totalRatingsCount,
        totalEscrowsCount: totalEscrows,
        disputedEscrowsCount: disputedCount,
        disputeRate,
        isApproved: noHistory ? true : isApproved,
        noHistory,
      };

      console.log(
        `[ReputationScorer] Audit Completed: Rating=${averageRating.toFixed(1)}/5, Escrows=${totalEscrows}, Disputes=${disputedCount}, Approved=${profile.isApproved}`
      );
      this.cache.set(formattedAddress, { profile, fetchedAt: Date.now() });
      return profile;
    } catch (err: any) {
      console.error(`[ReputationScorer] Scan failed on X Layer:`, err.message || err);
      return {
        agentAddress,
        averageRating: 0,
        totalRatingsCount: 0,
        totalEscrowsCount: 0,
        disputedEscrowsCount: 0,
        disputeRate: 0,
        isApproved: false,
        scanFailed: true,
        error: err.message || String(err),
      };
    }
  }
}