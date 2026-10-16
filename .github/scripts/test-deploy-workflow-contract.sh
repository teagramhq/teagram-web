#!/usr/bin/env bash
# Guards the publication-only production deploy workflow and exact-SHA choice.
set -euo pipefail

workflow="${DEPLOY_WORKFLOW:-.github/workflows/deploy.yml}"
expected_if="\${{ github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push') }}"

fail() {
  printf '%s: %s\n' "$workflow" "$1" >&2
  exit 1
}

query() {
  yq -r "$1" "$workflow"
}

check_target_selection() (
  set -euo pipefail
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  query '.jobs[].steps[] | select(.id == "target") | .run' >"$tmp/target.sh"
  cat >"$tmp/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'actions/workflows/private-artifact.yml/runs?branch=master&event=push&status=success&per_page=1'*)
    printf '%s\t%s\n' "$TEST_LATEST_RUN_ID" "$TEST_LATEST_SHA"
    ;;
  *"compare/$RUN_HEAD_SHA...$TEST_LATEST_SHA --jq .status")
    [[ "$TEST_COMPARISON" != api-error ]] || exit 1
    printf '%s\n' "$TEST_COMPARISON"
    ;;
  *) echo "unexpected forge query: $*" >&2; exit 1 ;;
esac
SH
  chmod +x "$tmp/gh"
  export PATH="$tmp:$PATH" GITHUB_REPOSITORY=test/web
  export RUN_ID=100 RUN_HEAD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  export TEST_LATEST_RUN_ID=200 TEST_LATEST_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  export GITHUB_OUTPUT="$tmp/output" TEST_COMPARISON GITHUB_EVENT_NAME

  local expected status
  GITHUB_EVENT_NAME=workflow_run
  for status in ahead identical behind diverged; do
    TEST_COMPARISON="$status"
    TEST_LATEST_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    if [[ "$status" == identical ]]; then
      TEST_LATEST_SHA="$RUN_HEAD_SHA"
    fi
    expected="$RUN_HEAD_SHA"
    expected_run_id="$RUN_ID"
    if [[ "$status" == ahead ]]; then
      expected="$TEST_LATEST_SHA"
      expected_run_id="$TEST_LATEST_RUN_ID"
    elif [[ "$status" == identical ]]; then
      expected="$TEST_LATEST_SHA"
    fi
    : >"$GITHUB_OUTPUT"
    bash -euo pipefail "$tmp/target.sh" >/dev/null
    grep -Fxq "sha=$expected" "$GITHUB_OUTPUT" || fail "wrong SHA for workflow_run comparison $status"
    grep -Fxq "run_id=$expected_run_id" "$GITHUB_OUTPUT" || fail "wrong publication run for comparison $status"
  done

  TEST_COMPARISON=api-error
  if bash -euo pipefail "$tmp/target.sh" >/dev/null; then
    fail 'a failed forge comparison must fail the deploy'
  fi

  GITHUB_EVENT_NAME=workflow_dispatch
  RUN_ID=
  RUN_HEAD_SHA=
  : >"$GITHUB_OUTPUT"
  bash -euo pipefail "$tmp/target.sh" >/dev/null
  grep -Fxq "sha=$TEST_LATEST_SHA" "$GITHUB_OUTPUT" || fail 'dispatch must select the newest successful push publication'
  grep -Fxq "run_id=$TEST_LATEST_RUN_ID" "$GITHUB_OUTPUT" || fail 'dispatch must select that publication run'

  TEST_LATEST_SHA=null
  if bash -euo pipefail "$tmp/target.sh" >/dev/null; then
    fail 'an invalid successful publication SHA must fail the deploy'
  fi
)

check_contract() {
  [[ "$(query '.on | keys | sort | join(",")')" == 'workflow_dispatch,workflow_run' ]] ||
    fail 'triggers must be exactly workflow_run and workflow_dispatch'
  [[ "$(query '.on.workflow_dispatch // {} | length')" == 0 ]] ||
    fail 'workflow_dispatch must take no inputs'
  [[ "$(query '.on.workflow_run.workflows | join(",")')" == 'Private MTProto Artifact Publication' ]] ||
    fail 'workflow_run must follow only Private MTProto Artifact Publication'
  [[ "$(query '.on.workflow_run.types | join(",")')" == 'completed' ]] ||
    fail 'workflow_run must fire only on completion'
  [[ "$(query '.on.workflow_run.branches | join(",")')" == 'master' ]] ||
    fail 'workflow_run must be limited to branches: [master]'
  [[ "$(query '.concurrency.group')" == 'deploy-telegram-web' ]] ||
    fail 'concurrency group must be deploy-telegram-web'
  [[ "$(query '.concurrency."cancel-in-progress"')" == 'false' ]] ||
    fail 'concurrency must not cancel a deploy in progress'
  [[ "$(query '.permissions | to_entries | map(.key + "=" + .value) | sort | join(",")')" == 'actions=read,contents=read' ]] ||
    fail 'workflow permissions must be contents: read and actions: read'
  [[ "$(query '.jobs | keys | join(",")')" == 'deploy' ]] || fail 'workflow must define one deploy job'
  [[ "$(query '.jobs.deploy.if')" == "$expected_if" ]] ||
    fail 'deploy must run only on dispatch or a successful push publication'
  [[ "$(query '.jobs.deploy.environment')" == 'production' ]] ||
    fail 'deploy must use environment: production'
  [[ "$(query '.jobs.deploy.permissions.actions')" == 'read' ]] ||
    fail 'deploy job must grant actions: read'
  [[ "$(query '.jobs.deploy.permissions.contents')" == 'read' ]] ||
    fail 'deploy job must grant contents: read'
  [[ "$(query '.jobs.deploy.permissions | to_entries | map(select(.value != "read")) | length')" == 0 ]] ||
    fail 'deploy job must not request write permissions'

  local checkout_count download_count ssh_count uses
  checkout_count="$(query '[.jobs.deploy.steps[] | select(.uses // "" | test("^actions/checkout@"))] | length')"
  [[ "$checkout_count" == 0 ]] || fail 'deploy workflow must not use actions/checkout'
  download_count="$(query '[.jobs.deploy.steps[] | select((.uses // "" | test("^actions/download-artifact@")) and .with."run-id" == "${{ steps.target.outputs.run_id }}" and .with."github-token" == "${{ github.token }}")] | length')"
  [[ "$download_count" == 1 ]] || fail 'artifact download must be pinned to the selected run and github token'
  ssh_count="$(query '[.jobs.deploy.steps[] | select(.run // "" | test("(^|\\s)ssh\\s"))] | length')"
  [[ "$ssh_count" == 1 ]] || fail "expected one ssh step, found $ssh_count"
  query '.jobs.deploy.steps[] | select(.run // "" | test("(^|\\s)ssh\\s")) | .run' |
    grep -Fq 'root@100.124.236.66 "$DEPLOY_SHA" < "$RUNNER_TEMP/private-artifact.zip"' ||
    fail 'ssh must send the selected SHA and packaged artifact to the forced command'
  if query '.jobs.deploy.steps[].run // ""' | grep -Fq '${{'; then
    fail 'run blocks must pass GitHub values through environment variables'
  fi

  while IFS= read -r uses; do
    [[ -n "$uses" ]] || continue
    [[ "$uses" =~ ^[^@]+@[0-9a-f]{40}$ ]] || fail "action not pinned to a commit SHA: $uses"
  done < <(query '.jobs.deploy.steps[].uses // ""')
  check_target_selection
}

self_test() {
  local tmp mutation
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  local mutations=(
    '.on.pull_request = {}'
    '.on.pull_request_target = {}'
    '.on.push = {"branches": ["master"]}'
    '.on.workflow_dispatch.inputs = {"sha":{"type":"string"}}'
    'del(.on.workflow_run.branches)'
    '.on.workflow_run.branches = ["master", "dev"]'
    '.jobs.deploy.if = "wrong"'
    'del(.jobs.deploy.if)'
    '.jobs.deploy.environment = "staging"'
    'del(.jobs.deploy.environment)'
    'del(.concurrency)'
    '.concurrency.group = "deploy"'
    '.concurrency."cancel-in-progress" = true'
    '.jobs.deploy.steps = [{"uses": "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683"}] + .jobs.deploy.steps'
    '(.jobs.deploy.steps[] | select(.uses | test("^actions/download-artifact@")) | .with."run-id") = "${{ github.run_id }}"'
    '(.jobs.deploy.steps[] | select(.uses | test("^tailscale/github-action@")) | .uses) = "tailscale/github-action@v4"'
    '.permissions.contents = "write"'
    'del(.jobs.deploy.permissions.actions)'
  )

  for mutation in "${mutations[@]}"; do
    yq "$mutation" "$workflow" >"$tmp/deploy.yml"
    if DEPLOY_WORKFLOW="$tmp/deploy.yml" bash "$0" --contract-only >/dev/null 2>&1; then
      printf 'contract accepted a broken workflow: %s\n' "$mutation" >&2
      exit 1
    fi
  done
}

check_contract
if [[ "${1:-}" != '--contract-only' ]]; then
  self_test
  printf 'deploy workflow contract holds\n'
fi
