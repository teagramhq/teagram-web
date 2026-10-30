#!/usr/bin/env bash
set -euo pipefail

workflow=".github/workflows/ci.yml"
caller_workflow=".github/workflows/private-artifact.yml"
jobs=(test-web check-deploy-workflow check-k8s-manifests test-k8s-deploy)

fail() {
  printf '%s: %s\n' "$workflow" "$1" >&2
  exit 1
}

query() {
  yq -r "$1" "$workflow"
}

caller_query() {
  yq -r "$1" "$caller_workflow"
}

ci_needs="$(query '.jobs.ci.needs[]')"
[[ "$(query '.jobs.ci.if')" == 'always()' ]] ||
  fail 'the final ci aggregator must run after cancellation to report a red result'

for job in "${jobs[@]}"; do
  [[ "$ci_needs" == *"$job"* ]] ||
    fail "$job must be included in the final ci aggregate"
  [[ "$(query ".jobs.\"$job\".permissions.actions")" == write ]] ||
    fail "$job needs Actions write permission to cancel its PR run"
  [[ "$(query ".jobs.\"$job\".steps[-1].name")" == 'Cancel PR workflow run after job failure' ]] ||
    fail "$job must cancel its PR run in the final step"

  cancel_if="$(query ".jobs.\"$job\".steps[-1].if")"
  [[ "$cancel_if" == *'failure()'* && "$cancel_if" == *"github.event_name == 'pull_request'"* ]] ||
    fail "$job must cancel only after a pull request job failure"
  [[ "$(query ".jobs.\"$job\".steps[-1].env.GH_TOKEN")" == '${{ github.token }}' ]] ||
    fail "$job must use the workflow token for cancellation"
  cancel_run="$(query ".jobs.\"$job\".steps[-1].run")"
  [[ "$cancel_run" == *'gh run cancel'* && "$cancel_run" == *'github.run_id'* && \
    "$cancel_run" == *'$GITHUB_REPOSITORY'* ]] ||
    fail "$job must cancel its current workflow run in the repository"
done

[[ "$(caller_query '.jobs.check-repository-ci.permissions.actions')" == write && \
  "$(caller_query '.jobs.check-repository-ci.permissions.contents')" == read ]] ||
  fail "$caller_workflow must pass Actions write to the reusable PR CI run"

printf 'PR CI fail-fast contract holds\n'
