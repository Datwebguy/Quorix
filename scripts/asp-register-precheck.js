require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const email = process.env.OKX_OPERATOR_EMAIL?.trim();
const sessionHash = process.env.ONCHAINOS_CLI_SESSION?.trim();
if (!email && !sessionHash) {
  console.error('Set OKX_OPERATOR_EMAIL or ONCHAINOS_CLI_SESSION in .env');
  process.exit(1);
}
const computed =
  sessionHash ||
  crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
const homeDir = path.join(process.env.TEMP || '/tmp', 'okx-cli-sessions', computed);
const userProfile = process.env.USERPROFILE;
const binPath = path.join(userProfile, '.local', 'bin', 'onchainos.exe');
const avatarPath = process.env.OKX_AGENT_AVATAR_PATH?.trim() || '';

const IDENTITY_NAME = 'QuorixASP';
const IDENTITY_DESC =
  'Autonomous A2A deal broker: discovers OKX.AI marketplace tasks, audits buyer reputation, negotiates SLA terms, and tracks task status through to completion.';
const SERVICE_NAME = 'A2A Marketplace Deal Broker';
const SERVICE_DESC =
  'Delivers end-to-end A2A brokerage for OKX.AI public tasks: skill-matched task discovery, buyer reputation checks, and SLA counter-proposals through to delivery acceptance.\n\nBuyer provides: (1) task jobId or task title/description, (2) target budget range in USDT, (3) delivery deadline expectations, (4) any required deliverable format.';
const SERVICE_FEE = '0.5';

function env() {
  const driveMatch = homeDir.match(/^([a-zA-Z]:)(.*)$/);
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    HOMEDRIVE: driveMatch ? driveMatch[1] : 'C:',
    HOMEPATH: driveMatch ? driveMatch[2] : homeDir,
    APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
    ONCHAINOS_HOME: homeDir,
    PATH: `${path.join(userProfile, '.local', 'bin')};${process.env.PATH || ''}`,
    REAL_USERPROFILE: undefined,
  };
}

function run(args) {
  return new Promise((resolve) => {
    console.log('\n>>> onchainos', args.join(' '));
    execFile(binPath, args, { env: env(), timeout: 120000 }, (err, stdout, stderr) => {
      resolve({
        err,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    });
  });
}

(async () => {
  console.log('ASP session:', homeDir);
  console.log('Avatar path exists:', fs.existsSync(avatarPath), avatarPath);

  console.log('\n=== 1) agent pre-check --role asp ===');
  const pre = await run(['agent', 'pre-check', '--role', 'asp']);
  console.log(pre.stdout || pre.stderr);
  if (pre.err) console.log('exit error:', pre.err.message);

  let preJson;
  try {
    preJson = JSON.parse(pre.stdout);
  } catch {
    preJson = null;
  }

  if (preJson?.consent?.consentKey) {
    console.log('\n[CONSENT REQUIRED — re-running pre-check with consent-key]');
    const pre2 = await run([
      'agent',
      'pre-check',
      '--role',
      'asp',
      '--consent-key',
      preJson.consent.consentKey,
    ]);
    console.log(pre2.stdout || pre2.stderr);
    try {
      preJson = JSON.parse(pre2.stdout);
    } catch {}
  }

  if (!preJson?.canCreate) {
    console.log('\nSTOP: pre-check did not return canCreate:true');
    process.exit(2);
  }

  console.log('\n=== 2) agent upload --file <avatar> ===');
  const up = await run(['agent', 'upload', '--file', avatarPath]);
  console.log(up.stdout || up.stderr);
  if (up.err) {
    console.log('exit error:', up.err.message);
    process.exit(1);
  }

  let upJson;
  try {
    upJson = JSON.parse(up.stdout);
  } catch {
    console.error('Could not parse upload response');
    process.exit(1);
  }

  const pictureUrl = upJson?.data?.url || upJson?.url || upJson?.data?.pictureUrl;
  if (!pictureUrl) {
    console.error('No picture URL in upload response:', upJson);
    process.exit(1);
  }
  console.log('picture URL:', pictureUrl);

  const servicePayload = [
    {
      serviceName: SERVICE_NAME,
      serviceDescription: SERVICE_DESC,
      serviceType: 'A2A',
      feeAmount: SERVICE_FEE,
    },
  ];

  console.log('\n=== 3) agent validate-listing ===');
  const val = await run([
    'agent',
    'validate-listing',
    '--role',
    'asp',
    '--name',
    IDENTITY_NAME,
    '--description',
    IDENTITY_DESC,
    '--service',
    JSON.stringify(servicePayload),
  ]);
  console.log(val.stdout || val.stderr);
  if (val.err) console.log('exit error:', val.err.message);
})();