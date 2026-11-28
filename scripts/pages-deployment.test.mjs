import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {preparePagesSite, SOURCE_COMMIT_PATH} from '../.github/scripts/prepare-pages-site.mjs';
import {
  PAGES_HOST,
  PAGES_IPS,
  VERSION_PATH,
  verifyPagesOrigin
} from '../.github/scripts/verify-pages-origin.mjs';

const temporaryDirectories = [];
const sourceCommit = 'a'.repeat(40);

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'teagram-pages-deployment-'));
  temporaryDirectories.push(directory);
  return directory;
}

function imageTree() {
  const source = join(temporaryDirectory(), 'image');
  mkdirSync(join(source, '.well-known', 'teagram-web'), {recursive: true});
  writeFileSync(join(source, 'index.html'), '<!doctype html><main>web</main>');
  writeFileSync(join(source, '.well-known', 'teagram-web', 'version.txt'), '2.2 (676)\n');
  return source;
}

afterAll(() => {
  for(const directory of temporaryDirectories) rmSync(directory, {recursive: true, force: true});
});

describe('preparePagesSite', () => {
  it('preserves hidden image files and adds only the source commit marker', () => {
    const source = imageTree();
    const output = join(temporaryDirectory(), 'site');
    const result = preparePagesSite({sourceDirectory: source, outputDirectory: output, sourceCommit});

    expect(readFileSync(join(output, SOURCE_COMMIT_PATH), 'utf8')).toBe(`${sourceCommit}\n`);
    expect(readFileSync(join(output, '.well-known', 'teagram-web', 'version.txt'), 'utf8')).toBe('2.2 (676)\n');
    expect(result.imageTreeSha256).toBe(result.preservedTreeSha256);
    expect(result.pagesFiles).toContain('.well-known/teagram-web/version.txt');
    expect(result.pagesFiles).toContain(SOURCE_COMMIT_PATH);
    expect(result.pagesFiles).not.toContain('404.html');
    expect(result.pagesFiles).not.toContain('healthz');
    expect(result.pagesFiles).not.toContain('invite');
    expect(result.pagesFiles).not.toContain('invite.html');
    expect(result.pagesFiles).not.toContain('invite/index.html');
    expect(result.pagesFiles).toHaveLength(result.imageFiles.length + 1);
  });

  it('rejects symlinks before creating the Pages output', () => {
    const source = imageTree();
    const output = join(temporaryDirectory(), 'site');
    symlinkSync('index.html', join(source, 'linked-index.html'));

    expect(() => preparePagesSite({sourceDirectory: source, outputDirectory: output, sourceCommit}))
      .toThrow(/symlink/);
  });

  it.each(['404.html', 'healthz', 'invite', 'invite.html', 'invite/index.html'])('rejects an image route file at %s', (routePath) => {
    const source = imageTree();
    const output = join(temporaryDirectory(), 'site');
    const routeFile = join(source, routePath);
    mkdirSync(dirname(routeFile), {recursive: true});
    writeFileSync(routeFile, 'static route');

    expect(() => preparePagesSite({sourceDirectory: source, outputDirectory: output, sourceCommit}))
      .toThrow(/must not be published as a Pages route/);
  });
});

describe('verifyPagesOrigin', () => {
  it('pins the Pages IP and falls back to HTTP only for a missing hostname certificate', async() => {
    const requests = [];
    const result = await verifyPagesOrigin({
      origin: 'k3s',
      sourceCommit,
      request: async(options) => {
        requests.push(options);
        if(options.protocol === 'https:') {
          throw Object.assign(new Error('certificate hostname mismatch'), {code: 'ERR_TLS_CERT_ALTNAME_INVALID'});
        }
        return {status: 200, body: `${sourceCommit}\n`};
      },
      now: () => 0,
      timeoutMs: 1000
    });

    expect(result).toEqual({transport: 'http', ip: PAGES_IPS[0]});
    expect(requests.map(({protocol, host, ip, path}) => ({protocol, host, ip, path}))).toEqual([
      {protocol: 'https:', host: PAGES_HOST, ip: PAGES_IPS[0], path: `${VERSION_PATH}?deploy=${sourceCommit}`},
      {protocol: 'http:', host: PAGES_HOST, ip: PAGES_IPS[0], path: `${VERSION_PATH}?deploy=${sourceCommit}`}
    ]);
  });

  it('uses normal HTTPS and never downgrades in Pages mode', async() => {
    const requests = [];
    let time = 0;
    const result = await verifyPagesOrigin({
      origin: 'pages',
      sourceCommit,
      request: async(options) => {
        requests.push(options);
        return {status: 200, body: `${sourceCommit}\n`};
      },
      now: () => time,
      sleep: async(duration) => { time += duration; },
      timeoutMs: 1000
    });

    expect(result).toEqual({transport: 'https', ip: undefined});
    expect(requests).toEqual([{
      protocol: 'https:', host: PAGES_HOST, path: `${VERSION_PATH}?deploy=${sourceCommit}`, timeoutMs: 8000
    }]);
  });

  it('fails closed on Pages certificate errors', async() => {
    const requests = [];
    let time = 0;
    await expect(verifyPagesOrigin({
      origin: 'pages',
      sourceCommit,
      request: async(options) => {
        requests.push(options);
        throw Object.assign(new Error('certificate hostname mismatch'), {code: 'ERR_TLS_CERT_ALTNAME_INVALID'});
      },
      now: () => time,
      sleep: async(duration) => { time += duration; },
      timeoutMs: 10,
      pollIntervalMs: 5
    })).rejects.toThrow(/timed out/);

    expect(requests.every((request) => request.protocol === 'https:' && request.ip === undefined)).toBe(true);
  });
});
