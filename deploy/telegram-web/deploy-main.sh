#!/usr/bin/env bash
# Deploys a published private artifact to the Telegram Web loopback stack.
# Runs as root on the teagram LXC.
set -Eeuo pipefail

SHA=${DEPLOY_SHA:-}
ARTIFACT=${DEPLOY_ARTIFACT:-}
ROOT=/opt/telegram-web
RECORD_ROOT=/root
LOCK_FILE=/tmp/telegram-web-deploy.lock
BASE_URL=http://127.0.0.1:8080
BACKUP_ROOT="$ROOT/backups"
WORK_DIR=
VERIFY_IMAGE=
BACKUP_DIR=
RELEASE_DIR=
DEPLOYMENT_STARTED=false

fail() {
  printf '%s\n' "$*" >&2
  return 1
}

wait_for_stack() {
  local attempt health
  for attempt in {1..20}; do
    health=$(curl -q --noproxy '*' --silent --max-time 2 "$BASE_URL/healthz") || health=
    if [[ "$health" == ok ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

verify_served_release() {
  local expected_sha=$1 expected_digest=$2 http_status health served
  http_status=$(curl -q --noproxy '*' --silent --show-error --max-time 10 -o /dev/null -w '%{http_code}' "$BASE_URL/")
  if [[ "$http_status" != 200 ]]; then
    printf 'served / returned HTTP %s\n' "$http_status" >&2
    return 1
  fi
  health=$(curl -q --noproxy '*' --fail --silent --show-error --max-time 10 "$BASE_URL/healthz") || {
    printf 'health check request failed\n' >&2
    return 1
  }
  if [[ "$health" != ok ]]; then
    printf 'health check returned %s\n' "$health" >&2
    return 1
  fi
  served=$(curl -q --noproxy '*' --fail --silent --show-error --max-time 10 "$BASE_URL/mtproto-target.json") || {
    printf 'served artifact manifest request failed\n' >&2
    return 1
  }
  if ! jq -e -s --arg sha "$expected_sha" --arg digest "$expected_digest" '
    length == 1 and .[0].sourceCommit == $sha and .[0].artifactDigest == $digest
  ' <<<"$served" >/dev/null; then
    printf 'served manifest does not match source %s and digest %s\n' "$expected_sha" "$expected_digest" >&2
    return 1
  fi
}

cleanup() {
  local status=$?
  if [[ -n "$VERIFY_IMAGE" ]]; then
    docker image rm "$VERIFY_IMAGE" >/dev/null 2>&1 || true
  fi
  if [[ -n "$WORK_DIR" ]]; then
    rm -rf -- "$WORK_DIR"
  fi
  exit "$status"
}

rollback_on_error() {
  local status=$?
  trap - ERR
  if [[ "$DEPLOYMENT_STARTED" == true ]]; then
    printf 'deploy failed; rolling back to %s\n' "$LIVE_SHA" >&2
    if [[ -d "$ROOT/deploy/telegram-web" ]]; then
      (cd "$ROOT/deploy/telegram-web" && docker compose ps && docker compose logs --tail=50 web) >&2 || true
    fi
    if ! "$BACKUP_DIR/rollback.sh"; then
      printf 'rollback failed; run bash %s/rollback.sh\n' "$BACKUP_DIR" >&2
    fi
    if [[ -n "$RELEASE_DIR" ]]; then
      rm -rf -- "$RELEASE_DIR"
    fi
  fi
  exit "$status"
}

trap cleanup EXIT
trap rollback_on_error ERR

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'DEPLOY_SHA must be a full 40-hex commit SHA'
[[ -n "$ARTIFACT" && -f "$ARTIFACT" && ! -L "$ARTIFACT" ]] || fail 'DEPLOY_ARTIFACT must be a regular ZIP file'
[[ "$(id -u)" == 0 ]] || fail 'deploy-main.sh must run as root'

for command in curl docker flock git install jq sha256sum tar unzip; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is missing: $command"
done

mkdir -m 700 -p "$BACKUP_ROOT"
exec 9>"$LOCK_FILE"
flock -x 9
cd "$ROOT"
git cat-file -e "$SHA^{commit}"

LIVE_MANIFEST=$(curl -q --noproxy '*' --fail --silent --show-error --max-time 10 "$BASE_URL/mtproto-target.json")
LIVE_SHA=$(jq -er -s '
  if length == 1 and (.[0].sourceCommit | type == "string" and test("^[0-9a-f]{40}$"))
  then .[0].sourceCommit else error("served manifest source commit is invalid") end
' <<<"$LIVE_MANIFEST")
LIVE_CONTENT_DIGEST=$(jq -er -s '
  if length == 1 and (.[0].artifactDigest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  then .[0].artifactDigest else error("served manifest content digest is invalid") end
' <<<"$LIVE_MANIFEST")

if git merge-base --is-ancestor "$SHA" "$LIVE_SHA"; then
  if [[ "$LIVE_SHA" == "$SHA" ]]; then
    printf 'already at %s\n' "$SHA"
  else
    printf 'live is newer (%s), skipped %s\n' "$LIVE_SHA" "$SHA"
  fi
  exit 0
fi
git merge-base --is-ancestor "$LIVE_SHA" "$SHA" || fail "live source $LIVE_SHA is not an ancestor of $SHA; refusing"
git diff --quiet && git diff --cached --quiet || fail 'tracked changes exist in the deployment checkout; refusing'

TS=$(date -u +%Y%m%dT%H%M%SZ)
WORK_DIR=$(mktemp -d "$BACKUP_ROOT/.stage.XXXXXX")
VERIFY_CONTEXT="$WORK_DIR/verify-context"
mkdir -p "$WORK_DIR/dist-private" "$VERIFY_CONTEXT"
unzip -tq "$ARTIFACT" >/dev/null
unzip -q "$ARTIFACT" -d "$WORK_DIR/dist-private"
[[ -f "$WORK_DIR/dist-private/mtproto-target.json" && ! -L "$WORK_DIR/dist-private/mtproto-target.json" ]] || fail 'artifact manifest is missing or not a regular file'
CONTENT_DIGEST=$(jq -er -s --arg sha "$SHA" '
  if length == 1 and .[0].sourceCommit == $sha and
    (.[0].artifactDigest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  then .[0].artifactDigest else error("artifact manifest does not match DEPLOY_SHA") end
' "$WORK_DIR/dist-private/mtproto-target.json")
ARCHIVE_SHA256="sha256:$(sha256sum -- "$ARTIFACT" | awk '{print $1}')"

# Run the repository's Node verifier inside its checked-in verification image
# stage so the LXC does not need a Node runtime of its own.
git archive --format=tar "$SHA" \
  ci/private-mtproto-target.json \
  ci/private-mtproto-server-public.pem \
  scripts/mtproto-target.mjs \
  scripts/private-artifact-csp.mjs \
  scripts/private-artifact.mjs \
  scripts/private-artifact-release.mjs \
  scripts/verify-deployment-artifact.mjs \
  deploy/telegram-web/Dockerfile |
  tar -xf - -C "$VERIFY_CONTEXT"
mkdir -p "$VERIFY_CONTEXT/dist-private"
cp -a "$WORK_DIR/dist-private/." "$VERIFY_CONTEXT/dist-private/"
VERIFY_IMAGE="telegram-web:verify-${SHA:0:12}-${TS}"
docker build \
  --target artifact-verification \
  --build-arg "PRIVATE_ARTIFACT_COMMIT=$SHA" \
  --file "$VERIFY_CONTEXT/deploy/telegram-web/Dockerfile" \
  --tag "$VERIFY_IMAGE" \
  "$VERIFY_CONTEXT"
docker image rm "$VERIFY_IMAGE" >/dev/null
VERIFY_IMAGE=

PREVIOUS_SHA=$LIVE_SHA
BACKUP_DIR="$BACKUP_ROOT/pre-${PREVIOUS_SHA:0:7}-$TS"
mkdir -m 700 "$BACKUP_DIR"
cp -a "$ROOT/dist-private" "$BACKUP_DIR/dist-private"
OLD_IMAGE_ID=$(docker image inspect telegram-web:local --format '{{.Id}}')
BACKUP_IMAGE="telegram-web:rollback-${PREVIOUS_SHA:0:12}-${TS}"
docker image tag "$OLD_IMAGE_ID" "$BACKUP_IMAGE"

{
  printf '#!/usr/bin/env bash\n'
  printf 'ROOT=%q\n' "$ROOT"
  printf 'BACKUP_DIR=%q\n' "$BACKUP_DIR"
  printf 'PREVIOUS_SHA=%q\n' "$PREVIOUS_SHA"
  printf 'PREVIOUS_CONTENT_DIGEST=%q\n' "$LIVE_CONTENT_DIGEST"
  printf 'BACKUP_IMAGE=%q\n' "$BACKUP_IMAGE"
  printf 'BASE_URL=%q\n' "$BASE_URL"
  declare -f wait_for_stack
  declare -f verify_served_release
  cat <<'ROLLBACK'
set -Eeuo pipefail

git -C "$ROOT" checkout --detach "$PREVIOUS_SHA"
rm -rf -- "$ROOT/dist-private"
cp -a "$BACKUP_DIR/dist-private" "$ROOT/dist-private"
docker image tag "$BACKUP_IMAGE" telegram-web:local
(
  cd "$ROOT/deploy/telegram-web"
  export PRIVATE_ARTIFACT_COMMIT="$PREVIOUS_SHA"
  docker compose up --detach --no-build
)
wait_for_stack
verify_served_release "$PREVIOUS_SHA" "$PREVIOUS_CONTENT_DIGEST"
echo "rollback restored $PREVIOUS_SHA"
ROLLBACK
} >"$BACKUP_DIR/rollback.sh"
chmod 700 "$BACKUP_DIR/rollback.sh"

RELEASE_DIR="$RECORD_ROOT/telegram-web-${SHA:0:7}-$TS"
mkdir -m 700 "$RELEASE_DIR"
DEPLOYMENT_STARTED=true
git checkout --detach "$SHA"
rm -rf -- "$ROOT/dist-private"
mv "$WORK_DIR/dist-private" "$ROOT/dist-private"
(
  cd "$ROOT/deploy/telegram-web"
  export PRIVATE_ARTIFACT_COMMIT="$SHA"
  docker compose up --detach --build
)

wait_for_stack || fail 'deployment did not become healthy within 60 seconds'
verify_served_release "$SHA" "$CONTENT_DIGEST" || fail 'served release checks failed'

jq -n \
  --arg sourceCommit "$SHA" \
  --arg archiveSha256 "$ARCHIVE_SHA256" \
  --arg contentDigest "$CONTENT_DIGEST" \
  --arg url "https://teagram.tailaa4918.ts.net/?v=$SHA" \
  '{sourceCommit:$sourceCommit,archiveSha256:$archiveSha256,contentDigest:$contentDigest,url:$url}' \
  >"$RELEASE_DIR/release-record.json.tmp"
install -o root -g root -m 0444 "$RELEASE_DIR/release-record.json.tmp" "$RELEASE_DIR/release-record.json"
rm -f "$RELEASE_DIR/release-record.json.tmp"

DEPLOYMENT_STARTED=false
printf 'backup %s\n' "$BACKUP_DIR"
printf 'release record %s/release-record.json\n' "$RELEASE_DIR"
printf 'deployed %s\n' "$SHA"
