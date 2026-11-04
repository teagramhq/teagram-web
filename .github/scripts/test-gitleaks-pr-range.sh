#!/usr/bin/env bash
set -euo pipefail

workflow="${REPOSITORY_CI_WORKFLOW:-.github/workflows/ci.yml}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
seed="$tmp/seed"
checkout="$tmp/checkout"
merged_checkout="$tmp/merged-checkout"

git init --quiet --bare "$tmp/origin.git"
git init --quiet -b master "$seed"
git -C "$seed" config user.name 'Workflow contract'
git -C "$seed" config user.email 'workflow-contract@example.invalid'
printf 'base\n' >"$seed/history.txt"
git -C "$seed" add history.txt
git -C "$seed" commit --quiet -m 'root'
for index in 1 2 3 4 5 6 7 8; do
  printf 'shared history %s\n' "$index" >>"$seed/history.txt"
  git -C "$seed" commit --quiet -am "shared history $index"
done
printf 'branch point\n' >>"$seed/history.txt"
git -C "$seed" commit --quiet -am 'branch point'
branch_point="$(git -C "$seed" rev-parse HEAD)"
git -C "$seed" push --quiet "$tmp/origin.git" master

git -C "$seed" switch --quiet -c pull-request
printf 'first PR change\n' >"$seed/pr.txt"
git -C "$seed" add pr.txt
git -C "$seed" commit --quiet -m 'first PR change'
first_pr_commit="$(git -C "$seed" rev-parse HEAD)"
printf 'second PR change\n' >>"$seed/pr.txt"
git -C "$seed" commit --quiet -am 'second PR change'
second_pr_commit="$(git -C "$seed" rev-parse HEAD)"
git -C "$seed" push --quiet "$tmp/origin.git" pull-request

git -C "$seed" switch --quiet master
# Keep the merge point well past the PR branch point.
for index in 1 2 3 4 5 6 7 8 9 10; do
  printf 'base advance %s\n' "$index" >>"$seed/history.txt"
  git -C "$seed" commit --quiet -am "base advance $index"
done
merged_master_sha="$(git -C "$seed" rev-parse HEAD)"
git -C "$seed" switch --quiet pull-request
git -C "$seed" merge --quiet --no-ff -m 'merge master into pull request' master
merged_pr_merge_commit="$(git -C "$seed" rev-parse HEAD)"
printf 'PR change 3\n' >>"$seed/pr.txt"
git -C "$seed" commit --quiet -am 'PR change 3'
third_pr_commit="$(git -C "$seed" rev-parse HEAD)"
printf 'PR change 4\n' >>"$seed/pr.txt"
git -C "$seed" commit --quiet -am 'PR change 4'
fourth_pr_commit="$(git -C "$seed" rev-parse HEAD)"
merged_pr_commit="$fourth_pr_commit"
git -C "$seed" push --quiet "$tmp/origin.git" HEAD:refs/heads/pull-request-merged
git -C "$seed" switch --quiet master
# Advance master so its shallow history reaches the merge point but not the branch point.
for index in 11 12 13 14 15; do
  printf 'base advance %s\n' "$index" >>"$seed/history.txt"
  git -C "$seed" commit --quiet -am "base advance $index"
done
base_sha="$(git -C "$seed" rev-parse HEAD)"
git -C "$seed" push --quiet "$tmp/origin.git" master

git -C "$seed" switch --quiet -c workflow-merge-simple master
git -C "$seed" merge --quiet --no-ff -m 'GitHub pull request merge' "$second_pr_commit"
git -C "$seed" push --quiet "$tmp/origin.git" HEAD:refs/heads/workflow-merge-simple
git -C "$seed" switch --quiet master
git -C "$seed" switch --quiet -c workflow-merge-merged master
git -C "$seed" merge --quiet --no-ff -m 'GitHub pull request merge' "$merged_pr_commit"
git -C "$seed" push --quiet "$tmp/origin.git" HEAD:refs/heads/workflow-merge-merged

# Pull request CI checks out GitHub's synthetic merge commit, then fetches the PR refs.
git clone --quiet --depth=1 --branch workflow-merge-simple "file://$tmp/origin.git" "$checkout"
git clone --quiet --depth=1 --branch workflow-merge-merged "file://$tmp/origin.git" "$merged_checkout"
yq -r '.jobs.check-security.steps[] | select(.name == "Scan pull request commits with Gitleaks") | .run' \
  "$workflow" >"$tmp/gitleaks-step.sh"

mkdir "$tmp/bin"
cat >"$tmp/bin/gitleaks" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
range=
for argument in "$@"; do
  if [[ "$argument" == --log-opts=* ]]; then
    range="${argument#--log-opts=}"
  fi
done
actual_commits="$(git rev-list --reverse "$range")"
expected_commits="$EXPECTED_COMMITS"
if [[ "$actual_commits" != "$expected_commits" ]]; then
  printf 'Gitleaks received commits outside the PR range. Expected:\n%s\nReceived:\n%s\n' \
    "$expected_commits" "$actual_commits" >&2
  exit 1
fi
SH
chmod +x "$tmp/bin/gitleaks"

run_gitleaks_step() (
  local checkout_path="$1" head_sha="$2" pr_commits="$3" expected_commits="$4"
  cd "$checkout_path"
  PATH="$tmp/bin:$PATH" \
    BASE_SHA="$base_sha" \
    HEAD_SHA="$head_sha" \
    PR_COMMITS="$pr_commits" \
    RUNNER_TEMP="$tmp" \
    EXPECTED_COMMITS="$expected_commits" \
    bash -euo pipefail "$tmp/gitleaks-step.sh"
)

simple_expected_commits="$(printf '%s\n%s' "$first_pr_commit" "$second_pr_commit")"
run_gitleaks_step "$checkout" "$second_pr_commit" 2 "$simple_expected_commits"
[[ "$(git -C "$checkout" merge-base "$base_sha" "$second_pr_commit")" == "$branch_point" ]] || {
  echo 'advanced-base fetch did not establish the original branch point' >&2
  exit 1
}

merged_expected_commits="$(printf '%s\n%s\n%s\n%s\n%s' \
  "$first_pr_commit" "$second_pr_commit" "$merged_pr_merge_commit" \
  "$third_pr_commit" "$fourth_pr_commit")"
run_gitleaks_step "$merged_checkout" "$merged_pr_commit" 5 "$merged_expected_commits"
[[ "$(git -C "$merged_checkout" merge-base "$base_sha" "$merged_pr_commit")" == "$merged_master_sha" ]] || {
  echo 'merged-base test fixture has an unexpected merge base' >&2
  exit 1
}
[[ "$(git -C "$seed" rev-list --count "$merged_master_sha..$merged_pr_commit")" == 5 ]] || {
  echo 'merged-base test fixture must have five PR commits' >&2
  exit 1
}
printf 'Gitleaks scanned only PR commits with advanced and merged bases\n'
