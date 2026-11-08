import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {assetPath, downloadFixtureRelease, reconstructAssets, validateManifest} from './fixture-release.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

test('validates the pinned manifest and reconstructed asset paths', () => {
  const manifest = validateManifest({
    fixture: 'a'.repeat(64),
    server_commit: 'b'.repeat(40),
    migration_revision: '20261025194500',
    assets: [{name: 'fixture-100x.json', sha256: digest('fixture')}]
  }, 'a'.repeat(64));

  assert.equal(manifest.server_commit, 'b'.repeat(40));
  assert.equal(assetPath('blobs-100x__a__b.bin'), 'blobs-100x/a/b.bin');
});

test('rejects an asset whose checksum differs from the manifest', () => {
  assert.throws(() => reconstructAssets([
    {name: 'fixture-100x.json', sha256: '0'.repeat(64), data: Buffer.from('fixture')}
  ]), /checksum/);
});

test('joins split assets in numeric order and validates each part checksum', () => {
  const assets = [
    {name: 'perf_100x.dump.part001', data: Buffer.from('second')},
    {name: 'perf_100x.dump.part000', data: Buffer.from('first')}
  ].map((asset) => ({...asset, sha256: digest(asset.data)}));

  const files = reconstructAssets(assets);
  assert.equal(files.get('perf_100x.dump').toString(), 'firstsecond');
});

test('rejects path traversal and missing split parts', () => {
  assert.throws(() => assetPath('../outside'), /unsafe/);
  assert.throws(() => reconstructAssets([
    {name: 'perf_100x.dump.part001', sha256: digest('only'), data: Buffer.from('only')}
  ]), /missing part/);
});

test('logs and retries temporary network and HTTP failures while downloading a fixture asset', async() => {
  const version = 'a'.repeat(64);
  const data = Buffer.from('fixture data');
  const manifest = {
    fixture: version,
    server_commit: 'b'.repeat(40),
    migration_revision: '20261025194500',
    assets: [{name: 'fixture-100x.json', sha256: digest(data)}]
  };
  const outputDirectory = mkdtempSync(join(tmpdir(), 'teagram-perf-fixture-'));
  const originalFetch = globalThis.fetch;
  const originalStderrWrite = process.stderr.write;
  const retryMessages = [];
  let assetAttempts = 0;
  globalThis.fetch = async(url) => {
    if(String(url).endsWith('/manifest.json')) return new Response(JSON.stringify(manifest));
    ++assetAttempts;
    if(assetAttempts === 1) throw new Error('socket reset\nprovider detail');
    if(assetAttempts === 2) return new Response('Bad Gateway', {status: 502});
    return new Response(data);
  };
  process.stderr.write = (chunk) => {
    retryMessages.push(String(chunk));
    return true;
  };

  try {
    await downloadFixtureRelease({version, outputDirectory});
    assert.equal(assetAttempts, 3);
    assert.deepEqual(readFileSync(join(outputDirectory, 'snapshot', 'fixture-100x.json')), data);
    const assetUrl = `https://github.com/teagramhq/teagram-server/releases/download/perf-fixture-${version}/fixture-100x.json`;
    assert.equal(retryMessages.length, 2);
    assert.match(retryMessages[0], /attempt 1\/4/);
    assert.match(retryMessages[0], /network error: socket reset provider detail/);
    assert.match(retryMessages[1], /attempt 2\/4/);
    assert.match(retryMessages[1], /HTTP 502/);
    for(const message of retryMessages) {
      assert.ok(message.includes(assetUrl));
      assert.equal(message.split('\n').length, 2);
      assert.ok(message.endsWith('\n'));
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
    rmSync(outputDirectory, {recursive: true, force: true});
  }
});
