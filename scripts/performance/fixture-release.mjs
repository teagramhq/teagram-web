import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Readable, Transform} from 'node:stream';
import {pathToFileURL} from 'node:url';

const FIXTURE_REPOSITORY = 'teagramhq/teagram-server';
const HASH_RE = /^[a-f0-9]{64}$/i;
const MIN_RETRY_WINDOW_MS = 300_000;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const NETWORK_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
]);

export function assetPath(name) {
  if(typeof(name) !== 'string' || !name || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`unsafe release asset name: ${name}`);
  }
  const path = name.replaceAll('__', '/');
  if(path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe release asset path: ${name}`);
  }
  return path;
}

export function validateManifest(manifest, pinnedVersion) {
  if(!manifest || manifest.fixture !== pinnedVersion || !HASH_RE.test(pinnedVersion)) {
    throw new Error(`fixture manifest does not match pinned version ${pinnedVersion}`);
  }
  if(typeof(manifest.server_commit) !== 'string' || !/^[a-f0-9]{40}$/i.test(manifest.server_commit)) {
    throw new Error('fixture manifest has an invalid server_commit');
  }
  if(typeof(manifest.migration_revision) !== 'string' || !manifest.migration_revision.trim()) {
    throw new Error('fixture manifest has no migration_revision');
  }
  if(!Array.isArray(manifest.assets) || !manifest.assets.length) {
    throw new Error('fixture manifest has no assets');
  }

  const names = new Set();
  for(const asset of manifest.assets) {
    assetPath(asset?.name);
    if(!HASH_RE.test(asset?.sha256 || '')) throw new Error(`invalid checksum for asset ${asset?.name}`);
    if(names.has(asset.name)) throw new Error(`duplicate asset ${asset.name}`);
    names.add(asset.name);
  }
  return manifest;
}

function verifyAsset(asset) {
  const digest = createHash('sha256').update(asset.data).digest('hex');
  if(digest !== asset.sha256) throw new Error(`checksum mismatch for ${asset.name}`);
}

export function reconstructAssets(assets) {
  const ordinary = new Map();
  const split = new Map();
  for(const asset of assets) {
    verifyAsset(asset);
    const match = /^(.*)\.part(\d{3})$/.exec(asset.name);
    if(match) {
      const parts = split.get(match[1]) || [];
      parts.push({index: Number(match[2]), data: asset.data});
      split.set(match[1], parts);
    } else {
      ordinary.set(asset.name, asset.data);
    }
  }

  for(const [name, parts] of split) {
    if(ordinary.has(name)) throw new Error(`asset is both split and unsplit: ${name}`);
    parts.sort((a, b) => a.index - b.index);
    for(let index = 0; index < parts.length; ++index) {
      if(parts[index].index !== index) throw new Error(`missing part ${index} for ${name}`);
    }
    ordinary.set(name, Buffer.concat(parts.map((part) => part.data)));
  }

  const files = new Map();
  for(const [name, data] of ordinary) {
    const path = assetPath(name);
    if(files.has(path)) throw new Error(`release assets collide at ${path}`);
    files.set(path, data);
  }
  return files;
}

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ');
}

function isNetworkError(error) {
  for(let current = error; current; current = current.cause) {
    if(NETWORK_ERROR_CODES.has(current.code)) return true;
    if(/fetch failed|terminated|network error|socket|connection reset|timed out/i.test(current.message || '')) return true;
  }
  return false;
}

function assetFailure(assetName, attempts, lastStatus, error) {
  const attemptLabel = attempts === 1 ? 'attempt' : 'attempts';
  const message = `failed to download release asset ${assetName} after ${attempts} ${attemptLabel} (last status: ${lastStatus})`;
  return error ? new Error(`${message}: ${errorMessage(error)}`, {cause: error}) : new Error(message);
}

function retryDelay(attempt) {
  return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

function sleepFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchReleaseAsset(url, assetName, consumeResponse, sleep) {
  let attempts = 0;
  let totalRetryDelayMs = 0;
  let lastStatus = 'no response';

  const retry = async() => {
    if(totalRetryDelayMs >= MIN_RETRY_WINDOW_MS) throw assetFailure(assetName, attempts, lastStatus);
    const delay = retryDelay(attempts);
    process.stderr.write(`Retrying fixture release asset ${assetName} (attempt ${attempts}, last status: ${lastStatus}, next retry in ${delay}ms): ${url}\n`);
    await sleep(delay);
    totalRetryDelayMs += delay;
  };

  while(true) {
    ++attempts;
    let response;
    try {
      response = await fetch(url, {redirect: 'follow'});
    } catch(error) {
      lastStatus = `network error: ${errorMessage(error)}`;
      if(totalRetryDelayMs >= MIN_RETRY_WINDOW_MS) throw assetFailure(assetName, attempts, lastStatus, error);
      await retry();
      continue;
    }

    lastStatus = `HTTP ${response.status}`;
    if(response.status >= 500 && response.status <= 599) {
      await retry();
      continue;
    }
    if(!response.ok || !response.body) {
      if(!response.body) lastStatus += ', empty response body';
      throw assetFailure(assetName, attempts, lastStatus);
    }

    try {
      return await consumeResponse(response);
    } catch(error) {
      if(!isNetworkError(error)) throw assetFailure(assetName, attempts, lastStatus, error);
      lastStatus = `HTTP ${response.status}; network error: ${errorMessage(error)}`;
      if(totalRetryDelayMs >= MIN_RETRY_WINDOW_MS) throw assetFailure(assetName, attempts, lastStatus, error);
      await retry();
    }
  }
}

async function fetchBytes(url, assetName, sleep) {
  return fetchReleaseAsset(url, assetName, async(response) => {
    const chunks = [];
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback(null, chunk);
      }
    }));
    return Buffer.concat(chunks);
  }, sleep);
}

async function downloadAsset(url, assetName, targetPath, expectedHash, sleep) {
  await fetchReleaseAsset(url, assetName, async(response) => {
    rmSync(targetPath, {force: true});
    const digest = createHash('sha256');
    const hasher = new Transform({
      transform(chunk, encoding, callback) {
        digest.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(targetPath));
    const actualHash = digest.digest('hex');
    if(actualHash !== expectedHash) throw new Error(`checksum mismatch for ${assetName}`);
  }, sleep);
}

async function reconstructDownloadedAssets(assets, downloadedDirectory, snapshotDirectory) {
  const ordinary = new Map();
  const split = new Map();
  for(const asset of assets) {
    const match = /^(.*)\.part(\d{3})$/.exec(asset.name);
    if(match) {
      const parts = split.get(match[1]) || [];
      parts.push({index: Number(match[2]), asset});
      split.set(match[1], parts);
    } else {
      ordinary.set(asset.name, asset);
    }
  }

  const install = async(name, sources) => {
    const relativePath = assetPath(name);
    const targetPath = join(snapshotDirectory, relativePath);
    mkdirSync(resolve(targetPath, '..'), {recursive: true});
    for(let index = 0; index < sources.length; ++index) {
      const source = join(downloadedDirectory, sources[index].name);
      await pipeline(createReadStream(source), createWriteStream(targetPath, {flags: index ? 'a' : 'w'}));
    }
  };

  for(const [name, asset] of ordinary) await install(name, [asset]);
  for(const [name, parts] of split) {
    if(ordinary.has(name)) throw new Error(`asset is both split and unsplit: ${name}`);
    parts.sort((a, b) => a.index - b.index);
    for(let index = 0; index < parts.length; ++index) {
      if(parts[index].index !== index) throw new Error(`missing part ${index} for ${name}`);
    }
    await install(name, parts.map((part) => part.asset));
  }
}

export async function downloadFixtureRelease({version, outputDirectory, sleep = sleepFor}) {
  if(!HASH_RE.test(version || '')) throw new Error('fixture version must be a 64-character SHA-256 hash');
  const tag = `perf-fixture-${version}`;
  const releaseUrl = `https://github.com/${FIXTURE_REPOSITORY}/releases/download/${tag}`;
  const manifest = validateManifest(JSON.parse((await fetchBytes(`${releaseUrl}/manifest.json`, 'manifest.json', sleep)).toString('utf8')), version);
  const root = resolve(outputDirectory);
  rmSync(root, {recursive: true, force: true});
  const downloadedDirectory = join(root, 'release-assets');
  const snapshotDirectory = join(root, 'snapshot');
  mkdirSync(downloadedDirectory, {recursive: true});
  mkdirSync(snapshotDirectory, {recursive: true});

  for(const asset of manifest.assets) {
    await downloadAsset(`${releaseUrl}/${encodeURIComponent(asset.name)}`, asset.name, join(downloadedDirectory, asset.name), asset.sha256, sleep);
  }
  await reconstructDownloadedAssets(manifest.assets, downloadedDirectory, snapshotDirectory);
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if(command !== 'download') throw new Error('usage: fixture-release.mjs download --version <sha256> --output <directory>');
  const options = Object.fromEntries(args.reduce((pairs, value, index) => {
    if(value === '--version' || value === '--output') pairs.push([value.slice(2), args[index + 1]]);
    return pairs;
  }, []));
  if(!options.version || !options.output) throw new Error('both --version and --output are required');
  const manifest = await downloadFixtureRelease({version: options.version, outputDirectory: options.output});
  if(process.env.GITHUB_OUTPUT) {
    const output = `fixture_version=${manifest.fixture}\nserver_commit=${manifest.server_commit}\nmigration_revision=${manifest.migration_revision}\n`;
    writeFileSync(process.env.GITHUB_OUTPUT, output, {flag: 'a'});
  }
  process.stdout.write(`Verified ${manifest.assets.length} assets for ${manifest.fixture} at ${manifest.server_commit}\n`);
}

if(import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
