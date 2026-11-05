import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/performance.yml', import.meta.url), 'utf8');

test('performance comparisons use a reconcile-only head bundle and an uninstrumented base bundle', () => {
  assert.match(workflow, /^\s+VITE_PERF_RECONCILE_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-head-dist"\s*$/m);
  assert.match(workflow, /^\s+\(cd "\$base_directory" && pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-base-dist"\)\s*$/m);
  assert.doesNotMatch(workflow, /VITE_PERF_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-(?:head|base)-dist"/);
});

test('performance tracing uses a separate diagnostic bundle', () => {
  assert.match(workflow, /VITE_PERF_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-trace-dist"/);
  assert.match(workflow, /PERF_TRACE_HEAD_ORIGIN_100X=http:\/\/localhost:4177/);
  assert.match(workflow, /TG_WEBSOCKET_ALLOWED_ORIGINS=.*http:\/\/localhost:4177/);
});
