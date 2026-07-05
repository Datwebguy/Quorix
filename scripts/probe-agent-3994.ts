import { createXLayerPublicClient } from '../src/blockchain/rpcTransport';

const REGISTRY = '0x7337a8963Dc7Cf0644f9423bBE397b3D0f97ACa1' as const;

const registryAbi = [
  {
    name: 'getAgent',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [
      { name: 'owner', type: 'address' },
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'active', type: 'bool' },
    ],
  },
  {
    name: 'getAgentCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

async function main() {
  const c = createXLayerPublicClient();
  const count = await c.readContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: 'getAgentCount',
  });
  console.log('AgentRegistry getAgentCount:', count.toString());

  for (const id of [3994n, 3827n]) {
    try {
      const agent = await c.readContract({
        address: REGISTRY,
        abi: registryAbi,
        functionName: 'getAgent',
        args: [id],
      });
      console.log(`\nAgent #${id}:`, agent);
    } catch (e: any) {
      console.log(`\nAgent #${id} error:`, e.message?.slice(0, 200));
    }
  }
}

main().catch(console.error);