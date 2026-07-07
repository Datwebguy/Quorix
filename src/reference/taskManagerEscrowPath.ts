/**
 * REFERENCE / HACKATHON ONLY — TaskManager escrow poll + PoW demo path.
 *
 * Live OKX.AI marketplace jobs use contact-user / confirm-accept via OKX backend.
 * This module is NOT invoked for hex or portal-scale numeric job IDs.
 *
 * Enable with REFERENCE_DEMO_ENABLED=true (default false in production).
 */
import crypto from 'crypto';
import { XLayerClient } from '../escrow/contract';
import { ENV } from '../config/env';
import type { SLAProposal, Task } from '../negotiation/schemas';

export interface ReferenceEscrowHandlers {
  updateJobStatus: (taskId: string, status: string) => void;
  setOnChainTaskId: (taskId: string, onChainTaskId: string) => void;
  setPoW: (taskId: string, pow: string) => void;
  getOnChainTaskId: (taskId: string) => string | undefined;
}

/**
 * Poll reference TaskManager for createTask → execute → release/dispute (hackathon demo).
 * Returns true when the reference lifecycle completes or dispute is filed.
 */
export async function runReferenceTaskManagerEscrowPath(
  task: Task,
  finalProposal: SLAProposal,
  blockchainClient: XLayerClient,
  handlers: ReferenceEscrowHandlers
): Promise<boolean> {
  const taskId = task.id;

  console.log(
    `[Reference] Waiting for client createTask on TaskManager ${ENV.ESCROW_CONTRACT_ADDRESS} (agent #${ENV.AGENT_ID})...`
  );
  handlers.updateJobStatus(taskId, 'WAITING_ESCROW');

  const expectedPayment = BigInt(task.budgetWei);
  let escrowConfirmed = false;
  let lockedAmount = 0n;

  for (let attempt = 1; attempt <= ENV.MAX_POLL_ATTEMPTS; attempt++) {
    try {
      const match = await blockchainClient.findClientEscrowTask(
        task.clientAddress,
        ENV.AGENT_ID,
        expectedPayment
      );
      if (match && match.status >= 0) {
        lockedAmount = match.payment;
        handlers.setOnChainTaskId(taskId, match.taskId);
        escrowConfirmed = true;
        break;
      }
    } catch (err) {
      console.warn(`[Reference] Escrow poll failed (attempt ${attempt}):`, err);
    }
    await new Promise((resolve) => setTimeout(resolve, ENV.POLL_INTERVAL_MS));
  }

  if (!escrowConfirmed) {
    console.error(`[Reference] Escrow deposit timeout for task ${taskId}.`);
    handlers.updateJobStatus(taskId, 'FAILED');
    return false;
  }

  console.log(
    `[Reference] Escrow verified. Locked ${lockedAmount.toString()} USDC. On-chain task #${handlers.getOnChainTaskId(taskId)}.`
  );
  handlers.updateJobStatus(taskId, 'ESCROW_LOCKED');

  handlers.updateJobStatus(taskId, 'EXECUTING');
  try {
    const deliverablePayload = JSON.stringify({
      taskId,
      title: task.title,
      deliverables: finalProposal.deliverables,
      completedAt: Math.floor(Date.now() / 1000),
      escrowContract: ENV.ESCROW_CONTRACT_ADDRESS,
    });
    const proofHash = `0x${crypto.createHash('sha256').update(deliverablePayload).digest('hex')}`;
    handlers.setPoW(taskId, proofHash);
    console.log(`[Reference] Generated PoW hash: ${proofHash}`);
  } catch (err) {
    console.error(`[Reference] Deliverables execution failed:`, err);
    handlers.updateJobStatus(taskId, 'FAILED');
    return false;
  }

  const onChainTaskId = handlers.getOnChainTaskId(taskId);
  let paymentReleased = false;

  for (let attempt = 1; attempt <= ENV.MAX_POLL_ATTEMPTS; attempt++) {
    try {
      if (!onChainTaskId) break;
      const escrow = await blockchainClient.getEscrowDetails(onChainTaskId);
      if (escrow.status === 3 || escrow.status === 5) {
        paymentReleased = true;
        break;
      }
      if (escrow.status === 4) break;
    } catch (err) {
      console.warn(`[Reference] Release poll failed:`, err);
    }
    await new Promise((resolve) => setTimeout(resolve, ENV.POLL_INTERVAL_MS));
  }

  if (paymentReleased) {
    handlers.updateJobStatus(taskId, 'COMPLETED');
    try {
      await blockchainClient.submitRating(
        task.clientAddress,
        5,
        'Excellent transaction. Smooth escrow lock and release.'
      );
    } catch (err) {
      console.warn(`[Reference] Rating submission failed:`, err);
    }
    return true;
  }

  handlers.updateJobStatus(taskId, 'DISPUTED');
  try {
    await blockchainClient.fileDispute(onChainTaskId || taskId);
    return true;
  } catch (err) {
    console.error(`[Reference] Dispute filing failed:`, err);
    handlers.updateJobStatus(taskId, 'FAILED');
    return false;
  }
}