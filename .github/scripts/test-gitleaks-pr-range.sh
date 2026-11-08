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
yq -r '.jobs.check-security.steps[] | select(.name == "Fetch pull request commits for Gitleaks") | .run' \
  "$workflow" >"$tmp/gitleaks-fetch-step.sh"
yq -r '.jobs.check-security.steps[] | select(.name == "Scan pull request commits with Gitleaks") | .run' \
  "$workflow" >"$tmp/gitleaks-scan-step.sh"

fetch_token_env="$(yq -r '.jobs.check-security.steps[] | select(.name == "Fetch pull request commits for Gitleaks") | .env.GH_TOKEN' "$workflow")"
if [[ "$fetch_token_env" != '${{ github.token }}' ]]; then
  echo 'Gitleaks fetch step must use github.token' >&2
  exit 1
fi

assert_no_auth_env() {
  local scope="$1" env_keys="$2" variable
  while IFS= read -r variable; do
    case "$variable" in
      GH_TOKEN|GIT_CONFIG_*)
        printf '%s must not define %s\n' "$scope" "$variable" >&2
        exit 1
        ;;
    esac
  done <<<"$env_keys"
}

assert_no_git_config_env() {
  local scope="$1" env_keys="$2" variable
  while IFS= read -r variable; do
    case "$variable" in
      GIT_CONFIG_*)
        printf '%s must not define %s\n' "$scope" "$variable" >&2
        exit 1
        ;;
    esac
  done <<<"$env_keys"
}

workflow_env_keys="$(yq -r '(.env // {}) | keys | .[]' "$workflow")"
job_env_keys="$(yq -r '(.jobs.check-security.env // {}) | keys | .[]' "$workflow")"
fetch_env_keys="$(yq -r '.jobs.check-security.steps[] | select(.name == "Fetch pull request commits for Gitleaks") | (.env // {}) | keys | .[]' "$workflow")"
scan_env_keys="$(yq -r '.jobs.check-security.steps[] | select(.name == "Scan pull request commits with Gitleaks") | (.env // {}) | keys | .[]' "$workflow")"
assert_no_auth_env 'Workflow env' "$workflow_env_keys"
assert_no_auth_env 'Security job env' "$job_env_keys"
assert_no_git_config_env 'Gitleaks fetch step env' "$fetch_env_keys"
assert_no_auth_env 'Gitleaks scan step env' "$scan_env_keys"

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
token='workflow-contract-token'
auth_header="$(printf 'x-access-token:%s' "$token" | base64 -w0)"
check_auth_environment() {
  local scope="$1" entry variable
  while IFS= read -r entry; do
    variable="${entry%%=*}"
    case "$variable" in
      GH_TOKEN|GIT_CONFIG_*)
        printf '%s contains credential environment variable %s\n' "$scope" "$variable" >&2
        return 1
        ;;
    esac
    if [[ "$entry" == *"$token"* || "$entry" == *"$auth_header"* ]]; then
      printf '%s contains scan auth material\n' "$scope" >&2
      return 1
    fi
  done
}
check_auth_environment 'Gitleaks environment' < <(env)
if [[ ! -r "/proc/$PPID/environ" ]]; then
  echo 'Gitleaks test cannot inspect its parent environment' >&2
  exit 1
fi
check_auth_environment 'Gitleaks parent environment' < <(tr '\0' '\n' <"/proc/$PPID/environ")
extraheader_status=0
extraheader_config="$(git config --get-regexp extraheader 2>/dev/null)" || extraheader_status=$?
if [[ "$extraheader_status" -ne 1 || -n "$extraheader_config" ]]; then
  echo 'Gitleaks found an extraheader in Git config' >&2
  exit 1
fi
actual_commits="$(git rev-list --reverse "$range")"
expected_commits="$EXPECTED_COMMITS"
if [[ "$actual_commits" != "$expected_commits" ]]; then
  printf 'Gitleaks received commits outside the PR range. Expected:\n%s\nReceived:\n%s\n' \
    "$expected_commits" "$actual_commits" >&2
  exit 1
fi
printf 'ran\n' >>"$GITLEAKS_RUN_LOG"
SH
chmod +x "$tmp/bin/gitleaks"

real_git="$(command -v git)"
cat >"$tmp/bin/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == fetch ]]; then
  expected_auth_header="$(printf 'x-access-token:%s' 'workflow-contract-token' | base64 -w0)"
  if [[ "${GIT_CONFIG_COUNT:-}" != 1 || \
    "${GIT_CONFIG_KEY_0:-}" != 'http.https://github.com/.extraheader' || \
    "${GIT_CONFIG_VALUE_0:-}" != "AUTHORIZATION: basic $expected_auth_header" ]]; then
    echo 'Git fetch did not receive the scoped read-only auth header' >&2
    exit 1
  fi
  printf '%s\n' "$*" >>"$GIT_FETCH_AUTH_LOG"
fi
exec "$REAL_GIT" "$@"
SH
chmod +x "$tmp/bin/git"

run_gitleaks_steps() (
  local checkout_path="$1" head_sha="$2" pr_commits="$3" expected_commits="$4"
  local fetch_log="$tmp/$(basename "$checkout_path")-fetches.log"
  local scan_log="$tmp/$(basename "$checkout_path")-scans.log"
  local variable
  local -a clean_env=()
  local -a scan_clean_env=()
  while IFS= read -r variable; do
    case "$variable" in
      GIT_CONFIG_*) clean_env+=(-u "$variable") ;;
    esac
  done < <(compgen -e)
  scan_clean_env=("${clean_env[@]}" -u GH_TOKEN)
  cd "$checkout_path"
  env "${clean_env[@]}" \
    PATH="$tmp/bin:$PATH" \
    REAL_GIT="$real_git" \
    GIT_FETCH_AUTH_LOG="$fetch_log" \
    BASE_SHA="$base_sha" \
    HEAD_SHA="$head_sha" \
    PR_COMMITS="$pr_commits" \
    GH_TOKEN='workflow-contract-token' \
    RUNNER_TEMP="$tmp" \
    bash -euo pipefail "$tmp/gitleaks-fetch-step.sh"
  if [[ ! -s "$fetch_log" ]]; then
    echo 'Gitleaks range test did not observe an authenticated fetch' >&2
    exit 1
  fi
  env "${scan_clean_env[@]}" \
    PATH="$tmp/bin:$PATH" \
    REAL_GIT="$real_git" \
    GIT_FETCH_AUTH_LOG="$fetch_log" \
    GITLEAKS_RUN_LOG="$scan_log" \
    BASE_SHA="$base_sha" \
    HEAD_SHA="$head_sha" \
    RUNNER_TEMP="$tmp" \
    EXPECTED_COMMITS="$expected_commits" \
    bash -euo pipefail "$tmp/gitleaks-scan-step.sh"
  if [[ ! -s "$scan_log" ]]; then
    echo 'Gitleaks range test did not run the scanner step' >&2
    exit 1
  fi
)

simple_expected_commits="$(printf '%s\n%s' "$first_pr_commit" "$second_pr_commit")"
run_gitleaks_steps "$checkout" "$second_pr_commit" 2 "$simple_expected_commits"
[[ "$(git -C "$checkout" merge-base "$base_sha" "$second_pr_commit")" == "$branch_point" ]] || {
  echo 'advanced-base fetch did not establish the original branch point' >&2
  exit 1
}

merged_expected_commits="$(printf '%s\n%s\n%s\n%s\n%s' \
  "$first_pr_commit" "$second_pr_commit" "$merged_pr_merge_commit" \
  "$third_pr_commit" "$fourth_pr_commit")"
run_gitleaks_steps "$merged_checkout" "$merged_pr_commit" 5 "$merged_expected_commits"
[[ "$(git -C "$merged_checkout" merge-base "$base_sha" "$merged_pr_commit")" == "$merged_master_sha" ]] || {
  echo 'merged-base test fixture has an unexpected merge base' >&2
  exit 1
}
[[ "$(git -C "$seed" rev-list --count "$merged_master_sha..$merged_pr_commit")" == 5 ]] || {
  echo 'merged-base test fixture must have five PR commits' >&2
  exit 1
}
printf 'Gitleaks scanned only PR commits with advanced and merged bases and no scan auth\n'
