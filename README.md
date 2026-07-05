# QuorixASP

Production-grade Agent Service Provider (ASP) broker engine built for **OKX.AI**, inspired by Virtuals Protocol’s Agent Commerce Protocol (ACP).

QuorixASP acts as an autonomous deal broker for agent-to-agent (A2A) commerce on the **X Layer** network. It tracks marketplace task lists, audits client agent reputations, handles SLA terms negotiations, monitors escrow payment locks, submits cryptographic proofs-of-work, handles disputes with evaluation bounties, and processes instant pay-per-call A2MCP requests.

---

## Repository Skeleton

```
QuorixASP/
├── package.json            # Script definitions and dependency manifests
├── tsconfig.json           # Compiler configuration for CommonJS modules
├── README.md               # Onboarding and command documentation
└── src/
    ├── index.ts            # Entrypoint (starts both A2A loop and A2MCP server)
    ├── config/
    │   └── env.ts          # Environmental variables, rules, and X Layer RPCs
    ├── core/
    │   └── orchestrator.ts # Lifecycle state machine (matching, reputation, escrow, payout, ratings)
    ├── discovery/
    │   └── matching.ts     # Semantic keyword task capability matcher
    ├── escrow/
    │   └── contract.ts     # EVM adapter interface via viem + Onchain OS CLI calls for writes
    ├── mcp/
    │   └── server.ts       # Model Context Protocol stdio tools server (rate limits, parameter filtering)
    ├── negotiation/
    │   ├── engine.ts       # SLA pricing logic & negotiation strategy module
    │   └── schemas.ts      # Strict Zod schema validators
    └── reputation/
        └── scorer.ts       # Blockchain logs ratings auditor (scans X Layer events)
```

---

## Technical Architecture & Onchain OS Integration

QuorixASP utilizes a hybrid execution pattern designed to maximize security:
*   **Reads (Viem & Public Client)**: All checks (verifying escrow locks, parsing reputation ratings) are executed via light, fast JSON-RPC reads on the X Layer network.
*   **Writes (Onchain OS CLI Integration)**: QuorixASP never holds private keys. All state-changing write transactions (creating escrow, releasing payment, filing a dispute, submitting rating) are delegated to the `onchainos` CLI. It spawns the command:
    ```bash
    onchainos wallet contract-call --to <escrow_address> --chain x-layer --input-data <hex_calldata> [--amt <native_value_wei>]
    ```
    This redirects the signing action to the secure Onchain OS Agentic Wallet.

---

## Onchain OS Registration Steps

To link this codebase to the **OKX.AI** marketplace, run the following commands in your agent console:

1. **Install Onchain OS Skills**:
   ```bash
   npx skills add okx/onchainos-skills --yes -g
   ```
   *(Be sure to restart/open a new session after this completes)*

2. **Log in to Agentic Wallet**:
   ```
   Prompt: Log in to Agentic Wallet on Onchain OS with my email
   ```

3. **Register as A2A Broker**:
   ```
   Prompt: Help me register an A2A ASP on OKX.AI using OKX Agent Identity from Onchain OS
   ```
   *Provide details when prompted:*
   *   **Name**: `QuorixASP Broker`
   *   **Description**: `Autonomous agent broker for A2A commerce. Discovers tasks, negotiates terms, monitors escrow settlements, and submits verified proofs-of-work.`
   *   **Service List**: `[1] Task Discovery & Matching, [2] Term Negotiation, [3] X Layer Escrow Management, [4] Agent Reputation Auditing`
   *   **Default Pricing**: `1% transaction brokering fee settled dynamically on X Layer`

4. **Register as A2MCP Service**:
   ```
   Prompt: Help me register an A2MCP ASP on OKX.AI using OKX Agent Identity from Onchain OS
   ```
   *Provide details when prompted:*
   *   **Service Name**: `Quorix Reputation API`
   *   **Description**: `Pay-per-call on-chain reputation logs lookup for agents on X Layer.`
   *   **Price**: `0.005 OKB per call`
   *   **Endpoint**: `https://api.quorix.io/mcp/reputation`

5. **Request Marketplace Listing**:
   ```
   Prompt: Help me list my ASP on OKX.AI using Onchain OS
   ```

---

## Setup & Running Locally

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Create a `.env` file in the project root:
```env
X_LAYER_RPC_URL=https://rpc.xlayer.tech
ESCROW_CONTRACT_ADDRESS=0xOfficialOKXNativeEscrowAddress
POLL_INTERVAL_MS=15000
MAX_POLL_ATTEMPTS=20
PORT=3000
```
*Note: To query the official Escrow contract address from Onchain OS registry, run: `onchainos registry get --name agent-escrow-a2a --chain x-layer`*

### 3. Run Simulations
Starts the stdio A2MCP server and the A2A polling sweep:
```bash
npm run dev
```

### 4. Run Automated Tests
```bash
npm run test
```

---

## Troubleshooting Guide

#### 1. `onchainos: command not found`
*   **Reason**: The Onchain OS CLI binary is not in your system's environment `PATH` variable.
*   **Fix**: Verify your installation. Re-run `npx skills add okx/onchainos-skills --yes -g` and open a brand new terminal session so path updates take effect.

#### 2. `Onchain OS wallet call failed: Authentication Required`
*   **Reason**: The Agentic Wallet session has expired or is unauthenticated.
*   **Fix**: Run the wallet login prompt: `Log in to Agentic Wallet on Onchain OS with my email` in the agent terminal and complete the email verification handshake.

#### 3. `Log query failed: rate limit exceeded`
*   **Reason**: The public X Layer RPC endpoint is throttled or timed out.
*   **Fix**: Configure a custom private RPC endpoint in your `.env` under `X_LAYER_RPC_URL`. QuorixASP will automatically retry logs sweeps using exponential backoff (up to 3 attempts).

#### 4. `Out of Gas / Insufficient Funds`
*   **Reason**: The wallet has insufficient OKB to pay for EVM gas or lock the 5% dispute arbitration bounty.
*   **Fix**: Deposit OKB gas tokens on X Layer to the agent wallet address (retrieve the address using `onchainos wallet show`).
