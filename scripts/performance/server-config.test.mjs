import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {test} from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/performance.yml', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
const serverCheckout = process.env.PERF_SERVER_CHECKOUT || 'teagram-server';
const serverTestHelpers = readFileSync(resolve(serverCheckout, 'internal/pgtest/pgtest.go'), 'utf8');
const runtimeCommitPath = new URL('../../.github/perf-server-commit', import.meta.url);

test('the Vitest suite leaves native performance tests to node:test', () => {
  assert.match(viteConfig, /exclude:[\s\S]*?'scripts\/performance\/\*\*\/\*\.test\.mjs'/);
});

test('the restored fixture server uses the seeder auth-key encryption key', () => {
  const fixtureKey = serverTestHelpers.match(/func EncKey\(\) \[\]byte \{\s*return bytes\.Repeat\(\[\]byte\{0x([a-f0-9]{2})\}, (\d+)\)\s*\}/i);
  assert.ok(fixtureKey, 'could not find the deterministic performance fixture encryption key');

  const workflowKey = workflow.match(/^\s+TG_AUTHKEY_ENC_KEY=([a-f0-9]{64})\s*$/m)?.[1];
  assert.ok(workflowKey, 'could not find the server encryption key in the performance workflow');
  assert.equal(workflowKey, fixtureKey[1].repeat(Number(fixtureKey[2])));
});

test('the performance workflow migrates the fixture with a pinned runtime server', () => {
  assert.ok(existsSync(runtimeCommitPath), 'runtime server commit pin is missing');
  const runtimeCommit = readFileSync(runtimeCommitPath, 'utf8').trim();
  assert.match(runtimeCommit, /^[a-f0-9]{40}$/i, 'runtime server commit pin must be a full SHA');
  assert.match(workflow, /id: runtime-server[\s\S]*?server_commit=.*perf-server-commit/);
  assert.match(workflow, /ref: \$\{\{ steps\.runtime-server\.outputs\.server_commit \}\}/);
  assert.match(workflow, /atlas migrate apply --url "postgres:\/\/postgres:perf@localhost:5432\/teagram_\$scale\?sslmode=disable" --dir file:\/\/teagram-server\/migrations/);
  assert.match(workflow, /PERF_FIXTURE_SERVER_COMMIT: \$\{\{ steps\.fixture\.outputs\.server_commit \}\}/);
});

test('the performance workflow restores and migrates both scale snapshots', () => {
  assert.match(workflow, /for scale in 1x 100x/);
  assert.match(workflow, /snapshot\/perf_\$scale\.dump/);
  assert.match(workflow, /pg_restore[^\n]*-d "teagram_\$scale"/);
  assert.match(workflow, /atlas migrate apply --url "postgres:\/\/postgres:perf@localhost:5432\/teagram_\$scale/);
  assert.match(workflow, /fixture-1x\.json/);
  assert.match(workflow, /fixture-100x\.json/);
});

test('the performance workflow assigns the 1x and 100x browser origins to separate servers', () => {
  assert.match(workflow, /PERF_BASE_ORIGIN_1X/);
  assert.match(workflow, /PERF_HEAD_ORIGIN_1X/);
  assert.match(workflow, /PERF_BASE_ORIGIN_100X/);
  assert.match(workflow, /PERF_HEAD_ORIGIN_100X/);
  assert.match(workflow, /2443/);
  assert.match(workflow, /2444/);
  assert.match(workflow, /2445/);
  assert.match(workflow, /2446/);
});

test('PR performance runs require complete base bundle measurements', () => {
  assert.match(workflow, /PERF_REQUIRE_BASE: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test('performance comparisons are uninstrumented and diagnostics use a traced bundle', () => {
  assert.match(workflow, /pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-head-dist"/);
  assert.match(workflow, /pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-base-dist"/);
  assert.doesNotMatch(workflow, /VITE_PERF_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-(?:head|base)-dist"/);
  assert.match(workflow, /VITE_PERF_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-trace-dist"/);
});
