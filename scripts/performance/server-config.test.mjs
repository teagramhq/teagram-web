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
  assert.match(workflow, /atlas migrate apply --url "\$TG_POSTGRES_DSN" --dir file:\/\/teagram-server\/migrations/);
  assert.match(workflow, /PERF_FIXTURE_SERVER_COMMIT: \$\{\{ steps\.fixture\.outputs\.server_commit \}\}/);
});
