import * as dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

/**
 * REFERENCE / HACKATHON on-chain deployments (X Layer Mainnet, chain 196).
 * These demonstrate escrow mechanics but are NOT the live okx.ai/tasks marketplace path.
 * Production task discovery uses `onchainos agent task-search` / `recommend-task`
 * (OKX aieco backend). See WALKTHROUGH.md.
 *
 * - TaskManager (USDC A2A Escrow): 0x599e23D6073426eBe357d03056258eEAa217e01D
 * - X402Rating (On-chain Reputation ratings): 0x85Be67F1A3c1f470A6c94b3C77fD326d3c0f1188
 * - AgentRegistry (Multi-agent registrations): 0x7337a8963Dc7Cf0644f9423bBE397b3D0f97ACa1
 * - ReputationEngine: 0x3bf87bf49141B014e4Eef71A661988624c1af29F
 */
export const ENV = {
  // X Layer RPC node (defaults to X Layer Mainnet RPC)
  X_LAYER_RPC_URL: process.env.X_LAYER_RPC_URL || 'https://rpc.xlayer.tech',

  // USDC on X Layer (6 decimals) — used by TaskManager.createTask transferFrom
  USDC_TOKEN_ADDRESS: process.env.USDC_TOKEN_ADDRESS || '0x74b7F16337b8972027F6196A17a631aC6dE26d22',

  // QuorixASP registered agent ID on AgentRegistry (required for createTask)
  AGENT_ID: BigInt(process.env.AGENT_ID || '3827'),

  // The OKX.AI native TaskManager (escrow) contract address on X Layer
  ESCROW_CONTRACT_ADDRESS: process.env.ESCROW_CONTRACT_ADDRESS || '0x599e23D6073426eBe357d03056258eEAa217e01D',
  
  // The OKX.AI native X402Rating contract address on X Layer
  RATING_CONTRACT_ADDRESS: process.env.RATING_CONTRACT_ADDRESS || '0x85Be67F1A3c1f470A6c94b3C77fD326d3c0f1188',
  
  // Configurable polling settings for task listings and payment confirmations
  POLL_INTERVAL_MS: Math.max(
    parseInt(process.env.POLL_INTERVAL_MS || '120000', 10) || 120000,
    60_000
  ), // Default 2 min; minimum 1 min to avoid RPC rate limits
  MAX_POLL_ATTEMPTS: parseInt(process.env.MAX_POLL_ATTEMPTS || '20', 10),  // Default to 20 attempts (5 minutes total)
  
  // Broker SLA Constraints
  BROKER_FEE_BPS: parseInt(process.env.BROKER_FEE_BPS || '100', 10), // 100 bps = 1%
  MIN_REPUTATION_SCORE: parseFloat(process.env.MIN_REPUTATION_SCORE || '3.0'), // 1.0 to 5.0 scale
  MAX_DISPUTE_RATE: parseFloat(process.env.MAX_DISPUTE_RATE || '0.20'), // Max 20% dispute rate tolerated
  
  // A2MCP Micro-Service Pricing
  A2MCP_CALL_PRICE_OKB: process.env.A2MCP_CALL_PRICE_OKB || '0.005',
  
  // Server port
  PORT: parseInt(process.env.PORT || '3001', 10),
};
