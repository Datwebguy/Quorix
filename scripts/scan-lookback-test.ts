/**
 * One-off: compare TaskCreated event counts at different lookback windows.
 * Usage: npx ts-node scripts/scan-lookback-test.ts [blocks]
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { SemanticMatcher } from '../src/discovery/matching';
import { ReferenceOnChainMarketplaceScanner } from '../src/discovery/marketplaceReference';
import { createXLayerPublicClient } from '../src/blockchain/rpcTransport';

async function scanAtLookback(blocks: number): Promise<number> {
  process.env.MARKETPLACE_LOOKBACK_BLOCKS = String(blocks);
  const matcher = new SemanticMatcher();
  const scanner = new ReferenceOnChainMarketplaceScanner(matcher);
  const client = createXLayerPublicClient();
  const tasks = await scanner.scanReferenceTasks(client, 100, 0);
  return tasks.length;
}

async function main() {
  const windows = process.argv.slice(2).map(Number).filter((n) => n > 0);
  const toTest = windows.length ? windows : [400, 1800, 7200];

  console.log('REFERENCE TaskCreated scan on hackathon TaskManager (minScore=0)\n');
  for (const blocks of toTest) {
    const start = Date.now();
    try {
      const count = await scanAtLookback(blocks);
      const sec = ((Date.now() - start) / 1000).toFixed(1);
      const estMin = (blocks * 2 / 60).toFixed(1);
      console.log(`  lookback=${blocks} blocks (~${estMin} min at 2s/block): ${count} tasks (${sec}s)`);
    } catch (err: any) {
      console.log(`  lookback=${blocks} blocks: ERROR ${err.message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});