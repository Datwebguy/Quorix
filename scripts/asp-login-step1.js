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

fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(path.join(homeDir, 'AppData', 'Roaming'), { recursive: true });
fs.mkdirSync(path.join(homeDir, 'AppData', 'Local'), { recursive: true });

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

console.log('Identity: QuorixASP ASP');
console.log('Email:', email);
console.log('Session hash:', computed);
console.log('ONCHAINOS_HOME:', homeDir);
console.log('Action: wallet login (OTP send)\n');

execFile(binPath, ['wallet', 'login', email], { env, timeout: 60000 }, (err, stdout, stderr) => {
  console.log('--- stdout ---');
  console.log(stdout || '(empty)');
  if (stderr) {
    console.log('--- stderr ---');
    console.log(stderr);
  }
  if (err) {
    console.log('--- exit ---');
    console.log(err.message);
    process.exit(1);
  }
});