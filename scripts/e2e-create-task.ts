/**
 * End-to-end createTask: approve USDC → createTask → verify getTaskCount increments.
 * Requires onchainos CLI logged in with USDC balance and AGENT_ID active on AgentRegistry.
 */
import * as dotenv from 'dotenv';
import os from 'os';
import path from 'path';
dotenv.config();

import { XLayerClient } from '../src/escrow/contract';
import { ENV } from '../src/config/env';

async function main() {
  // E2E writes use the default onchainos login session (broker daemon isolates via ONCHAINOS_HOME).
  delete process.env.ONCHAINOS_HOME;
  const client = new XLayerClient();
  const agentId = ENV.AGENT_ID;
  const payment = 50000n; // 0.05 USDC
  const description = `QuorixASP ABI fix E2E test ${new Date().toISOString()}`;

  console.log('=== E2E createTask ===');
  console.log('TaskManager:', ENV.ESCROW_CONTRACT_ADDRESS);
  console.log('USDC token:', ENV.USDC_TOKEN_ADDRESS);
  console.log('Agent ID:', agentId.toString());
  console.log('Payment (USDC 6dp):', payment.toString());

  const countBefore = await client.getTaskCount();
  console.log('getTaskCount() before:', countBefore.toString());

  try {
    const result = await client.createTaskOnChain(agentId, description, payment);
    console.log('approve tx:', result.approveTx || '(skipped/sufficient)');
    console.log('createTask tx:', result.txHash);
  } catch (err: any) {
    console.error('createTask FAILED:', err.message || err);
    process.exit(1);
  }

  // Wait for confirmation
  await new Promise((r) => setTimeout(r, 8000));

  const countAfter = await client.getTaskCount();
  console.log('getTaskCount() after:', countAfter.toString());

  const incremented = countAfter === countBefore + 1n;
  console.log('Count incremented by 1:', incremented ? 'YES' : `NO (${countBefore} → ${countAfter})`);

  if (incremented) {
    const details = await client.getEscrowDetails((countAfter - 1n).toString());
    console.log('New task details:', {
      taskId: details.taskId,
      client: details.client,
      agentId: details.agentId.toString(),
      payment: details.payment.toString(),
      status: details.status,
      description: details.description.slice(0, 80),
    });
  }

  if (!incremented) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});