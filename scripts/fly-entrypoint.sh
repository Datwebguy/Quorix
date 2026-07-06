#!/bin/sh
# Fly.io entrypoint: wire persistent volume paths, then supervise Express + okx-a2a.
set -eu

DATA_DIR="/data"
SESSION_HASH="${ONCHAINOS_CLI_SESSION:?ONCHAINOS_CLI_SESSION must be set}"
SESSION_DIR="${DATA_DIR}/okx-cli-sessions/${SESSION_HASH}"

export PATH="/root/.local/bin:/usr/local/bin:${PATH}"

# ── Persistent volume layout ────────────────────────────────────────────────
mkdir -p "${DATA_DIR}/okx-cli-sessions" "${DATA_DIR}/codex" "${DATA_DIR}/okx-agent-task"
ln -sfn "${DATA_DIR}/okx-cli-sessions" /tmp/okx-cli-sessions
ln -sfn "${DATA_DIR}/codex" /root/.codex
ln -sfn "${DATA_DIR}/okx-agent-task" /root/.okx-agent-task

# onchainos session data lives in SESSION_DIR; process HOME stays /root for okx-a2a + PM2.
export ONCHAINOS_HOME="${SESSION_DIR}"
export HOME="/root"
export USERPROFILE="${SESSION_DIR}"
export APPDATA="${SESSION_DIR}/AppData/Roaming"
export LOCALAPPDATA="${SESSION_DIR}/AppData/Local"
mkdir -p "${APPDATA}" "${LOCALAPPDATA}" "${SESSION_DIR}/.local/bin"
ln -sfn /root/.local/bin/onchainos "${SESSION_DIR}/.local/bin/onchainos"
ln -sfn "${DATA_DIR}/okx-agent-task" "${SESSION_DIR}/.okx-agent-task"

if [ ! -f "${SESSION_DIR}/session.json" ]; then
  echo "FATAL: ${SESSION_DIR}/session.json missing."
  echo "Upload your laptop session (${SESSION_HASH}) to the Fly volume before starting."
  exit 1
fi

if [ ! -f /root/.codex/auth.json ]; then
  echo "WARN: /root/.codex/auth.json missing — okx-a2a AI dispatch may require Codex login."
fi

echo "[entrypoint] ONCHAINOS_HOME=${ONCHAINOS_HOME}"
echo "[entrypoint] HOME=${HOME}"
echo "[entrypoint] PORT=${PORT:-8080}"

cd /app
exec pm2-runtime ecosystem.config.cjs