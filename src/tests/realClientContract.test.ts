import {chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import {
  assertAllScenariosPassed,
  parseFixtureReadiness,
  parseRealClientArgs,
  parseRequiredScenarios,
  readSyntheticCredentials
} from '../../scripts/real-client/contract.mjs';

const require = createRequire(import.meta.url);
const {getSingleExactMessageFailure, matchesPrivateArtifactManifest} = require('../../scripts/real-client/browser.cjs');

describe('real client scenario contract', () => {
  it('requires exactly one recipient message with the expected text', () => {
    expect(getSingleExactMessageFailure(['browser-ci-hello'], 'browser-ci-hello')).toBe(null);
    expect(getSingleExactMessageFailure(['prefix browser-ci-hello'], 'browser-ci-hello')).toBe('content');
    expect(getSingleExactMessageFailure(['browser-ci-hello', 'browser-ci-hello'], 'browser-ci-hello')).toBe('count');
  });

  it('rejects missing and empty scenario selection', () => {
    expect(() => parseRequiredScenarios(undefined)).toThrow('scenario selection is required');
    expect(() => parseRequiredScenarios('')).toThrow('scenario selection is required');
    expect(() => parseRequiredScenarios(' , ')).toThrow('scenario selection is required');
  });

  it('requires every scenario exactly once', () => {
    expect(() => parseRequiredScenarios('sign-in,message')).toThrow('required scenarios are missing');
    expect(() => parseRequiredScenarios('sign-in,message,group,group')).toThrow('duplicate scenario');
    expect(() => parseRequiredScenarios('sign-in,message,group,channel')).toThrow('unknown scenario');
    expect(parseRequiredScenarios('sign-in,message,group')).toEqual(['sign-in', 'message', 'group']);
  });

  it('fails if a required scenario was skipped or did not report success', () => {
    expect(() => assertAllScenariosPassed([
      {name: 'sign-in', status: 'passed'},
      {name: 'message', status: 'passed'},
      {name: 'group', status: 'skipped'}
    ])).toThrow('group was skipped');
    expect(() => assertAllScenariosPassed([
      {name: 'sign-in', status: 'passed'},
      {name: 'message', status: 'failed'},
      {name: 'group', status: 'passed'}
    ])).toThrow('message did not pass');
    expect(() => assertAllScenariosPassed([
      {name: 'sign-in', status: 'passed'},
      {name: 'message', status: 'passed'}
    ])).toThrow('group did not execute');
    expect(assertAllScenariosPassed([
      {name: 'sign-in', status: 'passed'},
      {name: 'message', status: 'passed'},
      {name: 'group', status: 'passed'}
    ])).toEqual(['sign-in', 'message', 'group']);
  });

  it('matches the audited private manifest schema without requiring an absent public key hash field', () => {
    const expected = {
      wssEndpoint: 'wss://telegramd.test/apiws',
      fingerprint: '1234567890abcdef',
      publicKeySHA256: 'a'.repeat(64),
      webRevision: 'b7523e39f5365f50ab6ecd7aa1fb4c79eedf08d8',
      artifactDigest: `sha256:${'c'.repeat(64)}`
    };
    const manifest = {
      mode: 'private',
      endpoint: expected.wssEndpoint,
      fingerprint: expected.fingerprint,
      sourceCommit: expected.webRevision,
      artifactDigest: expected.artifactDigest
    };

    expect(matchesPrivateArtifactManifest(manifest, expected)).toBe(true);
    expect(matchesPrivateArtifactManifest({...manifest, endpoint: 'wss://other.test/apiws'}, expected)).toBe(false);
    expect(matchesPrivateArtifactManifest({...manifest, fingerprint: '0'.repeat(16)}, expected)).toBe(false);
    expect(matchesPrivateArtifactManifest({...manifest, sourceCommit: '0'.repeat(40)}, expected)).toBe(false);
    expect(matchesPrivateArtifactManifest({...manifest, artifactDigest: `sha256:${'0'.repeat(64)}`}, expected)).toBe(false);
    expect(matchesPrivateArtifactManifest({...manifest, publicKeySHA256: expected.publicKeySHA256}, expected)).toBe(false);
  });

  it('requires matching server and audited artifact readiness for the same immutable run', () => {
    const runId = 'a'.repeat(32);
    const pins = {
      runId,
      harnessRevision: '47daaaea5c71b859d9865c03cabb50da5a1a013b',
      serverRevision: '47daaaea5c71b859d9865c03cabb50da5a1a013b',
      webRevision: 'b7523e39f5365f50ab6ecd7aa1fb4c79eedf08d8'
    };
    const mtprotoPublicKeyPEM = generateKeyPairSync('rsa', {modulusLength: 2048}).publicKey.export({type: 'spki', format: 'pem'}).trimEnd();
    const expected = {
      event: 'server-ready',
      status: 'ready',
      ...pins,
      evidenceClass: 'production-telegramd',
      endpoint: 'https://telegramd.test',
      wssEndpoint: 'wss://telegramd.test/apiws',
      mode: 'private',
      mtprotoPublicKeyPEM,
      publicKeySHA256: createHash('sha256').update(mtprotoPublicKeyPEM).digest('hex'),
      fingerprint: '1234567890abcdef',
      leafSPKI: Buffer.from('a'.repeat(64), 'hex').toString('base64'),
      credentials: [
        {username: `u${runId.slice(0, 30)}a`, passwordFile: `/dev/shm/telegram-fixture-${runId}.abc/a-password`},
        {username: `u${runId.slice(0, 30)}b`, passwordFile: `/dev/shm/telegram-fixture-${runId}.abc/b-password`}
      ],
      security: {
        registrationClosed: true,
        loginCodeLogging: false,
        electionClosed: true,
        administratorIsNull: true,
        ordinaryUsers: 2,
        usernameAccounts: 2,
        passwordVerifiers: 2,
        initialAuthKeys: 0,
        initialMessages: 0,
        finalAuthKeys: 2
      },
      evidence: {
        httpStatus: 200,
        wssUpgradeStatus: 101,
        allowedWssObserved: 1,
        workerProbes: {
          page: {attempted: 8, blocked: 8},
          shared_worker: {attempted: 8, blocked: 8},
          service_worker: {attempted: 8, blocked: 8}
        },
        observerControlledAttempts: {page: 8, shared_worker: 8, service_worker: 8},
        directTCP: {attempted: 5, blocked: 5},
        unexpectedAttempts: 0,
        unexpectedDetectionVerified: true
      }
    };
    const artifactReady = {
      event: 'artifact-ready',
      status: 'ready',
      ...pins,
      endpoint: expected.endpoint,
      wssEndpoint: expected.wssEndpoint,
      fingerprint: expected.fingerprint,
      artifactDigest: `sha256:${'c'.repeat(64)}`,
      manifestSHA256: 'd'.repeat(64),
      indexSHA256: 'e'.repeat(64),
      auditChecks: {
        manifestMode: true,
        manifestEndpoint: true,
        manifestFingerprint: true,
        manifestSourceCommit: true,
        artifactDigest: true,
        privateCSP: true,
        privateTargetInBundle: true,
        safeFileTypesAndPermissions: true,
        routeCollisions: true
      },
      browser: {
        status: 'passed',
        entryResponseStatus: 200,
        manifestResponseStatus: 200,
        artifactResponses: 8,
        artifactResponsesWithPrivateCSP: 8,
        workerTargets: {shared_worker: 1, service_worker: 1},
        unexpectedAttempts: 0,
        observerErrors: 0
      }
    };
    const text = [expected, artifactReady].map((event) => JSON.stringify(event)).join('\n');

    expect(parseFixtureReadiness(text, pins)).toEqual({serverReady: expected, artifactReady});
    expect(() => parseFixtureReadiness(JSON.stringify(expected), pins)).toThrow('both fixture readiness events are required');
    expect(() => parseFixtureReadiness([expected, {...artifactReady, webRevision: 'f'.repeat(40)}].map((event) => JSON.stringify(event)).join('\n'), pins))
    .toThrow('artifact-ready does not match the requested immutable inputs');
    expect(() => parseFixtureReadiness([expected, {...artifactReady, browser: {...artifactReady.browser, unexpectedAttempts: 1}}]
      .map((event) => JSON.stringify(event)).join('\n'), pins)).toThrow('artifact-ready audit or browser evidence is incomplete');
    expect(() => parseFixtureReadiness([{...expected, publicKeySHA256: 'f'.repeat(64)}, artifactReady]
      .map((event) => JSON.stringify(event)).join('\n'), pins)).toThrow('server-ready security evidence is incomplete');
    expect(() => parseFixtureReadiness([expected, {...artifactReady, auditChecks: {manifestMode: true}}]
      .map((event) => JSON.stringify(event)).join('\n'), pins)).toThrow('artifact-ready audit or browser evidence is incomplete');
  });

  it('reads only the fixture-owned mode-0400 synthetic password files', () => {
    const runId = 'c'.repeat(32);
    const secretDirectory = mkdtempSync(join(tmpdir(), `telegram-fixture-${runId}.`));
    chmodSync(secretDirectory, 0o700);
    const passwordFileA = join(secretDirectory, 'a-password');
    const passwordFileB = join(secretDirectory, 'b-password');
    writeFileSync(passwordFileA, `${'1'.repeat(64)}\n`, {mode: 0o400});
    writeFileSync(passwordFileB, `${'2'.repeat(64)}\n`, {mode: 0o400});
    chmodSync(passwordFileA, 0o400);
    chmodSync(passwordFileB, 0o400);

    try {
      const credentials = [
        {username: `u${runId.slice(0, 30)}a`, passwordFile: passwordFileA},
        {username: `u${runId.slice(0, 30)}b`, passwordFile: passwordFileB}
      ];
      expect(readSyntheticCredentials(credentials, runId)).toEqual([
        {username: `u${runId.slice(0, 30)}a`, password: '1'.repeat(64)},
        {username: `u${runId.slice(0, 30)}b`, password: '2'.repeat(64)}
      ]);

      chmodSync(passwordFileA, 0o600);
      expect(() => readSyntheticCredentials(credentials, runId)).toThrow('synthetic password file is not protected');
      chmodSync(passwordFileA, 0o400);
      const hardLink = join(secretDirectory, 'a-password-hardlink');
      linkSync(passwordFileA, hardLink);
      expect(() => readSyntheticCredentials(credentials, runId)).toThrow('synthetic password file is not protected');
      unlinkSync(hardLink);
      unlinkSync(passwordFileA);
      symlinkSync(passwordFileB, passwordFileA);
      expect(() => readSyntheticCredentials(credentials, runId)).toThrow('fixture synthetic password file is unavailable');
    } finally {
      rmSync(secretDirectory, {recursive: true, force: true});
    }
  });

  it('requires explicit immutable pins, readiness and the complete scenario set', () => {
    const args = [
      '--readiness-file', './fixture.jsonl',
      '--harness-revision', '47daaaea5c71b859d9865c03cabb50da5a1a013b',
      '--server-revision', '47daaaea5c71b859d9865c03cabb50da5a1a013b',
      '--web-revision', 'b7523e39f5365f50ab6ecd7aa1fb4c79eedf08d8',
      '--run-id', 'a'.repeat(32),
      '--scenarios', 'sign-in,message,group'
    ];

    expect(parseRealClientArgs(args)).toEqual({
      readinessFile: './fixture.jsonl',
      harnessRevision: '47daaaea5c71b859d9865c03cabb50da5a1a013b',
      serverRevision: '47daaaea5c71b859d9865c03cabb50da5a1a013b',
      webRevision: 'b7523e39f5365f50ab6ecd7aa1fb4c79eedf08d8',
      runId: 'a'.repeat(32),
      scenarios: ['sign-in', 'message', 'group']
    });
    expect(parseRealClientArgs(['--', ...args])).toEqual(parseRealClientArgs(args));
    expect(() => parseRealClientArgs([])).toThrow('missing required options');
    expect(() => parseRealClientArgs(args.slice(0, -2))).toThrow('scenario selection is required');
    expect(() => parseRealClientArgs([...args, '--scenarios', 'sign-in,message'])).toThrow('option was provided more than once');
    expect(() => parseRealClientArgs([...args, '--source-sha', 'a'.repeat(40)])).toThrow('unknown option');
  });
});
