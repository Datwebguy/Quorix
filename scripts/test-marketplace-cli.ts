/**
 * Live integration test: task-search + recommend-task for a bound agentId.
 * Usage: npx ts-node scripts/test-marketplace-cli.ts [sessionHash] [agentId]
 * Defaults read ONCHAINOS_CLI_SESSION and AGENT_ID from .env
 */
import path from 'path';
import os from 'os';
import { execOnchainOs, parseOnchainOsJson } from '../src/onchainos/exec';
import { recommendTask, taskSearch, walletIsLoggedIn } from '../src/onchainos/taskMarketplace';

function portalUrlForJob(jobId: string): string | undefined {
  if (/^\d+$/.test(jobId)) return `https://www.okx.ai/tasks/${jobId}`;
  return undefined;
}

async function rawCli(homeDir: string, args: string[]): Promise<string> {
  const { stdout } = await execOnchainOs(args, homeDir);
  return stdout;
}

async function main() {
  const hash = process.argv[2] || process.env.ONCHAINOS_CLI_SESSION?.trim();
  const agentId = process.argv[3] || process.env.AGENT_ID?.trim();
  if (!hash || !agentId) {
    console.error('Provide sessionHash and agentId args, or set ONCHAINOS_CLI_SESSION and AGENT_ID in .env');
    process.exit(1);
  }
  const homeDir = path.join(os.tmpdir(), 'okx-cli-sessions', hash);

  console.log('=== Step 3 marketplace CLI test ===');
  console.log('Session HOME:', homeDir);
  console.log('Agent ID:', agentId);
  console.log('Listing state: unlisted / review not submitted (pre-activate)\n');

  const loggedIn = await walletIsLoggedIn(homeDir);
  console.log('loggedIn:', loggedIn);
  if (!loggedIn) {
    console.error('FAIL: wallet not logged in');
    process.exit(1);
  }

  console.log('\n--- RAW: onchainos agent task-search ---');
  try {
    const searchRaw = await rawCli(homeDir, [
      'agent',
      'task-search',
      '--agent-id',
      agentId,
      '--page',
      '1',
      '--page-size',
      '3',
      '--status',
      '0',
      '--order-by',
      'create_time_desc',
    ]);
    console.log(searchRaw);

    const searchJson = parseOnchainOsJson<{ ok?: boolean; error?: string; data?: unknown }>(searchRaw);
    if (searchJson.ok !== false) {
      const parsed = await taskSearch(
        { homeDir, agentId },
        { page: 1, pageSize: 3, status: [0], orderBy: 'create_time_desc' }
      );
      console.log('\n--- PARSED task-search (with portalUrl) ---');
      console.log(
        JSON.stringify(
          {
            ...parsed,
            tasks: parsed.tasks.map((t) => ({
              ...t,
              portalUrl: portalUrlForJob(t.jobId),
            })),
          },
          null,
          2
        )
      );
    }
  } catch (err: any) {
    console.log('task-search ERROR:', err?.stdout || err?.message || err);
  }

  console.log('\n--- RAW: onchainos agent recommend-task ---');
  try {
    const recRaw = await rawCli(homeDir, ['agent', 'recommend-task', '--agent-id', agentId]);
    console.log(recRaw);

    const recJson = parseOnchainOsJson<{ ok?: boolean; error?: string }>(recRaw);
    if (recJson.ok !== false) {
      const parsed = await recommendTask({ homeDir, agentId }, { pageSize: 5 });
      console.log('\n--- PARSED recommend-task (with portalUrl) ---');
      console.log(
        JSON.stringify(
          {
            ...parsed,
            tasks: parsed.tasks.map((t) => ({
              ...t,
              portalUrl: portalUrlForJob(t.jobId),
            })),
          },
          null,
          2
        )
      );
    }
  } catch (err: any) {
    console.log('recommend-task ERROR:', err?.stdout || err?.message || err);
  }
}

main().catch((err) => {
  console.error('FATAL:', err?.stdout || err?.message || err);
  process.exit(1);
});