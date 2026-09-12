#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID == 0 ]] || { printf 'Root required\n' >&2; exit 1; }
[[ $# == 1 && $1 =~ ^sha-[0-9a-f]{40}$ ]] || { printf 'Invalid revision tag\n' >&2; exit 64; }
readonly TAG=$1
readonly ROOT=/opt/kinan_works
cd "$ROOT"
exec 9>/run/lock/kinan-deploy.lock
flock -n 9 || { printf 'Another deployment is active\n' >&2; exit 75; }
[[ -f .env.vps && ! -L .env.vps ]]
[[ $(stat -c %u .env.vps) == 0 ]]
install -d -m 700 /var/backups/kinan-works /var/lib/kinan-deploy
RUN=$(mktemp -d /var/backups/kinan-works/deploy-XXXXXXXX)
cp .env.vps "$RUN/environment.before"
# Never source an environment file as executable shell code.
python3 - "$TAG" "$RUN/environment.next" <<'PY'
import pathlib, sys
text = pathlib.Path('.env.vps').read_text()
lines = text.splitlines()
assert sum(line.startswith('IMAGE_TAG=') for line in lines) == 1, 'Expected one IMAGE_TAG'
pathlib.Path(sys.argv[2]).write_text('\n'.join('IMAGE_TAG='+sys.argv[1] if line.startswith('IMAGE_TAG=') else line for line in lines)+'\n')
PY
compose() { docker compose --project-directory "$ROOT" --env-file "$1" -f "$ROOT/docker-compose.vps.yml" "${@:2}"; }
compose "$RUN/environment.next" config --quiet
# Only these fixed images may be pulled; do not accept arbitrary registry input.
mapfile -t IMAGES < <(compose "$RUN/environment.next" config --images)
for component in api web; do
  expected="ghcr.io/rchmdndy/kinan_works-$component:$TAG"
  printf '%s\n' "${IMAGES[@]}" | grep -Fxq "$expected"
  docker pull "$expected"
  revision=$(docker image inspect "$expected" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  [[ $revision == "${TAG#sha-}" ]] || { printf 'Image revision label mismatch\n' >&2; exit 1; }
done
phase=before-stop
recover() {
  rc=$?
  if (( rc != 0 )); then
    if [[ $phase == stopped ]]; then
      # New code has not started: restarting the unchanged old API is safe.
      compose "$RUN/environment.before" start api || true
    fi
    printf 'Deployment failed (phase=%s). Backup: %s. No automatic database restore.\n' "$phase" "$RUN" >&2
  fi
}
trap recover EXIT
compose "$RUN/environment.before" stop -t 30 api
phase=stopped
# API is the sole SQLite writer. Refuse to create a fake empty backup.
python3 - "$RUN/database.sqlite" <<'PY'
import pathlib, sqlite3, sys
p = pathlib.Path('data/kinan.sqlite').resolve()
assert p.is_file(), 'Existing production database required'
with sqlite3.connect(p.as_uri()+'?mode=ro', uri=True) as source:
    with sqlite3.connect(sys.argv[1]) as target:
        source.backup(target)
        assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
PY
install -m 600 "$RUN/environment.next" .env.vps.next
mv .env.vps.next .env.vps
phase=new-code-may-have-migrated
compose .env.vps up -d --no-build --wait --wait-timeout 120
curl --fail --silent --show-error --max-time 20 https://growsense.my.id/ >/dev/null
compose .env.vps exec -T api bun -e 'const r=await fetch("http://127.0.0.1:3000/health");const b=await r.json();if(!r.ok||!b.ok||!b.redis)process.exit(1)'
printf '%s\n' "$TAG" > /var/lib/kinan-deploy/current-tag
printf '%s %s success backup=%s\n' "$(date -u +%FT%TZ)" "$TAG" "$RUN" >> /var/lib/kinan-deploy/history.log
phase=complete
printf 'Deployment succeeded: %s; backup: %s\n' "$TAG" "$RUN"
