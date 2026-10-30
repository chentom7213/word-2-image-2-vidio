#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  deploy/restore-single.sh BACKUP_DIR
  deploy/restore-single.sh BACKUP_DIR --force --confirm-project PROJECT

Restores mysql.sql and storage.tar.gz into the current Docker Compose project's
mysql-data and app-storage named volumes. The Compose project must be stopped.

Options:
  --force                    Replace non-empty target volumes after taking a
                             temporary rollback snapshot.
  --confirm-project PROJECT  Required with --force; must exactly match the
                             Compose project resolved from docker-compose.yml.
  -h, --help                 Show this help.
EOF
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 2
fi
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

BACKUP_INPUT="$1"
shift
FORCE=0
CONFIRM_PROJECT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=1
      shift
      ;;
    --confirm-project)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "--confirm-project requires a project name" >&2
        exit 2
      fi
      CONFIRM_PROJECT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for command in docker tar sha256sum sed grep mktemp head tail tr sleep; do
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

if [[ ! -d "$BACKUP_INPUT" ]]; then
  echo "Backup directory does not exist: $BACKUP_INPUT" >&2
  exit 1
fi
BACKUP_DIR="$(cd -- "$BACKUP_INPUT" && pwd)"

for file in mysql.sql storage.tar.gz metadata.txt SHA256SUMS; do
  if [[ ! -f "$BACKUP_DIR/$file" ]]; then
    echo "Backup is incomplete; missing: $BACKUP_DIR/$file" >&2
    exit 1
  fi
done

# Only accept the exact checksum manifest produced by backup-single.sh. This
# prevents a modified manifest from making sha256sum read paths outside the
# selected backup directory.
MYSQL_SUMS=0
STORAGE_SUMS=0
METADATA_SUMS=0
SUM_LINES=0
SUMS_VALID=1
while read -r hash filename extra; do
  SUM_LINES=$((SUM_LINES + 1))
  if [[ ! "$hash" =~ ^[0-9a-fA-F]{64}$ || -n "${extra:-}" ]]; then
    SUMS_VALID=0
    continue
  fi
  case "$filename" in
    mysql.sql) MYSQL_SUMS=$((MYSQL_SUMS + 1)) ;;
    storage.tar.gz) STORAGE_SUMS=$((STORAGE_SUMS + 1)) ;;
    metadata.txt) METADATA_SUMS=$((METADATA_SUMS + 1)) ;;
    *) SUMS_VALID=0 ;;
  esac
done < "$BACKUP_DIR/SHA256SUMS"
if [[ "$SUMS_VALID" -ne 1 || "$SUM_LINES" -ne 3 || "$MYSQL_SUMS" -ne 1 || "$STORAGE_SUMS" -ne 1 || "$METADATA_SUMS" -ne 1 ]]; then
  echo "SHA256SUMS contains unexpected or duplicate entries" >&2
  exit 1
fi

echo "Validating backup checksums..."
(
  cd "$BACKUP_DIR"
  sha256sum --check --strict SHA256SUMS
)

metadata_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$BACKUP_DIR/metadata.txt" | tail -n 1
}

BACKUP_PROJECT="$(metadata_value compose_project)"
BACKUP_STORAGE_VOLUME="$(metadata_value storage_volume)"
BACKUP_DATABASE_SERVICE="$(metadata_value database_service)"
BACKUP_CREATED_AT="$(metadata_value created_at_utc)"
if [[ -z "$BACKUP_PROJECT" || -z "$BACKUP_STORAGE_VOLUME" || -z "$BACKUP_DATABASE_SERVICE" || -z "$BACKUP_CREATED_AT" ]]; then
  echo "metadata.txt is missing required fields" >&2
  exit 1
fi
if [[ "$BACKUP_DATABASE_SERVICE" != "mysql" ]]; then
  echo "Unsupported database service in backup metadata: $BACKUP_DATABASE_SERVICE" >&2
  exit 1
fi
if [[ ! -s "$BACKUP_DIR/mysql.sql" ]] || ! grep -q 'CREATE TABLE' "$BACKUP_DIR/mysql.sql"; then
  echo "mysql.sql does not look like a valid application dump" >&2
  exit 1
fi
if [[ ! -s "$BACKUP_DIR/storage.tar.gz" ]]; then
  echo "storage.tar.gz is empty" >&2
  exit 1
fi
if tar tzf "$BACKUP_DIR/storage.tar.gz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "storage.tar.gz contains an unsafe absolute or parent path" >&2
  exit 1
fi
tar tzf "$BACKUP_DIR/storage.tar.gz" >/dev/null

CURRENT_PROJECT="$(docker compose config | sed -n 's/^name:[[:space:]]*//p' | head -n 1)"
if [[ -z "$CURRENT_PROJECT" || ! "$CURRENT_PROJECT" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  echo "Could not resolve a safe Compose project name" >&2
  exit 1
fi
if [[ "$BACKUP_PROJECT" != "$CURRENT_PROJECT" ]]; then
  echo "Backup project '$BACKUP_PROJECT' does not match current Compose project '$CURRENT_PROJECT'" >&2
  exit 1
fi

MYSQL_VOLUME="${CURRENT_PROJECT}_mysql-data"
STORAGE_VOLUME="${CURRENT_PROJECT}_app-storage"
if [[ "$BACKUP_STORAGE_VOLUME" != "$STORAGE_VOLUME" ]]; then
  echo "Backup storage volume '$BACKUP_STORAGE_VOLUME' does not match target '$STORAGE_VOLUME'" >&2
  exit 1
fi

if [[ "$FORCE" -eq 1 && "$CONFIRM_PROJECT" != "$CURRENT_PROJECT" ]]; then
  echo "--force requires: --confirm-project $CURRENT_PROJECT" >&2
  exit 2
fi
if [[ "$FORCE" -eq 0 && -n "$CONFIRM_PROJECT" ]]; then
  echo "--confirm-project is only valid together with --force" >&2
  exit 2
fi

RUNNING_CONTAINERS="$(docker compose ps --status running -q)"
if [[ -n "$RUNNING_CONTAINERS" ]]; then
  echo "The target Compose project is running; stop it before restoring:" >&2
  echo "  docker compose down" >&2
  exit 1
fi

volume_nonempty() {
  local volume="$1"
  docker run --rm --volume "$volume:/data:ro" alpine:3.20 \
    sh -c 'test -n "$(find /data -mindepth 1 -maxdepth 1 -print -quit)"'
}

wipe_volume() {
  local volume="$1"
  docker run --rm --volume "$volume:/data" alpine:3.20 \
    sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'
}

MYSQL_VOLUME_CREATED=0
STORAGE_VOLUME_CREATED=0
if ! docker volume inspect "$MYSQL_VOLUME" >/dev/null 2>&1; then
  docker volume create \
    --label "com.docker.compose.project=$CURRENT_PROJECT" \
    --label 'com.docker.compose.volume=mysql-data' \
    "$MYSQL_VOLUME" >/dev/null
  MYSQL_VOLUME_CREATED=1
fi
if ! docker volume inspect "$STORAGE_VOLUME" >/dev/null 2>&1; then
  docker volume create \
    --label "com.docker.compose.project=$CURRENT_PROJECT" \
    --label 'com.docker.compose.volume=app-storage' \
    "$STORAGE_VOLUME" >/dev/null
  STORAGE_VOLUME_CREATED=1
fi

MYSQL_NONEMPTY=0
STORAGE_NONEMPTY=0
if volume_nonempty "$MYSQL_VOLUME"; then MYSQL_NONEMPTY=1; fi
if volume_nonempty "$STORAGE_VOLUME"; then STORAGE_NONEMPTY=1; fi
if [[ "$FORCE" -eq 0 && ("$MYSQL_NONEMPTY" -eq 1 || "$STORAGE_NONEMPTY" -eq 1) ]]; then
  echo "Target volumes are not empty; refusing to overwrite:" >&2
  [[ "$MYSQL_NONEMPTY" -eq 1 ]] && echo "  $MYSQL_VOLUME" >&2
  [[ "$STORAGE_NONEMPTY" -eq 1 ]] && echo "  $STORAGE_VOLUME" >&2
  echo "After verifying the target, use --force --confirm-project $CURRENT_PROJECT" >&2
  [[ "$MYSQL_VOLUME_CREATED" -eq 1 ]] && docker volume rm "$MYSQL_VOLUME" >/dev/null
  [[ "$STORAGE_VOLUME_CREATED" -eq 1 ]] && docker volume rm "$STORAGE_VOLUME" >/dev/null
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/benchu-restore.XXXXXX")"
STAGE_VOLUME="${CURRENT_PROJECT}_restore-stage-$$"
docker volume create "$STAGE_VOLUME" >/dev/null
MYSQL_SNAPSHOT=0
STORAGE_SNAPSHOT=0
MYSQL_STARTED=0
RESTORE_SUCCEEDED=0

cleanup() {
  local status=$?
  set +e
  if [[ "$MYSQL_STARTED" -eq 1 ]]; then
    docker compose stop mysql >/dev/null 2>&1
    docker compose rm -f mysql >/dev/null 2>&1
  fi
  if [[ "$status" -ne 0 && "$RESTORE_SUCCEEDED" -eq 0 ]]; then
    echo "Restore failed; rolling target volumes back..." >&2
    wipe_volume "$MYSQL_VOLUME" >/dev/null 2>&1
    wipe_volume "$STORAGE_VOLUME" >/dev/null 2>&1
    if [[ "$MYSQL_SNAPSHOT" -eq 1 ]]; then
      docker run --rm --volume "$MYSQL_VOLUME:/data" --volume "$WORK_DIR:/rollback:ro" alpine:3.20 \
        tar xzf /rollback/mysql-volume.tar.gz -C /data >/dev/null 2>&1
    elif [[ "$MYSQL_VOLUME_CREATED" -eq 1 ]]; then
      docker volume rm "$MYSQL_VOLUME" >/dev/null 2>&1
    fi
    if [[ "$STORAGE_SNAPSHOT" -eq 1 ]]; then
      docker run --rm --volume "$STORAGE_VOLUME:/data" --volume "$WORK_DIR:/rollback:ro" alpine:3.20 \
        tar xzf /rollback/storage-volume.tar.gz -C /data >/dev/null 2>&1
    elif [[ "$STORAGE_VOLUME_CREATED" -eq 1 ]]; then
      docker volume rm "$STORAGE_VOLUME" >/dev/null 2>&1
    fi
  fi
  docker volume rm "$STAGE_VOLUME" >/dev/null 2>&1
  rm -rf -- "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT

if [[ "$FORCE" -eq 1 ]]; then
  echo "Taking temporary rollback snapshots of target volumes..."
  if [[ "$MYSQL_NONEMPTY" -eq 1 ]]; then
    docker run --rm --volume "$MYSQL_VOLUME:/data:ro" --volume "$WORK_DIR:/rollback" alpine:3.20 \
      tar czf /rollback/mysql-volume.tar.gz -C /data .
    MYSQL_SNAPSHOT=1
  fi
  if [[ "$STORAGE_NONEMPTY" -eq 1 ]]; then
    docker run --rm --volume "$STORAGE_VOLUME:/data:ro" --volume "$WORK_DIR:/rollback" alpine:3.20 \
      tar czf /rollback/storage-volume.tar.gz -C /data .
    STORAGE_SNAPSHOT=1
  fi
fi

echo "Staging object storage archive..."
docker run --rm \
  --volume "$STAGE_VOLUME:/data" \
  --volume "$BACKUP_DIR:/backup:ro" \
  alpine:3.20 \
  tar xzf /backup/storage.tar.gz -C /data

wipe_volume "$MYSQL_VOLUME"
wipe_volume "$STORAGE_VOLUME"

echo "Starting an isolated MySQL service for SQL restore..."
docker compose up -d --no-deps mysql >/dev/null
MYSQL_STARTED=1
MYSQL_CONTAINER="$(docker compose ps -q mysql)"
if [[ -z "$MYSQL_CONTAINER" ]]; then
  echo "MySQL restore container was not created" >&2
  exit 1
fi

MYSQL_READY=0
for _ in {1..60}; do
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$MYSQL_CONTAINER" 2>/dev/null || true)"
  if [[ "$health" == "healthy" ]]; then
    MYSQL_READY=1
    break
  fi
  if [[ "$health" == "exited" || "$health" == "dead" ]]; then
    break
  fi
  sleep 2
done
if [[ "$MYSQL_READY" -ne 1 ]]; then
  echo "MySQL did not become healthy during restore" >&2
  docker compose logs --tail=80 mysql >&2 || true
  exit 1
fi

echo "Importing MySQL dump..."
docker compose exec -T mysql sh -c \
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' \
  < "$BACKUP_DIR/mysql.sql"

TABLE_COUNT="$(docker compose exec -T mysql sh -c \
  'exec mysql -N -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()"' \
  | tr -d '\r')"
if [[ ! "$TABLE_COUNT" =~ ^[0-9]+$ || "$TABLE_COUNT" -lt 1 ]]; then
  echo "Restored database contains no tables" >&2
  exit 1
fi

echo "Copying staged object storage into $STORAGE_VOLUME..."
docker run --rm \
  --volume "$STAGE_VOLUME:/source:ro" \
  --volume "$STORAGE_VOLUME:/data" \
  alpine:3.20 \
  sh -c 'cd /source && tar cf - . | tar xf - -C /data'

docker compose stop mysql >/dev/null
docker compose rm -f mysql >/dev/null
MYSQL_STARTED=0
RESTORE_SUCCEEDED=1

echo "Restore completed from: $BACKUP_DIR"
echo "Backup created at: $BACKUP_CREATED_AT"
echo "Database tables restored: $TABLE_COUNT"
echo "Start the full stack with: docker compose up -d"
