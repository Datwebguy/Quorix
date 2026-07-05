const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const binPath = path.join(process.env.USERPROFILE, '.local', 'bin', 'onchainos.exe');
const roots = [
  path.join(os.tmpdir(), 'okx-cli-sessions'),
  path.join(os.tmpdir(), 'okx-cli-sessions-ARCHIVED-TEST-20260705-102950'),
];

function run(args, homeDir) {
  return new Promise((resolve) => {
    const env = { ...process.env, ONCHAINOS_HOME: homeDir, USERPROFILE: homeDir, HOME: homeDir };
    execFile(binPath, args, { env, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

(async () => {
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    console.log(`\n### ROOT ${root}`);
    for (const dir of fs.readdirSync(root)) {
      const homeDir = path.join(root, dir);
      if (!fs.statSync(homeDir).isDirectory()) continue;
      const status = await run(['wallet', 'status'], homeDir);
      let parsed;
      try {
        parsed = JSON.parse(status.stdout);
      } catch {
        continue;
      }
      if (!parsed?.data?.loggedIn) continue;
      const email = parsed.data.email || '';
      const agents = await run(['agent', 'get-my-agents'], homeDir);
      let agentList = [];
      try {
        const ap = JSON.parse(agents.stdout);
        agentList = ap?.data?.list || [];
      } catch {}
      const aspAgents = agentList.filter((a) => String(a.role) === '2' || a.roleLabel === 'ASP');
      console.log(`\n[${dir}] email=${email} agents=${agentList.length} asp=${aspAgents.length}`);
      for (const a of agentList.slice(0, 5)) {
        console.log(`  #${a.agentId} role=${a.roleLabel || a.role} name=${a.name} status=${a.statusLabel || a.status}`);
      }
    }
  }
})();