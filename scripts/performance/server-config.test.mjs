import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {test} from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/performance.yml', import.meta.url), 'utf8');
const serverCheckout = process.env.PERF_SERVER_CHECKOUT || 'teagram-server';
const serverTestHelpers = readFileSync(resolve(serverCheckout, 'internal/pgtest/pgtest.go'), 'utf8');

test('the restored fixture server uses the seeder auth-key encryption key', () => {
  const fixtureKey = serverTestHelpers.match(/func EncKey\(\) \[\]byte \{\s*return bytes\.Repeat\(\[\]byte\{0x([a-f0-9]{2})\}, (\d+)\)\s*\}/i);
  assert.ok(fixtureKey, 'could not find the deterministic performance fixture encryption key');

  const workflowKey = workflow.match(/^\s+TG_AUTHKEY_ENC_KEY=([a-f0-9]{64})\s*$/m)?.[1];
  assert.ok(workflowKey, 'could not find the server encryption key in the performance workflow');
  assert.equal(workflowKey, fixtureKey[1].repeat(Number(fixtureKey[2])));
});
