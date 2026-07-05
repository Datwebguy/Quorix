const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const email = process.env.OKX_OPERATOR_EMAIL?.trim();
const sessionHash = process.env.ONCHAINOS_CLI_SESSION?.trim();
if (!email && !sessionHash) {
  console.error('Set OKX_OPERATOR_EMAIL or ONCHAINOS_CLI_SESSION in .env');
  process.exit(1);
}
const code = process.argv[2];
if (!code) {
  console.error('Usage: node asp-login-verify.js <otp-code>');
  process.exit(1);
}

const crypto = require('crypto');
const computed =
  sessionHash ||
  crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
const homeDir = path.join(process.env.TEMP || '/tmp', 'okx-cli-sessions', computed);
const userProfile = process.env.USERPROFILE;
const binPath = path.join(userProfile, '.local', 'bin', 'onchainos.exe');

function run(args) {
  return new Promise((resolve, reject) => {
    const driveMatch = homeDir.match(/^([a-zA-Z]:)(.*)$/);
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      HOMEDRIVE: driveMatch ? driveMatch[1] : 'C:',
      HOMEPATH: driveMatch ? driveMatch[2] : homeDir,
      APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
      ONCHAINOS_HOME: homeDir,
      PATH: `${path.join(userProfile, '.local', 'bin')};${process.env.PATH || ''}`,
    };
    delete env.REAL_USERPROFILE;
    execFile(binPath, args, { env, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

(async () => {
  console.log('Identity: QuorixASP ASP');
  console.log('Email:', email);
  console.log('ONCHAINOS_HOME:', homeDir);
  console.log('Action: wallet verify\n');

  let r = await run(['wallet', 'verify', code]);
  console.log('--- verify ---');
  console.log(r.stdout || r.stderr);
  if (r.err && /confirm|switch|account/i.test(r.stdout + r.stderr)) {
    r = await run(['wallet', 'verify', code, '--force']);
    console.log('\n--- verify --force ---');
    console.log(r.stdout || r.stderr);
  }

  const status = await run(['wallet', 'status']);
  console.log('\n--- wallet status ---');
  console.log(status.stdout);

  const addresses = await run(['wallet', 'addresses']);
  console.log('\n--- wallet addresses (excerpt) ---');
  const xlayer = (addresses.stdout || '').match(/0x[a-fA-F0-9]{40}/gi);
  console.log(xlayer ? [...new Set(xlayer)].join('\n') : addresses.stdout.slice(0, 500));
})();