#!/usr/bin/env bash
# Runs ../zero_thought_node on :4000 against the SAME local database this
# service uses (DB_* from ./.env), with local Mongo and Redis, so the website,
# this backend and the IDE share one set of users on this machine.
# zero_thought_node/.env keeps its production values; the overrides below win
# because dotenv never replaces variables that are already set.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
platform="${PLATFORM_DIR:-$here/../zero_thought_node}"
[ -f "$here/.env" ] || { echo "missing $here/.env"; exit 1; }
[ -d "$platform" ] || { echo "missing $platform"; exit 1; }
val() { grep -E "^$1=" "$here/.env" | head -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'; }
export NODE_ENV=development PORT="${PORT:-4000}"
export DB_HOST="$(val DB_HOST)" DB_PORT="$(val DB_PORT)" DB_USER="$(val DB_USER)" DB_PASS="$(val DB_PASS)" DB_NAME="$(val DB_NAME)"
export MONGO_URI="${MONGO_URI:-mongodb://127.0.0.1:27017}" MONGO_REQUIRED=false
export REDIS_URL="" REDIS_HOST=127.0.0.1 REDIS_PORT=6379 REDIS_USERNAME="" REDIS_PASSWORD="" REDIS_TLS=false REDIS_REQUIRED=false
export JWT_SECRET="$(val JWT_SECRET)"
echo "zero_thought_node → http://localhost:$PORT  db=$DB_USER@$DB_HOST/$DB_NAME  (local mongo/redis)"
cd "$platform" && exec node index.js
