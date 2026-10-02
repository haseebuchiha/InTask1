#!/usr/bin/env bash
set -euo pipefail

cd /opt/task1
git fetch --quiet origin main
git reset --hard --quiet "${SSH_ORIGINAL_COMMAND:-origin/main}"
pnpm install --frozen-lockfile --prefer-offline
pnpm exec prisma migrate deploy
NEXT_DIST_DIR=.next-build NODE_OPTIONS=--max-old-space-size=2048 nice -n 10 pnpm build
rm -rf .next
mv .next-build .next
pm2 restart ping-monitor
