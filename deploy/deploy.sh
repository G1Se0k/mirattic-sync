#!/bin/sh
# Runs on the deploy host after CI has `docker load`ed mirattic-sync-server:<tag>:
#   sh ~/Documents/mirattic-sync/deploy/deploy.sh <tag>
# Switches :current to the new image and rolls back if the health check fails.
set -eu
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd "$(dirname "$0")"
image=mirattic-sync-server

if [ ! -f .env ]; then
  # First deploy: generate the secrets here so they never leave the host.
  umask 077
  {
    echo "DB_PASSWORD=$(openssl rand -hex 24)"
    echo "MYSQL_ROOT_PASSWORD=$(openssl rand -hex 24)"
    echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
    echo "ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost,chrome-extension://kphihploboaigagpahhdhjiaglnfmpii"
  } > .env
fi

previous=$(docker image inspect -f '{{.Id}}' "$image:current" 2>/dev/null || true)
docker tag "$image:$1" "$image:current"
docker compose up -d

for _ in $(seq 60); do
  if curl -fsS http://127.0.0.1:8090/actuator/health >/dev/null 2>&1; then
    echo "deployed $1"
    # Keep the five newest tagged images for manual rollback.
    docker images "$image" --format '{{.Tag}}' | grep -v '^current$' | tail -n +6 | xargs -I{} docker rmi "$image:{}" >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done

echo "health check failed for $1" >&2
docker compose logs --tail 80 server >&2
if [ -n "$previous" ]; then
  docker tag "$previous" "$image:current"
  docker compose up -d
  echo "rolled back" >&2
fi
exit 1
