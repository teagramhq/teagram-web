#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
deploy_script="$repo_root/.github/scripts/deploy-k8s-web.sh"
real_jq="$(command -v jq)"
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
  local -a run_deploy=(bash)
  if [[ "$expected_failure" == jq-* ]]; then
    run_deploy=(timeout --kill-after=2s 12s bash)
  fi
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
    if [[ ( "${TEST_FAILURE:-}" == rollout || "${TEST_FAILURE:-}" == diagnostics || "${TEST_FAILURE:-}" == events || "${TEST_FAILURE:-}" == timeout || "${TEST_FAILURE:-}" == jq-* ) && "$count" -eq 2 ]]; then
      exit 1
    fi
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
  'get pods')
    if [[ "${TEST_FAILURE:-}" == timeout ]]; then
      sleep 20
    fi
    if [[ "${TEST_FAILURE:-}" == diagnostics ]]; then
      echo 'pod diagnostics unavailable' >&2
      exit 1
    fi
    cat <<'JSON'
{"items":[{"metadata":{"name":"teagram-web-new"},"spec":{"nodeName":"node-1","containers":[{"env":[{"name":"PRIVATE","value":"literal-value-must-not-be-logged"}]}]},"status":{"phase":"Pending","containerStatuses":[{"name":"teagram-web","state":{"waiting":{"reason":"ImagePullBackOff","message":"image unavailable"}},"lastState":{"terminated":{"reason":"Error","exitCode":1,"message":"literal-termination-must-not-be-logged"}}}]}},{"metadata":{"name":"teagram-web-old","deletionTimestamp":"2026-11-15T18:37:10Z","finalizers":["example.test/cleanup"]},"status":{"phase":"Running"}}]}
JSON
    ;;
  'get events')
    if [[ "${TEST_FAILURE:-}" == events ]]; then
      echo 'event diagnostics unavailable' >&2
      exit 1
    fi
    cat <<'JSON'
{"items":[{"involvedObject":{"name":"teagram-web-new","kind":"Pod"},"reason":"FailedCreatePodSandBox","message":"sandbox failed"},{"involvedObject":{"name":"postgres-private","kind":"Pod"},"reason":"Private","message":"not-web-private-value"}]}
JSON
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
  cat >"$bin/jq" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == -c ]]; then
  if [[ "${TEST_FAILURE:-}" == jq-pods && "${2:-}" == *'def container_status'* ]] ||
    [[ "${TEST_FAILURE:-}" == jq-events && "${2:-}" == *'involvedObject.name'* ]]; then
    printf 'jq:stall=%s\n' "$TEST_FAILURE" >>"$KUBECTL_LOG"
    trap '' TERM
    sleep 30 &
    sleep_pid=$!
    printf '%s %s\n' "$$" "$sleep_pid" >"$JQ_PIDS_FILE"
    wait "$sleep_pid"
  fi
fi
exec "$REAL_JQ" "$@"
SH
  cat >"$bin/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'node %s\n' "$*" >>"$KUBECTL_LOG"
exit 1
SH
  chmod +x "$bin/kubectl" "$bin/jq" "$bin/node"

  if PATH="$bin:$PATH" \
    KUBECTL_LOG="$log" \
    STATUS_COUNT_FILE="$tmp/$case_name-status-count" \
    GET_COUNT_FILE="$tmp/$case_name-get-count" \
    ROLLBACK_STARTED_FILE="$tmp/$case_name-rollback-started" \
    REAL_JQ="$real_jq" \
    JQ_PIDS_FILE="$tmp/$case_name-jq-pids" \
    OLD_IMAGE="$old_image" DEPLOY_IMAGE="$deploy_image" TEST_FAILURE="$expected_failure" \
    "${run_deploy[@]}" "$deploy_script" "$manifest" "$deploy_sha" "$artifact_digest" "$deploy_image" \
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

  if [[ "$expected_failure" == jq-* ]]; then
    grep -Fqx "jq:stall=$expected_failure" "$log" || fail "$case_name did not exercise the stalled filter"
    local jq_pid sleep_pid pid process_state live_filter=false
    read -r jq_pid sleep_pid <"$tmp/$case_name-jq-pids"
    for pid in "$jq_pid" "$sleep_pid"; do
      process_state="$(ps -o stat= -p "$pid" || true)"
      process_state="${process_state//[[:space:]]/}"
      if [[ -n "$process_state" && "$process_state" != Z* ]]; then
        kill -KILL "$jq_pid" "$sleep_pid" 2>/dev/null || true
        live_filter=true
        break
      fi
    done
    [[ "$script_status" == 1 ]] || fail "$case_name did not bound the stalled JSON filter (exit $script_status)"
    [[ "$live_filter" == false ]] || fail "$case_name left a stalled filter process running"
  fi

  if [[ "$expected_failure" == rollout || "$expected_failure" == diagnostics || "$expected_failure" == events || "$expected_failure" == timeout || "$expected_failure" == jq-* ]]; then
    if [[ "$expected_failure" == events ]]; then
      grep -Fq 'event diagnostics unavailable' "$output" || fail "$case_name hid the event read failure"
    elif [[ "$expected_failure" == jq-events ]]; then
      grep -Fq 'could not collect pod events' "$output" || fail "$case_name hid the event filter timeout"
    else
      grep -Fq 'FailedCreatePodSandBox' "$output" || fail "$case_name did not report web pod events"
    fi
    if [[ "$expected_failure" == timeout || "$expected_failure" == jq-pods ]]; then
      grep -Fq 'could not collect pod diagnostics' "$output" || fail "$case_name hid the diagnostic timeout"
    elif [[ "$expected_failure" != diagnostics ]]; then
      grep -Fq 'ImagePullBackOff' "$output" || fail "$case_name did not report web pod status"
      grep -Fq '"deletionTimestamp":"2026-11-15T18:37:10Z"' "$output" ||
        fail "$case_name did not report the terminating pod timestamp"
      grep -Fq '"finalizers":["example.test/cleanup"]' "$output" ||
        fail "$case_name did not report the terminating pod finalizers"
    else
      grep -Fq 'pod diagnostics unavailable' "$output" || fail "$case_name hid the diagnostic failure"
    fi
    if grep -Eq 'not-web-private-value|literal-value-must-not-be-logged|literal-termination-must-not-be-logged' "$output"; then
      fail "$case_name exposed unrelated events, pod environment values, or termination logs"
    fi
    local events_line undo_line
    events_line="$(grep -n '^get events ' "$log" | cut -d: -f1)"
    undo_line="$(grep -n '^rollout undo ' "$log" | cut -d: -f1)"
    [[ -n "$events_line" && "$events_line" -lt "$undo_line" ]] ||
      fail "$case_name did not collect events before rollback"
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

run_case jq_pods jq-pods
run_case jq_events jq-events
run_case smoke smoke
run_case image image
run_case read read
run_case signal signal
run_case undo undo
run_case status status
run_case rollout rollout
run_case diagnostics diagnostics
run_case events events
run_case timeout timeout

printf 'k3s web deployment rollback behavior holds\n'
