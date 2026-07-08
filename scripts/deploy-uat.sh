#!/usr/bin/env bash
# =============================================================================
# deploy-uat.sh — Pre-deploy backup + disk hygiene + rebuild for fseDMS UAT
# =============================================================================
# Run this BEFORE every deployment. It will:
#   1. Run preflight checks (Docker, stack health, env file)
#   2. Back up the MySQL database
#   3. Back up uploaded media files
#   4. Remind you to take a Hyper-V snapshot from the Windows host
#   5. Pull latest code (branch: version2)
#   6. Reclaim disk space safely (dangling images + capped BuildKit cache)
#   7. Rebuild and redeploy the stack
#   8. Drop images orphaned by this build
#   9. Run post-deploy health checks
#  10. Print a summary with rollback instructions
#
# Named volumes (MySQL / media / ES data) are NEVER pruned.
#
# Usage (from the repo root, on the server):
#   chmod +x deploy-uat.sh        # first time only
#   ./deploy-uat.sh
#
# Override the BuildKit cache budget (default 10 GB):
#   BUILD_CACHE_BUDGET=5GB ./deploy-uat.sh
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

# ── Configuration ─────────────────────────────────────────────────────────────
COMPOSE="docker compose --env-file .env.uat -f docker-compose.uat.yml"
BACKUP_DIR="$HOME/backups"
DATE=$(date +%F)
BRANCH="version2"
CACHE_BUDGET="${BUILD_CACHE_BUDGET:-10GB}"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo -e "${BLUE}[$(date +%T)]${NC} $1"; }
ok()   { echo -e "${GREEN}[$(date +%T)] ✔ $1${NC}"; }
warn() { echo -e "${YELLOW}[$(date +%T)] ⚠ $1${NC}"; }
fail() { echo -e "${RED}[$(date +%T)] ✘ $1${NC}"; exit 1; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║        fseDMS Pre-Deploy Backup & Snapshot           ║${NC}"
echo -e "${BLUE}║                  $(date '+%Y-%m-%d %H:%M')                    ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Step 1: Preflight checks ──────────────────────────────────────────────────
log "Running preflight checks..."

if [ ! -f "docker-compose.uat.yml" ]; then
  fail "Run this script from the ~/dms directory (docker-compose.uat.yml not found)"
fi

if [ ! -f ".env.uat" ]; then
  fail ".env.uat not found — create it from .env.uat.example first."
fi

if ! docker info > /dev/null 2>&1; then
  fail "Docker is not running. Start Docker and try again."
fi

DB_STATUS=$($COMPOSE ps db --format json 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['Health'])" 2>/dev/null \
  || echo "unknown")

if [ "$DB_STATUS" != "healthy" ]; then
  warn "Database container is not healthy (status: $DB_STATUS)."
  warn "Attempting to start the stack before backing up..."
  $COMPOSE up -d
  log "Waiting 30 seconds for db to become healthy..."
  sleep 30
fi

ok "Preflight checks passed"
echo ""

# ── Step 2: Create backup directory ───────────────────────────────────────────
log "Creating backup directory: $BACKUP_DIR/$DATE"
mkdir -p "$BACKUP_DIR/$DATE"
ok "Backup directory ready"
echo ""

# ── Step 3: Database backup ───────────────────────────────────────────────────
log "Backing up MySQL database (idm_db)..."
DB_BACKUP="$BACKUP_DIR/$DATE/idm_db_$DATE.sql"

$COMPOSE exec -T db sh -c \
  'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers idm_db' \
  > "$DB_BACKUP" 2>/dev/null

DB_SIZE=$(du -sh "$DB_BACKUP" 2>/dev/null | cut -f1)
if [ ! -s "$DB_BACKUP" ]; then
  fail "Database backup is empty! Aborting — do not deploy."
fi

ok "Database backup complete: $DB_BACKUP ($DB_SIZE)"
echo ""

# ── Step 4: Media files backup ────────────────────────────────────────────────
log "Backing up media files..."
MEDIA_BACKUP="$BACKUP_DIR/$DATE/media_$DATE.tgz"

docker run --rm \
  -v dms_media_files:/m \
  -v "$BACKUP_DIR/$DATE":/b \
  alpine tar czf "/b/media_$DATE.tgz" -C /m . 2>/dev/null

MEDIA_SIZE=$(du -sh "$MEDIA_BACKUP" 2>/dev/null | cut -f1)
if [ ! -f "$MEDIA_BACKUP" ]; then
  fail "Media backup failed! Aborting — do not deploy."
fi

ok "Media backup complete: $MEDIA_BACKUP ($MEDIA_SIZE)"
echo ""

# ── Step 5: Hyper-V snapshot reminder ─────────────────────────────────────────
log "Skipping Hyper-V snapshot (must be taken from the Windows host)."
warn "REMINDER: Before continuing, take a Hyper-V snapshot from the Windows host:"
warn "  Checkpoint-VM -Name 'fsedms' -SnapshotName 'pre-deploy-$DATE'"
echo ""
read -rp "  Have you taken the snapshot (or want to skip)? [y/N]: " SNAP_CONFIRM
if [[ ! "$SNAP_CONFIRM" =~ ^[Yy]$ ]]; then
  log "Take the snapshot first, then re-run. Backups are at $BACKUP_DIR/$DATE."
  exit 0
fi
echo ""

# ── Step 6: Pull latest code ───────────────────────────────────────────────────
log "Pulling latest code from branch: $BRANCH..."
git fetch origin
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/$BRANCH)

if [ "$LOCAL" = "$REMOTE" ]; then
  warn "Already up to date — no new commits on $BRANCH."
  echo ""
  read -rp "  Continue with rebuild anyway? [y/N]: " REBUILD_CONFIRM
  if [[ ! "$REBUILD_CONFIRM" =~ ^[Yy]$ ]]; then
    log "Nothing to deploy. Backups are saved at $BACKUP_DIR/$DATE."
    exit 0
  fi
else
  git pull origin "$BRANCH"
  ok "Code updated to $(git rev-parse --short HEAD)"
fi
echo ""

# ── Step 7: Disk hygiene ──────────────────────────────────────────────────────
log "Disk before cleanup:"
df -h / | tail -n +1
echo ""

log "Reclaiming space (dangling images + capped BuildKit cache)..."
# Dangling images only — never named/tagged images or volumes.
docker image prune -f
# Trim build cache to the budget — keeps recent layers, drops the oldest.
# Heavy layers (apt/pip/LibreOffice/Paddle) stay cached; only COPY . . rebuilds.
# Note: --keep-storage was renamed to --reserved-space in newer BuildKit versions.
docker builder prune -f --reserved-space "$CACHE_BUDGET"
ok "Disk hygiene done (cache budget: $CACHE_BUDGET)"
echo ""

# ── Step 8: Rebuild and redeploy ──────────────────────────────────────────────
log "Rebuilding and restarting the stack..."
$COMPOSE up -d --build
ok "Stack restarted"
echo ""

# ── Step 9: Drop images orphaned by this build ────────────────────────────────
log "Cleaning up images orphaned by this build..."
docker image prune -f
ok "Post-build image cleanup done"
echo ""

log "Disk after deployment:"
df -h / | tail -n +1
echo ""

# ── Step 10: Post-deploy health checks ────────────────────────────────────────
log "Running post-deploy health checks..."
sleep 15  # give containers time to start

STOPPED=$($COMPOSE ps --format json 2>/dev/null | python3 -c "
import sys, json
containers = json.load(sys.stdin)
stopped = [c['Name'] for c in containers if c.get('State') != 'running']
print('\n'.join(stopped))
" 2>/dev/null)

if [ -n "$STOPPED" ]; then
  warn "The following containers are not running:"
  echo "$STOPPED"
  warn "Check logs with: $COMPOSE logs -f <container_name>"
else
  ok "All containers are running"
fi

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost/ 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ]; then
  ok "nginx is serving the SPA (HTTP $HTTP_STATUS)"
else
  warn "nginx returned HTTP $HTTP_STATUS — check: $COMPOSE logs nginx"
fi

API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost/api/v1/ 2>/dev/null || echo "000")
if [ "$API_STATUS" = "401" ] || [ "$API_STATUS" = "200" ]; then
  ok "Backend API is responding (HTTP $API_STATUS)"
else
  warn "Backend API returned HTTP $API_STATUS — check: $COMPOSE logs backend"
fi

echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                  Deploy Complete                     ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BLUE}Backups saved to:${NC}  $BACKUP_DIR/$DATE/"
echo -e "  ${BLUE}DB backup:${NC}         idm_db_$DATE.sql  ($DB_SIZE)"
echo -e "  ${BLUE}Media backup:${NC}      media_$DATE.tgz   ($MEDIA_SIZE)"
echo -e "  ${BLUE}Git commit:${NC}        $(git rev-parse --short HEAD) — $(git log -1 --format='%s')"
echo -e "  ${BLUE}Cache budget:${NC}      $CACHE_BUDGET"
echo ""
echo -e "  ${YELLOW}To roll back:${NC}"
echo -e "    • Restore VM snapshot from Hyper-V Manager (instant)"
echo -e "    • Or: git checkout <previous-commit> && $COMPOSE up -d --build"
echo ""
echo -e "  ${YELLOW}To tail logs:${NC}"
echo -e "    $COMPOSE logs -f backend celery_worker"
echo ""