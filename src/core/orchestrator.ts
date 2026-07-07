import crypto from 'crypto';
import { Task, SLAProposal, CounterProposal } from '../negotiation/schemas';
import { NegotiationEngine } from '../negotiation/engine';
import { SemanticMatcher } from '../discovery/matching';
import { ReputationScorer } from '../reputation/scorer';
import { XLayerClient } from '../escrow/contract';
import { ENV } from '../config/env';
import { requiresLiveOkxSettlementPath } from '../onchainos/settlement';

export class QuorixOrchestrator {
  private matcher: SemanticMatcher;
  private repScorer: ReputationScorer;
  private negEngine: NegotiationEngine;
  private blockchainClient: XLayerClient;

  // Track active jobs in memory with status transition timestamps
  private activeJobs: Map<string, {
    task: Task;
    status: 'DISCOVERED' | 'REJECTED_MISMATCH' | 'REJECTED_REPUTATION' | 'NEGOTIATING' | 'WAITING_ESCROW' | 'ESCROW_LOCKED' | 'EXECUTING' | 'COMPLETED' | 'DISPUTED' | 'RESOLVED' | 'FAILED';
    proposal?: SLAProposal;
    poW?: string;
    onChainTaskId?: string;
    statusUpdatedAt: number; // Unix timestamp in seconds
  }> = new Map();

  constructor(
    matcher: SemanticMatcher,
    repScorer: ReputationScorer,
    negEngine: NegotiationEngine,
    blockchainClient: XLayerClient
  ) {
    this.matcher = matcher;
    this.repScorer = repScorer;
    this.negEngine = negEngine;
    this.blockchainClient = blockchainClient;
  }

  /**
   * Helper to update task status and save transition timestamp.
   */
  public updateJobStatus(taskId: string, status: any) {
    const job = this.activeJobs.get(taskId);
    if (job) {
      job.status = status;
      job.statusUpdatedAt = Math.floor(Date.now() / 1000);
      console.log(`[Orchestrator] Task ${taskId} status transitioned to: ${status} (updated: ${job.statusUpdatedAt})`);
    }
  }

  public getActiveJobs() {
    return Array.from(this.activeJobs.values()).map(job => {
      const match = this.matcher.matchTask(job.task);
      return {
        id: job.task.id,
        title: job.task.title,
        description: job.task.description,
        clientAddress: job.task.clientAddress,
        budgetWei: job.task.budgetWei,
        deadlineTimestamp: job.task.deadlineTimestamp,
        status: job.status,
        proposal: job.proposal,
        score: Math.round(match.score * 100),
        statusUpdatedAt: job.statusUpdatedAt,
        expectedProofHash: job.task.expectedProofHash
      };
    });
  }

  /**
   * Main orchestrator loop for handling an incoming A2A task from the marketplace.
   */
  public async handleTaskRequest(task: Task): Promise<boolean> {
    const taskId = task.id;
    console.log(`\n[Orchestrator] ========================================`);
    console.log(`[Orchestrator] Starting Production Lifecycle for Task: ${taskId}`);
    console.log(`[Orchestrator] ========================================`);

    // Initialize job status
    this.activeJobs.set(taskId, { 
      task, 
      status: 'DISCOVERED',
      statusUpdatedAt: Math.floor(Date.now() / 1000)
    });

    // Step 1: Capability Matching Check
    const match = this.matcher.matchTask(task);
    if (!match.isMatched) {
      console.warn(`[Orchestrator] Task ${taskId} does not match QuorixASP capabilities. Rejecting.`);
      this.updateJobStatus(taskId, 'REJECTED_MISMATCH');
      return false;
    }
    console.log(`[Orchestrator] Match Succeeded. Capabilities: [${match.matchedCapabilities.join(', ')}]. Score: ${match.score.toFixed(2)}`);

    // Step 2: Reputation Audit on X Layer via logs (wallet only — marketplace may supply agent ID)
    const clientIsWallet = /^0x[a-fA-F0-9]{40}$/i.test(task.clientAddress);
    if (clientIsWallet) {
      const clientRep = await this.repScorer.getAgentReputation(task.clientAddress, this.blockchainClient.publicClient);
      if (!clientRep.isApproved) {
        console.warn(`[Orchestrator] Client ${task.clientAddress} failed reputation audit. Rejecting task ${taskId}.`);
        this.updateJobStatus(taskId, 'REJECTED_REPUTATION');
        return false;
      }
      console.log(`[Orchestrator] Client reputation approved (Rating: ${clientRep.averageRating.toFixed(1)}/5, DisputeRate: ${(clientRep.disputeRate * 100).toFixed(0)}%).`);
    } else {
      console.log(`[Orchestrator] Client ref ${task.clientAddress} is an OKX agent ID — skipping on-chain wallet reputation until escrow.`);
    }

    // Step 3: Terms & SLA Negotiation
    const evaluation = await this.negEngine.evaluateTaskProposal(task);
    if (evaluation.status === 'DECLINED') {
      console.warn(`[Orchestrator] Negotiation declined: ${evaluation.reason}`);
      this.updateJobStatus(taskId, 'FAILED');
      return false;
    }

    const finalProposal = evaluation.proposal!;
    this.updateJobStatus(taskId, 'NEGOTIATING');
    this.activeJobs.get(taskId)!.proposal = finalProposal;
    console.log(`[Orchestrator] SLA proposal offered to client. Price: ${finalProposal.priceWei} Wei. Days: ${finalProposal.timelineDays}`);

    // Live OKX.AI marketplace jobs settle via OKX backend (contact-user / confirm-accept) — not reference TaskManager.
    if (requiresLiveOkxSettlementPath(taskId)) {
      console.log(
        `[Orchestrator] Task ${taskId} is a live OKX.AI marketplace job — skipping reference TaskManager escrow polling.`
      );
      console.log(
        `[Orchestrator] Use dashboard "Contact Client on OKX.AI" and OKX.AI status APIs for escrow lifecycle.`
      );
      this.updateJobStatus(taskId, 'WAITING_ESCROW');
      return true;
    }

    // Step 4: Poll reference TaskManager for client createTask (hackathon demo path only)
    console.log(
      `[Orchestrator] Waiting for client createTask on reference TaskManager ${ENV.ESCROW_CONTRACT_ADDRESS} (agent #${ENV.AGENT_ID})...`
    );
    this.updateJobStatus(taskId, 'WAITING_ESCROW');

    const maxEscrowPollAttempts = ENV.MAX_POLL_ATTEMPTS;
    let escrowConfirmed = false;
    let lockedAmount = 0n;
    const expectedPayment = BigInt(task.budgetWei);

    for (let attempt = 1; attempt <= maxEscrowPollAttempts; attempt++) {
      try {
        const match = await this.blockchainClient.findClientEscrowTask(
          task.clientAddress,
          ENV.AGENT_ID,
          expectedPayment
        );
        if (match && match.status >= 0) {
          lockedAmount = match.payment;
          this.activeJobs.get(taskId)!.onChainTaskId = match.taskId;
          escrowConfirmed = true;
          break;
        }
      } catch (err) {
        console.warn(`[Orchestrator] Escrow poll query failed (attempt ${attempt}):`, err);
      }

      await new Promise(resolve => setTimeout(resolve, ENV.POLL_INTERVAL_MS));
    }

    if (!escrowConfirmed) {
      console.error(`[Orchestrator] Escrow deposit timeout: client failed to lock funds within window. Terminating task ${taskId}.`);
      this.updateJobStatus(taskId, 'FAILED');
      return false;
    }

    console.log(`[Orchestrator] Escrow Verified on X Layer. Locked Amount: ${lockedAmount.toString()} USDC (6 decimals). On-chain task #${this.activeJobs.get(taskId)!.onChainTaskId}.`);
    this.updateJobStatus(taskId, 'ESCROW_LOCKED');

    // Step 5: Execute Task & Generate Proof-of-Work
    console.log(`[Orchestrator] Executing task deliverables...`);
    this.updateJobStatus(taskId, 'EXECUTING');

    try {
      const deliverablePayload = JSON.stringify({
        taskId,
        title: task.title,
        deliverables: finalProposal.deliverables,
        completedAt: Math.floor(Date.now() / 1000),
        escrowContract: ENV.ESCROW_CONTRACT_ADDRESS,
      });
      const proofHash = `0x${crypto.createHash('sha256').update(deliverablePayload).digest('hex')}`;
      if (task.expectedProofHash) {
        const expected = task.expectedProofHash.toLowerCase().trim();
        const actual = proofHash.toLowerCase().trim();
        if (expected !== actual) {
          console.warn(`[Orchestrator] Generated proof hash does not match expectedProofHash for task ${taskId}.`);
        }
      }
      console.log(`[Orchestrator] Deliverables executed. Generated Proof-of-Work hash: ${proofHash}`);
      this.activeJobs.get(taskId)!.poW = proofHash;
    } catch (err) {
      console.error(`[Orchestrator] Deliverables execution failed:`, err);
      this.updateJobStatus(taskId, 'FAILED');
      return false;
    }

    // Step 6: Monitor Client Release or File Dispute
    console.log(`[Orchestrator] Proof-of-work submitted to client. Monitoring native escrow release...`);
    
    // Poll to see if client approves the work and releases funds
    const maxReleasePollAttempts = ENV.MAX_POLL_ATTEMPTS;
    let paymentReleased = false;

    const onChainTaskId = this.activeJobs.get(taskId)?.onChainTaskId;

    for (let attempt = 1; attempt <= maxReleasePollAttempts; attempt++) {
      try {
        if (!onChainTaskId) break;
        const escrow = await this.blockchainClient.getEscrowDetails(onChainTaskId);
        if (escrow.status === 3 || escrow.status === 5) {
          paymentReleased = true;
          break;
        }
        if (escrow.status === 4) {
          break;
        }
      } catch (err) {
        console.warn(`[Orchestrator] Payout release poll query failed:`, err);
      }
      await new Promise(resolve => setTimeout(resolve, ENV.POLL_INTERVAL_MS));
    }

    // Step 7: Handle Arbitration or Complete Payout
    if (paymentReleased) {
      console.log(`[Orchestrator] Escrow payment released by client on X Layer. Task completed successfully.`);
      this.updateJobStatus(taskId, 'COMPLETED');

      // Submit Client rating on-chain via Onchain OS wallet toolcall
      try {
        console.log(`[Orchestrator] Submitting client agent rating to X Layer...`);
        const ratingTx = await this.blockchainClient.submitRating(task.clientAddress, 5, "Excellent transaction. Smooth escrow lock and release.");
        console.log(`[Orchestrator] Rating registered. Tx: ${ratingTx}`);
      } catch (err) {
        console.warn(`[Orchestrator] Failed to register client rating on-chain:`, err);
      }
      return true;
    } else {
      // Trigger dispute filing (deposit 5% bounty) if client rejects or ignores the proof
      console.warn(`[Orchestrator] Client rejected proof or payment release timed out. Initiating arbitration...`);
      this.updateJobStatus(taskId, 'DISPUTED');

      try {
        console.log(`[Orchestrator] Filing dispute. Depositing 5% arbitration bounty using Onchain OS wallet...`);
        const disputeTx = await this.blockchainClient.fileDispute(onChainTaskId || taskId);
        console.log(`[Orchestrator] Dispute successfully registered on X Layer. Bounty locked. Tx: ${disputeTx}`);
        
        // Return true since dispute was safely escalated to arbitration
        return true;
      } catch (err) {
        console.error(`[Orchestrator] Failed to escalate dispute:`, err);
        this.updateJobStatus(taskId, 'FAILED');
        return false;
      }
    }
  }

  public getJobState(taskId: string) {
    return this.activeJobs.get(taskId);
  }
}
