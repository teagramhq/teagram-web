import {chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {
  assertAllScenariosPassed,
  formatBrowserFailureMessage,
  parseAuthProgressReport,
  parseCenterColumnState,
  parseFixtureReadiness,
  parseGroupCreatedState,
  parseGroupNameFormState,
  parseObserverControls,
  parseRealClientArgs,
  parseRequiredScenarios,
  parseWorkerObservation,
  readSyntheticCredentials
} from '../../scripts/real-client/contract.mjs';
import * as realClientContract from '../../scripts/real-client/contract.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require('@playwright/test');
const realClientBrowser = require('../../scripts/real-client/browser.cjs');
const {captureCenterColumnState, captureGroupCreatedState, captureGroupNameFormState, countClientErrors, createNetworkObserver, createWorkerDiscovery, emitAuthProgressReport, getSingleExactMessageFailure, getSingleExactMessageTextFailure, main: runRealClient, matchesPrivateArtifactManifest, nameNewGroup, openBobGroupChat, openComposer, prepareUsernameEntry, resolveActiveGroupChat, sendGroupText, submitUsernameOnceAndWaitForPassword, validateRuntimeInput, waitForGroupCreated, waitForPasswordField, submitPassword} = realClientBrowser;
const observation = require('../../scripts/real-client/observation.cjs');

const APP_ORIGIN = 'https://telegramd.test';
const MTPROTO_CHUNK_URL = `${APP_ORIGIN}/index.worker-AbCdEfGh.js?x-protocol-version=4`;
const PROBE_WORKER_URL = `${APP_ORIGIN}/_fixture_probe/shared-worker.js`;
const PROBE_MISSING_URL = `${APP_ORIGIN}/_fixture_probe/missing.js`;
const HOSTILE_PASSWORD = 'f4ce'.repeat(16);
const HOSTILE = Object.freeze({
  username: 'u' + 'a'.repeat(30) + 'a',
  password: HOSTILE_PASSWORD,
  token: 'bearer-secret-value',
  url: 'https://unannounced.invalid/exfiltrate?token=bearer-secret-value',
  blobUrl: 'blob:https://telegramd.test/0e4a2c1a-1111-2222-3333-444444444444',
  phrase: 'hunter2 secret passphrase',
  frame: `at ${APP_ORIGIN}/index.worker-AbCdEfGh.js:1:7 (${HOSTILE_PASSWORD})`
});

function createNetworkObserverHarness(observer: any, options: any = {}) {
  const cdp: any = new EventEmitter();
  cdp.send = options.send || (async(method: string) => method === 'Target.getTargetInfo'
    ? {targetInfo: {browserContextId: 'contract-test'}}
    : {});
  cdp.detach = options.detach || (async() => {});
  const context = {newCDPSession: async() => cdp, close: options.closeContext || (async() => {})};
  const page: any = {context: () => context};
  return {cdp, networkObserver: createNetworkObserver(page, 'contract-test', observer)};
}

function emptyWebSocket101Grid() {
  return {
    alice: {pre_submit: 0, post_submit: 0, unknown: 0},
    control: {pre_submit: 0, post_submit: 0, unknown: 0},
    other: {pre_submit: 0, post_submit: 0, unknown: 0}
  };
}

function emitContextWebSocket101(observer: any, targetId: string, sessionId: string, requestId: string) {
  observer.noteWorkerEvent(targetId, 'Network.webSocketCreated', {requestId}, sessionId);
  observer.noteWorkerEvent(targetId, 'Network.webSocketHandshakeResponseReceived', {
    requestId,
    response: {status: 101}
  }, sessionId);
}

function createDiscoveryHarness(send: (method: string, params: any) => Promise<any> = async() => ({})) {
  const session: any = new EventEmitter();
  session.send = send;
  const browser: any = {newBrowserCDPSession: async() => session};
  return {browser, registry: createWorkerDiscovery(), session};
}

function acknowledgeCdpCommand(session: any, params: any, error = false) {
  const {id} = JSON.parse(params.message);
  queueMicrotask(() => session.emit('Target.receivedMessageFromTarget', {
    sessionId: params.sessionId,
    message: JSON.stringify(error ? {id, error: {message: HOSTILE.phrase}} : {id, result: {}})
  }));
}

function createWorkerNetworkObserverHarness(observer: any, browserContextId: string) {
  const harness = createNetworkObserverHarness(observer, {
    send: async(method: string, params: any) => {
      if(method === 'Target.sendMessageToTarget') acknowledgeCdpCommand(harness.cdp, params);
      return method === 'Target.getTargetInfo' ? {targetInfo: {browserContextId}} : {};
    }
  });
  return harness;
}

async function createDiscoveryNetworkHarness(options: any = {}) {
  const calls: any[] = [];
  const discovery = createDiscoveryHarness(async(method, params) => {
    calls.push({method, params});
    if(method === 'Target.attachToTarget') {
      if(options.attachFailure) throw new Error(HOSTILE.phrase);
      return {sessionId: `discovery-${params.targetId}`};
    }
    if(method === 'Target.sendMessageToTarget') {
      const {method: nestedMethod} = JSON.parse(params.message);
      if(options.detachBeforeSetup && nestedMethod === 'Network.enable') {
        discovery.session.emit('Target.detachedFromTarget', {sessionId: params.sessionId});
      }
      acknowledgeCdpCommand(discovery.session, params, options.setupFailure && nestedMethod === 'Network.enable');
    }
    return {};
  });
  if(options.launch !== false) await discovery.registry.launch(discovery.browser);
  const contexts: any[] = [];
  async function startContext(name: string, control = false) {
    const observer = observation.createContextObserver(name, {control, observeWebSocket101: options.observeWebSocket101 !== false});
    const {cdp, networkObserver} = createWorkerNetworkObserverHarness(observer, name);
    await networkObserver.start(discovery.registry);
    discovery.session.emit('Target.targetCreated', {targetInfo: pageTarget(`${name}-page`, name)});
    observer.state.windowElapsed = true;
    const context = {name, observer, cdp, networkObserver};
    contexts.push(context);
    return context;
  }
  const alice = options.startContext === false ? undefined : await startContext('alice');
  return {
    ...discovery,
    calls,
    alice,
    startContext,
    async attach(context: any, targetId: string, via = 'discovery', type = 'shared_worker') {
      const targetInfo = {targetId, type, url: HOSTILE.blobUrl, browserContextId: context.name};
      if(via === 'discovery') discovery.session.emit('Target.targetCreated', {targetInfo});
      else context.cdp.emit('Target.attachedToTarget', {sessionId: `auto-${targetId}`, targetInfo});
      await Promise.all([context.networkObserver.waitForSetup(), discovery.registry.waitForSetup()]);
    },
    emit(context: any, targetId: string, method: string, params: any, via = 'discovery', forged: any = {}) {
      const emitter = via === 'discovery' ? discovery.session : context.cdp;
      emitter.emit('Target.receivedMessageFromTarget', {
        sessionId: `${via === 'discovery' ? 'discovery' : 'auto'}-${targetId}`,
        message: JSON.stringify({...forged, method, params})
      });
    },
    async stop() {
      await discovery.registry.stop();
      for(const context of contexts) await context.networkObserver.stop();
    }
  };
}

async function runDiscoveryAccountingGate(events: any[], fault?: string) {
  const harness = await createDiscoveryNetworkHarness({
    startContext: false,
    launch: false,
    attachFailure: fault === 'attach',
    setupFailure: fault === 'setup',
    detachBeforeSetup: fault === 'detach'
  });
  const page = new EventEmitter();
  const context = {newPage: async() => page, close: async() => {}};
  const browser = {...harness.browser, newContext: async() => context, close: async() => {}};
  const runId = createHash('sha256').update(`${process.pid}-${Math.random()}`).digest('hex').slice(0, 32);
  const runtimeConfig = {
    runId,
    endpoint: APP_ORIGIN,
    wssEndpoint: 'wss://telegramd.test/apiws',
    fingerprint: '1234567890abcdef',
    publicKeySHA256: 'a'.repeat(64),
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    manifestArtifactDigest: `sha256:${'d'.repeat(64)}`,
    webRevision: READINESS_PINS.webRevision,
    leafSPKI: Buffer.alloc(32, 1).toString('base64'),
    frontIp: '127.0.0.1',
    screenshotDirectory: `/tmp/real-client-${runId}`,
    authProgressOneSubmission: true,
    accounts: [{username: `u${runId.slice(0, 30)}a`, password: 'c'.repeat(64)}]
  };
  let app: any;
  let report: any;
  await runRealClient({
    runtimeConfig,
    launchBrowser: async() => browser,
    createWorkerDiscovery: () => harness.registry,
    runObserverControls: async() => ({controls: controlBlocks(), failedControls: [] as string[]}),
    emitAuthProgressReport: (value: any, cleanupFailed: boolean) => {
      report = cleanupFailed ? {...value, status: 'failed', stage: 'cleanup'} : value;
    },
    authProgressDependencies: {
      createNetworkObserver: (_page: any, name: string, observer: any) => {
        const {cdp, networkObserver} = createWorkerNetworkObserverHarness(observer, name);
        app = {name, observer, cdp, networkObserver};
        return networkObserver;
      },
      submitUsernameOnceAndWaitForPassword: async(_page: any, _account: any, _runtime: any, _name: string, evidence: any, counts: any) => {
        counts.usernameSubmissions++;
        evidence.push({stage: 'alice_password_field_ready', count: 1});
        harness.session.emit('Target.targetCreated', {targetInfo: pageTarget('alice-page', 'alice')});
        await harness.attach(app, 'alice-worker');
        await harness.attach(app, 'service-worker', 'auto', 'service_worker');
        harness.emit(app, 'service-worker', 'Network.webSocketCreated', {requestId: 'service-allowed', url: 'wss://telegramd.test/apiws'}, 'auto');
        harness.emit(app, 'alice-worker', 'Network.webSocketCreated', {requestId: 'allowed', url: 'wss://telegramd.test/apiws'});
        if(fault === 'overflow') app.observer.noteInjectedControlFault('overflow');
        for(const event of events) harness.emit(app, 'alice-worker', event.method, event.params);
      }
    }
  });
  return report;
}

async function settleAfterCdpDeadline(promise: Promise<any>) {
  const settled = promise.then(
    (value) => ({status: 'resolved' as const, value}),
    (error) => ({status: 'rejected' as const, error})
  );
  await vi.advanceTimersByTimeAsync(observation.LIMITS.commandTimeoutMs);
  vi.useRealTimers();
  return Promise.race([
    settled,
    new Promise<{status: 'stalled'}>((resolve) => setTimeout(() => resolve({status: 'stalled'}), 100))
  ]);
}

const READINESS_PINS = Object.freeze({
  runId: 'a'.repeat(32),
  harnessRevision: '5f294c39abb32fc8ae15a4f7ccb085974098b320',
  serverRevision: '47daaaea5c71b859d9865c03cabb50da5a1a013b',
  webRevision: 'b7523e39f5365f50ab6ecd7aa1fb4c79eedf08d8'
});

function buildServerReady(): any {
  const runId = READINESS_PINS.runId;
  const mtprotoPublicKeyPEM = generateKeyPairSync('rsa', {modulusLength: 2048}).publicKey.export({type: 'spki', format: 'pem'}).trimEnd();
  return {
    event: 'server-ready',
    status: 'ready',
    ...READINESS_PINS,
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
}

function buildArtifactReady(serverReady: any): any {
  return {
    event: 'artifact-ready',
    status: 'ready',
    ...READINESS_PINS,
    endpoint: serverReady.endpoint,
    wssEndpoint: serverReady.wssEndpoint,
    fingerprint: serverReady.fingerprint,
    artifactDigest: `sha256:${'c'.repeat(64)}`,
    manifestArtifactDigest: `sha256:${'f'.repeat(64)}`,
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
}

function pageTarget(targetId: string = 'page-target', browserContextId: string = 'context-app') {
  return {targetId, type: 'page', url: `${APP_ORIGIN}/`, browserContextId};
}

function sharedWorker(targetId: string, url: string, browserContextId: string = 'context-app') {
  return {targetId, type: 'shared_worker', url, browserContextId};
}

function networkRequestWillBeSent(requestId: string, url: string) {
  return {
    requestId,
    loaderId: 'loader-1',
    documentURL: APP_ORIGIN,
    request: {
      url,
      method: 'GET',
      headers: {},
      initialPriority: 'High',
      referrerPolicy: 'no-referrer-when-downgrade'
    },
    timestamp: 1,
    wallTime: 1,
    initiator: {type: 'script'},
    type: 'Script'
  };
}

function networkLoadingFailed(requestId: string) {
  return {
    requestId,
    timestamp: 2,
    type: 'Script',
    errorText: 'net::ERR_INTERNET_DISCONNECTED'
  };
}

function replayContext(events: any[], options: any = {}) {
  const observer = observation.createContextObserver('alice');
  observer.state.discoveryActive = options.discoveryActive !== false;
  observer.state.pageCoverageComplete = options.pageCoverage !== false;
  for(const event of events) {
    if(event.kind === 'target') observer.registerTarget(event.target);
    if(event.kind === 'attach') observer.noteAttached(event.targetId);
    if(event.kind === 'setup') observer.noteSetupComplete(event.targetId);
    if(event.kind === 'destroy') observer.noteDestroyed(event.targetId);
    if(event.kind === 'attachFailure') observer.noteAttachFailure();
    if(event.kind === 'detachBeforeSetup') observer.noteDetachBeforeSetup();
    if(event.kind === 'fault') observer.noteInjectedControlFault(event.fault);
    if(event.kind === 'page') observer.notePageEvent(event.method, event.params);
    if(event.kind === 'worker') observer.noteWorkerEvent(event.targetId, event.method, event.params);
  }
  observer.state.windowElapsed = options.windowElapsed !== false;
  return observer.summary();
}

function appContextEvents(): any[] {
  return [
    {kind: 'target', target: pageTarget()},
    {kind: 'page', method: 'Network.requestWillBeSent', params: networkRequestWillBeSent('mtproto-source', MTPROTO_CHUNK_URL)},
    {kind: 'page', method: 'Network.responseReceived', params: {type: 'Script', response: {url: MTPROTO_CHUNK_URL, status: 200, headers: {authorization: HOSTILE.token}}}},
    {kind: 'target', target: sharedWorker('mtproto-worker', HOSTILE.blobUrl)},
    {kind: 'attach', targetId: 'mtproto-worker'},
    {kind: 'setup', targetId: 'mtproto-worker'}
  ];
}

function expectNoHostileLeak(summary: any) {
  const serialized = JSON.stringify(summary);
  expect(serialized).not.toContain(HOSTILE.username);
  expect(serialized).not.toContain(HOSTILE.password);
  expect(serialized).not.toContain(HOSTILE.token);
  expect(serialized).not.toContain(HOSTILE.phrase);
  expect(serialized).not.toContain(HOSTILE.frame);
  expect(serialized).not.toContain('unannounced');
  expect(serialized).not.toContain('blob:');
  expect(serialized).not.toContain('telegramd.test');
  expect(serialized).not.toContain('AbCdEfGh');
  expect(serialized).not.toMatch(/https?:/);
  expect(serialized).not.toMatch(/wss?:/);
}

function overBudgetAttachEvents(): any[] {
  const events: any[] = [];
  for(let index = 0; index < observation.LIMITS.attachedTargets + 4; index++) {
    events.push({kind: 'target', target: sharedWorker(`budget-worker-${index}`, HOSTILE.blobUrl, 'context-c5')});
    events.push({kind: 'attach', targetId: `budget-worker-${index}`});
  }
  return events;
}

function controlBlocks(): Record<string, any> {
  return {
    c1_shared_worker_created: {
      ...replayContext([
        {kind: 'target', target: pageTarget('page-c1', 'context-c1')},
        {kind: 'target', target: sharedWorker('probe-worker', PROBE_WORKER_URL, 'context-c1')},
        {kind: 'attach', targetId: 'probe-worker'},
        {kind: 'setup', targetId: 'probe-worker'}
      ]),
      expected: 'pass'
    },
    c2_missing_module_script: {
      ...replayContext([
        {kind: 'target', target: pageTarget('page-c2', 'context-c2')},
        {kind: 'target', target: sharedWorker('missing-worker', PROBE_MISSING_URL, 'context-c2')},
        {kind: 'page', method: 'Log.entryAdded', params: {entry: {source: 'worker', level: 'error', text: 'Failed to fetch a worker script.', url: `${APP_ORIGIN}/`}}},
        {kind: 'attach', targetId: 'missing-worker'},
        {kind: 'destroy', targetId: 'missing-worker'}
      ]),
      expected: 'pass'
    },
    c3_no_construction: {...replayContext([{kind: 'target', target: pageTarget('page-c3', 'context-c3')}]), expected: 'pass'},
    c4_attach_failure: {
      ...replayContext([
        {kind: 'target', target: pageTarget('page-c4a', 'context-c4a')},
        {kind: 'attachFailure'}
      ]),
      expected: 'pass'
    },
    c4_overflow: {
      ...replayContext([
        {kind: 'target', target: pageTarget('page-c4b', 'context-c4b')},
        {kind: 'fault', fault: 'overflow'}
      ]),
      expected: 'pass'
    },
    c5_attach_budget: {
      ...replayContext([
        {kind: 'target', target: pageTarget('page-c5', 'context-c5')},
        ...overBudgetAttachEvents(),
        {kind: 'fault', fault: 'overflow'}
      ]),
      expected: 'pass'
    }
  };
}

function observationBlock(): any {
  const appSummary = replayContext(appContextEvents());
  return {
    unexpectedAttempts: 0,
    observerErrors: 0,
    foreignTargets: 0,
    contextlessTargets: 0,
    appContextlessTargets: 0,
    discoveryActive: 1,
    attachedTargets: 2,
    observerOverflow: 0,
    countedEvents: appSummary.countedEvents * 2,
    contexts: {alice: appSummary, bob: replayContext(appContextEvents())},
    controls: controlBlocks()
  };
}

function authProgressObservationBlock(): any {
  const block = observationBlock();
  delete block.contexts.bob;
  return block;
}

function createAuthProgressNetworkObserver(contextObserver: any, onStop: () => void = () => {}) {
  const {cdp, networkObserver} = createNetworkObserverHarness(contextObserver, {
    send: async(method: string, params: any) => {
      if(method === 'Target.sendMessageToTarget') {
        const {id} = JSON.parse(params.message);
        queueMicrotask(() => cdp.emit('Target.receivedMessageFromTarget', {
          sessionId: params.sessionId,
          message: JSON.stringify({id, result: {}})
        }));
      }
      return method === 'Target.getTargetInfo' ? {targetInfo: {browserContextId: 'contract-test'}} : {};
    }
  });
  return {
    async start(registry: any = undefined) {
      await networkObserver.start(registry);
      contextObserver.state.discoveryActive = true;
      contextObserver.state.pageCoverageComplete = true;
      contextObserver.registerTarget({targetId: 'alice-page', type: 'page'});
      cdp.emit('Target.attachedToTarget', {
        sessionId: 'service-worker-session',
        targetInfo: {targetId: 'service-worker-target', type: 'service_worker', url: `${APP_ORIGIN}/service-worker.js`}
      });
      cdp.emit('Target.attachedToTarget', {
        sessionId: 'shared-worker-session',
        targetInfo: {targetId: 'shared-worker-target', type: 'shared_worker', url: PROBE_WORKER_URL}
      });
      await networkObserver.waitForSetup();
      cdp.emit('Target.receivedMessageFromTarget', {
        sessionId: 'service-worker-session',
        message: JSON.stringify({
          method: 'Network.requestWillBeSent',
          params: {type: 'WebSocket', request: {url: 'wss://telegramd.test/apiws'}}
        })
      });
    },
    async waitForSetup() {
      await networkObserver.waitForSetup();
    },
    async stop() {
      onStop();
      await networkObserver.stop();
    },
    summary() {
      return networkObserver.summary();
    }
  };
}

async function authProgressNetwork(): Promise<any> {
  const contextObserver = observation.createContextObserver('auth-progress-network', {observeWebSocket101: true});
  const networkObserver = createAuthProgressNetworkObserver(contextObserver);
  await networkObserver.start();
  try {
    const summary = networkObserver.summary();
    return {
      unexpectedAttempts: summary.unexpectedAttempts,
      observerErrors: summary.observerErrors,
      contexts: {
        alice: {
          workerTargets: summary.workerTargets,
          allowedWebSockets: summary.allowedWebSockets,
          attemptsBySource: summary.attemptsBySource,
          unexpectedAttemptsBySource: summary.unexpectedAttemptsBySource,
          allowedWebSocketsBySource: summary.allowedWebSocketsBySource
        }
      },
      websocket_101_by_context_phase: contextObserver.webSocket101ByContextPhase()
    };
  } finally {
    await networkObserver.stop();
  }
}

describe('confined runner shared-worker observation contract', () => {
  it('reports a fetched allowlisted source with one same-origin blob worker as a candidate', () => {
    const summary = replayContext(appContextEvents());

    expect(summary.mtprotoSourceChunk).toBe('mtproto_worker');
    expect(summary.mtprotoSourceFetch).toBe('ok');
    expect(summary.mtprotoWorker).toBe('mtproto_candidate');
    expect(summary.sharedWorkerState).toBe('created');
    expect(summary.blobSharedWorkerTargets).toBe(1);
    expect(summary.workerFailure).toBe('no_failure_observed');
    expect(summary.workerFailureValidation).toBe('validated');
    expect(summary.coverageComplete).toBe(1);
    expect(summary.workerSourceChunks).toEqual(['blob_same_origin', 'mtproto_worker']);
    expectNoHostileLeak(summary);
  });

  it('reports two same-origin blob workers as ambiguous, never as one candidate', () => {
    const summary = replayContext([
      ...appContextEvents(),
      {kind: 'target', target: sharedWorker('second-worker', 'blob:https://telegramd.test/11111111-2222-3333-4444-555555555555')},
      {kind: 'attach', targetId: 'second-worker'},
      {kind: 'setup', targetId: 'second-worker'}
    ]);

    expect(summary.mtprotoWorker).toBe('ambiguous');
    expect(summary.blobSharedWorkerTargets).toBe(2);
    expectNoHostileLeak(summary);
  });

  it('reports absence only with complete discovery coverage, and unknown without it', () => {
    const absentEvents = [
      {kind: 'target', target: pageTarget()},
      {kind: 'page', method: 'Network.requestWillBeSent', params: {type: 'Script', request: {url: MTPROTO_CHUNK_URL}}},
      {kind: 'page', method: 'Network.responseReceived', params: {type: 'Script', response: {url: MTPROTO_CHUNK_URL, status: 200}}}
    ];

    expect(replayContext(absentEvents).mtprotoWorker).toBe('absent');
    expect(replayContext(absentEvents, {discoveryActive: false}).mtprotoWorker).toBe('unknown');
    expect(replayContext(absentEvents, {discoveryActive: false}).coverageComplete).toBe(0);
    expect(replayContext(absentEvents, {pageCoverage: false}).sharedWorkerState).toBe('unknown');
    expect(replayContext(absentEvents, {windowElapsed: false}).mtprotoWorker).toBe('unknown');
    expect(replayContext([{kind: 'target', target: pageTarget()}]).mtprotoWorker).toBe('unknown');
  });

  it('classifies the source fetch status from page coverage alone', () => {
    const requestId = 'mtproto-source-request';
    const statusOf = (response: any) => replayContext([
      {kind: 'target', target: pageTarget()},
      {kind: 'page', method: 'Network.requestWillBeSent', params: networkRequestWillBeSent(requestId, MTPROTO_CHUNK_URL)},
      response
    ]).mtprotoSourceFetch;

    expect(statusOf({kind: 'page', method: 'Network.responseReceived', params: {type: 'Script', response: {url: MTPROTO_CHUNK_URL, status: 200}}})).toBe('ok');
    expect(statusOf({kind: 'page', method: 'Network.responseReceived', params: {type: 'Script', response: {url: MTPROTO_CHUNK_URL, status: 404}}})).toBe('http_4xx');
    expect(statusOf({kind: 'page', method: 'Network.responseReceived', params: {type: 'Script', response: {url: MTPROTO_CHUNK_URL, status: 503}}})).toBe('http_5xx');
    expect(statusOf({kind: 'page', method: 'Network.loadingFailed', params: networkLoadingFailed(requestId)})).toBe('failed');
    expect(replayContext([{kind: 'target', target: pageTarget()}]).mtprotoSourceFetch).toBe('not_requested');

    expect(replayContext([
      {kind: 'target', target: pageTarget()},
      {kind: 'page', method: 'Network.requestWillBeSent', params: networkRequestWillBeSent(requestId, MTPROTO_CHUNK_URL)},
      {kind: 'page', method: 'Network.responseReceived', params: {type: 'Script', response: {url: MTPROTO_CHUNK_URL, status: 200}}},
      {kind: 'page', method: 'Network.loadingFailed', params: networkLoadingFailed(requestId)}
    ]).mtprotoSourceFetch).toBe('failed');
  });

  it('never reads a worker destroyed before attach as loaded', () => {
    const summary = replayContext([
      {kind: 'target', target: pageTarget()},
      {kind: 'target', target: sharedWorker('dying-worker', HOSTILE.blobUrl)},
      {kind: 'attach', targetId: 'dying-worker'},
      {kind: 'destroy', targetId: 'dying-worker'}
    ]);

    expect(summary.workerFailure).toBe('destroyed_before_attach');
    expect(summary.workerFailureValidation).toBe('validated');
    expect(summary.sharedWorkerState).toBe('created');
    expectNoHostileLeak(summary);
  });

  it('classifies the missing-script control as a validated page-side script load failure', () => {
    const summary = replayContext([
      {kind: 'target', target: pageTarget('page-c2', 'context-c2')},
      {kind: 'target', target: sharedWorker('missing-worker', PROBE_MISSING_URL, 'context-c2')},
      {kind: 'page', method: 'Log.entryAdded', params: {entry: {source: 'worker', level: 'error', text: 'Failed to fetch a worker script.', url: `${APP_ORIGIN}/`}}}
    ]);

    expect(summary.workerFailure).toBe('script_load_failed');
    expect(summary.workerFailureValidation).toBe('validated');
    expect(summary.workerSourceChunks).toEqual(['probe_missing_script']);
    expectNoHostileLeak(summary);
  });

  it('marks module resolve, module fetch and evaluation categories unvalidated', () => {
    const moduleResolve = replayContext([
      {kind: 'target', target: pageTarget()},
      {kind: 'target', target: sharedWorker('blob-worker', HOSTILE.blobUrl)},
      {kind: 'attach', targetId: 'blob-worker'},
      {kind: 'setup', targetId: 'blob-worker'},
      {kind: 'worker', targetId: 'blob-worker', method: 'Log.entryAdded', params: {entry: {source: 'rendering', level: 'error', text: `Failed to resolve module specifier "./${HOSTILE.password}.js"`, url: HOSTILE.blobUrl}}}
    ]);
    const moduleFetch = replayContext([
      {kind: 'target', target: pageTarget()},
      {kind: 'target', target: sharedWorker('blob-worker', HOSTILE.blobUrl)},
      {kind: 'attach', targetId: 'blob-worker'},
      {kind: 'setup', targetId: 'blob-worker'},
      {kind: 'worker', targetId: 'blob-worker', method: 'Network.loadingFailed', params: {requestId: 'worker-script-request', timestamp: 2, type: 'Script', errorText: 'net::ERR_NAME_NOT_RESOLVED'}}
    ]);
    const evaluation = replayContext([
      {kind: 'target', target: pageTarget()},
      {kind: 'target', target: sharedWorker('blob-worker', HOSTILE.blobUrl)},
      {kind: 'attach', targetId: 'blob-worker'},
      {kind: 'setup', targetId: 'blob-worker'},
      {kind: 'worker', targetId: 'blob-worker', method: 'Runtime.exceptionThrown', params: {exceptionDetails: {text: 'Uncaught', exception: {className: 'Error', description: HOSTILE.frame}, stackTrace: {callFrames: [{url: HOSTILE.url}]}}}}
    ]);

    expect(moduleResolve.workerFailure).toBe('module_resolve_failed');
    expect(moduleResolve.workerFailureValidation).toBe('unvalidated');
    expect(moduleFetch.workerFailure).toBe('module_fetch_failed');
    expect(moduleFetch.workerFailureValidation).toBe('unvalidated');
    expect(evaluation.workerFailure).toBe('evaluation_exception');
    expect(evaluation.workerFailureValidation).toBe('unvalidated');
    expectNoHostileLeak(moduleResolve);
    expectNoHostileLeak(moduleFetch);
    expectNoHostileLeak(evaluation);
  });

  it('classifies a blob script-load log as a module fetch, not a script load', () => {
    const summary = replayContext([
      {kind: 'target', target: pageTarget()},
      {kind: 'target', target: sharedWorker('blob-worker', HOSTILE.blobUrl)},
      {kind: 'attach', targetId: 'blob-worker'},
      {kind: 'setup', targetId: 'blob-worker'},
      {kind: 'page', method: 'Log.entryAdded', params: {entry: {source: 'worker', level: 'error', text: 'Failed to fetch a worker script.', url: HOSTILE.blobUrl}}}
    ]);

    expect(summary.workerFailure).toBe('module_fetch_failed');
    expect(summary.workerFailureValidation).toBe('unvalidated');
    expectNoHostileLeak(summary);
  });

  it('drops console arguments, CSP blocked URLs and stack frames without retaining them', () => {
    const summary = replayContext([
      {kind: 'target', target: pageTarget()},
      {kind: 'target', target: sharedWorker('blob-worker', HOSTILE.blobUrl)},
      {kind: 'attach', targetId: 'blob-worker'},
      {kind: 'setup', targetId: 'blob-worker'},
      {kind: 'worker', targetId: 'blob-worker', method: 'Runtime.consoleAPICalled', params: {type: 'log', args: [{type: 'string', value: HOSTILE.phrase}, {type: 'object', description: `{password: '${HOSTILE.password}'`}, {type: 'string', value: HOSTILE.url}], stackTrace: {callFrames: [{url: HOSTILE.frame}]}}},
      {kind: 'worker', targetId: 'blob-worker', method: 'Audits.issueAdded', params: {issue: {details: {contentSecurityPolicyIssueDetails: {blockedURL: HOSTILE.url, blockedType: 'worker-src-violation', isReportOnly: false}}}}},
      {kind: 'worker', targetId: 'blob-worker', method: 'Runtime.executionContextCreated', params: {context: {id: 1, origin: HOSTILE.blobUrl, name: HOSTILE.username}}}
    ]);

    expect(summary.workerFailure).toBe('csp_blocked');
    expect(summary.workerFailureValidation).toBe('validated');
    expectNoHostileLeak(summary);
  });

  it('counts each page network request once', async() => {
    const contextObserver = observation.createContextObserver('single-page-request');
    const {cdp, networkObserver} = createNetworkObserverHarness(contextObserver);
    await networkObserver.start();

    try {
      cdp.emit('Network.requestWillBeSent', networkRequestWillBeSent('page-request', MTPROTO_CHUNK_URL));

      expect(contextObserver.summary().countedEvents).toBe(1);
      expect(networkObserver.events).toHaveLength(1);
    } finally {
      await networkObserver.stop();
    }
  });

  it('populates all websocket 101 context and submission phase cells', () => {
    const phase = observation.createWebSocket101Phase();
    const alice = observation.createContextObserver('alice', {observeWebSocket101: true, webSocket101Phase: phase});
    const control = observation.createContextObserver('c1_shared_worker_created', {control: true, observeWebSocket101: true, webSocket101Phase: phase});
    const other = observation.createContextObserver('bob', {observeWebSocket101: true, webSocket101Phase: phase});

    emitContextWebSocket101(alice, 'alice-page', 'alice-session', 'alice-pre');
    emitContextWebSocket101(control, 'control-page', 'control-session', 'control-pre');
    emitContextWebSocket101(other, 'other-page', 'other-session', 'other-pre');

    alice.beginUsernameSubmission();
    emitContextWebSocket101(alice, 'alice-page', 'alice-session', 'alice-during');
    emitContextWebSocket101(control, 'control-page', 'control-session', 'control-during');
    emitContextWebSocket101(other, 'other-page', 'other-session', 'other-during');

    alice.completeUsernameSubmission();
    emitContextWebSocket101(alice, 'alice-page', 'alice-session', 'alice-post');
    emitContextWebSocket101(control, 'control-page', 'control-session', 'control-post');
    emitContextWebSocket101(other, 'other-page', 'other-session', 'other-post');

    expect(alice.webSocket101ByContextPhase()).toEqual({
      alice: {pre_submit: 1, post_submit: 1, unknown: 1},
      control: {pre_submit: 0, post_submit: 0, unknown: 0},
      other: {pre_submit: 0, post_submit: 0, unknown: 0}
    });
    expect(control.webSocket101ByContextPhase()).toEqual({
      alice: {pre_submit: 0, post_submit: 0, unknown: 0},
      control: {pre_submit: 1, post_submit: 1, unknown: 1},
      other: {pre_submit: 0, post_submit: 0, unknown: 0}
    });
    expect(other.webSocket101ByContextPhase()).toEqual({
      alice: {pre_submit: 0, post_submit: 0, unknown: 0},
      control: {pre_submit: 0, post_submit: 0, unknown: 0},
      other: {pre_submit: 1, post_submit: 1, unknown: 1}
    });
  });

  it.each([
    {creationPhase: 'pre_submit', expectedAlice: {pre_submit: 1, post_submit: 0, unknown: 0}},
    {creationPhase: 'during_submit', expectedAlice: {pre_submit: 0, post_submit: 0, unknown: 1}}
  ])('attributes a delayed 101 to the $creationPhase creation phase', ({creationPhase, expectedAlice}) => {
    const observer = observation.createContextObserver('alice', {observeWebSocket101: true});
    if(creationPhase === 'during_submit') observer.beginUsernameSubmission();
    observer.notePageEvent('Network.webSocketCreated', {requestId: 'delayed-socket'});
    if(creationPhase === 'pre_submit') observer.beginUsernameSubmission();
    observer.completeUsernameSubmission();
    observer.notePageEvent('Network.webSocketHandshakeResponseReceived', {
      requestId: 'delayed-socket',
      response: {status: 101}
    });

    expect(observer.webSocket101ByContextPhase()).toEqual({
      alice: expectedAlice,
      control: {pre_submit: 0, post_submit: 0, unknown: 0},
      other: {pre_submit: 0, post_submit: 0, unknown: 0}
    });
  });

  it('counts only numeric 101 once and treats missing or session-mismatched creation as unknown', () => {
    const observer = observation.createContextObserver('alice', {observeWebSocket101: true});
    observer.notePageEvent('Network.webSocketCreated', {requestId: 'page-socket'});
    observer.notePageEvent('Network.webSocketHandshakeResponseReceived', {requestId: 'page-socket', response: {status: 101}});
    observer.notePageEvent('Network.webSocketHandshakeResponseReceived', {requestId: 'page-socket', response: {status: 101}});
    observer.notePageEvent('Network.webSocketHandshakeResponseReceived', {requestId: 'not-created', response: {status: 101}});
    observer.notePageEvent('Network.webSocketHandshakeResponseReceived', {requestId: 'not-created', response: {status: 101}});
    observer.notePageEvent('Network.webSocketHandshakeResponseReceived', {requestId: 'not-upgraded', response: {status: 200}});
    observer.notePageEvent('Network.webSocketHandshakeResponseReceived', {requestId: 'string-status', response: {status: '101'}});
    observer.notePageEvent('Network.webSocketCreated', {requestId: 'session-local'});
    observer.noteWorkerEvent('worker-target', 'Network.webSocketHandshakeResponseReceived', {
      requestId: 'session-local',
      response: {status: 101}
    }, 'different-session');

    expect(observer.webSocket101ByContextPhase()).toEqual({
      alice: {pre_submit: 1, post_submit: 0, unknown: 2},
      control: {pre_submit: 0, post_submit: 0, unknown: 0},
      other: {pre_submit: 0, post_submit: 0, unknown: 0}
    });
  });

  it('preserves upgrade counts after an observer overflow closes coverage', () => {
    const observer = observation.createContextObserver('alice', {observeWebSocket101: true});
    emitContextWebSocket101(observer, 'alice-page', 'alice-session', 'observed-before-overflow');
    const beforeOverflow = observer.webSocket101ByContextPhase();
    for(let index = observer.eventCount(); index < observation.LIMITS.countedEventsPerContext; index++) observer.noteEvent();
    observer.notePageEvent('Network.webSocketHandshakeResponseReceived', {requestId: 'after-overflow', response: {status: 101}});

    expect(observer.summary().observerOverflow).toBe(1);
    expect(observer.webSocket101ByContextPhase()).toEqual(beforeOverflow);
  });

  it('reads 101s from the existing page CDP session without retaining handshake data', async() => {
    const observer = observation.createContextObserver('alice', {observeWebSocket101: true});
    const {cdp, networkObserver} = createNetworkObserverHarness(observer);
    await networkObserver.start();

    try {
      cdp.emit('Network.webSocketCreated', {requestId: 'page-socket', url: 'wss://telegramd.test/apiws'});
      cdp.emit('Network.webSocketHandshakeResponseReceived', {
        requestId: 'page-socket',
        response: {
          status: 101,
          url: HOSTILE.url,
          headers: {cookie: HOSTILE.password},
          headersText: HOSTILE.token,
          timestamp: 12345
        }
      });

      expect(observer.webSocket101ByContextPhase()).toEqual({
        alice: {pre_submit: 1, post_submit: 0, unknown: 0},
        control: {pre_submit: 0, post_submit: 0, unknown: 0},
        other: {pre_submit: 0, post_submit: 0, unknown: 0}
      });
      const output = JSON.stringify({events: networkObserver.events, summary: networkObserver.summary(), upgrades: observer.webSocket101ByContextPhase()});
      expect(output).not.toContain(HOSTILE.url);
      expect(output).not.toContain(HOSTILE.password);
      expect(output).not.toContain(HOSTILE.token);
    } finally {
      await networkObserver.stop();
    }
  });

  it('reads 101s from an existing page auto-attach worker session without retaining handshake data', async() => {
    const observer = observation.createContextObserver('alice', {observeWebSocket101: true});
    const cdp: any = new EventEmitter();
    cdp.send = async(method: string, params: any) => {
      if(method === 'Target.sendMessageToTarget') {
        const {id} = JSON.parse(params.message);
        queueMicrotask(() => cdp.emit('Target.receivedMessageFromTarget', {
          sessionId: params.sessionId,
          message: JSON.stringify({id, result: {}})
        }));
      }
      return method === 'Target.getTargetInfo' ? {targetInfo: {browserContextId: 'alice-context'}} : {};
    };
    cdp.detach = async() => {};
    const context = {newCDPSession: async() => cdp, close: async() => {}};
    const page: any = {context: () => context};
    const networkObserver = createNetworkObserver(page, 'contract-test', observer);
    await networkObserver.start();

    try {
      cdp.emit('Target.attachedToTarget', {
        sessionId: 'service-worker-session',
        targetInfo: {targetId: 'service-worker-target', type: 'service_worker', url: `${APP_ORIGIN}/sw-test.js`}
      });
      await networkObserver.waitForSetup();
      const emitWorkerEvent = (method: string, params: any) => cdp.emit('Target.receivedMessageFromTarget', {
        sessionId: 'service-worker-session',
        message: JSON.stringify({method, params})
      });
      emitWorkerEvent('Network.webSocketCreated', {requestId: 'service-socket', url: 'wss://telegramd.test/apiws'});
      emitWorkerEvent('Network.webSocketHandshakeResponseReceived', {
        requestId: 'service-socket',
        response: {
          status: 101,
          url: HOSTILE.url,
          headers: {cookie: HOSTILE.password, 'x-secret': HOSTILE.token},
          headersText: HOSTILE.phrase,
          timestamp: 12345
        }
      });

      expect(observer.webSocket101ByContextPhase()).toEqual({
        alice: {pre_submit: 1, post_submit: 0, unknown: 0},
        control: {pre_submit: 0, post_submit: 0, unknown: 0},
        other: {pre_submit: 0, post_submit: 0, unknown: 0}
      });
      const output = JSON.stringify({events: networkObserver.events, summary: networkObserver.summary(), upgrades: observer.webSocket101ByContextPhase()});
      expect(output).not.toContain(HOSTILE.url);
      expect(output).not.toContain(HOSTILE.password);
      expect(output).not.toContain(HOSTILE.token);
      expect(output).not.toContain(HOSTILE.phrase);
    } finally {
      await networkObserver.stop();
    }
  });

  it('reads 101s from the existing discovery-attached shared-worker session', async() => {
    const observer = observation.createContextObserver('alice', {observeWebSocket101: true});
    const session: any = new EventEmitter();
    session.send = async(method: string, params: any) => {
      if(method === 'Target.attachToTarget') return {sessionId: 'shared-worker-session'};
      if(method === 'Target.sendMessageToTarget') {
        const {id} = JSON.parse(params.message);
        queueMicrotask(() => session.emit('Target.receivedMessageFromTarget', {
          sessionId: params.sessionId,
          message: JSON.stringify({id, result: {}})
        }));
      }
      return {};
    };
    const browser: any = {newBrowserCDPSession: async() => session};
    const registry = createWorkerDiscovery();
    await registry.launch(browser);
    registry.registerContext('alice-context', observer);

    try {
      session.emit('Target.targetCreated', {
        targetInfo: {targetId: 'shared-worker-target', type: 'shared_worker', url: PROBE_WORKER_URL, browserContextId: 'alice-context'}
      });
      await registry.waitForSetup();
      const emitWorkerEvent = (method: string, params: any) => session.emit('Target.receivedMessageFromTarget', {
        sessionId: 'shared-worker-session',
        message: JSON.stringify({method, params})
      });
      emitWorkerEvent('Network.webSocketCreated', {requestId: 'shared-socket', url: 'wss://telegramd.test/apiws'});
      emitWorkerEvent('Network.webSocketHandshakeResponseReceived', {
        requestId: 'shared-socket',
        response: {status: 101, url: HOSTILE.url, headers: {cookie: HOSTILE.password}, headersText: HOSTILE.token}
      });

      expect(observer.webSocket101ByContextPhase()).toEqual({
        alice: {pre_submit: 1, post_submit: 0, unknown: 0},
        control: {pre_submit: 0, post_submit: 0, unknown: 0},
        other: {pre_submit: 0, post_submit: 0, unknown: 0}
      });
      expect(JSON.stringify(observer.webSocket101ByContextPhase())).not.toContain(HOSTILE.url);
    } finally {
      await registry.stop();
    }
  });

  it('keeps paired-only websocket cells out of normal observer summaries', async() => {
    const observer = observation.createContextObserver('normal-mode');
    const {cdp, networkObserver} = createNetworkObserverHarness(observer);
    await networkObserver.start();

    try {
      cdp.emit('Network.webSocketHandshakeResponseReceived', {requestId: 'normal-socket', response: {status: 101}});

      expect(observer.summary()).not.toHaveProperty('websocket_101_by_context_phase');
      expect(networkObserver.summary()).not.toHaveProperty('websocket_101_by_context_phase');
    } finally {
      await networkObserver.stop();
    }
  });

  it('makes the context unknown and records overflow on every resource bound', async() => {
    const attachEvents: any[] = [{kind: 'target', target: pageTarget()}];
    for(let index = 0; index < observation.LIMITS.attachedTargets + 4; index++) {
      attachEvents.push({kind: 'target', target: sharedWorker(`worker-${index}`, HOSTILE.blobUrl)});
      attachEvents.push({kind: 'attach', targetId: `worker-${index}`});
    }
    const attachOverflow = replayContext(attachEvents);

    const floodEvents: any[] = [{kind: 'target', target: pageTarget()}];
    for(let index = 0; index < observation.LIMITS.countedEventsPerContext + 20; index++) {
      floodEvents.push({kind: 'page', method: 'Network.webSocketCreated', params: {url: HOSTILE.url}});
    }
    const eventOverflow = replayContext(floodEvents);

    expect(attachOverflow.attachedTargets).toBe(observation.LIMITS.attachedTargets);
    expect(attachOverflow.observerOverflow).toBe(1);
    expect(attachOverflow.coverageComplete).toBe(0);
    expect(attachOverflow.sharedWorkerState).toBe('unknown');
    expect(eventOverflow.observerOverflow).toBe(1);
    expect(eventOverflow.countedEvents).toBe(observation.LIMITS.countedEventsPerContext);
    expect(eventOverflow.mtprotoWorker).toBe('unknown');

    const networkContextObserver = observation.createContextObserver('network-overflow');
    const {cdp, networkObserver} = createNetworkObserverHarness(networkContextObserver);
    await networkObserver.start();
    let requestIndex = 0;
    const emitWebSocketRequest = () => {
      cdp.emit('Network.requestWillBeSent', {
        type: 'WebSocket',
        request: {url: `wss://unannounced.invalid/apiws?request=${requestIndex++}`}
      });
    };
    for(let index = 0; index <= observation.LIMITS.countedEventsPerContext && networkContextObserver.summary().observerOverflow === 0; index++) {
      emitWebSocketRequest();
    }
    expect(networkContextObserver.summary().observerOverflow).toBe(1);
    const eventsAtOverflow = networkObserver.events.length;
    for(let index = 0; index < 20; index++) emitWebSocketRequest();
    expect(networkContextObserver.summary().countedEvents).toBe(observation.LIMITS.countedEventsPerContext);
    expect(networkObserver.events).toHaveLength(eventsAtOverflow);
    await networkObserver.stop();

    const {browser, registry, session} = createDiscoveryHarness();
    await registry.launch(browser);
    const discoveryObserver = observation.createContextObserver('discovery-overflow');
    registry.registerContext('context-overflow', discoveryObserver);
    const emitPageTarget = (index: number) => session.emit('Target.targetCreated', {
      targetInfo: {targetId: `page-${index}`, type: 'page', url: `${APP_ORIGIN}/`, browserContextId: 'context-overflow'}
    });
    for(let index = 0; index <= observation.LIMITS.countedEventsPerContext && discoveryObserver.summary().observerOverflow === 0; index++) {
      emitPageTarget(index);
    }
    const targetsAtOverflow = registry.ownedTargetCount;
    for(let index = 0; index < 20; index++) emitPageTarget(observation.LIMITS.countedEventsPerContext + index + 1);
    expect(discoveryObserver.summary().observerOverflow).toBe(1);
    expect(targetsAtOverflow).toBeLessThanOrEqual(observation.LIMITS.countedEventsPerContext);
    expect(registry.ownedTargetCount).toBe(targetsAtOverflow);
    await registry.stop();
  });

  it('does not retain page-session targets rejected after observer overflow', async() => {
    const contextObserver = observation.createContextObserver('page-session-overflow');
    const {cdp, networkObserver} = createNetworkObserverHarness(contextObserver);
    await networkObserver.start();
    for(let index = 0; index < observation.LIMITS.countedEventsPerContext - 1; index++) contextObserver.noteEvent();

    const emitAttachedWorker = (index: number) => cdp.emit('Target.attachedToTarget', {
      sessionId: `session-${index}`,
      targetInfo: sharedWorker(`worker-${index}`, HOSTILE.blobUrl)
    });
    emitAttachedWorker(0);
    for(let index = 1; index < 25; index++) emitAttachedWorker(index);
    await networkObserver.waitForSetup();

    expect(contextObserver.summary().observerOverflow).toBe(1);
    expect(networkObserver.summary().workerTargets.shared_worker).toBe(0);
    await networkObserver.stop();
  });

  it('caps malformed nested-message errors and stops after observer overflow', async() => {
    const contextObserver = observation.createContextObserver('message-overflow');
    const {cdp, networkObserver} = createNetworkObserverHarness(contextObserver);
    await networkObserver.start();
    const oversizedMessage = 'x'.repeat(observation.LIMITS.cdpMessageBytes + 1);
    const emitInvalidMessage = (index: number) => cdp.emit('Target.receivedMessageFromTarget', {
      sessionId: 'untracked-session',
      message: index % 2 === 0 ? '{invalid' : oversizedMessage
    });
    for(let index = 0; index < observation.LIMITS.countedEventsPerContext + 20; index++) emitInvalidMessage(index);

    expect(contextObserver.summary().observerOverflow).toBe(1);
    expect(contextObserver.summary().countedEvents).toBe(observation.LIMITS.countedEventsPerContext);
    expect(networkObserver.errors.length).toBeLessThanOrEqual(2);
    const retainedErrors = networkObserver.errors.length;
    for(let index = 0; index < 20; index++) emitInvalidMessage(index);
    expect(networkObserver.errors).toHaveLength(retainedErrors);
    expect(contextObserver.summary().observerErrors).toBeLessThanOrEqual(observation.LIMITS.countedEventsPerContext + 1);
    await networkObserver.stop();
  });

  it('skips page URL classifiers after observer overflow', async() => {
    const contextObserver = observation.createContextObserver('page-handler-overflow');
    const {cdp, networkObserver} = createNetworkObserverHarness(contextObserver);
    await networkObserver.start();
    contextObserver.noteInjectedControlFault('overflow');

    cdp.emit('Network.requestWillBeSent', {
      type: 'Script',
      request: {get url() {throw new Error('request URL inspected after overflow');}}
    });
    cdp.emit('Network.webSocketCreated', {get url() {throw new Error('websocket URL inspected after overflow');}});
    cdp.emit('Audits.issueAdded', {get issue() {throw new Error('CSP issue inspected after overflow');}});
    cdp.emit('Log.entryAdded', {get entry() {throw new Error('log entry inspected after overflow');}});

    expect(contextObserver.summary().observerOverflow).toBe(1);
    await networkObserver.stop();
  });

  it('disables page auto-attach and bounds overflow target releases', async() => {
    const contextObserver = observation.createContextObserver('page-release-overflow');
    const detachResolvers: Array<() => void> = [];
    let autoAttachDisabled = 0;
    let contextClosed = 0;
    const {cdp, networkObserver} = createNetworkObserverHarness(contextObserver, {
      send: async(method: string, params: any) => {
        if(method === 'Target.setAutoAttach' && params.autoAttach === false) autoAttachDisabled++;
        if(method === 'Target.detachFromTarget') return new Promise<void>((resolve) => detachResolvers.push(resolve));
        return {};
      },
      closeContext: async() => {
        contextClosed++;
        for(const resolve of detachResolvers) resolve();
      }
    });
    await networkObserver.start();
    contextObserver.noteInjectedControlFault('overflow');
    for(let index = 0; index < observation.LIMITS.attachedTargets * 3; index++) {
      cdp.emit('Target.attachedToTarget', {
        sessionId: `overflow-session-${index}`,
        targetInfo: sharedWorker(`overflow-worker-${index}`, HOSTILE.blobUrl)
      });
    }

    const setupPromise = networkObserver.waitForSetup();
    let setupSettled = false;
    setupPromise.then(() => setupSettled = true);
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(autoAttachDisabled).toBe(1);
      expect(detachResolvers.length).toBeLessThanOrEqual(observation.LIMITS.attachedTargets);
      expect(contextClosed).toBe(1);
      expect(setupSettled).toBe(true);
    } finally {
      for(const resolve of detachResolvers) resolve();
      await setupPromise;
      await networkObserver.stop();
    }
  });

  it('rejects cleanup when the page observer session cannot detach', async() => {
    const detachFailure = new Error('observer detach failed');
    const contextObserver = observation.createContextObserver('detach-failure');
    const {networkObserver} = createNetworkObserverHarness(contextObserver, {detach: async() => {throw detachFailure;}});
    await networkObserver.start();

    await expect(networkObserver.stop()).rejects.toBe(detachFailure);
  });

  it('times out a stalled page observer cleanup command', async() => {
    const contextObserver = observation.createContextObserver('stalled-detach');
    const {networkObserver} = createNetworkObserverHarness(contextObserver, {detach: () => new Promise(() => {})});
    await networkObserver.start();

    vi.useFakeTimers();
    const outcome = await settleAfterCdpDeadline(networkObserver.stop());
    expect(outcome).toMatchObject({status: 'rejected', error: {message: 'cdp_command_timeout'}});
  });

  it('times out stalled page and browser discovery setup commands', async() => {
    const contextObserver = observation.createContextObserver('stalled-setup');
    const page = createNetworkObserverHarness(contextObserver, {
      send: async(method: string) => method === 'Network.enable' ? new Promise(() => {}) : method === 'Target.getTargetInfo'
        ? {targetInfo: {browserContextId: 'contract-test'}}
        : {}
    });
    const discovery = createDiscoveryHarness((method: string, params: any) => {
      if(method === 'Target.setDiscoverTargets' && params.discover === true) return new Promise(() => {});
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      const outcome = await settleAfterCdpDeadline(Promise.allSettled([
        page.networkObserver.start(),
        discovery.registry.launch(discovery.browser)
      ]));
      expect(outcome.status).toBe('resolved');
      if(outcome.status === 'resolved') {
        expect(outcome.value.map((result: any) => result.status)).toEqual(['rejected', 'rejected']);
        expect(outcome.value.map((result: any) => result.reason.message)).toEqual(['cdp_command_timeout', 'cdp_command_timeout']);
      }
    } finally {
      vi.useRealTimers();
      await page.networkObserver.stop();
      await discovery.registry.stop();
    }
  });

  it('times out stalled browser discovery cleanup commands', async() => {
    const discovery = createDiscoveryHarness((method: string, params: any) => {
      if(method === 'Target.setDiscoverTargets' && params.discover === false) return new Promise(() => {});
      return Promise.resolve({});
    });
    await discovery.registry.launch(discovery.browser);

    vi.useFakeTimers();
    const outcome = await settleAfterCdpDeadline(discovery.registry.stop());
    expect(outcome).toMatchObject({
      status: 'resolved',
      value: {detachFailures: 0, discoveryDisabled: false}
    });
  });

  it('drains a delayed browser attachment rejection before finalizing observer evidence', async() => {
    let rejectAttach: ((error: Error) => void) | undefined;
    const discovery = createDiscoveryHarness((method: string) => {
      if(method === 'Target.attachToTarget') {
        return new Promise((resolve, reject) => {
          rejectAttach = reject;
        });
      }
      return Promise.resolve({});
    });
    await discovery.registry.launch(discovery.browser);
    const contextObserver = observation.createContextObserver('delayed-attach-rejection');
    discovery.registry.registerContext('context-delayed-rejection', contextObserver);
    discovery.session.emit('Target.targetCreated', {
      targetInfo: sharedWorker('delayed-rejection-worker', HOSTILE.blobUrl, 'context-delayed-rejection')
    });

    const setupPromise = discovery.registry.waitForSetup();
    let setupSettled = false;
    setupPromise.then(() => setupSettled = true);
    await Promise.resolve();

    try {
      expect(setupSettled).toBe(false);
      expect(rejectAttach).toBeTypeOf('function');
    } finally {
      rejectAttach?.(new Error('delayed attach failure'));
      await setupPromise;
      await discovery.registry.stop();
    }

    expect(contextObserver.summary().observerErrors).toBe(1);
    expect(contextObserver.summary().sharedWorkerState).toBe('unknown');
  });

  it('drains a delayed browser attachment success and detaches it during shutdown', async() => {
    let resolveAttach: ((result: {sessionId: string}) => void) | undefined;
    const detachedSessions: string[] = [];
    const discovery = createDiscoveryHarness((method: string, params: any) => {
      if(method === 'Target.attachToTarget') {
        return new Promise((resolve) => {
          resolveAttach = resolve;
        });
      }
      if(method === 'Target.sendMessageToTarget') {
        const {id} = JSON.parse(params.message);
        queueMicrotask(() => discovery.session.emit('Target.receivedMessageFromTarget', {
          sessionId: params.sessionId,
          message: JSON.stringify({id, result: {}})
        }));
      }
      if(method === 'Target.detachFromTarget') detachedSessions.push(params.sessionId);
      return Promise.resolve({});
    });
    await discovery.registry.launch(discovery.browser);
    const contextObserver = observation.createContextObserver('delayed-attach-success');
    discovery.registry.registerContext('context-delayed-success', contextObserver);
    discovery.session.emit('Target.targetCreated', {
      targetInfo: sharedWorker('delayed-success-worker', HOSTILE.blobUrl, 'context-delayed-success')
    });

    const setupPromise = discovery.registry.waitForSetup();
    const stopPromise = discovery.registry.stop();
    let stopSettled = false;
    stopPromise.then(() => stopSettled = true);
    await Promise.resolve();

    try {
      expect(stopSettled).toBe(false);
      expect(resolveAttach).toBeTypeOf('function');
    } finally {
      resolveAttach?.({sessionId: 'late-browser-session'});
    }
    await Promise.all([setupPromise, stopPromise]);

    expect(detachedSessions).toContain('late-browser-session');
    expect(contextObserver.summary().observerErrors).toBe(0);
  });

  it('stops attributing MTProto to blobs that predate the fetch, are cross-origin, or follow a failed fetch', () => {
    const sourceFetch = {kind: 'page', method: 'Network.responseReceived', params: {type: 'Script', response: {url: MTPROTO_CHUNK_URL, status: 200}}};
    const sourceRequest = {kind: 'page', method: 'Network.requestWillBeSent', params: networkRequestWillBeSent('mtproto-source-request', MTPROTO_CHUNK_URL)};

    const preexistingBlob = replayContext([
      {kind: 'target', target: pageTarget()},
      {kind: 'target', target: sharedWorker('pre-worker', HOSTILE.blobUrl)},
      {kind: 'attach', targetId: 'pre-worker'},
      {kind: 'setup', targetId: 'pre-worker'},
      sourceRequest,
      sourceFetch
    ]);
    expect(preexistingBlob.mtprotoSourceFetch).toBe('ok');
    expect(preexistingBlob.sharedWorkerState).toBe('created');
    expect(preexistingBlob.mtprotoWorker).toBe('unknown');

    const crossOriginBlob = replayContext([
      {kind: 'target', target: pageTarget()},
      sourceRequest,
      sourceFetch,
      {kind: 'target', target: sharedWorker('foreign-worker', 'blob:https://unannounced.invalid/0e4a2c1a-1111-2222-3333-444444444444')}
    ]);
    expect(crossOriginBlob.blobSharedWorkerTargets).toBe(1);
    expect(crossOriginBlob.mtprotoWorker).toBe('unknown');
    expectNoHostileLeak(crossOriginBlob);

    const failedFetch = replayContext([
      {kind: 'target', target: pageTarget()},
      sourceRequest,
      {kind: 'page', method: 'Network.loadingFailed', params: networkLoadingFailed('mtproto-source-request')},
      {kind: 'target', target: sharedWorker('post-failure-worker', HOSTILE.blobUrl)}
    ]);
    expect(failedFetch.mtprotoSourceFetch).toBe('failed');
    expect(failedFetch.mtprotoWorker).toBe('unknown');

    const notFetched = replayContext([
      {kind: 'target', target: pageTarget()},
      sourceRequest,
      {kind: 'target', target: sharedWorker('unattributed-worker', HOSTILE.blobUrl)}
    ]);
    expect(notFetched.mtprotoSourceFetch).toBe('not_requested');
    expect(notFetched.mtprotoWorker).toBe('unknown');

    expect(replayContext(appContextEvents()).mtprotoWorker).toBe('mtproto_candidate');
  });

  it('closes the observer at a resource bound and retains nothing afterwards', () => {
    const observer = observation.createContextObserver('alice');
    observer.state.discoveryActive = true;
    observer.state.pageCoverageComplete = true;
    observer.registerTarget(pageTarget());
    observer.noteInjectedControlFault('overflow');
    observer.notePageEvent('Network.responseReceived', {type: 'Script', response: {url: MTPROTO_CHUNK_URL, status: 200}});
    observer.registerTarget(sharedWorker('late-worker', HOSTILE.blobUrl));
    observer.noteAttached('late-worker');
    observer.noteWorkerEvent('late-worker', 'Runtime.exceptionThrown', {exceptionDetails: {text: 'Uncaught', exception: {className: 'Error', description: HOSTILE.frame}}});
    observer.state.windowElapsed = true;
    const summary = observer.summary();

    expect(summary.observerOverflow).toBe(1);
    expect(summary.countedEvents).toBe(observation.LIMITS.countedEventsPerContext);
    expect(summary.attachedTargets).toBe(0);
    expect(summary.sharedWorkerTargets).toBe(0);
    expect(summary.workerFailure).toBe('no_failure_observed');
    expect(summary.mtprotoSourceChunk).toBe('none');
    expect(summary.coverageComplete).toBe(0);
    expectNoHostileLeak(summary);
  });

  it('refuses attachments past the budget and bounds the counted total', () => {
    const observer = observation.createContextObserver('alice');
    observer.state.discoveryActive = true;
    observer.state.pageCoverageComplete = true;
    observer.registerTarget(pageTarget());
    const accepted: boolean[] = [];
    for(let index = 0; index < observation.LIMITS.attachedTargets + 6; index++) {
      const targetId = `worker-${index}`;
      observer.registerTarget(sharedWorker(targetId, HOSTILE.blobUrl));
      accepted.push(observer.noteAttached(targetId));
    }
    observer.state.windowElapsed = true;
    const summary = observer.summary();

    expect(accepted.filter((value) => value)).toHaveLength(observation.LIMITS.attachedTargets);
    expect(accepted.filter((value) => !value)).toHaveLength(6);
    expect(summary.attachedTargets).toBe(observation.LIMITS.attachedTargets);
    expect(summary.observerOverflow).toBe(1);
    expect(summary.sharedWorkerState).toBe('unknown');
  });

  it('rejects every CDP method outside the accepted scope, including nested sends', () => {
    const forbidden = ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.getProperties', 'Runtime.addBinding',
      'Debugger.enable', 'Debugger.setBreakpoint', 'Fetch.enable', 'Network.setBlockedFrequencies',
      'Page.addScriptToEvaluateOnNewDocument', 'Page.setBypassCSP', 'Page.captureScreenshot',
      'Target.createTarget', 'Target.exposeFunction', 'Network.setRequestInterception'];

    for(const method of forbidden) {
      expect(observation.allowCdpMethod('browser', method)).toBe(false);
      expect(observation.allowCdpMethod('page', method)).toBe(false);
      expect(observation.allowCdpMethod('worker', method)).toBe(false);
    }

    expect(observation.BROWSER_CDP_METHODS).toEqual(['Target.setDiscoverTargets', 'Target.attachToTarget', 'Target.detachFromTarget', 'Target.sendMessageToTarget']);
    expect(observation.PAGE_CDP_METHODS).toEqual(['Network.enable', 'Audits.enable', 'Log.enable', 'Target.setAutoAttach', 'Target.getTargetInfo', 'Target.sendMessageToTarget', 'Target.detachFromTarget']);
    expect(observation.WORKER_CDP_METHODS).toEqual(['Network.enable', 'Audits.enable', 'Log.enable', 'Runtime.enable', 'Runtime.runIfWaitingForDebugger']);
    expect(observation.allowCdpMethod('page', 'Target.getTargetInfo')).toBe(true);
    expect(observation.allowCdpMethod('page', 'Runtime.enable')).toBe(false);
    expect(observation.allowCdpMethod('page', 'Target.setAutoAttach')).toBe(true);
    expect(observation.allowCdpMethod('browser', 'Target.setDiscoverTargets')).toBe(true);
    expect(observation.allowCdpMethod('worker', 'Runtime.enable')).toBe(true);
  });

  it('names chunk sources only as allowlisted logical names without hash or query', () => {
    expect(observation.classifyWorkerSource(MTPROTO_CHUNK_URL).label).toBe('mtproto_worker');
    expect(observation.classifyWorkerSource(`${APP_ORIGIN}/crypto.worker-Zz0yYyXx.js`).label).toBe('crypto_worker');
    expect(observation.classifyWorkerSource(`${APP_ORIGIN}/sw-Zz0yYyXx.js`).label).toBe('service_worker');
    expect(observation.classifyWorkerSource(`${APP_ORIGIN}/index.worker.js`).label).toBe('other_same_origin');
    expect(observation.classifyWorkerSource(HOSTILE.blobUrl).label).toBe('blob_same_origin');
    expect(observation.classifyWorkerSource('blob:https://other.test/0e4a2c1a-1111-2222-3333-444444444444').label).toBe('cross_origin');
    expect(observation.classifyWorkerSource(HOSTILE.url).label).toBe('cross_origin');
    expect(observation.classifyWorkerSource('').label).toBe('cross_origin');
    expect(JSON.stringify(observation.classifyWorkerSource(MTPROTO_CHUNK_URL))).not.toContain('AbCdEfGh');
  });

  it('fails the closed schema on any value outside the fixed enums, counts and names', () => {
    expect(observation.validateNetworkBlock(observationBlock())).toBe(null);
    expect(observation.UNCLASSIFIED_NETWORK_BLOCK).toEqual({classification: 'unclassified'});

    const tampered = (mutate: (block: any) => void) => {
      const block = JSON.parse(JSON.stringify(observationBlock()));
      mutate(block);
      return observation.validateNetworkBlock(block);
    };

    expect(tampered((block: any) => {
      block.contexts.alice.workerFailure = HOSTILE.phrase;
    })).toContain('workerFailure');
    expect(tampered((block: any) => {
      block.contexts.alice.workerSourceChunks = ['https://telegramd.test/index.worker-AbCdEfGh.js'];
    })).toContain('workerSourceChunks');
    expect(tampered((block: any) => {
      block.contexts.alice.mtprotoSourceFetch = MTPROTO_CHUNK_URL;
    })).toBeTruthy();
    expect(tampered((block: any) => {
      block.contexts.alice.countedEvents = '512';
    })).toBeTruthy();
    expect(tampered((block: any) => {
      block.contexts.alice[HOSTILE.username] = 1;
    })).toBeTruthy();
    expect(tampered((block: any) => {
      // Shape is schema-valid; the report contract refuses it as evidence.
      block.foreignTargets = 1;
    })).toBe(null);
    expect(tampered((block: any) => {
      block.appContextlessTargets = HOSTILE.password;
    })).toBe('network_appContextlessTargets');
    expect(tampered((block: any) => {
      // A 0/1 flag stays in schema when it is 0: `discoveryActive: 0` is a
      // legal shape, and the report contract is what refuses it as evidence.
      block.discoveryActive = 0;
    })).toBe(null);
    expect(tampered((block: any) => {
      block.controls.c3_no_construction.expected = HOSTILE.token;
    })).toBeTruthy();
  });

  it('establishes the synthetic controls C1 to C4 and fails the run on a mismatch', () => {
    const blocks = controlBlocks();
    for(const name of Object.keys(blocks)) {
      expect(observation.evaluateControl(name, blocks[name])).toBe('pass');
    }

    expect(blocks.c1_shared_worker_created.sharedWorkerState).toBe('created');
    expect(blocks.c1_shared_worker_created.workerFailure).toBe('no_failure_observed');
    expect(blocks.c2_missing_module_script.workerFailure).toBe('script_load_failed');
    expect(blocks.c3_no_construction.sharedWorkerState).toBe('absent');
    expect(blocks.c4_attach_failure.sharedWorkerState).toBe('unknown');
    expect(blocks.c4_attach_failure.observerErrors).toBeGreaterThan(0);
    expect(blocks.c4_overflow.sharedWorkerState).toBe('unknown');
    expect(blocks.c4_overflow.observerOverflow).toBe(1);

    const destroyedBeforeAttach = {
      ...replayContext([
        {kind: 'target', target: pageTarget('page-c2', 'context-c2')},
        {kind: 'target', target: sharedWorker('missing-worker', PROBE_MISSING_URL, 'context-c2')},
        {kind: 'attach', targetId: 'missing-worker'},
        {kind: 'destroy', targetId: 'missing-worker'}
      ])
    };
    expect(observation.evaluateControl('c2_missing_module_script', destroyedBeforeAttach)).toBe('pass');
    expect(observation.evaluateControl('c2_missing_module_script', {...replayContext([
      {kind: 'target', target: pageTarget('page-c2', 'context-c2')},
      {kind: 'target', target: sharedWorker('probe-worker', PROBE_WORKER_URL, 'context-c2')},
      {kind: 'attach', targetId: 'probe-worker'},
      {kind: 'setup', targetId: 'probe-worker'}
    ])})).toBe('fail');
    expect(observation.evaluateControl('c3_no_construction', {...replayContext([
      {kind: 'target', target: pageTarget('page-c3', 'context-c3')},
      {kind: 'target', target: sharedWorker('probe-worker', PROBE_WORKER_URL, 'context-c3')},
      {kind: 'attach', targetId: 'probe-worker'},
      {kind: 'setup', targetId: 'probe-worker'}
    ])})).toBe('fail');
    expect(observation.evaluateControl('c4_attach_failure', {...replayContext([{kind: 'target', target: pageTarget('page-c4', 'context-c4')}])})).toBe('fail');
    expect(observation.evaluateControl('c4_overflow', {...replayContext([{kind: 'target', target: pageTarget('page-c4', 'context-c4')}])})).toBe('fail');
    expect(observation.evaluateControl('c9_unknown_control', blocks.c3_no_construction)).toBe('fail');
  });

  it('requires complete per-context evidence in the published report', () => {
    expect(parseWorkerObservation(observationBlock())).toStrictEqual(observationBlock());

    const tampered = (mutate: (block: any) => void) => {
      const block = JSON.parse(JSON.stringify(observationBlock()));
      mutate(block);
      return block;
    };

    expect(() => parseWorkerObservation(undefined)).toThrow('isolated browser worker observation is missing');
    expect(() => parseWorkerObservation({classification: 'unclassified'})).toThrow('isolated browser worker observation is unclassified');
    expect(() => parseWorkerObservation(tampered((block: any) => {
      block.controls.c2_missing_module_script.expected = 'fail';
    }))).toThrow('observer synthetic control c2_missing_module_script did not pass');
    expect(() => parseWorkerObservation(tampered((block: any) => {
      delete block.controls.c3_no_construction;
    }))).toThrow('observer synthetic controls are incomplete');
    expect(() => parseWorkerObservation(tampered((block: any) => {
      block.contexts.alice.coverageComplete = 0;
    }))).toThrow('alice shared-worker observation coverage is incomplete');
    expect(() => parseWorkerObservation(tampered((block: any) => {
      block.contexts.alice.pageTargets = 2;
    }))).toThrow('alice does not own exactly one page');
    expect(() => parseWorkerObservation(tampered((block: any) => {
      block.contexts.alice.mtprotoWorker = 'unknown';
    }))).toThrow('alice MTProto shared-worker state is unknown');
    expect(() => parseWorkerObservation(tampered((block: any) => {
      block.contexts.alice.mtprotoSourceChunk = 'none';
    }))).toThrow('alice MTProto worker source is not an allowlisted chunk');
    expect(() => parseWorkerObservation(tampered((block: any) => {
      block.foreignTargets = 1;
    }))).toThrow('shared-worker targets were observed outside the runner contexts');
    expect(() => parseWorkerObservation(tampered((block: any) => {
      block.appContextlessTargets = 1;
    }))).toThrow('app shared-worker targets were never attributed to a browser context');
    expect(() => parseWorkerObservation(tampered((block: any) => {
      block.discoveryActive = 0;
    }))).toThrow('browser-level shared-worker discovery was never active');
    expect(() => parseWorkerObservation(tampered((block: any) => {
      block.observerOverflow = 1;
    }))).toThrow('browser worker observer overflowed a resource bound');
    expect(() => parseWorkerObservation(tampered((block: any) => {
      block.contexts.alice.workerFailure = HOSTILE.phrase;
    }))).toThrow('isolated browser worker observation does not match the closed schema');
  });

  it('keeps the resource bounds and page count that the report depends on', () => {
    expect(observation.LIMITS).toEqual({attachedTargets: 16, countedEventsPerContext: 512, cdpMessageBytes: 262_144, commandTimeoutMs: 5000});

    const twoPages = replayContext([
      {kind: 'target', target: pageTarget()},
      {kind: 'target', target: {...pageTarget(), targetId: 'second-page'}}
    ]);
    expect(twoPages.pageTargets).toBe(2);
    expect(twoPages.coverageComplete).toBe(0);

    const detachBeforeSetup = replayContext([
      {kind: 'target', target: pageTarget()},
      {kind: 'target', target: sharedWorker('worker', HOSTILE.blobUrl)},
      {kind: 'detachBeforeSetup'}
    ]);
    expect(detachBeforeSetup.coverageComplete).toBe(0);
    expect(detachBeforeSetup.observerErrors).toBe(1);
  });
});


describe('discovery shared-worker network accounting', () => {
  it('counts one observed allowed creation without creating an upgrade or charging twice', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      await harness.attach(alice, 'alice-worker');
      const before = alice.observer.eventCount();
      const workerEvents = vi.spyOn(alice.observer, 'noteWorkerEvent');
      harness.emit(alice, 'alice-worker', 'Network.webSocketCreated', {requestId: 'socket', url: 'wss://telegramd.test/apiws'});

      expect(alice.observer.eventCount()).toBe(before + 1);
      expect(workerEvents).toHaveBeenCalledTimes(1);
      expect(alice.networkObserver.summary()).toMatchObject({
        workerTargets: {shared_worker: 1, service_worker: 0},
        allowedWebSockets: 1,
        unexpectedAttempts: 0,
        attemptsBySource: {page: 0, shared_worker: 1, service_worker: 0, worker: 0},
        allowedWebSocketsBySource: {page: 0, shared_worker: 1, service_worker: 0, worker: 0}
      });
      expect(alice.observer.webSocket101ByContextPhase()).toEqual(emptyWebSocket101Grid());
      harness.emit(alice, 'alice-worker', 'Network.requestWillBeSent', {type: 'WebSocket', request: {url: 'wss://telegramd.test/apiws'}});
      harness.emit(alice, 'alice-worker', 'Network.webSocketCreated', {requestId: 'repeat', url: 'wss://telegramd.test/apiws'});
      expect(alice.networkObserver.events).toHaveLength(1);
    } finally {
      await harness.stop();
    }
  });

  it.each([
    ['Network.requestWillBeSent', {type: 'Fetch', request: {url: HOSTILE.url}}],
    ['Network.webSocketCreated', {requestId: 'disallowed-socket', url: 'wss://unannounced.invalid/socket?secret=bearer-secret-value'}],
    ['Audits.issueAdded', {issue: {details: {contentSecurityPolicyIssueDetails: {blockedURL: HOSTILE.url, isReportOnly: false}}}}],
    ['Log.entryAdded', {entry: {source: 'security', text: `Refused to connect to '${HOSTILE.url}'`}}]
  ])('classifies discovery-only disallowed egress from %s without serializing inputs', async(method, params) => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      await harness.attach(alice, 'hostile-target-id');
      harness.emit(alice, 'hostile-target-id', method, params);
      expect(alice.networkObserver.summary()).toMatchObject({
        unexpectedAttempts: 1,
        attemptsBySource: {page: 0, shared_worker: 1, service_worker: 0, worker: 0},
        unexpectedAttemptsBySource: {page: 0, shared_worker: 1, service_worker: 0, worker: 0}
      });
      const output = {network: alice.networkObserver.summary(), events: alice.networkObserver.events, worker: alice.observer.summary()};
      expectNoHostileLeak(output);
      expect(JSON.stringify(output)).not.toContain('hostile-target-id');
      expect(JSON.stringify(output)).not.toContain('discovery-hostile-target-id');
    } finally {
      await harness.stop();
    }
  });

  it('preserves report-only CSP behavior and requires the exact allowed websocket URL', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      await harness.attach(alice, 'alice-worker');
      harness.emit(alice, 'alice-worker', 'Audits.issueAdded', {
        issue: {details: {contentSecurityPolicyIssueDetails: {blockedURL: HOSTILE.url, isReportOnly: true}}}
      });
      for(const blockedURL of ['', `https://[invalid?secret=${HOSTILE.token}`]) {
        harness.emit(alice, 'alice-worker', 'Audits.issueAdded', {
          issue: {details: {contentSecurityPolicyIssueDetails: {blockedURL, isReportOnly: true}}}
        });
      }
      expect(alice.observer.summary()).toMatchObject({observerErrors: 0, coverageComplete: 1});
      expect(alice.networkObserver.summary().unexpectedAttempts).toBe(0);
      harness.emit(alice, 'alice-worker', 'Network.webSocketCreated', {requestId: 'query-socket', url: 'wss://telegramd.test/apiws?extra=1'});
      expect(alice.networkObserver.summary()).toMatchObject({unexpectedAttempts: 1, allowedWebSockets: 0});
    } finally {
      await harness.stop();
    }
  });

  it('accepts omitted optional resource types and CSP URLs without inventing attempts', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      await harness.attach(alice, 'alice-worker');
      harness.emit(alice, 'alice-worker', 'Network.requestWillBeSent', {request: {url: `${APP_ORIGIN}/fetch`}});
      harness.emit(alice, 'alice-worker', 'Audits.issueAdded', {issue: {details: {contentSecurityPolicyIssueDetails: {isReportOnly: false}}}});
      harness.emit(alice, 'alice-worker', 'Audits.issueAdded', {issue: {details: {otherIssueDetails: {}}}});
      harness.emit(alice, 'alice-worker', 'Log.entryAdded', {entry: {source: 'javascript', text: `ignored '${HOSTILE.url}'`}});
      expect(alice.observer.summary()).toMatchObject({coverageComplete: 1, observerErrors: 0});
      expect(alice.networkObserver.summary()).toMatchObject({
        allowedWebSockets: 0,
        unexpectedAttempts: 0,
        attemptsBySource: {page: 0, shared_worker: 1, service_worker: 0, worker: 0}
      });
    } finally {
      await harness.stop();
    }
  });

  it.each(['discovery', 'auto'])('uses the first %s session for a target on both paths and unions distinct targets', async(first) => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    const second = first === 'discovery' ? 'auto' : 'discovery';
    try {
      await harness.attach(alice, 'duplicate-worker', first);
      await harness.attach(alice, 'duplicate-worker', second);
      for(const via of [first, second]) {
        harness.emit(alice, 'duplicate-worker', 'Network.webSocketCreated', {requestId: 'socket', url: 'wss://telegramd.test/apiws'}, via);
        harness.emit(alice, 'duplicate-worker', 'Network.requestWillBeSent', {type: 'Fetch', request: {url: `${APP_ORIGIN}/fetch`}}, via);
      }
      harness.emit(alice, 'duplicate-worker', 'Network.requestWillBeSent', {type: 'Fetch', request: {url: HOSTILE.url}}, second);
      expect(alice.networkObserver.summary()).toMatchObject({
        allowedWebSockets: 1,
        unexpectedAttempts: 0,
        attemptsBySource: {page: 0, shared_worker: 2, service_worker: 0, worker: 0},
        workerTargets: {shared_worker: 1, service_worker: 0}
      });
      await harness.attach(alice, 'distinct-worker', second);
      harness.emit(alice, 'distinct-worker', 'Network.webSocketCreated', {requestId: 'distinct-socket', url: 'wss://telegramd.test/apiws'}, second);
      expect(alice.networkObserver.summary()).toMatchObject({allowedWebSockets: 2, workerTargets: {shared_worker: 2, service_worker: 0}});
    } finally {
      await harness.stop();
    }
  });

  it('attributes forged fields to the session owner and keeps Alice, Bob and controls separate', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    const bob = await harness.startContext('bob');
    const control = await harness.startContext('c1_shared_worker_created', true);
    try {
      for(const context of [alice, bob, control]) await harness.attach(context, `${context.name}-worker`);
      harness.emit(alice, 'alice-worker', 'Network.webSocketCreated', {
        requestId: 'alice-socket', url: 'wss://telegramd.test/apiws', targetId: 'bob-worker', type: 'service_worker', source: 'page'
      }, 'discovery', {targetId: 'bob-worker', type: 'service_worker', source: 'page'});
      expect(alice.networkObserver.summary().attemptsBySource).toEqual({page: 0, shared_worker: 1, service_worker: 0, worker: 0});
      expect(bob.networkObserver.events).toHaveLength(0);
      expect(control.networkObserver.events).toHaveLength(0);
      harness.emit(bob, 'bob-worker', 'Network.webSocketCreated', {requestId: 'bob-socket', url: 'wss://telegramd.test/apiws'});
      harness.emit(control, `${control.name}-worker`, 'Network.requestWillBeSent', {type: 'Fetch', request: {url: HOSTILE.url}});
      expect(alice.networkObserver.summary().allowedWebSockets).toBe(1);
      expect(bob.networkObserver.summary().allowedWebSockets).toBe(1);
      expect(control.networkObserver.summary()).toMatchObject({allowedWebSockets: 0, unexpectedAttempts: 1});
    } finally {
      await harness.stop();
    }
  });

  it('ignores baseline, contextless, unattributed and pending targets until registration', async() => {
    const harness = await createDiscoveryNetworkHarness({startContext: false});
    try {
      harness.session.emit('Target.targetCreated', {targetInfo: sharedWorker('baseline', HOSTILE.blobUrl, 'baseline-context')});
      const alice = await harness.startContext('alice');
      harness.session.emit('Target.targetCreated', {targetInfo: {targetId: 'contextless', type: 'shared_worker', url: HOSTILE.blobUrl}});
      for(const targetId of ['unattributed', 'pending']) {
        harness.session.emit('Target.targetCreated', {targetInfo: sharedWorker(targetId, HOSTILE.blobUrl, targetId)});
      }
      for(const targetId of ['baseline', 'contextless', 'unattributed', 'pending']) {
        harness.emit(alice, targetId, 'Network.webSocketCreated', {requestId: targetId, url: 'wss://telegramd.test/apiws'});
      }
      expect(alice.networkObserver.summary()).toMatchObject({allowedWebSockets: 0, workerTargets: {shared_worker: 0, service_worker: 0}});
      expect(alice.networkObserver.events).toHaveLength(0);
      const pending = await harness.startContext('pending');
      await harness.registry.waitForSetup();
      harness.emit(pending, 'pending', 'Network.webSocketCreated', {requestId: 'now-owned', url: 'wss://telegramd.test/apiws'});
      expect(pending.networkObserver.summary()).toMatchObject({allowedWebSockets: 1, workerTargets: {shared_worker: 1, service_worker: 0}});
      expect(alice.networkObserver.events).toHaveLength(0);
    } finally {
      await harness.stop();
    }
  });

  it('rejects late discovery and auto-attach evidence as soon as a context is released', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      await harness.attach(alice, 'discovery-worker');
      await harness.attach(alice, 'auto-worker', 'auto');
      const before = alice.observer.eventCount();
      const errorsBefore = alice.observer.summary().observerErrors;
      const releasing = harness.registry.releaseContext(alice.observer);
      harness.emit(alice, 'discovery-worker', 'Network.webSocketCreated', {requestId: 'late-discovery', url: 'wss://telegramd.test/apiws'});
      harness.emit(alice, 'auto-worker', 'Network.requestWillBeSent', {type: 'Fetch', request: {url: HOSTILE.url}}, 'auto');
      for(const [emitter, sessionId] of [[harness.session, 'discovery-discovery-worker'], [alice.cdp, 'auto-auto-worker']]) {
        expect(() => emitter.emit('Target.receivedMessageFromTarget', {sessionId, message: 'null'})).not.toThrow();
        expect(() => emitter.emit('Target.receivedMessageFromTarget', {sessionId, message: '{invalid'})).not.toThrow();
      }
      await releasing;
      expect(alice.networkObserver.events).toHaveLength(0);
      expect(alice.observer.eventCount()).toBe(before);
      expect(alice.observer.summary().observerErrors).toBe(errorsBefore);
      expect(harness.registry.ownedTargetCount).toBe(0);
    } finally {
      await harness.stop();
    }
  });

  it.each([
    ['Network.webSocketCreated', null],
    ['Network.webSocketCreated', []],
    ['Network.webSocketCreated', 'not-object'],
    ['Network.webSocketCreated', {url: 42}],
    ['Network.requestWillBeSent', {type: 'Fetch', request: null}],
    ['Network.requestWillBeSent', {type: 42, request: {url: HOSTILE.url}}],
    ['Network.requestWillBeSent', {type: 'Fetch', request: {url: {secret: HOSTILE.token}}}],
    ['Audits.issueAdded', {issue: {details: {contentSecurityPolicyIssueDetails: {blockedURL: 42}}}}],
    ['Audits.issueAdded', {issue: {details: {contentSecurityPolicyIssueDetails: {blockedURL: HOSTILE.url, isReportOnly: 'true'}}}}],
    ['Log.entryAdded', {entry: {source: 'security', text: {secret: HOSTILE.token}}}]
  ])('fails coverage without throwing or adding an attempt for malformed %s params %j', async(method, params) => {
    const harness = await createDiscoveryNetworkHarness({observeWebSocket101: false});
    const {alice} = harness;
    try {
      await harness.attach(alice, 'alice-worker');
      const before = alice.observer.eventCount();
      expect(() => harness.emit(alice, 'alice-worker', method, params)).not.toThrow();
      expect(alice.observer.eventCount()).toBe(before + 1);
      expect(alice.observer.summary()).toMatchObject({observerErrors: 1, coverageComplete: 0});
      expect(alice.networkObserver.events).toHaveLength(0);
      expectNoHostileLeak(alice.networkObserver.summary());
    } finally {
      await harness.stop();
    }
  });

  it.each([
    ['Network.webSocketCreated', {requestId: 'invalid-socket', url: ''}],
    ['Network.webSocketCreated', {requestId: 'invalid-socket', url: `relative-path?secret=${HOSTILE.token}`}],
    ['Network.requestWillBeSent', {type: 'Fetch', request: {url: ''}}],
    ['Network.requestWillBeSent', {type: 'Fetch', request: {url: `https://[invalid?secret=${HOSTILE.token}`}}],
    ['Network.requestWillBeSent', {type: 'Fetch', request: {url: 'data'}}]
  ])('rejects invalid URL strings from discovery %s without charging twice or inventing attempts', async(method, params) => {
    const harness = await createDiscoveryNetworkHarness({observeWebSocket101: false});
    const {alice} = harness;
    try {
      await harness.attach(alice, 'alice-worker');
      const before = alice.observer.eventCount();
      expect(() => harness.emit(alice, 'alice-worker', method, params)).not.toThrow();
      expect(alice.observer.eventCount()).toBe(before + 1);
      expect(alice.observer.summary()).toMatchObject({observerErrors: 1, coverageComplete: 0});
      expect(alice.networkObserver.summary()).toMatchObject({observerErrors: 1, allowedWebSockets: 0, unexpectedAttempts: 0});
      expect(alice.networkObserver.events).toHaveLength(0);
      expectNoHostileLeak({network: alice.networkObserver.summary(), worker: alice.observer.summary(), errors: alice.networkObserver.errors});
    } finally {
      await harness.stop();
    }
  });

  it.each(['page', 'auto'])('rejects invalid URL strings from the existing %s path with one event charge', async(via) => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      if(via === 'auto') await harness.attach(alice, 'alice-worker', 'auto');
      const before = alice.observer.eventCount();
      const params = {requestId: 'invalid-socket', url: ''};
      if(via === 'page') alice.cdp.emit('Network.webSocketCreated', params);
      else harness.emit(alice, 'alice-worker', 'Network.webSocketCreated', params, 'auto');
      expect(alice.observer.eventCount()).toBe(before + 1);
      expect(alice.observer.summary()).toMatchObject({observerErrors: 1, coverageComplete: 0});
      expect(alice.networkObserver.summary()).toMatchObject({observerErrors: 1, allowedWebSockets: 0, unexpectedAttempts: 0});
      expect(alice.networkObserver.events).toHaveLength(0);
    } finally {
      await harness.stop();
    }
  });

  it.each(['page', 'auto', 'discovery'])('ignores normalized CSP diagnostic values on the %s path', async(via) => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      if(via !== 'page') await harness.attach(alice, 'alice-worker', via);
      for(const blockedURL of ['', 'blob', 'data', `https://[invalid?secret=${HOSTILE.token}`]) {
        const before = alice.observer.eventCount();
        const params = {issue: {details: {contentSecurityPolicyIssueDetails: {
          blockedURL,
          violatedDirective: 'connect-src \'self\'',
          contentSecurityPolicyViolationType: 'kURLViolation',
          isReportOnly: false
        }}}};
        if(via === 'page') alice.cdp.emit('Audits.issueAdded', params);
        else harness.emit(alice, 'alice-worker', 'Audits.issueAdded', params, via);
        expect(alice.observer.eventCount()).toBe(before + 1);
        expect(alice.observer.summary()).toMatchObject({observerErrors: 0, coverageComplete: 1});
        expect(alice.networkObserver.summary()).toMatchObject({observerErrors: 0, allowedWebSockets: 0, unexpectedAttempts: 0});
        expect(alice.networkObserver.events).toHaveLength(0);
      }
      expectNoHostileLeak({network: alice.networkObserver.summary(), worker: alice.observer.summary(), errors: alice.networkObserver.errors});
    } finally {
      await harness.stop();
    }
  });

  it('ignores unparseable log diagnostic URLs without treating the text as a malformed request', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      await harness.attach(alice, 'alice-worker');
      const before = alice.observer.eventCount();
      harness.emit(alice, 'alice-worker', 'Log.entryAdded', {
        entry: {source: 'security', text: `Refused to connect to 'https://[invalid?secret=${HOSTILE.token}'`}
      });
      expect(alice.observer.eventCount()).toBe(before + 1);
      expect(alice.observer.summary()).toMatchObject({observerErrors: 0, coverageComplete: 1});
      expect(alice.networkObserver.summary()).toMatchObject({observerErrors: 0, allowedWebSockets: 0, unexpectedAttempts: 0});
      expect(alice.networkObserver.events).toHaveLength(0);
      expectNoHostileLeak(alice.observer.summary());
    } finally {
      await harness.stop();
    }
  });

  it('records an observer error when an owned discovery session has no network sink', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      harness.registry.registerContext('alice', alice.observer);
      await harness.attach(alice, 'alice-worker');
      harness.emit(alice, 'alice-worker', 'Network.requestWillBeSent', {type: 'Fetch', request: {url: HOSTILE.url}});
      expect(alice.observer.summary()).toMatchObject({observerErrors: 1, coverageComplete: 0});
      expect(alice.networkObserver.events).toHaveLength(0);
    } finally {
      await harness.stop();
    }
  });

  it('rejects malformed discovery payloads without throwing or leaking their text', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      await harness.attach(alice, 'alice-worker');
      const invalidPayloads: any[] = [null, 42, HOSTILE.phrase, [], {}, {method: 42}];
      for(const value of invalidPayloads) {
        expect(() => harness.session.emit('Target.receivedMessageFromTarget', {
          sessionId: 'discovery-alice-worker', message: JSON.stringify(value)
        })).not.toThrow();
      }
      expect(alice.observer.summary()).toMatchObject({observerErrors: 6, coverageComplete: 0});
      expect(alice.networkObserver.events).toHaveLength(0);
      expectNoHostileLeak(alice.observer.summary());
    } finally {
      await harness.stop();
    }
  });

  it.each([
    {method: 'Network.requestWillBeSent', params: {type: 'Fetch', request: {url: HOSTILE.url}}},
    {method: 'Audits.issueAdded', params: {issue: {details: {contentSecurityPolicyIssueDetails: {blockedURL: HOSTILE.url, isReportOnly: false}}}}}
  ])('fails the existing egress gate on discovery-only $method', async(event) => {
    const report = await runDiscoveryAccountingGate([event]);
    expect(report).toMatchObject({status: 'failed', stage: 'browser_egress_or_page_errors', network: {unexpectedAttempts: 1}});
    expect(report.network.contexts.alice.unexpectedAttemptsBySource).toEqual({page: 0, shared_worker: 1, service_worker: 0, worker: 0});
    expectNoHostileLeak(report);
  });

  it('keeps the successful paired report compatible with the existing parser and controls', async() => {
    const report = await runDiscoveryAccountingGate([]);
    expect(report).toMatchObject({status: 'passed', stage: 'alice_password_field_ready'});
    expect(report.network.contexts.alice).toEqual({
      workerTargets: {shared_worker: 1, service_worker: 1},
      allowedWebSockets: 2,
      attemptsBySource: {page: 0, shared_worker: 1, service_worker: 1, worker: 0},
      unexpectedAttemptsBySource: {page: 0, shared_worker: 0, service_worker: 0, worker: 0},
      allowedWebSocketsBySource: {page: 0, shared_worker: 1, service_worker: 1, worker: 0}
    });
    expect(report.network.websocket_101_by_context_phase).toEqual(emptyWebSocket101Grid());
    expect(JSON.stringify(report.workerObservation.controls)).toBe(JSON.stringify(controlBlocks()));
    expect(observation.validateNetworkBlock(report.workerObservation)).toBe(null);
    expect(parseAuthProgressReport(report).network).toEqual(report.network);
  });

  it.each(['overflow', 'attach', 'setup'])('rejects a passing verdict after a discovery %s fault', async(fault) => {
    const report = await runDiscoveryAccountingGate([], fault);
    expect(report.status).toBe('failed');
    expect(report.workerObservation.contexts.alice.coverageComplete).toBe(0);
  });

  it('drains a discovery detach before setup and rejects a passing verdict', async() => {
    vi.useFakeTimers();
    try {
      const outcome = await settleAfterCdpDeadline(runDiscoveryAccountingGate([], 'detach'));
      expect(outcome.status).toBe('resolved');
      if(outcome.status === 'resolved') {
        expect(outcome.value.status).toBe('failed');
        expect(outcome.value.workerObservation.contexts.alice.coverageComplete).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a passing verdict after malformed discovery egress', async() => {
    const report = await runDiscoveryAccountingGate([{method: 'Network.requestWillBeSent', params: null}]);
    expect(report.status).toBe('failed');
    expect(report.workerObservation.contexts.alice.coverageComplete).toBe(0);
  });

  it.each([
    {method: 'Network.webSocketCreated', params: {requestId: 'invalid-socket', url: ''}},
    {method: 'Network.requestWillBeSent', params: {type: 'Fetch', request: {url: ''}}}
  ])('fails the egress gate on invalid URL strings from discovery $method', async(event) => {
    const report = await runDiscoveryAccountingGate([event]);
    expect(report).toMatchObject({
      status: 'failed', stage: 'browser_egress_or_page_errors', network: {unexpectedAttempts: 0, observerErrors: 1}
    });
    expect(report.workerObservation.contexts.alice.coverageComplete).toBe(0);
    expect(report.network.websocket_101_by_context_phase).toEqual(emptyWebSocket101Grid());
    expectNoHostileLeak(report);
  });

  it.each(['', 'blob', 'data', `https://[invalid?secret=${HOSTILE.token}`])('keeps a passing scenario verdict for CSP diagnostic value %j', async(blockedURL) => {
    const report = await runDiscoveryAccountingGate([{method: 'Audits.issueAdded', params: {
      issue: {details: {contentSecurityPolicyIssueDetails: {
        blockedURL,
        violatedDirective: 'connect-src \'self\'',
        contentSecurityPolicyViolationType: 'kURLViolation',
        isReportOnly: false
      }}}
    }}]);
    expect(report).toMatchObject({
      status: 'passed', stage: 'alice_password_field_ready', network: {unexpectedAttempts: 0, observerErrors: 0}
    });
    expect(report.workerObservation.contexts.alice.coverageComplete).toBe(1);
    expect(report.network.contexts.alice.attemptsBySource).toEqual({page: 0, shared_worker: 1, service_worker: 1, worker: 0});
    expect(report.network.websocket_101_by_context_phase).toEqual(emptyWebSocket101Grid());
    expectNoHostileLeak(report);
  });

  it('does not backfill allowed attempts from a 101 whose creation was missed', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      await harness.attach(alice, 'alice-worker');
      harness.emit(alice, 'alice-worker', 'Network.webSocketHandshakeResponseReceived', {requestId: 'missed-creation', response: {status: 101, url: HOSTILE.url}});
      expect(alice.networkObserver.summary()).toMatchObject({allowedWebSockets: 0, unexpectedAttempts: 0});
      expect(alice.networkObserver.events).toHaveLength(0);
      expect(alice.observer.webSocket101ByContextPhase()).toEqual({
        alice: {pre_submit: 0, post_submit: 0, unknown: 1},
        control: {pre_submit: 0, post_submit: 0, unknown: 0},
        other: {pre_submit: 0, post_submit: 0, unknown: 0}
      });
    } finally {
      await harness.stop();
    }
  });

  it('keeps Runtime, Inspector, response, frame and nested Target messages out of network accounting', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      await harness.attach(alice, 'alice-worker');
      for(const method of ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Inspector.targetCrashed', 'Network.responseReceived', 'Network.webSocketFrameReceived', 'Target.attachedToTarget']) {
        harness.emit(alice, 'alice-worker', method, {
          url: HOSTILE.url, request: {url: HOSTILE.url}, type: 'WebSocket', response: {status: 101},
          sessionId: 'forged-session', targetInfo: sharedWorker('forged-target', HOSTILE.url, 'bob')
        });
      }
      expect(alice.networkObserver.events).toHaveLength(0);
      expect(alice.networkObserver.summary().workerTargets).toEqual({shared_worker: 1, service_worker: 0});
      expect(harness.calls.filter((call) => call.method === 'Target.attachToTarget')).toHaveLength(1);
    } finally {
      await harness.stop();
    }
  });

  it('bounds discovery event and target memory with the existing budgets', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      for(let index = 0; index < observation.LIMITS.attachedTargets; index++) await harness.attach(alice, `bounded-${index}`);
      expect(alice.networkObserver.summary().workerTargets.shared_worker).toBe(16);
      for(let index = 0; index < observation.LIMITS.countedEventsPerContext + 20; index++) {
        harness.emit(alice, 'bounded-0', 'Network.webSocketCreated', {requestId: `socket-${index}`, url: `wss://unannounced.invalid/${index}`});
      }
      expect(alice.observer.summary()).toMatchObject({countedEvents: 512, observerOverflow: 1, coverageComplete: 0});
      expect(alice.networkObserver.events).toHaveLength(479);
      const retained = alice.networkObserver.events.length;
      await harness.attach(alice, 'over-budget-target');
      harness.emit(alice, 'bounded-0', 'Network.requestWillBeSent', {type: 'Fetch', request: {url: HOSTILE.url}});
      expect(alice.networkObserver.events).toHaveLength(retained);
      expect(alice.networkObserver.summary().workerTargets.shared_worker).toBe(16);
    } finally {
      await harness.stop();
    }
  });

  it('caps the discovery target union and protocol attachments at the existing attachment limit', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      for(let index = 0; index < 20; index++) await harness.attach(alice, `bounded-${index}`);
      expect(alice.networkObserver.summary().workerTargets).toEqual({shared_worker: 16, service_worker: 0});
      expect(harness.calls.filter((call) => call.method === 'Target.attachToTarget')).toHaveLength(16);
      expect(alice.observer.summary()).toMatchObject({attachedTargets: 16, observerOverflow: 1, coverageComplete: 0});
    } finally {
      await harness.stop();
    }
  });
});

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
      artifactDigest: `sha256:${'c'.repeat(64)}`,
      manifestArtifactDigest: `sha256:${'f'.repeat(64)}`
    };
    const manifest = {
      mode: 'private',
      endpoint: expected.wssEndpoint,
      fingerprint: expected.fingerprint,
      sourceCommit: expected.webRevision,
      artifactDigest: expected.manifestArtifactDigest
    };

    expect(matchesPrivateArtifactManifest(manifest, expected)).toBe(true);
    expect(matchesPrivateArtifactManifest({...manifest, endpoint: 'wss://other.test/apiws'}, expected)).toBe(false);
    expect(matchesPrivateArtifactManifest({...manifest, fingerprint: '0'.repeat(16)}, expected)).toBe(false);
    expect(matchesPrivateArtifactManifest({...manifest, sourceCommit: '0'.repeat(40)}, expected)).toBe(false);
    expect(matchesPrivateArtifactManifest({...manifest, artifactDigest: `sha256:${'0'.repeat(64)}`}, expected)).toBe(false);
    expect(matchesPrivateArtifactManifest({...manifest, artifactDigest: expected.artifactDigest}, expected)).toBe(false);
    expect(matchesPrivateArtifactManifest(manifest, {...expected, manifestArtifactDigest: undefined})).toBe(false);
    expect(matchesPrivateArtifactManifest({...manifest, publicKeySHA256: expected.publicKeySHA256}, expected)).toBe(false);
  });

  it('requires matching server and audited artifact readiness for the same immutable run', () => {
    const pins = READINESS_PINS;
    const expected = buildServerReady();
    const artifactReady = buildArtifactReady(expected);
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

  it('requires the manifest payload digest beside the staged artifact digest', () => {
    const serverReady = buildServerReady();
    const artifactReady = buildArtifactReady(serverReady);
    const parse = (event: any) => parseFixtureReadiness([serverReady, event].map((value) => JSON.stringify(value)).join('\n'), READINESS_PINS);

    expect(artifactReady.manifestArtifactDigest).not.toBe(artifactReady.artifactDigest);
    expect(parse(artifactReady).artifactReady.artifactDigest).toBe(artifactReady.artifactDigest);
    const {manifestArtifactDigest: _omitted, ...missing} = artifactReady;
    expect(() => parse(missing)).toThrow('fixture artifact identity is invalid');
    for(const malformed of [null, 7, [artifactReady.manifestArtifactDigest], 'f'.repeat(64), `sha256:${'f'.repeat(63)}`, `sha256:${'F'.repeat(64)}`, `sha512:${'f'.repeat(64)}`]) {
      expect(() => parse({...artifactReady, manifestArtifactDigest: malformed})).toThrow('fixture artifact identity is invalid');
    }
  });

  it('requires a string manifest payload digest in the browser runtime input', () => {
    const runId = 'a'.repeat(32);
    const runtime = {
      runId,
      endpoint: APP_ORIGIN,
      wssEndpoint: 'wss://telegramd.test/apiws',
      fingerprint: '1234567890abcdef',
      publicKeySHA256: 'a'.repeat(64),
      artifactDigest: `sha256:${'c'.repeat(64)}`,
      manifestArtifactDigest: `sha256:${'f'.repeat(64)}`,
      webRevision: READINESS_PINS.webRevision,
      leafSPKI: Buffer.alloc(32, 1).toString('base64'),
      frontIp: '127.0.0.1',
      screenshotDirectory: `/tmp/real-client-${runId}`,
      accounts: [
        {username: `u${runId.slice(0, 30)}a`, password: 'b'.repeat(64)},
        {username: `u${runId.slice(0, 30)}b`, password: 'c'.repeat(64)}
      ]
    };

    expect(() => validateRuntimeInput(runtime)).not.toThrow();
    expect(() => validateRuntimeInput({...runtime, observationOnly: true, artifactDigest: null, manifestArtifactDigest: null})).not.toThrow();
    for(const malformed of [undefined, null, [runtime.manifestArtifactDigest], `sha256:${'f'.repeat(63)}`]) {
      expect(() => validateRuntimeInput({...runtime, manifestArtifactDigest: malformed})).toThrow('runtime_input_validation');
    }
    expect(() => validateRuntimeInput({...runtime, observationOnly: true, artifactDigest: null})).toThrow('runtime_input_validation');
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
      expect(readSyntheticCredentials(credentials, runId, 1)).toEqual([
        {username: `u${runId.slice(0, 30)}a`, password: '1'.repeat(64)}
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
      '--harness-revision', '5f294c39abb32fc8ae15a4f7ccb085974098b320',
      '--server-revision', '47daaaea5c71b859d9865c03cabb50da5a1a013b',
      '--web-revision', 'b7523e39f5365f50ab6ecd7aa1fb4c79eedf08d8',
      '--run-id', 'a'.repeat(32),
      '--scenarios', 'sign-in,message,group'
    ];

    expect(parseRealClientArgs(args)).toEqual({
      readinessFile: './fixture.jsonl',
      harnessRevision: '5f294c39abb32fc8ae15a4f7ccb085974098b320',
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

  it('accepts a server-ready-only readiness pair for the synthetic-only run', () => {
    const serverReady = buildServerReady();
    const text = JSON.stringify(serverReady);

    expect(parseFixtureReadiness(text, READINESS_PINS, {requireArtifact: false})).toEqual({serverReady, artifactReady: undefined});
    expect(() => parseFixtureReadiness(text, READINESS_PINS)).toThrow('both fixture readiness events are required');
    expect(() => parseFixtureReadiness([serverReady, buildArtifactReady(serverReady)].map((event) => JSON.stringify(event)).join('\n'), READINESS_PINS, {requireArtifact: false}))
    .toThrow('one fixture readiness event is required');
    expect(() => parseFixtureReadiness(JSON.stringify({...serverReady, security: {...serverReady.security, registrationClosed: false}}), READINESS_PINS, {requireArtifact: false}))
    .toThrow('server-ready security evidence is incomplete');
  });

  it('requires the observer-controls-only flag to be explicit and complete', () => {
    const args = [
      '--readiness-file', './fixture.jsonl',
      '--harness-revision', READINESS_PINS.harnessRevision,
      '--server-revision', READINESS_PINS.serverRevision,
      '--web-revision', READINESS_PINS.webRevision,
      '--run-id', READINESS_PINS.runId
    ];

    expect(parseRealClientArgs([...args, '--observer-controls-only'])).toEqual({
      readinessFile: './fixture.jsonl',
      harnessRevision: READINESS_PINS.harnessRevision,
      serverRevision: READINESS_PINS.serverRevision,
      webRevision: READINESS_PINS.webRevision,
      runId: READINESS_PINS.runId,
      observerControlsOnly: true,
      scenarios: ['sign-in', 'message', 'group']
    });
    expect(parseRealClientArgs([...args, '--scenarios', 'sign-in,message,group', '--observer-controls-only']).observerControlsOnly).toBe(true);
    expect(() => parseRealClientArgs(args)).toThrow('scenario selection is required');
    expect(() => parseRealClientArgs([...args, '--observer-controls-only', '--observer-controls-only'])).toThrow('option was provided more than once');
  });

  it('keeps one-submission mode separate from scenario and observer modes', () => {
    const args = [
      '--readiness-file', './fixture.jsonl',
      '--harness-revision', READINESS_PINS.harnessRevision,
      '--server-revision', READINESS_PINS.serverRevision,
      '--web-revision', READINESS_PINS.webRevision,
      '--run-id', READINESS_PINS.runId
    ];

    expect(parseRealClientArgs([...args, '--auth-progress-one-submission'])).toEqual({
      readinessFile: './fixture.jsonl',
      harnessRevision: READINESS_PINS.harnessRevision,
      serverRevision: READINESS_PINS.serverRevision,
      webRevision: READINESS_PINS.webRevision,
      runId: READINESS_PINS.runId,
      authProgressOneSubmission: true
    });
    expect(() => parseRealClientArgs([...args, '--scenarios', 'sign-in,message,group', '--auth-progress-one-submission']))
    .toThrow('cannot be combined');
    expect(() => parseRealClientArgs([...args, '--observer-controls-only', '--auth-progress-one-submission']))
    .toThrow('cannot be combined');
    expect(() => parseRealClientArgs([...args, '--auth-progress-one-submission', '--auth-progress-one-submission']))
    .toThrow('option was provided more than once');
  });

  it('rejects conflicting runner modes before reading readiness or starting Docker', () => {
    const runnerPath = resolve(process.cwd(), 'scripts/real-client/run.mjs');
    const result = spawnSync(process.execPath, [runnerPath,
      '--readiness-file', '/path/that/does/not/exist',
      '--harness-revision', READINESS_PINS.harnessRevision,
      '--server-revision', READINESS_PINS.serverRevision,
      '--web-revision', READINESS_PINS.webRevision,
      '--run-id', READINESS_PINS.runId,
      '--scenarios', 'sign-in,message,group',
      '--auth-progress-one-submission'
    ], {encoding: 'utf8'});

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cannot be combined');
    expect(result.stderr).not.toContain('does/not/exist');
    expect(result.stdout).toBe('');
  });

  it('accepts only bounded fixed one-submission evidence', async() => {
    const network = await authProgressNetwork();
    const report = (overrides = {}) => ({
      status: 'passed',
      mode: 'auth_progress_one_submission',
      stage: 'alice_password_field_ready',
      usernameSubmissions: 1,
      passwordFills: 0,
      passwordSubmissions: 0,
      bobContextCount: 0,
      laterScenarioCount: 0,
      contextCount: 1,
      controlContextCount: Object.keys(observation.CONTROL_EXPECTATIONS).length,
      screenshotsCaptured: 0,
      passwordEvidence: [{stage: 'alice_password_field_ready', count: 1}],
      network: structuredClone(network),
      workerObservation: authProgressObservationBlock(),
      ...overrides
    });

    expect(Object.keys(network.contexts.alice.workerTargets).sort()).toEqual(['service_worker', 'shared_worker']);
    expect(network.contexts.alice.workerTargets).toEqual({shared_worker: 1, service_worker: 1});
    for(const sourceMap of [network.contexts.alice.attemptsBySource, network.contexts.alice.unexpectedAttemptsBySource, network.contexts.alice.allowedWebSocketsBySource]) {
      expect(Object.keys(sourceMap).sort()).toEqual(['page', 'service_worker', 'shared_worker', 'worker']);
    }
    expect(parseAuthProgressReport(report())).toEqual(report());
    expect(parseAuthProgressReport(report({
      status: 'failed',
      stage: 'alice_password_card_not_reached',
      passwordEvidence: [{stage: 'alice_password_card_not_reached', count: 0}]
    }))).toEqual(report({
      status: 'failed',
      stage: 'alice_password_card_not_reached',
      passwordEvidence: [{stage: 'alice_password_card_not_reached', count: 0}]
    }));
    expect(parseAuthProgressReport(report({
      status: 'failed',
      stage: 'alice_password_field_not_unique',
      passwordEvidence: [{stage: 'alice_password_field_not_unique', count: 2}]
    })).passwordEvidence).toEqual([{stage: 'alice_password_field_not_unique', count: 2}]);
    expect(() => parseAuthProgressReport(report({rpcCount: 1}))).toThrow('auth progress report is invalid');
    expect(() => parseAuthProgressReport(report({passwordFills: 1}))).toThrow('auth progress report is invalid');
    expect(() => parseAuthProgressReport(report({bobContextCount: 1}))).toThrow('auth progress report is invalid');
    expect(() => parseAuthProgressReport(report({laterScenarioCount: 1}))).toThrow('auth progress report is invalid');
    expect(() => parseAuthProgressReport(report({stage: 'arbitrary server text'}))).toThrow('auth progress report is invalid');
    expect(() => parseAuthProgressReport(report({workerObservation: {classification: 'unclassified', secret: HOSTILE.password}})))
    .toThrow('auth progress report is invalid');
    const networkWithRpc = {...structuredClone(network), rpcCount: 1};
    expect(() => parseAuthProgressReport(report({network: networkWithRpc})))
    .toThrow('auth progress report is invalid');
    const unmatchedAttempts = structuredClone(network);
    unmatchedAttempts.contexts.alice.attemptsBySource.page = 1;
    unmatchedAttempts.contexts.alice.unexpectedAttemptsBySource.page = 1;
    expect(() => parseAuthProgressReport(report({network: unmatchedAttempts})))
    .toThrow('auth progress report is invalid');

    const invalidNetworks = [
      (() => { const invalid = structuredClone(network); delete invalid.contexts.alice.workerTargets.shared_worker; return invalid; })(),
      (() => { const invalid = structuredClone(network); invalid.contexts.alice.workerTargets.page = 0; return invalid; })(),
      ...['attemptsBySource', 'unexpectedAttemptsBySource', 'allowedWebSocketsBySource'].map((key) => {
        const invalid = structuredClone(network);
        delete invalid.contexts.alice[key].worker;
        return invalid;
      }),
      ...['attemptsBySource', 'unexpectedAttemptsBySource', 'allowedWebSocketsBySource'].map((key) => {
        const invalid = structuredClone(network);
        invalid.contexts.alice[key].unknown = 0;
        return invalid;
      }),
      ...[
        ['workerTargets', 'service_worker', -1],
        ['workerTargets', 'shared_worker', 0.5],
        ['workerTargets', 'service_worker', 1_000_001],
        ['workerTargets', 'shared_worker', Number.MAX_SAFE_INTEGER + 1],
        ['attemptsBySource', 'page', -1],
        ['unexpectedAttemptsBySource', 'worker', 0.5],
        ['allowedWebSocketsBySource', 'shared_worker', 1_000_001]
      ].map(([key, source, count]) => {
        const invalid = structuredClone(network);
        invalid.contexts.alice[key][source] = count;
        return invalid;
      }),
      (() => {
        const invalid = structuredClone(network);
        invalid.contexts.alice.attemptsBySource.page = 0;
        invalid.contexts.alice.unexpectedAttemptsBySource.page = 1;
        invalid.unexpectedAttempts = 1;
        return invalid;
      })(),
      (() => { const invalid = structuredClone(network); invalid.contexts.alice.attemptsBySource.service_worker = 0; return invalid; })(),
      (() => { const invalid = structuredClone(network); invalid.contexts.alice.allowedWebSockets = 0; return invalid; })(),
      (() => { const invalid = structuredClone(network); invalid.unexpectedAttempts = 1; return invalid; })()
    ];
    for(const invalidNetwork of invalidNetworks) {
      expect(() => parseAuthProgressReport(report({network: invalidNetwork}))).toThrow('auth progress report is invalid');
    }
  });

  it('requires all websocket 101 cells with closed context and phase enums', async() => {
    const network = await authProgressNetwork();
    const grid: any = emptyWebSocket101Grid();
    grid.alice.post_submit = 2_147_483_647;
    const makeReport = (counts: any): any => ({
      status: 'failed',
      mode: 'auth_progress_one_submission',
      stage: 'browser_launch',
      usernameSubmissions: 0,
      passwordFills: 0,
      passwordSubmissions: 0,
      bobContextCount: 0,
      laterScenarioCount: 0,
      contextCount: 0,
      controlContextCount: 0,
      screenshotsCaptured: 0,
      passwordEvidence: [] as any[],
      network: {...structuredClone(network), websocket_101_by_context_phase: counts},
      workerObservation: null as any
    });
    const validReport = makeReport(grid);

    expect(parseAuthProgressReport(validReport)).toEqual(validReport);

    const invalidGrids = [
      (() => { const invalid = structuredClone(grid); delete invalid.alice.unknown; return invalid; })(),
      (() => { const invalid = structuredClone(grid); invalid.alice.extra = 0; return invalid; })(),
      (() => { const invalid = structuredClone(grid); invalid.bob = invalid.alice; return invalid; })(),
      (() => { const invalid = structuredClone(grid); invalid.constructor = invalid.alice; return invalid; })(),
      (() => { const invalid = structuredClone(grid); Object.defineProperty(invalid.alice, '__proto__', {value: 0, enumerable: true}); return invalid; })(),
      ...[1.5, -1, 2_147_483_648].map((count) => {
        const invalid = structuredClone(grid);
        invalid.other.unknown = count;
        return invalid;
      }),
      (() => { const invalid = Object.create({alice: grid.alice}); invalid.control = grid.control; invalid.other = grid.other; return invalid; })()
    ];
    for(const invalidGrid of invalidGrids) {
      expect(() => parseAuthProgressReport(makeReport(invalidGrid))).toThrow('auth progress report is invalid');
    }
    expect(() => parseAuthProgressReport(makeReport(undefined))).toThrow('auth progress report is invalid');
  });

  it('turns cleanup failure into a fixed failed one-submission report and nonzero exit', async() => {
    const network = await authProgressNetwork();
    const report = {
      status: 'passed',
      mode: 'auth_progress_one_submission',
      stage: 'alice_password_field_ready',
      usernameSubmissions: 1,
      passwordFills: 0,
      passwordSubmissions: 0,
      bobContextCount: 0,
      laterScenarioCount: 0,
      contextCount: 1,
      controlContextCount: Object.keys(observation.CONTROL_EXPECTATIONS).length,
      screenshotsCaptured: 0,
      passwordEvidence: [{stage: 'alice_password_field_ready', count: 1}],
      network,
      workerObservation: authProgressObservationBlock()
    };
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const originalExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      emitAuthProgressReport(report, true);

      expect(write).toHaveBeenCalledWith(`${JSON.stringify({...report, status: 'failed', stage: 'cleanup'})}\n`);
      expect(process.exitCode).toBe(1);
    } finally {
      write.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it('requires every synthetic control to pass in the controls-only report', () => {
    const controlsOnly = (overrides = {}) => ({
      unexpectedAttempts: 0,
      observerErrors: 0,
      foreignTargets: 0,
      contextlessTargets: 0,
      appContextlessTargets: 0,
      discoveryActive: 1,
      attachedTargets: 2,
      observerOverflow: 0,
      countedEvents: 40,
      contexts: {},
      controls: controlBlocks(),
      ...overrides
    });

    expect(parseObserverControls(controlsOnly())).toStrictEqual(controlsOnly());
    expect(() => parseObserverControls(controlsOnly({contexts: {alice: replayContext(appContextEvents())}})))
    .toThrow('observer control evidence carries app contexts');
    expect(() => parseObserverControls(controlsOnly({discoveryActive: 0}))
    ).toThrow('browser-level shared-worker discovery was never active');
    expect(() => parseObserverControls(controlsOnly({appContextlessTargets: 1}))
    ).toThrow('app shared-worker targets were never attributed to a browser context');
    expect(() => parseObserverControls({classification: 'unclassified'})).toThrow('observer control evidence is unclassified');
    const failing = controlsOnly();
    failing.controls.c2_missing_module_script.expected = 'fail';
    expect(() => parseObserverControls(failing)).toThrow('observer synthetic control c2_missing_module_script did not pass');
  });
});

function usernameReadinessMarkup({delay = 0, fieldCount = 1, legacyButton = false}: {delay?: number, fieldCount?: number, legacyButton?: boolean} = {}) {
  const fields = Array.from({length: fieldCount}, () => '<input aria-label="Username">').join('');
  const button = legacyButton ? '<button id="legacy-entry" type="button">Sign in with username</button>' : '';
  const renderFields = delay > 0
    ? `setTimeout(() => {document.querySelector('#login').insertAdjacentHTML('beforeend', ${JSON.stringify(fields)})}, ${delay});`
    : `document.querySelector('#login').insertAdjacentHTML('beforeend', ${JSON.stringify(fields)});`;

  return `<!doctype html><html><body>
    ${button}<form id="login"></form>
    <script>
      window.legacyClicks = 0;
      window.formSubmissions = 0;
      document.querySelector('#legacy-entry')?.addEventListener('click', () => {window.legacyClicks++});
      document.querySelector('#login').addEventListener('submit', (event) => {event.preventDefault(); window.formSubmissions++});
      ${renderFields}
    </script>
  </body></html>`;
}

function escapeHtmlAttribute(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function passwordStageMarkup({
  delay = 0,
  actualCount = 1,
  includeActual = true,
  actualType = 'password',
  actualStyle = '',
  actualClass = '',
  usernameRemainsVisible = false,
  label = 'Password',
  alertText = ''
}: {
  delay?: number,
  actualCount?: number,
  includeActual?: boolean,
  actualType?: string,
  actualStyle?: string,
  actualClass?: string,
  usernameRemainsVisible?: boolean,
  label?: string,
  alertText?: string
} = {}) {
  const actualFields = includeActual
    ? Array.from({length: actualCount}, (_, index) => `<input id="password-real-${index}" data-password-test="true" name="notsearch_password" type="${escapeHtmlAttribute(actualType)}" class="${escapeHtmlAttribute(actualClass)}" style="${escapeHtmlAttribute(actualStyle)}" aria-label="${escapeHtmlAttribute(label)}">`).join('')
    : '';
  const decoys = [
    '<input id="decoy-email" data-password-test="true" class="stealthy" name="email" type="password" style="position:absolute;opacity:0;width:1px;height:1px">',
    '<input id="decoy-name" data-password-test="true" class="stealthy" name="name" type="password" style="position:absolute;opacity:0;width:1px;height:1px">'
  ].join('');
  const insertScript = `document.querySelector('#auth-pages').insertAdjacentHTML('beforeend', ${JSON.stringify(`${actualFields}${decoys}<div id="fixture-alert" role="alert"></div>`)});
        document.querySelector('#fixture-alert').textContent = ${JSON.stringify(alertText)};`;
  const attachScript = delay > 0 ? `setTimeout(() => {${insertScript}}, ${delay});` : insertScript;

  return `<!doctype html><html><body>
    <div id="auth-pages"><form id="login"><input id="username" aria-label="Username"></form></div>
    <script>
      window.passwordEnters = [];
      document.querySelector('#login').addEventListener('submit', (event) => event.preventDefault());
      document.addEventListener('keydown', (event) => {
        if(event.key === 'Enter' && event.target.hasAttribute('data-password-test')) window.passwordEnters.push(event.target.id);
      });
      document.querySelector('#username').addEventListener('keydown', (event) => {
        if(event.key !== 'Enter') return;
        event.preventDefault();
        ${usernameRemainsVisible ? '' : 'event.currentTarget.style.display = "none";'}
        ${attachScript}
      });
    </script>
  </body></html>`;
}

describe('real client password evidence contract', () => {
  it('preserves cleanup failure reports that omit password evidence', () => {
    const formatBrowserFailureMessage = (realClientContract as any).formatBrowserFailureMessage;

    expect(typeof formatBrowserFailureMessage).toBe('function');
    expect(formatBrowserFailureMessage({status: 'failed', stage: 'cleanup'})).toBe('real client scenario failed at cleanup');
    expect(formatBrowserFailureMessage({
      status: 'failed',
      stage: 'sign-in',
      passwordEvidence: [{stage: 'alice_password_field_absent', count: 0}]
    })).toBe('real client scenario failed at sign-in; password evidence [{"stage":"alice_password_field_absent","count":0}]');
    expect(() => formatBrowserFailureMessage({
      status: 'failed',
      stage: 'cleanup',
      passwordEvidence: null
    })).toThrow('password evidence is invalid');
  });

  it('keeps only fixed stages and counts in serialized evidence', () => {
    const parsePasswordEvidence = (realClientContract as any).parsePasswordEvidence;
    const evidence = [
      {stage: 'alice_password_field_not_unique', count: 2},
      {stage: 'bob_password_field_ready', count: 1}
    ];

    expect(parsePasswordEvidence(evidence)).toEqual(evidence);
    expect(parsePasswordEvidence([
      {stage: 'alice_password_card_not_reached', count: 0}
    ])).toEqual([{stage: 'alice_password_card_not_reached', count: 0}]);
    const serialized = JSON.stringify(parsePasswordEvidence(evidence));
    expect(serialized).not.toContain(HOSTILE.password);
    expect(serialized).not.toContain(HOSTILE.phrase);
    expect(serialized).not.toContain(HOSTILE.token);
    expect(() => parsePasswordEvidence([
      {stage: 'alice_password_field_hidden', count: 1, hint: HOSTILE.phrase}
    ])).toThrow('password evidence is invalid');
    expect(() => parsePasswordEvidence([
      {stage: 'bob_password_rejected', count: 1, alert: HOSTILE.token}
    ])).toThrow('password evidence is invalid');
    expect(() => parsePasswordEvidence([
      {stage: 'alice_password_field_absent', count: 1}
    ])).toThrow('password evidence is invalid');
  });
});

const USERNAME_ENTRY_RUNTIME = Object.freeze({
  wssEndpoint: 'wss://telegramd.test/apiws',
  fingerprint: '1234567890abcdef',
  webRevision: READINESS_PINS.webRevision,
  artifactDigest: `sha256:${'c'.repeat(64)}`,
  manifestArtifactDigest: `sha256:${'f'.repeat(64)}`
});
const DUMMY_USERNAME = 'runner-contract-user';

function usernameEntryManifest() {
  return {
    artifactDigest: USERNAME_ENTRY_RUNTIME.manifestArtifactDigest,
    endpoint: USERNAME_ENTRY_RUNTIME.wssEndpoint,
    fingerprint: USERNAME_ENTRY_RUNTIME.fingerprint,
    mode: 'private',
    sourceCommit: USERNAME_ENTRY_RUNTIME.webRevision
  };
}

function authProgressMarkup({card = 'ready', delay = 0}: {card?: 'ready' | 'timeout' | 'ambiguous', delay?: number} = {}) {
  const count = card === 'ready' ? 1 : card === 'ambiguous' ? 2 : 0;
  const passwordFields = Array.from({length: count}, (_, index) =>
    `<input id="progress-password-${index}" name="notsearch_password" type="password">`
  ).join('');
  const revealPasswordCard = card === 'timeout' ? '' : `
    document.querySelector('#username').style.display = 'none';
    setTimeout(() => {
      document.querySelector('#auth-pages').insertAdjacentHTML('beforeend', '<form id="password-form">${passwordFields}</form>');
    }, ${delay});`;

  return `<!doctype html><html><body>
    <div id="auth-pages"><form id="login"><input id="username" aria-label="Username"></form></div>
    <script>
      window.authProgressCounts = {usernameSubmissions: 0, passwordFills: 0, passwordSubmissions: 0};
      document.querySelector('#login').addEventListener('submit', (event) => {
        event.preventDefault();
        window.authProgressCounts.usernameSubmissions++;
        ${revealPasswordCard}
      });
      document.addEventListener('input', (event) => {
        if(event.target?.name === 'notsearch_password') window.authProgressCounts.passwordFills++;
      });
      document.addEventListener('keydown', (event) => {
        if(event.key === 'Enter' && event.target?.name === 'notsearch_password') window.authProgressCounts.passwordSubmissions++;
      });
    </script>
  </body></html>`;
}

describe('real client username field readiness', () => {
  let browser: any;
  let fixtureServer: any;
  let fixtureOrigin: string;
  let fixtureMarkup = '';
  let fixtureManifest: any;
  let fixtureRequests: string[];

  beforeAll(async() => {
    fixtureServer = createServer((request, response) => {
      const requestPath = request.url || '/';
      fixtureRequests.push(requestPath);
      if(requestPath === '/') {
        response.writeHead(200, {'content-type': 'text/html'});
        response.end(fixtureMarkup);
      } else if(requestPath === '/mtproto-target.json') {
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify(fixtureManifest));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      fixtureServer.once('error', reject);
      fixtureServer.listen(0, '127.0.0.1', resolve);
    });
    const address = fixtureServer.address();
    if(!address || typeof address === 'string') throw new Error('loopback fixture did not bind');
    fixtureOrigin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({headless: true});
  }, 30_000);

  afterAll(async() => {
    await browser?.close();
    await new Promise<void>((resolve) => fixtureServer?.close(resolve));
  }, 15_000);

  function setFixture(markup: string, manifest: any = usernameEntryManifest()) {
    fixtureMarkup = markup;
    fixtureManifest = manifest;
    fixtureRequests = [];
  }

  async function createRunnerPage() {
    const page = await browser.newPage();
    await page.route('**/*', async(route: any) => {
      const requestUrl = new URL(route.request().url());
      if(requestUrl.origin !== APP_ORIGIN) {
        await route.abort();
        return;
      }
      const response = await fetch(`${fixtureOrigin}${requestUrl.pathname}`);
      await route.fulfill({
        status: response.status,
        headers: {'content-type': response.headers.get('content-type') || 'text/plain'},
        body: await response.text()
      });
    });
    return page;
  }

  async function runAuthProgressRunner({
    card = 'ready',
    failContextClose = false,
    realEmitter = false
  }: {card?: 'ready' | 'timeout' | 'ambiguous', failContextClose?: boolean, realEmitter?: boolean} = {}) {
    setFixture(authProgressMarkup({card}));
    const runId = createHash('sha256').update(`${process.pid}-${Date.now()}-${Math.random()}`).digest('hex').slice(0, 32);
    const screenshotDirectory = `/tmp/real-client-${runId}`;
    const counts = {
      contextCreates: 0,
      contextCloses: 0,
      browserCloses: 0,
      networkStops: 0,
      registryStops: 0,
      registryLaunches: 0,
      controlsRuns: 0
    };
    const ownedBrowser = await chromium.launch({headless: true});
    let pageCounts: any;
    let emittedReport: any;
    let reportBeforeEmission: any;
    let output = '';
    const originalExitCode = process.exitCode;
    process.exitCode = 0;
    const stdoutWrite = realEmitter
      ? vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      }) as any)
      : undefined;
    const syntheticBrowser = {
      async newContext(options: any) {
        counts.contextCreates++;
        const context = await ownedBrowser.newContext(options);
        await context.route('**/*', async(route: any) => {
          const requestUrl = new URL(route.request().url());
          if(requestUrl.origin !== APP_ORIGIN) {
            await route.abort();
            return;
          }
          const response = await fetch(`${fixtureOrigin}${requestUrl.pathname}`);
          await route.fulfill({
            status: response.status,
            headers: {'content-type': response.headers.get('content-type') || 'text/plain'},
            body: await response.text()
          });
        });
        return {
          newPage: () => context.newPage(),
          async close() {
            counts.contextCloses++;
            if(failContextClose) throw new Error('synthetic_context_close_failed');
            await context.close();
          }
        };
      },
      async close() {
        counts.browserCloses++;
        await ownedBrowser.close();
      }
    };
    const registry = {
      discoveryActive: true,
      foreignTargets: 0,
      contextlessTargets: 0,
      appContextlessTargets: 0,
      async launch() {
        counts.registryLaunches++;
      },
      registerContext() {},
      async waitForSetup() {},
      async stop() {
        counts.registryStops++;
        return {detachFailures: 0, discoveryDisabled: true};
      }
    };

    try {
      const runtimeConfig = {
        runId,
        endpoint: APP_ORIGIN,
        wssEndpoint: USERNAME_ENTRY_RUNTIME.wssEndpoint,
        fingerprint: USERNAME_ENTRY_RUNTIME.fingerprint,
        publicKeySHA256: 'a'.repeat(64),
        artifactDigest: USERNAME_ENTRY_RUNTIME.artifactDigest,
        manifestArtifactDigest: USERNAME_ENTRY_RUNTIME.manifestArtifactDigest,
        webRevision: USERNAME_ENTRY_RUNTIME.webRevision,
        leafSPKI: Buffer.alloc(32, 1).toString('base64'),
        frontIp: '127.0.0.1',
        screenshotDirectory,
        authProgressOneSubmission: true,
        accounts: [{username: `u${runId.slice(0, 30)}a`, password: 'b'.repeat(64)}]
      };
      await runRealClient({
        runtimeConfig,
        launchBrowser: async() => syntheticBrowser,
        createWorkerDiscovery: () => registry,
        runObserverControls: async() => {
          counts.controlsRuns++;
          return {controls: controlBlocks(), failedControls: [] as string[]};
        },
        ...(realEmitter ? {
          emitAuthProgressReport: (report: any, cleanupFailed: boolean) => {
            reportBeforeEmission = report;
            emitAuthProgressReport(report, cleanupFailed);
          }
        } : {
          emitAuthProgressReport: (report: any, cleanupFailed: boolean) => {
            reportBeforeEmission = report;
            emittedReport = cleanupFailed ? {...report, status: 'failed', stage: 'cleanup'} : report;
          }
        }),
        authProgressDependencies: {
          submitUsernameOnceAndWaitForPassword: async(...args: any[]) => {
            try {
              await submitUsernameOnceAndWaitForPassword(...args.slice(0, 6), card === 'timeout' ? 100 : 1000, args[7]);
            } finally {
              pageCounts = await args[0].evaluate((): any => (window as any).authProgressCounts).catch((_: any): null => null);
            }
          },
          createNetworkObserver: (_page: any, _name: string, observer: any) => createAuthProgressNetworkObserver(observer, () => counts.networkStops++)
        }
      });

      return {
        report: realEmitter ? JSON.parse(output.trim()) : emittedReport,
        reportBeforeEmission,
        output,
        counts,
        pageCounts,
        exitCode: process.exitCode,
        screenshotExists: existsSync(screenshotDirectory),
        fixtureRequests: [...fixtureRequests]
      };
    } finally {
      stdoutWrite?.mockRestore();
      process.exitCode = originalExitCode;
      await ownedBrowser.close();
      rmSync(screenshotDirectory, {recursive: true, force: true});
    }
  }

  function runOuterAuthProgressRunner(browserOutput: string, {browserExitCode = 0, failRunnerCleanup = false}: {browserExitCode?: number, failRunnerCleanup?: boolean} = {}) {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'real-client-runner-contract-'));
    const secretDirectory = mkdtempSync(join(tmpdir(), `telegram-fixture-${READINESS_PINS.runId}.`));
    const passwordFiles = [join(secretDirectory, 'a-password'), join(secretDirectory, 'b-password')];
    const statePath = join(fixtureDirectory, 'docker-state.json');
    const readinessPath = join(fixtureDirectory, 'readiness.jsonl');
    const browserOutputPath = join(fixtureDirectory, 'browser-output.jsonl');
    const cleanupPath = join(fixtureDirectory, 'cleanup.log');
    const browserInputPath = join(fixtureDirectory, 'browser-input.json');
    const runLabel = 'org.teagram.fixture.run';
    const browserName = `telegram-fixture-${READINESS_PINS.runId}browser`;
    const edgeName = `telegram-fixture-${READINESS_PINS.runId}edge`;
    const serverName = `telegram-fixture-${READINESS_PINS.runId}server`;
    const browser = {
      NetworkSettings: {Networks: {[edgeName]: {IPAddress: '172.20.0.2'}}},
      Config: {Labels: {[runLabel]: READINESS_PINS.runId}, Env: [] as string[], User: '1001:1001'},
      HostConfig: {
        NetworkMode: edgeName,
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true', 'seccomp=fixture-profile'],
        PortBindings: {}
      },
      Mounts: [] as {Type?: string}[]
    };
    const front = {
      NetworkSettings: {Networks: {
        [edgeName]: {IPAddress: '172.20.0.3'},
        [serverName]: {IPAddress: '172.19.0.2'}
      }},
      Config: {Labels: {[runLabel]: READINESS_PINS.runId}, Env: [] as string[], User: '1001:1001'},
      HostConfig: {
        NetworkMode: edgeName,
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        PortBindings: {}
      },
      Mounts: [] as {Type?: string}[]
    };
    const network = {Labels: {[runLabel]: READINESS_PINS.runId}, Internal: true, EnableIPv6: false};
    const serverReady = {
      ...buildServerReady(),
      credentials: passwordFiles.map((passwordFile, index) => ({
        username: `u${READINESS_PINS.runId.slice(0, 30)}${index === 0 ? 'a' : 'b'}`,
        passwordFile
      }))
    };
    const artifactReady = buildArtifactReady(serverReady);
    const dockerScript = [
      '#!/usr/bin/env node',
      'const {appendFileSync, readFileSync} = require(\'node:fs\');',
      'const args = process.argv.slice(2);',
      'const state = JSON.parse(readFileSync(process.env.REAL_CLIENT_DOCKER_FIXTURE_STATE, \'utf8\'));',
      'const write = (value) => process.stdout.write(typeof value === \'string\' ? value : JSON.stringify(value));',
      'if(args[0] === \'inspect\') write(args.at(-1) === state.browserName ? state.browser : state.front);',
      'else if(args[0] === \'network\') write(state.network);',
      'else if(args[0] === \'exec\') {',
      '  if(args.includes(\'/proc/net/route\')) write(\'Iface Destination Gateway\\n\');',
      '  else if(args.includes(\'/proc/net/ipv6_route\')) {}',
      '  else if(args.includes(\'node\')) { appendFileSync(state.browserInputPath, readFileSync(0, \'utf8\')); write(readFileSync(state.browserOutputPath, \'utf8\')); if(state.browserExitCode) process.exitCode = state.browserExitCode; }',
      '  else if(args.includes(\'rm\')) { appendFileSync(state.cleanupPath, `${args.at(-1)}\\n`); if(state.failRunnerCleanup && args.at(-1).endsWith(\'-runner\')) process.exitCode = 1; }',
      '}'
    ].join('\n');
    const dockerPath = join(fixtureDirectory, 'docker');
    const runnerPath = resolve(process.cwd(), 'scripts/real-client/run.mjs');

    try {
      passwordFiles.forEach((passwordFile, index) => {
        writeFileSync(passwordFile, `${String(index + 1).repeat(64)}\n`, {mode: 0o400});
        chmodSync(passwordFile, 0o400);
      });
      writeFileSync(readinessPath, `${[serverReady, artifactReady].map((event) => JSON.stringify(event)).join('\n')}\n`);
      writeFileSync(browserOutputPath, browserOutput);
      writeFileSync(statePath, JSON.stringify({
        browserName,
        browser,
        front,
        network,
        browserOutputPath,
        browserExitCode,
        browserInputPath,
        cleanupPath,
        failRunnerCleanup
      }));
      writeFileSync(dockerPath, dockerScript, {mode: 0o755});
      chmodSync(dockerPath, 0o755);

      const result = spawnSync(process.execPath, [runnerPath,
        '--readiness-file', readinessPath,
        '--harness-revision', READINESS_PINS.harnessRevision,
        '--server-revision', READINESS_PINS.serverRevision,
        '--web-revision', READINESS_PINS.webRevision,
        '--run-id', READINESS_PINS.runId,
        '--auth-progress-one-submission'
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fixtureDirectory}:${process.env.PATH}`,
          REAL_CLIENT_DOCKER_FIXTURE_STATE: statePath
        }
      });
      return {
        ...result,
        cleanup: existsSync(cleanupPath) ? readFileSync(cleanupPath, 'utf8').trim().split('\n') : [],
        artifactReady,
        browserInput: existsSync(browserInputPath) ? JSON.parse(readFileSync(browserInputPath, 'utf8')) : undefined
      };
    } finally {
      rmSync(fixtureDirectory, {recursive: true, force: true});
      rmSync(secretDirectory, {recursive: true, force: true});
    }
  }

  async function startPasswordStage(page: any, evidence: any[], name = 'alice', timeoutMs = 1000) {
    const username = await prepareUsernameEntry(page, name, USERNAME_ENTRY_RUNTIME);
    const usernameField = await username.elementHandle();
    try {
      await username.fill(DUMMY_USERNAME);
      await username.press('Enter');
      const password = await waitForPasswordField(page, usernameField, name, evidence, timeoutMs);
      return {usernameField, password};
    } catch(error) {
      await usernameField?.dispose();
      throw error;
    }
  }

  async function passwordInputValues(page: any) {
    return page.locator('#auth-pages input[data-password-test]').evaluateAll((inputs: HTMLInputElement[]) => inputs.map((input) => input.value));
  }

  it('submits Username once and stops at the masked password-card boundary', async() => {
    setFixture(authProgressMarkup());
    const page = await createRunnerPage();
    const passwordEvidence: any[] = [];
    const actionCounts = {usernameSubmissions: 0};
    try {
      await submitUsernameOnceAndWaitForPassword(
        page,
        {username: DUMMY_USERNAME},
        USERNAME_ENTRY_RUNTIME,
        'alice',
        passwordEvidence,
        actionCounts,
        1000
      );

      expect(actionCounts.usernameSubmissions).toBe(1);
      expect(passwordEvidence).toEqual([{stage: 'alice_password_field_ready', count: 1}]);
      expect(await page.evaluate(() => (window as any).authProgressCounts)).toEqual({
        usernameSubmissions: 1,
        passwordFills: 0,
        passwordSubmissions: 0
      });
      expect(await page.locator('#auth-pages input[name="notsearch_password"]').evaluateAll((inputs: HTMLInputElement[]) => inputs.map((input) => input.value)))
      .toEqual(['']);
      expect(await page.locator('#page-chats').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('runs auth progress through teardown with one Alice context and no later scenarios', async() => {
    const result = await runAuthProgressRunner({realEmitter: true});

    expect(result.report).toMatchObject({
      status: 'passed',
      usernameSubmissions: 1,
      passwordFills: 0,
      passwordSubmissions: 0,
      bobContextCount: 0,
      laterScenarioCount: 0,
      contextCount: 1
    });
    expect(result.reportBeforeEmission.network.contexts.alice.workerTargets).toEqual({shared_worker: 1, service_worker: 1});
    expect(JSON.parse(result.output.trim()).network.contexts.alice.workerTargets).toEqual({shared_worker: 1, service_worker: 1});
    expect(parseAuthProgressReport(result.report)).toEqual(result.report);
    expect(result.report.network.websocket_101_by_context_phase).toEqual(emptyWebSocket101Grid());
    expect(JSON.parse(result.output.trim()).network.websocket_101_by_context_phase).toEqual(emptyWebSocket101Grid());
    expect(parseAuthProgressReport(result.report).network.contexts.alice.workerTargets).toEqual({shared_worker: 1, service_worker: 1});
    expect(Object.keys(result.report.network.contexts.alice.workerTargets).sort()).toEqual(['service_worker', 'shared_worker']);
    expect(result.report.network.contexts.alice.attemptsBySource).toEqual({page: 0, shared_worker: 0, service_worker: 1, worker: 0});
    expect(result.report.network.contexts.alice.unexpectedAttemptsBySource).toEqual({page: 0, shared_worker: 0, service_worker: 0, worker: 0});
    expect(result.report.network.contexts.alice.allowedWebSocketsBySource).toEqual({page: 0, shared_worker: 0, service_worker: 1, worker: 0});
    expect(result.counts).toEqual({
      contextCreates: 1,
      contextCloses: 1,
      browserCloses: 1,
      networkStops: 1,
      registryStops: 1,
      registryLaunches: 1,
      controlsRuns: 1
    });
    expect(result.screenshotExists).toBe(false);
    expect(result.pageCounts).toEqual({
      usernameSubmissions: 1,
      passwordFills: 0,
      passwordSubmissions: 0
    });
    expect(result.fixtureRequests).toEqual(['/', '/mtproto-target.json']);

    const outer = runOuterAuthProgressRunner(result.output);
    expect(outer.status).toBe(0);
    expect(outer.stderr).toBe('');
    expect(outer.cleanup).toHaveLength(2);
    expect(outer.stdout.trim().split('\n')).toHaveLength(1);
    const finalReport = JSON.parse(outer.stdout.trim());
    expect(finalReport).toMatchObject(result.report);
    expect(finalReport.network).toEqual(result.report.network);
    expect(finalReport.network.contexts.alice.workerTargets).toEqual({shared_worker: 1, service_worker: 1});
    expect(finalReport.artifactDigest).toBe(outer.artifactReady.artifactDigest);
    expect(outer.browserInput).toMatchObject({
      artifactDigest: outer.artifactReady.artifactDigest,
      manifestArtifactDigest: outer.artifactReady.manifestArtifactDigest
    });

    const cleanupFailure = runOuterAuthProgressRunner(result.output, {failRunnerCleanup: true});
    expect(cleanupFailure.status).toBe(1);
    expect(cleanupFailure.cleanup).toHaveLength(2);
    const cleanupReport = JSON.parse(cleanupFailure.stdout.trim());
    expect(cleanupReport).toMatchObject({...result.report, status: 'failed', stage: 'cleanup'});
    expect(cleanupReport.network).toEqual(result.report.network);
  });

  it('reports a timeout after cleaning up and exits nonzero', async() => {
    const result = await runAuthProgressRunner({card: 'timeout', realEmitter: true});

    expect(result.report).toMatchObject({
      status: 'failed',
      stage: 'alice_password_card_not_reached',
      usernameSubmissions: 1,
      passwordEvidence: [{stage: 'alice_password_card_not_reached', count: 0}],
      bobContextCount: 0,
      laterScenarioCount: 0,
      contextCount: 1
    });
    expect(parseAuthProgressReport(result.report)).toEqual(result.report);
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({
      contextCreates: 1,
      contextCloses: 1,
      browserCloses: 1,
      networkStops: 1,
      registryStops: 1,
      registryLaunches: 1,
      controlsRuns: 1
    });
    expect(result.screenshotExists).toBe(false);
    expect(result.pageCounts).toEqual({
      usernameSubmissions: 1,
      passwordFills: 0,
      passwordSubmissions: 0
    });

    const outer = runOuterAuthProgressRunner(result.output, {browserExitCode: 1});
    expect(outer.status).toBe(1);
    expect(outer.stderr).toBe('');
    expect(outer.cleanup).toHaveLength(2);
    expect(JSON.parse(outer.stdout.trim())).toMatchObject(result.report);
  });

  it('emits a cleanup failure and exits nonzero when the app context cannot close', async() => {
    const result = await runAuthProgressRunner({failContextClose: true, realEmitter: true});

    expect(result.report).toMatchObject({
      status: 'failed',
      stage: 'cleanup',
      usernameSubmissions: 1,
      contextCount: 1
    });
    expect(parseAuthProgressReport(result.report)).toEqual(result.report);
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({
      contextCreates: 1,
      contextCloses: 1,
      browserCloses: 1,
      networkStops: 1,
      registryStops: 1,
      registryLaunches: 1,
      controlsRuns: 1
    });
    expect(result.screenshotExists).toBe(false);
    const outer = runOuterAuthProgressRunner(result.output, {browserExitCode: 1});
    expect(outer.status).toBe(1);
    expect(outer.cleanup).toHaveLength(2);
    expect(JSON.parse(outer.stdout.trim())).toMatchObject(result.report);
  });

  it('records a fixed timeout stage after one Username submission without retrying', async() => {
    setFixture(authProgressMarkup({card: 'timeout'}));
    const page = await createRunnerPage();
    const passwordEvidence: any[] = [];
    const actionCounts = {usernameSubmissions: 0};
    try {
      await expect(submitUsernameOnceAndWaitForPassword(
        page,
        {username: DUMMY_USERNAME},
        USERNAME_ENTRY_RUNTIME,
        'alice',
        passwordEvidence,
        actionCounts,
        500
      )).rejects.toThrow('alice_password_card_not_reached');

      expect(actionCounts.usernameSubmissions).toBe(1);
      expect(passwordEvidence).toEqual([{stage: 'alice_password_card_not_reached', count: 0}]);
      expect(await page.evaluate(() => (window as any).authProgressCounts)).toEqual({
        usernameSubmissions: 1,
        passwordFills: 0,
        passwordSubmissions: 0
      });
    } finally {
      await page.close();
    }
  });

  it('records an ambiguous password card after one Username submission without acting on a password', async() => {
    setFixture(authProgressMarkup({card: 'ambiguous'}));
    const page = await createRunnerPage();
    const passwordEvidence: any[] = [];
    const actionCounts = {usernameSubmissions: 0};
    try {
      await expect(submitUsernameOnceAndWaitForPassword(
        page,
        {username: DUMMY_USERNAME},
        USERNAME_ENTRY_RUNTIME,
        'alice',
        passwordEvidence,
        actionCounts,
        1000
      )).rejects.toThrow('alice_password_field_not_unique');

      expect(actionCounts.usernameSubmissions).toBe(1);
      expect(passwordEvidence).toEqual([{stage: 'alice_password_field_not_unique', count: 2}]);
      expect(await page.evaluate(() => (window as any).authProgressCounts)).toEqual({
        usernameSubmissions: 1,
        passwordFills: 0,
        passwordSubmissions: 0
      });
      expect(await page.locator('#auth-pages input[name="notsearch_password"]').evaluateAll((inputs: HTMLInputElement[]) => inputs.map((input) => input.value)))
      .toEqual(['', '']);
    } finally {
      await page.close();
    }
  });

  it('reaches a delayed Username field without a legacy entry button', async() => {
    setFixture(usernameReadinessMarkup({delay: 100}));
    const page = await createRunnerPage();
    try {
      const username = await prepareUsernameEntry(page, 'alice', USERNAME_ENTRY_RUNTIME);

      expect(await username.count()).toBe(1);
      expect(await username.isVisible()).toBe(true);
      await username.fill(DUMMY_USERNAME);
      expect(await username.inputValue()).toBe(DUMMY_USERNAME);
      expect(await page.evaluate(() => (window as any).formSubmissions)).toBe(0);
      expect(fixtureRequests.slice(0, 2)).toEqual(['/', '/mtproto-target.json']);
    } finally {
      await page.close();
    }
  });

  it('does not click a visible legacy-style decoy while waiting for Username', async() => {
    setFixture(usernameReadinessMarkup({delay: 100, legacyButton: true}));
    const page = await createRunnerPage();
    try {
      const username = await prepareUsernameEntry(page, 'alice', USERNAME_ENTRY_RUNTIME);

      expect(await username.isVisible()).toBe(true);
      await username.fill(DUMMY_USERNAME);
      expect(await username.inputValue()).toBe(DUMMY_USERNAME);
      expect(await page.evaluate(() => (window as any).legacyClicks)).toBe(0);
      expect(await page.evaluate(() => (window as any).formSubmissions)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('accepts an immediately visible Username field', async() => {
    setFixture(usernameReadinessMarkup());
    const page = await createRunnerPage();
    try {
      const username = await prepareUsernameEntry(page, 'alice', USERNAME_ENTRY_RUNTIME);

      expect(await username.isVisible()).toBe(true);
      expect(await username.inputValue()).toBe('');
      expect(await page.evaluate(() => (window as any).formSubmissions)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('fails at Username readiness when the field never appears', async() => {
    setFixture(usernameReadinessMarkup({fieldCount: 0}));
    const page = await createRunnerPage();
    try {
      await expect(prepareUsernameEntry(page, 'alice', USERNAME_ENTRY_RUNTIME)).rejects.toThrow('alice_username_field');
      expect(await page.locator('input[aria-label="Username"]').count()).toBe(0);
      expect(await page.evaluate(() => (window as any).formSubmissions)).toBe(0);
      expect(fixtureRequests.slice(0, 2)).toEqual(['/', '/mtproto-target.json']);
    } finally {
      await page.close();
    }
  }, 40_000);

  it('fails safely when multiple accessible Username fields match', async() => {
    setFixture(usernameReadinessMarkup({fieldCount: 2}));
    const page = await createRunnerPage();
    try {
      await expect(prepareUsernameEntry(page, 'alice', USERNAME_ENTRY_RUNTIME)).rejects.toThrow('alice_username_field_not_unique');
      expect(await page.locator('input[aria-label="Username"]').evaluateAll((inputs: HTMLInputElement[]) => inputs.map((input) => input.value)))
      .toEqual(['', '']);
      expect(await page.evaluate(() => (window as any).formSubmissions)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('validates the private manifest before waiting for Username', async() => {
    setFixture(usernameReadinessMarkup(), {...usernameEntryManifest(), fingerprint: 'different-fingerprint'});
    const page = await createRunnerPage();
    try {
      await expect(prepareUsernameEntry(page, 'alice', USERNAME_ENTRY_RUNTIME)).rejects.toThrow('alice_manifest_mismatch');
      expect(fixtureRequests.slice(0, 2)).toEqual(['/', '/mtproto-target.json']);
    } finally {
      await page.close();
    }
  });

  it('rejects a served manifest that carries the staged artifact digest instead of its own', async() => {
    setFixture(usernameReadinessMarkup(), {...usernameEntryManifest(), artifactDigest: USERNAME_ENTRY_RUNTIME.artifactDigest});
    const page = await createRunnerPage();
    try {
      await expect(prepareUsernameEntry(page, 'alice', USERNAME_ENTRY_RUNTIME)).rejects.toThrow('alice_manifest_mismatch');
    } finally {
      await page.close();
    }
  });

  it('fills and submits only the named masked field with both decoys and an account hint label', async() => {
    const outcomes = [];
    for(const label of ['Password', HOSTILE.phrase]) {
      setFixture(passwordStageMarkup({label, alertText: HOSTILE.token}));
      const page = await createRunnerPage();
      const evidence: any[] = [];
      try {
        const {usernameField, password} = await startPasswordStage(page, evidence);
        await submitPassword(password, usernameField, HOSTILE.password, 'alice', evidence);
        outcomes.push({
          values: await passwordInputValues(page),
          entered: await page.evaluate(() => (window as any).passwordEnters),
          evidence
        });
      } finally {
        await page.close();
      }
    }

    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toEqual({
      values: [HOSTILE.password, '', ''],
      entered: ['password-real-0'],
      evidence: [{stage: 'alice_password_field_ready', count: 1}]
    });
    const serializedEvidence = JSON.stringify(outcomes.map((outcome) => outcome.evidence));
    expect(serializedEvidence).not.toContain(HOSTILE.password);
    expect(serializedEvidence).not.toContain(HOSTILE.phrase);
    expect(serializedEvidence).not.toContain(HOSTILE.token);
  });

  it('waits for the named password field to mount inside the readiness bound', async() => {
    setFixture(passwordStageMarkup({delay: 50}));
    const page = await createRunnerPage();
    const evidence: any[] = [];
    try {
      const {usernameField, password} = await startPasswordStage(page, evidence);
      await submitPassword(password, usernameField, HOSTILE.password, 'alice', evidence);
      expect(evidence).toEqual([{stage: 'alice_password_field_ready', count: 1}]);
      expect(await passwordInputValues(page)).toEqual([HOSTILE.password, '', '']);
    } finally {
      await page.close();
    }
  });

  it('does not accept a password field that mounts after the readiness wait times out', async() => {
    setFixture(passwordStageMarkup({delay: 50}));
    const page = await createRunnerPage();
    const evidence: any[] = [];
    const originalWaitForFunction = page.waitForFunction.bind(page);
    (page as any).waitForFunction = async(pageFunction: any, argument: any, options: any) => {
      try {
        return await originalWaitForFunction(pageFunction, argument, {...options, timeout: 1});
      } catch(error) {
        if((error as any)?.name !== 'TimeoutError') throw error;
        const lateMount = await originalWaitForFunction(
          () => Boolean(document.querySelector('#auth-pages input[name="notsearch_password"]')),
          undefined,
          {timeout: 500}
        );
        await lateMount.dispose();
        throw error;
      }
    };

    try {
      await expect(startPasswordStage(page, evidence, 'alice', 1000)).rejects.toThrow('alice_password_card_not_reached');
      expect(evidence).toEqual([{stage: 'alice_password_card_not_reached', count: 1}]);
      expect(await passwordInputValues(page)).toEqual(['', '', '']);
    } finally {
      await page.close();
    }
  });

  it('fails with a fixed absent stage when only stealthy password decoys exist', async() => {
    setFixture(passwordStageMarkup({includeActual: false}));
    const page = await createRunnerPage();
    const evidence: any[] = [];
    try {
      await expect(startPasswordStage(page, evidence)).rejects.toThrow('alice_password_field_absent');
      expect(evidence).toEqual([{stage: 'alice_password_field_absent', count: 0}]);
      expect(await passwordInputValues(page)).toEqual(['', '']);
    } finally {
      await page.close();
    }
  });

  it('fails with a fixed hidden stage when the real field is hidden beside decoys', async() => {
    setFixture(passwordStageMarkup({actualStyle: 'display:none'}));
    const page = await createRunnerPage();
    const evidence: any[] = [];
    try {
      await expect(startPasswordStage(page, evidence)).rejects.toThrow('alice_password_field_hidden');
      expect(evidence).toEqual([{stage: 'alice_password_field_hidden', count: 1}]);
      expect(await passwordInputValues(page)).toEqual(['', '', '']);
    } finally {
      await page.close();
    }
  });

  it('fails with a fixed non-unique stage when two named fields exist', async() => {
    setFixture(passwordStageMarkup({actualCount: 2}));
    const page = await createRunnerPage();
    const evidence: any[] = [];
    try {
      await expect(startPasswordStage(page, evidence)).rejects.toThrow('alice_password_field_not_unique');
      expect(evidence).toEqual([{stage: 'alice_password_field_not_unique', count: 2}]);
      expect(await passwordInputValues(page)).toEqual(['', '', '', '']);
    } finally {
      await page.close();
    }
  });

  it('fails with a fixed unmasked stage when the named field is a text input', async() => {
    setFixture(passwordStageMarkup({actualType: 'text'}));
    const page = await createRunnerPage();
    const evidence: any[] = [];
    try {
      await expect(startPasswordStage(page, evidence)).rejects.toThrow('alice_password_field_unmasked');
      expect(evidence).toEqual([{stage: 'alice_password_field_unmasked', count: 1}]);
      expect(await passwordInputValues(page)).toEqual(['', '', '']);
    } finally {
      await page.close();
    }
  });

  it('fails with a fixed card-not-reached stage while Username remains visible', async() => {
    setFixture(passwordStageMarkup({includeActual: false, usernameRemainsVisible: true}));
    const page = await createRunnerPage();
    const evidence: any[] = [];
    try {
      await expect(startPasswordStage(page, evidence)).rejects.toThrow('alice_password_card_not_reached');
      expect(evidence).toEqual([{stage: 'alice_password_card_not_reached', count: 0}]);
      expect(await passwordInputValues(page)).toEqual(['', '']);
    } finally {
      await page.close();
    }
  });

  it('never treats a stealthy named match as ready', async() => {
    setFixture(passwordStageMarkup({actualClass: 'stealthy'}));
    const page = await createRunnerPage();
    const evidence: any[] = [];
    try {
      await expect(startPasswordStage(page, evidence)).rejects.toThrow('alice_password_field_hidden');
      expect(evidence).toEqual([{stage: 'alice_password_field_hidden', count: 1}]);
      expect(await passwordInputValues(page)).toEqual(['', '', '']);
    } finally {
      await page.close();
    }
  });

  it('rechecks the named-field count before filling', async() => {
    setFixture(passwordStageMarkup());
    const page = await createRunnerPage();
    const evidence: any[] = [];
    let usernameField: any;
    try {
      const ready = await startPasswordStage(page, evidence);
      usernameField = ready.usernameField;
      await page.locator('#auth-pages').evaluate((root: HTMLElement) => {
        const input = document.createElement('input');
        input.id = 'password-real-added';
        input.name = 'notsearch_password';
        input.type = 'password';
        input.setAttribute('data-password-test', 'true');
        root.append(input);
      });

      await expect(submitPassword(ready.password, usernameField, HOSTILE.password, 'alice', evidence)).rejects.toThrow('alice_password_field_not_unique');
      expect(evidence).toEqual([{stage: 'alice_password_field_not_unique', count: 2}]);
      expect(await passwordInputValues(page)).toEqual(['', '', '', '']);
    } finally {
      await usernameField?.dispose();
      await page.close();
    }
  });

  it('rechecks the masked type before filling', async() => {
    setFixture(passwordStageMarkup());
    const page = await createRunnerPage();
    const evidence: any[] = [];
    let usernameField: any;
    try {
      const ready = await startPasswordStage(page, evidence);
      usernameField = ready.usernameField;
      await page.locator('#password-real-0').evaluate((input: HTMLInputElement) => {input.type = 'text'});

      await expect(submitPassword(ready.password, usernameField, HOSTILE.password, 'alice', evidence)).rejects.toThrow('alice_password_field_unmasked');
      expect(evidence).toEqual([{stage: 'alice_password_field_unmasked', count: 1}]);
      expect(await passwordInputValues(page)).toEqual(['', '', '']);
    } finally {
      await usernameField?.dispose();
      await page.close();
    }
  });
});

describe('real client centre-column failure state', () => {
  let browser: any;

  beforeAll(async() => {
    browser = await chromium.launch({headless: true});
  }, 30_000);

  afterAll(async() => {
    await browser?.close();
  }, 15_000);

  // The production chat keeps the composer and its height mirror side by side,
  // both `.input-message-input` and both contenteditable.
  function chatMarkup({editable = 'true', chatInput = 'chat-input', control = '', extraInput = ''} = {}) {
    return `<div id="column-center"><div class="chats-container">
      <div class="chat tabs-tab active">
        <div class="topbar"><div class="chat-info"><div class="avatar" data-peer-id="1000002"></div>${HOSTILE.username}</div></div>
        <div class="bubbles"><div class="bubble"><div class="message">${HOSTILE.phrase}</div></div></div>
        <div class="${chatInput}"><div class="input-message-container">
          <div class="input-message-input" contenteditable="${editable}">${HOSTILE.password}</div>
          <div class="input-message-input input-field-input-fake" contenteditable="true" style="opacity:0;position:absolute;top:0;z-index:-3"></div>
          ${extraInput}
        </div></div>
        <div class="chat-input-control">${control}</div>
      </div>
    </div></div>`;
  }

  // A delivered text bubble as tweb renders it: the text, then the time span
  // with its time, its `.time-inner` copy and the delivery status icon.
  function receivedMessageMarkup(texts: string[]) {
    const time = '<span class="i18n" dir="auto">12:34</span>';
    return `<div id="column-center"><div class="bubbles">${texts.map((text) => `<div class="bubble"><div class="message spoilers-container"><div>${text}</div><span class="time">${time}<div class="time-inner">${time}<span class="tgico time-sending-status">\uE900</span></div></span><div class="clearfix"></div></div></div>`).join('')}</div></div>`;
  }

  async function receivedMessages(page: any, texts: string[]) {
    await page.setContent(receivedMessageMarkup(texts));
    return page.locator('#column-center .bubble .message').filter({hasText: 'browser-ci-hello'});
  }

  it('matches the delivered message text and not the time and status beside it', async() => {
    const page = await browser.newPage();
    try {
      const messages = await receivedMessages(page, ['browser-ci-hello']);
      expect(getSingleExactMessageFailure(await messages.allInnerTexts(), 'browser-ci-hello')).toBe('content');
      expect(await getSingleExactMessageTextFailure(messages, 'browser-ci-hello')).toBe(null);
    } finally {
      await page.close();
    }
  });

  it('still rejects a near-miss message text or a second matching bubble', async() => {
    const page = await browser.newPage();
    try {
      expect(await getSingleExactMessageTextFailure(await receivedMessages(page, ['browser-ci-hello!']), 'browser-ci-hello')).toBe('content');
      expect(await getSingleExactMessageTextFailure(await receivedMessages(page, [' browser-ci-hello']), 'browser-ci-hello')).toBe('content');
      expect(await getSingleExactMessageTextFailure(await receivedMessages(page, ['browser-ci-hello', 'browser-ci-hello']), 'browser-ci-hello')).toBe('count');
    } finally {
      await page.close();
    }
  });

  // Emoji that `wrapRichText` draws as a custom emoji or an image keep their
  // characters only in `data-sticker-emoji` and `alt`.
  it('counts emoji drawn as custom emoji or images as message text', async() => {
    const page = await browser.newPage();
    try {
      const customEmoji = '<custom-emoji-element class="custom-emoji" data-doc-id="1" data-sticker-emoji="\u{1F600}"></custom-emoji-element>';
      const imageEmoji = '<img class="emoji emoji-image" src="assets/img/emoji/1f600.png" alt="\u{1F600}">';
      expect(await getSingleExactMessageTextFailure(await receivedMessages(page, [`browser-ci-hello${customEmoji}`]), 'browser-ci-hello')).toBe('content');
      expect(await getSingleExactMessageTextFailure(await receivedMessages(page, [`browser-ci-hello${imageEmoji}`]), 'browser-ci-hello')).toBe('content');
      expect(await getSingleExactMessageTextFailure(await receivedMessages(page, [`browser-ci-hello${customEmoji}`]), 'browser-ci-hello\u{1F600}')).toBe(null);
      expect(await getSingleExactMessageTextFailure(await receivedMessages(page, [`browser-ci-hello${imageEmoji}`]), 'browser-ci-hello\u{1F600}')).toBe(null);
    } finally {
      await page.close();
    }
  });

  it('waits for the editable composer and not its height mirror', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(chatMarkup());
      const input = await openComposer(page, 'alice_direct_chat');
      expect(await input.count()).toBe(1);
      expect(await input.evaluate((element: HTMLElement) => element.classList.contains('input-field-input-fake'))).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('records a composer wait that two matching inputs end, without page text', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(chatMarkup({extraInput: '<div class="input-message-input" contenteditable="true"></div>'}));
      await expect(openComposer(page, 'alice_direct_chat')).rejects.toThrow('alice_direct_chat_composer');
      const state = await captureCenterColumnState();
      expect(state).toEqual({
        chatCount: 1,
        activeChatCount: 1,
        activePeerId: '1000002',
        composerMatches: 2,
        composerInputs: 2,
        composerFakeInputs: 1,
        composerVisible: 2,
        composerEditable: 2,
        chatInput: 'visible',
        controlBar: 'none',
        selectedPeerId: null,
        composerWait: 'strict_mode_violation',
        pageErrorsSinceSelection: null,
        consoleErrorsSinceSelection: null,
        rpcErrorsSinceSelection: null,
        rpcErrorTypesSinceSelection: null
      });
      expect(parseCenterColumnState(state)).toEqual(state);
      expectNoHostileLeak(state);
      expect(JSON.stringify(state)).not.toContain('Unblock');
    } finally {
      await page.close();
    }
  });

  it('names a bottom bar that replaced the composer and counts client and RPC errors since selection', async() => {
    const page = await browser.newPage();
    try {
      await countClientErrors(page);
      const markup = chatMarkup({
        editable: 'false',
        chatInput: 'chat-input is-hidden',
        control: '<button class="btn-primary chat-input-control-button">Unblock</button>'
      });
      await page.route(`${APP_ORIGIN}/**`, (route: any) => route.fulfill({contentType: 'text/html', body: markup}));
      await page.goto(`${APP_ORIGIN}/`);
      // A worker port as the app uses it; an error before selection is the baseline.
      await page.evaluate(() => {
        const channel = new MessageChannel();
        channel.port2.addEventListener('message', () => {});
        channel.port2.start();
        (window as any).workerPort = channel.port1;
        channel.port1.postMessage({type: 'result', payload: {taskId: 1, error: {type: 'SESSION_PASSWORD_NEEDED', code: 401}}});
      });
      await page.waitForTimeout(50);
      await page.evaluate((text: string) => {
        const port = (window as any).workerPort;
        port.postMessage({type: 'batch', payload: [
          {type: 'result', payload: {taskId: 2, error: {type: 'PEER_ID_INVALID', code: 400, description: text}}},
          {type: 'result', payload: {taskId: 3, result: text}}
        ]});
        port.postMessage({type: 'ack', payload: {taskId: 4, cached: true, error: {type: text, message: text}}});
        port.postMessage({type: 'invoke', payload: {type: 'invoke', payload: text}});
        console.error(text);
        setTimeout(() => {
          throw new Error(text);
        });
      }, HOSTILE.phrase);
      await page.waitForTimeout(100);
      const state = await captureCenterColumnState({
        page,
        selectedPeerId: '1000002',
        errorsAtSelection: {pageErrors: 0, consoleErrors: 0, rpc: {total: 1, byType: {SESSION_PASSWORD_NEEDED: 1}}},
        composerWait: 'timeout'
      });
      expect(state).toMatchObject({
        activePeerId: '1000002',
        selectedPeerId: '1000002',
        composerEditable: 0,
        chatInput: 'hidden',
        controlBar: 'unblock',
        composerWait: 'timeout',
        pageErrorsSinceSelection: 1,
        consoleErrorsSinceSelection: 1,
        rpcErrorsSinceSelection: 2,
        rpcErrorTypesSinceSelection: {PEER_ID_INVALID: 1}
      });
      expect(parseCenterColumnState(state)).toEqual(state);
      expectNoHostileLeak(state);
    } finally {
      await page.close();
    }
  });

  it('reports an unreadable page as unavailable', async() => {
    const page = await browser.newPage();
    await page.close();
    expect(await captureCenterColumnState({page, composerWait: 'timeout'})).toBe('unavailable');
    expect(await captureCenterColumnState({composerWait: 'none'})).toBe('unavailable');
  });

  it('reports unavailable within the capture deadline when a page read never settles', async() => {
    const probe: any = {chatCount: 0, activeChatCount: 0, activePeerId: null, composerMatches: 0, composerInputs: 0,
      composerFakeInputs: 0, composerVisible: 0, composerEditable: 0, chatInput: 'absent', controlBar: 'none'};
    for(const stalled of [0, 1]) {
      let calls = 0;
      const page = {evaluate: () => calls++ === stalled ? new Promise(() => {}) : Promise.resolve(probe)};
      const started = Date.now();
      expect(await captureCenterColumnState({page, composerWait: 'timeout'}, 50)).toBe('unavailable');
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  it('keeps only the closed schema in the failure message', () => {
    const state: any = {
      chatCount: 1,
      activeChatCount: 0,
      activePeerId: null,
      composerMatches: 0,
      composerInputs: 0,
      composerFakeInputs: 0,
      composerVisible: 0,
      composerEditable: 0,
      chatInput: 'absent',
      controlBar: 'none',
      selectedPeerId: '1000002',
      composerWait: 'timeout',
      pageErrorsSinceSelection: 0,
      consoleErrorsSinceSelection: 2,
      rpcErrorsSinceSelection: 3,
      rpcErrorTypesSinceSelection: {PEER_ID_INVALID: 2}
    };
    expect(formatBrowserFailureMessage({
      status: 'failed',
      stage: 'alice_direct_chat_composer',
      passwordEvidence: [],
      centerColumn: state
    })).toBe(`real client scenario failed at alice_direct_chat_composer; password evidence []; centre column ${JSON.stringify(parseCenterColumnState(state))}`);
    expect(parseCenterColumnState(state)).toEqual(state);
    expect(formatBrowserFailureMessage({status: 'failed', stage: 'alice_direct_chat_composer', centerColumn: 'unavailable'}))
    .toBe('real client scenario failed at alice_direct_chat_composer; centre column "unavailable"');
    for(const hostile of [
      {...state, hint: HOSTILE.phrase},
      {...state, activePeerId: HOSTILE.username},
      {...state, controlBar: HOSTILE.phrase},
      {...state, composerMatches: -1},
      {...state, rpcErrorTypesSinceSelection: {[HOSTILE.phrase]: 1}},
      {...state, rpcErrorTypesSinceSelection: Object.fromEntries(Array.from({length: 17}, (_, index) => [`ERROR_${index}`, 1]))},
      {...state, rpcErrorTypesSinceSelection: {PEER_ID_INVALID: 0}},
      {...state, rpcErrorTypesSinceSelection: null},
      HOSTILE.phrase,
      null
    ]) {
      const message = formatBrowserFailureMessage({status: 'failed', stage: 'alice_direct_chat_composer', centerColumn: hostile});
      expect(message).toBe('real client scenario failed at alice_direct_chat_composer; centre column "unclassified"');
    }
    expect(formatBrowserFailureMessage({status: 'failed', stage: 'bob_chats_list'})).toBe('real client scenario failed at bob_chats_list');
  });
});

describe('real client group name form', () => {
  let browser: any;
  let screenshotDirectory: string;

  beforeAll(async() => {
    browser = await chromium.launch({headless: true});
    screenshotDirectory = mkdtempSync(join(tmpdir(), 'real-client-group-name-'));
  }, 30_000);

  afterAll(async() => {
    await browser?.close();
    rmSync(screenshotDirectory, {recursive: true, force: true});
  }, 15_000);

  // The new-group tab as tweb renders it: the avatar picker, the name as an
  // InputField (a contenteditable div prefilled with the members' names), the
  // hidden location field and the corner button the name's input event shows.
  function groupFormMarkup({nameField = true} = {}) {
    const name = nameField
      ? `<div class="input-field"><div class="input-field-input" contenteditable="true">${HOSTILE.username} &amp; ${HOSTILE.phrase}</div><label>Group Name</label></div>`
      : '';
    return `<div class="tabs-tab sidebar-slider-item new-group-container active">
      <div class="sidebar-content">
        <div class="avatar-edit"><canvas class="avatar-edit-canvas"></canvas></div>
        <div class="input-wrapper">${name}
          <div class="input-field hide" style="display:none"><div class="input-field-input" contenteditable="false"></div></div>
        </div>
        <button class="btn-circle btn-corner z-depth-1" style="position:absolute;bottom:0;transform:translateY(200vh)"></button>
      </div>
    </div>
    <script>
      const button = document.querySelector('.btn-corner');
      document.querySelector('.input-field-input[contenteditable="true"]')?.addEventListener('input', (event) => {
        const filled = !!event.target.textContent.length;
        button.classList.toggle('is-visible', filled);
        button.style.transform = filled ? 'none' : 'translateY(200vh)';
      });
      button.addEventListener('click', () => {
        window.createdTitle = document.querySelector('.input-field-input').textContent;
      });
    </script>`;
  }

  it('fills the contenteditable group name and clicks the button it shows', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(groupFormMarkup());
      const capturedScreenshots = {count: 0};
      await nameNewGroup(page, 'browser-ci-group-0123abcd', screenshotDirectory, capturedScreenshots, 2_000);
      expect(await page.evaluate(() => (window as any).createdTitle)).toBe('browser-ci-group-0123abcd');
      expect(capturedScreenshots.count).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('names the fill step and describes the form without page text', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(groupFormMarkup({nameField: false}));
      await expect(nameNewGroup(page, 'browser-ci-group-0123abcd', screenshotDirectory, {count: 0}, 200))
      .rejects.toThrow('alice_group_name_fill');
      const state = await captureGroupNameFormState();
      expect(state).toEqual({
        formCount: 1,
        formVisible: true,
        visibleInputs: 0,
        visibleEditables: 0,
        nameFieldMatches: 0,
        nameFieldVisible: 0,
        nameHasValue: false,
        confirmCount: 1,
        confirmShown: false,
        confirmEnabled: true,
        stepWait: 'timeout'
      });
      expect(parseGroupNameFormState(state)).toEqual(state);
    } finally {
      await page.close();
    }
  });

  it('names the confirm step when the filled name never shows the button', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(groupFormMarkup().replace(/<script>[\s\S]*<\/script>/, ''));
      await page.locator('.btn-corner').evaluate((button: HTMLElement) => button.setAttribute('disabled', 'true'));
      await expect(nameNewGroup(page, 'browser-ci-group-0123abcd', screenshotDirectory, {count: 0}, 200))
      .rejects.toThrow('alice_group_name_confirm');
      const state = await captureGroupNameFormState();
      expect(state).toMatchObject({
        nameFieldMatches: 1,
        nameFieldVisible: 1,
        visibleEditables: 1,
        nameHasValue: true,
        confirmCount: 1,
        confirmShown: false,
        confirmEnabled: false,
        stepWait: 'timeout'
      });
      expectNoHostileLeak(state);
      expect(JSON.stringify(state)).not.toContain('browser-ci-group');
    } finally {
      await page.close();
    }
  });

  it('reports an unreadable form as unavailable', async() => {
    const page = await browser.newPage();
    await page.close();
    expect(await captureGroupNameFormState({page, stepWait: 'timeout'})).toBe('unavailable');
    expect(await captureGroupNameFormState({stepWait: 'none'})).toBe('unavailable');
  });

  it('keeps only the closed schema in the failure message', () => {
    const state: any = {
      formCount: 1,
      formVisible: true,
      visibleInputs: 0,
      visibleEditables: 1,
      nameFieldMatches: 1,
      nameFieldVisible: 1,
      nameHasValue: true,
      confirmCount: 1,
      confirmShown: true,
      confirmEnabled: true,
      stepWait: 'none'
    };
    expect(formatBrowserFailureMessage({status: 'failed', stage: 'alice_group_name_fill', centerColumn: 'unavailable', groupNameForm: state}))
    .toBe(`real client scenario failed at alice_group_name_fill; centre column "unavailable"; group name form ${JSON.stringify(parseGroupNameFormState(state))}`);
    expect(parseGroupNameFormState(state)).toEqual(state);
    expect(formatBrowserFailureMessage({status: 'failed', stage: 'alice_group_name_fill', groupNameForm: 'unavailable'}))
    .toBe('real client scenario failed at alice_group_name_fill; group name form "unavailable"');
    for(const hostile of [
      {...state, name: HOSTILE.phrase},
      {...state, nameHasValue: HOSTILE.phrase},
      {...state, stepWait: HOSTILE.phrase},
      {...state, visibleInputs: -1},
      {...state, confirmShown: undefined},
      HOSTILE.phrase,
      null
    ]) {
      expect(formatBrowserFailureMessage({status: 'failed', stage: 'alice_group_name_fill', groupNameForm: hostile}))
      .toBe('real client scenario failed at alice_group_name_fill; group name form "unclassified"');
    }
  });
});

describe('real client group created', () => {
  const GROUP_NAME = 'browser-ci-group-0123abcd';
  const GROUP_MESSAGE = 'browser-ci-group-hello';
  let browser: any;
  let screenshotDirectory: string;

  beforeAll(async() => {
    browser = await chromium.launch({headless: true});
    screenshotDirectory = mkdtempSync(join(tmpdir(), 'real-client-group-created-'));
  }, 30_000);

  afterAll(async() => {
    await browser?.close();
    rmSync(screenshotDirectory, {recursive: true, force: true});
  }, 15_000);

  // The centre column as tweb leaves it after the confirm: Bob's direct chat
  // and the new group's chat side by side, only one of them active. Like the
  // client, an inactive chat stays rendered and is hidden by opacity.
  function chatMarkup({peerId, title, active}: {peerId: string, title: string, active: boolean}) {
    return `<div class="chat tabs-tab${active ? ' active' : ''}" style="position:absolute;inset:0;opacity:${active ? 1 : 0}">
      <div class="topbar"><div class="chat-info"><div class="avatar" data-peer-id="${peerId}"></div><span class="peer-title">${title}</span></div></div>
      <div class="bubbles"><div class="bubble"><div class="message">${HOSTILE.phrase}</div></div></div>
      <div class="chat-input"><div class="input-message-container">
        <div class="input-message-input" contenteditable="true"></div>
        <div class="input-message-input input-field-input-fake" contenteditable="true" style="opacity:0;position:absolute;top:0;z-index:-3"></div>
      </div></div>
    </div>`;
  }

  function centerMarkup({groupActive = true, groupTitle = GROUP_NAME} = {}) {
    return `<div id="column-center"><div class="chats-container">
      ${chatMarkup({peerId: '1000002', title: HOSTILE.username, active: !groupActive})}
      ${chatMarkup({peerId: '-1000003', title: groupTitle, active: groupActive})}
    </div></div>`;
  }

  it('resolves the active group chat and matching title beside a mounted direct chat', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(centerMarkup());
      const {chat, header, title} = resolveActiveGroupChat(page, GROUP_NAME);
      expect(await chat.count()).toBe(1);
      expect(await header.count()).toBe(1);
      expect(await title.count()).toBe(1);
      expect(await chat.locator('.avatar').getAttribute('data-peer-id')).toBe('-1000003');
    } finally {
      await page.close();
    }
  });

  function messageChatMarkup({peerId, title, active, message = ''}: {peerId: string, title: string, active: boolean, message?: string}) {
    return `<div class="chat tabs-tab${active ? ' active' : ''}" style="position:absolute;inset:0;opacity:${active ? 1 : 0}">
      <div class="topbar"><div class="chat-info"><div class="avatar" data-peer-id="${peerId}"></div><span class="peer-title">${title}</span></div></div>
      <div class="bubbles">${message ? `<div class="bubble"><div class="message">${message}</div></div>` : ''}</div>
      <div class="chat-input"><div class="input-message-container">
        <div class="input-message-input" contenteditable="true"></div>
        <div class="input-message-input input-field-input-fake" contenteditable="true" style="opacity:0;position:absolute;top:0;z-index:-3"></div>
      </div></div>
    </div>`;
  }

  function messageCenterMarkup({groupActive = true} = {}) {
    return `<div id="column-center"><div class="chats-container">
      ${messageChatMarkup({peerId: '1000002', title: HOSTILE.username, active: !groupActive, message: GROUP_MESSAGE})}
      ${messageChatMarkup({peerId: '-1000003', title: GROUP_NAME, active: groupActive})}
    </div></div>`;
  }

  async function installMessageSender(page: any) {
    await page.evaluate(() => {
      document.addEventListener('keydown', (event) => {
        const input = event.target as HTMLElement;
        if(event.key !== 'Enter' || !input.matches('.input-message-input:not(.input-field-input-fake)')) return;
        event.preventDefault();
        const chat = input.closest('.chat');
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        const message = document.createElement('div');
        message.className = 'message';
        message.textContent = input.textContent;
        bubble.appendChild(message);
        chat?.querySelector('.bubbles')?.appendChild(bubble);
      });
    });
  }

  it('sends Alice\'s group message only through the active group chat', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(messageCenterMarkup());
      await installMessageSender(page);
      await sendGroupText(page, GROUP_MESSAGE, GROUP_NAME, 'alice_group_message', 2_000);
      expect(await page.locator('#column-center .chat.active .bubble .message').filter({hasText: GROUP_MESSAGE}).count()).toBe(1);
      expect(await page.locator('#column-center .chat:not(.active) .bubble .message').filter({hasText: GROUP_MESSAGE}).count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('fails Alice\'s group message stage when the new group is not active', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(messageCenterMarkup({groupActive: false}));
      await installMessageSender(page);
      await expect(sendGroupText(page, GROUP_MESSAGE, GROUP_NAME, 'alice_group_message', 100))
      .rejects.toThrow('alice_group_message_chat');
      const state = await captureGroupCreatedState();
      expect(state).toEqual({activeChat: 'user', chatCount: 2, groupHeaderVisible: false, stepWait: 'timeout'});
      const summary = formatBrowserFailureMessage({
        status: 'failed',
        stage: 'alice_group_message_chat',
        centerColumn: await captureCenterColumnState(),
        groupCreated: state
      });
      expect(summary).toContain('; centre column ');
      expect(summary).toContain('; group created ');
      expectNoHostileLeak(summary);
      expect(summary).not.toContain(GROUP_NAME);
    } finally {
      await page.close();
    }
  });

  it('passes once the new group is the active chat', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(centerMarkup());
      const capturedScreenshots = {count: 0};
      await waitForGroupCreated(page, GROUP_NAME, screenshotDirectory, capturedScreenshots, 2_000);
      expect(capturedScreenshots.count).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('is not satisfied by the direct chat still active next to the inactive group chat', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(centerMarkup({groupActive: false}));
      await expect(waitForGroupCreated(page, GROUP_NAME, screenshotDirectory, {count: 0}, 200))
      .rejects.toThrow('alice_group_created_chat');
      const state = await captureGroupCreatedState();
      expect(state).toEqual({activeChat: 'user', chatCount: 2, groupHeaderVisible: false, stepWait: 'timeout'});
      expect(parseGroupCreatedState(state)).toEqual(state);
      expectNoHostileLeak(state);
      expect(JSON.stringify(state)).not.toContain('browser-ci-group');
      expect(JSON.stringify(state)).not.toContain('1000002');
    } finally {
      await page.close();
    }
  });

  it('names the title step when the active group carries another name', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(centerMarkup({groupTitle: 'another-group'}));
      await expect(waitForGroupCreated(page, GROUP_NAME, screenshotDirectory, {count: 0}, 200))
      .rejects.toThrow('alice_group_created_title');
      expect(await captureGroupCreatedState()).toEqual({activeChat: 'group', chatCount: 2, groupHeaderVisible: false, stepWait: 'timeout'});
    } finally {
      await page.close();
    }
  });

  it('names the screenshot step when the capture throws', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(centerMarkup());
      // A file where the screenshot directory should be: the capture cannot be written.
      const blocked = join(screenshotDirectory, 'blocked');
      writeFileSync(blocked, '');
      const capturedScreenshots = {count: 0};
      await expect(waitForGroupCreated(page, GROUP_NAME, blocked, capturedScreenshots, 2_000))
      .rejects.toThrow('alice_group_created_screenshot');
      expect(capturedScreenshots.count).toBe(0);
      expect(await captureGroupCreatedState()).toEqual({activeChat: 'group', chatCount: 2, groupHeaderVisible: true, stepWait: 'other'});
    } finally {
      await page.close();
    }
  });

  it('reports an unreadable page as unavailable', async() => {
    const page = await browser.newPage();
    await page.close();
    expect(await captureGroupCreatedState({page, groupName: GROUP_NAME, stepWait: 'timeout'})).toBe('unavailable');
    expect(await captureGroupCreatedState({groupName: GROUP_NAME, stepWait: 'none'})).toBe('unavailable');
  });

  // Bob's centre column with Alice's direct chat active and the group's row in
  // the chat list. A row that opens the chat swaps which chat is active.
  function bobMarkup({opens = true, groupTitle = GROUP_NAME} = {}) {
    return `<div id="chatlist-container"><a class="chatlist-chat"${opens ? ' onclick="for(const chat of document.querySelectorAll(\'.chat\')){chat.classList.toggle(\'active\');chat.style.opacity=chat.classList.contains(\'active\')?1:0;}"' : ''}>${GROUP_NAME}</a></div>
      <div style="position:relative;height:200px">${centerMarkup({groupActive: false, groupTitle})}</div>`;
  }

  function groupProfileMarkup({groupPeerId = '-1000003', memberIds = ['1000002', '1000003'], membersTab = true, membersTabActive = false} = {}) {
    const membersMenu = membersTab ? '<div class="menu-horizontal-div-item"><span>Members</span></div>' : '';
    const membersPanel = membersTab ? `<div class="search-super-tab-container search-super-container-members tabs-tab${membersTabActive ? ' active' : ''}" style="min-height:80px">
      <div class="search-super-content-container search-super-content-members"><ul class="chatlist">${memberIds.map((peerId) => `<li class="chatlist-chat" data-peer-id="${peerId}" style="height:40px">member</li>`).join('')}</ul></div>
    </div>` : '';
    return `<div class="tabs-tab sidebar-slider-item active" style="min-height:200px">
      <div class="sidebar-content"><div class="profile-content">
        <div class="profile-avatars-container"><div class="avatar profile-avatars-avatar-fake" data-peer-id="${groupPeerId}" style="width:120px;height:120px"></div><div class="profile-avatars-info">${GROUP_NAME}</div></div>
        <div class="search-super"><nav class="search-super-tabs"><div class="menu-horizontal-div-item"><span>Media</span></div>${membersMenu}</nav>
          <div class="search-super-tabs-container"><div class="search-super-tab-container search-super-container-media tabs-tab"></div>${membersPanel}</div>
        </div>
      </div></div>
    </div>`;
  }

  async function prepareBobGroupMemberPage({profileMarkup = groupProfileMarkup(), openProfile = true, activateMembers = true, reportErrorsOnMembersClick = false} = {}) {
    const page = await browser.newPage();
    await countClientErrors(page);
    await page.goto('data:text/html,');
    await page.setContent(`${bobMarkup()}<div id="column-right"><div class="sidebar-slider"></div></div>`);
    await page.evaluate(({profileMarkup, openProfile, activateMembers, reportErrorsOnMembersClick}: {profileMarkup: string, openProfile: boolean, activateMembers: boolean, reportErrorsOnMembersClick: boolean}) => {
      const group = document.querySelector('#column-center .chat .avatar[data-peer-id="-1000003"]')?.closest('.chat');
      group?.querySelector('.topbar .chat-info')?.addEventListener('click', () => {
        if(!openProfile) return;
        const slider = document.querySelector('#column-right .sidebar-slider');
        document.body.classList.add('is-right-column-shown');
        slider.innerHTML = profileMarkup;
        const activeProfile = slider.querySelector('.sidebar-slider-item.active');
        const membersMenu = activeProfile?.querySelectorAll('.search-super-tabs .menu-horizontal-div-item')[1];
        const membersPanel = activeProfile?.querySelector('.search-super-container-members');
        membersMenu?.addEventListener('click', () => {
          if(reportErrorsOnMembersClick) {
            console.error('hunter2 secret passphrase');
            setTimeout(() => {throw new Error('hunter2 secret passphrase')}, 0);
            const channel = new MessageChannel();
            channel.port2.addEventListener('message', () => {});
            channel.port2.start();
            channel.port1.postMessage({type: 'result', payload: {taskId: 1, error: {type: 'PROFILE_RPC_ERROR'}}});
          }
          if(!activateMembers) return;
          activeProfile.querySelectorAll('.search-super-tab-container').forEach((panel) => panel.classList.remove('active'));
          membersPanel?.classList.add('active');
        });
      });
    }, {profileMarkup, openProfile, activateMembers, reportErrorsOnMembersClick});
    const capturedScreenshots = {count: 0};
    const groupHeader = await openBobGroupChat(page, page.locator('#chatlist-container .chatlist-chat'), GROUP_NAME, screenshotDirectory, capturedScreenshots, 2_000);
    return {page, groupHeader, capturedScreenshots};
  }

  function requireOpenBobGroupMembers() {
    const open = realClientBrowser.openBobGroupMembers;
    expect(typeof open).toBe('function');
    return open;
  }

  it('passes Bob\'s group steps once the clicked group is the active chat', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(bobMarkup());
      const capturedScreenshots = {count: 0};
      const header = await openBobGroupChat(page, page.locator('#chatlist-container .chatlist-chat'), GROUP_NAME, screenshotDirectory, capturedScreenshots, 2_000);
      expect(await header.locator('.avatar').getAttribute('data-peer-id')).toBe('-1000003');
      expect(capturedScreenshots.count).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('does not let Alice\'s still-active direct chat satisfy Bob\'s group steps', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(bobMarkup({opens: false}));
      await expect(openBobGroupChat(page, page.locator('#chatlist-container .chatlist-chat'), GROUP_NAME, screenshotDirectory, {count: 0}, 2_000))
      .rejects.toThrow('bob_group_chat');
      const state = await captureGroupCreatedState();
      expect(state).toEqual({activeChat: 'user', chatCount: 2, groupHeaderVisible: false, stepWait: 'timeout'});
      expectNoHostileLeak(state);
      expect(JSON.stringify(state)).not.toContain('browser-ci-group');
      expect(JSON.stringify(state)).not.toContain('1000002');
    } finally {
      await page.close();
    }
  });

  it('does not let Alice\'s direct chat satisfy Bob\'s group steps when the group chat is absent', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div id="chatlist-container"><a class="chatlist-chat">${GROUP_NAME}</a></div>
        <div style="position:relative;height:200px"><div id="column-center"><div class="chats-container">${chatMarkup({peerId: '1000002', title: GROUP_NAME, active: true})}</div></div></div>`);
      await expect(openBobGroupChat(page, page.locator('#chatlist-container .chatlist-chat'), GROUP_NAME, screenshotDirectory, {count: 0}, 200))
      .rejects.toThrow('bob_group_chat');
      expect(await captureGroupCreatedState()).toEqual({activeChat: 'user', chatCount: 1, groupHeaderVisible: true, stepWait: 'timeout'});
    } finally {
      await page.close();
    }
  });

  it('fails Bob\'s title read under bob_group_title with the summary', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(bobMarkup({groupTitle: 'another-group'}));
      await expect(openBobGroupChat(page, page.locator('#chatlist-container .chatlist-chat'), GROUP_NAME, screenshotDirectory, {count: 0}, 2_000))
      .rejects.toThrow('bob_group_title');
      expect(await captureGroupCreatedState()).toEqual({activeChat: 'group', chatCount: 2, groupHeaderVisible: false, stepWait: 'timeout'});
    } finally {
      await page.close();
    }
  });

  it('names Bob\'s row click and screenshot steps', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(bobMarkup());
      await expect(openBobGroupChat(page, page.locator('#chatlist-container .missing-row'), GROUP_NAME, screenshotDirectory, {count: 0}, 200))
      .rejects.toThrow('bob_group_open');
      const blocked = join(screenshotDirectory, 'bob-blocked');
      writeFileSync(blocked, '');
      await expect(openBobGroupChat(page, page.locator('#chatlist-container .chatlist-chat'), GROUP_NAME, blocked, {count: 0}, 2_000))
      .rejects.toThrow('bob_group_screenshot');
      expect(await captureGroupCreatedState()).toEqual({activeChat: 'group', chatCount: 2, groupHeaderVisible: true, stepWait: 'other'});
    } finally {
      await page.close();
    }
  });

  it('reads the exact two members from Bob\'s active group profile Members tab', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage();
    try {
      expect(await page.locator('#column-right .sidebar-slider-item.active .row').filter({hasText: /^Members/}).count()).toBe(0);
      await openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, 500);
      expect(capturedScreenshots.count).toBe(2);
    } finally {
      await page.close();
    }
  });

  it('fails Bob\'s member profile step when the group profile did not open', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({openProfile: false});
    try {
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, 100))
      .rejects.toThrow('bob_group_member_profile');
      const state = await realClientBrowser.captureGroupMemberState();
      expect(state).toMatchObject({activePanel: 'none', profileMatchesActiveGroup: false, membersTabExists: false, membersListExists: false, memberRowCount: 0});
      expect(realClientContract.parseGroupMemberState(state)).toEqual(state);
    } finally {
      await page.close();
    }
  });

  it('does not read members from a stale right-column profile for another group', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const staleProfile = groupProfileMarkup({groupPeerId: '-1000004', membersTabActive: true});
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({profileMarkup: staleProfile});
    try {
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, 100))
      .rejects.toThrow('bob_group_member_profile');
      expect(await realClientBrowser.captureGroupMemberState()).toMatchObject({activePanel: 'members', profileMatchesActiveGroup: false, membersTabExists: true, membersListExists: true, memberRowCount: 2});
    } finally {
      await page.close();
    }
  });

  it('captures client error baselines before Bob\'s active-chat prechecks', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage();
    try {
      await page.locator('#column-center .chat.active').evaluate((chat: Element) => chat.classList.remove('active'));
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, 100))
      .rejects.toThrow('bob_group_member_profile');
      expect(await realClientBrowser.captureGroupMemberState()).toMatchObject({
        pageErrorsSinceStep: 0,
        consoleErrorsSinceStep: 0,
        rpcErrorsSinceStep: 0
      });
    } finally {
      await page.close();
    }
  });

  it('fails Bob\'s Members tab step when the profile has no Members tab', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({profileMarkup: groupProfileMarkup({membersTab: false})});
    try {
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, 100))
      .rejects.toThrow('bob_group_member_tab');
      expect(await realClientBrowser.captureGroupMemberState()).toMatchObject({activePanel: 'profile', profileMatchesActiveGroup: true, membersTabExists: false, membersListExists: false, memberRowCount: 0});
    } finally {
      await page.close();
    }
  });

  it('fails Bob\'s member list step when the Members panel does not become active', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({activateMembers: false});
    try {
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, 100))
      .rejects.toThrow('bob_group_member_list');
      expect(await realClientBrowser.captureGroupMemberState()).toMatchObject({activePanel: 'profile', profileMatchesActiveGroup: true, membersTabExists: true, membersListExists: true, memberRowCount: 0});
    } finally {
      await page.close();
    }
  });

  it('fails Bob\'s member row wait with the active Members panel row count', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({profileMarkup: groupProfileMarkup({memberIds: ['1000002']})});
    try {
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, 100))
      .rejects.toThrow('bob_group_member_count');
      expect(await realClientBrowser.captureGroupMemberState()).toMatchObject({activePanel: 'members', membersTabExists: true, membersListExists: true, memberRowCount: 1});
    } finally {
      await page.close();
    }
  });

  it('requires exactly two member peer ids including the selected Bob', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    for(const memberIds of [['1000003', '1000004'], ['1000002', '1000003', '1000004']]) {
      const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({profileMarkup: groupProfileMarkup({memberIds})});
      try {
        await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, 500))
        .rejects.toThrow('bob_group_member_identity');
        expect(await realClientBrowser.captureGroupMemberState()).toMatchObject({activePanel: 'members', memberRowCount: memberIds.length});
      } finally {
        await page.close();
      }
    }
  });

  it('summarizes only the active right-column state and safe error deltas on failure', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({activateMembers: false, reportErrorsOnMembersClick: true});
    try {
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, 100))
      .rejects.toThrow('bob_group_member_list');
      const state = await realClientBrowser.captureGroupMemberState();
      expect(state).toMatchObject({activePanel: 'profile', profileMatchesActiveGroup: true, membersTabExists: true, membersListExists: true, memberRowCount: 0});
      expect(state.pageErrorsSinceStep).toBeGreaterThan(0);
      expect(state.consoleErrorsSinceStep).toBeGreaterThan(0);
      expect(state.rpcErrorsSinceStep).toBeGreaterThan(0);
      expect(realClientContract.parseGroupMemberState(state)).toEqual(state);
      const summary = formatBrowserFailureMessage({status: 'failed', stage: 'bob_group_member_list', groupMember: state});
      expect(summary).toContain('; group members ');
      expectNoHostileLeak(summary);
      expect(summary).not.toContain(GROUP_NAME);
      expect(summary).not.toContain('1000002');
    } finally {
      await page.close();
    }
  });

  it('rejects unsafe member diagnostics from the failure summary', () => {
    const parseGroupMemberState = (realClientContract as any).parseGroupMemberState;
    expect(typeof parseGroupMemberState).toBe('function');
    const state = {
      activePanel: 'members',
      profileMatchesActiveGroup: true,
      membersTabExists: true,
      membersListExists: true,
      memberRowCount: 2,
      pageErrorsSinceStep: 0,
      consoleErrorsSinceStep: 0,
      rpcErrorsSinceStep: 0,
      stepWait: 'timeout'
    };
    expect(parseGroupMemberState(state)).toEqual(state);
    for(const hostile of [
      {...state, groupName: HOSTILE.phrase},
      {...state, activePanel: HOSTILE.phrase},
      {...state, memberPeerIds: ['1000002']},
      {...state, memberRowCount: -1},
      {...state, pageErrorsSinceStep: HOSTILE.phrase},
      {...state, stepWait: HOSTILE.phrase},
      null
    ]) {
      expect(formatBrowserFailureMessage({status: 'failed', stage: 'bob_group_member_identity', groupMember: hostile}))
      .toBe('real client scenario failed at bob_group_member_identity; group members "unclassified"');
    }
  });

  it('keeps only the closed schema in the failure message', () => {
    const state: any = {activeChat: 'user', chatCount: 2, groupHeaderVisible: false, stepWait: 'timeout'};
    expect(formatBrowserFailureMessage({status: 'failed', stage: 'alice_group_created_chat', centerColumn: 'unavailable', groupCreated: state}))
    .toBe(`real client scenario failed at alice_group_created_chat; centre column "unavailable"; group created ${JSON.stringify(state)}`);
    expect(formatBrowserFailureMessage({status: 'failed', stage: 'alice_group_created_chat', groupCreated: 'unavailable'}))
    .toBe('real client scenario failed at alice_group_created_chat; group created "unavailable"');
    for(const hostile of [
      {...state, groupName: HOSTILE.phrase},
      {...state, activeChat: '1000002'},
      {...state, groupHeaderVisible: HOSTILE.phrase},
      {...state, stepWait: HOSTILE.phrase},
      {...state, chatCount: -1},
      HOSTILE.phrase,
      null
    ]) {
      expect(formatBrowserFailureMessage({status: 'failed', stage: 'alice_group_created_chat', groupCreated: hostile}))
      .toBe('real client scenario failed at alice_group_created_chat; group created "unclassified"');
    }
  });
});
