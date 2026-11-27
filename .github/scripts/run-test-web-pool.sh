#!/usr/bin/env bash
set -euo pipefail

phase="${1:-}"
case "$phase" in
  checks)
    worker_limit=3
    stages=(unit-tests typecheck lint)
    ;;
  *)
    printf 'unknown test:web pool phase: %s\n' "$phase" >&2
    exit 2
    ;;
esac

run_stage_command() {
  local stage="$1"

  case "$stage" in
    unit-tests)
      pnpm test --run
      ;;
    typecheck)
      pnpm run typecheck
      ;;
    lint)
      pnpm run lint
      ;;
    *)
      printf 'unknown test:web pool stage: %s\n' "$stage" >&2
      return 2
      ;;
  esac
}

run_stage() {
  local stage="$1"
  local stage_dir="$RUNNER_TEMP/test-web-$phase"
  local log_file="$stage_dir/$stage.log"
  local result_file="$stage_dir/$stage.exit"
  local status

  if run_stage_command "$stage" 2>&1 | tee "$log_file" | sed --unbuffered "s/^/[$stage] /"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$status" >"$result_file"
}

stage_dir="$RUNNER_TEMP/test-web-$phase"
mkdir -p "$stage_dir"

for stage in "${stages[@]}"; do
  while (( $(jobs -pr | wc -l) >= worker_limit )); do
    wait -n || true
  done
  run_stage "$stage" &
done
wait || true

failed=0
for stage in "${stages[@]}"; do
  result_file="$stage_dir/$stage.exit"
  if [[ -f "$result_file" ]]; then
    status="$(<"$result_file")"
  else
    status=127
  fi

  printf '::group::test: web / %s (exit %s)\n' "$stage" "$status"
  printf '::endgroup::\n'

  if [[ "$status" != 0 ]]; then
    printf '::error title=test: web / %s::stage %s failed with exit code %s\n' "$stage" "$stage" "$status"
    failed=1
  fi
done

exit "$failed"
