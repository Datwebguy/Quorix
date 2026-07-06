import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface OnchainOsExecResult {
  stdout: string;
  stderr: string;
}

/** Build an isolated process env mirroring the per-email dashboard login sessions. */
export function buildIsolatedCliEnv(homeDir: string): { env: NodeJS.ProcessEnv; binPath: string } {
  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (!userProfile) {
    throw new Error(
      'Critical Startup Error: Neither USERPROFILE nor HOME environment variables are defined. Active user profile directory path is required.'
    );
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

  delete env.REAL_USERPROFILE;

  return { env, binPath };
}

/** Spawn onchainos with array arguments (no shell) under an isolated ONCHAINOS_HOME. */
export function execOnchainOs(
  args: string[],
  homeDir: string,
  timeoutMs = 60_000
): Promise<OnchainOsExecResult> {
  const { env, binPath } = buildIsolatedCliEnv(homeDir);

  return new Promise((resolve, reject) => {
    execFile(binPath, args, { env, timeout: timeoutMs }, (error, stdout, stderr) => {
      const out = (stdout || '').trim();
      const errOut = (stderr || '').trim();
      if (error) {
        reject(Object.assign(error, { stdout: out, stderr: errOut }));
        return;
      }
      resolve({ stdout: out, stderr: errOut });
    });
  });
}

/** Parse CLI stdout that may be pure JSON or JSON embedded in log/path text. */
export function parseOnchainOsJson<T = unknown>(stdout: string): T {
  const trimmed = (stdout || '').trim();
  if (!trimmed) {
    throw new Error('Onchain OS CLI returned empty stdout');
  }

  const attempts: string[] = [trimmed];

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    attempts.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const lt = line.trim();
    if (lt.startsWith('{') && lt.endsWith('}')) attempts.push(lt);
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  throw new Error(
    `Onchain OS CLI returned non-JSON output: ${trimmed.slice(0, 240)}${trimmed.length > 240 ? '…' : ''}`
  );
}

/** True when contact-user succeeded but emitted human/playbook text instead of JSON. */
export function isContactUserPlainSuccess(stdout: string, stderr = ''): boolean {
  const combined = `${stdout || ''}\n${stderr || ''}`.trim();
  if (!combined) return false;
  return /cold[- ]?start|cold[- ]?sta|contact[- ]?user|opener|xmtp|session created|negotiation opened|message sent|canonical self-intro/i.test(
    combined
  );
}

export function assertOnchainOsOk(
  payload: { ok?: boolean; error?: string; data?: unknown },
  context: string
): void {
  if (payload?.ok === false) {
    throw new Error(`${context}: ${payload.error || 'CLI returned ok:false'}`);
  }
}