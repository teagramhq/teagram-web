#!/usr/bin/env node

import {createPublicKey} from 'node:crypto';
import {spawn} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireAttemptPermit} from './l1PrekeyRunnerPolicy.mjs';

const RUNNER_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(RUNNER_PATH), '../..');
const MAX_ATTEMPT_MS = 20_000;
const MAX_INPUT_BYTES = 32 * 1024;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UPGRADE_RESULTS = new Set(['101', '403', 'other_4xx', '5xx', 'network_error']);
const STAGE_RESULTS = new Set(['complete', 'proto_error', 'closed', 'timeout', 'malformed']);
const DH_REPLY_RESULTS = new Set(['ok', 'fail', 'proto_error', 'closed', 'timeout', 'malformed']);
const PROTOCOL_ERROR_CODES = new Set(['404', '429', '444', 'other']);
const DIAGNOSTIC_RESULTS = new Set([
  'invalid_input',
  'already_stopped',
  'concurrency_limited',
  'interval_limited',
  'rate_limited',
  'unknown',
  'origin_rejected',
  'upgrade_refused',
  'server_error',
  'respq_protocol_error',
  'respq_closed',
  'respq_malformed',
  'respq_nonce_mismatch',
  'fingerprint_mismatch',
  'pq_invalid',
  'dh_protocol_error',
  'dh_reply_closed',
  'dh_reply_malformed',
  'dh_reply_refused',
  'dh_reply_nonce_mismatch',
  'dh_inner_malformed',
  'dh_inner_invalid',
  'dh_inner_valid'
]);
const STRING_FIELDS = {
  upgrade: UPGRADE_RESULTS,
  respq: STAGE_RESULTS,
  dh_reply: DH_REPLY_RESULTS,
  proto_error_code: PROTOCOL_ERROR_CODES,
  result: DIAGNOSTIC_RESULTS
};
const REFERENCE_FIELDS = ['source_ref', 'deploy_ref', 'run_ref'];

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeReference(value) {
  return typeof value === 'string' && SAFE_REFERENCE_PATTERN.test(value) ? value : 'unknown';
}

function safeReferences(value) {
  return Object.fromEntries(REFERENCE_FIELDS.map((field) => [field, safeReference(value?.[field])]));
}

export function sanitizeReport(value) {
  const output = {};
  if(!isRecord(value)) value = {};

  for(const [field, allowed] of Object.entries(STRING_FIELDS)) {
    if(typeof value[field] === 'string' && allowed.has(value[field])) output[field] = value[field];
  }
  for(const field of ['respq_nonce_match', 'fingerprint_in_pinned_set', 'pq_valid', 'dh_inner_valid', 'close_1000_sent']) {
    if(typeof value[field] === 'boolean') output[field] = value[field];
  }
  Object.assign(output, safeReferences(value));
  if(!output.result) output.result = 'unknown';
  return output;
}

export function normalizeRuntimeInput(value) {
  if(!isRecord(value)) return undefined;
  const refs = safeReferences(value);
  const {endpoint, origin, subprotocol, dc_id: dcId, fingerprint, public_key: publicKey} = value;
  if(typeof endpoint !== 'string' || endpoint.length > 2048 ||
    typeof origin !== 'string' || origin.length > 2048 ||
    subprotocol !== 'binary' || !Number.isInteger(dcId) || dcId < 1 || dcId > 5 ||
    typeof fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fingerprint) ||
    typeof publicKey !== 'string' || publicKey.length > 8192 || /PRIVATE KEY/.test(publicKey)) {
    return undefined;
  }

  let endpointUrl;
  let originUrl;
  let parsedKey;
  try {
    endpointUrl = new URL(endpoint);
    originUrl = new URL(origin);
    if(endpointUrl.protocol !== 'wss:' || endpointUrl.href !== endpoint || endpointUrl.username ||
      endpointUrl.password || endpointUrl.search || endpointUrl.hash ||
      originUrl.protocol !== 'https:' || originUrl.origin !== origin || originUrl.username || originUrl.password) {
      return undefined;
    }
    parsedKey = createPublicKey(publicKey);
  } catch{
    return undefined;
  }

  if(parsedKey.asymmetricKeyType !== 'rsa') return undefined;
  const jwk = parsedKey.export({format: 'jwk'});
  if(typeof jwk.n !== 'string' || typeof jwk.e !== 'string') return undefined;
  const publicKeyHex = {
    modulus: Buffer.from(jwk.n, 'base64url').toString('hex'),
    exponent: Buffer.from(jwk.e, 'base64url').toString('hex')
  };
  if(!/^[0-9a-f]{512}$/.test(publicKeyHex.modulus) || publicKeyHex.exponent !== '010001') return undefined;

  const target = {
    mode: 'private',
    endpoint,
    fingerprint,
    publicKey,
    publicKeyHex,
    routeLock: {
      mode: 'private',
      endpoint,
      transport: 'websocket',
      dcIds: [1, 2, 3, 4, 5],
      connectionTypes: ['client', 'upload', 'download']
    }
  };

  return {
    target,
    origin,
    subprotocol,
    dc_id: dcId,
    ...refs
  };
}

function minimalChildEnvironment() {
  const allowedNames = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'USERPROFILE']);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => allowedNames.has(name)));
}

export function superviseAttempt(input, deadlineAt, options = {}) {
  const childPath = options.childPath ?? RUNNER_PATH;
  const timeoutMs = options.timeoutMs ?? MAX_ATTEMPT_MS;

  return new Promise((resolvePromise) => {
    let report;
    let timedOut = false;
    let complete = false;
    const child = spawn(process.execPath, [childPath, '--child'], {
      cwd: ROOT,
      env: minimalChildEnvironment(),
      stdio: ['pipe', 'ignore', 'ignore', 'ipc']
    });

    const finish = (result) => {
      if(complete) return;
      complete = true;
      clearTimeout(timer);
      resolvePromise(sanitizeReport(result));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('message', (message) => {
      report = sanitizeReport(message);
    });
    child.once('error', () => finish({result: 'unknown'}));
    child.once('exit', (code, signal) => {
      if(timedOut || code !== 0 || signal) {
        finish({result: 'unknown', ...safeReferences(input)});
      } else {
        finish(report ?? {result: 'unknown', ...safeReferences(input)});
      }
    });

    child.send({input, deadlineAt}, (error) => {
      if(error) {
        timedOut = true;
        child.kill('SIGKILL');
      }
    });
  });
}

async function readInput() {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if(totalBytes > MAX_INPUT_BYTES) throw new Error('input_limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function aliases() {
  const source = resolve(ROOT, 'src');
  return {
    'solid-js': resolve(source, 'vendor/solid'),
    'solid-js/web': resolve(source, 'vendor/solid/web'),
    'solid-js/store': resolve(source, 'vendor/solid/store'),
    'solid-js/jsx-runtime': resolve(source, 'vendor/solid'),
    'solid-js/jsx-dev-runtime': resolve(source, 'vendor/solid'),
    'solid-transition-group': resolve(source, 'vendor/solid-transition-group'),
    '@components': resolve(source, 'components'),
    '@helpers': resolve(source, 'helpers'),
    '@hooks': resolve(source, 'hooks'),
    '@stores': resolve(source, 'stores'),
    '@lib': resolve(source, 'lib'),
    '@appManagers': resolve(source, 'lib/appManagers'),
    '@richTextProcessor': resolve(source, 'lib/richTextProcessor'),
    '@environment': resolve(source, 'environment'),
    '@customEmoji': resolve(source, 'lib/customEmoji'),
    '@config': resolve(source, 'config'),
    '@vendor': resolve(source, 'vendor'),
    '@layer': resolve(source, 'layer.d.ts'),
    '@types': resolve(source, 'types.d.ts'),
    '@': source
  };
}

function silenceConsole() {
  const saved = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map((name) => [name, console[name]]));
  for(const name of Object.keys(saved)) console[name] = () => {};
  return () => {
    for(const [name, value] of Object.entries(saved)) console[name] = value;
  };
}

async function runChild() {
  let sentResult = false;
  process.on('disconnect', () => {
    if(!sentResult) process.exit(1);
  });
  const restoreConsole = silenceConsole();
  let server;
  let input = {};
  let deadlineAt = Date.now();
  let result = {result: 'unknown'};

  try {
    const envelope = await new Promise((resolvePromise) => process.once('message', resolvePromise));
    if(isRecord(envelope)) {
      input = isRecord(envelope.input) ? envelope.input : {};
      deadlineAt = Number.isSafeInteger(envelope.deadlineAt) ? envelope.deadlineAt : Date.now();
    }
    const {createServer} = await import('vite');
    server = await createServer({
      configFile: false,
      envDir: false,
      root: ROOT,
      mode: 'production',
      appType: 'custom',
      logLevel: 'silent',
      server: {middlewareMode: true, watch: null},
      resolve: {alias: aliases()},
      define: {
        __MTPROTO_TARGET__: 'globalThis.__L1_TARGET__',
        __MTPROTO_PRIVATE__: 'true',
        'import.meta.env.VITE_MTPROTO_HAS_WS': 'true',
        'import.meta.env.VITE_MTPROTO_HAS_HTTP': 'false',
        'import.meta.env.VITE_MTPROTO_AUTO': 'false',
        'import.meta.env.VITE_MTPROTO_SW': 'false'
      }
    });

    globalThis.__L1_TARGET__ = input.target;
    try {
      await server.ssrLoadModule('/src/config/mtprotoTarget.ts');
    } catch{
      result = {result: 'invalid_input', ...safeReferences(input)};
      return;
    }
    await server.ssrLoadModule('/src/lib/crypto/crypto.worker.ts');
    const {runDiagnosticAttempt} = await server.ssrLoadModule('/src/tests/l1PrekeyAttempt.ts');
    const deadlineMs = Math.min(MAX_ATTEMPT_MS, deadlineAt - Date.now() - 500);
    if(deadlineMs > 0) {
      result = await runDiagnosticAttempt(input, {deadlineMs});
    } else {
      result = {result: 'unknown', ...safeReferences(input)};
    }
  } catch{
    result = {result: 'unknown', ...safeReferences(input)};
  } finally {
    try {
      await server?.close();
    } catch{
      result = {result: 'unknown', ...safeReferences(input)};
    }
    restoreConsole();
    const report = sanitizeReport(result);
    if(process.connected) {
      process.send(report, () => {
        sentResult = true;
        process.disconnect();
      });
    }
  }
}

async function runParent() {
  let parsed;
  try {
    parsed = JSON.parse(await readInput());
  } catch{
    process.stdout.write(JSON.stringify(sanitizeReport({result: 'invalid_input'})) + '\n');
    return;
  }

  const references = safeReferences(parsed);
  const input = normalizeRuntimeInput(parsed);
  if(!input) {
    process.stdout.write(JSON.stringify(sanitizeReport({result: 'invalid_input', ...references})) + '\n');
    return;
  }

  try {
    const permit = await acquireAttemptPermit();
    if(!permit.allowed) {
      process.stdout.write(JSON.stringify(sanitizeReport({result: permit.reason, ...references})) + '\n');
      return;
    }

    try {
      const deadlineAt = Date.now() + MAX_ATTEMPT_MS;
      const report = await superviseAttempt(input, deadlineAt);
      if(report.result === 'dh_inner_valid' || report.result === 'unknown') await permit.markStopped();
      process.stdout.write(JSON.stringify(report) + '\n');
    } finally {
      await permit.release();
    }
  } catch{
    process.stdout.write(JSON.stringify(sanitizeReport({result: 'unknown', ...references})) + '\n');
  }
}

if(process.argv[2] === '--child') {
  await runChild();
} else if(process.argv[1] && resolve(process.argv[1]) === RUNNER_PATH) {
  await runParent();
}
