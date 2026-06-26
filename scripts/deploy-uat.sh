#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# deploy-uat.sh — rebuild & redeploy the IDM UAT stack with disk hygiene.
#
# Reclaims space the way that DOESN'T sabotage build speed:
#   • removes dangling images (every `up --build` orphans the previous
#     idm-app:uat — that's what was filling the disk), and
#   • caps the BuildKit cache to a budget instead of nuking it, so the heavy
#     apt/pip/LibreOffice/Paddle layers stay cached and only `COPY . .` rebuilds.
#
# It never prunes named volumes, so MySQL / media / ES data are always safe.
#
# Usage (from the repo root, on the server):
#   ./scripts/deploy-uat.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose --env-file .env.uat -f docker-compose.uat.yml"
CACHE_BUDGET="${BUILD_CACHE_BUDGET:-10GB}"   # override: BUILD_CACHE_BUDGET=5GB ./scripts/deploy-uat.sh

if [[ ! -f .env.uat ]]; then
  echo "✗ .env.uat not found in $(pwd) — create it from .env.uat.example first." >&2
  exit 1
fi

echo "── Disk before ─────────────────────────────────────────────"
df -h / | tail -n +1

echo "── Reclaiming space (dangling images + capped build cache) ──"
# Dangling images only (never tagged images in use); volumes are untouched.
docker image prune -f
# Trim build cache to the budget — keeps recent layers, drops the oldest.
docker builder prune -f --keep-storage "$CACHE_BUDGET"

echo "── Build + deploy ──────────────────────────────────────────"
$COMPOSE up -d --build

echo "── Cleanup: drop images orphaned by this build ─────────────"
docker image prune -f

echo "── Disk after ──────────────────────────────────────────────"
df -h / | tail -n +1

echo "── Status ──────────────────────────────────────────────────"
$COMPOSE ps

echo "✓ Deploy complete. Tail logs with:"
echo "    $COMPOSE logs -f backend"
