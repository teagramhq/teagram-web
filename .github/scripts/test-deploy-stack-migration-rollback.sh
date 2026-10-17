#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
deploy_script="$repo_root/deploy/teagram-web/deploy-main.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

fail() {
  printf '%s\n' "$*" >&2
  if [[ -f "$tmp/deploy.log" ]]; then
    cat "$tmp/deploy.log" >&2
  fi
  exit 1
}

[[ "$(grep -Fxc 'ROOT=/opt/telegram-web' "$deploy_script")" == 1 ]] ||
  fail 'expected one fixed deployment root in deploy-main.sh'
[[ "$(grep -Fxc 'RECORD_ROOT=/root' "$deploy_script")" == 1 ]] ||
  fail 'expected one fixed release-record root in deploy-main.sh'
[[ "$(grep -Fxc 'LOCK_FILE=/tmp/teagram-web-deploy.lock' "$deploy_script")" == 1 ]] ||
  fail 'expected one fixed deployment lock path in deploy-main.sh'

deploy_root="$tmp/root"
record_root="$tmp/records"
mock_bin="$tmp/bin"
archive_root="$tmp/archive"
state_root="$tmp/state"
docker_log="$tmp/docker.log"
deploy_sha=1111111111111111111111111111111111111111
live_sha=2222222222222222222222222222222222222222
artifact_digest="sha256:$(printf '%064x' 7)"

mkdir -p "$deploy_root/deploy/teagram-web" "$record_root" \
  "$deploy_root/dist-private" "$mock_bin" "$archive_root/ci" \
  "$archive_root/scripts" "$archive_root/deploy/teagram-web" "$state_root"
printf 'old release\n' >"$deploy_root/dist-private/index.html"
printf 'name: teagram-web-edge\n' >"$deploy_root/deploy/teagram-web/compose.yaml"
cp "$repo_root/deploy/teagram-web/Dockerfile" "$archive_root/deploy/teagram-web/Dockerfile"
for path in \
  ci/private-mtproto-target.json \
  ci/private-mtproto-server-public.pem \
  scripts/mtproto-target.mjs \
  scripts/private-artifact-csp.mjs \
  scripts/private-artifact.mjs \
  scripts/private-artifact-release.mjs \
  scripts/verify-deployment-artifact.mjs; do
  : >"$archive_root/$path"
done

cat >"$mock_bin/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == -C ]]; then
  checkout_root=$2
  shift 2
else
  checkout_root=$PWD
fi

case "${1:-}" in
  cat-file)
    exit 0
    ;;
  merge-base)
    [[ "$2" == --is-ancestor ]] || exit 2
    [[ "$3" == "$TEST_LIVE_SHA" && "$4" == "$TEST_DEPLOY_SHA" ]]
    ;;
  diff)
    exit 0
    ;;
  archive)
    shift 3
    tar -C "$TEST_ARCHIVE_ROOT" -cf - "$@"
    ;;
  checkout)
    target_sha=${@: -1}
    if [[ "$target_sha" == "$TEST_LIVE_SHA" ]]; then
      rm -rf -- "$checkout_root/deploy/teagram-web"
      mkdir -p "$checkout_root/deploy/telegram-web"
      printf 'name: telegram-web\n' >"$checkout_root/deploy/telegram-web/compose.yaml"
    fi
    ;;
  *)
    printf 'unexpected git invocation: %s\n' "$*" >&2
    exit 2
    ;;
esac
SH

cat >"$mock_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

record() {
  printf '%s\t%s\n' "$PWD" "$*" >>"$TEST_DOCKER_LOG"
}

get_state() {
  cat "$TEST_STATE_ROOT/$1"
}

set_state() {
  printf '%s\n' "$2" >"$TEST_STATE_ROOT/$1"
}

record "$*"
case "${1:-}" in
  build)
    ;;
  image)
    ;;
  inspect)
    case "${3:-}" in
      *com.docker.compose.project*) printf 'telegram-web\n' ;;
      *Config.Image*) printf 'telegram-web:local\n' ;;
      *.Image*) printf 'sha256:old-image\n' ;;
      *) printf 'unexpected docker inspect format: %s\n' "${3:-}" >&2; exit 2 ;;
    esac
    ;;
  ps)
    if [[ "$*" == *publish=8080* ]]; then
      printf 'old-web\n'
    elif [[ "$*" == *project=telegram-web* && "$(get_state old-running)" == true ]]; then
      printf 'old-web\n'
    elif [[ "$*" == *project=telegram-web* && "$*" == *--all* && "$(get_state old-exists)" == true ]]; then
      printf 'old-web\n'
    fi
    ;;
  stop)
    set_state old-running false
    ;;
  rm)
    set_state old-exists false
    ;;
  compose)
    shift
    compose_command=${1:-}
    case "$compose_command" in
      build)
        ;;
      ps)
        if [[ "$PWD" == "$TEST_DEPLOY_ROOT/deploy/teagram-web" && "$*" == *--all* && "$(get_state new-exists)" == true ]]; then
          printf 'new-web\n'
        fi
        ;;
      stop)
        set_state new-running false
        ;;
      rm)
        set_state new-exists false
        ;;
      config)
        project_name=$(sed -n 's/^name: //p' "$PWD/compose.yaml")
        printf '{"name":"%s"}\n' "$project_name"
        ;;
      up)
        project_name=$(sed -n 's/^name: //p' "$PWD/compose.yaml")
        if [[ "$project_name" == teagram-web-edge ]]; then
          set_state new-exists true
          set_state new-running true
          set_state active-project "$project_name"
        else
          set_state old-exists true
          set_state old-running true
          set_state active-project "$project_name"
        fi
        ;;
      logs)
        ;;
      *)
        printf 'unexpected docker compose invocation: %s\n' "$*" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    printf 'unexpected docker invocation: %s\n' "$*" >&2
    exit 2
    ;;
esac
SH

cat >"$mock_bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

url=${!#}
case "$url" in
  */mtproto-target.json)
    printf '{"sourceCommit":"%s","artifactDigest":"%s"}\n' "$TEST_LIVE_SHA" "$TEST_ARTIFACT_DIGEST"
    ;;
  */healthz)
    if [[ "$(cat "$TEST_STATE_ROOT/active-project")" == teagram-web-edge ]]; then
      printf 'unhealthy\n'
    else
      printf 'ok\n'
    fi
    ;;
  */)
    [[ "$*" == *'%{http_code}'* ]] || { printf 'unexpected root check: %s\n' "$*" >&2; exit 2; }
    printf '200'
    ;;
  *)
    printf 'unexpected curl URL: %s\n' "$url" >&2
    exit 2
    ;;
esac
SH

cat >"$mock_bin/id" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == -u ]]; then
  printf '0\n'
else
  exec /usr/bin/id "$@"
fi
SH

cat >"$mock_bin/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$mock_bin/unzip" <<'PY'
#!/usr/bin/env python3
import sys
import zipfile

if sys.argv[1] == '-tq':
    with zipfile.ZipFile(sys.argv[2]) as archive:
        sys.exit(archive.testzip() is not None)
elif sys.argv[1] == '-q' and sys.argv[3] == '-d':
    with zipfile.ZipFile(sys.argv[2]) as archive:
        archive.extractall(sys.argv[4])
else:
    print(f'unexpected unzip invocation: {sys.argv[1:]}', file=sys.stderr)
    sys.exit(2)
PY
chmod +x "$mock_bin/git" "$mock_bin/docker" "$mock_bin/curl" "$mock_bin/id" \
  "$mock_bin/sleep" "$mock_bin/unzip"

printf 'true\n' >"$state_root/old-exists"
printf 'true\n' >"$state_root/old-running"
printf 'false\n' >"$state_root/new-exists"
printf 'false\n' >"$state_root/new-running"
printf 'telegram-web\n' >"$state_root/active-project"
: >"$docker_log"

artifact_dir="$tmp/artifact"
mkdir -p "$artifact_dir"
jq -n --arg sha "$deploy_sha" --arg digest "$artifact_digest" \
  '{sourceCommit:$sha,artifactDigest:$digest}' >"$artifact_dir/mtproto-target.json"
artifact="$tmp/private-artifact.zip"
python3 - "$artifact_dir/mtproto-target.json" "$artifact" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[2], 'w') as archive:
    archive.write(sys.argv[1], 'mtproto-target.json')
PY

test_script="$tmp/deploy-main.sh"
sed \
  -e "s|^ROOT=/opt/telegram-web$|ROOT=$deploy_root|" \
  -e "s|^RECORD_ROOT=/root$|RECORD_ROOT=$record_root|" \
  -e "s|^LOCK_FILE=/tmp/teagram-web-deploy.lock$|LOCK_FILE=$tmp/deploy.lock|" \
  "$deploy_script" >"$test_script"
chmod +x "$test_script"

export PATH="$mock_bin:$PATH"
export TEST_DEPLOY_ROOT="$deploy_root" TEST_STATE_ROOT="$state_root" TEST_DOCKER_LOG="$docker_log"
export TEST_ARCHIVE_ROOT="$archive_root" TEST_DEPLOY_SHA="$deploy_sha" TEST_LIVE_SHA="$live_sha"
export TEST_ARTIFACT_DIGEST="$artifact_digest"
export DEPLOY_SHA="$deploy_sha" DEPLOY_ARTIFACT="$artifact"

if bash "$test_script" >"$tmp/deploy.log" 2>&1; then
  fail 'the simulated new project unexpectedly became healthy'
fi
grep -Fq "deploy failed; rolling back to $live_sha" "$tmp/deploy.log" ||
  fail 'the deployment failure did not start rollback'
grep -Fq "rollback restored $live_sha" "$tmp/deploy.log" ||
  fail 'the rollback did not report restoring the previous release'
if grep -Fq 'rollback failed' "$tmp/deploy.log"; then
  fail 'the rollback reported a failure'
fi

line_old_stop=$(grep -nF $'\tstop --time 60 old-web' "$docker_log" | head -n 1 | cut -d: -f1)
line_old_remove=$(grep -nF $'\trm old-web' "$docker_log" | head -n 1 | cut -d: -f1)
line_new_start=$(grep -nF "$deploy_root/deploy/teagram-web"$'\tcompose up --detach --no-build' "$docker_log" | head -n 1 | cut -d: -f1)
line_new_stop=$(grep -nF "$deploy_root/deploy/teagram-web"$'\tcompose stop --timeout 60 web' "$docker_log" | head -n 1 | cut -d: -f1)
line_new_remove=$(grep -nF "$deploy_root/deploy/teagram-web"$'\tcompose rm --force web' "$docker_log" | head -n 1 | cut -d: -f1)
line_old_start=$(grep -nF "$deploy_root/deploy/telegram-web"$'\tcompose up --detach --no-build' "$docker_log" | head -n 1 | cut -d: -f1)
grep -Fq "$deploy_root"$'\tps --quiet --filter label=com.docker.compose.project=telegram-web --filter label=com.docker.compose.service=web' "$docker_log" ||
  fail 'the old project container lookup did not target the inspected Compose project'
[[ -n "$line_old_stop" && -n "$line_old_remove" && -n "$line_new_start" && -n "$line_new_stop" &&
  -n "$line_new_remove" && -n "$line_old_start" ]] || fail 'Docker did not record each migration and rollback operation'
(( line_old_stop < line_old_remove && line_old_remove < line_new_start && line_new_start < line_new_stop &&
  line_new_stop < line_new_remove && line_new_remove < line_old_start )) ||
  fail 'Docker operations did not remove the old project, start the new project, then restore the old project'

[[ "$(cat "$state_root/active-project")" == telegram-web ]] || fail 'rollback did not select the previous Compose project'
[[ "$(cat "$state_root/old-exists")" == true && "$(cat "$state_root/old-running")" == true ]] ||
  fail 'rollback did not restart the old web container'
[[ "$(cat "$state_root/new-exists")" == false && "$(cat "$state_root/new-running")" == false ]] ||
  fail 'rollback left the renamed web container behind'
[[ "$(cat "$deploy_root/dist-private/index.html")" == 'old release' ]] ||
  fail 'rollback did not restore the previous private artifact'
grep -Fq 'image tag teagram-web:rollback-' "$docker_log" || fail 'rollback image was not tagged for restoration'
grep -Fq ' telegram-web:local' "$docker_log" || fail 'rollback did not restore the previous image tag'

printf 'mocked Docker migration and rollback passed\n'
