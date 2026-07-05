import {
  encodeFunctionData,
  PublicClient,
  parseAbiItem,
} from 'viem';
import { createXLayerPublicClient, getXLayerRpcUrls } from '../blockchain/rpcTransport';
import { execFile } from 'child_process';
import { ENV } from '../config/env';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * REFERENCE / HACKATHON TaskManager on X Layer (USDC escrow).
 * Demonstrates on-chain createTask/approve mechanics — NOT the live okx.ai/tasks publish path.
 * Production publishing: `onchainos agent create-task` → OKX aieco backend.
 */
export const TASK_MANAGER_ABI = [
  {
    inputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'string', name: 'description', type: 'string' },
      { internalType: 'uint256', name: 'payment', type: 'uint256' },
    ],
    name: 'createTask',
    outputs: [{ internalType: 'uint256', name: 'taskId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'taskId', type: 'uint256' }],
    name: 'acceptTask',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'taskId', type: 'uint256' },
      { internalType: 'string', name: 'resultHash', type: 'string' },
    ],
    name: 'completeTask',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'taskId', type: 'uint256' }],
    name: 'approveTask',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'taskId', type: 'uint256' }],
    name: 'disputeTask',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'taskId', type: 'uint256' }],
    name: 'getTask',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'client', type: 'address' },
          { internalType: 'uint256', name: 'agentId', type: 'uint256' },
          { internalType: 'string', name: 'description', type: 'string' },
          { internalType: 'uint256', name: 'payment', type: 'uint256' },
          { internalType: 'string', name: 'resultHash', type: 'string' },
          { internalType: 'uint8', name: 'state', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'uint256', name: 'acceptedAt', type: 'uint256' },
          { internalType: 'uint256', name: 'completedAt', type: 'uint256' },
          { internalType: 'uint256', name: 'disputedAt', type: 'uint256' },
        ],
        internalType: 'struct TaskManager.Task',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getTaskCount',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'client', type: 'address' }],
    name: 'getTasksByClient',
    outputs: [{ internalType: 'uint256[]', name: '', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getMarketStats',
    outputs: [
      { internalType: 'uint256', name: 'totalTasks', type: 'uint256' },
      { internalType: 'uint256', name: 'approvedTasks', type: 'uint256' },
      { internalType: 'uint256', name: 'volume', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'USDC_TOKEN',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const ERC20_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'spender', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'address', name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// OKX.AI native X402Rating contract ABI definition
export const RATING_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'ratee', type: 'address' },
      { internalType: 'uint8', name: 'rating', type: 'uint8' },
      { internalType: 'string', name: 'comment', type: 'string' },
    ],
    name: 'rateAgent',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

/** TaskManager.TaskState enum — Created=0 … Cancelled=6 */
export const TASK_STATE_LABELS = [
  'created',
  'in_progress',
  'completed',
  'approved',
  'disputed',
  'resolved',
  'cancelled',
] as const;

export interface EscrowDetails {
  taskId: string;
  client: string;
  agentId: bigint;
  description: string;
  payment: bigint;
  resultHash: string;
  status: number;
  createdAt: bigint;
  acceptedAt: bigint;
  completedAt: bigint;
  disputedAt: bigint;
}

export class XLayerClient {
  public publicClient: PublicClient;

  constructor() {
    const rpcUrls = getXLayerRpcUrls();
    console.log(
      `[XLayerClient] Connecting to X Layer RPC (${rpcUrls.length} endpoint${rpcUrls.length === 1 ? '' : 's'}): ${rpcUrls.join(', ')}`
    );
    this.publicClient = createXLayerPublicClient();
  }

  /** Parse on-chain uint256 task ID from decimal string (rejects bytes32 hex). */
  public parseTaskId(taskId: string): bigint {
    const trimmed = taskId.trim();
    if (trimmed.startsWith('0x')) {
      throw new Error(
        `[XLayerClient] Task IDs are uint256 decimals on TaskManager, not bytes32 hex. Got: ${trimmed.slice(0, 18)}...`
      );
    }
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`[XLayerClient] Invalid task ID — expected non-negative decimal uint256. Got: ${taskId}`);
    }
    return BigInt(trimmed);
  }

  /** @deprecated Legacy broker UUID → bytes32 helper; not used by official TaskManager. */
  public getBytes32TaskId(taskId: string): `0x${string}` {
    let cleanId = taskId.replace(/-/g, '');
    if (cleanId.startsWith('0x')) {
      cleanId = cleanId.slice(2);
    }
    const hex = '0x' + cleanId.padEnd(64, '0').slice(0, 64);
    return hex as `0x${string}`;
  }

  public async getTaskCount(): Promise<bigint> {
    return this.publicClient.readContract({
      address: ENV.ESCROW_CONTRACT_ADDRESS as `0x${string}`,
      abi: TASK_MANAGER_ABI,
      functionName: 'getTaskCount',
    });
  }

  public async getEscrowDetails(taskId: string): Promise<EscrowDetails> {
    try {
      const id = this.parseTaskId(taskId);
      const details = await this.publicClient.readContract({
        address: ENV.ESCROW_CONTRACT_ADDRESS as `0x${string}`,
        abi: TASK_MANAGER_ABI,
        functionName: 'getTask',
        args: [id],
      });

      return {
        taskId: id.toString(),
        client: details.client,
        agentId: details.agentId,
        description: details.description,
        payment: details.payment,
        resultHash: details.resultHash,
        status: details.state,
        createdAt: details.createdAt,
        acceptedAt: details.acceptedAt,
        completedAt: details.completedAt,
        disputedAt: details.disputedAt,
      };
    } catch (err: any) {
      const isRevert =
        err.message &&
        (err.message.toLowerCase().includes('execution reverted') ||
          err.message.toLowerCase().includes('reverted') ||
          err.message.toLowerCase().includes('task does not exist'));
      if (isRevert) {
        return {
          taskId: taskId,
          client: '0x' + '0'.repeat(40),
          agentId: 0n,
          description: '',
          payment: 0n,
          resultHash: '',
          status: -1,
          createdAt: 0n,
          acceptedAt: 0n,
          completedAt: 0n,
          disputedAt: 0n,
        };
      }
      console.error(`[XLayerClient] Critical RPC query failure for getEscrowDetails:`, err);
      throw err;
    }
  }

  /** Find a client's on-chain task by agentId and optional payment match. */
  public async findClientEscrowTask(
    clientAddress: string,
    agentId: bigint,
    expectedPayment?: bigint
  ): Promise<EscrowDetails | null> {
    const taskIds = await this.publicClient.readContract({
      address: ENV.ESCROW_CONTRACT_ADDRESS as `0x${string}`,
      abi: TASK_MANAGER_ABI,
      functionName: 'getTasksByClient',
      args: [clientAddress as `0x${string}`],
    });

    for (let i = taskIds.length - 1; i >= 0; i--) {
      const details = await this.getEscrowDetails(taskIds[i].toString());
      if (details.status < 0) continue;
      if (details.agentId !== agentId) continue;
      if (expectedPayment !== undefined && details.payment !== expectedPayment) continue;
      return details;
    }
    return null;
  }

  private async executeOnchainOSCall(
    targetContract: string,
    calldata: string,
    valueWei: bigint = 0n,
    functionName?: string,
    attempt = 1
  ): Promise<string> {
    if (!/^0x[a-fA-F0-9]{40}$/.test(targetContract)) {
      throw new Error(`[Security] Invalid contract address parameter: ${targetContract}`);
    }
    if (!/^0x[a-fA-F0-9]*$/.test(calldata)) {
      throw new Error(`[Security] Invalid calldata parameter payload.`);
    }

    const userProfile = process.env.USERPROFILE || process.env.HOME;
    if (!userProfile) {
      throw new Error(
        'Critical Startup Error: Neither USERPROFILE nor HOME environment variables are defined. Active user profile directory path is required.'
      );
    }
    const binName = process.platform === 'win32' ? 'onchainos.exe' : 'onchainos';
    const binPath = path.join(userProfile, '.local', 'bin', binName);

    const args = ['wallet', 'contract-call', '--to', targetContract, '--chain', 'xlayer', '--input-data', calldata];
    if (valueWei > 0n) {
      args.push('--amt', valueWei.toString());
    }

    console.log(
      `[XLayerClient] [Onchain OS] [Attempt ${attempt}/3] Spawning CLI binary via execFile: ${binName} ${args.join(' ')}`
    );

    const runCli = () =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
        const localBinDir = path.join(userProfile, '.local', 'bin');
        let env: NodeJS.ProcessEnv = {
          ...process.env,
          [pathKey]: `${localBinDir};${process.env[pathKey] || ''}`,
        };

        // Broker daemon sets ONCHAINOS_HOME to an isolated session dir; scripts omit it to use the default login.
        if (process.env.ONCHAINOS_HOME) {
          const brokerHome = process.env.ONCHAINOS_HOME;
          const driveMatch = brokerHome.match(/^([a-zA-Z]:)(.*)$/);
          const homeDrive = driveMatch ? driveMatch[1] : 'C:';
          const homePath = driveMatch ? driveMatch[2] : brokerHome;
          const isolatedAppData = path.join(brokerHome, 'AppData', 'Roaming');
          const isolatedLocalAppData = path.join(brokerHome, 'AppData', 'Local');
          fs.mkdirSync(isolatedAppData, { recursive: true });
          fs.mkdirSync(isolatedLocalAppData, { recursive: true });
          env = {
            ...env,
            HOME: brokerHome,
            USERPROFILE: brokerHome,
            HOMEDRIVE: homeDrive,
            HOMEPATH: homePath,
            APPDATA: isolatedAppData,
            LOCALAPPDATA: isolatedLocalAppData,
            ONCHAINOS_HOME: brokerHome,
          };
        }
        delete env.REAL_USERPROFILE;

        execFile(binPath, args, { env, timeout: 30000 }, (error, stdout, stderr) => {
          if (error) {
            reject(error);
          } else {
            resolve({ stdout, stderr });
          }
        });
      });

    try {
      const { stdout, stderr } = await runCli();

      if (stderr && (stderr.includes('Error') || stderr.includes('failed'))) {
        throw new Error(`Onchain OS CLI reported stderr error: ${stderr}`);
      }

      const txHashMatch = stdout.match(/0x[a-fA-F0-9]{64}/);
      if (txHashMatch) {
        console.log(`[XLayerClient] Transaction successful. TxHash: ${txHashMatch[0]}`);
        return txHashMatch[0];
      }

      if (stdout.trim().length > 0) {
        return stdout.trim();
      }

      throw new Error('CLI transaction executed successfully but returned empty output.');
    } catch (err: any) {
      console.error(`[XLayerClient] Onchain OS call failed on attempt ${attempt}:`, err.message || err);

      if (attempt < 3) {
        const delay = 3000 * Math.pow(2, attempt - 1);
        console.log(`[XLayerClient] Waiting ${delay}ms before next retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.executeOnchainOSCall(targetContract, calldata, valueWei, functionName, attempt + 1);
      }

      throw new Error(`Onchain OS contract-call failed after 3 attempts: ${err.message || String(err)}`);
    }
  }

  /**
   * Ensures USDC allowance for TaskManager before createTask (transferFrom).
   * Returns tx hash if approve was sent, or "already_approved" if sufficient.
   */
  public async ensureUsdcAllowance(paymentUsdc: bigint): Promise<string> {
    const usdcAddress = ENV.USDC_TOKEN_ADDRESS as `0x${string}`;
    const spender = ENV.ESCROW_CONTRACT_ADDRESS as `0x${string}`;

    let walletAddress: `0x${string}` | null = null;
    try {
      walletAddress = await this.getWalletAddress();
    } catch {
      console.warn('[XLayerClient] Could not read wallet address for allowance check — will attempt approve anyway.');
    }

    if (walletAddress) {
      const allowance = await this.publicClient.readContract({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [walletAddress, spender],
      });
      if (allowance >= paymentUsdc) {
        console.log(
          `[XLayerClient] USDC allowance sufficient (${allowance.toString()} >= ${paymentUsdc.toString()}). Skipping approve.`
        );
        return 'already_approved';
      }
    }

    const approveCalldata = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, paymentUsdc],
    });

    console.log(`[XLayerClient] Approving USDC ${paymentUsdc.toString()} for TaskManager ${spender}...`);
    return this.executeOnchainOSCall(usdcAddress, approveCalldata, 0n, 'approve');
  }

  /**
   * Client locks USDC escrow via official createTask(agentId, description, payment).
   * Requires prior ERC-20 approve() — call ensureUsdcAllowance first (done automatically).
   */
  public async createTaskOnChain(
    agentId: bigint,
    description: string,
    paymentUsdc: bigint,
    skipApprove = false
  ): Promise<{ txHash: string; approveTx?: string }> {
    const countBefore = await this.getTaskCount();

    let approveTx: string | undefined;
    if (!skipApprove) {
      approveTx = await this.ensureUsdcAllowance(paymentUsdc);
    }

    const calldata = encodeFunctionData({
      abi: TASK_MANAGER_ABI,
      functionName: 'createTask',
      args: [agentId, description, paymentUsdc],
    });

    const txHash = await this.executeOnchainOSCall(
      ENV.ESCROW_CONTRACT_ADDRESS,
      calldata,
      0n,
      'createTask'
    );

    const countAfter = await this.getTaskCount();
    if (countAfter <= countBefore && txHash !== '0xconfirmed_onchain_idempotent') {
      console.warn(
        `[XLayerClient] createTask tx submitted but getTaskCount unchanged (${countBefore} → ${countAfter}). Tx may still be pending.`
      );
    } else {
      console.log(`[XLayerClient] createTask confirmed: getTaskCount ${countBefore} → ${countAfter}`);
    }

    return { txHash, approveTx };
  }

  /** @deprecated Use createTaskOnChain — kept as alias for backward compatibility. */
  public async lockEscrow(_taskId: string, agentIdOrProvider: string, paymentUsdc: string): Promise<string> {
    const result = await this.createTaskOnChain(
      BigInt(agentIdOrProvider),
      `QuorixASP escrow lock (legacy lockEscrow call)`,
      BigInt(paymentUsdc)
    );
    return result.txHash;
  }

  /** Agent marks task complete with result hash. */
  public async completeTaskOnChain(taskId: string, resultHash: string): Promise<string> {
    const id = this.parseTaskId(taskId);
    const calldata = encodeFunctionData({
      abi: TASK_MANAGER_ABI,
      functionName: 'completeTask',
      args: [id, resultHash],
    });
    return this.executeOnchainOSCall(ENV.ESCROW_CONTRACT_ADDRESS, calldata, 0n, 'completeTask');
  }

  /** Client approves completed work and releases USDC to agent registry accounting. */
  public async releaseEscrow(taskId: string): Promise<string> {
    const id = this.parseTaskId(taskId);
    const calldata = encodeFunctionData({
      abi: TASK_MANAGER_ABI,
      functionName: 'approveTask',
      args: [id],
    });
    return this.executeOnchainOSCall(ENV.ESCROW_CONTRACT_ADDRESS, calldata, 0n, 'approveTask');
  }

  /** Client files a dispute on a completed task (no native-token bounty). */
  public async fileDispute(taskId: string): Promise<string> {
    const id = this.parseTaskId(taskId);
    const calldata = encodeFunctionData({
      abi: TASK_MANAGER_ABI,
      functionName: 'disputeTask',
      args: [id],
    });
    return this.executeOnchainOSCall(ENV.ESCROW_CONTRACT_ADDRESS, calldata, 0n, 'disputeTask');
  }

  public async submitRating(ratee: string, rating: number, comment: string): Promise<string> {
    const calldata = encodeFunctionData({
      abi: RATING_ABI,
      functionName: 'rateAgent',
      args: [ratee as `0x${string}`, rating, comment],
    } as any);

    return this.executeOnchainOSCall(ENV.RATING_CONTRACT_ADDRESS, calldata, 0n, 'rateAgent');
  }

  /** Returns the active onchainos wallet address on X Layer (chainIndex 196). */
  public async getWalletAddress(): Promise<`0x${string}`> {
    const userProfile = process.env.USERPROFILE || process.env.HOME || '';
    const binName = process.platform === 'win32' ? 'onchainos.exe' : 'onchainos';
    const binPath = path.join(userProfile, '.local', 'bin', binName);

    const addrOut = await new Promise<string>((resolve, reject) => {
      execFile(binPath, ['wallet', 'addresses'], { timeout: 15000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });

    try {
      const parsed = JSON.parse(addrOut);
      const xlayer = parsed?.data?.xlayer;
      if (Array.isArray(xlayer) && xlayer[0]?.address) {
        return xlayer[0].address as `0x${string}`;
      }
    } catch {
      // fall through to regex
    }

    const match = addrOut.match(/0x[a-fA-F0-9]{40}/i);
    if (match) return match[0] as `0x${string}`;
    throw new Error('Could not parse X Layer wallet address from onchainos wallet addresses output.');
  }

  public async getEscrowTimeInCurrentState(taskId: string, status: number, disputedAt: bigint): Promise<number> {
    const now = Math.floor(Date.now() / 1000);

    if (status === 4 && disputedAt > 0n) {
      return Math.max(0, now - Number(disputedAt));
    }

    if (status === 0 || status === 1) {
      try {
        const id = this.parseTaskId(taskId);
        const latestBlock = await this.publicClient.getBlockNumber();
        const lookback = 99n;
        const fromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;
        const logs = await this.publicClient.getLogs({
          address: ENV.ESCROW_CONTRACT_ADDRESS as `0x${string}`,
          event: parseAbiItem(
            'event TaskCreated(uint256 indexed taskId, address indexed client, uint256 indexed agentId, uint256 payment)'
          ),
          args: { taskId: id } as any,
          fromBlock,
          toBlock: latestBlock,
        });
        if (logs.length > 0 && logs[0].blockNumber) {
          const block = await this.publicClient.getBlock({ blockNumber: logs[0].blockNumber });
          return Math.max(0, now - Number(block.timestamp));
        }
      } catch (err) {
        console.warn(`[XLayerClient] Failed to scan TaskCreated block timestamp:`, err);
      }
    }

    return 0;
  }
}