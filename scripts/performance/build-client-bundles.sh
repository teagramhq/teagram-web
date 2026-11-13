#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo 'expected the client build environment output path' >&2
  exit 2
fi

client_build_env="$1"
: > "$client_build_env"

VITE_PERF_RECONCILE_TRACE=1 VITE_PERF_SEARCH_TRACE=1 VITE_PERF_HISTORY_TRACE=1 pnpm exec vite build --outDir "$RUNNER_TEMP/teagram-web-head-dist"
VITE_PERF_TRACE=1 pnpm exec vite build --outDir "$RUNNER_TEMP/teagram-web-trace-dist"
if [ -n "$PERF_BASE_SHA" ]; then
  base_directory="$RUNNER_TEMP/teagram-web-base"
  git worktree add --detach "$base_directory" "$PERF_BASE_SHA"
  ln -s "$GITHUB_WORKSPACE/node_modules" "$base_directory/node_modules"
  node scripts/performance/inject-search-rpc-tracer.mjs "$base_directory/src/lib/appManagers/apiManager.ts"
  (cd "$base_directory" && VITE_PERF_RECONCILE_TRACE=1 VITE_PERF_SEARCH_TRACE=1 VITE_PERF_HISTORY_TRACE=1 pnpm exec vite build --outDir "$RUNNER_TEMP/teagram-web-base-dist")
  (cd "$base_directory" && VITE_PERF_TRACE=1 pnpm exec vite build --outDir "$RUNNER_TEMP/teagram-web-base-trace-dist")
  sticker_base_sha="$(cat .github/perf-sticker-base-commit)"
  sticker_base_directory="$RUNNER_TEMP/teagram-web-sticker-base"
  git worktree add --detach "$sticker_base_directory" "$sticker_base_sha"
  ln -s "$GITHUB_WORKSPACE/node_modules" "$sticker_base_directory/node_modules"
  (cd "$sticker_base_directory" && pnpm exec vite build --outDir "$RUNNER_TEMP/teagram-web-sticker-base-dist")
  echo "PERF_BASE_DIST=$RUNNER_TEMP/teagram-web-base-dist" >> "$client_build_env"
  echo "PERF_TRACE_BASE_DIST=$RUNNER_TEMP/teagram-web-base-trace-dist" >> "$client_build_env"
  echo "PERF_STICKER_BASE_DIST=$RUNNER_TEMP/teagram-web-sticker-base-dist" >> "$client_build_env"
  echo 'PERF_STICKER_BASE_ORIGIN=http://localhost:4179' >> "$client_build_env"
  echo 'PERF_TRACE_BASE_ORIGIN_100X=http://localhost:4178' >> "$client_build_env"
  echo 'PERF_BASE_ORIGIN_1X=http://localhost:4173' >> "$client_build_env"
  echo 'PERF_BASE_ORIGIN_100X=http://localhost:4175' >> "$client_build_env"
else
  echo "PERF_BASE_DIST=$RUNNER_TEMP/teagram-web-head-dist" >> "$client_build_env"
  echo "PERF_TRACE_BASE_DIST=$RUNNER_TEMP/teagram-web-trace-dist" >> "$client_build_env"
  echo 'PERF_BASE_ORIGIN_1X=' >> "$client_build_env"
  echo 'PERF_BASE_ORIGIN_100X=' >> "$client_build_env"
fi
echo "PERF_HEAD_DIST=$RUNNER_TEMP/teagram-web-head-dist" >> "$client_build_env"
echo "PERF_TRACE_HEAD_DIST=$RUNNER_TEMP/teagram-web-trace-dist" >> "$client_build_env"
echo 'PERF_HEAD_ORIGIN_1X=http://localhost:4174' >> "$client_build_env"
echo 'PERF_HEAD_ORIGIN_100X=http://localhost:4176' >> "$client_build_env"
echo 'PERF_TRACE_HEAD_ORIGIN_100X=http://localhost:4177' >> "$client_build_env"
