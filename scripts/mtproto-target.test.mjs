import {createPublicKey, generateKeyPairSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {inspect} from 'node:util';
import {afterAll, describe, expect, it, vi} from 'vitest';
import * as mtprotoTarget from './mtproto-target.mjs';
import {
  auditPrivateArtifact,
  includePrivateArtifactBackground,
  includePrivateArtifactFonts,
  verifyPrivateArtifactCsp,
  writePrivateArtifactManifest
} from './private-artifact.mjs';
import {createPrivateWorkerBlobURL} from '../src/helpers/createPrivateWorkerBlobURL';
const {assertRunnableMtprotoTarget, resolveMtprotoTarget} = mtprotoTarget;

const fixturePath = resolve('scripts/fixtures/private-mtproto-public.pem');
const trustedOfficialModulus = readFileSync(resolve('scripts/private-artifact.mjs'), 'utf8')
.match(/const TRUSTED_MT_PROTO_MODULI = \[\s*'([0-9a-f]+)'/i)?.[1];
const fixtureKey = `-----BEGIN RSA PUBLIC KEY-----
MIIBCgKCAQEAt0XATe6T6yIGpzy/ZTTulB8sROFQJU/Oo8dKKEHQd5S30CHfkcDE
jeYOOspc7zHv5ZrM9eQfJ3LelIsP1u6p1iZWchkAhf/UsHzN3P31gh6sjRV/SuBo
8YM1gJ1lq6286j9Ht4Ek1uD0gXVBQzlap5KvH0sD8OJRSjIH+PA9TzYSjfmyK1+q
M+dwTXP2qFNgZ1oc9c9zm92xF9TwC5Z7ZPNlMSHBozC8R+HFq27JVXiCSL1lAunt
6NtFavrBmttvDkEHkWeglSWHWHLWjUGP3H49tcqvs1GflY1YQeruxNK2ynEr47iF
t5fHT9B6HtX1XBdGsYF39yjOMjZETrYB6wIDAQAB
-----END RSA PUBLIC KEY-----\n`;
const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'mtproto-target-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for(const directory of temporaryDirectories) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function privateEnv(overrides = {}) {
  return {
    MTPROTO_TARGET_MODE: 'private',
    MTPROTO_PRIVATE_ENDPOINT: 'wss://private.example.test:2443/apiws',
    MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: fixturePath,
    ...overrides
  };
}

function targetError(environment) {
  try {
    resolveMtprotoTarget(environment);
  } catch(error) {
    return error;
  }
  throw new Error('Expected private target resolution to fail');
}

function writeKey(contents) {
  const directory = temporaryDirectory();
  const keyPath = join(directory, 'key.pem');
  writeFileSync(keyPath, contents);
  return keyPath;
}

function pem(label, der, lineLength = 64) {
  const payload = der.toString('base64').match(new RegExp(`.{1,${lineLength}}`, 'g')).join('\n');
  return `-----BEGIN ${label}-----\n${payload}\n-----END ${label}-----\n`;
}

function buildPrivateTarget(overrides = {}, outputDirectory = join(temporaryDirectory(), 'dist')) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    name !== 'MTPROTO_TARGET_MODE' && !name.startsWith('MTPROTO_PRIVATE_')
  ));
  const result = spawnSync(process.execPath, [
    resolve('node_modules/vite/bin/vite.js'),
    'build',
    '--outDir',
    outputDirectory
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {...env, ...privateEnv(overrides)}
  });
  return {outputDirectory, result};
}

function buildTelegramTarget(outputDirectory = join(temporaryDirectory(), 'dist')) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    name !== 'MTPROTO_TARGET_MODE' && !name.startsWith('MTPROTO_PRIVATE_')
  ));
  const result = spawnSync(process.execPath, [
    resolve('node_modules/vite/bin/vite.js'),
    'build',
    '--outDir',
    outputDirectory
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env
  });
  return {outputDirectory, result};
}

function findArtifactFiles(directory, rootDirectory = directory, files = []) {
  for(const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if(entry.isDirectory()) {
      findArtifactFiles(path, rootDirectory, files);
    } else {
      files.push(path.slice(rootDirectory.length + 1));
    }
  }
  return files;
}

function writeArtifactFile(directory, relativePath, contents) {
  const file = join(directory, relativePath);
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, contents);
}

function findEmittedWorkers(directory, workers = []) {
  for(const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if(entry.isDirectory()) {
      findEmittedWorkers(path, workers);
    } else if(/^index\.worker-[^/]+\.js$/.test(entry.name)) {
      workers.push(path);
    }
  }
  return workers;
}

describe('MTProto build target', () => {
  it('keeps the default Telegram target unchanged', () => {
    expect(resolveMtprotoTarget({})).toEqual({mode: 'telegram'});
  });

  it.each(['', 'privatee', 'TELEGRAM'])('rejects an empty or unknown target mode %j', (mode) => {
    expect(() => resolveMtprotoTarget({MTPROTO_TARGET_MODE: mode})).toThrow(/either telegram or private/);
  });

  it('rejects private fields in Telegram mode', () => {
    expect(() => resolveMtprotoTarget({
      MTPROTO_TARGET_MODE: 'telegram',
      MTPROTO_PRIVATE_ENDPOINT: 'wss://private.example.test/apiws'
    })).toThrow(/private.*fields require.*private/i);
  });

  it.each([
    ['endpoint is omitted', {MTPROTO_PRIVATE_ENDPOINT: undefined}],
    ['endpoint is empty', {MTPROTO_PRIVATE_ENDPOINT: '  '}],
    ['key file is omitted', {MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: undefined}],
    ['key file is empty', {MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: '\t'}]
  ])('rejects private mode when the %s', (_name, overrides) => {
    expect(() => resolveMtprotoTarget(privateEnv(overrides))).toThrow(/requires non-empty/);
  });

  it('rejects alternate private-target fields', () => {
    expect(() => resolveMtprotoTarget(privateEnv({MTPROTO_PRIVATE_ENDPOINT_2: 'wss://other.example.test'})))
    .toThrow(/unrecognized.*MTPROTO_PRIVATE_ENDPOINT_2/i);
  });

  it('rejects an unknown private-target field without reading its value', () => {
    const env = privateEnv();
    Object.defineProperty(env, 'MTPROTO_PRIVATE_SECRET', {
      enumerable: true,
      get() {
        throw new Error('secret value was read');
      }
    });

    expect(() => resolveMtprotoTarget(env)).toThrow(/unrecognized.*MTPROTO_PRIVATE_SECRET/i);
  });

  it.each([
    ['MODE_INVALID', () => privateEnv({MTPROTO_TARGET_MODE: 'privatee'})],
    ['FIELDS_MISSING', () => privateEnv({MTPROTO_PRIVATE_ENDPOINT: ' '})],
    ['FIELD_UNRECOGNIZED', () => privateEnv({MTPROTO_PRIVATE_ENDPOINT_2: 'canary-key-value'})],
    ['FIELD_UNRECOGNIZED', () => ({MTPROTO_TARGET_MODE: 'telegram', MTPROTO_PRIVATE_ENDPOINT: 'wss://canary-target.example.test/apiws'})],
    ['ENDPOINT_PREFIX', () => privateEnv({MTPROTO_PRIVATE_ENDPOINT: 'https://canary-target.example.test/apiws?canary=query'})],
    ['ENDPOINT_PARSE', () => privateEnv({MTPROTO_PRIVATE_ENDPOINT: 'wss://canary-target.example.test:bad/apiws?canary=query'})],
    ['ENDPOINT_CREDENTIALS', () => privateEnv({MTPROTO_PRIVATE_ENDPOINT: 'wss://canary-user:canary-password@canary-target.example.test/apiws'})],
    ['ENDPOINT_QUERY', () => privateEnv({MTPROTO_PRIVATE_ENDPOINT: 'wss://canary-target.example.test/apiws?canary=query'})],
    ['ENDPOINT_FRAGMENT', () => privateEnv({MTPROTO_PRIVATE_ENDPOINT: 'wss://canary-target.example.test/apiws#canary-fragment'})],
    ['ENDPOINT_EMPTY_HOST', () => privateEnv({MTPROTO_PRIVATE_ENDPOINT: 'wss://./apiws'})],
    ['ENDPOINT_TELEGRAM_ORG', () => privateEnv({MTPROTO_PRIVATE_ENDPOINT: 'wss://telegram.org/apiws'})],
    ['KEY_FILE_OPEN', () => privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: '/canary-key/missing.pem'})],
    ['KEY_FILE_SHAPE', () => privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: writeKey('A'.repeat(16 * 1024 + 1))})],
    ['KEY_PRIVATE_MATERIAL', () => {
      const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
      return privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: writeKey(privateKey.export({type: 'pkcs8', format: 'pem'}))});
    }],
    ['KEY_PEM_SHAPE', () => privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: writeKey('canary-key-material-not-a-pem')})],
    ['KEY_BASE64_NONCANONICAL', () => privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: writeKey(fixtureKey.replace('AQAB', 'AQAB='))})],
    ['KEY_PARSE', () => privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: writeKey(pem('PUBLIC KEY', Buffer.from([1, 2, 3])))})],
    ['KEY_DER_NONCANONICAL', () => {
      const canonicalDer = createPublicKey(fixtureKey).export({type: 'spki', format: 'der'});
      return privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: writeKey(pem('PUBLIC KEY', Buffer.concat([canonicalDer, Buffer.from([1, 2, 3])])))});
    }],
    ['KEY_JWK_MISSING', () => {
      const {publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
      return privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: writeKey(publicKey.export({type: 'spki', format: 'pem'}))});
    }],
    ['KEY_SIZE_EXPONENT', () => {
      const {publicKey} = generateKeyPairSync('rsa', {modulusLength: 1024});
      return privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: writeKey(publicKey.export({type: 'spki', format: 'pem'}))});
    }]
  ])('tags %s with its fixed diagnostic code', (code, makeEnvironment) => {
    expect(targetError(makeEnvironment())).toMatchObject({code});
  });

  it.each([
    'https://private.example.test/apiws',
    'wss://user:pass@private.example.test/apiws',
    'wss://private.example.test/apiws?dc=1',
    'wss://private.example.test/apiws#target',
    'wss:///apiws',
    'not a URL',
    'wss://telegram.org/apiws',
    'wss://KWS2.WEB.TELEGRAM.ORG./apiws',
    'wss://ＴＥＬＥＧＲＡＭ．ＯＲＧ/apiws'
  ])('rejects private endpoint %s', (endpoint) => {
    expect(() => resolveMtprotoTarget(privateEnv({MTPROTO_PRIVATE_ENDPOINT: endpoint}))).toThrow();
  });

  it('does not retain malformed endpoint credentials in the complete error', () => {
    const credentialMarker = 'credential-marker';
    let thrown;
    try {
      resolveMtprotoTarget(privateEnv({
        MTPROTO_PRIVATE_ENDPOINT: `wss://build-user:${credentialMarker}@%`
      }));
    } catch(error) {
      thrown = error;
    }

    const rendered = inspect(thrown, {depth: null});
    expect(rendered).toMatch(/must be an absolute wss URL/);
    expect(rendered).not.toContain(credentialMarker);
  });

  it('rejects an unreadable key file', () => {
    const keyPath = '/does/not/exist-sensitive-key.pem';
    let thrown;
    try {
      resolveMtprotoTarget(privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: keyPath}));
    } catch(error) {
      thrown = error;
    }
    expect(thrown.message).toMatch(/read.*public key/i);
    expect(thrown.message).not.toContain(keyPath);
  });

  it.each([
    ['non-regular', () => temporaryDirectory()],
    ['oversized', () => writeKey('A'.repeat(32 * 1024))]
  ])('rejects a %s key file without disclosing its path', (_name, makeKeyPath) => {
    const keyPath = makeKeyPath();
    let thrown;
    try {
      resolveMtprotoTarget(privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: keyPath}));
    } catch(error) {
      thrown = error;
    }
    expect(thrown.message).toMatch(/read.*public key/i);
    expect(thrown.message).not.toContain(keyPath);
  });

  it.each([
    ['malformed PEM', 'not a key'],
    ['malformed base64', '-----BEGIN PUBLIC KEY-----\n%%%\n-----END PUBLIC KEY-----\n'],
    ['malformed DER', pem('PUBLIC KEY', Buffer.from([1, 2, 3]))],
    ['additional text', `${fixtureKey}unexpected`],
    ['additional PEM object', `${fixtureKey}${fixtureKey}`]
  ])('rejects %s', (_name, contents) => {
    expect(() => resolveMtprotoTarget(privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: writeKey(contents)})))
    .toThrow(/exactly one public RSA key/i);
  });

  it.each(['pkcs1', 'pkcs8'])('rejects %s private key material', (type) => {
    const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
    const keyPath = writeKey(privateKey.export({type, format: 'pem'}));
    expect(() => resolveMtprotoTarget(privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: keyPath})))
    .toThrow(/private key material/i);
  });

  it.each(['public', 'private'])('rejects appended %s DER inside one public PEM block', (kind) => {
    const firstKey = createPublicKey(fixtureKey).export({type: 'spki', format: 'der'});
    const keyPair = generateKeyPairSync('rsa', {modulusLength: 2048});
    const appendedKey = kind === 'public' ?
      keyPair.publicKey.export({type: 'spki', format: 'der'}) :
      keyPair.privateKey.export({type: 'pkcs8', format: 'der'});
    const keyPath = writeKey(pem('PUBLIC KEY', Buffer.concat([firstKey, appendedKey])));

    expect(() => resolveMtprotoTarget(privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: keyPath})))
    .toThrow(/exactly one public RSA key/i);
  });

  it.each([
    ['1024-bit modulus', {modulusLength: 1024}],
    ['exponent 3', {modulusLength: 2048, publicExponent: 3}]
  ])('rejects an RSA key with a %s', (_name, options) => {
    const {publicKey} = generateKeyPairSync('rsa', options);
    const keyPath = writeKey(publicKey.export({type: 'spki', format: 'pem'}));
    expect(() => resolveMtprotoTarget(privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: keyPath})))
    .toThrow(/2048-bit RSA.*exponent 65537/);
  });

  it('rejects a non-RSA public key', () => {
    const {publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
    const keyPath = writeKey(publicKey.export({type: 'spki', format: 'pem'}));
    expect(() => resolveMtprotoTarget(privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: keyPath})))
    .toThrow(/2048-bit RSA.*exponent 65537/);
  });

  it.each([
    ['PKCS#1', 'RSA PUBLIC KEY', 'pkcs1'],
    ['SPKI', 'PUBLIC KEY', 'spki']
  ])('accepts canonical %s DER and regenerates canonical PEM', (_name, label, type) => {
    const key = createPublicKey(fixtureKey);
    const der = key.export({type, format: 'der'});
    const keyPath = writeKey(pem(label, der, 37));

    expect(resolveMtprotoTarget(privateEnv({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: keyPath}))).toMatchObject({
      fingerprint: '289f8aeb5aa17de3',
      publicKey: key.export({type, format: 'pem'}).toString()
    });
  });

  it('normalizes and exposes one atomic private target', () => {
    const target = resolveMtprotoTarget(privateEnv({
      MTPROTO_PRIVATE_ENDPOINT: 'WSS://PRIVATE.Example.Test.:2443/a/../apiws'
    }));
    expect(target).toMatchObject({
      mode: 'private',
      endpoint: 'wss://private.example.test:2443/apiws',
      fingerprint: '289f8aeb5aa17de3',
      publicKey: fixtureKey
    });
    const jwk = createPublicKey(fixtureKey).export({format: 'jwk'});
    expect(target.publicKeyHex).toEqual({
      modulus: Buffer.from(jwk.n, 'base64url').toString('hex'),
      exponent: Buffer.from(jwk.e, 'base64url').toString('hex')
    });
  });

  it('allows a validated private target to emit a runnable artifact', () => {
    const target = resolveMtprotoTarget(privateEnv());
    expect(target.routeLock).toEqual({
      mode: 'private',
      endpoint: 'wss://private.example.test:2443/apiws',
      transport: 'websocket',
      dcIds: [1, 2, 3, 4, 5],
      connectionTypes: ['client', 'upload', 'download']
    });
    expect(() => assertRunnableMtprotoTarget(target)).not.toThrow();
  });

  it('tags a route-lock invariant failure with UNKNOWN', () => {
    const target = resolveMtprotoTarget(privateEnv());
    let error;
    try {
      assertRunnableMtprotoTarget({...target, routeLock: undefined});
    } catch(cause) {
      error = cause;
    }
    expect(error).toMatchObject({code: 'UNKNOWN'});
  });

  it('allows a configured WSS endpoint whose path contains apiw1', () => {
    const endpoint = 'wss://private.example.test:2443/apiw1';
    const target = resolveMtprotoTarget(privateEnv({MTPROTO_PRIVATE_ENDPOINT: endpoint}));
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, 'client.js'),
      `const endpoint = ${JSON.stringify(endpoint)};\nconst fingerprint = ${JSON.stringify(target.fingerprint)};\n`);
    includePrivateArtifactFonts(resolve('.'), outputDirectory);
    includePrivateArtifactBackground(resolve('.'), outputDirectory);

    expect(() => auditPrivateArtifact(outputDirectory, target)).not.toThrow();
  });

  it('rejects a clean JavaScript chunk accompanied by a source map', () => {
    const target = resolveMtprotoTarget(privateEnv());
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, 'client.js'), [
      `const endpoint = ${JSON.stringify(target.endpoint)};`,
      `const fingerprint = ${JSON.stringify(target.fingerprint)};`
    ].join('\n'));
    writeFileSync(join(outputDirectory, 'client.js.map'), JSON.stringify({
      version: 3,
      names: [],
      sources: [],
      mappings: ''
    }));
    includePrivateArtifactFonts(resolve('.'), outputDirectory);

    expect(() => writePrivateArtifactManifest(outputDirectory, target, process.cwd())).toThrow(/source map/i);
    expect(existsSync(join(outputDirectory, 'mtproto-target.json'))).toBe(false);
  });

  it.each([
    ['line hash sourceMappingURL', '//# sourceMappingURL=missing.js.map'],
    ['line at sourceMappingURL data URI', '//@ sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ=='],
    ['block hash sourceURL', '/*# sourceURL=worker.js */'],
    ['block at sourceURL', '/*@ sourceURL=worker.js */']
  ])('rejects %s directives in non-JavaScript output', (_name, directive) => {
    const target = resolveMtprotoTarget(privateEnv());
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, 'client.js'), [
      `const endpoint = ${JSON.stringify(target.endpoint)};`,
      `const fingerprint = ${JSON.stringify(target.fingerprint)};`
    ].join('\n'));
    writeFileSync(join(outputDirectory, 'index.html'), `<!-- ${directive} -->`);
    includePrivateArtifactFonts(resolve('.'), outputDirectory);

    expect(() => auditPrivateArtifact(outputDirectory, target)).toThrow(/source.?map|source url/i);
  });

  it.each([
    ['alternate WSS endpoint', 'wss://other.example.test/apiws', /second private MTProto target/i],
    ['cleartext WebSocket URL', 'ws://telegramd.test/apiws', /cleartext WebSocket/i],
    ['official DC route', 'https://kws1.web.telegram.org/apiws', /official Telegram MTProto route/i],
    ['official IPv4 DC address', '149.154.167.91', /official Telegram MTProto IP/i],
    ['official IPv6 DC prefix', '2001:b28:f23d:f001::a', /official Telegram MTProto IP/i],
    ['trusted official RSA fingerprint', 'c3b42b026ce86b21', /trusted Telegram RSA fingerprint/i],
    ['trusted official RSA modulus', trustedOfficialModulus, /trusted Telegram RSA public key/i],
    ['private-key block', '-----BEGIN PRIVATE KEY-----\ncanary\n-----END PRIVATE KEY-----', /private key material/i]
  ])('rejects %s in every emitted file', (_name, payload, expectedError) => {
    const target = resolveMtprotoTarget(privateEnv());
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, 'client.js'), [
      `const endpoint = ${JSON.stringify(target.endpoint)};`,
      `const fingerprint = ${JSON.stringify(target.fingerprint)};`
    ].join('\n'));
    writeArtifactFile(outputDirectory, 'assets/app.css', payload);
    includePrivateArtifactFonts(resolve('.'), outputDirectory);

    expect(() => auditPrivateArtifact(outputDirectory, target)).toThrow(expectedError);
  });

  it('rejects a query variant of the configured WSS endpoint', () => {
    const target = resolveMtprotoTarget(privateEnv());
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, 'client.js'), [
      `const endpoint = ${JSON.stringify(target.endpoint)};`,
      `const fingerprint = ${JSON.stringify(target.fingerprint)};`
    ].join('\n'));
    writeArtifactFile(outputDirectory, 'assets/app.css', `content: "${target.endpoint}?variant=canary";`);
    includePrivateArtifactFonts(resolve('.'), outputDirectory);

    expect(() => auditPrivateArtifact(outputDirectory, target)).toThrow(/second private MTProto target/i);
  });

  it('allows ordinary HTTPS product references in non-JavaScript output', () => {
    const target = resolveMtprotoTarget(privateEnv());
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, 'client.js'), [
      `const endpoint = ${JSON.stringify(target.endpoint)};`,
      `const fingerprint = ${JSON.stringify(target.fingerprint)};`
    ].join('\n'));
    writeArtifactFile(outputDirectory, 'assets/app.css', 'content: "https://web.telegram.org/a/";');
    includePrivateArtifactFonts(resolve('.'), outputDirectory);
    includePrivateArtifactBackground(resolve('.'), outputDirectory);

    expect(() => auditPrivateArtifact(outputDirectory, target)).not.toThrow();
  });

  it('rejects an HTTP MTProto route in a private artifact', () => {
    const target = resolveMtprotoTarget(privateEnv());
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, 'client.js'), [
      `const endpoint = ${JSON.stringify(target.endpoint)};`,
      `const fallback = ${JSON.stringify('https://private.example.test/apiw1')};`,
      `const fingerprint = ${JSON.stringify(target.fingerprint)};`
    ].join('\n'));

    expect(() => auditPrivateArtifact(outputDirectory, target)).toThrow(/HTTP MTProto transport/i);
  });

  it.each([
    ['an interpolated official host and path', 'const route = `wss://${suffix}ws${dcId}${suffix}.web.telegram.org/${path}`;'],
    ['a concatenated official host and path', "const route = host + '.web.telegram.org/' + path;"]
  ])('rejects %s in a private artifact', (_name, route) => {
    const target = resolveMtprotoTarget(privateEnv());
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, 'client.js'), [
      `const endpoint = ${JSON.stringify(target.endpoint)};`,
      route,
      `const fingerprint = ${JSON.stringify(target.fingerprint)};`
    ].join('\n'));

    expect(() => auditPrivateArtifact(outputDirectory, target)).toThrow(/official Telegram MTProto route/i);
  });

  it('rejects an executable transport violation when a source map is also present', () => {
    const target = resolveMtprotoTarget(privateEnv());
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, 'index.worker.js'), [
      `const endpoint = ${JSON.stringify(target.endpoint)};`,
      "const route = 'wss://kws1.web.telegram.org/apiws';",
      `const fingerprint = ${JSON.stringify(target.fingerprint)};`
    ].join('\n'));
    writeFileSync(join(outputDirectory, 'index.worker.js.map'), JSON.stringify({
      version: 3,
      names: [],
      sources: [],
      mappings: ''
    }));
    includePrivateArtifactFonts(resolve('.'), outputDirectory);

    expect(() => auditPrivateArtifact(outputDirectory, target)).toThrow(/official Telegram MTProto route/i);
  });

  it('emits a self-identifying private Vite artifact with a blob-safe worker and restrictive CSP', async() => {
    const {outputDirectory, result} = buildPrivateTarget();
    const target = resolveMtprotoTarget(privateEnv());

    expect(result.status).toBe(0);
    expect(existsSync(outputDirectory)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(outputDirectory, 'mtproto-target.json'), 'utf8'));
    expect(manifest).toMatchObject({
      mode: 'private',
      endpoint: 'wss://private.example.test:2443/apiws',
      fingerprint: '289f8aeb5aa17de3',
      sourceCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      artifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    });
    const index = readFileSync(join(outputDirectory, 'index.html'), 'utf8').replaceAll('&#39;', "'");
    expect(index).toContain('Content-Security-Policy');
    expect(index).toContain("connect-src 'self' wss://private.example.test:2443/apiws");
    expect(() => verifyPrivateArtifactCsp(outputDirectory, target.endpoint)).not.toThrow();
    const artifactFiles = findArtifactFiles(outputDirectory);
    expect(artifactFiles.some((file) => file.toLowerCase().endsWith('.map'))).toBe(false);
    for(const file of artifactFiles) {
      expect(readFileSync(join(outputDirectory, file), 'latin1'))
      .not.toMatch(/(?:\/\/|\/\*)[#@]\s*source(?:MappingURL|URL)\s*=/i);
    }
    const executable = readdirSync(outputDirectory)
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(outputDirectory, file), 'utf8'))
    .join('\n');
    expect(executable).toContain('289f8aeb5aa17de3');
    expect(executable).not.toMatch(/(?:kws[1-5]|apiw(?:_test1|1))\.web\.telegram\.org|\bapiw(?:_test1|1)\b/i);
    expect(executable).not.toContain('c3b42b026ce86b21');
    expect(mtprotoTarget.verifyPrivateArtifactManifest(outputDirectory)).toEqual(manifest);

    const workerPaths = findEmittedWorkers(outputDirectory);
    expect(workerPaths.length).toBeGreaterThan(0);
    const relativeImportPattern = /(?:\bfrom\s*|\bimport\s*)(["'])(\.{1,2}\/[^"']+)\1/;
    const relativeDynamicImportPattern = /import\s*\(\s*(["'\x60])(\.{1,2}\/[^"'\x60]+)\1\s*\)/;
    const workerPath = workerPaths.find((path) =>
      relativeDynamicImportPattern.test(readFileSync(path, 'utf8'))
    ) || workerPaths.find((path) =>
      relativeImportPattern.test(readFileSync(path, 'utf8'))
    ) || workerPaths[0];
    const workerSource = readFileSync(workerPath, 'utf8');
    const relativeImport = workerSource.match(relativeImportPattern);
    const relativeDynamicImport = workerSource.match(relativeDynamicImportPattern);

    if(relativeImport || relativeDynamicImport) {
      const originalFetch = globalThis.fetch;
      const originalCreateObjectURL = URL.createObjectURL;
      const createObjectURL = vi.fn(() => 'blob:private-mtproto-worker');
      vi.stubGlobal('fetch', vi.fn(async() => ({
        ok: true,
        text: async() => workerSource
      })));
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: createObjectURL
      });

      try {
        await expect(createPrivateWorkerBlobURL(workerPath)).resolves.toBe('blob:private-mtproto-worker');
        const blob = createObjectURL.mock.calls[0][0];
        const blobSource = await blob.text();
        expect(blobSource).not.toMatch(relativeImportPattern);
        expect(blobSource).not.toMatch(relativeDynamicImportPattern);
        const firstRelativeSpecifier = relativeDynamicImport?.[2] || relativeImport?.[2];
        expect(blobSource).toContain(new URL(firstRelativeSpecifier, location.href).href);
      } finally {
        vi.stubGlobal('fetch', originalFetch);
        if(originalCreateObjectURL) {
          Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: originalCreateObjectURL
          });
        } else {
          delete URL.createObjectURL;
        }
      }
    }
  }, 60_000);

  it('rejects a production build without a private target', () => {
    const {outputDirectory, result} = buildTelegramTarget();

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Teagram production builds require a private MTProto target');
    expect(existsSync(outputDirectory)).toBe(false);
  }, 60_000);

  it('rejects source-map audit builds outside CI', () => {
    const {outputDirectory, result} = buildPrivateTarget({
      CI: 'false',
      MTPROTO_SOURCE_MAP_AUDIT: '1'
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('source-map audit builds require CI');
    expect(existsSync(outputDirectory)).toBe(false);
  }, 60_000);

  it('audits mapped private-target chunks without producing a deployable artifact', () => {
    const {outputDirectory, result} = buildPrivateTarget({
      CI: 'true',
      MTPROTO_SOURCE_MAP_AUDIT: '1'
    });
    const auditEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      name !== 'MTPROTO_TARGET_MODE' && !name.startsWith('MTPROTO_PRIVATE_')
    ));
    const audit = result.status === 0 ? spawnSync(process.execPath, [
      resolve('scripts/check-bundle-mangling.mjs'),
      outputDirectory
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: auditEnvironment
    }) : undefined;

    expect(result.status).toBe(0);
    expect(existsSync(join(outputDirectory, 'mtproto-target.json'))).toBe(false);
    expect(findArtifactFiles(outputDirectory).some((file) => file.endsWith('.map'))).toBe(true);
    expect(audit?.status).toBe(0);
    expect(audit?.stdout).toMatch(/[1-9]\d* mapped chunks for miscompiled defaults/);
  }, 120_000);

  it('runs the focused private artifact output and audit check', () => {
    const result = spawnSync(process.execPath, [resolve('scripts/check-private-artifact-output.mjs')], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('endpoint=wss://telegramd.test/apiws');
    expect(result.stdout).toMatch(/sourceCommit=[0-9a-f]{40}/);
    expect(result.stdout).toMatch(/artifactDigest=sha256:[0-9a-f]{64}/);
    expect(result.stdout).toMatch(/0 mapped chunks for miscompiled defaults/);
  }, 120_000);

  it('fails private bundle auditing when the sidecar is missing', () => {
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, 'client.js'), 'const client = 1;\n');

    const audit = spawnSync(process.execPath, [
      resolve('scripts/check-bundle-mangling.mjs'),
      outputDirectory
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {...process.env, MTPROTO_TARGET_MODE: 'private'}
    });

    expect(audit.status).not.toBe(0);
    expect(`${audit.stdout}${audit.stderr}`).toMatch(/private artifact manifest is missing/i);
  }, 60_000);

  it('checks lost literals in JavaScript chunks without source maps', () => {
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, 'client.js'), 'const broken = "�";\n');

    const audit = spawnSync(process.execPath, [
      resolve('scripts/check-bundle-mangling.mjs'),
      outputDirectory
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        name !== 'MTPROTO_TARGET_MODE' && !name.startsWith('MTPROTO_PRIVATE_')
      ))
    });

    expect(audit.status).not.toBe(0);
    expect(`${audit.stdout}${audit.stderr}`).toMatch(/U\+FFFD/);
  });

  it('fails private bundle validation when it would check zero JavaScript chunks', () => {
    const outputDirectory = temporaryDirectory();
    const audit = spawnSync(process.execPath, [
      resolve('scripts/check-bundle-mangling.mjs'),
      outputDirectory
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {...process.env, MTPROTO_TARGET_MODE: 'private'}
    });

    expect(audit.status).not.toBe(0);
    expect(`${audit.stdout}${audit.stderr}`).toMatch(/no JavaScript chunks/i);
  });

  it('fails private artifact verification after a completed artifact is changed', () => {
    const target = resolveMtprotoTarget(privateEnv());
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, 'client.js'), [
      'const endpoint = ' + JSON.stringify(target.endpoint) + ';',
      'const fingerprint = ' + JSON.stringify(target.fingerprint) + ';'
    ].join('\n'));
    writePrivateArtifactManifest(outputDirectory, target, process.cwd());

    const executable = readdirSync(outputDirectory).find((file) => file.endsWith('.js'));
    expect(executable).toBeTruthy();
    writeFileSync(join(outputDirectory, executable), readFileSync(join(outputDirectory, executable)) + '\n// tampered');
    expect(() => mtprotoTarget.verifyPrivateArtifactManifest(outputDirectory)).toThrow(/digest/i);
  });

  it('does not rewrite existing output when private validation fails', () => {
    const keyPath = writeKey('not a key');
    const outputDirectory = join(temporaryDirectory(), 'dist');
    mkdirSync(outputDirectory);
    const sentinelPath = join(outputDirectory, 'sentinel.txt');
    writeFileSync(sentinelPath, 'keep this artifact');
    const {result} = buildPrivateTarget({MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: keyPath}, outputDirectory);

    expect(result.status).not.toBe(0);
    expect(readdirSync(outputDirectory)).toEqual(['sentinel.txt']);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('keep this artifact');
    expect(`${result.stdout}${result.stderr}`).not.toContain(keyPath);
    expect(`${result.stdout}${result.stderr}`).not.toContain('not a key');
  });
});
