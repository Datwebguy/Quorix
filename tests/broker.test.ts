process.env.ESCROW_CONTRACT_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
process.env.RATING_CONTRACT_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
process.env.A2MCP_PAY_TO_WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
process.env.A2MCP_X402_ENABLED = 'true';
process.env.A2MCP_CALL_PRICE_USDT = '0.005';

import { SemanticMatcher } from '../src/discovery/matching';
import { NegotiationEngine } from '../src/negotiation/engine';
import { XLayerClient } from '../src/escrow/contract';
import { Task } from '../src/negotiation/schemas';
import { QuorixOrchestrator } from '../src/core/orchestrator';
import { ReputationScorer } from '../src/reputation/scorer';
import {
  extractPaymentAuthorization,
  hasPaymentAuthorization,
} from '../src/payments/authorization';
import { buildPayPerCallChallenge } from '../src/payments/x402Challenge';
import {
  isReferenceTaskManagerId,
  requiresLiveOkxSettlementPath,
} from '../src/onchainos/settlement';
import { portalUrlForJob, portalLinkHint } from '../src/onchainos/portalUrls';
import { verifyPaymentAuthorization } from '../src/payments/verify';

async function runTests() {
  console.log('====================================================');
  console.log('       QUORIXASP PRODUCTION INTEGRATION TESTS       ');
  console.log('====================================================\n');

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

    assert(orchestrator !== undefined, 'Orchestrator successfully instantiated');

    const alignedTask: Task = {
      id: 'task-001',
      clientAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      title: 'A2A broker for marketplace escrow and agent task negotiation',
      description: 'Require ASP to audit reputation, monitor escrow payment locks, and broker deals on X Layer',
      budgetWei: '1000000',
      deadlineTimestamp: Math.floor(Date.now() / 1000) + 500,
    };

    const matchResult = matcher.matchTask(alignedTask);
    assert(matchResult.isMatched === true, 'Aligned task matches capabilities');
    assert(
      matchResult.matchedCapabilities.includes('reputation & escrow'),
      "Matches 'reputation & escrow' capability"
    );

    const misalignedTask: Task = {
      id: 'task-002',
      clientAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      title: 'Create graphical marketing banner',
      description: 'Design a logo and banner for website',
      budgetWei: '1000000',
      deadlineTimestamp: Math.floor(Date.now() / 1000) + 500,
    };
    const mismatchResult = matcher.matchTask(misalignedTask);
    assert(mismatchResult.isMatched === false, 'Misaligned task is rejected');

    const cheapTask: Task = {
      id: 'task-cheap',
      clientAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      title: 'Verify escrow lock logs',
      description: 'Log checks',
      budgetWei: '1000',
      deadlineTimestamp: Math.floor(Date.now() / 1000) + 10 * 24 * 3600,
    };

    const cheapEvaluation = await negEngine.evaluateTaskProposal(cheapTask);
    assert(cheapEvaluation.status === 'COUNTERED', 'Negotiator counters low budget task');
    assert(
      cheapEvaluation.proposal?.priceWei === '50000',
      'Counter price is correctly set to min price limit (0.05 USDC)'
    );

    const parsedId = blockchainClient.parseTaskId('42');
    assert(parsedId === 42n, 'parseTaskId accepts decimal uint256 task IDs');
    let threw = false;
    try {
      blockchainClient.parseTaskId('0xabc');
      threw = false;
    } catch {
      threw = true;
    }
    assert(threw, 'parseTaskId rejects bytes32 hex (official contract uses uint256)');

    // --- Payment layer alignment (mocked / no live CLI) ---
    assert(isReferenceTaskManagerId('42') === true, 'Decimal taskId routes to reference TaskManager');
    assert(
      isReferenceTaskManagerId('0xdeadbeef') === false,
      'Hex jobId does not route to reference TaskManager'
    );
    assert(
      requiresLiveOkxSettlementPath('0xabc123') === true,
      'Hex marketplace jobId requires live OKX settlement path'
    );
    assert(
      requiresLiveOkxSettlementPath('394079') === true,
      'Numeric OKX portal jobId requires live OKX settlement path'
    );
    assert(
      requiresLiveOkxSettlementPath('42') === false,
      'Reference decimal taskId does not require live OKX path'
    );

    const challenge = buildPayPerCallChallenge({
      baseUrl: 'https://quorixasp.fly.dev',
      operation: 'reputation_audit',
    });
    assert(challenge.x402Version === 2, 'x402 challenge uses version 2');
    assert(
      Array.isArray(challenge.body.accepts) && challenge.body.accepts.length >= 1,
      'Challenge body includes accepts entries'
    );
    const decoded = JSON.parse(
      Buffer.from(challenge.paymentRequiredHeader, 'base64').toString('utf8')
    );
    assert(decoded.x402Version === 2, 'PAYMENT-REQUIRED payload is x402 v2 JSON');
    assert(
      decoded.accepts[0].scheme === 'exact' && decoded.accepts[0].network === 'eip155:196',
      'accepts entry uses exact scheme on X Layer'
    );
    assert(
      decoded.accepts[0].amount === '5000',
      '0.005 USDT encodes to 5000 atomic units (6 decimals)'
    );

    const headersV2 = { 'payment-signature': 'signed-proof-base64' };
    const auth = extractPaymentAuthorization(headersV2);
    assert(auth?.headerName === 'PAYMENT-SIGNATURE', 'Extracts PAYMENT-SIGNATURE header');
    assert(hasPaymentAuthorization(headersV2) === true, 'Detects v2 payment authorization');

    const headersV1 = { 'x-payment': 'legacy-proof' };
    assert(
      extractPaymentAuthorization(headersV1)?.headerName === 'X-PAYMENT',
      'Falls back to legacy X-PAYMENT header'
    );
    assert(hasPaymentAuthorization({}) === false, 'Missing payment headers return false');

    const payTo = process.env.A2MCP_PAY_TO_WALLET || '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const validPayload = Buffer.from(
      JSON.stringify({
        payTo,
        amount: '5000',
        scheme: 'exact',
        network: 'eip155:196',
      }),
      'utf8'
    ).toString('base64');

    const structuralOk = await verifyPaymentAuthorization(
      { headerName: 'PAYMENT-SIGNATURE', value: validPayload },
      { payTo, amountAtomic: '5000', operation: 'reputation_audit' }
    );
    assert(structuralOk.ok === true, 'Structural verify accepts valid payTo/amount payload');
    assert(structuralOk.level === 'beta', 'Default structural verify is beta level');

    const wrongPayTo = await verifyPaymentAuthorization(
      { headerName: 'PAYMENT-SIGNATURE', value: validPayload },
      { payTo: '0x0000000000000000000000000000000000000001', amountAtomic: '5000', operation: 'x' }
    );
    assert(wrongPayTo.ok === false, 'Structural verify rejects payTo mismatch');

    const replay = await verifyPaymentAuthorization(
      { headerName: 'PAYMENT-SIGNATURE', value: validPayload },
      { payTo, amountAtomic: '5000', operation: 'reputation_audit' }
    );
    assert(replay.ok === false, 'Structural verify rejects signature replay');

    assert(
      portalUrlForJob('394079') === 'https://www.okx.ai/tasks/394079',
      'Numeric portal ID gets public OKX.AI URL'
    );
    assert(portalUrlForJob('0xdeadbeef') === undefined, 'Hex jobId does not get broken portal URL');
    assert(
      portalLinkHint('0xdeadbeef').includes('My Tasks'),
      'Hex jobId hint directs to OKX.AI My Tasks'
    );

    console.log('\n====================================================');
    console.log(`PRODUCTION TESTS COMPLETED. Passed: ${testsPassed}, Failed: ${testsFailed}`);
    console.log('====================================================');

    if (testsFailed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err: any) {
    console.error('[Test Suite] Critical test run exception:', err.message || err);
    process.exit(1);
  }
}

runTests();