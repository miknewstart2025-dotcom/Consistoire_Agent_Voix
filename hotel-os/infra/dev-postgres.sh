#!/usr/bin/env bash
# Local PostgreSQL for development and integration tests (no Docker needed).
# Data dir: .dev-pg (git-ignored). Port 54329.
#   owner role : hotelos_owner / hotelos_owner  (runs migrations)
#   app login  : hotelos_api   / hotelos_api    (member of hotelos_app, subject to RLS)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA="$ROOT/.dev-pg"
PORT="${PGPORT:-54329}"
# initdb/pg_ctl refuse to run as root: delegate to the 'postgres' system user when needed.
AS=()
if [ "$(id -u)" = "0" ]; then AS=(runuser -u postgres --); mkdir -p "$DATA"; chown postgres "$DATA"; fi
case "${1:-start}" in
  start)
    if [ ! -f "$DATA/PG_VERSION" ]; then
      "${AS[@]}" "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
    fi
    if ! "${AS[@]}" "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      "${AS[@]}" "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/server.log" -w start >/dev/null
    fi
    psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hotelos_owner') THEN CREATE ROLE hotelos_owner LOGIN PASSWORD 'hotelos_owner' CREATEDB; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hotelos_app') THEN CREATE ROLE hotelos_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hotelos_api') THEN CREATE ROLE hotelos_api LOGIN PASSWORD 'hotelos_api' IN ROLE hotelos_app; END IF;
END \$\$;
SQL
    psql -h 127.0.0.1 -p "$PORT" -U postgres -tAc "select 1 from pg_database where datname='hotelos'" | grep -q 1 \
      || psql -h 127.0.0.1 -p "$PORT" -U postgres -qc "create database hotelos owner hotelos_owner"
    echo "postgres ready on 127.0.0.1:$PORT"
    ;;
  stop) "${AS[@]}" "$PGBIN/pg_ctl" -D "$DATA" stop -m fast ;;
  *) echo "usage: $0 start|stop"; exit 1 ;;
esac
