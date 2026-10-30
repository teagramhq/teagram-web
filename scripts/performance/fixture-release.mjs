import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Readable, Transform} from 'node:stream';
import {pathToFileURL} from 'node:url';

const FIXTURE_REPOSITORY = 'teagramhq/teagram-server';
const HASH_RE = /^[a-f0-9]{64}$/i;

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

async function fetchBytes(url, expectedHash) {
  const response = await fetch(url, {redirect: 'follow'});
  if(!response.ok || !response.body) throw new Error(`download failed (${response.status}): ${url}`);

  const digest = createHash('sha256');
  const hasher = new Transform({
    transform(chunk, encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  const chunks = [];
  await pipeline(Readable.fromWeb(response.body), hasher, new Transform({
    transform(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback(null, chunk);
    }
  }));
  const actualHash = digest.digest('hex');
  if(expectedHash && actualHash !== expectedHash) throw new Error(`checksum mismatch for ${url}`);
  return Buffer.concat(chunks);
}

async function downloadAsset(url, targetPath, expectedHash) {
  const response = await fetch(url, {redirect: 'follow'});
  if(!response.ok || !response.body) throw new Error(`download failed (${response.status}): ${url}`);

  const digest = createHash('sha256');
  const hasher = new Transform({
    transform(chunk, encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(targetPath));
  const actualHash = digest.digest('hex');
  if(actualHash !== expectedHash) throw new Error(`checksum mismatch for ${url}`);
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

export async function downloadFixtureRelease({version, outputDirectory}) {
  if(!HASH_RE.test(version || '')) throw new Error('fixture version must be a 64-character SHA-256 hash');
  const tag = `perf-fixture-${version}`;
  const releaseUrl = `https://github.com/${FIXTURE_REPOSITORY}/releases/download/${tag}`;
  const manifest = validateManifest(JSON.parse((await fetchBytes(`${releaseUrl}/manifest.json`)).toString('utf8')), version);
  const root = resolve(outputDirectory);
  rmSync(root, {recursive: true, force: true});
  const downloadedDirectory = join(root, 'release-assets');
  const snapshotDirectory = join(root, 'snapshot');
  mkdirSync(downloadedDirectory, {recursive: true});
  mkdirSync(snapshotDirectory, {recursive: true});

  for(const asset of manifest.assets) {
    await downloadAsset(`${releaseUrl}/${encodeURIComponent(asset.name)}`, join(downloadedDirectory, asset.name), asset.sha256);
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
