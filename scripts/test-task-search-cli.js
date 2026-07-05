const { execFile } = require('child_process');
const path = require('path');
const os = require('os');

const binPath = path.join(process.env.USERPROFILE, '.local', 'bin', 'onchainos.exe');
const homeDir = path.join(os.tmpdir(), 'okx-cli-sessions', '16244a22b9b5242d');

function run(args) {
  return new Promise((resolve, reject) => {
    const userProfile = process.env.USERPROFILE;
    const driveMatch = homeDir.match(/^([a-zA-Z]:)(.*)$/);
    const homeDrive = driveMatch ? driveMatch[1] : 'C:';
    const homePath = driveMatch ? driveMatch[2] : homeDir;
    const isolatedAppData = path.join(homeDir, 'AppData', 'Roaming');
    const isolatedLocalAppData = path.join(homeDir, 'AppData', 'Local');
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      HOMEDRIVE: homeDrive,
      HOMEPATH: homePath,
      APPDATA: isolatedAppData,
      LOCALAPPDATA: isolatedLocalAppData,
      ONCHAINOS_HOME: homeDir,
      PATH: `${path.join(userProfile, '.local', 'bin')};${process.env.PATH || ''}`,
    };
    delete env.REAL_USERPROFILE;
    console.log('CMD:', 'onchainos', args.join(' '));
    console.log('HOME:', homeDir);
    execFile(binPath, args, { env, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      resolve({ stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

(async () => {
  const status = await run(['wallet', 'status']);
  console.log('\n=== wallet status ===\n', status.stdout);

  for (const agentId of ['3994', '3827', '1']) {
    try {
      const out = await run([
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
      ]);
      console.log(`\n=== task-search agent-id=${agentId} ===\n`, out.stdout);
    } catch (e) {
      console.log(`\n=== task-search agent-id=${agentId} FAILED ===`);
      console.log('stdout:', e.stdout);
      console.log('stderr:', e.stderr);
      console.log('message:', e.message);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});