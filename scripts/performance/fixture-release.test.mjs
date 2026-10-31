import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {assetPath, reconstructAssets, validateManifest} from './fixture-release.mjs';

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
