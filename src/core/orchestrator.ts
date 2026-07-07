import { Task, SLAProposal, CounterProposal } from '../negotiation/schemas';
import { NegotiationEngine } from '../negotiation/engine';
import { SemanticMatcher } from '../discovery/matching';
import { ReputationScorer } from '../reputation/scorer';
import { XLayerClient } from '../escrow/contract';
import { ENV } from '../config/env';
import { requiresLiveOkxSettlementPath } from '../onchainos/settlement';
import { runReferenceTaskManagerEscrowPath } from '../reference/taskManagerEscrowPath';

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

    if (!ENV.REFERENCE_DEMO_ENABLED) {
      console.log(
        `[Orchestrator] Reference TaskManager demo disabled (REFERENCE_DEMO_ENABLED=false). Task ${taskId} stays at WAITING_ESCROW — use OKX.AI APIs.`
      );
      this.updateJobStatus(taskId, 'WAITING_ESCROW');
      return true;
    }

    return runReferenceTaskManagerEscrowPath(task, finalProposal, this.blockchainClient, {
      updateJobStatus: (id, status) => this.updateJobStatus(id, status),
      setOnChainTaskId: (id, onChainTaskId) => {
        const job = this.activeJobs.get(id);
        if (job) job.onChainTaskId = onChainTaskId;
      },
      setPoW: (id, pow) => {
        const job = this.activeJobs.get(id);
        if (job) job.poW = pow;
      },
      getOnChainTaskId: (id) => this.activeJobs.get(id)?.onChainTaskId,
    });
  }

  public getJobState(taskId: string) {
    return this.activeJobs.get(taskId);
  }
}
