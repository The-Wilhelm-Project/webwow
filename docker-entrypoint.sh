#!/bin/sh
# Webwow container entrypoint: run pending knex migrations, then start Next.js.
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[webwow] ERROR: DATABASE_URL is not set (e.g. postgresql://user:pass@db:5432/webwow)." >&2
  exit 1
fi

if [ -z "$PAGE_AUTH_SECRET" ] && [ -z "$AUTH_SECRET" ]; then
  echo "[webwow] WARNING: PAGE_AUTH_SECRET is not set - sessions will not survive a restart. Generate one with: openssl rand -hex 32" >&2
fi

# Wait for the database to accept connections (docker compose already waits for the
# db healthcheck, but a plain `docker run` or an external DB may still be starting).
attempt=1
max_attempts="${DB_WAIT_ATTEMPTS:-15}"
echo "[webwow] Running database migrations..."
until ./node_modules/.bin/knex migrate:latest --knexfile knexfile.ts; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "[webwow] ERROR: migrations failed after ${max_attempts} attempts, giving up." >&2
    exit 1
  fi
  echo "[webwow] Migration attempt ${attempt}/${max_attempts} failed - retrying in 3s..."
  attempt=$((attempt + 1))
  sleep 3
done
echo "[webwow] Migrations complete."

echo "[webwow] Starting Webwow on port ${PORT:-3002}..."
# next.config.ts sets output:'standalone'; `next start` logs a one-line warning about
# that, which is expected here (we ship the full node_modules for the knex CLI).
exec ./node_modules/.bin/next start -p "${PORT:-3002}"
