import { Task, SLAProposal, CounterProposal } from './schemas';
import { ENV } from '../config/env';

export class NegotiationEngine {
  // Operational minimum metrics
  private minBasePriceWei: bigint = 50000n; // 0.05 USDC (6 decimals)
  private minDaysRequired: number = 3;

  constructor() {
    console.log(`[NegotiationEngine] Initialized: Min Price=${this.minBasePriceWei.toString()} USDC (6 decimals), Min Days=${this.minDaysRequired}`);
  }

  /**
   * Evaluates an incoming task or proposal and generates a response.
   */
  public async evaluateTaskProposal(task: Task): Promise<CounterProposal> {
    const taskBudget = BigInt(task.budgetWei);
    const now = Math.floor(Date.now() / 1000);
    const durationSec = task.deadlineTimestamp - now;
    const durationDays = durationSec / (24 * 3600);

    console.log(`[NegotiationEngine] Evaluating: Task=${task.id}, Budget=${taskBudget.toString()} Wei, Timeline=${durationDays.toFixed(1)} Days`);

    // Guard 1: Sanity validation for inputs
    if (task.id.trim() === '' || task.clientAddress.trim() === '') {
      return {
        status: 'DECLINED',
        reason: 'SLA Negotiation rejected: Invalid/empty task details.'
      };
    }

    // Guard 2: Price Validation
    if (taskBudget < this.minBasePriceWei) {
      console.log(`[NegotiationEngine] Budget is below minimum operational cost. Counter-offering minimum pricing.`);
      return {
        status: 'COUNTERED',
        proposal: {
          taskId: task.id,
          priceWei: this.minBasePriceWei.toString(),
          deliverables: [
            'Deploy standard AI agent micro-services and capabilities integration',
            'Full unit and compliance test report logs',
            'SLA integration support (Uptime 99.5%)'
          ],
          timelineDays: Math.max(this.minDaysRequired, Math.ceil(durationDays)),
          escrowReleaseConditions: 'Completed proof-of-work hash submitted and verified on-chain',
          arbitrationTerms: 'Disputes resolved via OKX.AI designated third-party evaluators'
        },
        reason: `Offered budget (${taskBudget.toString()} Wei) is below our minimum operating threshold of ${this.minBasePriceWei.toString()} Wei.`
      };
    }

    // Guard 3: Timeline Check
    if (durationDays < this.minDaysRequired) {
      console.log(`[NegotiationEngine] Timeline too short. Countering with standard timeline.`);
      return {
        status: 'COUNTERED',
        proposal: {
          taskId: task.id,
          priceWei: task.budgetWei,
          deliverables: [
            'Express deployment of AI agent capabilities',
            'Automated integration check logs'
          ],
          timelineDays: this.minDaysRequired,
          escrowReleaseConditions: 'Verified integration test report logs',
          arbitrationTerms: 'Disputes settled via OKX.AI native arbitration'
        },
        reason: `Target deadline of ${durationDays.toFixed(1)} days is too short. Integration and verification require a minimum of ${this.minDaysRequired} days.`
      };
    }

    // Standard Accept
    console.log(`[NegotiationEngine] Task approved. Proposal created.`);
    return {
      status: 'ACCEPTED',
      proposal: {
        taskId: task.id,
        priceWei: task.budgetWei,
        deliverables: [
          `Full deployment of requested service: ${task.title}`,
          `Compliance check against description: ${task.description}`
        ],
        timelineDays: Math.max(1, Math.ceil(durationDays)),
        escrowReleaseConditions: 'Client approval or evaluator arbitration release',
        arbitrationTerms: '5% Arbitration bounty deposit in case of dispute'
      },
      reason: 'Budget and timeline are within acceptable operating parameters.'
    };
  }

  /**
   * Refined negotiation cycle. Apply discount structures down to the minimum base price.
   */
  public async negotiateCycle(task: Task, previousOffer: CounterProposal, counterPartyMessage: string): Promise<CounterProposal> {
    console.log(`[NegotiationEngine] Negotiating cycle with buyer message: "${counterPartyMessage}"`);

    if (previousOffer.proposal) {
      const currentPrice = BigInt(previousOffer.proposal.priceWei);
      // Offer 5% price reduction
      const discountedPrice = (currentPrice * 95n) / 100n;

      if (discountedPrice >= this.minBasePriceWei) {
        console.log(`[NegotiationEngine] Discount accepted. New price: ${discountedPrice.toString()} Wei`);
        return {
          status: 'COUNTERED',
          proposal: {
            ...previousOffer.proposal,
            priceWei: discountedPrice.toString()
          },
          reason: 'Discount applied to match buyer budget targets.'
        };
      }
    }

    console.log(`[NegotiationEngine] Declined negotiation: reached minimum threshold.`);
    return {
      status: 'DECLINED',
      reason: 'Negotiated price is below minimum viable threshold.'
    };
  }
}
