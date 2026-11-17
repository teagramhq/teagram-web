#!/usr/bin/env bash
# Guards web image publication and the production k3s deployment flow.
# GitHub and shell expressions are compared as literal text throughout this contract.
# shellcheck disable=SC2016
set -euo pipefail

workflow="${DEPLOY_WORKFLOW:-.github/workflows/deploy.yml}"
expected_if="\${{ (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master') || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push') }}"
expected_deploy_if="\${{ needs.check-published-image-pin.outputs.skip == 'false' }}"
expected_run_name="\${{ inputs.issue && format('{0} [{1}]', github.workflow, inputs.issue) || '' }}"
expected_issue_description='Issue key to report this run to (e.g. MAIN-123). Leave empty for no report.'
private_artifact_workflow="${PRIVATE_ARTIFACT_WORKFLOW:-.github/workflows/private-artifact.yml}"
repository_ci_workflow="${REPOSITORY_CI_WORKFLOW:-.github/workflows/ci.yml}"
deployment_stack_workflow="${DEPLOYMENT_STACK_WORKFLOW:-.github/workflows/deployment-stack-checks.yml}"
identity_guard_script="${DEPLOY_IDENTITY_GUARD_SCRIPT:-.github/scripts/verify-deploy-identity.sh}"
# Split legacy references so this contract does not scan itself.
legacy_routes=("tag:ci-""deploy" "teagram-k3s-""api")
legacy_deploy_identity=("teagram-" "deployer")

fail() {
  printf '%s: %s\n' "$workflow" "$1" >&2
  exit 1
}

query() {
  yq -r "$1" "$workflow"
}

publication_query() {
  yq -r "$2" "$1"
}

check_publication_call_graph() {
  local ci_group private_group stack_group group cancel_in_progress caller_if build_if workflow_path

  [[ "$(publication_query "$private_artifact_workflow" '.on.pull_request.branches | join(",")')" == master ]] ||
    fail 'private artifact pull request checks must remain scoped to master'
  [[ "$(publication_query "$private_artifact_workflow" '.on.push.branches | join(",")')" == master ]] ||
    fail 'private artifact publication must retain its master push trigger'
  [[ "$(publication_query "$private_artifact_workflow" '.on.workflow_run.workflows | join(",")')" == 'Private MTProto Artifact Request' ]] ||
    fail 'private artifact publication must follow the request workflow'
  [[ "$(publication_query "$private_artifact_workflow" '.on.workflow_run.types | join(",")')" == completed ]] ||
    fail 'private artifact publication must wait for request completion'
  [[ "$(publication_query "$private_artifact_workflow" '.on.workflow_run.branches | join(",")')" == master ]] ||
    fail 'private artifact workflow-run publication must remain scoped to master'

  [[ "$(publication_query "$private_artifact_workflow" '.jobs.check-repository-ci.uses')" == './.github/workflows/ci.yml' ]] ||
    fail 'master publication must call repository CI'
  [[ "$(publication_query "$private_artifact_workflow" '.jobs.check-deployment-stack.uses')" == './.github/workflows/deployment-stack-checks.yml' ]] ||
    fail 'master publication must call deployment stack checks'
  for job in check-repository-ci check-deployment-stack; do
    caller_if="$(publication_query "$private_artifact_workflow" ".jobs.$job.if")"
    [[ "$caller_if" == *"needs.check-publication-request.result == 'success'"* && \
      "$caller_if" == *"needs.check-publication-request.outputs.publish_private_artifact == 'true'"* ]] ||
      fail "$job must run only for an approved publication request"
  done
  [[ "$(publication_query "$private_artifact_workflow" '.jobs.build-private-artifact.needs | sort | join(",")')" == 'check-deployment-stack,check-publication-request,check-repository-ci' ]] ||
    fail 'private artifact build must wait for the request, repository CI, and deployment stack checks'
  build_if="$(publication_query "$private_artifact_workflow" '.jobs.build-private-artifact.if')"
  [[ "$build_if" == *"needs.check-repository-ci.result == 'success'"* && \
    "$build_if" == *"needs.check-deployment-stack.result == 'success'"* ]] ||
    fail 'private artifact build must require both reusable workflows to pass'
  [[ "$(publication_query "$private_artifact_workflow" '.jobs.publish-private-artifact.needs | sort | join(",")')" == 'build-private-artifact,check-publication-request' ]] ||
    fail 'private artifact publication must wait for its verified build'
  [[ "$(publication_query "$private_artifact_workflow" '.jobs.publish-teagram-web-image.needs | sort | join(",")')" == 'build-private-artifact,check-publication-request,publish-private-artifact' ]] ||
    fail 'web image publication must wait for the verified private artifact'

  ci_group="$(publication_query "$repository_ci_workflow" '.concurrency.group')"
  private_group="$(publication_query "$private_artifact_workflow" '.concurrency.group')"
  stack_group="$(publication_query "$deployment_stack_workflow" '.concurrency.group')"
  [[ "$ci_group" == teagram-web-ci-* ]] ||
    fail 'repository CI concurrency group must use literal prefix teagram-web-ci'
  [[ "$private_group" == teagram-web-private-artifact-* ]] ||
    fail 'private artifact concurrency group must use literal prefix teagram-web-private-artifact'
  [[ "$stack_group" == teagram-web-deployment-stack-checks-* ]] ||
    fail 'deployment stack checks concurrency group must use literal prefix teagram-web-deployment-stack-checks'
  [[ "$ci_group" != "$private_group" && "$ci_group" != "$stack_group" && "$private_group" != "$stack_group" ]] ||
    fail 'master publication workflows must have distinct concurrency groups'

  for group in "$ci_group" "$private_group" "$stack_group"; do
    [[ "$group" == *"github.event_name == 'pull_request'"* && "$group" == *'github.event.pull_request.number'* ]] ||
      fail 'pull request concurrency groups must be scoped by pull request number'
    [[ "$group" == *"format('pr-{0}', github.event.pull_request.number)"* ]] ||
      fail 'pull request concurrency groups must include the pull request number'
    [[ "$group" == *'github.run_id'* && "$group" == *'github.run_attempt'* ]] ||
      fail 'non-PR concurrency groups must be unique to each run attempt'
    [[ "$group" == *"format('run-{0}-{1}', github.run_id, github.run_attempt)"* ]] ||
      fail 'non-PR concurrency groups must include the run ID and attempt'
  done
  for workflow_path in "$repository_ci_workflow" "$private_artifact_workflow" "$deployment_stack_workflow"; do
    cancel_in_progress="$(publication_query "$workflow_path" '.concurrency."cancel-in-progress"')"
    [[ "$cancel_in_progress" == *"github.event_name == 'pull_request'"* ]] ||
      fail "$workflow_path must cancel superseded pull request runs only"
  done
  [[ "$(publication_query "$repository_ci_workflow" '.jobs.check-security.steps[] | select(.name == "Check out code") | .with."fetch-depth"')" == 1 ]] ||
    fail 'check: security must check out shallowly; its Gitleaks step fetches the pull request range itself'
}

publication_call_graph_self_test() (
  set -euo pipefail
  local tmp private_group
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  private_group="$(publication_query "$private_artifact_workflow" '.concurrency.group')"
  TEST_PRIVATE_GROUP="$private_group" yq '.concurrency.group = strenv(TEST_PRIVATE_GROUP)' \
    "$repository_ci_workflow" >"$tmp/ci.yml"
  if DEPLOY_WORKFLOW="$workflow" \
    PRIVATE_ARTIFACT_WORKFLOW="$private_artifact_workflow" \
    REPOSITORY_CI_WORKFLOW="$tmp/ci.yml" \
    DEPLOYMENT_STACK_WORKFLOW="$deployment_stack_workflow" \
    bash "$0" --contract-only >/dev/null 2>&1; then
    fail 'publication call-graph self-test accepted a shared concurrency group'
  fi
)

publisher_pin_prefix() {
  local pin_template
  pin_template="$(publication_query "$private_artifact_workflow" \
    '.jobs.publish-teagram-web-image.steps[] | select(.name == "Publish the immutable web image pin") | .with.name')"
  [[ "$pin_template" =~ ^([A-Za-z0-9-]+)\$\{\{ ]] ||
    fail 'web image pin upload name must start with a literal prefix before its template values'
  printf '%s\n' "${BASH_REMATCH[1]}"
}

check_target_selection() (
  set -euo pipefail
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  query '.jobs.check-published-image-pin.steps[] | select(.id == "target") | .run' >"$tmp/target.sh"
  query '.jobs.deploy-web.steps[] | select(.id == "refresh") | .run' >"$tmp/refresh.sh"
  cat >"$tmp/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
api_path=
for arg in "$@"; do
  [[ "$arg" == repos/test/web/* ]] && api_path="$arg"
done

if [[ "$api_path" == *'/actions/workflows/private-artifact.yml/runs?'* ]]; then
  printf '%s\n' "$TEST_RUNS"
elif [[ "$api_path" =~ /actions/runs/([0-9]+)/artifacts ]]; then
  run_id="${BASH_REMATCH[1]}"
  if [[ "$run_id" == "${TEST_ARTIFACT_API_FAILURE_RUN_ID:-}" ]]; then
    exit 1
  fi
  if [[ "$run_id" == "${TEST_ARTIFACT_API_MALFORMED_RUN_ID:-}" ]]; then
    printf '{"artifacts":{}}\n'
    exit 0
  fi
  if [[ "$run_id" == "$TEST_UNPUBLISHED_RUN_ID" ]]; then
    printf '{"artifacts":[]}\n'
  elif [[ "$run_id" == "$TEST_EVENT_RUN_ID" && "$TEST_EVENT_PUBLICATION" == true ]]; then
    printf '{"artifacts":[{"name":"%s%s-%s","expired":false}]}\n' "$TEST_PIN_PREFIX" "$RUN_HEAD_SHA" "$TEST_EVENT_DIGEST"
  elif [[ "$run_id" == "$TEST_LATEST_RUN_ID" && "$TEST_LATEST_PUBLICATION" == true ]]; then
    printf '{"artifacts":[{"name":"%s%s-%s","expired":false}]}\n' "$TEST_PIN_PREFIX" "$TEST_LATEST_SHA" "$TEST_LATEST_DIGEST"
  elif [[ "$run_id" == "$TEST_PUBLISHED_RUN_ID" && "$TEST_PUBLISHED_PUBLICATION" == true ]]; then
    printf '{"artifacts":[{"name":"%s%s-%s","expired":false}]}\n' "$TEST_PIN_PREFIX" "$TEST_PUBLISHED_SHA" "$TEST_PUBLISHED_DIGEST"
  else
    printf '{"artifacts":[]}\n'
  fi
elif [[ "$api_path" =~ /actions/runs/([0-9]+)/jobs ]]; then
  run_id="${BASH_REMATCH[1]}"
  [[ "${TEST_JOBS_API_FAILURE:-false}" != true ]] || exit 1
  [[ "$run_id" == "$TEST_EVENT_RUN_ID" ]] || {
    echo "unexpected job query for run $run_id" >&2
    exit 1
  }
  printf '{"jobs":[{"name":"publish: teagram-web-image","conclusion":"%s"}]}\n' \
    "$TEST_EVENT_JOB_CONCLUSION"
elif [[ "$api_path" == *'/compare/'* ]]; then
  [[ "$TEST_COMPARISON" != api-error ]] || exit 1
  printf '%s\n' "$TEST_COMPARISON"
else
  echo "unexpected forge query: $*" >&2
  exit 1
fi
SH
  chmod +x "$tmp/gh"
  export PATH="$tmp:$PATH" GITHUB_REPOSITORY=test/web
  printf -v TEST_EVENT_SHA '%040d' 1
  printf -v TEST_OTHER_SHA '%040d' 2
  printf -v TEST_EVENT_DIGEST '%064d' 1
  printf -v TEST_LATEST_DIGEST '%064d' 2
  printf -v TEST_PUBLISHED_DIGEST '%064d' 3
  export TEST_EVENT_SHA TEST_OTHER_SHA TEST_EVENT_DIGEST TEST_LATEST_DIGEST TEST_PUBLISHED_DIGEST
  TEST_PIN_PREFIX="$(publisher_pin_prefix)"
  export TEST_PIN_PREFIX
  export RUN_ID=100 RUN_HEAD_SHA="$TEST_EVENT_SHA"
  export TEST_EVENT_RUN_ID=100 TEST_EVENT_PUBLICATION=true
  export TEST_EVENT_JOB_CONCLUSION=success
  export TEST_LATEST_RUN_ID=200 TEST_LATEST_SHA="$TEST_OTHER_SHA" TEST_LATEST_PUBLICATION=true
  export TEST_PUBLISHED_RUN_ID=300 TEST_PUBLISHED_SHA="$TEST_EVENT_SHA" TEST_PUBLISHED_PUBLICATION=false
  export TEST_UNPUBLISHED_RUN_ID=999 TEST_COMPARISON GITHUB_EVENT_NAME
  export GITHUB_OUTPUT="$tmp/output" GH_TOKEN=test TEST_RUNS

  local expected expected_run_id expected_digest expected_name status
  GITHUB_EVENT_NAME=workflow_run
  TEST_EVENT_PUBLICATION=true
  TEST_LATEST_PUBLICATION=true
  TEST_UNPUBLISHED_RUN_ID=999
  for status in ahead identical behind; do
    TEST_COMPARISON="$status"
    TEST_LATEST_SHA="$TEST_OTHER_SHA"
    if [[ "$status" == identical ]]; then
      TEST_LATEST_SHA="$TEST_EVENT_SHA"
    fi
    TEST_RUNS="$TEST_LATEST_RUN_ID"$'\t'"$TEST_LATEST_SHA"$'\n'"$RUN_ID"$'\t'"$RUN_HEAD_SHA"
    expected="$RUN_HEAD_SHA"
    expected_run_id="$RUN_ID"
    expected_digest="$TEST_EVENT_DIGEST"
    if [[ "$status" == ahead ]]; then
      expected="$TEST_LATEST_SHA"
      expected_run_id="$TEST_LATEST_RUN_ID"
      expected_digest="$TEST_LATEST_DIGEST"
    elif [[ "$status" == identical ]]; then
      expected="$TEST_LATEST_SHA"
      expected_run_id="$TEST_LATEST_RUN_ID"
      expected_digest="$TEST_LATEST_DIGEST"
    fi
    : >"$GITHUB_OUTPUT"
    local resolver_output=/dev/null
    if [[ "$status" == behind ]]; then
      resolver_output="$tmp/behind.out"
    fi
    bash -euo pipefail "$tmp/target.sh" >"$resolver_output"
    grep -Fxq "sha=$expected" "$GITHUB_OUTPUT" || fail "wrong SHA for workflow_run comparison $status"
    grep -Fxq "run_id=$expected_run_id" "$GITHUB_OUTPUT" || fail "wrong publication run for comparison $status"
    expected_name="$TEST_PIN_PREFIX$expected-$expected_digest"
    grep -Fxq "artifact_name=$expected_name" "$GITHUB_OUTPUT" || fail "wrong image pin for workflow_run comparison $status"
    grep -Fxq "image_digest=$expected_digest" "$GITHUB_OUTPUT" || fail "wrong image digest for workflow_run comparison $status"
    if [[ "$status" == behind ]]; then
      grep -Fq "latest publication $TEST_LATEST_SHA is behind; keeping event SHA $RUN_HEAD_SHA" "$tmp/behind.out" ||
        fail 'a behind comparison must log the event SHA it keeps'
    fi
  done

  TEST_COMPARISON=diverged
  TEST_RUNS="$TEST_LATEST_RUN_ID"$'\t'"$TEST_OTHER_SHA"$'\n'"$RUN_ID"$'\t'"$RUN_HEAD_SHA"
  if bash -euo pipefail "$tmp/target.sh" >"$tmp/diverged.out" 2>&1; then
    fail 'a diverged publication comparison must fail the deploy'
  fi
  grep -Fq '::error::publication commits' "$tmp/diverged.out" ||
    fail 'a diverged publication comparison must explain the failure'

  TEST_COMPARISON=api-error
  if bash -euo pipefail "$tmp/target.sh" >/dev/null; then
    fail 'a failed forge comparison must fail the deploy'
  fi

  # Dispatch finds the newest run that actually published a web image pin.
  TEST_PUBLISHED_RUN_ID=100
  TEST_PUBLISHED_SHA="$TEST_EVENT_SHA"
  TEST_PUBLISHED_PUBLICATION=true
  TEST_UNPUBLISHED_RUN_ID=200
  TEST_LATEST_RUN_ID=200
  TEST_LATEST_SHA="$TEST_OTHER_SHA"
  TEST_LATEST_PUBLICATION=false
  TEST_RUNS="$TEST_UNPUBLISHED_RUN_ID"$'\t'"$TEST_OTHER_SHA"$'\n'"$TEST_PUBLISHED_RUN_ID"$'\t'"$TEST_EVENT_SHA"
  GITHUB_EVENT_NAME=workflow_dispatch
  RUN_ID=
  RUN_HEAD_SHA=
  TEST_EVENT_RUN_ID=
  TEST_EVENT_PUBLICATION=false
  : >"$GITHUB_OUTPUT"
  bash -euo pipefail "$tmp/target.sh" >/dev/null
  grep -Fxq "sha=$TEST_EVENT_SHA" "$GITHUB_OUTPUT" || fail 'dispatch must skip a newer run with no web image pin'
  grep -Fxq "run_id=$TEST_PUBLISHED_RUN_ID" "$GITHUB_OUTPUT" || fail 'dispatch must select the latest published web image pin'
  expected_name="$TEST_PIN_PREFIX$TEST_EVENT_SHA-$TEST_PUBLISHED_DIGEST"
  grep -Fxq "artifact_name=$expected_name" "$GITHUB_OUTPUT" || fail 'dispatch selected the wrong image pin'
  grep -Fxq "image_digest=$TEST_PUBLISHED_DIGEST" "$GITHUB_OUTPUT" || fail 'dispatch selected the wrong image digest'

  # A published event is not displaced by a newer run without a pin.
  GITHUB_EVENT_NAME=workflow_run
  RUN_ID=100
  RUN_HEAD_SHA="$TEST_EVENT_SHA"
  TEST_EVENT_RUN_ID=100
  TEST_EVENT_PUBLICATION=true
  TEST_EVENT_JOB_CONCLUSION=success
  TEST_LATEST_RUN_ID=200
  TEST_LATEST_SHA="$TEST_OTHER_SHA"
  TEST_LATEST_PUBLICATION=false
  TEST_RUNS="$TEST_LATEST_RUN_ID"$'\t'"$TEST_LATEST_SHA"$'\n'"$RUN_ID"$'\t'"$RUN_HEAD_SHA"
  TEST_COMPARISON=identical
  : >"$GITHUB_OUTPUT"
  bash -euo pipefail "$tmp/target.sh" >/dev/null
  grep -Fxq 'skip=false' "$GITHUB_OUTPUT" || fail 'a published event must deploy when a newer run has no pin'
  grep -Fxq "sha=$TEST_EVENT_SHA" "$GITHUB_OUTPUT" || fail 'the published event must keep its SHA when the newer run has no pin'

  # A successful publication with no artifact pin must fail closed.
  TEST_EVENT_RUN_ID="$TEST_UNPUBLISHED_RUN_ID"
  TEST_EVENT_JOB_CONCLUSION=success
  RUN_ID="$TEST_UNPUBLISHED_RUN_ID"
  RUN_HEAD_SHA="$TEST_OTHER_SHA"
  : >"$GITHUB_OUTPUT"
  if bash -euo pipefail "$tmp/target.sh" >"$tmp/missing-pin.out" 2>&1; then
    fail 'a successful publisher without its image pin must fail'
  fi
  if grep -Fxq 'skip=true' "$GITHUB_OUTPUT"; then
    fail 'a successful publisher without its image pin must not be skipped'
  fi
  grep -Fq '::error::web image publication job succeeded' "$tmp/missing-pin.out" ||
    fail 'a successful publisher without its image pin must explain the error'

  # An unavailable publication-job API must fail instead of skipping an unverified event.
  TEST_EVENT_RUN_ID="$TEST_UNPUBLISHED_RUN_ID"
  TEST_EVENT_JOB_CONCLUSION=success
  RUN_ID="$TEST_UNPUBLISHED_RUN_ID"
  RUN_HEAD_SHA="$TEST_OTHER_SHA"
  export TEST_JOBS_API_FAILURE=true
  : >"$GITHUB_OUTPUT"
  if bash -euo pipefail "$tmp/target.sh" >"$tmp/event-jobs-api.out" 2>&1; then
    fail 'a publication-job API failure must fail the event resolver'
  else
    status=$?
  fi
  [[ "$status" == 1 ]] || fail 'a publication-job API failure must exit 1'
  if grep -Fxq 'skip=true' "$GITHUB_OUTPUT"; then
    fail 'a publication-job API failure must not skip the deploy'
  fi
  grep -Fq '::error::could not verify the web image publication job' "$tmp/event-jobs-api.out" ||
    fail 'a publication-job API failure must have a distinct diagnostic'
  unset TEST_JOBS_API_FAILURE

  # An unexpected publication-job conclusion must also fail closed.
  TEST_EVENT_JOB_CONCLUSION=failure
  : >"$GITHUB_OUTPUT"
  if bash -euo pipefail "$tmp/target.sh" >"$tmp/event-unexpected-conclusion.out" 2>&1; then
    fail 'an unexpected publication-job conclusion must fail the event resolver'
  else
    status=$?
  fi
  [[ "$status" == 1 ]] || fail 'an unexpected publication-job conclusion must exit 1'
  if grep -Fxq 'skip=true' "$GITHUB_OUTPUT"; then
    fail 'an unexpected publication-job conclusion must not skip the deploy'
  fi
  grep -Fq "::error::web image publication job in run $TEST_UNPUBLISHED_RUN_ID has unexpected conclusion 'failure'" \
    "$tmp/event-unexpected-conclusion.out" ||
    fail 'an unexpected publication-job conclusion must explain the error'

  # An unpublished event skips before deployment serialization.
  GITHUB_EVENT_NAME=workflow_run
  RUN_ID="$TEST_UNPUBLISHED_RUN_ID"
  RUN_HEAD_SHA="$TEST_OTHER_SHA"
  TEST_EVENT_RUN_ID="$TEST_UNPUBLISHED_RUN_ID"
  TEST_EVENT_JOB_CONCLUSION=skipped
  : >"$GITHUB_OUTPUT"
  bash -euo pipefail "$tmp/target.sh" >/dev/null
  grep -Fxq 'skip=true' "$GITHUB_OUTPUT" || fail 'an unpublished workflow_run must be skipped'
  if grep -q '^sha=' "$GITHUB_OUTPUT"; then
    fail 'an unpublished workflow_run must not select a deploy SHA'
  fi

  # An event-run artifacts API error is operational, never an unpublished skip.
  RUN_ID="$TEST_UNPUBLISHED_RUN_ID"
  RUN_HEAD_SHA="$TEST_OTHER_SHA"
  TEST_EVENT_RUN_ID="$TEST_UNPUBLISHED_RUN_ID"
  TEST_EVENT_PUBLICATION=false
  export TEST_ARTIFACT_API_FAILURE_RUN_ID="$TEST_UNPUBLISHED_RUN_ID"
  : >"$GITHUB_OUTPUT"
  if bash -euo pipefail "$tmp/target.sh" >"$tmp/event-artifact-api.out" 2>&1; then
    fail 'an event artifacts API failure must fail the target resolver'
  else
    status=$?
  fi
  [[ "$status" == 1 ]] || fail 'an event artifacts API failure must exit 1'
  if grep -Fxq 'skip=true' "$GITHUB_OUTPUT"; then
    fail 'an event artifacts API failure must not skip the deploy'
  fi
  grep -Fq "::error::could not verify the web image pin for publication run $TEST_UNPUBLISHED_RUN_ID" \
    "$tmp/event-artifact-api.out" ||
    fail 'an event artifacts API failure must have a distinct diagnostic'
  unset TEST_ARTIFACT_API_FAILURE_RUN_ID

  # Artifacts API errors are operational failures, never a no-pin skip.
  GITHUB_EVENT_NAME=workflow_dispatch
  TEST_RUNS="$TEST_LATEST_RUN_ID"$'\t'"$TEST_OTHER_SHA"
  TEST_LATEST_PUBLICATION=true
  export TEST_ARTIFACT_API_FAILURE_RUN_ID="$TEST_LATEST_RUN_ID"
  : >"$GITHUB_OUTPUT"
  if bash -euo pipefail "$tmp/target.sh" >"$tmp/artifact-api.out" 2>&1; then
    fail 'an artifacts API failure must fail the deploy target resolver'
  fi
  if grep -Fxq 'skip=true' "$GITHUB_OUTPUT"; then
    fail 'an artifacts API failure must not skip the deploy'
  fi
  grep -Fq '::error::could not query or validate successful web image publications' "$tmp/artifact-api.out" ||
    fail 'an artifacts API failure must have a distinct diagnostic'
  unset TEST_ARTIFACT_API_FAILURE_RUN_ID

  export TEST_ARTIFACT_API_MALFORMED_RUN_ID="$TEST_LATEST_RUN_ID"
  : >"$GITHUB_OUTPUT"
  if bash -euo pipefail "$tmp/target.sh" >"$tmp/artifact-malformed.out" 2>&1; then
    fail 'malformed artifacts metadata must fail the deploy target resolver'
  fi
  if grep -Fxq 'skip=true' "$GITHUB_OUTPUT"; then
    fail 'malformed artifacts metadata must not skip the deploy'
  fi
  grep -Fq '::error::could not query or validate successful web image publications' "$tmp/artifact-malformed.out" ||
    fail 'malformed artifacts metadata must have a distinct diagnostic'
  unset TEST_ARTIFACT_API_MALFORMED_RUN_ID

  # A delayed deployment refreshes to the latest descendant after acquiring the slot.
  GITHUB_EVENT_NAME=workflow_run
  RUN_ID=100
  RUN_HEAD_SHA="$TEST_EVENT_SHA"
  TEST_EVENT_RUN_ID=100
  TEST_EVENT_PUBLICATION=true
  TEST_LATEST_RUN_ID=400
  TEST_LATEST_SHA="$TEST_OTHER_SHA"
  TEST_LATEST_DIGEST="$TEST_PUBLISHED_DIGEST"
  TEST_LATEST_PUBLICATION=true
  TEST_COMPARISON=ahead
  TEST_RUNS="$TEST_LATEST_RUN_ID"$'\t'"$TEST_LATEST_SHA"$'\n'"$RUN_ID"$'\t'"$RUN_HEAD_SHA"
  BASE_SHA="$TEST_EVENT_SHA"
  BASE_RUN_ID=100
  BASE_ARTIFACT_NAME="$TEST_PIN_PREFIX$TEST_EVENT_SHA-$TEST_EVENT_DIGEST"
  BASE_IMAGE_DIGEST="$TEST_EVENT_DIGEST"
  export BASE_SHA BASE_RUN_ID BASE_ARTIFACT_NAME BASE_IMAGE_DIGEST
  : >"$GITHUB_OUTPUT"
  bash -euo pipefail "$tmp/refresh.sh" >/dev/null
  grep -Fxq "sha=$TEST_OTHER_SHA" "$GITHUB_OUTPUT" || fail 'post-slot refresh must select the latest descendant'
  grep -Fxq "run_id=$TEST_LATEST_RUN_ID" "$GITHUB_OUTPUT" || fail 'post-slot refresh must use the latest publication run'
  expected_name="$TEST_PIN_PREFIX$TEST_OTHER_SHA-$TEST_PUBLISHED_DIGEST"
  grep -Fxq "artifact_name=$expected_name" "$GITHUB_OUTPUT" || fail 'post-slot refresh must download the latest image pin'
  grep -Fxq "image_digest=$TEST_PUBLISHED_DIGEST" "$GITHUB_OUTPUT" || fail 'post-slot refresh must use the latest image digest'

  TEST_COMPARISON=behind
  : >"$GITHUB_OUTPUT"
  bash -euo pipefail "$tmp/refresh.sh" >"$tmp/refresh-behind.out"
  grep -Fxq "sha=$BASE_SHA" "$GITHUB_OUTPUT" || fail 'post-slot refresh must retain its pre-resolved SHA when latest is behind'
  grep -Fq "latest publication $TEST_LATEST_SHA is behind; keeping pre-resolved SHA $BASE_SHA" "$tmp/refresh-behind.out" ||
    fail 'post-slot refresh must log the pre-resolved SHA it keeps'

  TEST_COMPARISON=diverged
  if bash -euo pipefail "$tmp/refresh.sh" >"$tmp/refresh-diverged.out" 2>&1; then
    fail 'a diverged post-slot comparison must fail the deploy'
  fi
  grep -Fq '::error::publication commits' "$tmp/refresh-diverged.out" ||
    fail 'a diverged post-slot comparison must explain the failure'

  TEST_COMPARISON=ahead
  export TEST_ARTIFACT_API_FAILURE_RUN_ID="$TEST_LATEST_RUN_ID"
  if bash -euo pipefail "$tmp/refresh.sh" >"$tmp/refresh-api.out" 2>&1; then
    fail 'a post-slot artifacts API failure must fail the deploy'
  fi
  grep -Fq '::error::could not query or validate successful web image publications' "$tmp/refresh-api.out" ||
    fail 'a post-slot artifacts API failure must have a distinct diagnostic'
  unset TEST_ARTIFACT_API_FAILURE_RUN_ID

  RUN_HEAD_SHA=null
  if bash -euo pipefail "$tmp/target.sh" >/dev/null; then
    fail 'an invalid publication event SHA must fail the deploy'
  fi
)

check_kubeconfig_validation() (
  set -euo pipefail
  local tmp good_config config case_name expected_host
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  query '.jobs.deploy-web.steps[] | select(.name == "Install the deploy kubeconfig") | .run' >"$tmp/install.sh"
  good_config='{"apiVersion":"v1","kind":"Config","clusters":[{"name":"k3s","cluster":{"server":"https://teagram.tailaa4918.ts.net:6443","certificate-authority-data":"ZHVtbXktY2E="}}],"contexts":[{"name":"deploy","context":{"cluster":"k3s","user":"deploy"}}],"current-context":"deploy","users":[{"name":"deploy","user":{}}]}'
  export RUNNER_TEMP="$tmp" GITHUB_ENV="$tmp/env"
  : >"$GITHUB_ENV"
  : >"$tmp/output"
  GITHUB_OUTPUT="$tmp/output" KUBECONFIG_CONTENT="$good_config" bash -euo pipefail "$tmp/install.sh" >"$tmp/good.log" 2>&1 ||
    fail 'a CA-pinned kubeconfig for the tailnet API must pass validation'
  grep -Fxq "KUBECONFIG=$tmp/k8s/config" "$GITHUB_ENV" || fail 'validated kubeconfig must be exported'
  printf -v expected_host '%s=%s' api_host teagram.tailaa4918.ts.net
  grep -Fxq "$expected_host" "$tmp/output" || fail 'validated API host must be exposed for the ping'
  [[ "$(stat -c '%a' "$tmp/k8s/config")" == 600 ]] || fail 'the kubeconfig must be private to the runner'

  for case_name in wrong_server missing_ca empty_ca insecure_true insecure_false missing_context empty; do
    case "$case_name" in
      wrong_server) config="$(jq -c '.clusters[0].cluster.server = "https://wrong.example:6443"' <<<"$good_config")" ;;
      missing_ca) config="$(jq -c 'del(.clusters[0].cluster."certificate-authority-data")' <<<"$good_config")" ;;
      empty_ca) config="$(jq -c '.clusters[0].cluster."certificate-authority-data" = ""' <<<"$good_config")" ;;
      insecure_true) config="$(jq -c '.clusters[0].cluster."insecure-skip-tls-verify" = true' <<<"$good_config")" ;;
      insecure_false) config="$(jq -c '.clusters[0].cluster."insecure-skip-tls-verify" = false' <<<"$good_config")" ;;
      missing_context) config="$(jq -c 'del(."current-context")' <<<"$good_config")" ;;
      empty) config='' ;;
    esac
    : >"$GITHUB_ENV"
    : >"$tmp/output"
    if GITHUB_OUTPUT="$tmp/output" KUBECONFIG_CONTENT="$config" bash -euo pipefail "$tmp/install.sh" >"$tmp/$case_name.log" 2>&1; then
      fail "kubeconfig validation accepted $case_name"
    fi
    [[ ! -s "$GITHUB_ENV" && ! -s "$tmp/output" ]] ||
      fail "kubeconfig validation exported values for $case_name"
  done
)

check_legacy_route_references() {
  local matches status
  if matches="$(git grep --untracked --exclude-standard -I -l -F \
    -e "${legacy_routes[0]}" -e "${legacy_routes[1]}" -- .)"; then
    fail "legacy route reference found in $matches"
  else
    status=$?
    [[ "$status" == 1 ]] || fail 'could not scan repository files for legacy route references'
  fi
}

check_legacy_deploy_identity_references() {
  local identity matches status
  identity="${legacy_deploy_identity[0]}${legacy_deploy_identity[1]}"
  if matches="$(grep -RIEil -- "$identity" "$workflow" .github/workflows .github/scripts deploy)"; then
    fail "legacy deploy identity reference found in $matches"
  else
    status=$?
    [[ "$status" == 1 ]] || fail 'could not scan deploy workflows and scripts for legacy identity references'
  fi
}

check_deploy_identity_guard_behavior() (
  set -euo pipefail
  local tmp expected_identity
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  expected_identity='system:serviceaccount:teagram:teagram-web-deployer'
  mkdir -p "$tmp/bin"
  cat >"$tmp/bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${TEST_KUBECTL_LOG:?}"
case "$*" in
  'auth whoami -o jsonpath={.status.userInfo.username}')
    [[ "${TEST_WHOAMI_FAIL:-false}" != true ]] || exit 1
    printf '%s' "${TEST_IDENTITY:-system:serviceaccount:teagram:teagram-web-deployer}"
    ;;
  'auth can-i get secrets -n teagram')
    [[ "${TEST_SECRETS_FAIL:-false}" != true ]] || exit 1
    printf '%s\n' "${TEST_SECRET_ACCESS:-no}"
    ;;
  'auth can-i create pods -n teagram')
    [[ "${TEST_PODS_FAIL:-false}" != true ]] || exit 1
    printf '%s\n' "${TEST_POD_ACCESS:-no}"
    ;;
  *)
    echo "unexpected kubectl invocation: $*" >&2
    exit 2
    ;;
esac
SH
  chmod +x "$tmp/bin/kubectl"

  run_identity_guard() {
    local output="$1" status
    shift
    : >"$tmp/calls"
    if env PATH="$tmp/bin:$PATH" TEST_KUBECTL_LOG="$tmp/calls" "$@" \
      bash "$identity_guard_script" >"$output" 2>&1; then
      return 0
    else
      status=$?
      return "$status"
    fi
  }

  if ! run_identity_guard "$tmp/success.log" TEST_IDENTITY="$expected_identity" \
    TEST_SECRET_ACCESS=no TEST_POD_ACCESS=no; then
    fail 'the deploy identity guard must accept the web identity with denied secret and pod access'
  fi
  cat >"$tmp/expected-calls" <<'EOF'
auth whoami -o jsonpath={.status.userInfo.username}
auth can-i get secrets -n teagram
auth can-i create pods -n teagram
EOF
  diff -u "$tmp/expected-calls" "$tmp/calls" >/dev/null ||
    fail 'the deploy identity guard must run each identity and permission check'

  if run_identity_guard "$tmp/whoami-failure.log" TEST_IDENTITY=unexpected; then
    fail 'the deploy identity guard accepted an unexpected kubeconfig identity'
  fi
  grep -Fq '::error::kubectl auth whoami failed' "$tmp/whoami-failure.log" ||
    fail 'an identity mismatch must name the failed kubectl auth whoami check'

  if run_identity_guard "$tmp/secrets-failure.log" TEST_SECRET_ACCESS=yes; then
    fail 'the deploy identity guard accepted secret access'
  fi
  grep -Fq '::error::kubectl auth can-i get secrets -n teagram failed' "$tmp/secrets-failure.log" ||
    fail 'unexpected secret access must name the failed kubectl auth can-i check'

  if run_identity_guard "$tmp/pods-failure.log" TEST_POD_ACCESS=yes; then
    fail 'the deploy identity guard accepted pod creation access'
  fi
  grep -Fq '::error::kubectl auth can-i create pods -n teagram failed' "$tmp/pods-failure.log" ||
    fail 'unexpected pod creation access must name the failed kubectl auth can-i check'
)

legacy_route_self_test() (
  set -euo pipefail
  local tmp fixture route
  local fixtures=(
    .github/workflows/nested/probe.yml
    .github/scripts/nested/probe.sh
    deploy/k8s/render.py
    scripts/nested/probe.mjs
    tools/nested/probe
  )
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cp -a .github "$tmp/.github"
  git -C "$tmp" init --quiet
  for fixture in "${fixtures[@]}"; do
    mkdir -p "$tmp/$(dirname "$fixture")"
    : >"$tmp/$fixture"
  done
  git -C "$tmp" add .github deploy scripts
  run_fixture_contract() (
    cd "$tmp"
    unset DEPLOY_WORKFLOW PRIVATE_ARTIFACT_WORKFLOW REPOSITORY_CI_WORKFLOW DEPLOYMENT_STACK_WORKFLOW SKIP_PUBLICATION_CALL_GRAPH
    bash .github/scripts/test-deploy-workflow-contract.sh --contract-only
  )
  run_fixture_contract >"$tmp/scan.log" 2>&1 || fail 'clean legacy route fixture must pass the contract'
  for fixture in "${fixtures[@]}"; do
    for route in "${legacy_routes[@]}"; do
      printf '%s\n' "$route" >"$tmp/$fixture"
      if run_fixture_contract >"$tmp/scan.log" 2>&1; then
        fail "legacy route self-test accepted a reference in $fixture"
      fi
      grep -Fq 'legacy route reference found' "$tmp/scan.log" ||
        fail "legacy route self-test failed for another reason in $fixture"
      : >"$tmp/$fixture"
    done
  done
)

check_contract() {
  check_legacy_route_references
  check_legacy_deploy_identity_references
  if [[ "${SKIP_PUBLICATION_CALL_GRAPH:-false}" != true ]]; then
    check_publication_call_graph
  fi

  [[ "$(query '.on | keys | sort | join(",")')" == 'workflow_dispatch,workflow_run' ]] ||
    fail 'triggers must be exactly workflow_run and workflow_dispatch'
  [[ "$(query '.on.workflow_dispatch.inputs | keys | join(",")')" == issue ]] ||
    fail 'workflow_dispatch must take only the optional issue input'
  [[ "$(query '.on.workflow_dispatch.inputs.issue.description')" == "$expected_issue_description" ]] ||
    fail 'the issue input description must explain optional reporting'
  [[ "$(query '.on.workflow_dispatch.inputs.issue.required')" == false ]] ||
    fail 'the issue input must be optional'
  [[ "$(query '.on.workflow_dispatch.inputs.issue.type')" == string ]] ||
    fail 'the issue input must be a string'
  [[ -z "$(query '.on.workflow_dispatch.inputs.issue.default')" ]] ||
    fail 'the issue input must default to empty'
  [[ "$(query '."run-name"')" == "$expected_run_name" ]] ||
    fail 'run names must include only non-empty issue keys'
  [[ "$(query '.on.workflow_run.workflows | join(",")')" == 'Private MTProto Artifact Publication' ]] ||
    fail 'workflow_run must follow only private artifact publications'
  [[ "$(query '.on.workflow_run.types | join(",")')" == completed ]] ||
    fail 'workflow_run must fire only on completion'
  [[ "$(query '.on.workflow_run.branches | join(",")')" == master ]] ||
    fail 'workflow_run must be limited to master'
  [[ "$(query '.permissions | to_entries | map(.key + "=" + .value) | sort | join(",")')" == 'actions=read,contents=read' ]] ||
    fail 'workflow permissions must be read-only actions and contents'
  [[ "$(query '.jobs | keys | sort | join(",")')" == 'check-published-image-pin,deploy-web' ]] ||
    fail 'workflow must define image-pin resolution and deployment jobs'
  [[ "$(query '.jobs.check-published-image-pin.if')" == "$expected_if" ]] ||
    fail 'image-pin resolution must run only for master dispatches or successful push publications'
  [[ "$(query '.jobs.deploy-web.needs')" == check-published-image-pin ]] ||
    fail 'deployment must wait for image-pin resolution'
  [[ "$(query '.jobs.deploy-web.if')" == "$expected_deploy_if" ]] ||
    fail 'deployment must skip before concurrency when no image pin exists'
  [[ "$(query '.jobs.check-published-image-pin.outputs.skip')" == '${{ steps.target.outputs.skip }}' ]] ||
    fail 'image-pin resolution must expose its skip result'
  [[ "$(query '.jobs.check-published-image-pin.outputs.sha')" == '${{ steps.target.outputs.sha }}' ]] ||
    fail 'image-pin resolution must expose its source SHA'
  [[ "$(query '.jobs.check-published-image-pin.outputs.run_id')" == '${{ steps.target.outputs.run_id }}' ]] ||
    fail 'image-pin resolution must expose its publication run'
  [[ "$(query '.jobs.check-published-image-pin.outputs.artifact_name')" == '${{ steps.target.outputs.artifact_name }}' ]] ||
    fail 'image-pin resolution must expose its artifact name'
  [[ "$(query '.jobs.check-published-image-pin.outputs.image_digest')" == '${{ steps.target.outputs.image_digest }}' ]] ||
    fail 'image-pin resolution must expose its image digest'
  [[ "$(query '.concurrency // {} | length')" == 0 ]] ||
    fail 'workflow-level concurrency must not queue image-pin resolver jobs'
  [[ "$(query '.jobs.check-published-image-pin.concurrency // {} | length')" == 0 ]] ||
    fail 'image-pin resolution must happen before deployment concurrency'
  [[ "$(query '.jobs.deploy-web.concurrency.group')" == deploy-teagram-web ]] ||
    fail 'deployment concurrency group must remain deploy-teagram-web'
  [[ "$(query '.jobs.deploy-web.concurrency."cancel-in-progress"')" == false ]] ||
    fail 'deployment must not cancel a running rollout'
  [[ "$(query '.jobs.deploy-web.environment')" == k3s-prod ]] ||
    fail 'deployment must use the k3s-prod environment'
  [[ "$(query '.jobs.check-published-image-pin.environment // ""')" == '' ]] ||
    fail 'image-pin resolution must not request production secrets'
  [[ "$(query '.jobs.deploy-web.permissions.actions')" == read &&
    "$(query '.jobs.deploy-web.permissions.contents')" == read ]] ||
    fail 'production workflow token permissions must remain read-only'
  [[ "$(query '.jobs.deploy-web.permissions | to_entries | map(select(.value != "read")) | length')" == 0 ]] ||
    fail 'production deployment must not request write token permissions'

  local checkout_count download_count uses
  checkout_count="$(query '[.jobs.deploy-web.steps[] | select(.uses // "" | test("^actions/checkout@"))] | length')"
  [[ "$checkout_count" == 1 ]] || fail 'deployment must check out only the published source commit'
  [[ "$(query '[.jobs.deploy-web.steps[] | select(.uses // "" | test("^actions/checkout@")) | .with.ref][0]')" == '${{ steps.refresh.outputs.sha }}' ]] ||
    fail 'deployment checkout must use the refreshed published SHA'
  [[ "$(query '[.jobs.deploy-web.steps[0].id][0]')" == refresh ]] ||
    fail 'deployment must refresh its target after acquiring the concurrency slot'
  download_count="$(query '[.jobs.deploy-web.steps[] | select((.uses // "" | test("^actions/download-artifact@")) and .with.name == "${{ steps.refresh.outputs.artifact_name }}" and .with."run-id" == "${{ steps.refresh.outputs.run_id }}" and .with."github-token" == "${{ github.token }}")] | length')"
  [[ "$download_count" == 1 ]] || fail 'image pin download must use the refreshed artifact name, run, and token'
  [[ "$(query '[.jobs.deploy-web.steps[] | select(.name == "Verify the source commit and image pin") | .env.DEPLOY_SHA][0]')" == '${{ steps.refresh.outputs.sha }}' ]] ||
    fail 'image pin verification must use the refreshed source SHA'
  [[ "$(query '[.jobs.deploy-web.steps[] | select(.name == "Verify the source commit and image pin") | .env.IMAGE_DIGEST][0]')" == '${{ steps.refresh.outputs.image_digest }}' ]] ||
    fail 'image pin verification must use the refreshed image digest'
  [[ "$(query '[.jobs.deploy-web.steps[] | select(.name == "Install the deploy kubeconfig")] | length')" == 1 &&
    "$(query '[.jobs.deploy-web.steps[] | select(.name == "Install the deploy kubeconfig") | .id][0]')" == kubeconfig &&
    "$(query '[.jobs.deploy-web.steps[] | select(.name == "Install the deploy kubeconfig") | .env.KUBECONFIG_CONTENT][0]')" == '${{ secrets.K3S_WEB_KUBECONFIG }}' ]] ||
    fail 'production must validate the dedicated web kubeconfig secret and expose its API host'
  [[ "$(query '[.jobs.deploy-web.steps[] | select(.name == "Join the tailnet")] | length')" == 1 &&
    "$(query '[.jobs.deploy-web.steps[] | select(.name == "Join the tailnet") | .uses][0]')" == 'tailscale/github-action@d1b6cd204f8dceda5b3eaad7f1f767be390056cd' &&
    "$(query '[.jobs.deploy-web.steps[] | select(.name == "Join the tailnet") | .with."oauth-client-id"][0]')" == '${{ secrets.K3S_TS_OAUTH_CLIENT_ID }}' &&
    "$(query '[.jobs.deploy-web.steps[] | select(.name == "Join the tailnet") | .with."oauth-secret"][0]')" == '${{ secrets.K3S_TS_OAUTH_SECRET }}' &&
    "$(query '[.jobs.deploy-web.steps[] | select(.name == "Join the tailnet") | .with.tags][0]')" == 'tag:k3s-deploy' &&
    "$(query '[.jobs.deploy-web.steps[] | select(.name == "Join the tailnet") | .with.ping][0]')" == '${{ steps.kubeconfig.outputs.api_host }}' ]] ||
    fail 'tailnet join must use the k3s deploy client and ping the validated API host'
  [[ "$(query '[.jobs.deploy-web.steps[] | select(.name == "Verify deploy kubeconfig identity and permissions")] | length')" == 1 ]] ||
    fail 'production must verify the least-privilege web kubeconfig identity before deployment'
  [[ "$(query '[.jobs.deploy-web.steps[] | select(.name == "Verify deploy kubeconfig identity and permissions") | .run][0]')" == \
    'bash .github/scripts/verify-deploy-identity.sh' ]] ||
    fail 'production must run the deploy kubeconfig identity and permission guard'
  [[ -f "$identity_guard_script" ]] || fail 'the deploy kubeconfig identity guard script must exist'
  local kubeconfig_index tailnet_index identity_guard_index deploy_index step_name
  kubeconfig_index="$(query '.jobs.deploy-web.steps | to_entries | .[] | select(.value.name == "Install the deploy kubeconfig") | .key')"
  tailnet_index="$(query '.jobs.deploy-web.steps | to_entries | .[] | select(.value.name == "Join the tailnet") | .key')"
  identity_guard_index="$(query '.jobs.deploy-web.steps | to_entries | .[] | select(.value.name == "Verify deploy kubeconfig identity and permissions") | .key')"
  deploy_index="$(query '.jobs.deploy-web.steps | to_entries | .[] | select(.value.name == "Deploy, verify the public route, and roll back on failure") | .key')"
  [[ "$kubeconfig_index" =~ ^[0-9]+$ && "$tailnet_index" =~ ^[0-9]+$ &&
    "$identity_guard_index" =~ ^[0-9]+$ && "$deploy_index" =~ ^[0-9]+$ ]] ||
    fail 'deployment step indices must be present'
  (( kubeconfig_index < tailnet_index && tailnet_index < identity_guard_index && identity_guard_index < deploy_index )) ||
    fail 'the deploy kubeconfig identity guard must run before the first cluster write'
  for step_name in 'Install the deploy kubeconfig' 'Join the tailnet' 'Verify deploy kubeconfig identity and permissions' 'Deploy, verify the public route, and roll back on failure'; do
    [[ "$(STEP_NAME="$step_name" query '[.jobs.deploy-web.steps[] | select(.name == strenv(STEP_NAME)) | .if // ""][0]')" == '' &&
      "$(STEP_NAME="$step_name" query '[.jobs.deploy-web.steps[] | select(.name == strenv(STEP_NAME)) | ."continue-on-error" // false][0]')" == false ]] ||
      fail "$step_name must stop on earlier failure"
  done
  [[ "$(query '[.jobs.deploy-web.steps[] | select(.name == "Remove the deploy kubeconfig") | .if][0]')" == '${{ always() }}' ]] ||
    fail 'the deploy kubeconfig must be removed after every deployment attempt'

  local deploy_run publisher_prefix target_run refresh_run
  deploy_run="$(query '[.jobs.deploy-web.steps[] | select(.name == "Deploy, verify the public route, and roll back on failure") | .run][0]')"
  [[ "$deploy_run" == *'.github/scripts/deploy-k8s-web.sh'* ]] ||
    fail 'production must use the shared rollback-safe k3s deployment script'
  [[ "$(query '[.jobs.deploy-web.steps[] | select(.name == "Deploy, verify the public route, and roll back on failure") | .env.REQUIRE_SINGLE_CLOUDFLARED][0]')" == true ]] ||
    fail 'production must require exactly one ready k3s tunnel connector'
  [[ "$(query '[.jobs.deploy-web.steps[] | select(.name == "Deploy, verify the public route, and roll back on failure") | .env.SMOKE_URL][0]')" == 'https://web.teagram.io/' ]] ||
    fail 'production smoke must verify the public web route'
  publisher_prefix="$(publisher_pin_prefix)"
  target_run="$(query '.jobs.check-published-image-pin.steps[] | select(.id == "target") | .run')"
  refresh_run="$(query '.jobs.deploy-web.steps[] | select(.id == "refresh") | .run')"
  for resolver in "$target_run" "$refresh_run"; do
    [[ "$resolver" == *"pin_prefix='$publisher_prefix'"* &&
      "$resolver" == *'test("^" + $prefix'* &&
      "$resolver" == *' =~ ^${pin_prefix}'* ]] ||
      fail 'deploy pin lookup must use the literal prefix from the publisher artifact name'
  done
  if query '.jobs.deploy-web.steps[].run // ""' | grep -Fq '${{'; then
    fail 'run blocks must pass GitHub values through environment variables'
  fi
  if query '.jobs.deploy-web.steps[].run // ""' | grep -Eiq '(^|[[:space:]])ssh[[:space:]]'; then
    fail 'the k3s deployment must not use the legacy SSH deploy path'
  fi

  local uses
  while IFS= read -r uses; do
    [[ -n "$uses" ]] || continue
    [[ "$uses" =~ ^[^@]+@[0-9a-f]{40}$ ]] || fail "action not pinned to a commit SHA: $uses"
  done < <(query '.jobs[].steps[].uses // ""')
  check_kubeconfig_validation
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
    '.on.workflow_dispatch.inputs.issue.required = true'
    'del(."run-name")'
    'del(.on.workflow_run.branches)'
    '.on.workflow_run.branches = ["master", "dev"]'
    '.jobs.check-published-image-pin.if = "wrong"'
    '.jobs.deploy-web.if = "wrong"'
    'del(.jobs.deploy-web.needs)'
    '.jobs.deploy-web.environment = "staging"'
    '.jobs.deploy-web.concurrency."cancel-in-progress" = true'
    '(.jobs.deploy-web.steps[] | select(.name == "Deploy, verify the public route, and roll back on failure") | .env.REQUIRE_SINGLE_CLOUDFLARED) = false'
    '(.jobs.deploy-web.steps[] | select(.name == "Deploy, verify the public route, and roll back on failure") | .env.SMOKE_URL) = "https://wrong.example/"'
    '(.jobs.deploy-web.steps[] | select(.uses | test("^actions/checkout@")) | .with.ref) = "${{ github.event.workflow_run.head_sha }}"'
    '(.jobs.deploy-web.steps[] | select(.uses | test("^actions/download-artifact@")) | .with."run-id") = "${{ github.run_id }}"'
    'del(.jobs.deploy-web.steps[] | select(.name == "Install the deploy kubeconfig").env.KUBECONFIG_CONTENT)'
    '(.jobs.deploy-web.steps[] | select(.name == "Join the tailnet") | .with.tags) = "tag:wrong"'
    'del(.jobs.deploy-web.steps[] | select(.name == "Join the tailnet").with.ping)'
    '(.jobs.deploy-web.steps[] | select(.name == "Join the tailnet") | .with."oauth-secret") = "${{ secrets.OLD_SECRET }}"'
    '(.jobs.deploy-web.steps[] | select(.name == "Join the tailnet") | ."continue-on-error") = true'
    'del(.jobs.deploy-web.steps[] | select(.name == "Verify deploy kubeconfig identity and permissions"))'
    '(.jobs.deploy-web.steps[] | select(.name == "Deploy, verify the public route, and roll back on failure") | .if) = "always()"'
    '.permissions.contents = "write"'
  )

  for mutation in "${mutations[@]}"; do
    yq "$mutation" "$workflow" >"$tmp/deploy.yml"
    if SKIP_PUBLICATION_CALL_GRAPH=true DEPLOY_WORKFLOW="$tmp/deploy.yml" bash "$0" --contract-only >/dev/null 2>&1; then
      printf 'contract accepted a broken workflow: %s\n' "$mutation" >&2
      exit 1
    fi
  done

  local guard_name forbidden_identity
  guard_name='Verify deploy kubeconfig identity and permissions'
  TEST_GUARD_NAME="$guard_name" yq \
    '(.jobs.deploy-web.steps) |= ([.[] | select(.name != strenv(TEST_GUARD_NAME))] + [.[] | select(.name == strenv(TEST_GUARD_NAME))])' \
    "$workflow" >"$tmp/deploy-after-write.yml"
  if SKIP_PUBLICATION_CALL_GRAPH=true DEPLOY_WORKFLOW="$tmp/deploy-after-write.yml" \
    bash "$0" --contract-only >"$tmp/deploy-after-write.out" 2>&1; then
    fail 'contract accepted a deploy identity guard moved after the first cluster write'
  fi
  grep -Fq 'before the first cluster write' "$tmp/deploy-after-write.out" ||
    fail 'moving the deploy identity guard must fail the cluster-write ordering check'

  forbidden_identity="${legacy_deploy_identity[0]}${legacy_deploy_identity[1]}"
  TEST_FORBIDDEN_IDENTITY="$forbidden_identity" yq \
    '(.jobs.deploy-web.steps[] | select(.name == "Verify deploy kubeconfig identity and permissions") | .run) = strenv(TEST_FORBIDDEN_IDENTITY)' \
    "$workflow" >"$tmp/deploy-legacy-identity.yml"
  if SKIP_PUBLICATION_CALL_GRAPH=true DEPLOY_WORKFLOW="$tmp/deploy-legacy-identity.yml" \
    bash "$0" --contract-only >"$tmp/deploy-legacy-identity.out" 2>&1; then
    fail 'contract accepted the legacy deploy identity in the workflow'
  fi
  grep -Fq 'legacy deploy identity reference found' "$tmp/deploy-legacy-identity.out" ||
    fail 'the legacy deploy identity mutation must fail the workflow and deploy script scan'
}

check_contract
if [[ "${1:-}" != '--contract-only' ]]; then
  check_deploy_identity_guard_behavior
  legacy_route_self_test
  publication_call_graph_self_test
  self_test
  printf 'deploy workflow contract holds\n'
fi
