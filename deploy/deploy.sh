#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/sipuni-mcp}"
BRANCH="${BRANCH:-main}"
LOCK_FILE="/var/lock/sipuni-mcp-deploy.lock"

exec 9>"$LOCK_FILE"
flock -n 9 || { echo "A deployment is already running" >&2; exit 1; }

cd "$APP_DIR"
test -f .env || { echo "Missing $APP_DIR/.env" >&2; exit 1; }

git fetch --prune origin "$BRANCH"
git checkout --detach "origin/$BRANCH"
# Both services use the same image; build it once.
docker compose build --pull sipuni-mcp

if grep -q '^PACHCA_WEBHOOK_SECRET=.' .env; then
  docker compose up -d pachca-sipuni-bot
else
  echo 'Pachca bot was not started: set PACHCA_WEBHOOK_SECRET in .env first.'
fi

echo "Sipuni MCP image successfully built from $(git rev-parse --short HEAD)"
