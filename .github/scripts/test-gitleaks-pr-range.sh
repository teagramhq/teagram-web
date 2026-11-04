#!/usr/bin/env bash
set -euo pipefail

workflow="${REPOSITORY_CI_WORKFLOW:-.github/workflows/ci.yml}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
seed="$tmp/seed"
checkout="$tmp/checkout"

git init --quiet --bare "$tmp/origin.git"
git init --quiet -b master "$seed"
git -C "$seed" config user.name 'Workflow contract'
git -C "$seed" config user.email 'workflow-contract@example.invalid'
printf 'base\n' >"$seed/history.txt"
git -C "$seed" add history.txt
git -C "$seed" commit --quiet -m 'root'
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
for index in 1 2 3 4 5 6; do
  printf 'base advance %s\n' "$index" >>"$seed/history.txt"
  git -C "$seed" commit --quiet -am "base advance $index"
done
base_sha="$(git -C "$seed" rev-parse HEAD)"
git -C "$seed" push --quiet "$tmp/origin.git" master

git clone --quiet --depth=1 --branch pull-request "file://$tmp/origin.git" "$checkout"
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
expected_commits="$(printf '%s\n%s' "$EXPECTED_FIRST_PR_COMMIT" "$EXPECTED_SECOND_PR_COMMIT")"
if [[ "$actual_commits" != "$expected_commits" ]]; then
  printf 'Gitleaks received commits outside the PR range. Expected:\n%s\nReceived:\n%s\n' \
    "$expected_commits" "$actual_commits" >&2
  exit 1
fi
SH
chmod +x "$tmp/bin/gitleaks"

(
  cd "$checkout"
  PATH="$tmp/bin:$PATH" \
    BASE_SHA="$base_sha" \
    HEAD_SHA="$second_pr_commit" \
    PR_COMMITS=2 \
    RUNNER_TEMP="$tmp" \
    EXPECTED_FIRST_PR_COMMIT="$first_pr_commit" \
    EXPECTED_SECOND_PR_COMMIT="$second_pr_commit" \
    bash -euo pipefail "$tmp/gitleaks-step.sh"
)
[[ "$(git -C "$checkout" merge-base "$base_sha" "$second_pr_commit")" == "$branch_point" ]] || {
  echo 'advanced-base fetch did not establish the original branch point' >&2
  exit 1
}
printf 'Gitleaks scanned only PR commits with an advanced base\n'
