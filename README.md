# QuorixASP

**QuorixASP** is an autonomous Agent Service Provider (ASP) broker for [OKX.AI](https://www.okx.ai)'s agent marketplace. It discovers live public tasks, evaluates SLA terms, audits counterparty reputation, exposes metered A2MCP tools for other agents, and provides an operator console for monitoring broker activity.

Built for the **OKX AI Genesis Hackathon** (2026). This repository is the broker daemon, web console, and MCP tool surface.

**Registered OKX.AI agent ID:** `#4187` (QuorixASP ASP identity). Service listing and approval status are managed through OKX.AI's agent identity flow (`onchainos agent activate`, etc.) and are independent of this codebase running locally.

**Live on OKX.AI:** [www.okx.ai/agents/4187](https://www.okx.ai/agents/4187) — public ASP listing for **QuorixASP** (Agent ID **4187**).

**GitHub repository:** [github.com/Datwebguy/Quorix](https://github.com/Datwebguy/Quorix) — the repo is named **Quorix** (shorter GitHub slug). The product, UI, and ASP identity are branded **QuorixASP** throughout.

### OKX.AI marketplace listing

| | |
|--|--|
| **Agent** | [QuorixASP #4187](https://www.okx.ai/agents/4187) |
| **Marketplace URL** | https://www.okx.ai/agents/4187 |
| **Role** | Autonomous A2A deal broker on the OKX.AI agent economy |
| **Production API** | https://quorixasp.fly.dev |

**What the listing sells (A2MCP / pay-per-call unless noted):**

| Service | Fee (USDT) | Notes |
|---------|------------|--------|
| **A2A Marketplace Deal Broker** | 0.5 | Full A2A brokerage for public tasks (discovery, reputation, SLA path) |
| **Quorix Reputation Audit** | 0.005 | On-chain agent reputation on X Layer — pass agent wallet `0x…` |
| **Quorix Escrow Monitor** | 0.005 | Escrow / settlement status for an OKX.AI job or reference task |
| **Quorix Metered Utility (x402)** | 0.005 | Pay-per-call gateway for `reputation_audit`, `escrow_check`, `task_match` |
| **Quorix Task Matcher** | 0.005 | Open marketplace tasks ranked by capability match |

Buyers discover the agent on OKX.AI, copy the service handoff prompt from a listing, then complete payment in their Agent host via **Onchain OS** + **Agentic Wallet** (**OKX Agent Payments Protocol** / x402). This repo is the broker daemon and endpoints behind that listing.

---

## What it does

| Capability | How it works today |
|------------|-------------------|
| **Live task discovery** | Wraps official `onchainos agent task-search` and `recommend-task` against the real OKX.AI marketplace API (`okx.ai/tasks`) |
| **Capability matching** | Scores tasks against keywords relevant to ASP brokerage in `SemanticMatcher` (SLA, marketplace, negotiation, etc.) |
| **SLA negotiation** | `NegotiationEngine` accepts, counters, or declines proposals by budget and timeline rules |
| **Reputation auditing** | Reads X Layer event logs via `ReputationScorer` (X402Rating / TaskManager history) for trust signals |
| **Escrow monitoring** | **Live path:** `onchainos agent status` for OKX.AI marketplace jobIds. **Reference path:** viem reads on hackathon TaskManager `0x599e…E01D` (demo only) |
| **A2MCP tools** | HTTP JSON-RPC MCP surface (`/api/mcp/*`) with six registered tools; `pay_per_call_utility` gates via **OKX Agent Payments Protocol** (HTTP 402 + `PAYMENT-REQUIRED`) |
| **Operator console** | `dashboard.html` — task feed, negotiation panel, reputation audit, optional developer MCP invoke UI |
| **Admin log stream** | `admin.html` — gated behind `ADMIN_PASSWORD`, separate from the operator login flow |

**Important:** For tasks discovered on the live OKX.AI marketplace, settlement and payment run on **OKX.AI infrastructure**. QuorixASP tracks deals locally and surfaces marketplace data via CLI. It does not replace OKX's backend escrow for production marketplace jobs.

---

## Engineering pivot (documented honestly)

Early development targeted a **hackathon reference TaskManager contract** on X Layer (`0x599e…E01D`) — scanning `TaskCreated` logs and calling `createTask` directly.

That path revealed a concrete finding:

> The reference contract had **zero real marketplace activity** (`getTaskCount() === 0`). It is **not** what the live OKX.AI task board uses.

Production discovery was rebuilt around the **official Onchain OS CLI**:

```bash
onchainos agent task-search ...
onchainos agent recommend-task --agent-id <AGENT_ID>
```

The reference on chain scanner remains in `src/discovery/marketplaceReference.ts` as a **hackathon competency demo** only. The dashboard task feed and MCP `match_market_tasks` tool use the CLI based path in `src/discovery/marketplace.ts`.

### Payment / escrow path audit

| Module | Classification | Notes |
|--------|----------------|-------|
| `src/discovery/marketplace.ts` | **(a) live/production** | `task-search` / `recommend-task` via Onchain OS CLI |
| `src/onchainos/taskLifecycle.ts` | **(a) live/production** | `contact-user`, `agent status` for marketplace negotiate + escrow lifecycle |
| `src/onchainos/settlement.ts` | **(a) live/production** | Maps live OKX status → unified escrow snapshot |
| `src/payments/x402Challenge.ts` | **(a) live/production** | x402 v2 `PAYMENT-REQUIRED` for `pay_per_call_utility` |
| `src/mcp/server.ts` (`pay_per_call_utility`) | **(a) live/production** | Delegates to reputation / escrow / match after `PAYMENT-SIGNATURE` |
| `src/escrow/contract.ts` (viem reads + CLI writes) | **(b) hackathon reference** | TaskManager `0x599e…E01D` — zero real marketplace volume |
| `src/discovery/marketplaceReference.ts` | **(b) hackathon reference** | On-chain log scanner for demo contract only |
| `src/core/orchestrator.ts` (TaskManager poll loop) | **(b) reference only** | Skips reference polling when taskId is a live OKX marketplace jobId |
| Facilitator verify on replay | **(c) gap / honest** | QuorixASP gates on header presence; server-side settlement verify not yet wired |

**A2A escrow (negotiated work):** Publisher funds via OKX.AI (`confirm-accept`, `set-payment-mode`, `complete`) — not QuorixASP's reference `createTask`.

**A2MCP (pay-per-call):** `POST /api/mcp/invoke` with `tool: pay_per_call_utility` → HTTP 402 → buyer signs `onchainos payment pay` → replay with `PAYMENT-SIGNATURE`.

---

## Architecture

```
QuorixASP/
├── index.html, login.html, dashboard.html, admin.html   # Static operator UI
├── assets/logo/                                         # Brand favicon set
├── src/
│   ├── index.ts              # Express daemon: APIs, session registry, static files, startup
│   ├── config/env.ts         # Environment loading and X Layer defaults
│   ├── core/orchestrator.ts  # In memory job lifecycle state machine
│   ├── discovery/
│   │   ├── marketplace.ts          # Production feed — CLI task-search / recommend-task
│   │   ├── marketplaceReference.ts # Reference only on chain log scanner (hackathon demo)
│   │   └── matching.ts             # Semantic keyword scorer for ASP capabilities
│   ├── onchainos/
│   │   ├── exec.ts                 # execFile only CLI spawn + isolated ONCHAINOS_HOME
│   │   ├── taskLifecycle.ts        # contact-user, agent status (live marketplace)
│   │   ├── settlement.ts           # Live OKX escrow reads vs reference TaskManager
│   │   └── taskMarketplace.ts      # task-search, recommend-task, agent ID resolution
│   ├── payments/
│   │   ├── x402Challenge.ts        # PAYMENT-REQUIRED builder (x402 v2)
│   │   └── authorization.ts        # PAYMENT-SIGNATURE / X-PAYMENT extraction
│   ├── negotiation/
│   │   ├── engine.ts               # SLA accept / counter / decline rules
│   │   └── schemas.ts              # Task and proposal types (Zod)
│   ├── reputation/scorer.ts        # On chain reputation log analysis
│   ├── escrow/contract.ts          # viem reads; Onchain OS CLI writes to TaskManager
│   ├── mcp/
│   │   ├── server.ts               # MCP invoke handler and rate limiting
│   │   ├── registry.ts             # Tool definitions and input schemas
│   │   ├── tools.ts                # Tool execution wiring
│   │   ├── responses.ts            # Structured MCP response helpers
│   │   └── okxIntegration.ts       # ASP service registration guidance / manifest
│   ├── blockchain/
│   │   ├── logScan.ts              # Chunked eth_getLogs for large lookbacks
│   │   └── rpcTransport.ts         # RPC error classification and retry hints
│   └── utils/logDedupe.ts          # Suppresses repeated error spam in logs
├── scripts/                  # Local dev helpers (login, probes, logo generation)
├── tests/broker.test.ts      # Broker unit tests
└── .env.example              # Required environment template (copy to .env)
```

### Request flow (simplified)

```
Browser console ──► Express (index.ts) ──► MarketplaceScanner
                                              │
                                              ├─► execFile(onchainos agent task-search)
                                              ├─► NegotiationEngine / Orchestrator
                                              ├─► ReputationScorer (viem reads)
                                              └─► XLayerClient (viem reads + CLI writes)

External agents ──► /api/mcp/invoke ──► QuorixMcpServer ──► same core modules
```

---

## Security and isolation

| Property | Implementation |
|----------|----------------|
| **No shell injection** | All `onchainos` invocations use `child_process.execFile` with argument arrays — never `exec` or shell string interpolation (`src/onchainos/exec.ts`, `src/escrow/contract.ts`, `src/index.ts`) |
| **Per operator session isolation** | Dashboard login maps each wallet to `%TEMP%/okx-cli-sessions/<hash>/` with its own `ONCHAINOS_HOME`, `USERPROFILE`, `APPDATA` (`buildIsolatedCliEnv`) |
| **ASP daemon session** | Broker process sets `ONCHAINOS_HOME` from `ONCHAINOS_CLI_SESSION` at startup — separate from other operators' sessions |
| **Admin gate** | Server **refuses to start** without `ADMIN_PASSWORD`. Admin routes and `admin.html` require password auth — no default password |
| **Write safety checks** | Contract addresses and calldata validated before CLI spawn; USDC `approve` skipped when allowance is already sufficient; `createTask` verifies `getTaskCount()` increment after submit |
| **Secrets excluded from git** | `.env`, session JSON, `scratch/`, logs, and `dist/` are in `.gitignore` |

---

## Tech stack

From `package.json` (runtime dependencies):

| Package | Role |
|---------|------|
| **express** ^5.2 | HTTP API and static file server |
| **viem** ^2.21 | X Layer JSON-RPC reads and ABI encoding |
| **@modelcontextprotocol/sdk** ^1.0 | MCP tool schema/types |
| **@okxweb3/a2a-node** ^0.1 | OKX A2A node integration |
| **zod** ^3.23 | Request/schema validation |
| **dotenv** ^16.4 | `.env` loading |
| **cors** ^2.8 | CORS for local dashboard |
| **typescript** / **ts-node** | Build and dev execution |

External requirement: **Onchain OS CLI** (`onchainos`) installed via [okx/onchainos-skills](https://github.com/okx/onchainos-skills) and an authenticated Agentic Wallet session.

---

## Setup

### 1. Prerequisites

- Node.js 20+
- Onchain OS CLI (`onchainos`) on your PATH (`~/.local/bin/onchainos`)
- OKX Agentic Wallet login and a registered ASP identity on OKX.AI

### 2. Install

```bash
git clone https://github.com/Datwebguy/Quorix.git
cd Quorix
npm install
cp .env.example .env
# Edit .env with your real values — never commit .env
```

### 3. Run

**Production (build + start):**

```bash
npm run start:prod
```

**Development (TypeScript direct, no build step):**

```bash
npm run dev
```

Daemon listens on `PORT` (default **3001**).

| URL | Purpose |
|-----|---------|
| `http://localhost:3001/` | Landing page |
| `http://localhost:3001/login.html` | Operator wallet login |
| `http://localhost:3001/dashboard.html` | Broker console |
| `http://localhost:3001/admin.html` | Admin log viewer (password required) |

### 4. OKX.AI registration (operator)

```bash
npx skills add okx/onchainos-skills --yes -g
```

Then use Onchain OS agent identity commands to register/login as ASP, activate your service listing, and set `AGENT_ID` + `ONCHAINOS_CLI_SESSION` in `.env` to match your isolated session folder.

Local helper scripts (`scripts/asp-login-step1.js`, etc.) read `OKX_OPERATOR_EMAIL` and `ONCHAINOS_CLI_SESSION` from `.env`.

---

## Environment variables

Copy `.env.example` → `.env`. Every variable:

| Variable | Description |
|----------|-------------|
| `X_LAYER_RPC_URL` | X Layer JSON-RPC endpoint (default: `https://rpc.xlayer.tech`) |
| `ESCROW_CONTRACT_ADDRESS` | Hackathon reference TaskManager contract on X Layer |
| `RATING_CONTRACT_ADDRESS` | Hackathon reference X402Rating contract on X Layer |
| `USDC_TOKEN_ADDRESS` | USDC token used by TaskManager `createTask` / allowance checks |
| `AGENT_ID` | Your registered OKX.AI agent registry ID (QuorixASP: `4187`) |
| `ONCHAINOS_CLI_SESSION` | 16 character hex session hash → `%TEMP%/okx-cli-sessions/<hash>` |
| `OKX_OPERATOR_EMAIL` | Operator email for local `asp-login-*` helper scripts only |
| `OKX_AGENT_AVATAR_PATH` | Optional avatar PNG path for `asp-register-precheck.js` |
| `MARKETPLACE_LOOKBACK_BLOCKS` | Block lookback for reference on chain scanner (not the live CLI feed) |
| `PUBLIC_BASE_URL` | Public HTTPS URL for A2MCP / ASP service registration |
| `ADMIN_PASSWORD` | **Required.** Admin panel password; server exits if unset |
| `PORT` | Express listen port (default `3001`) |
| `POLL_INTERVAL_MS` | Polling interval for on chain confirmation loops |
| `MAX_POLL_ATTEMPTS` | Max poll attempts before giving up on pending txs |
| `BROKER_FEE_BPS` | Broker fee basis points for SLA calculations (default `100` = 1%) |
| `MIN_REPUTATION_SCORE` | Minimum reputation score to accept a counterparty |
| `MAX_DISPUTE_RATE` | Maximum tolerated dispute rate (0–1 fraction) |
| `A2MCP_CALL_PRICE_USDT` | Metered x402 price per `pay_per_call_utility` call (default `0.005` USDT). Governs `PAYMENT-REQUIRED` accepts[]. |
| `A2MCP_CALL_PRICE_OKB` | Legacy alias for `A2MCP_CALL_PRICE_USDT` — same value, kept for older `.env` files. |
| `A2MCP_PAY_TO_WALLET` | ASP wallet receiving metered x402 payments on X Layer. Required when `A2MCP_X402_ENABLED=true`. |
| `A2MCP_X402_ENABLED` | Gate `pay_per_call_utility` behind HTTP 402 (default: `true` when `A2MCP_PAY_TO_WALLET` is set). |
| `USDT_TOKEN_ADDRESS` | USDT on X Layer for x402 accepts[] (default mainnet USDT). |
| `USDG_TOKEN_ADDRESS` | Optional second settlement currency in x402 accepts[]. |
| `A2A_SERVICE_FEE_USDT` | Registered A2A service fee shown in the UI (default `0.5` USDT). Set this to match your OKX.AI listing. |

**Fee clarification:** `A2A_SERVICE_FEE_USDT` is your **negotiated-work ASP listing** on OKX.AI. `A2MCP_CALL_PRICE_USDT` is the **metered per-call** price for `pay_per_call_utility` via x402 — a separate billing mode.

---

## MCP tools (live)

| Tool | Purpose |
|------|---------|
| `check_agent_reputation` | On chain reputation audit for an agent wallet |
| `check_escrow_status` | TaskManager escrow state for a task ID |
| `verify_task_proof` | Compare deliverable hash against agreed proof reference |
| `evaluate_deal_proposal` | SLA engine: accept / counter / decline |
| `match_market_tasks` | CLI based marketplace discovery with capability scores |
| `pay_per_call_utility` | x402-gated metered billing — delegates to reputation_audit / escrow_check / task_match after `PAYMENT-SIGNATURE` |

Manifest: `GET /api/mcp/manifest`

---

## Development

```bash
npm run dev          # ts-node src/index.ts — fast iteration, no build
npm run build        # tsc only
npm start            # node dist/src/index.js — requires npm run build first
npm run start:prod   # build + start (same as production path above)
npm test             # ts-node tests/broker.test.ts
```

Regenerate logo/favicon assets (requires `assets/logo/logo-source.png`):

```bash
python scripts/generate-logo-assets.py
```

---

## Hackathon context

**OKX AI Genesis Hackathon** — QuorixASP demonstrates a production grade ASP broker:

- Real OKX.AI marketplace integration via official CLI (not a mock task list)
- Honest documentation of the reference contract dead end and the pivot that followed
- CLI session isolation suitable for multiple operator dashboard logins
- Branded operator console with live task feed, negotiation, and MCP tool surface

Reference contract addresses (X Layer mainnet) are documented in `src/config/env.ts` and the landing page footer for evaluator cross check — they are **demonstration deployments**, not the live marketplace settlement path.

---

## License

MIT — see [LICENSE](LICENSE).