#!/usr/bin/env bash
set -Eeuo pipefail

# Consistent backup for the single-machine Docker Compose topology.
# Override BACKUP_ROOT/BACKUP_STAMP only when a scheduler needs a fixed path.

if [[ "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: npm run deploy:backup

Environment:
  BACKUP_ROOT    Destination parent directory (default: <repo>/backups)
  BACKUP_STAMP   Backup directory name (default: UTC YYYYmmdd-HHMMSS)
EOF
  exit 0
fi

if [[ $# -ne 0 ]]; then
  echo "Unknown argument: $1" >&2
  exit 2
fi

for command in docker tar sha256sum; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

docker compose version >/dev/null
docker compose config --quiet

STORAGE_VOLUME="benchu-canvas_app-storage"
if ! docker volume inspect "$STORAGE_VOLUME" >/dev/null 2>&1; then
  echo "Storage volume does not exist: $STORAGE_VOLUME" >&2
  echo "Start the stack at least once with: npm run deploy:up" >&2
  exit 1
fi

MYSQL_CONTAINER="$(docker compose ps -q mysql)"
if [[ -z "$MYSQL_CONTAINER" ]] || [[ "$(docker inspect -f '{{.State.Running}}' "$MYSQL_CONTAINER")" != "true" ]]; then
  echo "The mysql Compose service is not running" >&2
  exit 1
fi

API_CONTAINER="$(docker compose ps -q api)"
API_PAUSED_BY_SCRIPT=false

BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backups}"
BACKUP_STAMP="${BACKUP_STAMP:-$(date -u +%Y%m%d-%H%M%S)}"
if [[ ! "$BACKUP_STAMP" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "BACKUP_STAMP must contain only letters, digits, dots, underscores, or dashes" >&2
  exit 2
fi
mkdir -p -- "$BACKUP_ROOT"
BACKUP_ROOT="$(cd -- "$BACKUP_ROOT" && pwd)"
FINAL_DIR="$BACKUP_ROOT/$BACKUP_STAMP"
PARTIAL_DIR="$BACKUP_ROOT/.partial-$BACKUP_STAMP-$$"

if [[ -e "$FINAL_DIR" ]]; then
  echo "Backup destination already exists; refusing to overwrite: $FINAL_DIR" >&2
  exit 1
fi

umask 077
mkdir -- "$PARTIAL_DIR"
cleanup() {
  status=$?
  if [[ "$API_PAUSED_BY_SCRIPT" == "true" ]]; then
    echo "Resuming API after interrupted backup..." >&2
    docker unpause "$API_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ $status -ne 0 && -n "${PARTIAL_DIR:-}" && -d "$PARTIAL_DIR" ]]; then
    rm -rf -- "$PARTIAL_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

# Freeze the API and its embedded worker so the MySQL snapshot and local object
# storage archive describe the same application write window. Existing clients
# may briefly wait at nginx while the backup is collected.
if [[ -n "$API_CONTAINER" ]] &&
  [[ "$(docker inspect -f '{{.State.Running}}' "$API_CONTAINER")" == "true" ]] &&
  [[ "$(docker inspect -f '{{.State.Paused}}' "$API_CONTAINER")" != "true" ]]; then
  echo "Pausing API writes for a consistent backup..."
  docker pause "$API_CONTAINER" >/dev/null
  API_PAUSED_BY_SCRIPT=true
fi

echo "Backing up MySQL..."
docker compose exec -T mysql sh -c \
  'exec mysqldump --single-transaction --quick --routines --triggers -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' \
  > "$PARTIAL_DIR/mysql.sql"

if [[ ! -s "$PARTIAL_DIR/mysql.sql" ]] || ! grep -q 'CREATE TABLE' "$PARTIAL_DIR/mysql.sql"; then
  echo "MySQL dump validation failed" >&2
  exit 1
fi

echo "Backing up local object storage..."
docker run --rm \
  --volume "$STORAGE_VOLUME:/data:ro" \
  --volume "$PARTIAL_DIR:/backup" \
  alpine:3.20 \
  tar czf /backup/storage.tar.gz -C /data .

if [[ ! -s "$PARTIAL_DIR/storage.tar.gz" ]]; then
  echo "Storage archive is empty" >&2
  exit 1
fi
tar tzf "$PARTIAL_DIR/storage.tar.gz" >/dev/null

if [[ "$API_PAUSED_BY_SCRIPT" == "true" ]]; then
  echo "Resuming API..."
  docker unpause "$API_CONTAINER" >/dev/null
  API_PAUSED_BY_SCRIPT=false
fi

cat > "$PARTIAL_DIR/metadata.txt" <<EOF
created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
compose_project=benchu-canvas
storage_volume=$STORAGE_VOLUME
database_service=mysql
EOF

(
  cd "$PARTIAL_DIR"
  sha256sum mysql.sql storage.tar.gz metadata.txt > SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)

mv -- "$PARTIAL_DIR" "$FINAL_DIR"
PARTIAL_DIR=""
trap - EXIT

echo "Backup completed: $FINAL_DIR"
echo "Files: mysql.sql, storage.tar.gz, metadata.txt, SHA256SUMS"
