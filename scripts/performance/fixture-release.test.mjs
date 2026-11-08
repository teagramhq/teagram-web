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
  const retryDelays = [];
  let assetAttempts = 0;
  globalThis.fetch = async(url) => {
    if(String(url).endsWith('/manifest.json')) return new Response(JSON.stringify(manifest));
    ++assetAttempts;
    if(assetAttempts === 1) throw new Error('socket reset\nprovider detail');
    if(assetAttempts === 2) return new Response('Gateway Timeout', {status: 504});
    return new Response(data);
  };
  process.stderr.write = (chunk) => {
    retryMessages.push(String(chunk));
    return true;
  };

  try {
    await downloadFixtureRelease({version, outputDirectory, sleep: async(delay) => retryDelays.push(delay)});
    assert.equal(assetAttempts, 3);
    assert.deepEqual(readFileSync(join(outputDirectory, 'snapshot', 'fixture-100x.json')), data);
    const assetUrl = `https://github.com/teagramhq/teagram-server/releases/download/perf-fixture-${version}/fixture-100x.json`;
    assert.equal(retryMessages.length, 2);
    assert.match(retryMessages[0], /attempt 1/);
    assert.match(retryMessages[0], /network error: socket reset provider detail/);
    assert.match(retryMessages[1], /attempt 2/);
    assert.match(retryMessages[1], /last status: HTTP 504/);
    assert.deepEqual(retryDelays, [1000, 2000]);
    for(const message of retryMessages) {
      assert.ok(message.includes(assetUrl));
      assert.ok(message.includes('fixture-100x.json'));
      assert.equal(message.split('\n').length, 2);
      assert.ok(message.endsWith('\n'));
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
    rmSync(outputDirectory, {recursive: true, force: true});
  }
});

test('retries an interrupted asset body without keeping its partial download', async() => {
  const version = 'a'.repeat(64);
  const data = Buffer.from('complete fixture data');
  const manifest = {
    fixture: version,
    server_commit: 'b'.repeat(40),
    migration_revision: '20261025194500',
    assets: [{name: 'fixture-stream.json', sha256: digest(data)}]
  };
  const outputDirectory = mkdtempSync(join(tmpdir(), 'teagram-perf-fixture-'));
  const originalFetch = globalThis.fetch;
  const retryDelays = [];
  let assetAttempts = 0;
  globalThis.fetch = async(url) => {
    if(String(url).endsWith('/manifest.json')) return new Response(JSON.stringify(manifest));
    ++assetAttempts;
    if(assetAttempts === 1) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('partial'));
          controller.error(Object.assign(new Error('socket reset'), {code: 'ECONNRESET'}));
        }
      });
      return new Response(stream);
    }
    return new Response(data);
  };

  try {
    await downloadFixtureRelease({version, outputDirectory, sleep: async(delay) => retryDelays.push(delay)});
    assert.equal(assetAttempts, 2);
    assert.deepEqual(retryDelays, [1000]);
    assert.deepEqual(readFileSync(join(outputDirectory, 'snapshot', 'fixture-stream.json')), data);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDirectory, {recursive: true, force: true});
  }
});

test('keeps retrying a failing asset for at least two minutes without redownloading verified assets', async() => {
  const version = 'a'.repeat(64);
  const verifiedData = Buffer.from('verified asset');
  const failingData = Buffer.from('failing asset');
  const manifest = {
    fixture: version,
    server_commit: 'b'.repeat(40),
    migration_revision: '20261025194500',
    assets: [
      {name: 'fixture-verified.json', sha256: digest(verifiedData)},
      {name: 'fixture-flaky.json', sha256: digest(failingData)}
    ]
  };
  const outputDirectory = mkdtempSync(join(tmpdir(), 'teagram-perf-fixture-'));
  const originalFetch = globalThis.fetch;
  const retryDelays = [];
  const assetAttempts = new Map();
  globalThis.fetch = async(url) => {
    const value = String(url);
    if(value.endsWith('/manifest.json')) return new Response(JSON.stringify(manifest));
    const assetName = value.split('/').pop();
    assetAttempts.set(assetName, (assetAttempts.get(assetName) || 0) + 1);
    if(assetName === 'fixture-verified.json') return new Response(verifiedData);
    return new Response('Service Unavailable', {status: 503});
  };

  try {
    await assert.rejects(
      downloadFixtureRelease({version, outputDirectory, sleep: async(delay) => retryDelays.push(delay)}),
      (error) => {
        assert.match(error.message, /fixture-flaky\.json.*after \d+ attempts.*last status: HTTP 503/);
        return true;
      }
    );
    assert.equal(assetAttempts.get('fixture-verified.json'), 1);
    assert.equal(assetAttempts.get('fixture-flaky.json'), retryDelays.length + 1);
    assert.ok(retryDelays.reduce((total, delay) => total + delay, 0) >= 120_000);
    assert.deepEqual(retryDelays.slice(0, 5), [1000, 2000, 4000, 8000, 16000]);
    assert.ok(retryDelays.every((delay) => delay <= 30_000));
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDirectory, {recursive: true, force: true});
  }
});

test('fails on a 404 immediately and names the asset and response status', async() => {
  const version = 'a'.repeat(64);
  const data = Buffer.from('fixture data');
  const manifest = {
    fixture: version,
    server_commit: 'b'.repeat(40),
    migration_revision: '20261025194500',
    assets: [{name: 'fixture-404.json', sha256: digest(data)}]
  };
  const outputDirectory = mkdtempSync(join(tmpdir(), 'teagram-perf-fixture-'));
  const originalFetch = globalThis.fetch;
  const retryDelays = [];
  let assetAttempts = 0;
  globalThis.fetch = async(url) => {
    if(String(url).endsWith('/manifest.json')) return new Response(JSON.stringify(manifest));
    ++assetAttempts;
    return new Response('Not Found', {status: 404});
  };

  try {
    await assert.rejects(
      downloadFixtureRelease({version, outputDirectory, sleep: async(delay) => retryDelays.push(delay)}),
      /fixture-404\.json.*after 1 attempt.*last status: HTTP 404/
    );
    assert.equal(assetAttempts, 1);
    assert.deepEqual(retryDelays, []);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDirectory, {recursive: true, force: true});
  }
});
