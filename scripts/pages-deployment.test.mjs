import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {preparePagesSite} from '../.github/scripts/prepare-pages-site.mjs';
import {RETIRED_VERSION_PATHS, SOURCE_COMMIT_PATH} from '../.github/scripts/pages-paths.mjs';
import {
  PAGES_HOST,
  PAGES_IPS,
  RETIRED_VERSION_URLS,
  VERSION_PATH,
  requestText,
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
  mkdirSync(join(source, '.well-known', 'telegram-web'), {recursive: true});
  writeFileSync(join(source, 'index.html'), '<!doctype html><main>web</main>');
  writeFileSync(join(source, '.well-known', 'teagram-web', 'version.txt'), '2.2 (676)\n');
  writeFileSync(join(source, '.well-known', 'telegram-web', 'version.txt'), 'retired\n');
  writeFileSync(join(source, '.well-known', 'teagram-web', 'client.json'), '{"clients":[]}\n');
  return source;
}

afterAll(() => {
  for(const directory of temporaryDirectories) rmSync(directory, {recursive: true, force: true});
});

describe('requestText', () => {
  it('connects to a pinned IPv4 address through a local HTTP server', async() => {
    const server = createServer((_request, response) => response.end('pinned response\n'));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const result = await requestText({
        protocol: 'http:', host: PAGES_HOST, ip: '127.0.0.1', port: server.address().port,
        path: '/probe', timeoutMs: 1000
      });
      expect(result).toEqual({status: 200, body: 'pinned response\n'});
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

describe('preparePagesSite', () => {
  it('generates the app 404, omits retired paths, and preserves other hidden files', () => {
    const source = imageTree();
    const output = join(temporaryDirectory(), 'site');
    const result = preparePagesSite({sourceDirectory: source, outputDirectory: output, sourceCommit});

    expect(readFileSync(join(output, '404.html'))).toEqual(readFileSync(join(source, 'index.html')));
    expect(readFileSync(join(output, SOURCE_COMMIT_PATH), 'utf8')).toBe(`${sourceCommit}\n`);
    expect(readFileSync(join(output, '.well-known', 'teagram-web', 'client.json'), 'utf8')).toBe('{"clients":[]}\n');
    expect(result.imageTreeSha256).not.toBe(result.preservedTreeSha256);
    expect(result.pagesFiles).toContain('.well-known/teagram-web/client.json');
    expect(result.pagesFiles).toContain(SOURCE_COMMIT_PATH);
    expect(result.pagesFiles).toContain('404.html');
    expect(result.pagesFiles).not.toContain(RETIRED_VERSION_PATHS[0].slice(1));
    expect(result.pagesFiles).not.toContain(RETIRED_VERSION_PATHS[1].slice(1));
    expect(result.pagesFiles).not.toContain('healthz');
    expect(result.pagesFiles).not.toContain('invite');
    expect(result.pagesFiles).not.toContain('invite.html');
    expect(result.pagesFiles).not.toContain('invite/index.html');
    expect(result.pagesFiles).toHaveLength(result.imageFiles.length);
  });

  it('rejects symlinks before creating the Pages output', () => {
    const source = imageTree();
    const output = join(temporaryDirectory(), 'site');
    symlinkSync('index.html', join(source, 'linked-index.html'));

    expect(() => preparePagesSite({sourceDirectory: source, outputDirectory: output, sourceCommit}))
      .toThrow(/symlink/);
  });

  it.each(['healthz', 'invite', 'invite.html', 'invite/index.html'])('rejects an image route file at %s', (routePath) => {
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
        return options.path.startsWith(VERSION_PATH)
          ? {status: 200, body: `${sourceCommit}\n`}
          : {status: 404, body: '<!doctype html><main>web</main>'};
      },
      now: () => 0,
      timeoutMs: 1000
    });

    expect(result).toEqual({transport: 'http', ip: PAGES_IPS[0]});
    expect(requests.map(({protocol, host, ip, path}) => ({protocol, host, ip, path}))).toEqual([
      {protocol: 'https:', host: PAGES_HOST, ip: PAGES_IPS[0], path: `${VERSION_PATH}?deploy=${sourceCommit}`},
      {protocol: 'http:', host: PAGES_HOST, ip: PAGES_IPS[0], path: `${VERSION_PATH}?deploy=${sourceCommit}`},
      ...RETIRED_VERSION_URLS.map((path) => ({
        protocol: 'http:', host: PAGES_HOST, ip: PAGES_IPS[0], path: `${path}?deploy=${sourceCommit}`
      }))
    ]);
  });

  it('keeps the public HTTPS poll and verifies Pages directly over pinned HTTPS', async() => {
    const requests = [];
    let time = 0;
    const result = await verifyPagesOrigin({
      origin: 'pages',
      sourceCommit,
      request: async(options) => {
        requests.push(options);
        return options.path.startsWith(VERSION_PATH)
          ? {status: 200, body: `${sourceCommit}\n`}
          : {status: 404, body: '<!doctype html><main>web</main>'};
      },
      now: () => time,
      sleep: async(duration) => { time += duration; },
      timeoutMs: 1000
    });

    expect(result).toEqual({transport: 'https', ip: PAGES_IPS[0]});
    expect(requests).toEqual([
      {protocol: 'https:', host: PAGES_HOST, path: `${VERSION_PATH}?deploy=${sourceCommit}`, timeoutMs: 8000},
      ...RETIRED_VERSION_URLS.map((path) => ({
        protocol: 'https:', host: PAGES_HOST, path: `${path}?deploy=${sourceCommit}`, timeoutMs: 8000,
        maxResponseBytes: 65536
      })),
      {protocol: 'https:', host: PAGES_HOST, ip: PAGES_IPS[0], path: `${VERSION_PATH}?deploy=${sourceCommit}`, timeoutMs: 8000},
      ...RETIRED_VERSION_URLS.map((path) => ({
        protocol: 'https:', host: PAGES_HOST, ip: PAGES_IPS[0], path: `${path}?deploy=${sourceCommit}`, timeoutMs: 8000,
        maxResponseBytes: 65536
      }))
    ]);
  });

  it('does not accept a matching public fallback when the pinned Pages origin is stale', async() => {
    const requests = [];
    const staleCommit = 'b'.repeat(40);
    await expect(verifyPagesOrigin({
      origin: 'pages',
      sourceCommit,
      request: async(options) => {
        requests.push(options);
        if(options.path.startsWith(VERSION_PATH)) {
          return {status: 200, body: `${options.ip ? staleCommit : sourceCommit}\n`};
        }
        return {status: 404, body: ''};
      },
      now: () => 0,
      timeoutMs: 0
    })).rejects.toThrow(/direct Pages IP check failed: HTTP 200 at/);

    expect(requests[0]).toMatchObject({
      protocol: 'https:', host: PAGES_HOST, path: `${VERSION_PATH}?deploy=${sourceCommit}`
    });
    const pinnedRequests = requests.filter(({ip}) => ip);
    expect(pinnedRequests.map(({ip}) => ip)).toEqual(PAGES_IPS);
    expect(pinnedRequests.every(({protocol, host}) => protocol === 'https:' && host === PAGES_HOST)).toBe(true);
    expect(requests.every(({protocol}) => protocol === 'https:')).toBe(true);
  });

  it('fails unless both retired version paths return 404', async() => {
    const requests = [];
    await expect(verifyPagesOrigin({
      origin: 'pages',
      sourceCommit,
      request: async(options) => {
        requests.push(options);
        return options.path.startsWith(VERSION_PATH)
          ? {status: 200, body: `${sourceCommit}\n`}
          : {status: 200, body: '<!doctype html><main>web</main>'};
      },
      now: () => 0,
      timeoutMs: 0
    })).rejects.toThrow(`${RETIRED_VERSION_URLS[0]} returned HTTP 200`);

    expect(requests.map(({path}) => path)).toEqual([
      `${VERSION_PATH}?deploy=${sourceCommit}`,
      `${RETIRED_VERSION_URLS[0]}?deploy=${sourceCommit}`
    ]);
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

  it('preserves unexpected errors from Pages requests', async() => {
    await expect(verifyPagesOrigin({
      origin: 'pages',
      sourceCommit,
      request: async() => { throw new Error('unexpected verifier bug'); },
      now: () => 0,
      timeoutMs: 0
    })).rejects.toThrow('unexpected verifier bug');
  });
});
