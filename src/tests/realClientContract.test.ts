import {chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {
  assertAllScenariosPassed,
  parseFixtureReadiness,
  parseObserverControls,
  parseRealClientArgs,
  parseRequiredScenarios,
  parseWorkerObservation,
  readSyntheticCredentials
} from '../../scripts/real-client/contract.mjs';
import * as realClientContract from '../../scripts/real-client/contract.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require('@playwright/test');
const {createNetworkObserver, createWorkerDiscovery, getSingleExactMessageFailure, matchesPrivateArtifactManifest, prepareUsernameEntry, waitForPasswordField, submitPassword} = require('../../scripts/real-client/browser.cjs');
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

function createDiscoveryHarness(send: (method: string, params: any) => Promise<any> = async() => ({})) {
  const session: any = new EventEmitter();
  session.send = send;
  const browser: any = {newBrowserCDPSession: async() => session};
  return {browser, registry: createWorkerDiscovery(), session};
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
  artifactDigest: `sha256:${'c'.repeat(64)}`
});
const DUMMY_USERNAME = 'runner-contract-user';

function usernameEntryManifest() {
  return {
    artifactDigest: USERNAME_ENTRY_RUNTIME.artifactDigest,
    endpoint: USERNAME_ENTRY_RUNTIME.wssEndpoint,
    fingerprint: USERNAME_ENTRY_RUNTIME.fingerprint,
    mode: 'private',
    sourceCommit: USERNAME_ENTRY_RUNTIME.webRevision
  };
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
