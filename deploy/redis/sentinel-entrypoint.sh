#!/bin/sh
# Writable Sentinel config for the optional single-machine overlay.
# The monitored master name is redis. This process does not change REDIS_HOST.
set -eu

field() {
  printf '%s\n' "$1" | awk -v key="$2" 'prev == key { print; exit } { prev = $0 }'
}

if [ "${1:-}" = "healthcheck" ]; then
  output="$(redis-cli -p 26379 --raw SENTINEL MASTER redis)" || exit 1
  name="$(field "$output" name)"
  flags="$(field "$output" flags)"
  port="$(field "$output" port)"
  role="$(field "$output" role-reported)"
  slaves="$(field "$output" num-slaves)"
  address="$(field "$output" ip)"
  [ "$name" = "redis" ]
  [ "$port" = "6379" ]
  [ "$role" = "master" ]
  [ -n "$address" ]
  case "$flags" in
    *s_down*|*o_down*|*disconnected*)
      exit 1
      ;;
    *master*)
      ;;
    *)
      exit 1
      ;;
  esac
  [ "${slaves:-0}" -ge 1 ]
  exit 0
fi

config=/tmp/sentinel.conf
cat > "$config" <<'EOF'
port 26379
bind 0.0.0.0
protected-mode no
daemonize no
dir /tmp
sentinel resolve-hostnames yes
sentinel announce-hostnames yes
sentinel monitor redis redis 6379 1
sentinel down-after-milliseconds redis 10000
sentinel failover-timeout redis 60000
sentinel parallel-syncs redis 1
EOF

exec redis-sentinel "$config"
