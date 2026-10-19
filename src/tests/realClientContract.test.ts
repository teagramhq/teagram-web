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
  parsePassedBrowserGateBreakdown,
  parseAuthProgressReport,
  parseChannelMembershipState,
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
const {captureCenterColumnState, captureChannelMembershipState, captureGroupCreatedState, captureGroupNameFormState, countClientErrors, getClientErrorDiagnostics, createNetworkObserver, createWorkerDiscovery, emitAuthProgressReport, findChannelDialogRow, getSingleExactMessageFailure, getSingleExactMessageTextFailure, main: runRealClient, matchesPrivateArtifactManifest, nameNewGroup, openBobGroupChat, openComposer, prepareUsernameEntry, resolveActiveGroupChat, sendGroupText, submitUsernameOnceAndWaitForPassword, validateRuntimeInput, waitForChannelDialogRow, waitForChannelInviteCompletion, waitForGroupCreated, waitForPasswordField, submitPassword, waitForUnreadCount} = realClientBrowser;
const observation = require('../../scripts/real-client/observation.cjs');

const APP_ORIGIN = 'https://teagramd.test';
const CONTRACT_WAIT_TIMEOUT_MS = 5_000;
const MTPROTO_CHUNK_URL = `${APP_ORIGIN}/index.worker-AbCdEfGh.js?x-protocol-version=4`;
const LOTTIE_WORKER_CHUNK_URL = `${APP_ORIGIN}/tlottie.worker-JkLmNoPq.js`;
const PROBE_WORKER_URL = `${APP_ORIGIN}/_fixture_probe/shared-worker.js`;
const PROBE_MISSING_URL = `${APP_ORIGIN}/_fixture_probe/missing.js`;
const HOSTILE_PASSWORD = 'f4ce'.repeat(16);
const HOSTILE = Object.freeze({
  username: 'u' + 'a'.repeat(30) + 'a',
  password: HOSTILE_PASSWORD,
  token: 'bearer-secret-value',
  url: 'https://unannounced.invalid/exfiltrate?token=bearer-secret-value',
  blobUrl: 'blob:https://teagramd.test/0e4a2c1a-1111-2222-3333-444444444444',
  phrase: 'hunter2 secret passphrase',
  frame: `at ${APP_ORIGIN}/index.worker-AbCdEfGh.js:1:7 (${HOSTILE_PASSWORD})`
});

function createPlaywrightWrappedPageError(name: 'TypeError' | 'RangeError', asset: string) {
  const error = new Error(HOSTILE.phrase);
  error.name = name;
  error.stack = `${name}: ${HOSTILE.phrase}\n    at https://unannounced.invalid/assets/${asset}?token=${HOSTILE.token}:21:3`;
  return error;
}

function createNetworkObserverHarness(observer: any, options: any = {}) {
  const cdp: any = new EventEmitter();
  cdp.send = options.send || (async(method: string) => method === 'Target.getTargetInfo'
    ? {targetInfo: {targetId: 'contract-test-page', browserContextId: 'contract-test'}}
    : {});
  cdp.detach = options.detach || (async() => {});
  const context = {newCDPSession: async() => cdp, close: options.closeContext || (async() => {})};
  const page: any = new EventEmitter();
  page.mainFrame = () => ({});
  page.context = () => context;
  page.exposeBinding = async() => {};
  page.addInitScript = async() => {};
  return {cdp, page, networkObserver: createNetworkObserver(page, 'contract-test', observer, options.pageErrorAssetResolver, options.onPageException)};
}

function createDiagnosticPageErrors(message = 'Object', pageUrl = `${APP_ORIGIN}/`) {
  const recordPageError = (realClientBrowser as any).recordPageError;
  const error = new Error(message);
  error.stack = `Error: ${message}`;
  const pageErrors = {alice: [], bob: []} as any;
  recordPageError(pageErrors, 'alice', error, undefined,
    {scenario: 'channel', step: 'alice_channel_invite_button'},
    {captureDetails: true, pageUrl, scenario: 'channel', stage: 'alice_channel_invite_button'});
  return pageErrors;
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

function acknowledgeCdpCommand(session: any, params: any, error = false, result = {}) {
  const {id} = JSON.parse(params.message);
  queueMicrotask(() => session.emit('Target.receivedMessageFromTarget', {
    sessionId: params.sessionId,
    message: JSON.stringify(error ? {id, error: {message: HOSTILE.phrase}} : {id, result})
  }));
}

function createWorkerNetworkObserverHarness(observer: any, browserContextId: string, options: any = {}) {
  const harness = createNetworkObserverHarness(observer, {
    ...options,
    send: async(method: string, params: any) => {
      if(method === 'Target.sendMessageToTarget') acknowledgeCdpCommand(harness.cdp, params);
      return method === 'Target.getTargetInfo' ? {targetInfo: {targetId: 'contract-test-page', browserContextId}} : {};
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
      const result = nestedMethod === 'Runtime.callFunctionOn'
        ? {result: {value: {peerArguments: [{argument: 'peer', constructor: 'inputPeerChannel', id: '603'}]}}}
        : {};
      acknowledgeCdpCommand(discovery.session, params, options.setupFailure && nestedMethod === 'Network.enable', result);
    }
    return {};
  });
  if(options.launch !== false) await discovery.registry.launch(discovery.browser);
  const contexts: any[] = [];
  async function startContext(name: string, control = false) {
    const observer = observation.createContextObserver(name, {control, observeWebSocket101: options.observeWebSocket101 !== false});
    const {cdp, page, networkObserver} = createWorkerNetworkObserverHarness(observer, name, {
      pageErrorAssetResolver: options.pageErrorAssetResolver
    });
    await networkObserver.start(discovery.registry);
    discovery.session.emit('Target.targetCreated', {targetInfo: pageTarget(`${name}-page`, name)});
    observer.state.windowElapsed = true;
    const context = {name, observer, cdp, page, networkObserver};
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
    wssEndpoint: 'wss://teagramd.test/apiws',
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
        harness.emit(app, 'service-worker', 'Network.webSocketCreated', {requestId: 'service-allowed', url: 'wss://teagramd.test/apiws'}, 'auto');
        harness.emit(app, 'alice-worker', 'Network.webSocketCreated', {requestId: 'allowed', url: 'wss://teagramd.test/apiws'});
        if(fault === 'overflow') app.observer.noteInjectedControlFault('overflow');
        if(fault === 'malformed_discovery') harness.session.emit('Target.receivedMessageFromTarget', {
          sessionId: 'discovery-alice-worker', message: HOSTILE.phrase
        });
        for(const event of events) harness.emit(app, 'alice-worker', event.method, event.params);
        if(fault === 'page_error') {
          page.emit('pageerror', createPlaywrightWrappedPageError('TypeError', 'auth-client.js'));
        }
        if(fault === 'page_error_overflow') {
          for(let index = 0; index < 515; index++) {
            const isOtherAsset = index === 514;
            const asset = isOtherAsset ? 'overflow-client.js' : 'auth-client.js';
            page.emit('pageerror', createPlaywrightWrappedPageError(isOtherAsset ? 'RangeError' : 'TypeError', asset));
          }
        }
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
    evidenceClass: 'production-teagramd',
    endpoint: 'https://teagramd.test',
    wssEndpoint: 'wss://teagramd.test/apiws',
    mode: 'private',
    mtprotoPublicKeyPEM,
    publicKeySHA256: createHash('sha256').update(mtprotoPublicKeyPEM).digest('hex'),
    fingerprint: '1234567890abcdef',
    leafSPKI: Buffer.from('a'.repeat(64), 'hex').toString('base64'),
    credentials: [
      {username: `u${runId.slice(0, 30)}a`, passwordFile: `/dev/shm/teagram-fixture-${runId}.abc/a-password`},
      {username: `u${runId.slice(0, 30)}b`, passwordFile: `/dev/shm/teagram-fixture-${runId}.abc/b-password`}
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
  expect(serialized).not.toContain('teagramd.test');
  expect(serialized).not.toContain('AbCdEfGh');
  expect(serialized).not.toMatch(/https?:/);
  expect(serialized).not.toMatch(/wss?:/);
}

function expectNoGateSecretLeak(summary: any) {
  const serialized = JSON.stringify(summary);
  expect(serialized).not.toContain(HOSTILE.username);
  expect(serialized).not.toContain(HOSTILE.password);
  expect(serialized).not.toContain(HOSTILE.token);
  expect(serialized).not.toContain(HOSTILE.phrase);
  expect(serialized).not.toContain(HOSTILE.url);
  expect(serialized).not.toContain('/exfiltrate');
  expect(serialized).not.toContain('?token=');
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
          params: {type: 'WebSocket', request: {url: 'wss://teagramd.test/apiws'}}
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

describe('worker coverage failure diagnostics', () => {
  const breakdown = {
    registry: {
      discoveryInactive: 1,
      foreignTargets: 1,
      contextlessTargets: 2,
      appContextlessTargets: 1,
      targetDetailsOverflow: 0
    },
    contexts: {
      alice: {
        discoveryInactive: 1,
        pageCoverageIncomplete: 1,
        windowNotElapsed: 1,
        observerOverflow: 1,
        observerErrors: 2,
        foreignTargets: 1,
        countedEvents: 4096,
        attachedTargets: 6,
        pageTargets: 2,
        multiplePageTargets: 1,
        coverageComplete: 0
      },
      bob: {
        discoveryInactive: 0,
        pageCoverageIncomplete: 0,
        windowNotElapsed: 0,
        observerOverflow: 0,
        observerErrors: 0,
        foreignTargets: 0,
        countedEvents: 12,
        attachedTargets: 3,
        pageTargets: 1,
        multiplePageTargets: 0,
        coverageComplete: 1
      }
    },
    targets: [
      {targetType: 'page', owningContext: 'alice', scriptAsset: 'unknown', causes: ['multiple_pages']},
      {targetType: 'page', owningContext: 'alice', scriptAsset: 'unknown', causes: ['observer_overflow']},
      {targetType: 'iframe', owningContext: 'alice', scriptAsset: 'unknown', causes: ['contextless']},
      {targetType: 'service_worker', owningContext: null, scriptAsset: 'sw-01234567.js', causes: ['foreign']},
      {targetType: 'service_worker', owningContext: 'alice', scriptAsset: 'unknown', causes: ['observer_overflow']},
      {targetType: 'service_worker', owningContext: 'bob', scriptAsset: 'unknown', causes: ['observer_error']},
      {targetType: 'shared_worker', owningContext: 'alice', scriptAsset: 'index.worker-AbCdEfGh.js', causes: ['contextless']},
      {targetType: 'dedicated_worker', owningContext: 'bob', scriptAsset: 'tlottie.worker-JkLmNoPq.js', causes: ['multiple_pages']},
      {targetType: 'other', owningContext: null, scriptAsset: 'unknown', causes: ['foreign']}
    ]
  };

  it('builds a bounded breakdown for every coverage condition and target type', () => {
    const coverage = observation.buildWorkerCoverageBreakdown({
      registry: {discoveryActive: 0, foreignTargets: 1, contextlessTargets: 2, appContextlessTargets: 1, targetDetailsOverflow: 0},
      contexts: {
        alice: {
          discoveryActive: 0,
          pageCoverageComplete: 0,
          windowElapsed: 0,
          observerOverflow: 1,
          observerErrors: 2,
          foreignTargets: 1,
          countedEvents: 4096,
          attachedTargets: 6,
          pageTargets: 2,
          coverageComplete: 0
        },
        bob: {
          discoveryActive: 1,
          pageCoverageComplete: 1,
          windowElapsed: 1,
          observerOverflow: 0,
          observerErrors: 0,
          foreignTargets: 0,
          countedEvents: 12,
          attachedTargets: 3,
          pageTargets: 1,
          coverageComplete: 1
        }
      },
      targets: breakdown.targets.map((target) => ({
        type: target.targetType === 'dedicated_worker' ? 'worker' : target.targetType,
        owningContext: target.owningContext,
        scriptAsset: target.scriptAsset,
        causes: target.causes
      }))
    });

    expect(coverage).toEqual(breakdown);
    const redacted = observation.buildWorkerCoverageBreakdown({
      registry: {discoveryActive: 1, foreignTargets: 0, contextlessTargets: 0, appContextlessTargets: 0, targetDetailsOverflow: 0},
      contexts: {},
      targets: [{type: 'shared_worker', owningContext: null, scriptAsset: HOSTILE.url, causes: ['foreign']}]
    });
    expect(redacted.targets[0].scriptAsset).toBe('unknown');
    expect(JSON.stringify(redacted)).not.toContain(HOSTILE.url);
  });

  it('keeps coverage complete across a bounded page request window above the old cap', () => {
    const requests = Array.from({length: 1024}, () => ({
      kind: 'page',
      method: 'Network.requestWillBeSent',
      params: {type: 'Fetch', request: {url: `${APP_ORIGIN}/fixture-resource`}}
    }));
    const summary = replayContext([{kind: 'target', target: pageTarget()}, ...requests]);

    expect(summary).toMatchObject({
      countedEvents: 1025,
      observerOverflow: 0,
      coverageComplete: 1
    });
  });

  it('attributes a page event budget overflow to the page target', async() => {
    const contextObserver = observation.createContextObserver('alice');
    const {cdp, networkObserver} = createNetworkObserverHarness(contextObserver);
    const overflowedTargets: string[] = [];
    await networkObserver.start({
      registerContext() {},
      noteTargetOverflow(targetId: string) {
        overflowedTargets.push(targetId);
      }
    });

    try {
      for(let index = 0; index <= observation.LIMITS.countedEventsPerContext; index++) {
        cdp.emit('Network.requestWillBeSent', {
          requestId: `request-${index}`,
          type: 'Fetch',
          request: {url: `${APP_ORIGIN}/fixture-resource`}
        });
      }

      expect(contextObserver.summary()).toMatchObject({
        countedEvents: observation.LIMITS.countedEventsPerContext,
        observerOverflow: 1,
        coverageComplete: 0
      });
      expect(overflowedTargets).toEqual(['contract-test-page']);
    } finally {
      await networkObserver.stop();
    }
  });

  it('formats each registry and context condition with typed, attributed targets', () => {
    const message = formatBrowserFailureMessage({
      status: 'failed',
      stage: 'browser_worker_observation_incomplete',
      workerCoverageBreakdown: breakdown
    });

    expect(message).toContain(`; worker coverage ${JSON.stringify(breakdown)}`);
    expect(message).toContain('"pageCoverageIncomplete":1');
    expect(message).toContain('"windowNotElapsed":1');
    expect(message).toContain('"observerOverflow":1');
    expect(message).toContain('"observerErrors":2');
    expect(message).toContain('"foreignTargets":1');
    expect(message).toContain('"countedEvents":4096');
    expect(message).toContain('"attachedTargets":6');
    expect(message).toContain('"contextlessTargets":2');
    expect(message).toContain('"targetType":"dedicated_worker"');
    expect(message).toContain('"causes":["observer_overflow"]');
    expect(message).toContain('"targetType":"service_worker","owningContext":"alice","scriptAsset":"unknown","causes":["observer_overflow"]');
    expect(message).toContain('"owningContext":"bob"');
    expect(message).toContain('"scriptAsset":"index.worker-AbCdEfGh.js"');
  });

  it('rejects unclassified target details instead of echoing URLs or paths', () => {
    const hostile = structuredClone(breakdown);
    hostile.targets[0].scriptAsset = HOSTILE.url;

    expect(() => formatBrowserFailureMessage({
      status: 'failed',
      stage: 'browser_worker_observation_incomplete',
      workerCoverageBreakdown: hostile
    })).toThrow('worker coverage evidence is invalid');
  });
});

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
      {kind: 'target', target: sharedWorker('second-worker', 'blob:https://teagramd.test/11111111-2222-3333-4444-555555555555')},
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
      cdp.emit('Network.webSocketCreated', {requestId: 'page-socket', url: 'wss://teagramd.test/apiws'});
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
      emitWorkerEvent('Network.webSocketCreated', {requestId: 'service-socket', url: 'wss://teagramd.test/apiws'});
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
      emitWorkerEvent('Network.webSocketCreated', {requestId: 'shared-socket', url: 'wss://teagramd.test/apiws'});
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

  it('reuses the worker attachment budget after targets are destroyed', () => {
    const events: any[] = [{kind: 'target', target: pageTarget()}];
    for(let index = 0; index < observation.LIMITS.attachedTargets * 2; index++) {
      const targetId = `reused-worker-${index}`;
      events.push({kind: 'target', target: sharedWorker(targetId, HOSTILE.blobUrl)});
      events.push({kind: 'attach', targetId});
      events.push({kind: 'setup', targetId});
      events.push({kind: 'destroy', targetId});
    }

    const summary = replayContext(events);

    expect(summary.observerOverflow).toBe(0);
    expect(summary.attachedTargets).toBe(1);
    expect(summary.coverageComplete).toBe(1);
  });

  it('keeps coverage complete for a 32-target worker burst', () => {
    const events: any[] = [{kind: 'target', target: pageTarget()}];
    for(let index = 0; index < 32; index++) {
      const targetId = `burst-worker-${index}`;
      events.push({kind: 'target', target: sharedWorker(targetId, HOSTILE.blobUrl)});
      events.push({kind: 'attach', targetId});
      events.push({kind: 'setup', targetId});
    }

    const summary = replayContext(events);

    expect(summary.observerOverflow).toBe(0);
    expect(summary.attachedTargets).toBe(32);
    expect(summary.coverageComplete).toBe(1);
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
    const forbidden = ['Runtime.evaluate', 'Runtime.getProperties', 'Runtime.addBinding',
      'Debugger.enable', 'Debugger.setPauseOnExceptions', 'Debugger.resume', 'Debugger.setBreakpoint',
      'Fetch.enable', 'Network.setBlockedFrequencies',
      'Page.addScriptToEvaluateOnNewDocument', 'Page.setBypassCSP', 'Page.captureScreenshot',
      'Target.createTarget', 'Target.exposeFunction', 'Network.setRequestInterception'];

    for(const method of forbidden) {
      expect(observation.allowCdpMethod('browser', method)).toBe(false);
      expect(observation.allowCdpMethod('page', method)).toBe(false);
      expect(observation.allowCdpMethod('worker', method)).toBe(false);
    }

    expect(observation.BROWSER_CDP_METHODS).toEqual(['Target.setDiscoverTargets', 'Target.attachToTarget', 'Target.detachFromTarget', 'Target.sendMessageToTarget']);
    expect(observation.PAGE_CDP_METHODS).toEqual(['Network.enable', 'Audits.enable', 'Log.enable', 'Runtime.enable', 'Runtime.callFunctionOn', 'Target.setAutoAttach', 'Target.getTargetInfo', 'Target.sendMessageToTarget', 'Target.detachFromTarget']);
    expect(observation.WORKER_CDP_METHODS).toEqual(['Network.enable', 'Audits.enable', 'Log.enable', 'Runtime.enable', 'Runtime.callFunctionOn', 'Runtime.runIfWaitingForDebugger']);
    expect(observation.allowCdpMethod('page', 'Target.getTargetInfo')).toBe(true);
    expect(observation.allowCdpMethod('page', 'Runtime.enable')).toBe(true);
    for(const method of ['Debugger.enable', 'Debugger.setPauseOnExceptions', 'Debugger.resume']) {
      expect(observation.allowCdpMethod('page', method)).toBe(false);
      expect(observation.allowCdpMethod('browser', method)).toBe(false);
      expect(observation.allowCdpMethod('worker', method)).toBe(false);
    }
    expect(observation.allowCdpMethod('page', 'Runtime.callFunctionOn')).toBe(true);
    expect(observation.allowCdpMethod('page', 'Target.setAutoAttach')).toBe(true);
    expect(observation.allowCdpMethod('browser', 'Target.setDiscoverTargets')).toBe(true);
    expect(observation.allowCdpMethod('worker', 'Runtime.enable')).toBe(true);
    expect(observation.allowCdpMethod('worker', 'Runtime.callFunctionOn')).toBe(true);
  });

  it('does not send debugger commands in a default run', async() => {
    const calls: string[] = [];
    const observer = observation.createContextObserver('alice');
    const {cdp, networkObserver} = createNetworkObserverHarness(observer, {
      send: async(method: string) => {
        calls.push(method);
        return method === 'Target.getTargetInfo'
          ? {targetInfo: {targetId: 'contract-test-page', browserContextId: 'contract-test'}}
          : {};
      }
    });
    await networkObserver.start();

    try {
      cdp.emit('Debugger.paused', {reason: 'exception', callFrames: []});
      expect(calls).not.toContain('Debugger.enable');
      expect(calls).not.toContain('Debugger.setPauseOnExceptions');
      expect(calls).not.toContain('Debugger.resume');
    } finally {
      await networkObserver.stop();
    }
  });

  it('uses debugger commands only when page-error diagnostics are enabled', async() => {
    const calls: string[] = [];
    const exceptions: any[] = [];
    const observer = observation.createContextObserver('alice');
    const {cdp, networkObserver} = createNetworkObserverHarness(observer, {
      send: async(method: string) => {
        calls.push(method);
        return method === 'Target.getTargetInfo'
          ? {targetInfo: {targetId: 'contract-test-page', browserContextId: 'contract-test'}}
          : {};
      },
      onPageException: (details: any, source: string) => exceptions.push({details, source})
    });
    await networkObserver.start();

    try {
      expect(calls).toEqual(expect.arrayContaining(['Debugger.enable', 'Debugger.setPauseOnExceptions']));
      cdp.emit('Debugger.paused', {reason: 'exception', callFrames: []});
      await Promise.resolve();
      expect(calls).toContain('Debugger.resume');
      expect(exceptions).toEqual([{details: {reason: 'exception', callFrames: [], executionContextId: undefined, scriptUrls: {}}, source: 'debugger'}]);
    } finally {
      await networkObserver.stop();
    }
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
      block.contexts.alice.workerSourceChunks = ['https://teagramd.test/index.worker-AbCdEfGh.js'];
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
    expect(observation.LIMITS).toEqual({attachedTargets: 32, countedEventsPerContext: 4096, cdpMessageBytes: 262_144, commandTimeoutMs: 5000});

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
  it('counts the injected attach and rejected detach once each', async() => {
    const calls: any[] = [];
    const discovery = createDiscoveryHarness(async(method, params) => {
      calls.push({method, params});
      if(method === 'Target.attachToTarget') return {sessionId: 'injected-session'};
      if(method === 'Target.detachFromTarget') throw new Error(HOSTILE.phrase);
      return {};
    });
    const observer = observation.createContextObserver('c4_attach_failure', {control: true});
    let stopResult: any;
    try {
      await discovery.registry.launch(discovery.browser);
      await discovery.registry.simulateAttachFailure(observer);

      expect(observer.state.attachFailures).toBe(1);
      expect(observer.state.observerErrors).toBe(2);
      expect(calls.filter(({method}) => method === 'Target.attachToTarget')).toHaveLength(1);
      expect(calls.filter(({method}) => method === 'Target.detachFromTarget')).toHaveLength(1);
    } finally {
      stopResult = await discovery.registry.stop();
    }

    expect(stopResult).toMatchObject({detachFailures: 1, discoveryDisabled: true});
  });

  it('counts one observed allowed creation without creating an upgrade or charging twice', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      await harness.attach(alice, 'alice-worker');
      const before = alice.observer.eventCount();
      const workerEvents = vi.spyOn(alice.observer, 'noteWorkerEvent');
      harness.emit(alice, 'alice-worker', 'Network.webSocketCreated', {requestId: 'socket', url: 'wss://teagramd.test/apiws'});

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
      harness.emit(alice, 'alice-worker', 'Network.requestWillBeSent', {type: 'WebSocket', request: {url: 'wss://teagramd.test/apiws'}});
      harness.emit(alice, 'alice-worker', 'Network.webSocketCreated', {requestId: 'repeat', url: 'wss://teagramd.test/apiws'});
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
      harness.emit(alice, 'alice-worker', 'Network.webSocketCreated', {requestId: 'query-socket', url: 'wss://teagramd.test/apiws?extra=1'});
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
      expect(alice.observer.summary().attachedTargets).toBe(1);
      for(const via of [first, second]) {
        harness.emit(alice, 'duplicate-worker', 'Network.webSocketCreated', {requestId: 'socket', url: 'wss://teagramd.test/apiws'}, via);
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
      expect(alice.observer.summary().attachedTargets).toBe(2);
      harness.emit(alice, 'distinct-worker', 'Network.webSocketCreated', {requestId: 'distinct-socket', url: 'wss://teagramd.test/apiws'}, second);
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
        requestId: 'alice-socket', url: 'wss://teagramd.test/apiws', targetId: 'bob-worker', type: 'service_worker', source: 'page'
      }, 'discovery', {targetId: 'bob-worker', type: 'service_worker', source: 'page'});
      expect(alice.networkObserver.summary().attemptsBySource).toEqual({page: 0, shared_worker: 1, service_worker: 0, worker: 0});
      expect(bob.networkObserver.events).toHaveLength(0);
      expect(control.networkObserver.events).toHaveLength(0);
      harness.emit(bob, 'bob-worker', 'Network.webSocketCreated', {requestId: 'bob-socket', url: 'wss://teagramd.test/apiws'});
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
        harness.emit(alice, targetId, 'Network.webSocketCreated', {requestId: targetId, url: 'wss://teagramd.test/apiws'});
      }
      expect(alice.networkObserver.summary()).toMatchObject({allowedWebSockets: 0, workerTargets: {shared_worker: 0, service_worker: 0}});
      expect(alice.networkObserver.events).toHaveLength(0);
      const pending = await harness.startContext('pending');
      await harness.registry.waitForSetup();
      harness.emit(pending, 'pending', 'Network.webSocketCreated', {requestId: 'now-owned', url: 'wss://teagramd.test/apiws'});
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
      harness.emit(alice, 'discovery-worker', 'Network.webSocketCreated', {requestId: 'late-discovery', url: 'wss://teagramd.test/apiws'});
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
      expect(harness.registry.coverageTargets()).toContainEqual({
        type: 'shared_worker',
        owningContext: 'alice',
        scriptAsset: 'unknown',
        causes: ['observer_error']
      });
    } finally {
      await harness.stop();
    }
  });

  it('attributes malformed page-session worker events to their target', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      harness.session.emit('Target.targetCreated', {
        targetInfo: {targetId: 'alice-auto-worker', type: 'service_worker', url: HOSTILE.blobUrl, browserContextId: 'alice'}
      });
      await harness.attach(alice, 'alice-auto-worker', 'auto', 'service_worker');
      harness.emit(alice, 'alice-auto-worker', 'Network.requestWillBeSent', {
        type: 'Fetch', request: {url: 42, initiator: HOSTILE.url}
      }, 'auto');

      expect(alice.observer.summary()).toMatchObject({observerErrors: 1, coverageComplete: 0});
      expect(harness.registry.coverageTargets()).toContainEqual({
        type: 'service_worker',
        owningContext: 'alice',
        scriptAsset: 'unknown',
        causes: ['observer_error']
      });
      expect(JSON.stringify(harness.registry.coverageTargets())).not.toContain(HOSTILE.url);
    } finally {
      await harness.stop();
    }
  });

  it('attributes page-session observer overflow to the target that crossed the event budget', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      harness.session.emit('Target.targetCreated', {
        targetInfo: {targetId: 'alice-overflow-worker', type: 'service_worker', url: HOSTILE.blobUrl, browserContextId: 'alice'}
      });
      await harness.attach(alice, 'alice-overflow-worker', 'auto', 'service_worker');
      for(let index = alice.observer.eventCount(); index < observation.LIMITS.countedEventsPerContext; index++) {
        alice.observer.noteEvent();
      }

      alice.cdp.emit('Target.receivedMessageFromTarget', {
        sessionId: 'auto-alice-overflow-worker',
        message: '{'
      });

      expect(alice.observer.summary()).toMatchObject({observerOverflow: 1, countedEvents: observation.LIMITS.countedEventsPerContext});
      expect(harness.registry.coverageTargets()).toContainEqual({
        type: 'service_worker',
        owningContext: 'alice',
        scriptAsset: 'unknown',
        causes: ['observer_overflow']
      });
    } finally {
      await harness.stop();
    }
  });

  it('attributes iframe page-session observer errors to their owning context', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      harness.session.emit('Target.targetCreated', {
        targetInfo: {targetId: 'alice-iframe', type: 'iframe', url: HOSTILE.url, browserContextId: 'alice'}
      });
      await harness.attach(alice, 'alice-iframe', 'auto', 'iframe');

      alice.cdp.emit('Target.receivedMessageFromTarget', {
        sessionId: 'auto-alice-iframe',
        message: '{'
      });

      expect(alice.observer.summary()).toMatchObject({observerErrors: 1, coverageComplete: 0});
      expect(harness.registry.coverageTargets()).toContainEqual({
        type: 'iframe',
        owningContext: 'alice',
        scriptAsset: 'unknown',
        causes: ['observer_error']
      });
      expect(JSON.stringify(harness.registry.coverageTargets())).not.toContain(HOSTILE.url);
    } finally {
      await harness.stop();
    }
  });

  it('resolves a worker asset fetched after its target notification in coverage details', async() => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const resolver = createPageErrorAssetResolver();
    const harness = await createDiscoveryNetworkHarness({pageErrorAssetResolver: resolver});
    const {alice} = harness;
    try {
      await harness.attach(alice, 'late-blob-worker');
      harness.emit(alice, 'late-blob-worker', 'Network.requestWillBeSent', {
        type: 'Script',
        request: {url: MTPROTO_CHUNK_URL}
      });
      alice.observer.recordObserverError('late-blob-worker');

      expect(harness.registry.coverageTargets()).toContainEqual({
        type: 'shared_worker',
        owningContext: 'alice',
        scriptAsset: 'index.worker-AbCdEfGh.js',
        causes: ['observer_error']
      });
    } finally {
      resolver.clear();
      await harness.stop();
    }
  });

  it('associates an already mapped blob asset with a later worker target notification', () => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const resolver = createPageErrorAssetResolver();
    const blobUrl = 'blob:https://teagramd.test/abababab-abab-abab-abab-abababababab';
    try {
      resolver.observeRequest(MTPROTO_CHUNK_URL, {type: 'script'}, 'Fetch', 'source-worker', 'dedicated_worker');
      resolver.observeRequest(blobUrl, {type: 'script'}, 'Script', 'source-worker', 'dedicated_worker');
      resolver.observeWorkerTarget({targetId: 'late-target-notification', type: 'worker', parentId: 'source-worker', url: blobUrl});

      expect(resolver.workerAsset('late-target-notification')).toBe('index.worker-AbCdEfGh.js');
    } finally {
      resolver.clear();
    }
  });

  it('attributes event-budget overflow caused by target destruction', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      await harness.attach(alice, 'destroyed-at-cap');
      for(let index = alice.observer.eventCount(); index < observation.LIMITS.countedEventsPerContext; index++) {
        alice.observer.noteEvent();
      }
      harness.session.emit('Target.targetDestroyed', {targetId: 'destroyed-at-cap'});

      expect(alice.observer.summary()).toMatchObject({observerOverflow: 1, countedEvents: observation.LIMITS.countedEventsPerContext});
      expect(harness.registry.coverageTargets()).toContainEqual({
        type: 'shared_worker',
        owningContext: 'alice',
        scriptAsset: 'unknown',
        causes: ['observer_overflow']
      });
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
      expect(harness.registry.coverageTargets()).toContainEqual({
        type: 'shared_worker',
        owningContext: 'alice',
        scriptAsset: 'unknown',
        causes: ['observer_error']
      });
      expect(alice.networkObserver.events).toHaveLength(0);
      expectNoHostileLeak(alice.observer.summary());
    } finally {
      await harness.stop();
    }
  });

  it.each([
    {method: 'Network.requestWillBeSent', resourceType: 'Fetch', params: {type: 'Fetch', request: {url: HOSTILE.url}}},
    {method: 'Audits.issueAdded', resourceType: 'Other', params: {issue: {details: {contentSecurityPolicyIssueDetails: {blockedURL: HOSTILE.url, isReportOnly: false}}}}}
  ])('fails the existing egress gate on discovery-only $method', async(event) => {
    const report = await runDiscoveryAccountingGate([event]);
    expect(report).toMatchObject({status: 'failed', stage: 'browser_egress_or_page_errors', network: {unexpectedAttempts: 1}});
    expect(report.network.contexts.alice.unexpectedAttemptsBySource).toEqual({page: 0, shared_worker: 1, service_worker: 0, worker: 0});
    expect(report.gateBreakdown.unexpectedEgressAttempts.alice).toEqual([{
      source: 'shared_worker', scheme: 'https', host: 'unannounced.invalid', resourceType: event.resourceType
    }]);
    expect(parseAuthProgressReport(report).gateBreakdown).toEqual(report.gateBreakdown);
    expectNoGateSecretLeak(report.gateBreakdown);
  });

  it('reports auth-progress page errors by context and script asset', async() => {
    const report = await runDiscoveryAccountingGate([], 'page_error');
    expect(report).toMatchObject({status: 'failed', stage: 'browser_egress_or_page_errors'});
    expect(report.gateBreakdown).toEqual({
      counters: {unexpectedEgressAttempts: 0, observerErrors: 0, pageErrors: 1},
      unexpectedEgressAttempts: {alice: [], bob: []},
      observerErrors: {alice: {}, bob: {}},
      pageErrors: {
        alice: [{
          constructorName: 'TypeError',
          scriptAsset: 'auth-client.js',
          message: '[redacted]',
          stack: {
            state: 'captured',
            lineCount: 2,
            frameCount: 1,
            frames: [{functionName: 'unknown', scriptAsset: 'auth-client.js', line: 21, column: 3}]
          },
          scenarioStep: {scenario: 'sign-in', step: 'alice_context'}
        }],
        bob: []
      },
      pageErrorOverflow: {alice: [], bob: []}
    });
    expect(parseAuthProgressReport(report).gateBreakdown).toEqual(report.gateBreakdown);
    expectNoGateSecretLeak(report.gateBreakdown);
  });

  it('rejects unsafe gate diagnostics on a passing browser report', () => {
    const passingReport: any = {
      status: 'passed',
      gateBreakdown: {
        counters: {unexpectedEgressAttempts: 0, observerErrors: 0, pageErrors: 0},
        unexpectedEgressAttempts: {alice: [], bob: []},
        observerErrors: {alice: {}, bob: {}},
        pageErrors: {alice: [], bob: []},
        pageErrorOverflow: {alice: [], bob: []},
        stepDiagnostics: {alice: [], bob: []}
      }
    };

    expect(parsePassedBrowserGateBreakdown(passingReport)).toEqual(passingReport.gateBreakdown);
    expect(() => parsePassedBrowserGateBreakdown({
      ...passingReport,
      gateBreakdown: {
        ...passingReport.gateBreakdown,
        stepDiagnostics: {
          alice: [{scenarioStep: {scenario: 'message', step: 'alice_message_send'}, thrownValues: [], rpcFailures: [], consoleErrors: [], raw: HOSTILE.phrase}],
          bob: []
        }
      }
    })).toThrow('browser egress/page error evidence is invalid');
    expect(() => parsePassedBrowserGateBreakdown({
      ...passingReport,
      gateBreakdown: {
        ...passingReport.gateBreakdown,
        stepDiagnostics: {
          alice: [{scenarioStep: {scenario: 'message', step: 'alice_message_send'}, thrownValues: [], rpcFailures: [], consoleErrors: [{message: HOSTILE.url}]}],
          bob: []
        }
      }
    })).toThrow('browser egress/page error evidence is invalid');
  });

  it('keeps page-error reports free of page text while retaining safe stack frames', () => {
    const summarizeGateBreakdown = (realClientBrowser as any).summarizeBrowserGateBreakdown;
    const recordPageError = (realClientBrowser as any).recordPageError;
    const pageErrors = {alice: [], bob: []} as any;
    const message = 'private channel text: deployment window is at 09:30';
    const error = new TypeError(message);
    error.stack = `TypeError: ${message}\n    at renderSyntheticChat (https://unannounced.invalid/assets/bob-client.js?token=${HOSTILE.token}:21:3)`;

    recordPageError(pageErrors, 'bob', error, undefined, {scenario: 'channel', step: 'bob_channel_reload_chats_list'}, {
      captureDetails: true,
      pageUrl: `${APP_ORIGIN}/`,
      scenario: 'channel',
      stage: 'bob_channel_reload_chats_list'
    });
    const diagnosticError = new TypeError(message);
    diagnosticError.stack = `TypeError: ${message}\n    at renderSyntheticChat (webpack://bundle/src/client.ts:21:3)`;
    recordPageError(pageErrors, 'bob', diagnosticError, undefined, {scenario: 'channel', step: 'bob_channel_reload_chats_list'}, {
      captureDetails: true,
      pageUrl: `${APP_ORIGIN}/`,
      scenario: 'channel',
      stage: 'bob_channel_reload_chats_list'
    });
    const breakdown = summarizeGateBreakdown({pageErrors});

    expect(breakdown.pageErrors.bob[0]).toEqual({
      constructorName: 'TypeError',
      scriptAsset: 'bob-client.js',
      message: '[redacted]',
      stack: {
        state: 'captured',
        lineCount: 2,
        frameCount: 1,
        frames: [{functionName: 'renderSyntheticChat', scriptAsset: 'bob-client.js', line: 21, column: 3}]
      },
      scenarioStep: {scenario: 'channel', step: 'bob_channel_reload_chats_list'}
    });
    expect(breakdown.pageErrors.bob[1]).toEqual({
      constructorName: 'TypeError',
      scriptAsset: 'unknown',
      message: '[redacted]',
      stack: {
        state: 'unclassified_frames',
        lineCount: 2,
        frameCount: 1,
        frames: []
      },
      scenarioStep: {scenario: 'channel', step: 'bob_channel_reload_chats_list'},
      diagnostic: {
        pageUrl: `${APP_ORIGIN}/`,
        scenario: 'channel',
        stage: 'bob_channel_reload_chats_list'
      }
    });
    expect(JSON.stringify(breakdown)).not.toContain(message);
    expect(formatBrowserFailureMessage({status: 'failed', stage: 'browser_egress_or_page_errors', gateBreakdown: breakdown}))
    .toContain(JSON.stringify(breakdown));
    expectNoGateSecretLeak(breakdown);
    for(const pageError of [
      {...breakdown.pageErrors.bob[0], message: HOSTILE.url},
      {...breakdown.pageErrors.bob[0], stack: {...breakdown.pageErrors.bob[0].stack, frames: [{...breakdown.pageErrors.bob[0].stack.frames[0], url: HOSTILE.url}]}},
      {...breakdown.pageErrors.bob[0], scenarioStep: {scenario: 'channel', step: HOSTILE.phrase}},
      {...breakdown.pageErrors.bob[1], diagnostic: {...breakdown.pageErrors.bob[1].diagnostic, message}},
      {...breakdown.pageErrors.bob[1], diagnostic: {...breakdown.pageErrors.bob[1].diagnostic, stack: message}}
    ]) {
      const invalid = {...breakdown, pageErrors: {alice: [], bob: [pageError]}};
      expect(() => formatBrowserFailureMessage({status: 'failed', stage: 'browser_egress_or_page_errors', gateBreakdown: invalid}))
      .toThrow('browser egress/page error evidence is invalid');
    }

    const missingStackError = {name: 'Error', message: 'Synthetic missing stack'};
    recordPageError(pageErrors, 'bob', missingStackError, undefined, {scenario: 'channel', step: 'bob_channel_post_visible'});
    const unclassifiedStackError = new Error('Synthetic unclassified stack');
    unclassifiedStackError.stack = 'Error: Synthetic unclassified stack\n    at load (webpack://bundle/src/client.js:33:7)';
    recordPageError(pageErrors, 'bob', unclassifiedStackError, undefined, {scenario: 'channel', step: 'bob_channel_post_visible'});
    const stackStates = summarizeGateBreakdown({pageErrors}).pageErrors.bob.slice(1).map((pageError: any) => pageError.stack);
    expect(stackStates).toEqual([
      {state: 'unclassified_frames', lineCount: 2, frameCount: 1, frames: []},
      {state: 'unavailable', lineCount: 0, frameCount: 0, frames: []},
      {state: 'unclassified_frames', lineCount: 2, frameCount: 1, frames: []}
    ]);
  });

  it('correlates simultaneous window, Runtime and debugger observations of one object rejection', async() => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const enrichPageErrorDetails = (realClientBrowser as any).enrichPageErrorDetails;
    const recordPageErrorProtocolEvent = (realClientBrowser as any).recordPageErrorProtocolEvent;
    const resolver = createPageErrorAssetResolver();
    const pageErrors = createDiagnosticPageErrors();
    const source = `${APP_ORIGIN}/index-XYZ.js`;
    const page = {
      url: () => `${APP_ORIGIN}/`,
      evaluate: async(): Promise<unknown[]> => [{
        message: 'Object',
        stack: '',
        filename: '',
        lineNumber: 0,
        columnNumber: 0,
        pageUrl: `${APP_ORIGIN}/`,
        errorType: 'CHANNELS_ADMIN_PUBLIC_TOO_MUCH',
        errorCode: 400
      }]
    } as any;
    recordPageErrorProtocolEvent(page, {
      exceptionId: 11,
      executionContextId: 3,
      text: 'Uncaught (in promise)',
      scriptId: '1',
      lineNumber: 0,
      columnNumber: 0,
      exception: {
        type: 'object',
        description: 'Object',
        objectId: 'runtime-object-11',
        preview: {properties: [
          {name: 'type', type: 'string', value: 'CHANNELS_ADMIN_PUBLIC_TOO_MUCH'},
          {name: 'code', type: 'number', value: '400'}
        ]}
      },
      stackTrace: {callFrames: [{
        scriptId: '1',
        url: `${APP_ORIGIN}/`,
        functionName: '',
        lineNumber: 0,
        columnNumber: 0
      }]}
    }, 'runtime');
    recordPageErrorProtocolEvent(page, {
      reason: 'promiseRejection',
      executionContextId: 3,
      data: {type: 'object', description: 'Object', objectId: 'debugger-object-11'},
      callFrames: [{
        functionName: 'inviteToChannel',
        url: '',
        location: {scriptId: '7', lineNumber: 40, columnNumber: 8}
      }],
      scriptUrls: {'7': source}
    }, 'debugger');

    await enrichPageErrorDetails(pageErrors, 'alice', page, resolver);

    expect(pageErrors.alice[0].scriptAsset).toBe('index-XYZ.js');
    expect(pageErrors.alice[0].stack).toEqual({
      state: 'captured',
      lineCount: 2,
      frameCount: 1,
      frames: [{functionName: 'inviteToChannel', scriptAsset: 'index-XYZ.js', line: 41, column: 9}]
    });
    expect(pageErrors.alice[0].diagnostic).toMatchObject({
      pageUrl: `${APP_ORIGIN}/`,
      scenario: 'channel',
      stage: 'alice_channel_invite_button',
      rpcErrorType: 'CHANNELS_ADMIN_PUBLIC_TOO_MUCH',
      rpcErrorCode: 400
    });
    expect(JSON.stringify(pageErrors)).not.toContain('Object');
    resolver.clear();
  });

  it('keeps same-message exceptions separate when their protocol identities differ', async() => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const enrichPageErrorDetails = (realClientBrowser as any).enrichPageErrorDetails;
    const recordPageErrorProtocolEvent = (realClientBrowser as any).recordPageErrorProtocolEvent;
    const resolver = createPageErrorAssetResolver();
    const pageErrors = createDiagnosticPageErrors();
    const page = {url: () => `${APP_ORIGIN}/`, evaluate: async(): Promise<unknown[]> => []} as any;
    const createRuntimeException = (exceptionId: number, scriptId: string, functionName: string) => ({
      exceptionId,
      executionContextId: 3,
      text: 'Uncaught (in promise)',
      scriptId,
      lineNumber: 40,
      columnNumber: 8,
      exception: {type: 'object', description: 'Object', objectId: `runtime-object-${exceptionId}`},
      stackTrace: {callFrames: [{
        scriptId,
        url: `${APP_ORIGIN}/index-${scriptId}.js`,
        functionName,
        lineNumber: 40,
        columnNumber: 8
      }]}
    });
    recordPageErrorProtocolEvent(page, createRuntimeException(11, '1', 'inviteToChannel'), 'runtime');
    recordPageErrorProtocolEvent(page, {
      reason: 'promiseRejection',
      executionContextId: 3,
      data: {type: 'object', description: 'Object'},
      callFrames: [{
        functionName: 'inviteToChannel',
        url: '',
        location: {scriptId: '7', lineNumber: 40, columnNumber: 8}
      }],
      scriptUrls: {'7': `${APP_ORIGIN}/index-7.js`}
    }, 'debugger');
    recordPageErrorProtocolEvent(page, createRuntimeException(12, '8', 'unrelatedHandler'), 'runtime');

    await enrichPageErrorDetails(pageErrors, 'alice', page, resolver);

    expect(pageErrors.alice[0].scriptAsset).toBe('unknown');
    expect(pageErrors.alice[0].stack.state).toBe('no_frames');
    expect(pageErrors.alice[0].diagnostic.rpcErrorType).toBeUndefined();
    resolver.clear();
  });

  it('leaves page-error attribution unknown when generic messages match multiple fallback events', async() => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const enrichPageErrorDetails = (realClientBrowser as any).enrichPageErrorDetails;
    const resolver = createPageErrorAssetResolver();
    const pageErrors = createDiagnosticPageErrors();
    const page = {evaluate: async(): Promise<unknown[]> => []} as any;
    const events = [{
      message: 'Object',
      stack: `Object\n    at inviteToChannel (${APP_ORIGIN}/index-Aaaa.js:91:7)`,
      filename: `${APP_ORIGIN}/index-Aaaa.js`,
      lineNumber: 91,
      columnNumber: 7,
      pageUrl: `${APP_ORIGIN}/`,
      errorType: 'CHANNELS_ADMIN_PUBLIC_TOO_MUCH'
    }, {
      message: 'Object',
      stack: `Object\n    at unrelatedHandler (${APP_ORIGIN}/index-Bbbb.js:4:2)`,
      filename: `${APP_ORIGIN}/index-Bbbb.js`,
      lineNumber: 4,
      columnNumber: 2,
      pageUrl: `${APP_ORIGIN}/other`,
      errorCode: 400
    }];

    await enrichPageErrorDetails(pageErrors, 'alice', page, resolver, [], events);

    expect(pageErrors.alice[0].scriptAsset).toBe('unknown');
    expect(pageErrors.alice[0].stack.state).toBe('no_frames');
    expect(pageErrors.alice[0].diagnostic.rpcErrorType).toBeUndefined();
    resolver.clear();
  });

  it('enriches page-error evidence for failures before the final scenario gate', async() => {
    const enrichPageErrorReport = (realClientBrowser as any).enrichPageErrorReport;
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const resolver = createPageErrorAssetResolver();
    const pageErrors = createDiagnosticPageErrors('invite failed');
    const page = {evaluate: async(): Promise<unknown[]> => [{
      message: 'invite failed',
      stack: `Error: invite failed\n    at inviteToChannel (${APP_ORIGIN}/index-XYZ.js?token=${HOSTILE.token}:91:7)`,
      filename: `${APP_ORIGIN}/index-XYZ.js?token=${HOSTILE.token}`,
      lineNumber: 91,
      columnNumber: 7,
      pageUrl: `${APP_ORIGIN}/?token=${HOSTILE.token}`
    }]} as any;

    const gateBreakdown = await enrichPageErrorReport(pageErrors, {alice: page}, {alice: resolver}, {}, [HOSTILE.token]);
    const failureMessage = formatBrowserFailureMessage({
      status: 'failed',
      stage: 'alice_channel_invite_button',
      gateBreakdown
    });

    expect(failureMessage).toContain('"line":91,"column":7');
    expect(failureMessage).toContain(`${APP_ORIGIN}/`);
    expect(failureMessage).not.toContain(HOSTILE.token);
    expect(failureMessage).not.toContain('invite failed');
    resolver.clear();
  });

  it('attributes blob stack frames from correlated worker evidence without persisting blob identifiers', async() => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const recordPageError = (realClientBrowser as any).recordPageError;
    const summarizeGateBreakdown = (realClientBrowser as any).summarizeBrowserGateBreakdown;
    expect(typeof createPageErrorAssetResolver).toBe('function');
    expect(typeof recordPageError).toBe('function');
    expect(typeof summarizeGateBreakdown).toBe('function');

    const resolver = createPageErrorAssetResolver();
    const observer = observation.createContextObserver('alice');
    const {cdp, networkObserver} = createWorkerNetworkObserverHarness(observer, 'contract-test', {pageErrorAssetResolver: resolver});
    const pageErrors = {alice: [], bob: []} as any;
    await networkObserver.start();

    try {
      cdp.emit('Network.requestWillBeSent', {
        type: 'Script',
        request: {url: HOSTILE.blobUrl},
        initiator: {type: 'script', stack: {callFrames: [{url: MTPROTO_CHUNK_URL}]}}
      });
      const blobFromUrl = 'blob:https://teagramd.test/22222222-2222-2222-2222-222222222222';
      cdp.emit('Network.requestWillBeSent', {
        type: 'Script',
        request: {url: blobFromUrl},
        initiator: {type: 'other', url: MTPROTO_CHUNK_URL}
      });
      const blobWithoutInitiator = 'blob:https://teagramd.test/33333333-3333-3333-3333-333333333333';
      cdp.emit('Network.requestWillBeSent', {
        type: 'Fetch',
        request: {url: MTPROTO_CHUNK_URL},
        initiator: {type: 'script'}
      });
      cdp.emit('Target.attachedToTarget', {
        sessionId: 'rival-worker-session',
        targetInfo: {
          targetId: 'rival-worker-target',
          type: 'shared_worker',
          url: `${APP_ORIGIN}/rival.worker-ZzYyXxWw.js`
        }
      });
      await networkObserver.waitForSetup();
      cdp.emit('Target.receivedMessageFromTarget', {
        sessionId: 'rival-worker-session',
        message: JSON.stringify({
          method: 'Network.requestWillBeSent',
          params: {type: 'Fetch', request: {url: LOTTIE_WORKER_CHUNK_URL}}
        })
      });
      cdp.emit('Target.attachedToTarget', {
        sessionId: 'worker-session',
        targetInfo: {
          targetId: 'mtproto-worker-target',
          type: 'shared_worker',
          url: blobWithoutInitiator,
          browserContextId: 'contract-test'
        }
      });
      await networkObserver.waitForSetup();
      cdp.emit('Network.requestWillBeSent', {
        type: 'Script',
        request: {url: blobWithoutInitiator},
        initiator: {type: 'other'}
      });
      const error = new TypeError(HOSTILE.phrase);
      error.stack = `TypeError: ${HOSTILE.phrase}\n    at t (${HOSTILE.blobUrl}:1:183)\n    at r (${blobFromUrl}:2:12)`;
      recordPageError(pageErrors, 'alice', error, resolver, {scenario: 'sign-in', step: 'alice_context'});

      const pageErrorsFromUrl = {alice: [], bob: []} as any;
      const urlOnlyError = new TypeError(HOSTILE.phrase);
      urlOnlyError.stack = `TypeError: ${HOSTILE.phrase}\n    at r (${blobFromUrl}:2:12)`;
      recordPageError(pageErrorsFromUrl, 'alice', urlOnlyError, resolver, {scenario: 'sign-in', step: 'alice_context'});

      const breakdown = summarizeGateBreakdown({pageErrors});
      const breakdownFromUrl = summarizeGateBreakdown({pageErrors: pageErrorsFromUrl});
      const expectedPageError = {
        constructorName: 'TypeError',
        scriptAsset: 'unknown',
        message: '[redacted]',
        stack: {
          state: 'captured',
          lineCount: 3,
          frameCount: 2,
          frames: [
            {functionName: 't', scriptAsset: 'unknown', line: 1, column: 183},
            {functionName: 'r', scriptAsset: 'unknown', line: 2, column: 12}
          ]
        },
        scenarioStep: {scenario: 'sign-in', step: 'alice_context'}
      };
      expect(breakdown.pageErrors.alice).toEqual([expectedPageError]);
      expect(breakdownFromUrl.pageErrors.alice).toEqual([{
        ...expectedPageError,
        stack: {state: 'captured', lineCount: 2, frameCount: 1, frames: [expectedPageError.stack.frames[1]]}
      }]);
      expect(JSON.stringify(breakdown)).not.toContain(HOSTILE.blobUrl);
      expect(JSON.stringify(breakdown)).not.toContain(blobFromUrl);
      expect(JSON.stringify(breakdown)).not.toContain(HOSTILE.phrase);
      expect(JSON.stringify(breakdown)).not.toContain(HOSTILE.token);
      expect(JSON.stringify(breakdownFromUrl)).not.toContain(blobFromUrl);

      const pageErrorsFromFetch = {alice: [], bob: []} as any;
      const fetchOnlyError = new TypeError(HOSTILE.phrase);
      fetchOnlyError.stack = `TypeError: ${HOSTILE.phrase}\n    at r (${blobWithoutInitiator}:2:12)`;
      recordPageError(pageErrorsFromFetch, 'alice', fetchOnlyError, resolver, {scenario: 'sign-in', step: 'alice_context'});
      const breakdownFromFetch = summarizeGateBreakdown({pageErrors: pageErrorsFromFetch});
      expect(breakdownFromFetch.pageErrors.alice).toEqual([{
        ...expectedPageError,
        scriptAsset: 'index.worker-AbCdEfGh.js',
        stack: {
          state: 'captured',
          lineCount: 2,
          frameCount: 1,
          frames: [{functionName: 'r', scriptAsset: 'index.worker-AbCdEfGh.js', line: 2, column: 12}]
        }
      }]);
      expect(JSON.stringify(breakdownFromFetch)).not.toContain(blobWithoutInitiator);

      const blobFromScriptRequest = 'blob:https://teagramd.test/66666666-6666-6666-6666-666666666666';
      cdp.emit('Network.requestWillBeSent', {
        type: 'Fetch',
        request: {url: MTPROTO_CHUNK_URL},
        initiator: {type: 'script'}
      });
      cdp.emit('Network.requestWillBeSent', {
        type: 'Script',
        request: {url: blobFromScriptRequest},
        initiator: {type: 'other'}
      });
      const scriptRequestError = new TypeError(HOSTILE.phrase);
      scriptRequestError.stack = `TypeError: ${HOSTILE.phrase}\n    at t (${blobFromScriptRequest}:1:183)`;
      const pageErrorsFromScriptRequest = {alice: [], bob: []} as any;
      recordPageError(pageErrorsFromScriptRequest, 'alice', scriptRequestError, resolver, {scenario: 'sign-in', step: 'alice_context'});
      const breakdownFromScriptRequest = summarizeGateBreakdown({pageErrors: pageErrorsFromScriptRequest});
      expect(breakdownFromScriptRequest.pageErrors.alice).toEqual([{
        ...expectedPageError,
        scriptAsset: 'index.worker-AbCdEfGh.js',
        stack: {
          state: 'captured',
          lineCount: 2,
          frameCount: 1,
          frames: [{functionName: 't', scriptAsset: 'index.worker-AbCdEfGh.js', line: 1, column: 183}]
        }
      }]);
      expect(JSON.stringify(breakdownFromScriptRequest)).not.toContain(blobFromScriptRequest);

      const lottieBlobUrl = 'blob:https://teagramd.test/55555555-5555-5555-5555-555555555555';
      resolver.observeRequest(LOTTIE_WORKER_CHUNK_URL, {type: 'script'}, 'Fetch', 'lottie-error-target');
      const lottiePageErrors = {alice: [], bob: []} as any;
      const lottieError = new Error(HOSTILE.phrase);
      lottieError.stack = `Error: ${HOSTILE.phrase}\n    at TLottieWasm.createAnimation (${lottieBlobUrl}:1197:23)\n    at TLottieItem.init (${lottieBlobUrl}:1328:35)\n    at Object.loadFromData [as callback] (${lottieBlobUrl}:1580:16)\n    at async SuperMessagePort.processInvokeTask [as invoke] (${lottieBlobUrl}:804:29)`;
      recordPageError(lottiePageErrors, 'alice', lottieError, resolver, {scenario: 'channel', step: 'bob_channel_post_visible'});
      const lottieBreakdown = summarizeGateBreakdown({pageErrors: lottiePageErrors});
      expect(lottieBreakdown.counters.pageErrors).toBe(1);
      expect(lottieBreakdown.pageErrors.alice).toEqual([{
        constructorName: 'Error',
        scriptAsset: 'tlottie.worker-JkLmNoPq.js',
        message: '[redacted]',
        stack: {
          state: 'captured',
          lineCount: 5,
          frameCount: 4,
          frames: [
            {functionName: 'TLottieWasm.createAnimation', scriptAsset: 'tlottie.worker-JkLmNoPq.js', line: 1197, column: 23},
            {functionName: 'TLottieItem.init', scriptAsset: 'tlottie.worker-JkLmNoPq.js', line: 1328, column: 35},
            {functionName: 'unknown', scriptAsset: 'tlottie.worker-JkLmNoPq.js', line: 1580, column: 16},
            {functionName: 'unknown', scriptAsset: 'tlottie.worker-JkLmNoPq.js', line: 804, column: 29}
          ]
        },
        scenarioStep: {scenario: 'channel', step: 'bob_channel_post_visible'}
      }]);
      expect(JSON.stringify(lottieBreakdown)).not.toContain(lottieBlobUrl);
    } finally {
      resolver.clear();
      await networkObserver.stop();
    }
  });

  it('resolves unmapped blob script frames from fetched bundles and keeps unknown for frameless stacks', () => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const resolver = createPageErrorAssetResolver();
    resolver.observeRequest(MTPROTO_CHUNK_URL, {type: 'script'}, 'Fetch', 'contract-test-page');

    const firstBlobUrl = 'blob:https://teagramd.test/77777777-7777-7777-7777-777777777777';
    const secondBlobUrl = 'blob:https://teagramd.test/88888888-8888-8888-8888-888888888888';
    expect(resolver.scriptAsset(`Error: failed\n    at render (${firstBlobUrl}:1:183)`)).toBe('index.worker-AbCdEfGh.js');
    expect(resolver.scriptAsset(`Error: failed\n    at render (${secondBlobUrl}:1:183)`)).toBe('index.worker-AbCdEfGh.js');
    expect(resolver.scriptAsset('Error: failed')).toBe('unknown');
    resolver.clear();
  });

  it('correlates interleaved worker blobs by source and rejects ambiguous fallback', () => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const resolver = createPageErrorAssetResolver();
    const firstBlobUrl = 'blob:https://teagramd.test/99999999-9999-9999-9999-999999999999';
    const secondBlobUrl = 'blob:https://teagramd.test/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const uncorrelatedBlobUrl = 'blob:https://teagramd.test/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    try {
      resolver.observeRequest(MTPROTO_CHUNK_URL, {type: 'script'}, 'Fetch', 'worker-a', 'dedicated_worker');
      resolver.observeRequest(LOTTIE_WORKER_CHUNK_URL, {type: 'script'}, 'Fetch', 'worker-b', 'dedicated_worker');
      resolver.observeWorkerTarget({type: 'worker', targetId: 'worker-b-blob', parentId: 'worker-b', url: secondBlobUrl});
      resolver.observeWorkerTarget({type: 'worker', targetId: 'worker-a-blob', parentId: 'worker-a', url: firstBlobUrl});

      expect(resolver.scriptAsset(`Error: failed\n    at render (${firstBlobUrl}:1:183)`)).toBe('index.worker-AbCdEfGh.js');
      expect(resolver.scriptAsset(`Error: failed\n    at render (${secondBlobUrl}:1:183)`)).toBe('tlottie.worker-JkLmNoPq.js');
      expect(resolver.scriptAsset(`Error: failed\n    at render (${uncorrelatedBlobUrl}:1:183)`)).toBe('unknown');
    } finally {
      resolver.clear();
    }
  });

  it('prefers a correlated worker bundle over its main-bundle initiator', () => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const resolver = createPageErrorAssetResolver();
    const blobUrl = 'blob:https://teagramd.test/cccccccc-cccc-cccc-cccc-cccccccccccc';

    vi.useFakeTimers();
    try {
      resolver.observeRequest(LOTTIE_WORKER_CHUNK_URL, {type: 'script'}, 'Fetch', 'lottie-worker', 'dedicated_worker');
      vi.advanceTimersByTime(30_001);
      resolver.observeRequest(blobUrl, {
        type: 'script',
        stack: {callFrames: [{url: `${APP_ORIGIN}/main-QqRrSsTt.js`}]}
      }, 'Script', 'lottie-worker', 'dedicated_worker');

      expect(resolver.scriptAsset(`Error: failed\n    at render (${blobUrl}:1:183)`)).toBe('tlottie.worker-JkLmNoPq.js');
    } finally {
      resolver.clear();
      vi.useRealTimers();
    }
  });

  it('does not cache a main-bundle initiator when page worker fetches are ambiguous', () => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const resolver = createPageErrorAssetResolver();
    const pageTargetId = 'shared-page-target';
    const blobUrl = 'blob:https://teagramd.test/12121212-1212-1212-1212-121212121212';

    try {
      resolver.observeRequest(MTPROTO_CHUNK_URL, {type: 'script'}, 'Fetch', pageTargetId);
      resolver.observeRequest(LOTTIE_WORKER_CHUNK_URL, {type: 'script'}, 'Fetch', pageTargetId);
      resolver.observeRequest(blobUrl, {
        type: 'script',
        stack: {callFrames: [{url: `${APP_ORIGIN}/main-QqRrSsTt.js`}]}
      }, 'Script', pageTargetId);

      const lottieStack = `Error: failed\n    at TLottieWasm.createAnimation (${blobUrl}:1197:23)\n    at TLottieItem.init (${blobUrl}:1328:35)`;
      expect(resolver.scriptAsset(lottieStack)).toBe('tlottie.worker-JkLmNoPq.js');
    } finally {
      resolver.clear();
    }
  });

  it('keeps lifetime attribution for hinted stacks and expires unhinted fallback', () => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const resolver = createPageErrorAssetResolver();
    const hintedBlobUrl = 'blob:https://teagramd.test/dddddddd-dddd-dddd-dddd-dddddddddddd';
    const unhintedBlobUrl = 'blob:https://teagramd.test/ffffffff-ffff-ffff-ffff-ffffffffffff';

    vi.useFakeTimers();
    try {
      resolver.observeRequest(LOTTIE_WORKER_CHUNK_URL, {type: 'script'}, 'Fetch', 'delayed-lottie-worker', 'dedicated_worker');
      vi.advanceTimersByTime(30_001);

      expect(resolver.scriptAsset(`Error: failed\n    at TLottieWasm.createAnimation (${hintedBlobUrl}:1:183)`)).toBe('tlottie.worker-JkLmNoPq.js');
      expect(resolver.scriptAsset(`Error: failed\n    at render (${unhintedBlobUrl}:1:183)`)).toBe('unknown');
    } finally {
      resolver.clear();
      vi.useRealTimers();
    }
  });

  it('does not map an unmatched blob from stale worker or loader evidence', () => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const resolver = createPageErrorAssetResolver();
    const blobUrl = 'blob:https://teagramd.test/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    vi.useFakeTimers();
    try {
      resolver.observeRequest(LOTTIE_WORKER_CHUNK_URL, {type: 'script'}, 'Fetch', 'other-worker', 'dedicated_worker');
      vi.advanceTimersByTime(30_001);
      resolver.observeRequest(blobUrl, {
        type: 'script',
        stack: {callFrames: [{url: `${APP_ORIGIN}/main-QqRrSsTt.js`}]}
      }, 'Script', 'unmatched-worker', 'dedicated_worker');

      expect(resolver.scriptAsset(`Error: failed\n    at render (${blobUrl}:1:183)`)).toBe('unknown');
    } finally {
      resolver.clear();
      vi.useRealTimers();
    }
  });

  it('attributes a blob worker from its fetched bundle through browser discovery', async() => {
    const createPageErrorAssetResolver = (realClientBrowser as any).createPageErrorAssetResolver;
    const recordPageError = (realClientBrowser as any).recordPageError;
    const summarizeGateBreakdown = (realClientBrowser as any).summarizeBrowserGateBreakdown;
    const resolver = createPageErrorAssetResolver();
    const observer = observation.createContextObserver('alice');
    const discovery = createDiscoveryHarness();
    discovery.session.send = async(method: string, params: any) => {
      if(method === 'Target.attachToTarget') return {sessionId: 'worker-session'};
      if(method === 'Target.sendMessageToTarget') {
        const {id} = JSON.parse(params.message);
        queueMicrotask(() => discovery.session.emit('Target.receivedMessageFromTarget', {
          sessionId: params.sessionId,
          message: JSON.stringify({id, result: {}})
        }));
      }
      return {};
    };
    const {networkObserver} = createWorkerNetworkObserverHarness(observer, 'contract-test', {pageErrorAssetResolver: resolver});
    const blobUrl = 'blob:https://teagramd.test/44444444-4444-4444-4444-444444444444';
    const pageErrors = {alice: [], bob: []} as any;
    await discovery.registry.launch(discovery.browser);
    await networkObserver.start(discovery.registry);

    try {
      resolver.observeRequest(MTPROTO_CHUNK_URL, {type: 'script'}, 'Fetch', 'contract-test-page');
      discovery.session.emit('Target.targetCreated', {
        targetInfo: {
          targetId: 'mtproto-worker-target',
          type: 'shared_worker',
          url: blobUrl,
          parentId: 'contract-test-page',
          browserContextId: 'contract-test'
        }
      });
      await discovery.registry.waitForSetup();

      const error = new TypeError(HOSTILE.phrase);
      error.stack = `TypeError: ${HOSTILE.phrase}\n    at t (${blobUrl}:1:183)`;
      recordPageError(pageErrors, 'alice', error, resolver, {scenario: 'sign-in', step: 'alice_context'});
      const breakdown = summarizeGateBreakdown({pageErrors});
      expect(breakdown.pageErrors.alice).toEqual([{
        constructorName: 'TypeError',
        scriptAsset: 'index.worker-AbCdEfGh.js',
        message: '[redacted]',
        stack: {
          state: 'captured',
          lineCount: 2,
          frameCount: 1,
          frames: [{functionName: 't', scriptAsset: 'index.worker-AbCdEfGh.js', line: 1, column: 183}]
        },
        scenarioStep: {scenario: 'sign-in', step: 'alice_context'}
      }]);
      expect(JSON.stringify(breakdown)).not.toContain(blobUrl);
      expect(JSON.stringify(breakdown)).not.toContain(HOSTILE.phrase);
    } finally {
      await discovery.registry.stop();
      await networkObserver.stop();
      resolver.clear();
    }
  });

  it('summarizes attribution for page errors beyond the detail limit', async() => {
    const report = await runDiscoveryAccountingGate([], 'page_error_overflow');
    const breakdown = report.gateBreakdown;
    expect(report).toMatchObject({status: 'failed', stage: 'browser_egress_or_page_errors'});
    expect(breakdown.counters.pageErrors).toBe(515);
    expect(breakdown.pageErrors.alice).toHaveLength(512);
    expect(breakdown.pageErrors.alice[0]).toEqual({
      constructorName: 'TypeError',
      scriptAsset: 'auth-client.js',
      message: '[redacted]',
      stack: {
        state: 'captured',
        lineCount: 2,
        frameCount: 1,
        frames: [{functionName: 'unknown', scriptAsset: 'auth-client.js', line: 21, column: 3}]
      },
      scenarioStep: {scenario: 'sign-in', step: 'alice_context'}
    });
    expect(breakdown.pageErrorOverflow).toEqual({
      alice: [
        {
          constructorName: 'RangeError',
          scriptAsset: 'overflow-client.js',
          message: '[redacted]',
          stack: {
            state: 'captured',
            lineCount: 2,
            frameCount: 1,
            frames: [{functionName: 'unknown', scriptAsset: 'overflow-client.js', line: 21, column: 3}]
          },
          scenarioStep: {scenario: 'sign-in', step: 'alice_context'},
          count: 1
        },
        {
          constructorName: 'TypeError',
          scriptAsset: 'auth-client.js',
          message: '[redacted]',
          stack: {
            state: 'captured',
            lineCount: 2,
            frameCount: 1,
            frames: [{functionName: 'unknown', scriptAsset: 'auth-client.js', line: 21, column: 3}]
          },
          scenarioStep: {scenario: 'sign-in', step: 'alice_context'},
          count: 2
        }
      ],
      bob: []
    });
    expect(parseAuthProgressReport(report).gateBreakdown).toEqual(breakdown);
    expect(formatBrowserFailureMessage({status: 'failed', stage: 'browser_egress_or_page_errors', gateBreakdown: breakdown}))
    .toContain(`; browser egress/page errors ${JSON.stringify(breakdown)}`);
    expectNoGateSecretLeak(breakdown);
  });

  it('breaks down the final gate by context and redacts private error details', async() => {
    const summarizeGateBreakdown = (realClientBrowser as any).summarizeBrowserGateBreakdown;
    const recordPageError = (realClientBrowser as any).recordPageError;
    expect(typeof summarizeGateBreakdown).toBe('function');
    expect(typeof recordPageError).toBe('function');

    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    const bob = await harness.startContext('bob');
    const pageErrors = {alice: [], bob: []} as any;
    try {
      alice.cdp.emit('Network.requestWillBeSent', {type: 'Image', request: {url: HOSTILE.url}});
      await harness.attach(alice, 'alice-unexpected-worker');
      harness.emit(alice, 'alice-unexpected-worker', 'Network.requestWillBeSent', {
        type: 'Fetch', request: {url: HOSTILE.url}
      });
      await harness.attach(alice, 'alice-service-worker', 'auto', 'service_worker');
      harness.emit(alice, 'alice-service-worker', 'Network.requestWillBeSent', {
        type: 'Script', request: {url: HOSTILE.url}
      }, 'auto');
      await harness.attach(alice, 'alice-dedicated-worker', 'auto', 'worker');
      harness.emit(alice, 'alice-dedicated-worker', 'Network.requestWillBeSent', {
        type: 'XHR', request: {url: HOSTILE.url}
      }, 'auto');

      await harness.attach(bob, 'bob-invalid-worker');
      harness.emit(bob, 'bob-invalid-worker', 'Network.requestWillBeSent', {
        type: 'Fetch', request: {url: ''}
      });
      const error = new TypeError(HOSTILE.phrase);
      error.stack = `TypeError: ${HOSTILE.phrase}\n    at https://unannounced.invalid/assets/bob-client.js?token=${HOSTILE.token}:21:3`;
      recordPageError(pageErrors, 'bob', error, undefined, {scenario: 'message', step: 'bob_direct_message_visible'});

      const breakdown = summarizeGateBreakdown({
        networkObservers: {alice: alice.networkObserver, bob: bob.networkObserver},
        pageErrors
      });
      expect(breakdown).toEqual({
        counters: {unexpectedEgressAttempts: 4, observerErrors: 1, pageErrors: 1},
        unexpectedEgressAttempts: {
          alice: [
            {source: 'page', scheme: 'https', host: 'unannounced.invalid', resourceType: 'Image'},
            {source: 'shared_worker', scheme: 'https', host: 'unannounced.invalid', resourceType: 'Fetch'},
            {source: 'service_worker', scheme: 'https', host: 'unannounced.invalid', resourceType: 'Script'},
            {source: 'dedicated_worker', scheme: 'https', host: 'unannounced.invalid', resourceType: 'XHR'}
          ],
          bob: []
        },
        observerErrors: {
          alice: {},
          bob: {invalid_worker_cdp_message: 1}
        },
        pageErrors: {
          alice: [],
          bob: [{
            constructorName: 'TypeError',
            scriptAsset: 'bob-client.js',
            message: '[redacted]',
            stack: {
              state: 'captured',
              lineCount: 2,
              frameCount: 1,
              frames: [{functionName: 'unknown', scriptAsset: 'bob-client.js', line: 21, column: 3}]
            },
            scenarioStep: {scenario: 'message', step: 'bob_direct_message_visible'}
          }]
        },
        pageErrorOverflow: {alice: [], bob: []}
      });
      const serialized = JSON.stringify(breakdown);
      expect(serialized).not.toContain(HOSTILE.password);
      expect(serialized).not.toContain(HOSTILE.token);
      expect(serialized).not.toContain(HOSTILE.phrase);
      expect(serialized).not.toContain(HOSTILE.url);
      expect(serialized).not.toContain('/assets/');
      expect(serialized).not.toMatch(/https?:|wss?:/);
      expect(formatBrowserFailureMessage({status: 'failed', stage: 'browser_egress_or_page_errors', gateBreakdown: breakdown}))
      .toContain(`; browser egress/page errors ${serialized}`);
    } finally {
      await harness.stop();
    }
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

  it.each(['attach', 'setup'])('attributes a discovery %s failure to its worker', async(fault) => {
    const harness = await createDiscoveryNetworkHarness(fault === 'attach' ? {attachFailure: true} : {setupFailure: true});
    const {alice} = harness;
    try {
      await harness.attach(alice, 'alice-worker');

      expect(alice.observer.summary()).toMatchObject({observerErrors: 1, coverageComplete: 0});
      expect(harness.registry.coverageTargets()).toContainEqual({
        type: 'shared_worker',
        owningContext: 'alice',
        scriptAsset: 'unknown',
        causes: ['observer_error']
      });
    } finally {
      await harness.stop();
    }
  });

  it('includes observer-error target diagnostics in worker coverage failure output', async() => {
    const report = await runDiscoveryAccountingGate([], 'malformed_discovery');

    expect(report).toMatchObject({status: 'failed', stage: 'browser_worker_observation_incomplete'});
    expect(report.workerCoverageBreakdown.targets).toContainEqual({
      targetType: 'shared_worker',
      owningContext: 'alice',
      scriptAsset: 'unknown',
      causes: ['observer_error']
    });
    expect(parseAuthProgressReport(report).workerCoverageBreakdown).toEqual(report.workerCoverageBreakdown);
    expect(formatBrowserFailureMessage(report)).toContain('"causes":["observer_error"]');
    expectNoHostileLeak(report);
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
    expect(report.gateBreakdown.observerErrors.alice).toEqual({invalid_worker_cdp_message: 1});
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
      expect(alice.networkObserver.summary().workerTargets.shared_worker).toBe(observation.LIMITS.attachedTargets);
      const eventsBeforeFlood = alice.observer.eventCount();
      for(let index = 0; index < observation.LIMITS.countedEventsPerContext + 20; index++) {
        harness.emit(alice, 'bounded-0', 'Network.webSocketCreated', {requestId: `socket-${index}`, url: `wss://unannounced.invalid/${index}`});
      }
      expect(alice.observer.summary()).toMatchObject({countedEvents: observation.LIMITS.countedEventsPerContext, observerOverflow: 1, coverageComplete: 0});
      expect(alice.networkObserver.events).toHaveLength(observation.LIMITS.countedEventsPerContext - eventsBeforeFlood);
      const retained = alice.networkObserver.events.length;
      await harness.attach(alice, 'over-budget-target');
      harness.emit(alice, 'bounded-0', 'Network.requestWillBeSent', {type: 'Fetch', request: {url: HOSTILE.url}});
      expect(alice.networkObserver.events).toHaveLength(retained);
      expect(alice.networkObserver.summary().workerTargets.shared_worker).toBe(observation.LIMITS.attachedTargets);
    } finally {
      await harness.stop();
    }
  });

  it('caps the discovery target union and protocol attachments at the existing attachment limit', async() => {
    const harness = await createDiscoveryNetworkHarness();
    const {alice} = harness;
    try {
      for(let index = 0; index < observation.LIMITS.attachedTargets + 4; index++) await harness.attach(alice, `bounded-${index}`);
      expect(alice.networkObserver.summary().workerTargets).toEqual({shared_worker: observation.LIMITS.attachedTargets, service_worker: 0});
      expect(harness.calls.filter((call) => call.method === 'Target.attachToTarget')).toHaveLength(observation.LIMITS.attachedTargets);
      expect(alice.observer.summary()).toMatchObject({attachedTargets: observation.LIMITS.attachedTargets, observerOverflow: 1, coverageComplete: 0});
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
    expect(() => parseRequiredScenarios('sign-in,message,group,channel,unknown')).toThrow('unknown scenario');
    expect(parseRequiredScenarios('sign-in,message,group')).toEqual(['sign-in', 'message', 'group']);
    expect(parseRequiredScenarios('sign-in,message,group,channel')).toEqual(['sign-in', 'message', 'group', 'channel']);
    expect(parseRequiredScenarios('channel,group,sign-in,message')).toEqual(['sign-in', 'message', 'group', 'channel']);
  });

  it('runs the channel scenario only when selected', () => {
    expect(realClientBrowser.shouldRunChannelScenario({scenarios: ['sign-in', 'message', 'group']})).toBe(false);
    expect(realClientBrowser.shouldRunChannelScenario({scenarios: ['sign-in', 'message', 'group', 'channel']})).toBe(true);
  });

  it('requires the selected optional channel scenario to pass', () => {
    const scenarios = ['sign-in', 'message', 'group', 'channel'];
    expect(() => assertAllScenariosPassed([
      {name: 'sign-in', status: 'passed'},
      {name: 'message', status: 'passed'},
      {name: 'group', status: 'passed'}
    ], scenarios)).toThrow('channel did not execute');
    expect(assertAllScenariosPassed([
      {name: 'sign-in', status: 'passed'},
      {name: 'message', status: 'passed'},
      {name: 'group', status: 'passed'},
      {name: 'channel', status: 'passed'}
    ], scenarios)).toEqual(scenarios);
  });

  it('fails if a required scenario was skipped or did not report success', () => {
    expect(() => assertAllScenariosPassed([
      {name: 'sign-in', status: 'passed'},
      {name: 'message', status: 'passed'},
      {name: 'group', status: 'passed'},
      {name: 'channel', status: 'skipped'}
    ], ['sign-in', 'message', 'group', 'channel'])).toThrow('channel was skipped');
    expect(() => assertAllScenariosPassed([
      {name: 'sign-in', status: 'passed'},
      {name: 'message', status: 'failed'},
      {name: 'group', status: 'passed'},
      {name: 'channel', status: 'passed'}
    ])).toThrow('message did not pass');
    expect(() => assertAllScenariosPassed([
      {name: 'sign-in', status: 'passed'},
      {name: 'message', status: 'passed'}
    ])).toThrow('group did not execute');
    expect(() => assertAllScenariosPassed([
      {name: 'sign-in', status: 'passed'},
      {name: 'message', status: 'passed'},
      {name: 'group', status: 'passed'}
    ], ['sign-in', 'message', 'group', 'channel'])).toThrow('channel did not execute');
    expect(assertAllScenariosPassed([
      {name: 'sign-in', status: 'passed'},
      {name: 'message', status: 'passed'},
      {name: 'group', status: 'passed'},
      {name: 'channel', status: 'passed'}
    ], ['sign-in', 'message', 'group', 'channel'])).toEqual(['sign-in', 'message', 'group', 'channel']);
  });

  it('matches the audited private manifest schema without requiring an absent public key hash field', () => {
    const expected = {
      wssEndpoint: 'wss://teagramd.test/apiws',
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
      wssEndpoint: 'wss://teagramd.test/apiws',
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
    const secretDirectory = mkdtempSync(join(tmpdir(), `teagram-fixture-${runId}.`));
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
      '--scenarios', 'sign-in,message,group,channel'
    ];

    expect(parseRealClientArgs(args)).toEqual({
      readinessFile: './fixture.jsonl',
      harnessRevision: '5f294c39abb32fc8ae15a4f7ccb085974098b320',
      serverRevision: '47daaaea5c71b859d9865c03cabb50da5a1a013b',
      webRevision: 'b7523e39f5365f50ab6ecd7aa1fb4c79eedf08d8',
      runId: 'a'.repeat(32),
      scenarios: ['sign-in', 'message', 'group', 'channel']
    });
    expect(parseRealClientArgs(['--', ...args])).toEqual(parseRealClientArgs(args));
    expect(() => parseRealClientArgs([])).toThrow('missing required options');
    expect(() => parseRealClientArgs(args.slice(0, -2))).toThrow('scenario selection is required');
    expect(() => parseRealClientArgs([...args, '--scenarios', 'sign-in,message,group'])).toThrow('option was provided more than once');
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
    expect(parseRealClientArgs([...args, '--scenarios', 'sign-in,message,group,channel', '--observer-controls-only']).observerControlsOnly).toBe(true);
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
    expect(() => parseRealClientArgs([...args, '--scenarios', 'sign-in,message,group,channel', '--auth-progress-one-submission']))
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
      '--scenarios', 'sign-in,message,group,channel',
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
  wssEndpoint: 'wss://teagramd.test/apiws',
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

  it('captures own thrown and RPC fields plus console errors by synthetic scenario step', async() => {
    setFixture('<!doctype html><html><body>synthetic diagnostic page</body></html>');
    const page = await createRunnerPage();
    try {
      await countClientErrors(page, () => ({scenario: 'channel', step: 'bob_channel_membership'}));
      await page.goto(`${APP_ORIGIN}/`);
      await page.evaluate(async() => {
        const thrown = Object.create(null);
        Object.defineProperties(thrown, {
          type: {value: 'CHANNEL_PRIVATE', enumerable: true},
          code: {value: 403, enumerable: true},
          description: {value: 'Synthetic channel write denied', enumerable: true}
        });
        window.dispatchEvent(new ErrorEvent('error', {error: thrown}));
        window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {promise: Promise.resolve(), reason: thrown}));
        const unsafe = {type: 'CHANNEL_PRIVATE', code: 403, description: 'https://synthetic.invalid/?token=synthetic'};
        window.dispatchEvent(new ErrorEvent('error', {error: unsafe}));
        const long = {type: 'CHANNEL_PRIVATE', code: 403, description: 'Synthetic ' + 'x'.repeat(400)};
        window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {promise: Promise.resolve(), reason: long}));
        const channel = new MessageChannel();
        channel.port1.addEventListener('message', () => {});
        channel.port1.start();
        channel.port2.postMessage({type: 'result', payload: {error: thrown}});
        console.error('Synthetic channel console failure');
        console.error('https://synthetic.invalid/?token=synthetic');
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      const diagnostics = getClientErrorDiagnostics(page);
      expect(diagnostics).toEqual([{
        scenarioStep: {scenario: 'channel', step: 'bob_channel_membership'},
        thrownValues: [
          {source: 'error_event', valueType: 'object', type: 'CHANNEL_PRIVATE', code: 403, description: 'Synthetic channel write denied'},
          {source: 'unhandled_rejection', valueType: 'object', type: 'CHANNEL_PRIVATE', code: 403, description: 'Synthetic channel write denied'},
          {source: 'error_event', valueType: 'object', type: 'CHANNEL_PRIVATE', code: 403, description: '[redacted]'},
          {source: 'unhandled_rejection', valueType: 'object', type: 'CHANNEL_PRIVATE', code: 403, description: 'Synthetic [redacted]'}
        ],
        rpcFailures: [{type: 'CHANNEL_PRIVATE', code: 403, description: 'Synthetic channel write denied', method: 'unavailable', peerArguments: []}],
        consoleErrors: [{message: 'Synthetic channel console failure'}, {message: '[redacted]'}]
      }]);
      expect(getClientErrorDiagnostics(page, {scenario: 'channel', step: 'bob_channel_membership'})).toEqual(diagnostics);
      expect(getClientErrorDiagnostics(page, {scenario: 'channel', step: 'bob_channel_open'})).toEqual([]);
      const pageErrors = {alice: [], bob: []} as any;
      (realClientBrowser as any).recordPageError(
        pageErrors,
        'alice',
        Object.assign(new Error('Object'), {stack: 'Error: Object'}),
        undefined,
        {scenario: 'channel', step: 'bob_channel_membership'}
      );
      const breakdown = (realClientBrowser as any).summarizeBrowserGateBreakdown({
        pageErrors,
        clientErrorDiagnostics: {alice: diagnostics, bob: []}
      });
      expect(breakdown.stepDiagnostics).toEqual({alice: diagnostics, bob: []});
      expect(formatBrowserFailureMessage({status: 'failed', stage: 'bob_channel_membership', gateBreakdown: breakdown}))
      .toContain(JSON.stringify(breakdown));
      expectNoGateSecretLeak(breakdown);
    } finally {
      await page.close();
    }
  });

  it('captures failed RPC methods and only constructor ids from peer arguments', async() => {
    setFixture('<!doctype html><html><body>synthetic diagnostic page</body></html>');
    const page = await createRunnerPage();
    try {
      await countClientErrors(page, () => ({scenario: 'channel', step: 'bob_channel_other_conversation'}));
      await page.goto(`${APP_ORIGIN}/`);

      await page.evaluate((hostile: {token: string, password: string}) => {
        const channelPeer: any = {_: 'inputPeerChannel', channel_id: 90210};
        Object.defineProperty(channelPeer, 'access_hash', {
          enumerable: true,
          get() {
            throw new Error('access_hash must not be read');
          }
        });
        (window as any).__syntheticRpcParams = {
          peer: channelPeer,
          id: {_: 'inputUser', user_id: 70021, access_hash: hostile.token},
          random_id: hostile.password
        };
      }, HOSTILE);
      const cdp = await page.context().newCDPSession(page);
      let readerResponse: any;
      const paramsObject = await cdp.send('Runtime.evaluate', {
        expression: 'window.__syntheticRpcParams',
        returnByValue: false
      });
      const captured = await (realClientBrowser as any).captureRpcFailureFromConsole(page, {
        type: 'error',
        args: [
          {type: 'string', value: '%s'},
          {type: 'string', value: '12:00:00'},
          {type: 'string', value: '[ApiManager]'},
          {type: 'string', value: 'Error'},
          {type: 'number', value: 400},
          {type: 'string', value: 'PEER_ID_INVALID'},
          {type: 'number', value: 1},
          {type: 'number', value: 1},
          {type: 'string', value: 'messages.getDialogs'},
          {type: 'object', objectId: paramsObject.result.objectId}
        ]
      }, async(objectId: string) => {
        expect(objectId).toBe(paramsObject.result.objectId);
        readerResponse = await cdp.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: (realClientBrowser as any).readSafeRpcArguments.toString(),
          arguments: [{value: 8}],
          returnByValue: true,
          silent: true
        });
        return readerResponse.result?.value;
      });
      expect(readerResponse.exceptionDetails).toBeUndefined();
      expect(readerResponse.result.value).toEqual({peerArguments: [
        {argument: 'peer', constructor: 'inputPeerChannel', id: '90210'},
        {argument: 'id', constructor: 'inputUser', id: '70021'}
      ]});
      const peerArguments = readerResponse.result.value.peerArguments;
      expect(captured).toBe(true);

      const diagnostics = (realClientBrowser as any).getClientErrorDiagnostics(page);
      expect(diagnostics).toEqual([{
        scenarioStep: {scenario: 'channel', step: 'bob_channel_other_conversation'},
        thrownValues: [],
        rpcFailures: [{
          type: 'PEER_ID_INVALID',
          code: 400,
          description: 'unavailable',
          method: 'messages.getDialogs',
          peerArguments
        }],
        consoleErrors: []
      }]);
      expect(JSON.stringify(diagnostics)).not.toContain(HOSTILE.token);
      expect(JSON.stringify(diagnostics)).not.toContain(HOSTILE.password);
      expect(JSON.stringify(diagnostics)).not.toContain('access_hash');
      const breakdown = (realClientBrowser as any).summarizeBrowserGateBreakdown({
        pageErrors: {alice: [], bob: []},
        clientErrorDiagnostics: {alice: [], bob: diagnostics}
      });
      expect(formatBrowserFailureMessage({status: 'failed', stage: 'bob_channel_other_conversation', gateBreakdown: breakdown}))
      .toContain('messages.getDialogs');
      expectNoGateSecretLeak(breakdown);
      const unsafeBreakdown = structuredClone(breakdown);
      unsafeBreakdown.stepDiagnostics.bob[0].rpcFailures[0].peerArguments[0].access_hash = HOSTILE.token;
      expect(() => formatBrowserFailureMessage({status: 'failed', stage: 'bob_channel_other_conversation', gateBreakdown: unsafeBreakdown}))
      .toThrow('browser egress/page error evidence is invalid');

      await page.evaluate(() => {
        const channel = new MessageChannel();
        channel.port1.addEventListener('message', () => {});
        channel.port1.start();
        channel.port2.postMessage({type: 'result', payload: {error: {type: 'PEER_ID_INVALID', code: 400}}});
      });
      await page.waitForTimeout(25);
      expect((realClientBrowser as any).getClientErrorDiagnostics(page)[0].rpcFailures).toHaveLength(1);
      await cdp.detach();
    } finally {
      await page.close();
    }
  });

  it('captures a sanitized RPC failure from a page CDP console event', async() => {
    const cdp: any = new EventEmitter();
    cdp.send = async(method: string) => method === 'Target.getTargetInfo'
      ? {targetInfo: {targetId: 'rpc-diagnostic-page', browserContextId: 'rpc-diagnostic'}}
      : method === 'Runtime.callFunctionOn'
        ? {result: {value: {peerArguments: [{argument: 'peer', constructor: 'inputPeerUser', id: 501}]}}}
        : {};
    cdp.detach = async() => {};
    const fakePage: any = new EventEmitter();
    const frame = {};
    fakePage.mainFrame = () => frame;
    fakePage.context = () => ({newCDPSession: async() => cdp});
    fakePage.exposeBinding = async() => {};
    fakePage.addInitScript = async() => {};
    await countClientErrors(fakePage, () => ({scenario: 'channel', step: 'bob_channel_reload_chats_list'}));
    const observer = observation.createContextObserver('rpc-diagnostic');
    const networkObserver = createNetworkObserver(fakePage, 'rpc-diagnostic', observer);
    await networkObserver.start();
    try {
      cdp.emit('Runtime.consoleAPICalled', {
        type: 'error',
        args: [
          {type: 'string', value: '%s'}, {type: 'string', value: '12:00:00'},
          {type: 'string', value: '[ApiManager]'}, {type: 'string', value: 'Error'},
          {type: 'number', value: 400}, {type: 'string', value: 'PEER_ID_INVALID'},
          {type: 'number', value: 1}, {type: 'number', value: 1},
          {type: 'string', value: 'messages.getDialogs'}, {type: 'object', objectId: 'synthetic-rpc-params'}
        ]
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getClientErrorDiagnostics(fakePage)).toEqual([{
        scenarioStep: {scenario: 'channel', step: 'bob_channel_reload_chats_list'},
        thrownValues: [],
        rpcFailures: [{
          type: 'PEER_ID_INVALID', code: 400, description: 'unavailable',
          method: 'messages.getDialogs',
          peerArguments: [{argument: 'peer', constructor: 'inputPeerUser', id: '501'}]
        }],
        consoleErrors: []
      }]);
    } finally {
      await networkObserver.stop();
    }
  });

  it('captures a sanitized RPC failure from an attached worker console event', async() => {
    const cdp: any = new EventEmitter();
    const nestedCalls: any[] = [];
    cdp.send = async(method: string, params: any) => {
      if(method === 'Target.getTargetInfo') return {targetInfo: {targetId: 'worker-rpc-page', browserContextId: 'worker-rpc'}};
      if(method === 'Target.sendMessageToTarget') {
        const nested = JSON.parse(params.message);
        nestedCalls.push(nested);
        const result = nested.method === 'Runtime.callFunctionOn'
          ? {result: {result: {value: {peerArguments: [{argument: 'channel', constructor: 'inputChannel', id: '602'}]}}}}
          : {result: {}};
        queueMicrotask(() => cdp.emit('Target.receivedMessageFromTarget', {
          sessionId: params.sessionId,
          message: JSON.stringify({id: nested.id, ...result})
        }));
      }
      return {};
    };
    cdp.detach = async() => {};
    const fakePage: any = new EventEmitter();
    const frame = {};
    fakePage.mainFrame = () => frame;
    fakePage.context = () => ({newCDPSession: async() => cdp});
    fakePage.exposeBinding = async() => {};
    fakePage.addInitScript = async() => {};
    await countClientErrors(fakePage, () => ({scenario: 'channel', step: 'bob_channel_other_conversation'}));
    const observer = observation.createContextObserver('worker-rpc');
    const networkObserver = createNetworkObserver(fakePage, 'worker-rpc', observer);
    await networkObserver.start();
    try {
      cdp.emit('Target.attachedToTarget', {
        sessionId: 'synthetic-worker-session',
        targetInfo: {targetId: 'synthetic-worker', type: 'worker', url: MTPROTO_CHUNK_URL, browserContextId: 'worker-rpc'}
      });
      await networkObserver.waitForSetup();
      const workerConsoleEvent = {
        type: 'error',
        args: [
          {type: 'string', value: '%s'}, {type: 'string', value: '12:00:00'},
          {type: 'string', value: '[ApiManager]'}, {type: 'string', value: 'Error'},
          {type: 'number', value: 400}, {type: 'string', value: 'PEER_ID_INVALID'},
          {type: 'number', value: 1}, {type: 'number', value: 1},
          {type: 'string', value: 'channels.getMessages'}, {type: 'object', objectId: 'synthetic-worker-rpc-params'}
        ]
      };
      cdp.emit('Target.receivedMessageFromTarget', {
        sessionId: 'synthetic-worker-session',
        message: JSON.stringify({method: 'Runtime.consoleAPICalled', params: workerConsoleEvent})
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(nestedCalls.some((call) => call.method === 'Runtime.callFunctionOn')).toBe(true);
      expect(getClientErrorDiagnostics(fakePage)).toEqual([{
        scenarioStep: {scenario: 'channel', step: 'bob_channel_other_conversation'},
        thrownValues: [],
        rpcFailures: [{
          type: 'PEER_ID_INVALID', code: 400, description: 'unavailable',
          method: 'channels.getMessages',
          peerArguments: [{argument: 'channel', constructor: 'inputChannel', id: '602'}]
        }],
        consoleErrors: []
      }]);
    } finally {
      await networkObserver.stop();
    }
  });

  it('captures a sanitized RPC failure from the shared worker discovery path', async() => {
    const harness = await createDiscoveryNetworkHarness({startContext: false});
    const bob = await harness.startContext('bob');
    await countClientErrors(bob.page, () => ({scenario: 'channel', step: 'bob_channel_other_conversation'}));
    try {
      await harness.attach(bob, 'shared-rpc-worker', 'discovery', 'shared_worker');
      const countedEventsBeforeConsole = bob.observer.state.countedEvents;
      harness.emit(bob, 'shared-rpc-worker', 'Runtime.consoleAPICalled', {
        type: 'error',
        args: [
          {type: 'string', value: '%s'}, {type: 'string', value: '12:00:00'},
          {type: 'string', value: '[ApiManager]'}, {type: 'string', value: 'Error'},
          {type: 'number', value: 400}, {type: 'string', value: 'PEER_ID_INVALID'},
          {type: 'number', value: 1}, {type: 'number', value: 1},
          {type: 'string', value: 'messages.getDialogs'}, {type: 'object', objectId: 'shared-worker-rpc-params'}
        ]
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(bob.observer.state.countedEvents).toBe(countedEventsBeforeConsole);
      expect(getClientErrorDiagnostics(bob.page)).toEqual([{
        scenarioStep: {scenario: 'channel', step: 'bob_channel_other_conversation'},
        thrownValues: [],
        rpcFailures: [{
          type: 'PEER_ID_INVALID', code: 400, description: 'unavailable',
          method: 'messages.getDialogs',
          peerArguments: [{argument: 'peer', constructor: 'inputPeerChannel', id: '603'}]
        }],
        consoleErrors: []
      }]);
    } finally {
      await harness.stop();
    }
  });

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
    const secretDirectory = mkdtempSync(join(tmpdir(), `teagram-fixture-${READINESS_PINS.runId}.`));
    const passwordFiles = [join(secretDirectory, 'a-password'), join(secretDirectory, 'b-password')];
    const statePath = join(fixtureDirectory, 'docker-state.json');
    const readinessPath = join(fixtureDirectory, 'readiness.jsonl');
    const browserOutputPath = join(fixtureDirectory, 'browser-output.jsonl');
    const cleanupPath = join(fixtureDirectory, 'cleanup.log');
    const browserInputPath = join(fixtureDirectory, 'browser-input.json');
    const runLabel = 'org.teagram.fixture.run';
    const browserName = `teagram-fixture-${READINESS_PINS.runId}browser`;
    const edgeName = `teagram-fixture-${READINESS_PINS.runId}edge`;
    const serverName = `teagram-fixture-${READINESS_PINS.runId}server`;
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
      'const input = args.includes(\'-i\') ? readFileSync(0, \'utf8\') : \'\';',
      'const write = (value) => process.stdout.write(typeof value === \'string\' ? value : JSON.stringify(value));',
      'if(args[0] === \'inspect\') write(args.at(-1) === state.browserName ? state.browser : state.front);',
      'else if(args[0] === \'network\') write(state.network);',
      'else if(args[0] === \'exec\') {',
      '  if(args.includes(\'/proc/net/route\')) write(\'Iface Destination Gateway\\n\');',
      '  else if(args.includes(\'/proc/net/ipv6_route\')) {}',
      '  else if(args.includes(\'node\')) { appendFileSync(state.browserInputPath, input); write(readFileSync(state.browserOutputPath, \'utf8\')); if(state.browserExitCode) process.exitCode = state.browserExitCode; }',
      '  else if(args.some((argument) => argument.includes(\'cat >\'))) readFileSync(0, \'utf8\');',
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
  }, 45_000);

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

describe('real client channel invite completion', () => {
  let browser: any;

  beforeAll(async() => {
    browser = await chromium.launch({headless: true});
  }, 30_000);

  afterAll(async() => {
    await browser?.close();
  }, 15_000);

  it('waits for the active channel after the add-members tab closes without a popup', async() => {
    const page = await browser.newPage();
    try {
      const channelName = 'browser-ci-channel-abc123';
      await page.setContent(`<div class="add-members-container"></div><div id="column-center"><div class="chat active"><div class="topbar"><div class="chat-info">${channelName}</div><div class="avatar" data-peer-id="-10012345"></div></div></div></div>`);
      const addMembers = page.locator('.add-members-container');
      await page.evaluate(() => setTimeout(() => document.querySelector('.add-members-container')?.remove(), 20));

      await expect(waitForChannelInviteCompletion(page, addMembers, channelName, 500)).resolves.toBe('-10012345');
      expect(await page.locator('.popup-add-members').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('confirms Add when the channel flow shows an invite popup', async() => {
    const page = await browser.newPage();
    try {
      const channelName = 'browser-ci-channel-def456';
      await page.setContent(`<div class="add-members-container"></div><div class="popup-add-members" style="display:none"><button class="popup-button btn primary" aria-label="Add">Add</button><button class="popup-button btn primary">Cancel</button></div><div id="column-center"><div class="chat active"><div class="topbar"><div class="chat-info">${channelName}</div><div class="avatar" data-peer-id="-10012346"></div></div></div></div><script>window.inviteResult = ''; document.querySelector('.popup-button[aria-label="Add"]').addEventListener('click', () => {window.inviteResult = 'add'; document.querySelector('.popup-add-members').remove()}); document.querySelector('.popup-button:not([aria-label="Add"])').addEventListener('click', () => {window.inviteResult = 'cancel'}); setTimeout(() => {document.querySelector('.add-members-container').remove(); document.querySelector('.popup-add-members').style.display = ''}, 20)</script>`);
      const addMembers = page.locator('.add-members-container');

      await expect(waitForChannelInviteCompletion(page, addMembers, channelName, 500)).resolves.toBe('-10012346');
      expect(await page.evaluate(() => (window as any).inviteResult)).toBe('add');
    } finally {
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

describe('real client channel unread count', () => {
  let browser: any;

  beforeAll(async() => {
    browser = await chromium.launch({headless: true});
  }, 30_000);

  afterAll(async() => {
    await browser?.close();
  }, 15_000);

  it('waits for exactly one unread post on the selected channel dialog', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div id="chatlist-container">
        <div class="chatlist-chat" data-peer-id="-1000001">
          <div class="dialog-subtitle-badge badge dialog-subtitle-badge-unread unread is-visible">1</div>
        </div>
        <div class="chatlist-chat" data-peer-id="-1000002">
          <div class="dialog-subtitle-badge badge dialog-subtitle-badge-unread unread is-visible">7</div>
        </div>
      </div>`);
      await waitForUnreadCount(page, '-1000001', 1, 'bob_channel_unread', 1_000);
    } finally {
      await page.close();
    }
  });

  it('waits for the unread badge to clear after reading', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div id="chatlist-container">
        <div class="chatlist-chat" data-peer-id="-1000001">
          <div class="dialog-subtitle-badge badge dialog-subtitle-badge-unread unread">1</div>
        </div>
      </div>`);
      await waitForUnreadCount(page, '-1000001', 0, 'bob_channel_read', 1_000);
    } finally {
      await page.close();
    }
  });

  it('finds a new channel row by its unique title before it has a peer id', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div id="chatlist-container">
        <div class="chatlist-chat">browser-ci-channel-no-posts</div>
      </div>`);
      const row = await waitForChannelDialogRow(page, '-1000001', 'browser-ci-channel-no-posts', 'bob_channel_membership', 1_000);
      expect(await row.count()).toBe(1);
      expect(await row.getAttribute('data-peer-id')).toBeNull();
    } finally {
      await page.close();
    }
  });

  it('fails the membership wait when an invited channel row has not appeared', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div id="chatlist-container">
        <div class="chatlist-chat" data-peer-id="2">Bob's other conversation</div>
      </div>`);
      await expect(waitForChannelDialogRow(page, '-1000001', 'browser-ci-channel-no-posts', 'bob_channel_membership', 50))
      .rejects.toThrow('bob_channel_membership');
    } finally {
      await page.close();
    }
  });

  it('allows an invited channel to have no dialog row before its first post', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div id="chatlist-container">
        <div class="chatlist-chat" data-peer-id="2">Bob's other conversation</div>
      </div>`);
      expect(await findChannelDialogRow(page, '-1000001', 'browser-ci-channel-no-posts', 'bob_channel_membership')).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  it('uses the unique channel title before a new channel row has a peer id', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div id="chatlist-container">
        <div class="chatlist-chat">browser-ci-channel-no-posts</div>
      </div>`);
      await waitForUnreadCount(page, '-1000001', 0, 'bob_channel_read', CONTRACT_WAIT_TIMEOUT_MS, 'browser-ci-channel-no-posts');
    } finally {
      await page.close();
    }
  });

  it('fails with a fixed stage when the unread count is not exact', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div id="chatlist-container">
        <div class="chatlist-chat" data-peer-id="-1000001">
          <div class="dialog-subtitle-badge badge dialog-subtitle-badge-unread unread is-visible">2</div>
        </div>
      </div>`);
      await expect(waitForUnreadCount(page, '-1000001', 1, 'bob_channel_unread', CONTRACT_WAIT_TIMEOUT_MS))
      .rejects.toThrow('bob_channel_unread_count');
    } finally {
      await page.close();
    }
  });
});

describe('real client channel membership diagnostics', () => {
  let browser: any;

  beforeAll(async() => {
    browser = await chromium.launch({headless: true});
  }, 30_000);

  afterAll(async() => {
    await browser?.close();
  }, 15_000);

  it('keeps channel invitation failure evidence within a closed schema', () => {
    const parseChannelMembershipState = (realClientContract as any).parseChannelMembershipState;
    expect(typeof parseChannelMembershipState).toBe('function');
    const state = {
      channelPeerId: '-1000003',
      selectedBobPeerId: '1000002',
      alice: {
        channelRowCount: 1,
        channelTitleMatches: 1,
        activePeerId: '-1000003',
        chatListRowCount: 2,
        pageErrorsSinceStep: 0,
        consoleErrorsSinceStep: 0,
        rpcErrorsSinceStep: 0,
        rpcErrorTypesSinceStep: {}
      },
      bob: {
        channelRowCount: 0,
        channelTitleMatches: 0,
        activePeerId: '1000002',
        chatListRowCount: 1,
        pageErrorsSinceStep: 0,
        consoleErrorsSinceStep: 0,
        rpcErrorsSinceStep: 0,
        rpcErrorTypesSinceStep: {}
      },
      stepWait: 'timeout'
    };
    expect(parseChannelMembershipState(state)).toEqual(state);
    expect(formatBrowserFailureMessage({status: 'failed', stage: 'bob_channel_membership', channelMembership: state}))
    .toBe(`real client scenario failed at bob_channel_membership; channel membership ${JSON.stringify(state)}`);

    for(const hostile of [
      {...state, pageText: HOSTILE.phrase},
      {...state, channelPeerId: HOSTILE.username},
      {...state, selectedBobPeerId: HOSTILE.username},
      {...state, alice: {...state.alice, activePeerId: HOSTILE.phrase}},
      {...state, bob: {...state.bob, rpcErrorTypesSinceStep: {[HOSTILE.phrase]: 1}}},
      {...state, bob: {...state.bob, rpcErrorTypesSinceStep: {PEER_ID_INVALID: 0}}},
      {...state, stepWait: HOSTILE.phrase},
      null
    ]) {
      expect(formatBrowserFailureMessage({status: 'failed', stage: 'bob_channel_membership', channelMembership: hostile}))
      .toBe('real client scenario failed at bob_channel_membership; channel membership "unclassified"');
    }
  });

  it('summarizes the channel row and safe errors from both clients', async() => {
    const alicePage = await browser.newPage();
    const bobPage = await browser.newPage();
    try {
      await Promise.all([countClientErrors(alicePage), countClientErrors(bobPage)]);
      await alicePage.setContent(`<div id="chatlist-container"><div class="chatlist-chat" data-peer-id="-1000003">browser-ci-channel-secret</div></div>
        <div id="column-center"><div class="chat active"><div class="topbar"><div class="avatar" data-peer-id="-1000003"></div></div></div></div>`);
      await bobPage.setContent(`<div id="chatlist-container">
        <div class="chatlist-chat" data-peer-id="1000002">direct</div>
        <div class="chatlist-chat">browser-ci-channel-secret</div>
      </div>
        <div id="column-center"><div class="chat active"><div class="topbar"><div class="avatar" data-peer-id="1000002"></div></div></div></div>`);
      await alicePage.evaluate((secret: string) => {
        (window as any).__realClientRpcErrors = () => ({total: 2, byType: {PEER_ID_INVALID: 1, [secret]: 1}});
      }, HOSTILE.phrase);
      await bobPage.evaluate(() => {
        (window as any).__realClientRpcErrors = () => ({total: 1, byType: {CHANNEL_PRIVATE: 1}});
      });

      const state = await captureChannelMembershipState({
        alicePage,
        bobPage,
        channelPeerId: '-1000003',
        selectedBobPeerId: '1000002',
        channelName: 'browser-ci-channel-secret',
        errorsAtStep: {
          alice: {pageErrors: 0, consoleErrors: 0, rpc: {total: 0, byType: {}}},
          bob: {pageErrors: 0, consoleErrors: 0, rpc: {total: 0, byType: {}}}
        },
        stepWait: 'timeout'
      });
      expect(state).toEqual({
        channelPeerId: '-1000003',
        selectedBobPeerId: '1000002',
        alice: {
          channelRowCount: 1,
          channelTitleMatches: 1,
          activePeerId: '-1000003',
          chatListRowCount: 1,
          pageErrorsSinceStep: 0,
          consoleErrorsSinceStep: 0,
          rpcErrorsSinceStep: 2,
          rpcErrorTypesSinceStep: {PEER_ID_INVALID: 1}
        },
        bob: {
          channelRowCount: 0,
          channelTitleMatches: 1,
          activePeerId: '1000002',
          chatListRowCount: 2,
          pageErrorsSinceStep: 0,
          consoleErrorsSinceStep: 0,
          rpcErrorsSinceStep: 1,
          rpcErrorTypesSinceStep: {CHANNEL_PRIVATE: 1}
        },
        stepWait: 'timeout'
      });
      expect(JSON.stringify(state)).not.toContain('browser-ci-channel-secret');
      expect(JSON.stringify(state)).not.toContain(HOSTILE.phrase);
      expect(formatBrowserFailureMessage({status: 'failed', stage: 'bob_channel_membership', channelMembership: state}))
      .toContain('PEER_ID_INVALID');
      expectNoHostileLeak(state);
    } finally {
      await Promise.all([alicePage.close(), bobPage.close()]);
    }
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
      await expect(nameNewGroup(page, 'browser-ci-group-0123abcd', screenshotDirectory, {count: 0}, CONTRACT_WAIT_TIMEOUT_MS))
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
      await expect(nameNewGroup(page, 'browser-ci-group-0123abcd', screenshotDirectory, {count: 0}, CONTRACT_WAIT_TIMEOUT_MS))
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

  async function installMessageSender(page: any, mode = 'single') {
    await page.evaluate((mode: string) => {
      document.addEventListener('keydown', (event) => {
        const input = event.target as HTMLElement;
        if(event.key !== 'Enter' || !input.matches('.input-message-input:not(.input-field-input-fake)')) return;
        event.preventDefault();
        const chat = input.closest('.chat');
        const addBubble = (mid: string, status: string) => {
          const bubble = document.createElement('div');
          bubble.className = `bubble ${status}`;
          bubble.dataset.mid = mid;
          const message = document.createElement('div');
          message.className = 'message';
          message.textContent = input.textContent;
          bubble.appendChild(message);
          chat?.querySelector('.bubbles')?.appendChild(bubble);
          return bubble;
        };
        if(mode === 'transient-pending-sent') {
          const pending = addBubble('9001', 'is-sending');
          addBubble('9001', 'is-sent');
          setTimeout(() => pending.remove(), 700);
        } else if(mode === 'transient-temporary-server') {
          const pending = addBubble('9000.0001', 'is-sending');
          addBubble('9001', 'is-sent');
          setTimeout(() => pending.remove(), 700);
        } else if(mode === 'distinct-sent') {
          addBubble('9101', 'is-sent');
          addBubble('9102', 'is-sent');
          console.error('group message diagnostic secret');
          setTimeout(() => {throw new Error('group message diagnostic secret')}, 0);
          const channel = new MessageChannel();
          channel.port2.addEventListener('message', () => {});
          channel.port2.start();
          channel.port1.postMessage({type: 'result', payload: {taskId: 1, error: {type: 'GROUP_TEST_ERROR', message: 'group message diagnostic secret'}}});
        } else if(mode === 'disappears') {
          addBubble('9201', 'is-sent');
        } else {
          addBubble('9000', 'is-sent');
        }
      });
    }, mode);
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

  it('accepts a transient pending and sent pair for the same group message id', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(messageCenterMarkup());
      await installMessageSender(page, 'transient-pending-sent');
      await sendGroupText(page, GROUP_MESSAGE, GROUP_NAME, 'alice_group_message', 2_000);
      expect(await page.locator('#column-center .chat.active .bubble .message').filter({hasText: GROUP_MESSAGE}).count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('accepts a pending temporary id beside its sent server id', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(messageCenterMarkup());
      await installMessageSender(page, 'transient-temporary-server');
      await sendGroupText(page, GROUP_MESSAGE, GROUP_NAME, 'alice_group_message', 2_000);
      const state = await realClientBrowser.captureGroupMessageState();
      expect(state.result).toBe('settled');
      expect(state.distinctIds).toBe(true);
      expect(state.distinctServerIds).toBe(false);
      expect(state.samples).toEqual(expect.arrayContaining([
        expect.objectContaining({
          count: 2,
          bubbles: [
            {messageId: '9000.0001', sendState: 'pending'},
            {messageId: '9001', sendState: 'sent'}
          ],
          distinctIds: true,
          distinctServerIds: false
        })
      ]));
    } finally {
      await page.close();
    }
  });

  it('summarizes distinct sent ids and safe error deltas when Alice\'s group count fails', async() => {
    const page = await browser.newPage();
    try {
      await countClientErrors(page);
      await page.goto('data:text/html,');
      await page.setContent(messageCenterMarkup());
      await installMessageSender(page, 'distinct-sent');
      await expect(sendGroupText(page, GROUP_MESSAGE, GROUP_NAME, 'alice_group_message', 2_000))
      .rejects.toThrow('alice_group_message_message_count');
      const capture = realClientBrowser.captureGroupMessageState;
      const state = typeof capture === 'function' ? await capture() : undefined;
      expect(state).toMatchObject({
        distinctIds: true,
        samples: expect.arrayContaining([
          expect.objectContaining({
            count: 2,
            distinctIds: true,
            bubbles: [
              {messageId: '9101', sendState: 'sent'},
              {messageId: '9102', sendState: 'sent'}
            ]
          })
        ])
      });
      expect(state.pageErrorsSinceStep).toBeGreaterThan(0);
      expect(state.consoleErrorsSinceStep).toBeGreaterThan(0);
      expect(state.rpcErrorsSinceStep).toBeGreaterThan(0);
      const summary = formatBrowserFailureMessage({status: 'failed', stage: 'alice_group_message_message_count', groupMessage: state});
      expect(summary).toContain('9101');
      expect(summary).toContain('9102');
      expect(summary).toContain('pageErrorsSinceStep');
      expect(summary).toContain('consoleErrorsSinceStep');
      expect(summary).toContain('rpcErrorsSinceStep');
      expect(summary).not.toContain(GROUP_MESSAGE);
      expect(summary).not.toContain('group message diagnostic secret');
      expectNoHostileLeak(summary);
    } finally {
      await page.close();
    }
  });

  it('fails with a count-window summary when a visible group bubble disappears', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(messageCenterMarkup());
      await installMessageSender(page, 'disappears');
      const send = sendGroupText(page, GROUP_MESSAGE, GROUP_NAME, 'alice_group_message', 2_000);
      const rejectedSend = expect(send).rejects.toThrow('alice_group_message_message_count');
      const captureTrace = realClientBrowser.captureGroupMessageState;
      const removeAfterPositiveSample = async() => {
        const deadline = Date.now() + CONTRACT_WAIT_TIMEOUT_MS;
        while(Date.now() < deadline) {
          const state = typeof captureTrace === 'function' ? await captureTrace() : undefined;
          if(typeof state === 'object' && state?.samples.some((sample: any) => sample.count === 1)) {
            await page.locator('#column-center .chat.active .bubble .message').filter({hasText: GROUP_MESSAGE})
            .evaluate((message: Element) => message.closest('.bubble')?.remove());
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('group message runner did not capture the visible bubble');
      };
      await Promise.all([rejectedSend, removeAfterPositiveSample()]);
      const capture = realClientBrowser.captureGroupMessageState;
      const state = typeof capture === 'function' ? await capture() : undefined;
      expect(state).toBeDefined();
      expect(state.samples.map((sample: any) => sample.count)).toEqual(expect.arrayContaining([1, 0]));
      expect(state.result).toBe('disappeared');
      const summary = formatBrowserFailureMessage({status: 'failed', stage: 'alice_group_message_message_count', groupMessage: state});
      expect(summary).toContain('alice_group_message_message_count');
      expect(summary).toContain('"count":1');
      expect(summary).toContain('"count":0');
      expect(summary).not.toContain(GROUP_MESSAGE);
      expectNoHostileLeak(summary);
    } finally {
      await page.close();
    }
  });

  it('keeps Bob\'s group message count stage on a distinct-id failure', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(messageCenterMarkup());
      await page.locator('#column-center .chat.active .bubbles').evaluate((bubbles: Element) => {
        for(const mid of ['9301', '9302']) {
          const bubble = document.createElement('div');
          bubble.className = 'bubble is-sent';
          bubble.dataset.mid = mid;
          bubble.innerHTML = '<div class="message">browser-ci-group-hello</div>';
          bubbles.appendChild(bubble);
        }
      });
      const waitForGroupMessageCount = realClientBrowser.waitForGroupMessageCount;
      if(typeof waitForGroupMessageCount === 'function') {
        const activeGroup = resolveActiveGroupChat(page, GROUP_NAME);
        await expect(waitForGroupMessageCount(
          page,
          activeGroup.chat,
          activeGroup.title,
          activeGroup.chat.locator('.bubble .message').filter({hasText: GROUP_MESSAGE}),
          'bob_group_message_count',
          2_000
        )).rejects.toThrow('bob_group_message_count');
      }
      const capture = realClientBrowser.captureGroupMessageState;
      const state = typeof capture === 'function' ? await capture() : undefined;
      expect(state).toMatchObject({distinctIds: true, result: 'multiple_ids'});
      const summary = formatBrowserFailureMessage({status: 'failed', stage: 'bob_group_message_count', groupMessage: state});
      expect(summary).toContain('bob_group_message_count');
    } finally {
      await page.close();
    }
  });

  it('fails Alice\'s group message stage when the new group is not active', async() => {
    const page = await browser.newPage();
    try {
      await page.setContent(messageCenterMarkup({groupActive: false}));
      await installMessageSender(page);
      await expect(sendGroupText(page, GROUP_MESSAGE, GROUP_NAME, 'alice_group_message', CONTRACT_WAIT_TIMEOUT_MS))
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
      await expect(waitForGroupCreated(page, GROUP_NAME, screenshotDirectory, {count: 0}, CONTRACT_WAIT_TIMEOUT_MS))
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
      await expect(waitForGroupCreated(page, GROUP_NAME, screenshotDirectory, {count: 0}, CONTRACT_WAIT_TIMEOUT_MS))
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

  function groupProfileMarkup({groupPeerId = '-1000003', memberIds = ['1000002', '1000003'], membersTab = true, membersTabActive = false, membersTabVisible = true} = {}) {
    const membersMenu = membersTab ? `<div class="menu-horizontal-div-item${membersTabActive ? ' active' : ''}"${membersTabVisible ? '' : ' style="display:none"'}><span>Members</span></div>` : '';
    const membersPanel = membersTab ? `<div class="search-super-tab-container search-super-container-members tabs-tab${membersTabActive ? ' active' : ''}" style="min-height:80px">
      <div class="search-super-content-container search-super-content-members"><ul class="chatlist">${memberIds.map((peerId) => `<li class="chatlist-chat" data-peer-id="${peerId}" style="height:40px">member</li>`).join('')}</ul></div>
    </div>` : '';
    return `<style>.profile-avatars-avatar-fake { visibility: hidden; }</style>
    <div class="tabs-tab sidebar-slider-item active" style="min-height:200px">
      <div class="sidebar-content"><div class="profile-content">
        <div class="profile-avatars-container">
          <div class="avatar profile-avatars-avatar-fake" data-peer-id="${groupPeerId}" style="width:120px;height:120px"></div>
          <div class="profile-avatars-avatars"><div class="profile-avatars-avatar active" style="width:120px;height:120px"><div class="avatar" data-peer-id="${groupPeerId}" style="width:120px;height:120px"></div></div></div>
          <div class="profile-avatars-info">${GROUP_NAME}</div>
        </div>
        <div class="search-super"><nav class="search-super-tabs"><div class="menu-horizontal-div-item${membersTabActive ? '' : ' active'}"><span>Media</span></div>${membersMenu}</nav>
          <div class="search-super-tabs-container"><div class="search-super-tab-container search-super-container-media tabs-tab${membersTabActive ? '' : ' active'}"></div>${membersPanel}</div>
        </div>
      </div></div>
    </div>`;
  }

  async function prepareBobGroupMemberPage({profileMarkup = groupProfileMarkup(), openProfile = true, activateMembers = true, reportErrorsOnMembersClick = false, interceptMembersClick = false} = {}) {
    const page = await browser.newPage();
    await countClientErrors(page);
    await page.goto('data:text/html,');
    await page.setContent(`${bobMarkup()}<div id="column-right"><div class="sidebar-slider"></div></div>`);
    await page.evaluate(({profileMarkup, openProfile, activateMembers, reportErrorsOnMembersClick, interceptMembersClick}: {profileMarkup: string, openProfile: boolean, activateMembers: boolean, reportErrorsOnMembersClick: boolean, interceptMembersClick: boolean}) => {
      const group = document.querySelector('#column-center .chat .avatar[data-peer-id="-1000003"]')?.closest('.chat');
      group?.querySelector('.topbar .chat-info')?.addEventListener('click', () => {
        if(!openProfile) return;
        (window as any).memberTabClickCount = 0;
        const slider = document.querySelector('#column-right .sidebar-slider');
        document.body.classList.add('is-right-column-shown');
        slider.innerHTML = profileMarkup;
        const activeProfile = slider.querySelector('.sidebar-slider-item.active');
        const membersMenu = activeProfile?.querySelectorAll('.search-super-tabs .menu-horizontal-div-item')[1];
        const membersPanel = activeProfile?.querySelector('.search-super-container-members');
        membersMenu?.addEventListener('click', () => {
          (window as any).memberTabClickCount++;
          if(reportErrorsOnMembersClick) {
            console.error('hunter2 secret passphrase');
            setTimeout(() => {throw new Error('hunter2 secret passphrase')}, 0);
            const channel = new MessageChannel();
            channel.port2.addEventListener('message', () => {});
            channel.port2.start();
            channel.port1.postMessage({type: 'result', payload: {taskId: 1, error: {type: 'PROFILE_RPC_ERROR'}}});
          }
          if(!activateMembers) return;
          activeProfile.querySelectorAll('.search-super-tabs .menu-horizontal-div-item').forEach((tab) => tab.classList.remove('active'));
          membersMenu?.classList.add('active');
          activeProfile.querySelectorAll('.search-super-tab-container').forEach((panel) => panel.classList.remove('active'));
          membersPanel?.classList.add('active');
        });
        if(interceptMembersClick) {
          const interceptor = document.createElement('div');
          interceptor.className = 'member-tab-click-interceptor';
          interceptor.style.cssText = 'position:fixed;inset:0;z-index:9999';
          interceptor.innerHTML = '<span class="member-tab-interceptor-child" style="display:block;position:fixed;inset:0">Loading</span>';
          document.body.append(interceptor);
        }
      });
    }, {profileMarkup, openProfile, activateMembers, reportErrorsOnMembersClick, interceptMembersClick});
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
      await expect(openBobGroupChat(page, page.locator('#chatlist-container .chatlist-chat'), GROUP_NAME, screenshotDirectory, {count: 0}, CONTRACT_WAIT_TIMEOUT_MS))
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
      await expect(openBobGroupChat(page, page.locator('#chatlist-container .missing-row'), GROUP_NAME, screenshotDirectory, {count: 0}, CONTRACT_WAIT_TIMEOUT_MS))
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
      await groupHeader.click();
      expect(await page.locator('#column-right .sidebar-slider-item.active .profile-avatars-avatar-fake').evaluate((avatar: Element) => getComputedStyle(avatar).visibility)).toBe('hidden');
      expect(await page.locator('#column-right .sidebar-slider-item.active .profile-avatars-avatars > .profile-avatars-avatar.active .avatar[data-peer-id]').isVisible()).toBe(true);
      expect(await page.locator('#column-right .sidebar-slider-item.active .search-super-container-media.active').count()).toBe(1);
      await openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, CONTRACT_WAIT_TIMEOUT_MS);
      expect(await page.evaluate(() => (window as any).memberTabClickCount)).toBe(1);
      expect(capturedScreenshots.count).toBe(2);
    } finally {
      await page.close();
    }
  });

  it('uses Bob\'s already active Members panel without clicking its tab', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({
      profileMarkup: groupProfileMarkup({membersTabActive: true})
    });
    try {
      await openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, CONTRACT_WAIT_TIMEOUT_MS);
      expect(await page.evaluate(() => (window as any).memberTabClickCount)).toBe(0);
      expect(capturedScreenshots.count).toBe(2);
    } finally {
      await page.close();
    }
  });

  it('fails Bob\'s member profile step when the group profile did not open', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({openProfile: false});
    try {
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, CONTRACT_WAIT_TIMEOUT_MS))
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
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, CONTRACT_WAIT_TIMEOUT_MS))
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
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, CONTRACT_WAIT_TIMEOUT_MS))
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
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, CONTRACT_WAIT_TIMEOUT_MS))
      .rejects.toThrow('bob_group_member_tab');
      expect(await realClientBrowser.captureGroupMemberState()).toMatchObject({activePanel: 'media', profileMatchesActiveGroup: true, membersTabExists: false, membersListExists: false, memberRowCount: 0});
    } finally {
      await page.close();
    }
  });

  it('reports an existing invisible Members tab in the failure summary', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({
      profileMarkup: groupProfileMarkup({membersTabVisible: false})
    });
    try {
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, CONTRACT_WAIT_TIMEOUT_MS))
      .rejects.toThrow('bob_group_member_tab');
      const state = await realClientBrowser.captureGroupMemberState();
      expect(state).toMatchObject({
        activePanel: 'media',
        profileMatchesActiveGroup: true,
        membersTabExists: true,
        membersTab: {
          panelActiveBefore: false,
          panelActiveAfter: false,
          target: {index: 1, tag: 'div', classes: ['menu-horizontal-div-item']},
          paired: true,
          actionabilityReason: 'not_visible',
          interceptedBy: null
        }
      });
      expect(await page.evaluate(() => (window as any).memberTabClickCount)).toBe(0);
      expect(realClientContract.parseGroupMemberState(state)).toEqual(state);
      const summary = formatBrowserFailureMessage({status: 'failed', stage: 'bob_group_member_tab', groupMember: state});
      expect(summary).toContain('"actionabilityReason":"not_visible"');
      expectNoHostileLeak(summary);
      expect(summary).not.toContain(GROUP_NAME);
      expect(summary).not.toContain('1000002');
    } finally {
      await page.close();
    }
  });

  it('fails Bob\'s Members tab step when clicking it does not activate the panel', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({activateMembers: false});
    try {
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, CONTRACT_WAIT_TIMEOUT_MS))
      .rejects.toThrow('bob_group_member_tab');
      expect(await realClientBrowser.captureGroupMemberState()).toMatchObject({
        activePanel: 'media',
        profileMatchesActiveGroup: true,
        membersTabExists: true,
        membersListExists: true,
        memberRowCount: 0,
        membersTab: {panelActiveBefore: false, panelActiveAfter: false, actionabilityReason: 'none'}
      });
    } finally {
      await page.close();
    }
  });

  it('records the intercepted Members tab click without exposing page text', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({interceptMembersClick: true});
    try {
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, CONTRACT_WAIT_TIMEOUT_MS))
      .rejects.toThrow('bob_group_member_tab');
      const state = await realClientBrowser.captureGroupMemberState();
      expect(state).toMatchObject({
        membersTab: {
          panelActiveBefore: false,
          panelActiveAfter: false,
          target: {index: 1, tag: 'div', classes: ['menu-horizontal-div-item']},
          paired: true,
          actionabilityReason: 'intercepted',
          interceptedBy: {tag: 'span', classes: ['member-tab-interceptor-child']}
        }
      });
      expect(realClientContract.parseGroupMemberState(state)).toEqual(state);
      const summary = formatBrowserFailureMessage({status: 'failed', stage: 'bob_group_member_tab', groupMember: state});
      expect(summary).toContain('"actionabilityReason":"intercepted"');
      expect(summary).toContain('"member-tab-interceptor-child"');
      expect(summary).not.toContain('member-tab-click-interceptor');
      expect(summary).not.toContain('Loading');
      expectNoHostileLeak(summary);
      expect(summary).not.toContain(GROUP_NAME);
      expect(summary).not.toContain('1000002');
      expect(capturedScreenshots.count).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('fails Bob\'s member row wait with the active Members panel row count', async() => {
    const openBobGroupMembers = requireOpenBobGroupMembers();
    const {page, groupHeader, capturedScreenshots} = await prepareBobGroupMemberPage({profileMarkup: groupProfileMarkup({memberIds: ['1000002']})});
    try {
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, CONTRACT_WAIT_TIMEOUT_MS))
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
        await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, CONTRACT_WAIT_TIMEOUT_MS))
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
      await expect(openBobGroupMembers(page, groupHeader, GROUP_NAME, '1000002', screenshotDirectory, capturedScreenshots, CONTRACT_WAIT_TIMEOUT_MS))
      .rejects.toThrow('bob_group_member_tab');
      const state = await realClientBrowser.captureGroupMemberState();
      expect(state).toMatchObject({
        activePanel: 'media',
        profileMatchesActiveGroup: true,
        membersTabExists: true,
        membersListExists: true,
        memberRowCount: 0,
        membersTab: {panelActiveBefore: false, panelActiveAfter: false, actionabilityReason: 'none'}
      });
      expect(state.pageErrorsSinceStep).toBeGreaterThan(0);
      expect(state.consoleErrorsSinceStep).toBeGreaterThan(0);
      expect(state.rpcErrorsSinceStep).toBeGreaterThan(0);
      expect(realClientContract.parseGroupMemberState(state)).toEqual(state);
      const summary = formatBrowserFailureMessage({status: 'failed', stage: 'bob_group_member_tab', groupMember: state});
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
    const state: any = {
      activePanel: 'members',
      profileMatchesActiveGroup: true,
      membersTabExists: true,
      membersListExists: true,
      memberRowCount: 2,
      membersTab: {
        panelActiveBefore: false,
        panelActiveAfter: false,
        target: {index: 1, tag: 'div', classes: ['menu-horizontal-div-item']},
        paired: true,
        actionabilityReason: 'none',
        interceptedBy: null
      },
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
      {...state, membersTab: {...state.membersTab, actionabilityReason: HOSTILE.phrase}},
      {...state, membersTab: {...state.membersTab, interceptedBy: {tag: HOSTILE.phrase, classes: []}}},
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
