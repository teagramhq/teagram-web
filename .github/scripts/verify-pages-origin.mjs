import http from 'node:http';
import https from 'node:https';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RETIRED_VERSION_URLS} from './pages-paths.mjs';

export const PAGES_HOST = 'web.teagram.io';
export const VERSION_PATH = '/.well-known/teagram-web/source-commit.txt';
export {RETIRED_VERSION_URLS};
// These are GitHub Pages' documented IPv4 targets. Pinned requests verify the
// Pages origin directly instead of following public DNS to the active origin.
export const PAGES_IPS = [
  '185.199.108.153',
  '185.199.109.153',
  '185.199.110.153',
  '185.199.111.153'
];

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CERTIFICATE_NOT_READY = 'ERR_TLS_CERT_ALTNAME_INVALID';

function fail(message) {
  throw new Error(`[pages] ${message}`);
}

function requestText({protocol, host, ip, path, timeoutMs, maxResponseBytes = 4096}) {
  const client = protocol === 'https:' ? https : http;
  const options = {
    protocol,
    hostname: host,
    port: protocol === 'https:' ? 443 : 80,
    path,
    method: 'GET',
    agent: false,
    headers: {
      accept: 'text/plain',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache'
    }
  };
  if(ip) {
    options.lookup = (_hostname, _options, callback) => callback(null, ip, 4);
  }

  return new Promise((resolveResponse, rejectResponse) => {
    const request = client.get(options, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if(size > maxResponseBytes) {
          request.destroy(Object.assign(new Error('Pages response is too large'), {code: 'ERR_RESPONSE_TOO_LARGE'}));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolveResponse({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(Object.assign(new Error('version request timed out'), {code: 'ETIMEDOUT'}));
    });
    request.on('error', rejectResponse);
  });
}

function isCertificateNotReady(error) {
  return error?.code === CERTIFICATE_NOT_READY;
}

function responseMatches(response, sourceCommit) {
  if(response?.status !== 200 || typeof response.body !== 'string') return false;
  return response.body.replace(/\r?\n$/, '') === sourceCommit;
}

function requestPath(sourceCommit) {
  return `${VERSION_PATH}?deploy=${sourceCommit}`;
}

async function retiredVersionPathFailure({protocol, host, ip, sourceCommit, request, timeoutMs}) {
  for(const path of RETIRED_VERSION_URLS) {
    let response;
    try {
      response = await request({
        protocol, host, ip, path: `${path}?deploy=${sourceCommit}`, timeoutMs,
        maxResponseBytes: 65536
      });
    } catch(error) {
      return `${path}: ${errorLabel(error)}`;
    }
    if(response?.status !== 404) return `${path} returned HTTP ${response?.status ?? 'unknown'}`;
  }
  return null;
}

function errorLabel(error) {
  return typeof error?.code === 'string' ? error.code : 'request-failed';
}

async function verifyPinnedPagesIps({sourceCommit, request, timeoutMs, allowHttpFallback}) {
  let lastFailure = 'no response';

  for(const ip of PAGES_IPS) {
    let protocol = 'https:';
    let response;
    try {
      response = await request({
        protocol, host: PAGES_HOST, ip, path: requestPath(sourceCommit), timeoutMs
      });
    } catch(error) {
      if(!allowHttpFallback || !isCertificateNotReady(error)) {
        lastFailure = `${errorLabel(error)} at ${ip}`;
        continue;
      }
      protocol = 'http:';
      try {
        response = await request({
          protocol, host: PAGES_HOST, ip, path: requestPath(sourceCommit), timeoutMs
        });
      } catch(fallbackError) {
        lastFailure = `${errorLabel(fallbackError)} at ${ip}`;
        continue;
      }
    }

    if(!responseMatches(response, sourceCommit)) {
      lastFailure = `HTTP ${response?.status ?? 'unknown'} at ${ip}`;
      continue;
    }

    const routeFailure = await retiredVersionPathFailure({
      protocol, host: PAGES_HOST, ip, sourceCommit, request, timeoutMs
    });
    if(!routeFailure) return {result: {transport: protocol.slice(0, -1), ip}, failure: null};
    lastFailure = `${routeFailure} at ${ip}`;
  }

  return {result: null, failure: lastFailure};
}

export async function verifyPagesOrigin({
  origin,
  sourceCommit,
  request = requestText,
  sleep = (duration) => new Promise((resolveSleep) => setTimeout(resolveSleep, duration)),
  now = () => Date.now(),
  timeoutMs = 10 * 60 * 1000,
  pollIntervalMs = 10 * 1000,
  requestTimeoutMs = 8 * 1000
} = {}) {
  if(origin !== 'k3s' && origin !== 'pages') fail('origin must be k3s or pages');
  if(typeof sourceCommit !== 'string' || !COMMIT_PATTERN.test(sourceCommit)) {
    fail('source commit must be a full 40-character SHA');
  }
  if(!Number.isFinite(timeoutMs) || timeoutMs < 0) fail('timeout must be a non-negative number');
  if(!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) fail('poll interval must be a positive number');

  const deadline = now() + timeoutMs;
  const path = requestPath(sourceCommit);
  let lastResult = 'no response';

  do {
    if(origin === 'pages') {
      try {
        const response = await request({
          protocol: 'https:', host: PAGES_HOST, path, timeoutMs: requestTimeoutMs
        });
        if(responseMatches(response, sourceCommit)) {
          const routeFailure = await retiredVersionPathFailure({
            protocol: 'https:', host: PAGES_HOST, sourceCommit, request, timeoutMs: requestTimeoutMs
          });
          if(routeFailure) {
            lastResult = routeFailure;
          } else {
            const pinned = await verifyPinnedPagesIps({
              sourceCommit, request, timeoutMs: requestTimeoutMs, allowHttpFallback: false
            });
            if(pinned.result) return pinned.result;
            lastResult = `direct Pages IP check failed: ${pinned.failure}`;
          }
        } else {
          lastResult = `HTTP ${response.status ?? 'unknown'}`;
        }
      } catch(error) {
        lastResult = errorLabel(error);
      }
    } else {
      const pinned = await verifyPinnedPagesIps({
        sourceCommit, request, timeoutMs: requestTimeoutMs, allowHttpFallback: true
      });
      if(pinned.result) return pinned.result;
      lastResult = pinned.failure;
    }

    if(now() >= deadline) break;
    await sleep(Math.min(pollIntervalMs, deadline - now()));
  } while(now() < deadline);

  fail(`version check timed out for ${sourceCommit} (${lastResult})`);
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if(index === -1) return fallback;
  const value = args[index + 1];
  if(!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if(args[0] !== 'verify') fail('usage: verify-pages-origin.mjs verify --origin <k3s|pages> --commit <sha>');
  const origin = option(args, '--origin');
  const sourceCommit = option(args, '--commit');
  const timeoutSeconds = Number(option(args, '--timeout-seconds', '600'));
  if(!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) fail('--timeout-seconds must be non-negative');

  const result = await verifyPagesOrigin({origin, sourceCommit, timeoutMs: timeoutSeconds * 1000});
  console.log(`pages_origin_transport=${result.transport}${result.ip ? ` ip=${result.ip}` : ''}`);
  console.log(origin === 'pages' ? `rollout=verified sha=${sourceCommit}` : `pages=verified sha=${sourceCommit}`);
}

const invokedScript = process.argv[1] && resolve(process.argv[1]);
if(invokedScript === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
