#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
deploy_script="$repo_root/.github/scripts/deploy-k8s-web.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

run_case() {
  local case_name="$1" expected_failure="$2"
  local log="$tmp/$case_name.log" output="$tmp/$case_name.output"
  local bin="$tmp/$case_name-bin" manifest="$tmp/$case_name.yaml"
  local script_status=0
  mkdir -p "$bin"
  printf 'image: %s\n' "$deploy_image" >"$manifest"

  cat >"$bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$KUBECTL_LOG"

case "$1 $2" in
  'rollout status')
    count=0
    if [[ -f "$STATUS_COUNT_FILE" ]]; then
      count="$(cat "$STATUS_COUNT_FILE")"
    fi
    count=$((count + 1))
    printf '%s\n' "$count" >"$STATUS_COUNT_FILE"
    if [[ "${TEST_FAILURE:-}" == status && "$count" -eq 3 ]]; then
      exit 1
    fi
    ;;
  'rollout undo')
    : >"$ROLLBACK_STARTED_FILE"
    if [[ "${TEST_FAILURE:-}" == undo ]]; then
      exit 1
    fi
    ;;
  'apply --dry-run=server') ;;
  'apply --filename')
    if [[ "${TEST_FAILURE:-}" == signal ]]; then
      kill -TERM "$PPID"
    fi
    ;;
  'get deployment/teagram-web')
    count=0
    if [[ -f "$GET_COUNT_FILE" ]]; then
      count="$(cat "$GET_COUNT_FILE")"
    fi
    count=$((count + 1))
    printf '%s\n' "$count" >"$GET_COUNT_FILE"
    if [[ "$count" -eq 2 && "${TEST_FAILURE:-}" == read ]]; then
      printf '{\n'
      exit 0
    fi
    image="$OLD_IMAGE"
    if [[ "$count" -eq 2 && "${TEST_FAILURE:-}" != image && ! -f "$ROLLBACK_STARTED_FILE" ]]; then
      image="$DEPLOY_IMAGE"
    fi
    jq -n --arg image "$image" '{metadata:{annotations:{"deployment.kubernetes.io/revision":"7"}},spec:{template:{spec:{containers:[{name:"teagram-web",image:$image}]}}}}'
    ;;
  *)
    printf 'unexpected kubectl invocation: %s\n' "$*" >&2
    exit 2
    ;;
esac
SH
  cat >"$bin/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'node %s\n' "$*" >>"$KUBECTL_LOG"
exit 1
SH
  chmod +x "$bin/kubectl" "$bin/node"

  if PATH="$bin:$PATH" \
    KUBECTL_LOG="$log" \
    STATUS_COUNT_FILE="$tmp/$case_name-status-count" \
    GET_COUNT_FILE="$tmp/$case_name-get-count" \
    ROLLBACK_STARTED_FILE="$tmp/$case_name-rollback-started" \
    OLD_IMAGE="$old_image" DEPLOY_IMAGE="$deploy_image" TEST_FAILURE="$expected_failure" \
    bash "$deploy_script" "$manifest" "$deploy_sha" "$artifact_digest" "$deploy_image" \
      http://127.0.0.1:18080/ >"$output" 2>&1; then
    fail "$case_name unexpectedly succeeded"
  else
    script_status=$?
  fi

  if [[ "$expected_failure" == signal && "$script_status" != 143 ]]; then
    cat "$output" >&2
    cat "$log" >&2
    fail "TERM must exit with status 143 after rollback; got $script_status"
  fi

  if ! grep -Fqx 'rollout undo deployment/teagram-web --namespace teagram --to-revision=7' "$log"; then
    cat "$output" >&2
    fail "$case_name did not roll back to the previous revision"
  fi

  if [[ "$expected_failure" == undo ]]; then
    grep -Fq 'rollout=rollback-failed stage=undo previous_revision=7' "$output" ||
      fail "$case_name did not identify the failed undo stage"
    grep -Fq 'manual recovery: kubectl rollout undo deployment/teagram-web --namespace teagram --to-revision=7' "$output" ||
      fail "$case_name omitted the manual recovery command"
  elif [[ "$expected_failure" == status ]]; then
    grep -Fq 'rollout=rollback-failed stage=status previous_revision=7' "$output" ||
      fail "$case_name did not identify the failed rollback status stage"
    grep -Fq 'manual recovery: kubectl rollout undo deployment/teagram-web --namespace teagram --to-revision=7' "$output" ||
      fail "$case_name omitted the manual recovery command"
  else
    grep -Fq 'rollout=rollback-verified previous_revision=7' "$output" ||
      fail "$case_name did not verify the restored deployment"
  fi

  local undo_count
  undo_count="$(grep -Fc 'rollout undo deployment/teagram-web' "$log")"
  [[ "$undo_count" == 1 ]] || fail "$case_name ran rollback $undo_count times instead of once"
}

printf -v deploy_sha '%040d' 1
printf -v artifact_digest 'sha256:%064d' 2
old_image='ghcr.io/teagramhq/teagram-web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
deploy_image='ghcr.io/teagramhq/teagram-web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

run_case smoke smoke
run_case image image
run_case read read
run_case signal signal
run_case undo undo
run_case status status

printf 'k3s web deployment rollback behavior holds\n'
