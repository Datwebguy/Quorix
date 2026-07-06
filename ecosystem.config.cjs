/**
 * PM2 process supervisor for Fly.io container.
 * Keeps Express and okx-a2a (XMTP listener) alive; restarts either on crash.
 *
 * Phase 1 (Express-only): comment out the okx-a2a block below, deploy, verify
 *   GET /api/status, then restore okx-a2a before the atomic XMTP cutover.
 * Phase 2 (full stack): both apps uncommented — stop laptop daemon first.
 */
module.exports = {
  apps: [
    {
      name: 'quorix-express',
      script: 'dist/src/index.js',
      cwd: '/app',
      env: {
        PORT: process.env.PORT || '8080',
      },
      max_restarts: 100,
      min_uptime: '10s',
      restart_delay: 3000,
    },
    {
      name: 'okx-a2a',
      script: 'okx-a2a',
      args: 'run --provider codex',
      interpreter: 'none',
      max_restarts: 100,
      min_uptime: '10s',
      restart_delay: 5000,
    },
  ],
};