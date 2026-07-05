import { createXLayerPublicClient } from '../src/blockchain/rpcTransport';
import { parseAbiItem } from 'viem';

const addr = '0x599e23D6073426eBe357d03056258eEAa217e01D' as const;
const abi = [
  { name: 'getTaskCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'getMarketStats', type: 'function', stateMutability: 'view', inputs: [], outputs: [
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
  ]},
] as const;

async function main() {
  const c = createXLayerPublicClient();
  const latest = await c.getBlockNumber();
  const tc = await c.readContract({ address: addr, abi, functionName: 'getTaskCount' });
  const stats = await c.readContract({ address: addr, abi, functionName: 'getMarketStats' });
  console.log('latest block:', latest.toString());
  console.log('getTaskCount():', tc.toString());
  console.log('getMarketStats(): totalTasks=%s approved=%s volume=%s', stats[0], stats[1], stats[2]);

  const official = parseAbiItem(
    'event TaskCreated(uint256 indexed taskId, address indexed client, uint256 indexed agentId, uint256 payment)'
  );
  const quorix = parseAbiItem(
    'event TaskCreated(bytes32 indexed taskId, address indexed client, address indexed provider, uint256 budget)'
  );

  // Last 50k blocks in one call (under 100-block RPC limit may fail - try smaller)
  for (const [label, blocks, ev] of [
    ['50k official', 50000n, official],
    ['50k quorix', 50000n, quorix],
  ] as const) {
    try {
      const from = latest > blocks ? latest - blocks : 0n;
      const logs = await c.getLogs({ address: addr, event: ev, fromBlock: from, toBlock: latest });
      console.log(`${label}: ${logs.length} events`);
      if (logs.length) {
        const last = logs[logs.length - 1];
        const blk = await c.getBlock({ blockNumber: last.blockNumber! });
        console.log(`  most recent: block ${last.blockNumber} at ${new Date(Number(blk.timestamp) * 1000).toISOString()}`);
        console.log(`  args:`, (last as { args?: unknown }).args);
      }
    } catch (e: any) {
      console.log(`${label}: RPC error (range too wide?) ${e.message?.slice(0, 100)}`);
    }
  }
}

main().catch(console.error);