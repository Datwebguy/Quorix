process.env.ESCROW_CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
process.env.RATING_CONTRACT_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

import { SemanticMatcher } from '../src/discovery/matching';
import { NegotiationEngine } from '../src/negotiation/engine';
import { XLayerClient } from '../src/escrow/contract';
import { Task } from '../src/negotiation/schemas';
import { QuorixOrchestrator } from '../src/core/orchestrator';
import { ReputationScorer } from '../src/reputation/scorer';

async function runTests() {
  console.log("====================================================");
  console.log("       QUORIXASP PRODUCTION INTEGRATION TESTS       ");
  console.log("====================================================\n");

  let testsPassed = 0;
  let testsFailed = 0;

  const assert = (condition: boolean, testName: string) => {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      testsPassed++;
    } else {
      console.error(`[FAIL] ${testName}`);
      testsFailed++;
    }
  };

  try {
    const matcher = new SemanticMatcher();
    const negEngine = new NegotiationEngine();
    
    const repScorer = new ReputationScorer();
    const blockchainClient = new XLayerClient();
    const orchestrator = new QuorixOrchestrator(matcher, repScorer, negEngine, blockchainClient);

    assert(orchestrator !== undefined, "Orchestrator successfully instantiated");

    const alignedTask: Task = {
      id: "task-001",
      clientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      title: "Need escrow payment lock monitoring tool",
      description: "Require provider to monitor locked funds on X Layer",
      budgetWei: "1000000",
      deadlineTimestamp: Math.floor(Date.now() / 1000) + 500
    };

    const matchResult = matcher.matchTask(alignedTask);
    assert(matchResult.isMatched === true, "Aligned task matches capabilities");
    assert(matchResult.matchedCapabilities.includes("escrow verification"), "Matches 'escrow verification' capability");

    const misalignedTask: Task = {
      id: "task-002",
      clientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      title: "Create graphical marketing banner",
      description: "Design a logo and banner for website",
      budgetWei: "1000000",
      deadlineTimestamp: Math.floor(Date.now() / 1000) + 500
    };
    const mismatchResult = matcher.matchTask(misalignedTask);
    assert(mismatchResult.isMatched === false, "Misaligned task is rejected");

    const cheapTask: Task = {
      id: "task-cheap",
      clientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      title: "Verify escrow lock logs",
      description: "Log checks",
      budgetWei: "1000", // 0.001 USDC (below min 0.05)
      deadlineTimestamp: Math.floor(Date.now() / 1000) + 10 * 24 * 3600
    };

    const cheapEvaluation = await negEngine.evaluateTaskProposal(cheapTask);
    assert(cheapEvaluation.status === 'COUNTERED', "Negotiator counters low budget task");
    assert(cheapEvaluation.proposal?.priceWei === "50000", "Counter price is correctly set to min price limit (0.05 USDC)");

    const parsedId = blockchainClient.parseTaskId("42");
    assert(parsedId === 42n, "parseTaskId accepts decimal uint256 task IDs");
    let threw = false;
    try {
      blockchainClient.parseTaskId("0xabc");
      threw = false;
    } catch {
      threw = true;
    }
    assert(threw, "parseTaskId rejects bytes32 hex (official contract uses uint256)");

    console.log("\n====================================================");
    console.log(`PRODUCTION TESTS COMPLETED. Passed: ${testsPassed}, Failed: ${testsFailed}`);
    console.log("====================================================");

    if (testsFailed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }

  } catch (err: any) {
    console.error("[Test Suite] Critical test run exception:", err.message || err);
    process.exit(1);
  }
}

runTests();