#!/usr/bin/env bash
# Deploys the committed HEAD of this repository to the EC2 host by hand, doing exactly
# what .github/workflows/deploy.yml does (use that once EC2_HOST / EC2_SSH_KEY secrets exist).
#
#   deploy/deploy-local.sh [host] [ssh-key-file] [login-user]
#   EC2_HOST / EC2_SSH_KEY_FILE / EC2_USER environment variables work too.
set -euo pipefail
HOST="${1:-${EC2_HOST:-13.201.83.68}}"
KEY="${2:-${EC2_SSH_KEY_FILE:-$HOME/Downloads/lo.pem}}"
LOGIN="${3:-${EC2_USER:-ubuntu}}"

cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Working tree has uncommitted changes; this deploys HEAD. Commit (or stash) first." >&2
  exit 1
fi
SHA="$(git rev-parse HEAD)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf '%s\n' "$SHA" > "$TMP/deployment-commit.txt"
tar czf "$TMP/ide-backend.tgz" index.js package.json package-lock.json .nvmrc ecosystem.config.js src scripts -C "$TMP" deployment-commit.txt
echo "Packaged $SHA ($(du -h "$TMP/ide-backend.tgz" | cut -f1))"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -i "$KEY")
ssh "${SSH_OPTS[@]}" "$LOGIN@$HOST" 'mkdir -p ~/releases'
scp "${SSH_OPTS[@]}" "$TMP/ide-backend.tgz" "$LOGIN@$HOST:releases/ide-backend.tgz"

ssh "${SSH_OPTS[@]}" "$LOGIN@$HOST" bash -s "$SHA" <<'REMOTE'
set -euo pipefail
sha="$1"
if [ ! -f "$HOME/ide-backend.env" ]; then
  echo "❌ $HOME/ide-backend.env not found (see deploy/README.md)"; exit 1
fi
release="$HOME/releases/$sha"
mkdir -p "$release"
tar xzf "$HOME/releases/ide-backend.tgz" -C "$release"
rm -f "$HOME/releases/ide-backend.tgz"
cp "$HOME/ide-backend.env" "$release/.env"
chmod 600 "$release/.env"
cd "$release"
npm ci --omit=dev
npm run env:check
npm run db:sync
ln -sfn "$release" "$HOME/ide-backend"
cd "$HOME/ide-backend"
if pm2 describe ide-backend > /dev/null 2>&1; then
  pm2 reload ecosystem.config.js --env production --update-env
  # pm2 keeps the cwd of the first `pm2 start`; a reload does not move it to the new release.
  running=$(pm2 jlist | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=a.find((x)=>x.name==="ide-backend");process.stdout.write(p&&p.pm2_env?p.pm2_env.pm_cwd||"":"")')
  if [ "$(readlink -f "$running" 2>/dev/null)" != "$(readlink -f "$release")" ]; then
    echo "pm2 was still running ${running:-<unknown>}; restarting from $release"
    pm2 delete ide-backend
    pm2 start ecosystem.config.js --env production
  fi
else
  pm2 start ecosystem.config.js --env production
fi
pm2 save
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4100/health/ready > /dev/null; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:4100/health/ready; echo
grep -q "$sha" deployment-commit.txt
running=$(pm2 jlist | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=a.find((x)=>x.name==="ide-backend");process.stdout.write(p&&p.pm2_env?p.pm2_env.pm_cwd||"":"")')
[ "$(readlink -f "$running")" = "$(readlink -f "$release")" ] || { echo "❌ pm2 is running $running, not $release"; exit 1; }
# keep the five newest releases
ls -1dt "$HOME"/releases/*/ | tail -n +6 | xargs -r rm -rf
echo "✅ Deployed $sha"
REMOTE

echo "Public check:"
curl -fsS "https://ide-api.atomesus.com/health"; echo
