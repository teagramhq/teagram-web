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

test('retries a temporary 502 while downloading a fixture asset', async() => {
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
  let assetAttempts = 0;
  globalThis.fetch = async(url) => {
    if(String(url).endsWith('/manifest.json')) return new Response(JSON.stringify(manifest));
    ++assetAttempts;
    if(assetAttempts === 1) return new Response('Bad Gateway', {status: 502});
    return new Response(data);
  };

  try {
    await downloadFixtureRelease({version, outputDirectory});
    assert.equal(assetAttempts, 2);
    assert.deepEqual(readFileSync(join(outputDirectory, 'snapshot', 'fixture-100x.json')), data);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDirectory, {recursive: true, force: true});
  }
});
