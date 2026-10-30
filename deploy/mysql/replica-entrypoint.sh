#!/bin/bash
# Bootstrap a read-only GTID replica. Steady state replaces this process with mysqld.
set -euo pipefail

MARKER=/var/lib/mysql/.replica-configured
DATADIR=/var/lib/mysql
SOURCE_HOST=mysql
SOURCE_PORT=3306

log() {
  printf '%s [mysql-replica] %s\n' "$(date --rfc-3339=seconds)" "$*"
}

if [ -z "${MYSQL_ROOT_PASSWORD:-}" ] || [ -z "${MYSQL_REPLICATION_PASSWORD:-}" ]; then
  log "MYSQL_ROOT_PASSWORD and MYSQL_REPLICATION_PASSWORD are required"
  exit 1
fi

REPL_USER=${MYSQL_REPLICATION_USER:-repl}
SOURCE_DB=${REPLICA_SOURCE_DATABASE:-benchu_canvas}

if ! [[ "$REPL_USER" =~ ^[A-Za-z0-9_]{1,32}$ ]]; then
  log "MYSQL_REPLICATION_USER must be a MySQL identifier"
  exit 1
fi
if ! [[ "$SOURCE_DB" =~ ^[A-Za-z0-9_]{1,64}$ ]]; then
  log "REPLICA_SOURCE_DATABASE must be a MySQL identifier"
  exit 1
fi

escape_sql() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/''/g"
}

mysql_exec() {
  local host="$1"
  shift
  mysql --protocol=tcp -h "$host" -P "$SOURCE_PORT" -uroot --password="$MYSQL_ROOT_PASSWORD" --batch --skip-column-names "$@"
}

mysql_scalar() {
  mysql_exec "$@" | tr -cd '0-9'
}

wait_ping() {
  local host="$1"
  local i
  for i in $(seq 1 90); do
    if mysqladmin --protocol=tcp -h "$host" -P "$SOURCE_PORT" -uroot --password="$MYSQL_ROOT_PASSWORD" ping --silent; then
      return 0
    fi
    sleep 2
  done
  log "timed out waiting for MySQL at ${host}"
  return 1
}

stop_mysqld() {
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

trap 'stop_mysqld; exit 143' TERM INT

# The image entrypoint applies every server flag to its temporary init server.
# super_read_only would reject that initialization, so the first boot strips it.
# Later boots keep the read-only flags passed in by Compose.
server_args=("$@")
if [ ! -d "$DATADIR/mysql" ]; then
  filtered=()
  for arg in "${server_args[@]}"; do
    case "$arg" in
      --read-only | --read-only=ON | --read-only=1 | --super-read-only | --super-read-only=ON | --super-read-only=1) ;;
      *) filtered+=("$arg") ;;
    esac
  done
  server_args=("${filtered[@]}")
fi

if [ -f "$MARKER" ]; then
  exec docker-entrypoint.sh mysqld "$@"
fi

docker-entrypoint.sh mysqld "${server_args[@]}" &
pid=$!

if ! wait_ping 127.0.0.1; then
  stop_mysqld
  exit 1
fi

schema_count="$(mysql_scalar 127.0.0.1 -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${SOURCE_DB}'")"
if [ "$schema_count" != "1" ]; then
  if ! wait_ping "$SOURCE_HOST"; then
    stop_mysqld
    exit 1
  fi
  primary_count="$(mysql_scalar "$SOURCE_HOST" -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${SOURCE_DB}'")"
  if [ "$primary_count" != "1" ]; then
    log "primary has no ${SOURCE_DB} database to clone"
    stop_mysqld
    exit 1
  fi

  repl_password="$(escape_sql "$MYSQL_REPLICATION_PASSWORD")"
  mysql_exec "$SOURCE_HOST" <<SQL
CREATE USER IF NOT EXISTS '${REPL_USER}'@'%' IDENTIFIED BY '${repl_password}';
ALTER USER '${REPL_USER}'@'%' IDENTIFIED BY '${repl_password}';
GRANT REPLICATION SLAVE, REPLICATION CLIENT, BACKUP_ADMIN ON *.* TO '${REPL_USER}'@'%';
FLUSH PRIVILEGES;
SQL
  if [ "$(mysql_scalar "$SOURCE_HOST" -e "SELECT COUNT(*) FROM information_schema.plugins WHERE PLUGIN_NAME='clone'")" != "1" ]; then
    mysql_exec "$SOURCE_HOST" -e "INSTALL PLUGIN clone SONAME 'mysql_clone.so'"
  fi
  if [ "$(mysql_scalar 127.0.0.1 -e "SELECT COUNT(*) FROM information_schema.plugins WHERE PLUGIN_NAME='clone'")" != "1" ]; then
    mysql_exec 127.0.0.1 -e "INSTALL PLUGIN clone SONAME 'mysql_clone.so'"
  fi
  mysql_exec 127.0.0.1 -e "SET GLOBAL clone_valid_donor_list='${SOURCE_HOST}:${SOURCE_PORT}'"

  log "cloning ${SOURCE_DB} from ${SOURCE_HOST}"
  set +e
  mysql_exec 127.0.0.1 -e "CLONE INSTANCE FROM '${REPL_USER}'@'${SOURCE_HOST}':${SOURCE_PORT} IDENTIFIED BY '${repl_password}' REQUIRE SSL"
  clone_status=$?
  set -e
  sleep 3
  if kill -0 "$pid" 2>/dev/null; then
    log "clone did not restart the recipient (client status ${clone_status})"
    stop_mysqld
    exit 1
  fi
  wait "$pid" || true
  log "clone restarted mysqld; container exit lets Docker start the copied data directory"
  exit 0
fi

local_uuid="$(mysql_exec 127.0.0.1 -e "SELECT @@server_uuid" | tr -d '[:space:]')"
donor_uuid="$(mysql_exec "$SOURCE_HOST" -e "SELECT @@server_uuid" | tr -d '[:space:]')"
if [ -n "$local_uuid" ] && [ "$local_uuid" = "$donor_uuid" ]; then
  log "recipient UUID matches the donor; resetting auto.cnf before replication setup"
  stop_mysqld
  rm -f "$DATADIR/auto.cnf"
  exit 0
fi

repl_password="$(escape_sql "$MYSQL_REPLICATION_PASSWORD")"
mysql_exec 127.0.0.1 -e "SET GLOBAL super_read_only=OFF; SET GLOBAL read_only=OFF;"
mysql_exec 127.0.0.1 -e "STOP REPLICA" || true
mysql_exec 127.0.0.1 <<SQL
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST='${SOURCE_HOST}',
  SOURCE_PORT=${SOURCE_PORT},
  SOURCE_USER='${REPL_USER}',
  SOURCE_PASSWORD='${repl_password}',
  SOURCE_AUTO_POSITION=1,
  SOURCE_SSL=1,
  GET_SOURCE_PUBLIC_KEY=1;
SQL
mysql_exec 127.0.0.1 -e "START REPLICA; SET GLOBAL read_only=ON; SET GLOBAL super_read_only=ON;"

for _ in $(seq 1 30); do
  healthy="$(mysql_scalar 127.0.0.1 -e "SELECT (@@global.read_only=1) AND (@@global.super_read_only=1) AND (SELECT COUNT(*) FROM performance_schema.replication_connection_status WHERE SERVICE_STATE='ON')>=1 AND (SELECT COUNT(*) FROM performance_schema.replication_applier_status WHERE SERVICE_STATE='ON')>=1 AND (SELECT COUNT(*) FROM performance_schema.replication_connection_configuration WHERE HOST='${SOURCE_HOST}')>=1")"
  if [ "$healthy" = "1" ]; then
    touch "$MARKER"
    log "replica is read-only and applying GTID events from ${SOURCE_HOST}"
    wait "$pid"
    exit 0
  fi
  sleep 2
done

log "replica did not become healthy"
stop_mysqld
exit 1
