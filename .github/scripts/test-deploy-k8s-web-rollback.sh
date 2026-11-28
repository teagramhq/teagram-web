#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
deploy_script="$repo_root/.github/scripts/deploy-k8s-web.sh"
real_jq="$(command -v jq)"
real_sleep="$(command -v sleep)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

run_case() {
  local case_name="$1" expected_failure="$2" expected_result="${3:-failure}"
  local verification_route=public verification_label=rollout smoke_url='http://127.0.0.1:18080/'
  local log="$tmp/$case_name.log" output="$tmp/$case_name.output"
  local bin="$tmp/$case_name-bin" manifest="$tmp/$case_name.yaml"
  local script_status=0
  local -a run_deploy=(bash)
  if [[ "$case_name" == fallback_* ]]; then
    verification_route=fallback
    verification_label=fallback
    smoke_url='http://127.0.0.1:18080/api/v1/namespaces/teagram/services/teagram-web/proxy/'
  fi
  if [[ "$expected_failure" == jq-* ]]; then
    run_deploy=(timeout --kill-after=2s 12s bash)
  fi
  mkdir -p "$bin" "$tmp/$case_name-runner-temp"
  printf 'image: %s\n' "$deploy_image" >"$manifest"

  cat >"$bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$KUBECTL_LOG"

stall_output() {
  trap '' TERM
  printf '%s\n' "$$" >"$KUBECTL_PID_FILE"
  while :; do printf 'blocked diagnostic output\n'; done
}

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
    if [[ "${TEST_FAILURE:-}" == fallback-probe && ! -f "$API_PROXY_CLEANUP_FILE" ]]; then
      echo 'Kubernetes API proxy was not cleaned up before rollback' >&2
      exit 1
    fi
    : >"$ROLLBACK_STARTED_FILE"
    if [[ "${TEST_FAILURE:-}" == undo ]]; then
      exit 1
    fi
    ;;
  'proxy --address')
    printf '%s\n' "$$" >"$API_PROXY_PID_FILE"
    if [[ "${TEST_FAILURE:-}" == fallback-probe ]]; then
      printf 'kubectl proxy: serving the fallback service route\n' >&2
    fi
    trap 'printf cleaned >"$API_PROXY_CLEANUP_FILE"; exit 0' TERM INT
    while :; do read -r -t 1 _ || true; done
    ;;
  'apply --dry-run=server') ;;
  'apply --filename')
    if [[ "${TEST_FAILURE:-}" == signal ]]; then
      kill -TERM "$PPID"
    fi
    ;;
  'get pods')
    if [[ "${TEST_FAILURE:-}" == jq-pods ]]; then
      stall_output
    fi
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
    if [[ "${TEST_FAILURE:-}" == jq-events ]]; then
      stall_output
    fi
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
  cat >"$bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"$KUBECTL_LOG"
if [[ "${TEST_FAILURE:-}" == fallback-probe ]]; then
  printf 'curl: simulated service proxy connection reset\n' >&2
  exit 22
fi
printf 'ok'
SH
  cat >"$bin/sleep" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${TEST_FAILURE:-}" == fallback-probe ]]; then
  exit 0
fi
exec "$REAL_SLEEP" "$@"
SH
  cat >"$bin/jq" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == -c ]]; then
  if [[ "${TEST_FAILURE:-}" == jq-pods && "${2:-}" == *'def container_status'* ]] ||
    [[ "${TEST_FAILURE:-}" == jq-events && "${2:-}" == *'involvedObject.name'* ]]; then
    printf 'jq:stall=%s\n' "$TEST_FAILURE" >>"$KUBECTL_LOG"
    trap '' TERM
    printf '%s\n' "$$" >"$JQ_PID_FILE"
    exec sleep 30
  fi
fi
exec "$REAL_JQ" "$@"
SH
  cat >"$bin/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'node %s\n' "$*" >>"$KUBECTL_LOG"
if [[ "${TEST_FAILURE:-}" == fallback-ready ]]; then
  exit 0
fi
exit 1
SH
  chmod +x "$bin/kubectl" "$bin/curl" "$bin/sleep" "$bin/jq" "$bin/node"

  if PATH="$bin:$PATH" \
    KUBECTL_LOG="$log" \
    RUNNER_TEMP="$tmp/$case_name-runner-temp" \
    STATUS_COUNT_FILE="$tmp/$case_name-status-count" \
    GET_COUNT_FILE="$tmp/$case_name-get-count" \
    ROLLBACK_STARTED_FILE="$tmp/$case_name-rollback-started" \
    API_PROXY_PID_FILE="$tmp/$case_name-api-proxy-pid" \
    API_PROXY_CLEANUP_FILE="$tmp/$case_name-api-proxy-cleanup" \
    REAL_JQ="$real_jq" REAL_SLEEP="$real_sleep" \
    JQ_PID_FILE="$tmp/$case_name-jq-pid" \
    KUBECTL_PID_FILE="$tmp/$case_name-kubectl-pid" \
    OLD_IMAGE="$old_image" DEPLOY_IMAGE="$deploy_image" TEST_FAILURE="$expected_failure" \
    VERIFY_ROUTE="$verification_route" VERIFY_LABEL="$verification_label" \
    "${run_deploy[@]}" "$deploy_script" "$manifest" "$deploy_sha" "$artifact_digest" "$deploy_image" \
      "$smoke_url" >"$output" 2>&1; then
    script_status=0
  else
    script_status=$?
  fi

  if [[ "$expected_result" == success ]]; then
    [[ "$script_status" == 0 ]] || {
      cat "$output" >&2
      cat "$log" >&2
      fail "$case_name failed with exit status $script_status"
    }
  else
    [[ "$script_status" != 0 ]] || fail "$case_name unexpectedly succeeded"
  fi

  if [[ "$expected_failure" == signal && "$script_status" != 143 ]]; then
    cat "$output" >&2
    cat "$log" >&2
    fail "TERM must exit with status 143 after rollback; got $script_status"
  fi

  if [[ "$expected_failure" == jq-* ]]; then
    grep -Fqx "jq:stall=$expected_failure" "$log" || fail "$case_name did not exercise the stalled filter"
    local jq_pid kubectl_pid pid process_state live_diagnostic=false
    read -r jq_pid <"$tmp/$case_name-jq-pid"
    read -r kubectl_pid <"$tmp/$case_name-kubectl-pid"
    for pid in "$jq_pid" "$kubectl_pid"; do
      process_state="$(ps -o stat= -p "$pid" || true)"
      process_state="${process_state//[[:space:]]/}"
      if [[ -n "$process_state" && "$process_state" != Z* ]]; then
        kill -KILL "$jq_pid" "$kubectl_pid" 2>/dev/null || true
        live_diagnostic=true
        break
      fi
    done
    [[ "$script_status" == 1 ]] || fail "$case_name did not bound the stalled JSON filter (exit $script_status)"
    [[ "$live_diagnostic" == false ]] || fail "$case_name left a diagnostic process running"
  fi

  if [[ "$case_name" == fallback_* ]]; then
    grep -Fqx "proxy --address 127.0.0.1 --port 18080 --accept-hosts ^127\\.0\\.0\\.1$" "$log" ||
      fail "$case_name did not start a loopback-only Kubernetes API proxy"
    grep -Fq "/api/v1/namespaces/teagram/services/teagram-web/proxy/healthz?deploy=$deploy_sha" "$log" ||
      fail "$case_name did not probe fallback health through the service proxy API"
    if grep -Fq 'port-forward' "$log"; then
      fail "$case_name used pod port-forward instead of the service proxy route"
    fi
    [[ -f "$tmp/$case_name-api-proxy-pid" ]] || fail "$case_name did not record the API proxy process"
    [[ -f "$tmp/$case_name-api-proxy-cleanup" ]] || fail "$case_name did not clean up the API proxy process"
    local api_proxy_pid process_state
    read -r api_proxy_pid <"$tmp/$case_name-api-proxy-pid"
    process_state="$(ps -o stat= -p "$api_proxy_pid" || true)"
    process_state="${process_state//[[:space:]]/}"
    if [[ -n "$process_state" && "$process_state" != Z* ]]; then
      kill "$api_proxy_pid" 2>/dev/null || true
      fail "$case_name left the Kubernetes API proxy process running"
    fi

    if [[ "$expected_result" == success ]]; then
      grep -Fqx "fallback=verified sha=$deploy_sha" "$output" ||
        fail "$case_name did not print the fallback verification marker"
      if grep -Fq 'rollout=verified sha=' "$output"; then
        fail "$case_name printed the public rollout marker for a fallback probe"
      fi
      grep -Fqx "node .github/scripts/smoke-k8s-web.mjs $smoke_url $deploy_sha $artifact_digest" "$log" ||
        fail "$case_name did not run the deployment smoke against the fallback service"
      if grep -Fq 'rollout undo deployment/teagram-web' "$log"; then
        fail "$case_name rolled back after a successful fallback smoke"
      fi
      return 0
    fi

    grep -Fq 'the fallback route did not become ready' "$output" ||
      fail "$case_name did not report the failed fallback readiness probe"
    if [[ "$expected_failure" == fallback-probe ]]; then
      local api_proxy_line fallback_failure_line
      api_proxy_line="$(grep -n -F 'kubectl proxy: serving the fallback service route' "$output" | cut -d: -f1 || true)"
      fallback_failure_line="$(grep -n -F 'the fallback route did not become ready' "$output" | cut -d: -f1 || true)"
      [[ -n "$api_proxy_line" && -n "$fallback_failure_line" && "$api_proxy_line" -lt "$fallback_failure_line" ]] ||
        fail "$case_name did not print the service proxy diagnostic before failing the readiness probe"
    fi
    if grep -Fq 'fallback=verified sha=' "$output"; then
      fail "$case_name printed the fallback verification marker after a failed probe"
    fi
    if grep -Eq '^node ' "$log"; then
      fail "$case_name ran the web smoke after a failed readiness probe"
    fi
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
run_case fallback_ready fallback-ready success
run_case fallback_probe fallback-probe

printf 'k3s web deployment rollback behavior holds\n'
