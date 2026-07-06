import { SemanticMatcher } from './discovery/matching';
import { MarketplaceScanner } from './discovery/marketplace';
import type { OkxCliSession } from './onchainos/taskMarketplace';
import { walletIsLoggedIn } from './onchainos/taskMarketplace';
import { ReputationScorer } from './reputation/scorer';
import { NegotiationEngine } from './negotiation/engine';
import { XLayerClient } from './escrow/contract';
import { QuorixOrchestrator } from './core/orchestrator';
import { QuorixMcpServer } from './mcp/server';
import { QUORIX_MCP_TOOL_META, buildMcpToolDefinitions } from './mcp/tools';
import { buildQuorixMcpManifest } from './mcp/okxIntegration';
import { parseLegacyPayload } from './mcp/responses';
import { ENV } from './config/env';
import { shortenRpcError } from './blockchain/rpcTransport';
import { logErrorOnce } from './utils/logDedupe';
import express from 'express';
import cors from 'cors';
import { execFile } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';

const logBuffer: string[] = [];

// Capture all console output into memory logs for real-time dashboard terminal streaming
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args: any[]) => {
  const line = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  logBuffer.push(line);
  if (logBuffer.length > 300) logBuffer.shift();
  originalLog.apply(console, args);
};

console.warn = (...args: any[]) => {
  const line = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  logBuffer.push(`[WARN] ${line}`);
  if (logBuffer.length > 300) logBuffer.shift();
  originalWarn.apply(console, args);
};

console.error = (...args: any[]) => {
  const line = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  logBuffer.push(`[ERROR] ${line}`);
  if (logBuffer.length > 300) logBuffer.shift();
  originalError.apply(console, args);
};

interface SessionRecord {
  email: string;
  walletAddress: string;
  homeDir: string;
  lastActive: number;
}
const sessionRegistry = new Map<string, SessionRecord>(); // walletAddress -> SessionRecord
const otpCooldownMs = 120_000; // OKX rate-limits rapid OTP resends; reuse pending flows within this window
const otpAttemptTracker = new Map<string, number>(); // normalizedEmail -> last wallet login attempt timestamp

// Helper to shorten file paths for logging security
function getShortPath(fullPath: string): string {
  if (!fullPath) return '';
  return path.basename(fullPath);
}

/** Resolve project root for static HTML assets in both dev (src/) and prod (dist/src/). */
function resolveStaticRoot(): string {
  const candidates = [
    path.join(__dirname, '..'),
    path.join(__dirname, '../..'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'login.html'))) return dir;
  }
  return path.join(__dirname, '../..');
}

function isValidWalletAddress(wallet: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(wallet);
}

/** OKX marketplace tasks often expose buyer agent ID (e.g. 4038) instead of a wallet. */
function isValidClientRef(ref: string): boolean {
  const v = String(ref || '').trim();
  return isValidWalletAddress(v) || /^\d+$/.test(v);
}

// Helper to determine deterministic HOME directory per user
function getHomeDirForEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  const homeDir = path.join(os.tmpdir(), 'okx-cli-sessions', hash);
  if (!fs.existsSync(homeDir)) {
    fs.mkdirSync(homeDir, { recursive: true });
  }
  return homeDir;
}
  function buildIsolatedCliEnv(homeDir: string): { env: NodeJS.ProcessEnv; binPath: string } {
    const userProfile = process.env.USERPROFILE || process.env.HOME;
    if (!userProfile) {
      throw new Error("Critical Startup Error: Neither USERPROFILE nor HOME environment variables are defined. Active user profile directory path is required.");
    }

    const binName = process.platform === 'win32' ? 'onchainos.exe' : 'onchainos';
    const binPath = path.join(userProfile, '.local', 'bin', binName);
    const driveMatch = homeDir.match(/^([a-zA-Z]:)(.*)$/);
    const homeDrive = driveMatch ? driveMatch[1] : 'C:';
    const homePath = driveMatch ? driveMatch[2] : homeDir;
    const isolatedAppData = path.join(homeDir, 'AppData', 'Roaming');
    const isolatedLocalAppData = path.join(homeDir, 'AppData', 'Local');
    fs.mkdirSync(isolatedAppData, { recursive: true });
    fs.mkdirSync(isolatedLocalAppData, { recursive: true });

    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const localBinDir = path.join(userProfile, '.local', 'bin');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      HOMEDRIVE: homeDrive,
      HOMEPATH: homePath,
      APPDATA: isolatedAppData,
      LOCALAPPDATA: isolatedLocalAppData,
      ONCHAINOS_HOME: homeDir,
      [pathKey]: `${localBinDir};${process.env[pathKey] || ''}`,
    };

    // Prevent the CLI from falling back to the machine owner's global profile/session.
    delete env.REAL_USERPROFILE;

    return { env, binPath };
  }

  // Helper for executing Onchain OS commands with fully isolated per-email session directories.
  function execOnchainOs(args: string[], homeDir: string, callback: (error: any, stdout: string, stderr: string) => void) {
    const start = Date.now();
    const { env, binPath } = buildIsolatedCliEnv(homeDir);
    const exists = fs.existsSync(homeDir);
    const binName = path.basename(binPath);
    console.log(`[Onchain OS] Spawning CLI binary: "${binName} ${args.join(' ')}" under isolated HOME: "${getShortPath(homeDir)}" (exists: ${exists})`);

    execFile(binPath, args, { env }, (error: any, stdout: any, stderr: any) => {
      const duration = Date.now() - start;
      console.log(`[Onchain OS] CLI command "${args.join(' ')}" took ${duration}ms`);
      callback(error, stdout || '', stderr || '');
    });
  }

// Scans isolated session directories on disk to dynamically rebuild/restore the session mapping
function scanSessions() {
  const rootDir = path.join(os.tmpdir(), 'okx-cli-sessions');
  if (!fs.existsSync(rootDir)) return;
  
  try {
    const dirs = fs.readdirSync(rootDir);
    for (const dir of dirs) {
      const homeDir = path.join(rootDir, dir);
      
      // Perform status query to see if it is logged in
      const statusArgs = ['wallet', 'status'];
      
      execOnchainOs(statusArgs, homeDir, (err: any, stdout: any) => {
        if (!err) {
          try {
            const parsed = JSON.parse((stdout || '').trim());
            if (parsed && parsed.ok && parsed.data && parsed.data.loggedIn && parsed.data.email) {
              const email = parsed.data.email;
              const addressesArgs = ['wallet', 'addresses'];
              execOnchainOs(addressesArgs, homeDir, (aErr: any, aStdout: any) => {
                if (!aErr) {
                  const match = (aStdout || '').match(/0x[a-fA-F0-9]{40}/i);
                  if (match) {
                    const walletAddress = match[0].toLowerCase();
                    const existing = sessionRegistry.get(walletAddress);
                    if (!existing || existing.email !== email || existing.homeDir !== homeDir) {
                      sessionRegistry.set(walletAddress, {
                        email,
                        walletAddress,
                        homeDir,
                        lastActive: Date.now()
                      });
                      console.log(`[Onchain OS] Restored session registry: ${email} -> ${walletAddress} (HOME: ${getShortPath(homeDir)})`);
                    } else {
                      existing.lastActive = Date.now();
                    }
                  }
                }
              });
            }
          } catch (e) {}
        }
      });
    }
  } catch (e) {
    console.error(`[Onchain OS] Error scanning directories:`, e);
  }
}

// Helper to look up mapped session record and update/validate activity
function getSessionForWallet(walletAddress: string): SessionRecord | null {
  if (!walletAddress) return null;
  const key = walletAddress.toLowerCase();
  const cached = sessionRegistry.get(key);
  if (cached) {
    if (Date.now() - cached.lastActive > 24 * 60 * 60 * 1000) {
      sessionRegistry.delete(key);
      return null;
    }
    cached.lastActive = Date.now();
    return cached;
  }
  
  // Try scanning session folders to see if a record exists
  scanSessions();
  const rescanned = sessionRegistry.get(key);
  if (rescanned) {
    if (Date.now() - rescanned.lastActive > 24 * 60 * 60 * 1000) {
      sessionRegistry.delete(key);
      return null;
    }
    rescanned.lastActive = Date.now();
    return rescanned;
  }
  
  return null;
}

async function main() {
  if (!process.env.ADMIN_PASSWORD) {
    throw new Error("Critical Startup Error: ADMIN_PASSWORD environment variable is not defined. Active admin credential is required.");
  }

  // Prefer an explicit OKX CLI session (ASP login) over the legacy broker sandbox.
  const aspSessionHash = process.env.ONCHAINOS_CLI_SESSION?.trim();
  const configuredHome = process.env.ONCHAINOS_HOME?.trim();
  const brokerHome = aspSessionHash
    ? path.join(os.tmpdir(), 'okx-cli-sessions', aspSessionHash)
    : configuredHome && fs.existsSync(configuredHome)
      ? configuredHome
      : path.join(os.tmpdir(), 'okx-cli-sessions', 'broker');
  if (!fs.existsSync(brokerHome)) {
    fs.mkdirSync(brokerHome, { recursive: true });
  }
  process.env.ONCHAINOS_HOME = brokerHome;
  console.log(`[Onchain OS] Marketplace CLI session: ${getShortPath(brokerHome)}`);

  console.log("====================================================");
  console.log("       QUORIXASP DEPLOYED ASP ENGINE DAEMON         ");
  console.log(`       Target Escrow: ${ENV.ESCROW_CONTRACT_ADDRESS} `);
  console.log("====================================================\n");

  // 1. Initialize core system dependencies
  const matcher = new SemanticMatcher();
  const repScorer = new ReputationScorer();
  const negEngine = new NegotiationEngine();
  const blockchainClient = new XLayerClient();

  const orchestrator = new QuorixOrchestrator(
    matcher,
    repScorer,
    negEngine,
    blockchainClient
  );
  const marketplaceScanner = new MarketplaceScanner(matcher);

  async function resolveBrokerCliSession(): Promise<OkxCliSession | null> {
    const brokerHome = process.env.ONCHAINOS_HOME?.trim();
    if (!brokerHome) return null;
    const agentId = process.env.AGENT_ID?.trim() || '4187';
    if (!(await walletIsLoggedIn(brokerHome))) {
      logErrorOnce('broker-wallet', '[TaskFeed] Broker wallet session is not logged in');
      return null;
    }
    return { homeDir: brokerHome, agentId };
  }

  async function resolveVisitorCliSession(wallet?: string): Promise<OkxCliSession | null> {
    if (!wallet) return null;
    const record = getSessionForWallet(wallet);
    if (!record) return null;
    return marketplaceScanner.resolveSession(record.homeDir);
  }

  async function resolveMarketplaceCliSession(wallet?: string): Promise<OkxCliSession | null> {
    if (wallet) return resolveVisitorCliSession(wallet);
    return resolveBrokerCliSession();
  }

  // 2. Start the MCP server (A2MCP Pay-per-call stdio handler)
  const mcpServer = new QuorixMcpServer(
    repScorer,
    negEngine,
    blockchainClient,
    orchestrator,
    marketplaceScanner,
    () => resolveMarketplaceCliSession()
  );
  await mcpServer.start();

  console.log("[Daemon] A2MCP Server running. Listening on stdio channels.");

  // 3. Start Express backend helper server for real-time Web3 Dashboard Console
  const app = express();
  app.use(cors());
  app.use(express.json());
  
  const staticRoot = resolveStaticRoot();
  const cleanPageRoutes: Array<{ cleanPath: string; file: string }> = [
    { cleanPath: '/login', file: 'login.html' },
    { cleanPath: '/dashboard', file: 'dashboard.html' },
    { cleanPath: '/admin', file: 'admin.html' },
    { cleanPath: '/faq', file: 'faq.html' },
  ];

  app.get('/', (_req: any, res: any) => {
    res.sendFile(path.join(staticRoot, 'index.html'));
  });

  for (const { cleanPath, file } of cleanPageRoutes) {
    app.get(cleanPath, (_req: any, res: any) => {
      res.sendFile(path.join(staticRoot, file));
    });
    app.get(`/${file}`, (_req: any, res: any) => {
      res.redirect(301, cleanPath);
    });
  }

  // Serve dashboard HTML, CSS, and client-side assets
  app.use(express.static(staticRoot));

  app.get('/api/status', (req: any, res: any) => {
    res.json({
      // Source: .env AGENT_ID — onchainos agent get --agent-ids (QuorixASP #4187)
      agentId: process.env.AGENT_ID || '4187',
      // Source: registered A2A service #23685 feeAmount from asp-register-precheck.js
      a2aServiceFeeUsdt: process.env.A2A_SERVICE_FEE_USDT || '0.5',
      name: 'QuorixASP Broker',
      address: process.env.COMMUNICATION_ADDRESS || null,
      escrowContract: ENV.ESCROW_CONTRACT_ADDRESS,
      ratingContract: ENV.RATING_CONTRACT_ADDRESS,
      rpcUrl: ENV.X_LAYER_RPC_URL,
      chain: 'X Layer',
      chainId: 196,
      status: 'Online',
      mcpToolsLive: QUORIX_MCP_TOOL_META.filter((t) => t.status === 'live').length,
      mcpToolsTotal: QUORIX_MCP_TOOL_META.length,
      mcpManifest: '/api/mcp/manifest',
      mcpInvoke: '/api/mcp/invoke',
      okxIntegration: buildQuorixMcpManifest(
        process.env.PUBLIC_BASE_URL || `http://localhost:${ENV.PORT}`
      ).okxAi.integrationStatus,
    });
  });

  app.get('/api/health', (req: any, res: any) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.floor(process.uptime()),
      version: "1.0.0"
    });
  });

  app.get('/api/logs', (req: any, res: any) => {
    const adminToken = req.headers['x-admin-token'];
    const adminPassword = process.env.ADMIN_PASSWORD;
    const isAdmin = adminToken && adminToken === adminPassword;

    if (!isAdmin) {
      return res.status(401).json({ error: "Unauthorized: Valid admin token required" });
    }

    res.json({ logs: logBuffer });
  });

  // Admin login API endpoint
  app.post('/api/auth/admin-login', (req: any, res: any) => {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (password === adminPassword) {
      res.json({ ok: true, token: adminPassword });
    } else {
      res.status(401).json({ error: "Invalid admin password" });
    }
  });

  // Admin token verification endpoint
  app.post('/api/auth/admin-verify', (req: any, res: any) => {
    const { token } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (token === adminPassword) {
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: "Invalid token" });
    }
  });

  async function handleReputationLookup(address: string, res: any) {
    if (!address || !isValidWalletAddress(address)) {
      return res.status(400).json({ error: 'Invalid address format' });
    }
    try {
      const data = await repScorer.getAgentReputation(address, blockchainClient.publicClient);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  }

  app.get('/api/reputation', async (req: any, res: any) => {
    const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
    return handleReputationLookup(address, res);
  });

  app.post('/api/reputation', async (req: any, res: any) => {
    const address = req.body.address || req.body.agentAddress;
    return handleReputationLookup(address, res);
  });

  app.post('/api/negotiate', async (req: any, res: any) => {
    try {
      const { clientAddress, budgetWei, deadlineTimestamp, id, title, description, paymentToken, expectedProofHash } = req.body;
      const task = {
        id: id || crypto.randomUUID(),
        title: title || "A2A Task Proposal",
        description: description || "Task proposal submitted via QuorixASP console",
        clientAddress: clientAddress || "0x0000000000000000000000000000000000000000",
        budgetWei: budgetWei || "100000000000000000",
        deadlineTimestamp: Number(deadlineTimestamp) || Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
        paymentToken: paymentToken || "0x0000000000000000000000000000000000000000",
        expectedProofHash: expectedProofHash ? String(expectedProofHash) : undefined
      };
      
      const response = await negEngine.evaluateTaskProposal(task);
      res.json(response);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  type TaskFeedView = 'marketplace' | 'my';

  async function buildTaskFeed(options: { wallet?: string; view?: TaskFeedView } = {}) {
    const view: TaskFeedView = options.view === 'my' ? 'my' : 'marketplace';
    const wallet = view === 'my' ? options.wallet : undefined;
    const activeJobs = orchestrator.getActiveJobs();
    let cliSession: OkxCliSession | null = null;
    let discovered: Awaited<ReturnType<MarketplaceScanner['scanRecentTasks']>> = [];
    let scanError: string | null = null;
    let requiresVisitorAgent = false;
    let visitorAgentReady = false;

    try {
      if (view === 'marketplace') {
        marketplaceScanner.clearLastAuthError();
        cliSession = await resolveBrokerCliSession();
        if (!cliSession) {
          scanError = 'Broker wallet session unavailable — QuorixASP cannot query the OKX.AI marketplace.';
        }
      } else if (wallet) {
        cliSession = await resolveVisitorCliSession(wallet);
        visitorAgentReady = !!cliSession?.agentId;
        if (!cliSession) {
          requiresVisitorAgent = true;
          scanError =
            'No OKX.AI agent identity found for your wallet. Register a User or ASP agent on OKX.AI to view your personal tasks.';
        }
      } else {
        requiresVisitorAgent = true;
      }
    } catch (sessionErr: any) {
      scanError = sessionErr?.message || String(sessionErr);
      logErrorOnce('taskfeed-session', `[TaskFeed] CLI session resolution failed: ${scanError}`);
    }

    try {
      if (view === 'marketplace' || cliSession) {
        discovered = await marketplaceScanner.scanRecentTasks(
          {
            session: cliSession,
            limit: 40,
            minScore: 0,
            mode: 'search',
          },
          false
        );
      }
    } catch (scanErr: any) {
      scanError = scanErr?.message || String(scanErr);
      logErrorOnce('taskfeed-scan', `[TaskFeed] OKX CLI marketplace scan deferred: ${scanError}`);
    }

    const marketplaceTotal = marketplaceScanner.getCachedTotal() || discovered.length;
    let tasks: any[] = [];

    if (view === 'marketplace') {
      tasks = discovered.map((d) => ({ ...d, source: d.source }));
    } else {
      const activeIds = new Set(activeJobs.map((j: any) => String(j.id).toLowerCase()));
      tasks = [
        ...activeJobs.map((j: any) => ({ ...j, source: 'orchestrator' })),
        ...discovered
          .filter((d) => !activeIds.has(d.id.toLowerCase()))
          .map((d) => ({ ...d, source: d.source })),
      ];

      if (wallet) {
        const lowerWallet = wallet.toLowerCase();
        tasks = tasks.filter(
          (t: any) =>
            t.clientAddress?.toLowerCase() === lowerWallet ||
            String(t.agentId || t.providerAddress || '') === String(ENV.AGENT_ID) ||
            t.providerAddress?.toLowerCase() === lowerWallet ||
            (t.workerAddress && t.workerAddress.toLowerCase() === lowerWallet)
        );
      } else {
        tasks = [];
      }
    }

    let authError: string | undefined;
    if (view === 'marketplace') {
      authError =
        tasks.length === 0
          ? marketplaceScanner.getLastAuthError() || scanError || undefined
          : undefined;
    } else {
      authError = requiresVisitorAgent
        ? scanError || 'Register an OKX.AI agent identity (User or ASP) to view your personal tasks.'
        : marketplaceScanner.getLastAuthError() || scanError || undefined;
    }

    return {
      tasks,
      meta: {
        view,
        orchestratorCount: activeJobs.length,
        marketplaceTotal,
        globalOnChainCount: marketplaceTotal,
        onChainDiscovered: marketplaceTotal,
        mergedCount: tasks.length,
        marketplaceCacheFresh: marketplaceScanner.isCacheFresh(),
        onChainCacheFresh: marketplaceScanner.isCacheFresh(),
        marketplaceScanInProgress: marketplaceScanner.isScanInProgress(),
        onChainScanInProgress: marketplaceScanner.isScanInProgress(),
        feedSource: 'okx-cli-task-search',
        brokerPowered: view === 'marketplace',
        cliSessionReady: !!cliSession,
        authError,
        requiresVisitorAgent: view === 'my' ? requiresVisitorAgent : undefined,
        visitorAgentReady: view === 'my' ? visitorAgentReady : undefined,
        agentId: view === 'marketplace' ? cliSession?.agentId : cliSession?.agentId,
        brokerAgentId: view === 'marketplace' ? cliSession?.agentId : process.env.AGENT_ID || '4187',
      },
    };
  }

  app.get('/api/tasks', async (req: any, res: any) => {
    try {
      const viewParam = typeof req.query.view === 'string' ? req.query.view.trim().toLowerCase() : 'marketplace';
      const view: TaskFeedView = viewParam === 'my' ? 'my' : 'marketplace';
      const wallet =
        view === 'my' && typeof req.query.wallet === 'string'
          ? req.query.wallet.trim()
          : undefined;
      if (wallet && !isValidWalletAddress(wallet)) {
        return res.status(400).json({ error: 'Invalid wallet address format' });
      }
      const feed = await buildTaskFeed({ wallet, view });
      res.json(feed);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.get('/api/analytics', async (req: any, res: any) => {
    try {
      const wallet = typeof req.query.wallet === 'string' ? req.query.wallet.trim() : undefined;
      if (wallet && !isValidWalletAddress(wallet)) {
        return res.status(400).json({ error: 'Invalid wallet address format' });
      }

      const feed = await buildTaskFeed({ wallet, view: 'my' });
      const tasks = feed.tasks;
      const now = Math.floor(Date.now() / 1000);
      const dayBuckets: Record<string, number> = {};
      const statusCounts: Record<string, number> = {};

      let lockedVolumeWei = 0n;
      let completed = 0;
      let disputed = 0;

      for (const task of tasks) {
        const status = task.status || 'DISCOVERED';
        statusCounts[status] = (statusCounts[status] || 0) + 1;

        if (status === 'ESCROW_LOCKED' || status === 'EXECUTING') {
          lockedVolumeWei += BigInt(task.budgetWei || '0');
        }
        if (status === 'COMPLETED' || status === 'RESOLVED') completed++;
        if (status === 'DISPUTED') disputed++;

        const ts = Number(task.statusUpdatedAt || task.deadlineTimestamp || now);
        const dayKey = new Date(ts * 1000).toISOString().slice(0, 10);
        const budget = BigInt(task.budgetWei || '0');
        dayBuckets[dayKey] = (dayBuckets[dayKey] || 0) + Number(budget) / 1e18;
      }

      const last7Days: Array<{ date: string; volumeOkb: number }> = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        last7Days.push({ date: key, volumeOkb: Number((dayBuckets[key] || 0).toFixed(4)) });
      }

      const reviewed = completed + disputed;
      const successRate = reviewed > 0 ? Math.round((completed / reviewed) * 100) : 0;

      res.json({
        taskCount: tasks.length,
        lockedVolumeOkb: Number(lockedVolumeWei) / 1e18,
        successRate,
        statusBreakdown: statusCounts,
        volumeByDay: last7Days,
        sources: feed.meta,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.get('/api/mcp/manifest', (req: any, res: any) => {
    const base =
      process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get('host') || `localhost:${ENV.PORT}`}`;
    res.json(buildQuorixMcpManifest(base));
  });

  app.get('/api/mcp/health', (_req: any, res: any) => {
    res.json({
      ok: true,
      server: 'quorix-mcp-server',
      version: '1.1.0',
      toolsLive: QUORIX_MCP_TOOL_META.filter((t) => t.status === 'live').length,
      toolsTotal: QUORIX_MCP_TOOL_META.length,
      transports: ['stdio', 'http'],
    });
  });

  app.get('/api/mcp/tools', (req: any, res: any) => {
    const base =
      process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get('host') || `localhost:${ENV.PORT}`}`;
    const definitions = buildMcpToolDefinitions();
    const tools = QUORIX_MCP_TOOL_META.map((meta) => {
      const def = definitions.find((d) => d.name === meta.name);
      return {
        ...meta,
        description: def?.description || (meta as { summary?: string }).summary || '',
        inputSchema: def?.inputSchema || {},
        annotations: def?.annotations,
      };
    });
    res.json({
      server: 'quorix-mcp-server',
      version: '1.1.0',
      audience: 'ai-agents',
      description:
        'QuorixASP MCP tools for OKX.AI agent-to-agent commerce on X Layer. Callable by remote agents via HTTP or local agents via stdio.',
      transports: {
        stdio: { enabled: true },
        http: {
          invoke: `${base.replace(/\/$/, '')}/api/mcp/invoke`,
          manifest: `${base.replace(/\/$/, '')}/api/mcp/manifest`,
        },
      },
      invokeFormat: {
        method: 'POST',
        body: { tool: '<tool_name>', arguments: { /* tool-specific */ } },
        headers: { 'x-agent-address': '<optional caller wallet for rate limiting>' },
      },
      tools,
    });
  });

  app.get('/api/broker/logs', (req: any, res: any) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '80'), 10) || 80, 1), 300);
    res.json({ logs: logBuffer.slice(-limit) });
  });

  app.post('/api/mcp/invoke', async (req: any, res: any) => {
    try {
      const { tool, arguments: toolArgs } = req.body || {};
      if (!tool || typeof tool !== 'string') {
        return res.status(400).json({ error: 'Missing tool name' });
      }

      const callerId = String(
        req.headers['x-agent-address'] || req.body?.callerAddress || req.ip || 'http-client'
      ).toLowerCase();

      const result = await mcpServer.invokeTool(tool, toolArgs || {}, callerId);
      const raw = result.content?.[0]?.text || '';
      const parsed = parseLegacyPayload(raw) as {
        ok?: boolean;
        data?: unknown;
        error?: unknown;
      } | null;

      // Agent-friendly envelope (preferred for AI callers)
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
        return res.status(result.isError ? 422 : 200).json(parsed);
      }

      // Legacy shape for dashboard backward compatibility
      res.json({ tool, isError: result.isError, result: parsed, raw });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // Simple in-memory rate limiter mapped by caller (IP or wallet)
  const a2aRateLimitMap = new Map<string, { count: number; resetTime: number }>();
  function checkA2aRateLimit(req: any, res: any, next: any) {
    const rateLimitWindowMs = 60000; // 1 minute
    const maxRequests = 15;
    
    // Key by header x-agent-address, request body clientAddress, or request IP
    const rateLimitKey = String(
      req.headers['x-agent-address'] || 
      req.body.clientAddress || 
      req.ip || 
      "unknown-client"
    ).toLowerCase();
    
    const now = Date.now();
    const limit = a2aRateLimitMap.get(rateLimitKey);
    
    if (!limit) {
      a2aRateLimitMap.set(rateLimitKey, { count: 1, resetTime: now + rateLimitWindowMs });
      return next();
    }
    
    if (now > limit.resetTime) {
      limit.count = 1;
      limit.resetTime = now + rateLimitWindowMs;
      a2aRateLimitMap.set(rateLimitKey, limit);
      return next();
    }
    
    if (limit.count >= maxRequests) {
      console.warn(`[A2A] Rate limit triggered for client key: ${rateLimitKey}`);
      return res.status(429).json({ error: "Too Many Requests: Maximum 15 requests per minute allowed." });
    }
    
    limit.count++;
    a2aRateLimitMap.set(rateLimitKey, limit);
    return next();
  }

  // 1. Task Matchmaker (A2A)
  app.post('/a2a/match-task', checkA2aRateLimit, (req: any, res: any) => {
    const { capabilities, task } = req.body;
    
    if (task) {
      const match = matcher.matchTask(task);
      return res.json({
        isMatched: match.isMatched,
        score: Math.round(match.score * 100),
        matchedCapabilities: match.matchedCapabilities
      });
    }

    const activeJobs = orchestrator.getActiveJobs();
    const ranked = activeJobs.map(job => {
      const match = matcher.matchTask({
        id: job.id,
        title: job.title,
        description: job.description,
        clientAddress: job.clientAddress,
        budgetWei: job.budgetWei,
        deadlineTimestamp: job.deadlineTimestamp
      });
      return {
        ...job,
        score: Math.round(match.score * 100)
      };
    }).sort((a, b) => b.score - a.score);

    res.json({ matches: ranked });
  });

  // 2. SLA Negotiator (A2A)
  app.post('/a2a/negotiate', checkA2aRateLimit, async (req: any, res: any) => {
    try {
      const { clientAddress, budgetWei, deadlineTimestamp, id, title, description, paymentToken, expectedProofHash } = req.body;
      const task = {
        id: id || crypto.randomUUID(),
        title: title || "A2A Task Proposal",
        description: description || "Task proposal submitted via QuorixASP console",
        clientAddress: clientAddress || "0x0000000000000000000000000000000000000000",
        budgetWei: budgetWei || "100000000000000000",
        deadlineTimestamp: Number(deadlineTimestamp) || Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
        paymentToken: paymentToken || "0x0000000000000000000000000000000000000000",
        expectedProofHash: expectedProofHash ? String(expectedProofHash) : undefined
      };

      const response = await negEngine.evaluateTaskProposal(task);
      
      // Log request & response securely to gated logBuffer (visible only via admin console)
      console.log(`[Admin] [Negotiation] A2A Proposal from ${task.clientAddress} for Task ${task.id}. Status: ${response.status}. Reason: ${response.reason || 'N/A'}`);
      
      res.json(response);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // 3. Escrow Monitor (A2A/API)
  app.get('/api/escrows/needs-attention', (req: any, res: any) => {
    const wallet = typeof req.query.wallet === 'string' ? req.query.wallet.trim() : '';
    if (!wallet || !isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: 'Valid wallet parameter required' });
    }

    const activeJobs = orchestrator.getActiveJobs();
    const thresholdSec = Number(req.query.threshold || process.env.STUCK_ESCROW_THRESHOLD_SECONDS || 172800); // 48h default
    const now = Math.floor(Date.now() / 1000);

    const flagged = [];
    for (const job of activeJobs) {
      // Must be scoped strictly to the requesting user's own session
      if (job.clientAddress.toLowerCase() !== wallet.toLowerCase()) {
        continue;
      }

      const nonTerminal = ['DISCOVERED', 'NEGOTIATING', 'WAITING_ESCROW', 'ESCROW_LOCKED', 'EXECUTING', 'DISPUTED'];
      if (nonTerminal.includes(job.status)) {
        const updatedAt = job.statusUpdatedAt || now;
        const timeInState = now - updatedAt;
        
        if (timeInState >= thresholdSec) {
          flagged.push({
            id: job.id,
            title: job.title,
            status: job.status,
            timeInStateSeconds: timeInState,
            reason: `Escrow has been sitting in state ${job.status} for ${Math.round(timeInState / 60)} minutes without transition.`
          });
        }
      }
    }

    res.json({ escrows: flagged });
  });

  app.post('/api/tasks', async (req: any, res: any) => {
    try {
      const { clientAddress, budgetWei, deadlineTimestamp, id, title, description, paymentToken, expectedProofHash } = req.body;

      if (!clientAddress || !isValidClientRef(clientAddress)) {
        return res.status(400).json({ error: 'Valid clientAddress (wallet or OKX agent ID) is required' });
      }
      if (!budgetWei || !/^\d+$/.test(String(budgetWei)) || BigInt(budgetWei) <= 0n) {
        return res.status(400).json({ error: 'Valid budgetWei (positive integer string) is required' });
      }
      const deadline = Number(deadlineTimestamp);
      if (!deadline || deadline <= Math.floor(Date.now() / 1000)) {
        return res.status(400).json({ error: 'deadlineTimestamp must be a future Unix timestamp' });
      }

      const task = {
        id: id || crypto.randomUUID(),
        title: title || 'A2A Task Agreement',
        description: description || 'Task filed via QuorixASP console',
        clientAddress,
        budgetWei: String(budgetWei),
        deadlineTimestamp: deadline,
        paymentToken: paymentToken || '0x0000000000000000000000000000000000000000',
        expectedProofHash: expectedProofHash ? String(expectedProofHash) : undefined,
      };
      
      // Handle the task request in the background
      orchestrator.handleTaskRequest(task).catch(err => {
        console.error(`[Orchestrator] Task handling error for ${task.id}:`, err);
      });
      
      res.json({ ok: true, task });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // ============================================
  // OFFICIAL ONCHAIN OS WALLET AUTHENTICATION ENDPOINTS
  // ============================================



  // Helper for cleaning CLI execution errors
  function checkCliError(error: any, stderr: any) {
    if (error && (error.code === 'ENOENT' || error.message.includes('not recognized') || error.message.includes('not found'))) {
      return "Onchain OS CLI ('onchainos') is not installed or not configured in your system PATH. Please ensure the official OKX Agentic Wallet tooling is installed globally.";
    }
    return stderr || error?.message || 'Unknown Onchain OS CLI error';
  }

  function parseCliJson(stdout: string): any | null {
    try {
      const trimmed = (stdout || '').trim();
      if (!trimmed) return null;
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function hasOnchainOsSession(homeDir: string): boolean {
    return ['session.json', 'wallets.json'].some((file) => fs.existsSync(path.join(homeDir, file)));
  }

  function execOnchainOsAsync(args: string[], homeDir: string): Promise<{ error: any; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execOnchainOs(args, homeDir, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
  }

  function getCliFailureMessage(error: any, stdout: string, stderr: string): string {
    const parsed = parseCliJson(stdout) || parseCliJson(stderr);
    if (parsed?.error) return String(parsed.error);
    if (parsed?.message) return String(parsed.message);
    return checkCliError(error, stderr || stdout);
  }

  function isConfirmingResponse(stdout: string, error: any): boolean {
    const parsed = parseCliJson(stdout);
    return Boolean(parsed?.confirming) || error?.code === 2;
  }

  function extractWalletAddress(output: string): string | null {
    const match = (output || '').match(/0x[a-fA-F0-9]{40}/i);
    return match ? match[0].toLowerCase() : null;
  }

  function readLoginCache(homeDir: string): { email: string; flowId: string } | null {
    const cachePath = path.join(homeDir, 'cache.json');
    if (!fs.existsSync(cachePath)) return null;
    const cache = parseCliJson(fs.readFileSync(cachePath, 'utf8'));
    const email = cache?.login?.email;
    const flowId = cache?.login?.flowId;
    if (typeof email !== 'string' || typeof flowId !== 'string' || !flowId.trim()) return null;
    return { email: email.trim().toLowerCase(), flowId: flowId.trim() };
  }

  function readLoginEmailFromCache(homeDir: string): string | null {
    return readLoginCache(homeDir)?.email || null;
  }

  function hasPendingOtpForEmail(homeDir: string, expectedEmail: string): boolean {
    const pending = readLoginCache(homeDir);
    return Boolean(pending && pending.email === expectedEmail && pending.flowId);
  }

  function respondWithPendingOtp(res: any, normalizedEmail: string, rateLimited = false) {
    return res.json({
      ok: true,
      pendingOtp: true,
      rateLimited,
      email: normalizedEmail,
      message: rateLimited
        ? `A verification code was already sent to ${normalizedEmail}. Check your inbox and spam folder, enter it below, and wait 2-3 minutes before requesting a new code.`
        : `A verification code is already pending for ${normalizedEmail}. Check your inbox and spam folder, then enter it below.`
    });
  }

  async function clearOnchainOsAuthState(homeDir: string) {
    await execOnchainOsAsync(['wallet', 'logout'], homeDir);
    for (const file of ['cache.json', 'session.json', 'wallets.json']) {
      const filePath = path.join(homeDir, file);
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
    }
  }

  async function runWalletLogin(homeDir: string, email: string, force = false) {
    const args = force ? ['wallet', 'login', email, '--force'] : ['wallet', 'login', email];
    console.log(`[Onchain OS] Executing: onchainos ${args.join(' ')}`);
    return execOnchainOsAsync(args, homeDir);
  }

  app.get('/api/auth/session-check', (req: any, res: any) => {
    const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const homeDir = getHomeDirForEmail(email);
    const cached = readLoginCache(homeDir);
    res.json({
      email,
      pendingOtp: Boolean(cached && cached.email === email && cached.flowId),
      cacheEmail: cached?.email || null,
      hasSession: hasOnchainOsSession(homeDir),
    });
  });

  // 1. Trigger Login Command: Sends OTP
  app.post('/api/auth/send-otp', async (req: any, res: any) => {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const homeDir = getHomeDirForEmail(normalizedEmail);
    console.log(`[Onchain OS] Resolved isolated HOME for ${normalizedEmail} -> ${homeDir}`);

    try {
      const cachedEmail = readLoginEmailFromCache(homeDir);
      if (cachedEmail && cachedEmail !== normalizedEmail) {
        console.warn(`[Onchain OS] Session email mismatch for ${normalizedEmail}: found cached ${cachedEmail}. Clearing stale auth state.`);
        await clearOnchainOsAuthState(homeDir);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      const statusResult = await execOnchainOsAsync(['wallet', 'status'], homeDir);
      const statusJson = parseCliJson(statusResult.stdout);
      const statusEmail = (statusJson?.data?.email || '').trim().toLowerCase();
      console.log(`[Onchain OS] Pre-login status for ${normalizedEmail}: loggedIn=${statusJson?.data?.loggedIn}, sessionEmail=${statusEmail || 'none'}`);

      if (statusJson?.ok && statusJson?.data?.loggedIn) {
        if (statusEmail && statusEmail !== normalizedEmail) {
          console.warn(`[Onchain OS] Logged-in session belongs to ${statusEmail}, not ${normalizedEmail}. Clearing and re-authenticating.`);
          await clearOnchainOsAuthState(homeDir);
          await new Promise((resolve) => setTimeout(resolve, 400));
        } else {
          const addressesResult = await execOnchainOsAsync(['wallet', 'addresses'], homeDir);
          const walletAddress = extractWalletAddress(addressesResult.stdout);
          if (walletAddress) {
            sessionRegistry.set(walletAddress, {
              email: normalizedEmail,
              walletAddress,
              homeDir,
              lastActive: Date.now()
            });
            return res.json({
              ok: true,
              alreadyLoggedIn: true,
              address: walletAddress,
              email: normalizedEmail,
              message: `Already authenticated as ${normalizedEmail}.`
            });
          }
        }
      }

      const lastAttemptAt = otpAttemptTracker.get(normalizedEmail) || 0;
      const withinCooldown = Date.now() - lastAttemptAt < otpCooldownMs;
      if (withinCooldown && hasPendingOtpForEmail(homeDir, normalizedEmail)) {
        console.log(`[Onchain OS] Reusing pending OTP flow for ${normalizedEmail} (cooldown active)`);
        return respondWithPendingOtp(res, normalizedEmail, true);
      }

      otpAttemptTracker.set(normalizedEmail, Date.now());
      let loginResult = await runWalletLogin(homeDir, normalizedEmail);

      if (isConfirmingResponse(loginResult.stdout, loginResult.error)) {
        console.log(`[Onchain OS] Account-switch confirmation for ${normalizedEmail}; clearing session before retry`);
        await clearOnchainOsAuthState(homeDir);
        await new Promise((resolve) => setTimeout(resolve, 400));
        loginResult = await runWalletLogin(homeDir, normalizedEmail);
        if (isConfirmingResponse(loginResult.stdout, loginResult.error)) {
          loginResult = await runWalletLogin(homeDir, normalizedEmail, true);
        }
      }

      let loginJson = parseCliJson(loginResult.stdout);
      if (loginResult.error || loginJson?.ok === false) {
        const errorMsg = getCliFailureMessage(loginResult.error, loginResult.stdout, loginResult.stderr);
        const shouldResetSession = /not logged in|session|expired|invalid|account you used last time/i.test(errorMsg);

        if (shouldResetSession && hasOnchainOsSession(homeDir)) {
          console.log(`[Onchain OS] Stale session detected for ${normalizedEmail}; clearing before OTP retry`);
          await clearOnchainOsAuthState(homeDir);
          await new Promise((resolve) => setTimeout(resolve, 400));
          loginResult = await runWalletLogin(homeDir, normalizedEmail);
          if (isConfirmingResponse(loginResult.stdout, loginResult.error)) {
            loginResult = await runWalletLogin(homeDir, normalizedEmail, true);
          }
          loginJson = parseCliJson(loginResult.stdout);
        }

        if (loginResult.error || loginJson?.ok === false) {
          const finalError = getCliFailureMessage(loginResult.error, loginResult.stdout, loginResult.stderr);
          console.error(`[Onchain OS] Login CLI command error for ${normalizedEmail}:`, finalError);
          const isRateLimit = /too frequent|rate limit/i.test(finalError);
          if (isRateLimit && hasPendingOtpForEmail(homeDir, normalizedEmail)) {
            console.log(`[Onchain OS] Rate-limited for ${normalizedEmail}, but pending OTP flow exists — allowing verify step`);
            return respondWithPendingOtp(res, normalizedEmail, true);
          }
          return res.status(isRateLimit ? 429 : 500).json({
            error: isRateLimit
              ? 'OTP requests are rate-limited. If you already received a code, enter it below. Otherwise wait 2-3 minutes and try again.'
              : finalError
          });
        }
      }

      const otpTargetEmail = readLoginEmailFromCache(homeDir);
      if (!otpTargetEmail || otpTargetEmail !== normalizedEmail) {
        console.error(`[Onchain OS] OTP target mismatch for ${normalizedEmail}. Cache email=${otpTargetEmail || 'missing'}`);
        return res.status(500).json({
          error: `Failed to bind OTP flow to ${normalizedEmail}. Please try again in a few minutes.`
        });
      }

      console.log(`[Onchain OS] OTP dispatch verified for ${normalizedEmail} (cache email=${otpTargetEmail})`);
      return res.json({
        ok: true,
        otpSent: true,
        email: normalizedEmail,
        message: `Verification code sent to ${normalizedEmail}. Check your inbox and spam folder.`
      });
    } catch (err: any) {
      console.error(`[Onchain OS] send-otp failure for ${normalizedEmail}:`, err);
      return res.status(500).json({ error: err.message || String(err) });
    }
  });

  // 2. Verify Command: Submits Code & Returns status info
  app.post('/api/auth/verify-otp', (req: any, res: any) => {
    const { email, code } = req.body;
    console.log(`[Trace] /api/auth/verify-otp called with email: "${email}", code: "${code}"`);
    if (!email || !code) {
      return res.status(400).json({ error: "Email and code are required" });
    }
    
    const normalizedEmail = email.trim().toLowerCase();
    const homeDir = getHomeDirForEmail(normalizedEmail);
    console.log(`[Onchain OS] Resolved isolated HOME for ${normalizedEmail} -> ${homeDir}`);

    const cachedEmail = readLoginEmailFromCache(homeDir);
    if (!cachedEmail || cachedEmail !== normalizedEmail) {
      console.error(`[Onchain OS] verify-otp rejected for ${normalizedEmail}: cache email=${cachedEmail || 'missing'}`);
      return res.status(400).json({
        error: `No pending verification code for ${normalizedEmail}. Please request a new code for this email.`
      });
    }
    
    const verifyArgs = ['wallet', 'verify', code];
    console.log(`[Onchain OS] Executing: onchainos ${verifyArgs.join(' ')}`);
    
    execOnchainOs(verifyArgs, homeDir, (error: any, stdout: any, stderr: any) => {
      console.log(`[Trace] wallet verify command finished. error: ${error ? error.message : 'null'}`);
      console.log(`[Trace] stdout: "${(stdout || '').trim()}"`);
      console.log(`[Trace] stderr: "${(stderr || '').trim()}"`);
      if (error) {
        // Handle confirming on verification step just in case
        let isConfirming = false;
        try {
          const parsed = JSON.parse((stdout || '').trim());
          if (parsed && parsed.confirming) {
            isConfirming = true;
          }
        } catch (e) {}

        if (isConfirming) {
          const forceVerifyArgs = ['wallet', 'verify', code, '--force'];
          console.log(`[Onchain OS] Confirming verification switch: re-executing with --force: onchainos ${forceVerifyArgs.join(' ')}`);
          execOnchainOs(forceVerifyArgs, homeDir, (forceErr: any, forceStdout: any, forceStderr: any) => {
            console.log(`[Trace] wallet verify --force finished. error: ${forceErr ? forceErr.message : 'null'}`);
            console.log(`[Trace] stdout: "${(forceStdout || '').trim()}"`);
            console.log(`[Trace] stderr: "${(forceStderr || '').trim()}"`);
            if (forceErr) {
              const errorMsg = checkCliError(forceErr, forceStderr || forceStdout);
              return res.status(400).json({ error: errorMsg });
            }
            // Proceed to fetch addresses
            fetchAddresses();
          });
          return;
        }

        const errorMsg = checkCliError(error, stderr || stdout);
        console.error(`[Onchain OS] Verification CLI command error:`, errorMsg);
        return res.status(400).json({ error: errorMsg });
      }
      
      fetchAddresses();

      function fetchAddresses(retryCount = 1) {
        const addressesArgs = ['wallet', 'addresses'];
        console.log(`[Onchain OS] Executing addresses check (Attempt ${retryCount}): onchainos ${addressesArgs.join(' ')}`);
        
        execOnchainOs(addressesArgs, homeDir, (sErr: any, sStdout: any, sStderr: any) => {
          console.log(`[Trace] Attempt ${retryCount} wallet addresses finished. error: ${sErr ? sErr.message : 'null'}`);
          console.log(`[Trace] stdout: "${(sStdout || '').trim()}"`);
          console.log(`[Trace] stderr: "${(sStderr || '').trim()}"`);
          if (sErr) {
            if (retryCount < 3) {
              console.log(`[Onchain OS] Addresses check failed or pending file write. Retrying in 200ms...`);
              setTimeout(() => fetchAddresses(retryCount + 1), 200);
              return;
            }
            const errorMsg = checkCliError(sErr, sStderr || sStdout);
            console.error(`[Onchain OS] Addresses CLI command error after retries:`, errorMsg);
            return res.status(500).json({ error: "Failed to fetch wallet addresses: " + errorMsg });
          }
          
          const match = sStdout.match(/0x[a-fA-F0-9]{40}/i);
          if (!match) {
            if (retryCount < 3) {
              console.log(`[Onchain OS] Wallet address not found in stdout. Retrying in 200ms...`);
              setTimeout(() => fetchAddresses(retryCount + 1), 200);
              return;
            }
            return res.status(500).json({ error: "Failed to retrieve authenticated address from wallet addresses" });
          }
          
          const walletAddress = match[0].toLowerCase();
          console.log(`[Onchain OS] Wallet authenticated successfully. Address: ${walletAddress} (Took ${retryCount} addresses check attempt(s))`);
          
          // Register the session in the registry
          sessionRegistry.set(walletAddress, {
            email: normalizedEmail,
            walletAddress,
            homeDir,
            lastActive: Date.now()
          });
          
          res.json({ ok: true, address: walletAddress, details: sStdout.trim() });
        });
      }
    });
  });

  function checkStatusWithRetry(session: any, wallet: string, res: any, isMeEndpoint: boolean, retryCount = 1) {
    const addressesArgs = ['wallet', 'addresses'];
    console.log(`[Onchain OS] Executing addresses check (Attempt ${retryCount}) for wallet ${wallet}`);
    execOnchainOs(addressesArgs, session.homeDir, (error: any, stdout: any, stderr: any) => {
      console.log(`[Trace] Attempt ${retryCount} checkStatus addresses finished. error: ${error ? error.message : 'null'}`);
      console.log(`[Trace] stdout: "${(stdout || '').trim()}"`);
      console.log(`[Trace] stderr: "${(stderr || '').trim()}"`);
      if (error) {
        if (retryCount < 3) {
          console.log(`[Onchain OS] Status addresses check failed. Retrying in 200ms...`);
          setTimeout(() => checkStatusWithRetry(session, wallet, res, isMeEndpoint, retryCount + 1), 200);
          return;
        }
        if (isMeEndpoint) {
          return res.status(500).json({ error: checkCliError(error, stderr) });
        } else {
          return res.json({ loggedIn: false, error: checkCliError(error, stderr) });
        }
      }
      
      const match = stdout.match(/0x[a-fA-F0-9]{40}/i);
      console.log(`[Trace] status check regex match: ${match ? match[0] : 'null'}`);
      if (match && match[0].toLowerCase() === wallet.toLowerCase()) {
        res.json({ loggedIn: true, address: match[0], details: stdout.trim() });
      } else {
        if (retryCount < 3) {
          console.log(`[Onchain OS] Address mismatch or not found in stdout. Retrying in 200ms...`);
          setTimeout(() => checkStatusWithRetry(session, wallet, res, isMeEndpoint, retryCount + 1), 200);
          return;
        }
        if (isMeEndpoint) {
          res.status(401).json({ error: "Not logged in" });
        } else {
          res.json({ loggedIn: false });
        }
      }
    });
  }

  // 3. Status Command: Checks current active TEE session
  app.get('/api/auth/status', (req: any, res: any) => {
    const wallet = req.query.wallet;
    console.log(`[Trace] /api/auth/status called for wallet: "${wallet}"`);
    if (!wallet) {
      return res.json({ loggedIn: false, error: "Wallet query parameter required" });
    }
    const session = getSessionForWallet(wallet);
    console.log(`[Trace] getSessionForWallet returned session exists: ${!!session}`);
    if (!session) {
      return res.json({ loggedIn: false });
    }
    
    checkStatusWithRetry(session, wallet, res, false);
  });

  // 4b. Visitor agent identity — used by dashboard before personal actions (My Tasks, Negotiate)
  app.get('/api/auth/agent-identity', async (req: any, res: any) => {
    const wallet = typeof req.query.wallet === 'string' ? req.query.wallet.trim() : '';
    if (!wallet || !isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: 'Valid wallet query parameter required' });
    }
    const session = await resolveVisitorCliSession(wallet);
    res.json({
      hasAgentIdentity: !!session?.agentId,
      agentId: session?.agentId ?? null,
      loggedIn: !!getSessionForWallet(wallet),
    });
  });

  // 4. Me Command: Retrieves active logged-in wallet details
  app.get('/api/auth/me', (req: any, res: any) => {
    const wallet = req.query.wallet;
    console.log(`[Trace] /api/auth/me called for wallet: "${wallet}"`);
    if (!wallet) {
      return res.status(400).json({ error: "Wallet query parameter required" });
    }
    const session = getSessionForWallet(wallet);
    console.log(`[Trace] getSessionForWallet returned session exists: ${!!session}`);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized: No valid session found for this wallet address" });
    }
    
    checkStatusWithRetry(session, wallet, res, true);
  });

  // 5. Logout Command: Clears active TEE session credentials
  app.post('/api/auth/logout', (req: any, res: any) => {
    const { wallet } = req.body;
    if (!wallet) {
      return res.status(400).json({ error: "Wallet address required" });
    }
    const session = getSessionForWallet(wallet);
    if (!session) {
      return res.json({ ok: true }); // Already logged out or no session
    }
    
    const logoutArgs = ['wallet', 'logout'];
    console.log(`[Onchain OS] Executing logout for wallet ${wallet}`);
    execOnchainOs(logoutArgs, session.homeDir, (error: any, stdout: any, stderr: any) => {
      // Clear from session registry
      sessionRegistry.delete(wallet.toLowerCase());
      // Delete their session home directory to clean up
      try {
        fs.rmSync(session.homeDir, { recursive: true, force: true });
        console.log(`[Onchain OS] Cleaned up session directory: ${session.homeDir}`);
      } catch (e) {}
      
      if (error) {
        return res.status(500).json({ error: checkCliError(error, stderr) });
      }
      res.json({ ok: true, message: stdout.trim() });
    });
  });

  // Scheduled session/temp folder cleanup job (runs every hour)
  setInterval(() => {
    console.log(`[Onchain OS] Running scheduled session cleanup job...`);
    const rootDir = path.join(os.tmpdir(), 'okx-cli-sessions');
    if (!fs.existsSync(rootDir)) return;
    
    try {
      const dirs = fs.readdirSync(rootDir);
      const now = Date.now();
      const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
      
      for (const dir of dirs) {
        if (dir === 'broker') continue;
        const homeDir = path.join(rootDir, dir);
        const stats = fs.statSync(homeDir);
        if (now - stats.mtimeMs > maxAgeMs) {
          // Find if there is any session registered in our map
          for (const [wallet, record] of sessionRegistry.entries()) {
            if (record.homeDir === homeDir) {
              sessionRegistry.delete(wallet);
            }
          }
          fs.rmSync(homeDir, { recursive: true, force: true });
          console.log(`[Onchain OS] Cleaned up stale session folder: ${homeDir}`);
        }
      }
    } catch (e) {
      console.error(`[Onchain OS] Error during scheduled cleanup:`, e);
    }
  }, 60 * 60 * 1000); // 1 hour

  // Scan isolated session directories at startup to restore active mappings
  scanSessions();

  app.listen(ENV.PORT, () => {
    console.log(`[Daemon] QuorixASP ready at http://localhost:${ENV.PORT}`);
    console.log(`[Daemon] Dashboard: http://localhost:${ENV.PORT}/dashboard`);
  });

  // Start polling sweeps...
  console.log(`[Daemon] Marketplace poll interval: ${ENV.POLL_INTERVAL_MS}ms`);
  setInterval(async () => {
    if (marketplaceScanner.isCacheFresh() || marketplaceScanner.isScanInProgress()) {
      return;
    }
    if (marketplaceScanner.isInFailureCooldown()) {
      return;
    }
    try {
      const brokerHome = process.env.ONCHAINOS_HOME;
      const cliSession = brokerHome ? await marketplaceScanner.resolveSession(brokerHome) : null;
      if (!cliSession) {
        logErrorOnce(
          'marketplace-poll-no-session',
          '[Marketplace] Polling sweep skipped: broker session has no agent identity (register via onchainos agent create).'
        );
        return;
      }
      const discovered = await marketplaceScanner.scanRecentTasks(
        { session: cliSession, limit: 20, minScore: 25, mode: 'search' },
        true
      );
      console.log(
        `[Marketplace] OKX CLI task-search complete: ${discovered.length} tasks (total pool hint: ${marketplaceScanner.getCachedTotal()})`
      );
      for (const task of discovered.slice(0, 3)) {
        const client = task.clientAddress ? task.clientAddress.slice(0, 10) : 'n/a';
        console.log(`[Marketplace]  · ${task.id} score=${task.score}% title=${task.title.slice(0, 40)} client=${client}`);
      }
    } catch (err: any) {
      logErrorOnce('marketplace-poll-sweep', `[Marketplace] Polling sweep skipped: ${err?.message || shortenRpcError(err)}`);
    }
  }, ENV.POLL_INTERVAL_MS);

  process.on('SIGINT', () => {
    console.log('\n[Daemon] Gracefully shutting down QuorixASP daemon...');
    process.exit(0);
  });
}

main().catch(err => {
  console.error("[Daemon] Critical startup failure:", err);
  process.exit(1);
});
