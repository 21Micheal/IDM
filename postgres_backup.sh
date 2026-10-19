#!/usr/bin/env bash
#
# postgres_backup.sh — Postgres logical backup + media files for disaster recovery
# and migration. Zero downtime.
#
# Captures:
#   1. pg_dump (logical, portable — the actual data)
#   2. media_files volume (uploaded documents stored on the file server)
#   3. Compose files + .env (rebuild recipe)
#
# Usage:  ./postgres_backup.sh [--keep 14] [-o /path/to/backups]
set -euo pipefail
umask 077

# ---------------------------------------------------------------- config ----
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
COMPOSE_PROJECT="idm"
COMPOSE_FILES=("docker-compose.procurement.prod.yml")
POSTGRES_SERVICE="postgres"
MEDIA_VOLUME="idm_media_files"
OUT_ROOT=""
KEEP=0            # 0 = keep everything
SKIP_MEDIA=0      # set to 1 to omit media snapshot

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output)   OUT_ROOT="${2:?-o needs a path}"; shift 2 ;;
    --keep)        KEEP="${2:?--keep needs a number}"; shift 2 ;;
    --no-media)    SKIP_MEDIA=1; shift ;;
    -h|--help)     usage 0 ;;
    *)             printf 'Unknown option: %s\n' "$1" >&2; usage 1 ;;
  esac
done

COMPOSE=(docker compose -p "$COMPOSE_PROJECT")
for f in "${COMPOSE_FILES[@]}"; do COMPOSE+=(-f "$f"); done

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { printf '[%s] ERROR: %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }
size() { du -h "$1" 2>/dev/null | cut -f1; }

# ------------------------------------------------------------- preflight ---
command -v docker >/dev/null || die "docker not found in PATH"
docker info >/dev/null 2>&1 || die "cannot reach Docker daemon"

cd "$PROJECT_DIR"
for f in "${COMPOSE_FILES[@]}"; do
  [ -f "$f" ] || die "missing compose file: $f"
done

# Fail before creating a backup directory if the selected Postgres service is
# not running. This also prevents a missing-container error from looking like a
# pg_dump failure.
if ! "${COMPOSE[@]}" ps --status running -q "$POSTGRES_SERVICE" | grep -q .; then
  die "PostgreSQL service '$POSTGRES_SERVICE' is not running in Compose project '$COMPOSE_PROJECT'. Start the deployment with: docker compose -p $COMPOSE_PROJECT --env-file .env -f ${COMPOSE_FILES[0]} up -d postgres"
fi

STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="${OUT_ROOT:-$PROJECT_DIR/backups}/$STAMP"
mkdir -p "$BACKUP_DIR"
log "backup dir: $BACKUP_DIR"

# --- 1. logical dump (the actual data you care about) ----------------------
log "pg_dump starting..."
if ! "${COMPOSE[@]}" exec -T "$POSTGRES_SERVICE" sh -c \
     'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        --format=custom --compress=6 --no-owner --no-privileges --verbose' \
     > "$BACKUP_DIR/database.dump" 2> "$BACKUP_DIR/pg_dump.log"; then
  log "pg_dump command failed; diagnostic output follows:"
  cat "$BACKUP_DIR/pg_dump.log" >&2
  die "pg_dump failed — backup files retained at $BACKUP_DIR"
fi
[ -s "$BACKUP_DIR/database.dump" ] || { rm -rf "$BACKUP_DIR"; die "empty dump"; }
log "dump done ($(size "$BACKUP_DIR/database.dump"))"

# --- 2. media files snapshot (zero downtime) -------------------------------
if [ "$SKIP_MEDIA" -eq 0 ]; then
  if ! docker volume inspect "$MEDIA_VOLUME" >/dev/null 2>&1; then
    log "WARNING: volume $MEDIA_VOLUME not found — skipping media snapshot"
  else
    # Stream the archive to a host-created file. A bind-mounted file created by
    # a root container would be root-owned and could not be chmod'ed below.
    # GNU tar exit code 1 = "file changed as we read it" (expected live warning).
    # Exit code 2+ = real fatal error.
    log "snapshotting media volume: $MEDIA_VOLUME"
    rc=0
    docker run --rm \
         -v "$MEDIA_VOLUME:/source:ro" \
         -v "$BACKUP_DIR:/backup" \
         alpine tar -czf - -C /source . \
         > "$BACKUP_DIR/media_files.tar.gz" 2>"$BACKUP_DIR/media_tar.log" || rc=$?
    if [ "$rc" -gt 1 ]; then
      rm -rf "$BACKUP_DIR"
      die "media snapshot failed — see $BACKUP_DIR/media_tar.log"
    elif [ "$rc" -eq 1 ]; then
      log "media snapshot done (with warnings — normal for live volume)"
    fi
    [ -s "$BACKUP_DIR/media_files.tar.gz" ] || log "WARNING: media snapshot produced empty file"
    log "media done ($(size "$BACKUP_DIR/media_files.tar.gz"))"
  fi
else
  log "skipping media snapshot (--no-media)"
fi

# --- 3. rebuild recipe: compose files + env --------------------------------
cp -a "${COMPOSE_FILES[@]}" "$BACKUP_DIR/"
[ -f .env ] && cp -a .env "$BACKUP_DIR/.env"

# Record exact image tags so a new host pulls the same versions
"${COMPOSE[@]}" images > "$BACKUP_DIR/images.txt" 2>/dev/null || true

# --- 4. verify --------------------------------------------------------------
if command -v pg_restore >/dev/null; then
  pg_restore --list "$BACKUP_DIR/database.dump" >/dev/null \
    || die "dump failed verification — treat as corrupt"
  log "dump verified OK"
else
  if "${COMPOSE[@]}" exec -T "$POSTGRES_SERVICE" \
       pg_restore --list /dev/stdin < "$BACKUP_DIR/database.dump" >/dev/null 2>&1; then
    log "dump verified OK (via container)"
  else
    log "WARNING: could not verify dump (pg_restore unavailable)"
  fi
fi

# --- 5. manifest ------------------------------------------------------------
cat > "$BACKUP_DIR/MANIFEST.txt" <<EOF
created_utc : $(date -u +%Y-%m-%dT%H:%M:%SZ)
host        : $(hostname)
project_dir : $PROJECT_DIR
compose     : ${COMPOSE_FILES[*]}
volumes     : $MEDIA_VOLUME

Contents:
  database.dump      : $(size "$BACKUP_DIR/database.dump")
  media_files.tar.gz : $(size "$BACKUP_DIR/media_files.tar.gz" 2>/dev/null || echo 'skipped')

Restore:
  # 1. bring up postgres
  docker compose -p ${COMPOSE_PROJECT} -f ${COMPOSE_FILES[0]} up -d postgres

  # 2. restore the dump
  cat database.dump | docker compose -p ${COMPOSE_PROJECT} -f ${COMPOSE_FILES[0]} exec -T postgres \\
    pg_restore -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" --clean --if-exists

  # 3. (optional) restore media files to the volume
  docker run --rm -v ${MEDIA_VOLUME}:/dest -v .:/backup alpine \\
    tar -xzf /backup/media_files.tar.gz -C /dest

  # 4. restart the full stack
  docker compose -p ${COMPOSE_PROJECT} -f ${COMPOSE_FILES[0]} up -d
EOF

chmod -R go-rwx "$BACKUP_DIR"

# --- 6. retention -----------------------------------------------------------
if [ "$KEEP" -gt 0 ]; then
  root="${OUT_ROOT:-$PROJECT_DIR/backups}"
  ls -1dt "$root"/*/ 2>/dev/null | tail -n "+$((KEEP + 1))" \
    | while IFS= read -r old; do
        log "pruning $old"
        rm -rf -- "$old"
      done
fi

log "complete -> $BACKUP_DIR ($(du -sh "$BACKUP_DIR" | cut -f1))"
echo "$BACKUP_DIR"
