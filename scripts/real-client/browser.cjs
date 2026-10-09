const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const observation = require('./observation.cjs');

const REQUIRED_SCENARIOS = ['sign-in', 'message', 'group'];
const PRIVATE_CSP_ORIGIN = observation.PRIVATE_CSP_ORIGIN;
const PRIVATE_CSP_WSS = 'wss://telegramd.test/apiws';
const PROBE_PATH = '/_fixture_probe/';
const MESSAGE = 'browser-ci-hello';
const GROUP_MESSAGE = 'browser-ci-group-hello';
const CONTROL_WINDOW_MS = 10_000;
const INJECTED_TARGET_ID = '000000000000000000000000000000fe';
const CONTROL_PLAN = Object.freeze([
  Object.freeze({name: 'c1_shared_worker_created', expression: "new SharedWorker('/_fixture_probe/shared-worker.js')"}),
  Object.freeze({name: 'c2_missing_module_script', expression: "new SharedWorker('/_fixture_probe/missing.js', {type: 'module'})"}),
  Object.freeze({name: 'c3_no_construction'}),
  Object.freeze({name: 'c4_attach_failure', fault: 'attach', windowMs: 2000}),
  Object.freeze({name: 'c4_overflow', fault: 'overflow', windowMs: 2000}),
  // More distinct shared workers than the attached-target budget: the observer
  // must stop attaching, release the rejected targets and stay bounded.
  Object.freeze({name: 'c5_attach_budget', windowMs: 6000,
    expression: "for(let index = 0; index < 20; index++) new SharedWorker('/_fixture_probe/shared-worker.js', 'budget' + index)"})
]);

let currentStage = 'runtime_inputs';
let currentScenario;

function failStage(stage) {
  currentStage = stage;
  throw new Error(stage);
}

function matchesPrivateArtifactManifest(manifest, expected) {
  const fields = ['artifactDigest', 'endpoint', 'fingerprint', 'mode', 'sourceCommit'];
  return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest) &&
    JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(fields) &&
    manifest.mode === 'private' && manifest.endpoint === expected.wssEndpoint &&
    manifest.fingerprint === expected.fingerprint && manifest.sourceCommit === expected.webRevision &&
    manifest.artifactDigest === expected.artifactDigest;
}

function getSingleExactMessageFailure(messages, expected) {
  if(messages.length !== 1) return 'count';
  if(messages[0] !== expected) return 'content';
  return null;
}

function withCommandTimeout(operation) {
  let timer;
  const command = Promise.resolve().then(operation);
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('cdp_command_timeout')), observation.LIMITS.commandTimeoutMs);
  });
  return Promise.race([command, timeout]).finally(() => clearTimeout(timer));
}

function sendCdpCommand(session, method, params = {}) {
  return withCommandTimeout(() => session.send(method, params));
}

function readRuntimeInput() {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      value += chunk;
      if(value.length > 32_768) {
        reject(new Error('runtime_input_too_large'));
        process.stdin.destroy();
      }
    });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(value));
      } catch {
        reject(new Error('runtime_input_invalid'));
      }
    });
    process.stdin.on('error', () => reject(new Error('runtime_input_read_failed')));
  });
}

function validateRuntimeInput(config) {
  if(!/^[0-9a-f]{32}$/.test(config?.runId || '') ||
      config.endpoint !== PRIVATE_CSP_ORIGIN || config.wssEndpoint !== PRIVATE_CSP_WSS ||
      !/^[0-9a-f]{16}$/.test(config.fingerprint || '') ||
      !/^[0-9a-f]{64}$/.test(config.publicKeySHA256 || '') ||
      (config.observationOnly === true
        ? config.artifactDigest !== null
        : !/^sha256:[0-9a-f]{64}$/.test(config.artifactDigest || '')) ||
      !/^[0-9a-f]{40}$/.test(config.webRevision || '') ||
      !/^[A-Za-z0-9+/]{43}=$/.test(config.leafSPKI || '') ||
      Buffer.from(config.leafSPKI, 'base64').byteLength !== 32 ||
      Buffer.from(config.leafSPKI, 'base64').toString('base64') !== config.leafSPKI ||
      !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(config.frontIp || '') ||
      config.screenshotDirectory !== `/tmp/real-client-${config.runId}` ||
      (config.observationOnly !== undefined && config.observationOnly !== true) ||
      !Array.isArray(config.accounts) || config.accounts.length !== 2) {
    failStage('runtime_input_validation');
  }

  const expectedNames = [`u${config.runId.slice(0, 30)}a`, `u${config.runId.slice(0, 30)}b`];
  config.accounts.forEach((account, index) => {
    if(account?.username !== expectedNames[index] || !/^[0-9a-f]{64}$/.test(account.password || '')) {
      failStage('runtime_credential_validation');
    }
  });
}

// Every CDP send is gated by session scope. A method outside the accepted scope
// fails the run, and the nested worker channel carried by
// Target.sendMessageToTarget is gated by the worker scope as well.
function createGatedSender(scope, session, observer) {
  return function send(method, params = {}) {
    if(!observation.allowCdpMethod(scope, method)) {
      observer?.recordObserverError();
      return Promise.reject(new Error('cdp_method_not_allowed'));
    }
    return sendCdpCommand(session, method, params);
  };
}

// Browser-level target discovery. Shared workers are visible only here: the
// page-session auto-attach path holds dedicated and service workers and never
// announces a shared worker, so its zero counts cannot establish absence.
// Discovery is turned on before this runner creates any context.
function createWorkerDiscovery() {
  const ATTRIBUTED_TYPES = ['page', 'shared_worker', 'service_worker', 'worker'];
  const contextObservers = new Map();
  const targetOwners = new Map();
  const targetSessions = new Map();
  const sessionTargets = new Map();
  const attachedSessions = new Set();
  const attachingTargets = new Set();
  const pendingByContext = new Map();
  const baselineTargets = new Set();
  const unattributedTargets = new Set();
  const contextlessTargets = new Map();
  const appContextlessTargets = new Map();
  let appContextCount = 0;
  const pendingCommands = new Map();
  const setupPromises = new Set();
  let session;
  let send;
  let nextCommandId = 0;
  let discoveryActive = false;
  let orphanDetachFailures = 0;

  function ownerOf(targetId) {
    return targetOwners.get(targetId);
  }

  function sendNested(sessionId, method, params = {}) {
    const observer = ownerOf(sessionTargets.get(sessionId));
    if(!observation.allowCdpMethod('worker', method)) {
      observer?.recordObserverError();
      return Promise.reject(new Error('cdp_method_not_allowed'));
    }
    const id = ++nextCommandId;
    const key = `${sessionId}:${id}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(key);
        reject(new Error('cdp_command_timeout'));
      }, observation.LIMITS.commandTimeoutMs);
      pendingCommands.set(key, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({id, method, params})
      }).catch((error) => {
        const pending = pendingCommands.get(key);
        if(!pending) return;
        pendingCommands.delete(key);
        pending.reject(error);
      });
    });
  }

  function setupObserver(observer, targetId) {
    const sessionId = targetSessions.get(targetId);
    const setup = (async() => {
      for(const method of ['Network.enable', 'Audits.enable', 'Log.enable', 'Runtime.enable']) {
        await sendNested(sessionId, method);
      }
      // A shared worker cannot be held at startup, so this release is a no-op
      // for it. It stays unconditional: a target this runner attaches to must
      // never stay frozen because an observer reached it.
      await sendNested(sessionId, 'Runtime.runIfWaitingForDebugger');
      observer.noteSetupComplete(targetId);
    })().catch(() => {
      observer.recordObserverError();
    }).finally(() => setupPromises.delete(setup));
    setupPromises.add(setup);
  }

  function attachSharedWorker(observer, targetInfo) {
    const targetId = targetInfo.targetId;
    if(targetSessions.has(targetId) || attachingTargets.has(targetId)) return;
    attachingTargets.add(targetId);
    if(!observer.noteAttached(targetId)) {
      attachingTargets.delete(targetId);
      return;
    }
    send('Target.attachToTarget', {targetId, flatten: false})
    .catch(() => {
      attachingTargets.delete(targetId);
      observer.noteAttachFailure();
    });
  }

  function attribute(targetInfo) {
    if(typeof targetInfo.targetId !== 'string' || !ATTRIBUTED_TYPES.includes(targetInfo.type)) return null;
    if(typeof targetInfo.browserContextId !== 'string') {
      // Chromium can announce a short-lived worker before it names the context
      // it belongs to. Such a target belongs to no app evidence, and a later
      // targetInfoChanged that carries the context id resolves it.
      if(targetOwners.has(targetInfo.targetId)) return null;
      contextlessTargets.set(targetInfo.targetId, true);
      if(appContextCount > 0) appContextlessTargets.set(targetInfo.targetId, true);
      return null;
    }
    contextlessTargets.delete(targetInfo.targetId);
    appContextlessTargets.delete(targetInfo.targetId);
    const observer = contextObservers.get(targetInfo.browserContextId);
    if(observer) {
      discoveryActive = true;
      observer.state.discoveryActive = true;
      return observer;
    }
    if(contextObservers.size === 0) {
      // A target announced before this runner created any context belongs to
      // the browser itself, not to the app under test.
      baselineTargets.add(targetInfo.targetId);
      return null;
    }
    if(baselineTargets.has(targetInfo.targetId)) return null;
    const pending = pendingByContext.get(targetInfo.browserContextId) || [];
    pending.push(targetInfo);
    pendingByContext.set(targetInfo.browserContextId, pending);
    unattributedTargets.add(targetInfo.targetId);
    return null;
  }

  function onTargetInfo(targetInfo) {
    const targetId = targetInfo?.targetId;
    const currentOwner = typeof targetId === 'string' ? ownerOf(targetId) : null;
    const observer = currentOwner || attribute(targetInfo);
    if(!observer) return;
    observer.registerTarget(targetInfo);
    if(observer.state.overflow) return;
    if(!currentOwner) {
      targetOwners.set(targetId, observer);
      unattributedTargets.delete(targetId);
    }
    if(targetInfo.type === 'shared_worker') attachSharedWorker(observer, targetInfo);
  }

  function onReceivedMessage(event) {
    const targetId = sessionTargets.get(event.sessionId);
    const observer = targetId ? ownerOf(targetId) : null;
    if(!observer) return;
    if(typeof event.message !== 'string' || Buffer.byteLength(event.message, 'utf8') > observation.LIMITS.cdpMessageBytes) {
      observer.recordObserverError();
      return;
    }
    let payload;
    try {
      payload = JSON.parse(event.message);
    } catch {
      observer.recordObserverError();
      return;
    }
    if(typeof payload.id === 'number') {
      const key = `${event.sessionId}:${payload.id}`;
      const pending = pendingCommands.get(key);
      if(!pending) return;
      pendingCommands.delete(key);
      if(payload.error) pending.reject(new Error('worker_cdp_command_failed'));
      else pending.resolve(payload.result || {});
      return;
    }
    if(typeof payload.method !== 'string') return;
    observer.noteWorkerEvent(targetId, payload.method, payload.params);
  }

  return {
    get discoveryActive() {
      return discoveryActive;
    },
    get foreignTargets() {
      return unattributedTargets.size;
    },
    get contextlessTargets() {
      return contextlessTargets.size;
    },
    get appContextlessTargets() {
      return appContextlessTargets.size;
    },
    get ownedTargetCount() {
      return targetOwners.size;
    },
    async launch(browser) {
      session = await withCommandTimeout(() => browser.newBrowserCDPSession());
      send = createGatedSender('browser', session, null);
      session.on('Target.targetCreated', ({targetInfo}) => onTargetInfo(targetInfo));
      session.on('Target.targetInfoChanged', ({targetInfo}) => onTargetInfo(targetInfo));
      session.on('Target.attachedToTarget', ({sessionId, targetInfo}) => {
        const observer = ownerOf(targetInfo.targetId);
        if(!observer) {
          send('Target.detachFromTarget', {sessionId}).catch(() => {
            orphanDetachFailures++;
          });
          return;
        }
        sessionTargets.set(sessionId, targetInfo.targetId);
        targetSessions.set(targetInfo.targetId, sessionId);
        attachedSessions.add(sessionId);
        attachingTargets.delete(targetInfo.targetId);
        setupObserver(observer, targetInfo.targetId);
      });
      session.on('Target.receivedMessageFromTarget', (event) => onReceivedMessage(event));
      session.on('Target.detachedFromTarget', ({sessionId}) => {
        const targetId = sessionTargets.get(sessionId);
        attachedSessions.delete(sessionId);
        sessionTargets.delete(sessionId);
        if(!targetId) return;
        targetSessions.delete(targetId);
        const observer = ownerOf(targetId);
        if(observer && !observer.targets.get(targetId)?.setupComplete) observer.noteDetachBeforeSetup();
      });
      session.on('Target.targetDestroyed', ({targetId}) => {
        contextlessTargets.delete(targetId);
        appContextlessTargets.delete(targetId);
        const observer = ownerOf(targetId);
        if(observer) observer.noteDestroyed(targetId);
      });
      await send('Target.setDiscoverTargets', {discover: true});
      discoveryActive = true;
    },
    registerContext(browserContextId, observer) {
      if(!browserContextId) {
        observer.recordObserverError();
        return;
      }
      contextObservers.set(browserContextId, observer);
      if(observer.control !== true) appContextCount++;
      observer.state.discoveryActive = discoveryActive;
      const pending = pendingByContext.get(browserContextId) || [];
      pendingByContext.delete(browserContextId);
      for(const targetInfo of pending) {
        observer.registerTarget(targetInfo);
        unattributedTargets.delete(targetInfo.targetId);
        if(observer.state.overflow) continue;
        targetOwners.set(targetInfo.targetId, observer);
        if(targetInfo.type === 'shared_worker') attachSharedWorker(observer, targetInfo);
      }
    },
    // Synthetic control only: drive the real attach-failure branch.
    simulateAttachFailure(observer) {
      return send('Target.attachToTarget', {targetId: INJECTED_TARGET_ID, flatten: false})
      .then(async({sessionId}) => {
        observer.noteAttachFailure();
        try {
          await send('Target.detachFromTarget', {sessionId});
        } catch {
          orphanDetachFailures++;
          observer.recordObserverError();
        }
      })
      .catch(() => observer.noteAttachFailure());
    },
    async waitForSetup() {
      while(setupPromises.size > 0) {
        await Promise.all([...setupPromises]);
      }
    },
    async releaseContext(observer) {
      let detachFailures = 0;
      for(const [targetId, owner] of [...targetOwners.entries()]) {
        if(owner !== observer) continue;
        targetOwners.delete(targetId);
        attachingTargets.delete(targetId);
        const sessionId = targetSessions.get(targetId);
        if(!sessionId) continue;
        targetSessions.delete(targetId);
        sessionTargets.delete(sessionId);
        attachedSessions.delete(sessionId);
        try {
          await send('Target.detachFromTarget', {sessionId});
        } catch {
          detachFailures++;
          observer.recordObserverError();
        }
      }
      return {detachFailures};
    },
    // Detach and discovery-disable failures are counted and returned: the
    // cleanup stage must go nonzero on them, never resolve silently.
    async stop() {
      if(!session) return {detachFailures: 0, discoveryDisabled: true};
      let detachFailures = orphanDetachFailures;
      for(const sessionId of [...attachedSessions]) {
        try {
          await send('Target.detachFromTarget', {sessionId});
        } catch {
          detachFailures++;
        }
      }
      attachedSessions.clear();
      sessionTargets.clear();
      targetSessions.clear();
      session.removeAllListeners();
      let discoveryDisabled = true;
      try {
        await send('Target.setDiscoverTargets', {discover: false});
      } catch {
        discoveryDisabled = false;
      }
      return {detachFailures, discoveryDisabled};
    }
  };
}

function createNetworkObserver(page, contextName, contextObserver) {
  const events = [];
  const eventKeys = new Set();
  const targets = new Map();
  const observedWorkerTargets = {shared_worker: new Set(), service_worker: new Set()};
  const pendingCommands = new Map();
  const setupPromises = new Set();
  const errors = [];
  let nextCommandId = 0;
  let cdp;
  let send;

  // Nested-message failures bypass normal event accounting; coalesce their
  // fixed classes and charge each failure to the context budget.
  function recordError(category) {
    if(contextObserver?.state.overflow) return;
    if(errors.length < 8 && !errors.includes(category)) errors.push(category);
    if(contextObserver && contextObserver.noteEvent()) contextObserver.recordObserverError();
  }

  function record(targetId, source, kind, url, eventName) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }

    if(parsed.protocol === 'data:' || parsed.protocol === 'about:') return;
    if(parsed.protocol === 'blob:') {
      try {
        if(new URL(parsed.pathname).origin === PRIVATE_CSP_ORIGIN) return;
      } catch {
        // An unparseable blob URL remains an unexpected attempt.
      }
    }
    if(!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return;

    const allowed = parsed.origin === PRIVATE_CSP_ORIGIN || (kind === 'websocket' && url === PRIVATE_CSP_WSS);
    const key = kind === 'websocket' ? `${targetId}:${kind}:${url}` : undefined;
    if(key && eventKeys.has(key)) return;
    if(contextObserver && !contextObserver.noteEvent()) return;
    if(key) eventKeys.add(key);
    events.push({
      source,
      kind,
      allowed,
      allowedWebSocket: kind === 'websocket' && url === PRIVATE_CSP_WSS,
      event: eventName
    });
  }

  function sendTargetCommand(sessionId, method, params = {}) {
    if(!observation.allowCdpMethod('worker', method)) {
      recordError('cdp_method_not_allowed');
      return Promise.reject(new Error('cdp_method_not_allowed'));
    }
    const id = ++nextCommandId;
    const key = `${sessionId}:${id}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(key);
        reject(new Error('cdp_command_timeout'));
      }, observation.LIMITS.commandTimeoutMs);
      pendingCommands.set(key, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({id, method, params})
      }).catch((error) => {
        const pending = pendingCommands.get(key);
        if(!pending) return;
        pendingCommands.delete(key);
        pending.reject(error);
      });
    });
  }

  function addTarget(sessionId, targetInfo) {
    if(targets.has(sessionId)) return;
    contextObserver?.registerTarget(targetInfo);
    // The attached-target budget bounds protocol setup, not just a counter: a
    // target that cannot be counted gets no enables and is released at once.
    if(contextObserver && !contextObserver.noteAttached(targetInfo.targetId)) {
      const release = (async() => {
        try {
          await send('Target.detachFromTarget', {sessionId});
        } catch {
          recordError('worker_target_release');
        }
      })().finally(() => setupPromises.delete(release));
      setupPromises.add(release);
      return;
    }
    targets.set(sessionId, targetInfo);
    if(targetInfo.type === 'shared_worker' || targetInfo.type === 'service_worker') {
      observedWorkerTargets[targetInfo.type].add(targetInfo.targetId);
    }
    const setup = (async() => {
      if(['shared_worker', 'service_worker', 'worker'].includes(targetInfo.type)) {
        await sendTargetCommand(sessionId, 'Network.enable');
        await sendTargetCommand(sessionId, 'Audits.enable');
        await sendTargetCommand(sessionId, 'Log.enable');
      }
      // Unconditional startup release: page auto-attach holds the target.
      await sendTargetCommand(sessionId, 'Runtime.runIfWaitingForDebugger');
      contextObserver?.noteSetupComplete(targetInfo.targetId);
    })().catch(() => {
      recordError('worker_target_setup');
    }).finally(() => setupPromises.delete(setup));
    setupPromises.add(setup);
  }

  function recordCspIssue(source, targetId, issue) {
    const details = issue?.details?.contentSecurityPolicyIssueDetails;
    if(!details || details.isReportOnly || typeof details.blockedURL !== 'string' || !details.blockedURL) return;
    const protocol = (() => {
      try {
        return new URL(details.blockedURL).protocol;
      } catch {
        return '';
      }
    })();
    if(!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) return;
    record(targetId, source, ['ws:', 'wss:'].includes(protocol) ? 'websocket' : 'fetch', details.blockedURL, 'Audits.issueAdded');
  }

  function recordLogViolation(source, targetId, entry) {
    if(!['violation', 'security'].includes(entry?.source)) return;
    const match = /'((?:https?|wss?):\/\/[^']+)'/.exec(entry.text || '');
    if(!match) return;
    const protocol = (() => {
      try {
        return new URL(match[1]).protocol;
      } catch {
        return '';
      }
    })();
    if(!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) return;
    record(targetId, source, ['ws:', 'wss:'].includes(protocol) ? 'websocket' : 'fetch', match[1], 'Log.entryAdded');
  }

  function dispatchTargetMessage(sessionId, message) {
    if(contextObserver?.state.overflow) return;
    if(typeof message !== 'string' || Buffer.byteLength(message, 'utf8') > observation.LIMITS.cdpMessageBytes) {
      recordError('cdp_message_overflow');
      return;
    }
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      recordError('invalid_worker_cdp_message');
      return;
    }
    if(payload.id !== undefined) {
      const key = `${sessionId}:${payload.id}`;
      const pending = pendingCommands.get(key);
      if(!pending) return;
      pendingCommands.delete(key);
      if(payload.error) pending.reject(new Error('worker_cdp_command_failed'));
      else pending.resolve(payload.result || {});
      return;
    }
    if(payload.method === 'Target.attachedToTarget') {
      addTarget(payload.params.sessionId, payload.params.targetInfo);
      return;
    }

    const targetInfo = targets.get(sessionId);
    if(!targetInfo) return;
    if(payload.method === 'Network.requestWillBeSent') {
      const kind = payload.params.type === 'WebSocket' ? 'websocket' : 'fetch';
      record(targetInfo.targetId, targetInfo.type, kind, payload.params.request.url, payload.method);
    } else if(payload.method === 'Network.webSocketCreated') {
      record(targetInfo.targetId, targetInfo.type, 'websocket', payload.params.url, payload.method);
    } else if(payload.method === 'Audits.issueAdded') {
      recordCspIssue(targetInfo.type, targetInfo.targetId, payload.params.issue);
    } else if(payload.method === 'Log.entryAdded') {
      recordLogViolation(targetInfo.type, targetInfo.targetId, payload.params.entry);
    }
    contextObserver?.noteWorkerEvent(targetInfo.targetId, payload.method, payload.params);
  }

  async function start(registry) {
    cdp = await withCommandTimeout(() => page.context().newCDPSession(page));
    send = createGatedSender('page', cdp, contextObserver);
    // Page-session identity mapping only: the browser context this page lives
    // in is what attributes every browser-level shared worker to it.
    const info = await send('Target.getTargetInfo');
    registry?.registerContext(info?.targetInfo?.browserContextId, contextObserver);
    cdp.on('Network.requestWillBeSent', (event) => {
      const kind = event.type === 'WebSocket' ? 'websocket' : 'fetch';
      record('page', 'page', kind, event.request.url, 'Network.requestWillBeSent');
      contextObserver?.notePageEvent('Network.requestWillBeSent', event);
    });
    cdp.on('Network.responseReceived', (event) => contextObserver?.notePageEvent('Network.responseReceived', event));
    cdp.on('Network.loadingFailed', (event) => contextObserver?.notePageEvent('Network.loadingFailed', event));
    cdp.on('Network.webSocketCreated', (event) => {
      record('page', 'page', 'websocket', event.url, 'Network.webSocketCreated');
      contextObserver?.noteEvent();
    });
    cdp.on('Audits.issueAdded', ({issue}) => {
      recordCspIssue('page', 'page', issue);
      contextObserver?.notePageEvent('Audits.issueAdded', {issue});
    });
    cdp.on('Log.entryAdded', ({entry}) => {
      recordLogViolation('page', 'page', entry);
      contextObserver?.notePageEvent('Log.entryAdded', {entry});
    });
    cdp.on('Target.attachedToTarget', ({sessionId, targetInfo}) => addTarget(sessionId, targetInfo));
    cdp.on('Target.receivedMessageFromTarget', ({sessionId, message}) => dispatchTargetMessage(sessionId, message));
    cdp.on('Target.detachedFromTarget', ({sessionId}) => targets.delete(sessionId));
    await send('Network.enable');
    await send('Audits.enable');
    await send('Log.enable');
    await send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true, flatten: false});
    // Complete page coverage: this session is enabled before every navigation.
    contextObserver.state.pageCoverageComplete = true;
  }

  async function waitForSetup() {
    while(setupPromises.size > 0) {
      await Promise.all([...setupPromises]);
    }
  }

  return {
    events,
    errors,
    async start(registry) {
      await start(registry);
    },
    async waitForSetup() {
      await waitForSetup();
    },
    summary() {
      const workerTargets = {
        shared_worker: observedWorkerTargets.shared_worker.size,
        service_worker: observedWorkerTargets.service_worker.size
      };
      const attemptsBySource = {page: 0, shared_worker: 0, service_worker: 0, worker: 0};
      const unexpectedAttemptsBySource = {page: 0, shared_worker: 0, service_worker: 0, worker: 0};
      const allowedWebSocketsBySource = {page: 0, shared_worker: 0, service_worker: 0, worker: 0};
      for(const event of events) {
        if(!Object.hasOwn(attemptsBySource, event.source)) continue;
        attemptsBySource[event.source]++;
        if(!event.allowed) unexpectedAttemptsBySource[event.source]++;
        if(event.allowedWebSocket) allowedWebSocketsBySource[event.source]++;
      }
      return {
        workerTargets,
        unexpectedAttempts: events.filter((event) => !event.allowed).length,
        allowedWebSockets: events.filter((event) => event.allowedWebSocket).length,
        attemptsBySource,
        unexpectedAttemptsBySource,
        allowedWebSocketsBySource,
        observerErrors: errors.length,
        contextName
      };
    },
    async stop() {
      cdp?.removeAllListeners();
      try {
        if(cdp) await withCommandTimeout(() => cdp.detach());
      } catch(error) {
        contextObserver?.recordObserverError();
        throw error;
      }
    }
  };
}

async function waitForWorkerTargets(page, networkObserver, contextObserver) {
  const deadline = Date.now() + 25_000;
  while(Date.now() < deadline) {
    await networkObserver.waitForSetup();
    const summary = networkObserver.summary();
    const sharedWorkerObserved = contextObserver.sharedWorkerTargetIds.size > 0 || summary.workerTargets.shared_worker > 0;
    if(sharedWorkerObserved && summary.workerTargets.service_worker > 0) return;
    await page.waitForTimeout(100);
  }
  failStage('browser_worker_observation');
}

async function captureState(page, screenshotDirectory, name, capturedScreenshots) {
  const filePath = path.join(screenshotDirectory, `${name}.png`);
  await page.screenshot({path: filePath, fullPage: false, animations: 'disabled'});
  capturedScreenshots.count++;
}

async function signIn(page, account, name, screenshotDirectory, capturedScreenshots) {
  currentStage = `${name}_sign_in_form`;
  const response = await page.goto(PRIVATE_CSP_ORIGIN, {waitUntil: 'domcontentloaded', timeout: 30_000});
  if(response?.status() !== 200) failStage(`${name}_artifact_load`);

  const manifest = await page.evaluate(async() => {
    const response = await fetch('/mtproto-target.json', {cache: 'no-store'});
    if(!response.ok) throw new Error('manifest_not_ready');
    return response.json();
  }).catch(() => failStage(`${name}_manifest_load`));
  if(!matchesPrivateArtifactManifest(manifest, runtime)) {
    failStage(`${name}_manifest_mismatch`);
  }

  const username = page.locator('input[aria-label="Username"]');
  if(!(await username.isVisible())) {
    currentStage = `${name}_username_entry`;
    const usernameEntry = page.getByRole('button', {name: /sign in with username/i});
    await usernameEntry.waitFor({state: 'visible', timeout: 30_000}).catch(() => failStage(`${name}_username_entry`));
    if(await usernameEntry.count() !== 1) failStage(`${name}_username_entry_not_unique`);
    await usernameEntry.click();
  }
  currentStage = `${name}_username_field`;
  await username.waitFor({state: 'visible', timeout: 30_000}).catch(() => failStage(`${name}_username_field`));
  await captureState(page, screenshotDirectory, `${name}-sign-in`, capturedScreenshots);
  await username.fill(account.username);
  await username.press('Enter');

  currentStage = `${name}_password_form`;
  const password = page.locator('input[type="password"]');
  await password.waitFor({state: 'visible', timeout: 30_000}).catch(() => failStage(`${name}_password_field`));
  await captureState(page, screenshotDirectory, `${name}-password`, capturedScreenshots);
  await password.fill(account.password);
  await password.press('Enter');

  currentStage = `${name}_chats_list`;
  await page.waitForFunction(() => {
    const chats = document.querySelector('#page-chats');
    return chats && getComputedStyle(chats).display !== 'none' && document.querySelector('#new-menu');
  }, null, {timeout: 45_000}).catch(() => failStage(`${name}_chats_list`));
  await page.locator('#new-menu').waitFor({state: 'visible', timeout: 15_000}).catch(() => failStage(`${name}_new_chat_menu`));
  await captureState(page, screenshotDirectory, `${name}-chats-list`, capturedScreenshots);

  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, {timeout: 20_000})
  .catch(() => failStage(`${name}_service_worker_controller`));
}

async function selectUniquePeer(page, inputSelector, resultsSelector, username, stage) {
  currentStage = stage;
  const input = page.locator(inputSelector).first();
  await input.waitFor({state: 'visible', timeout: 15_000}).catch(() => failStage(`${stage}_search_field`));
  await input.fill(username);

  const rows = page.locator(resultsSelector);
  await rows.first().waitFor({state: 'visible', timeout: 25_000}).catch(() => failStage(`${stage}_search_results`));
  const count = await rows.count();
  const usernameMatches = rows.filter({hasText: username});
  const matchCount = await usernameMatches.count();
  let selectedRow;
  if(matchCount === 1) {
    selectedRow = usernameMatches;
  } else {
    const visible = [];
    for(let index = 0; index < count; index++) {
      const row = rows.nth(index);
      if(await row.isVisible()) visible.push(row);
    }
    if(visible.length !== 1) failStage(`${stage}_search_result_not_unique`);
    selectedRow = visible[0];
  }
  const peerId = await selectedRow.getAttribute('data-peer-id');
  if(!peerId) failStage(`${stage}_peer_identity`);
  await selectedRow.click();
  return peerId;
}

async function openComposer(page, stage) {
  const input = page.locator('#column-center .input-message-input[contenteditable="true"]');
  await input.waitFor({state: 'visible', timeout: 30_000}).catch(() => failStage(`${stage}_composer`));
  return input;
}

async function sendText(page, text, stage) {
  currentStage = stage;
  const input = await openComposer(page, stage);
  await input.fill(text);
  await input.press('Enter');
  const message = page.locator('#column-center .bubble .message').filter({hasText: text});
  await message.first().waitFor({state: 'visible', timeout: 30_000}).catch(() => failStage(`${stage}_visible_message`));
  await page.waitForTimeout(600);
  const count = await message.count();
  if(count !== 1) failStage(`${stage}_message_count`);
}

async function waitForMembers(page, memberRows) {
  const deadline = Date.now() + 20_000;
  while(Date.now() < deadline) {
    if(await memberRows.count() >= 2) return;
    await page.waitForTimeout(100);
  }
  failStage('bob_group_member_count');
}

// The accepted fixture's synthetic controls, run before any app context exists.
// Each control owns its own browser context, so its targets never enter app
// counts, and any mismatch stops the run before the app scenarios start.
async function runObserverControls(browser, registry, cleanupIssues) {
  const controls = {};
  const failedControls = [];
  for(const plan of CONTROL_PLAN) {
    const context = await browser.newContext({viewport: {width: 1280, height: 900}});
    const observer = observation.createContextObserver(plan.name, {control: true});
    let networkObserver;
    try {
      const page = await context.newPage();
      networkObserver = createNetworkObserver(page, plan.name, observer);
      await networkObserver.start(registry);
      const response = await page.goto(`${PRIVATE_CSP_ORIGIN}${PROBE_PATH}`, {waitUntil: 'domcontentloaded', timeout: 20_000}).catch(() => null);
      if(response?.status() !== 200) {
        observer.recordObserverError();
      } else if(plan.expression) {
        // A control context is a fixture-owned probe page, not an app context:
        // this is where the synthetic worker construction is issued.
        await page.evaluate(`(() => { ${plan.expression}; })()`).catch(() => observer.recordObserverError());
      }
      if(plan.fault === 'attach') await registry.simulateAttachFailure(observer);
      if(plan.fault === 'overflow') observer.noteInjectedControlFault('overflow');
      await page.waitForTimeout(plan.windowMs || CONTROL_WINDOW_MS);
      observer.state.windowElapsed = true;
      const block = observer.summary();
      controls[plan.name] = {...block, expected: observation.evaluateControl(plan.name, block)};
      if(controls[plan.name].expected === 'fail') failedControls.push(plan.name);
    } catch {
      observer.state.windowElapsed = true;
      controls[plan.name] = {...observer.summary(), expected: 'fail'};
      failedControls.push(plan.name);
    } finally {
      // Observer sessions detach and this context's discovery attribution is
      // released before the context itself closes.
      try {
        const released = await registry.releaseContext(observer);
        await networkObserver?.stop();
        if(released?.detachFailures > 0) cleanupIssues.push('observer_control_cleanup');
      } catch {
        cleanupIssues.push('observer_control_cleanup');
      }
      try {
        await context.close();
      } catch {
        cleanupIssues.push('observer_control_cleanup');
      }
    }
  }
  return {controls, failedControls};
}

function summarizeEgress(observers) {
  const summaries = observers.map((observer) => observer.summary());
  return {
    unexpectedAttempts: summaries.reduce((sum, summary) => sum + summary.unexpectedAttempts, 0),
    observerErrors: summaries.reduce((sum, summary) => sum + summary.observerErrors, 0)
  };
}

function buildObservationBlock(registry, appObservers, controls, egress) {
  const contexts = {};
  const controlBlocks = {};
  let countedEvents = 0;
  let attachedTargets = 0;
  let observerOverflow = 0;
  let observerErrors = egress.observerErrors;
  for(const [name, observer] of Object.entries(appObservers)) {
    const block = observer.summary();
    contexts[name] = block;
    countedEvents += block.countedEvents;
    attachedTargets += block.attachedTargets;
    observerErrors += block.observerErrors;
    if(block.observerOverflow === 1) observerOverflow = 1;
  }
  for(const [name, block] of Object.entries(controls)) {
    controlBlocks[name] = block;
    countedEvents += block.countedEvents;
    attachedTargets += block.attachedTargets;
  }
  return {
    unexpectedAttempts: egress.unexpectedAttempts,
    observerErrors,
    foreignTargets: registry?.foreignTargets || 0,
    contextlessTargets: registry?.contextlessTargets || 0,
    appContextlessTargets: registry?.appContextlessTargets || 0,
    discoveryActive: registry?.discoveryActive ? 1 : 0,
    attachedTargets,
    observerOverflow,
    countedEvents,
    contexts,
    controls: controlBlocks
  };
}

function buildObserverOnlyReport(registry, controls) {
  const block = buildObservationBlock(registry, {}, controls, {unexpectedAttempts: 0, observerErrors: 0});
  const schemaFailure = observation.validateNetworkBlock(block);
  const failedControls = Object.entries(controls).filter(([, block]) => block.expected !== 'pass').map(([name]) => name);
  if(schemaFailure || failedControls.length > 0 || registry.foreignTargets !== 0 || !registry.discoveryActive) {
    return {
      status: 'failed',
      stage: schemaFailure ? 'worker_observation_unclassified' : 'observer_control_mismatch',
      mode: 'observer_controls',
      scenarios: [],
      contextCount: 0,
      controlContextCount: CONTROL_PLAN.length,
      screenshotsCaptured: 0,
      workerObservation: schemaFailure ? observation.UNCLASSIFIED_NETWORK_BLOCK : block
    };
  }
  return {
    status: 'passed',
    mode: 'observer_controls',
    scenarios: [],
    contextCount: 0,
    controlContextCount: CONTROL_PLAN.length,
    screenshotsCaptured: 0,
    workerObservation: block
  };
}

async function main() {
  let report;
  let browser;
  const contexts = [];
  const observers = [];
  const appObservers = {};
  const capturedScreenshots = {count: 0};
  const cleanupIssues = [];
  let cleanupFailed = false;
  let registry;
  let controls = {};
  try {
    runtime = await readRuntimeInput();
    validateRuntimeInput(runtime);
    fs.mkdirSync(runtime.screenshotDirectory, {mode: 0o700});

    currentStage = 'browser_launch';
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: [
        `--host-resolver-rules=MAP telegramd.test ${runtime.frontIp},MAP * ~NOTFOUND`,
        `--ignore-certificate-errors-spki-list=${runtime.leafSPKI}`,
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-domain-reliability',
        '--disable-quic',
        '--disable-sync',
        '--dns-prefetch-disable'
      ]
    });

    // Browser-level discovery starts before this runner creates any context,
    // so shared-worker creation is never missed and absence becomes provable.
    currentStage = 'browser_worker_discovery';
    registry = createWorkerDiscovery();
    await registry.launch(browser);

    currentStage = 'observer_controls';
    const controlRun = await runObserverControls(browser, registry, cleanupIssues);
    controls = controlRun.controls;
    if(controlRun.failedControls.length > 0) failStage('observer_control_mismatch');

    // The synthetic-only mode proves the observer capability against the
    // fixture's own probe controls: no app context, no artifact.
    if(runtime.observationOnly === true) {
      report = buildObserverOnlyReport(registry, controls);
      return;
    }

    const accounts = runtime.accounts;
    currentStage = 'alice_context';
    const alice = {context: await browser.newContext({viewport: {width: 1280, height: 900}})};
    contexts.push(alice.context);
    alice.page = await alice.context.newPage();
    alice.observer = observation.createContextObserver('alice');
    appObservers.alice = alice.observer;
    alice.networkObserver = createNetworkObserver(alice.page, 'alice', alice.observer);
    observers.push(alice.networkObserver);
    await alice.networkObserver.start(registry);

    currentStage = 'bob_context';
    const bob = {context: await browser.newContext({viewport: {width: 1280, height: 900}})};
    contexts.push(bob.context);
    bob.page = await bob.context.newPage();
    bob.observer = observation.createContextObserver('bob');
    appObservers.bob = bob.observer;
    bob.networkObserver = createNetworkObserver(bob.page, 'bob', bob.observer);
    observers.push(bob.networkObserver);
    await bob.networkObserver.start(registry);

    const pageErrors = [];
    for(const page of [alice.page, bob.page]) {
      page.on('pageerror', () => pageErrors.push('pageerror'));
    }

    currentScenario = 'sign-in';
    await signIn(alice.page, accounts[0], 'alice', runtime.screenshotDirectory, capturedScreenshots);
    await signIn(bob.page, accounts[1], 'bob', runtime.screenshotDirectory, capturedScreenshots);
    alice.observer.state.windowElapsed = true;
    bob.observer.state.windowElapsed = true;
    await waitForWorkerTargets(alice.page, alice.networkObserver, alice.observer);
    await waitForWorkerTargets(bob.page, bob.networkObserver, bob.observer);
    report = [{name: 'sign-in', status: 'passed'}];

    currentScenario = 'message';
    await selectUniquePeer(
      alice.page,
      '#column-left .input-search-input',
      '#search-container .row[data-peer-id]',
      accounts[1].username,
      'alice_direct_chat'
    );
    await openComposer(alice.page, 'alice_direct_chat');
    await sendText(alice.page, MESSAGE, 'alice_direct_message');
    await captureState(alice.page, runtime.screenshotDirectory, 'alice-direct-message', capturedScreenshots);

    await selectUniquePeer(
      bob.page,
      '#column-left .input-search-input',
      '#search-container .row[data-peer-id]',
      accounts[0].username,
      'bob_direct_chat'
    );
    await openComposer(bob.page, 'bob_direct_chat');
    const bobDirectMessages = bob.page.locator('#column-center .bubble .message').filter({hasText: MESSAGE});
    await bobDirectMessages.first().waitFor({state: 'visible', timeout: 30_000}).catch(() => failStage('bob_direct_message_visible'));
    await bob.page.waitForTimeout(600);
    const directMessageFailure = getSingleExactMessageFailure(await bobDirectMessages.allInnerTexts(), MESSAGE);
    if(directMessageFailure) failStage(`bob_direct_message_${directMessageFailure}`);
    await captureState(bob.page, runtime.screenshotDirectory, 'bob-direct-message', capturedScreenshots);
    report.push({name: 'message', status: 'passed'});

    currentScenario = 'group';
    currentStage = 'alice_new_group_menu';
    await alice.page.locator('#new-menu').click();
    await captureState(alice.page, runtime.screenshotDirectory, 'alice-new-group-menu', capturedScreenshots);
    await alice.page.getByText('New Group', {exact: true}).click();
    const memberSelector = '.add-members-container';
    await alice.page.locator(memberSelector).waitFor({state: 'visible', timeout: 15_000}).catch(() => failStage('alice_add_members_screen'));
    const selectedBobPeerId = await selectUniquePeer(
      alice.page,
      `${memberSelector} .input-search-input`,
      `${memberSelector} .row[data-peer-id]`,
      accounts[1].username,
      'alice_add_bob_to_group'
    );
    await captureState(alice.page, runtime.screenshotDirectory, 'alice-group-member-selection', capturedScreenshots);
    const continueGroup = alice.page.locator(`${memberSelector} .btn-corner`);
    await continueGroup.click();

    const groupName = `browser-ci-group-${runtime.runId.slice(0, 8)}`;
    currentStage = 'alice_group_name';
    const groupForm = alice.page.locator('.new-group-container');
    await groupForm.waitFor({state: 'visible', timeout: 15_000}).catch(() => failStage('alice_group_name_form'));
    await captureState(alice.page, runtime.screenshotDirectory, 'alice-group-name', capturedScreenshots);
    const groupNameInput = groupForm.locator('input:visible').first();
    await groupNameInput.fill(groupName);
    await groupForm.locator('.btn-corner').click();
    await openComposer(alice.page, 'alice_group_created');
    const aliceGroupTitle = alice.page.locator('#column-center .topbar .chat-info');
    await aliceGroupTitle.waitFor({state: 'visible', timeout: 30_000}).catch(() => failStage('alice_group_header'));
    if(!(await aliceGroupTitle.innerText()).includes(groupName)) failStage('alice_group_title');
    await captureState(alice.page, runtime.screenshotDirectory, 'alice-group-created', capturedScreenshots);

    currentStage = 'bob_group_membership';
    const bobGroupRow = bob.page.locator('#chatlist-container .chatlist-chat').filter({hasText: groupName});
    await bobGroupRow.waitFor({state: 'visible', timeout: 45_000}).catch(() => failStage('bob_group_chatlist_entry'));
    await bobGroupRow.click();
    await openComposer(bob.page, 'bob_group_chat');
    const bobGroupTitle = bob.page.locator('#column-center .topbar .chat-info');
    await bobGroupTitle.waitFor({state: 'visible', timeout: 30_000}).catch(() => failStage('bob_group_header'));
    if(!(await bobGroupTitle.innerText()).includes(groupName)) failStage('bob_group_title');
    await captureState(bob.page, runtime.screenshotDirectory, 'bob-group-chat', capturedScreenshots);

    currentStage = 'alice_group_message';
    await sendText(alice.page, GROUP_MESSAGE, 'alice_group_message');
    await captureState(alice.page, runtime.screenshotDirectory, 'alice-group-message', capturedScreenshots);

    currentStage = 'bob_group_message';
    const bobGroupMessage = bob.page.locator('#column-center .bubble .message').filter({hasText: GROUP_MESSAGE});
    await bobGroupMessage.first().waitFor({state: 'visible', timeout: 30_000}).catch(() => failStage('bob_group_message_visible'));
    await bob.page.waitForTimeout(600);
    if(await bobGroupMessage.count() !== 1) failStage('bob_group_message_count');
    await captureState(bob.page, runtime.screenshotDirectory, 'bob-group-message', capturedScreenshots);

    currentStage = 'bob_group_member_list';
    await bobGroupTitle.click();
    const membersRow = bob.page.locator('#column-right .row').filter({hasText: /^Members/});
    await membersRow.waitFor({state: 'visible', timeout: 15_000}).catch(() => failStage('bob_group_members_row'));
    await membersRow.click();
    const memberRows = bob.page.locator('#column-right .chat-members-container .row[data-peer-id]');
    await memberRows.first().waitFor({state: 'visible', timeout: 20_000}).catch(() => failStage('bob_group_member_list'));
    await waitForMembers(bob.page, memberRows);
    const memberPeerIds = await memberRows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-peer-id')));
    if(memberPeerIds.length !== 2 || !memberPeerIds.includes(selectedBobPeerId)) failStage('bob_group_member_identity');
    await captureState(bob.page, runtime.screenshotDirectory, 'bob-group-members', capturedScreenshots);
    report.push({name: 'group', status: 'passed'});

    await Promise.all(observers.map((observer) => observer.waitForSetup()));
    await registry.waitForSetup();
    const apps = {alice, bob};
    const networkContexts = Object.fromEntries(Object.entries(apps).map(([name, app]) => {
      const summary = app.networkObserver.summary();
      return [name, {
        workerTargets: summary.workerTargets,
        allowedWebSockets: summary.allowedWebSockets,
        attemptsBySource: summary.attemptsBySource,
        unexpectedAttemptsBySource: summary.unexpectedAttemptsBySource,
        allowedWebSocketsBySource: summary.allowedWebSocketsBySource
      }];
    }));
    const egress = summarizeEgress(observers);
    const observationBlock = buildObservationBlock(registry, appObservers, controls, egress);
    if(egress.unexpectedAttempts !== 0 || egress.observerErrors !== 0 || pageErrors.length !== 0) failStage('browser_egress_or_page_errors');
    if(registry.foreignTargets !== 0 || registry.appContextlessTargets !== 0) failStage('browser_worker_observation_incomplete');
    if(['alice', 'bob'].some((name) => observationBlock.contexts[name].coverageComplete !== 1)) failStage('browser_worker_observation_incomplete');
    if(['alice', 'bob'].some((name) => observationBlock.contexts[name].sharedWorkerState !== 'created')) failStage('browser_worker_or_websocket_evidence');
    if(['alice', 'bob'].some((name) => networkContexts[name].workerTargets.service_worker < 1 ||
        networkContexts[name].allowedWebSockets < 1)) {
      failStage('browser_worker_or_websocket_evidence');
    }
    if(observation.validateNetworkBlock(observationBlock)) failStage('worker_observation_unclassified');

    report = {
      status: 'passed',
      scenarios: report,
      contextCount: contexts.length,
      controlContextCount: CONTROL_PLAN.length,
      screenshotsCaptured: capturedScreenshots.count,
      network: {unexpectedAttempts: egress.unexpectedAttempts, observerErrors: egress.observerErrors, contexts: networkContexts},
      workerObservation: observationBlock
    };
  } catch(error) {
    const egress = summarizeEgress(observers);
    // The bounded sign-in window has ended by the time a sign-in stage fails,
    // so the failure report states what the observer established, not a blank.
    for(const observer of Object.values(appObservers)) observer.state.windowElapsed = true;
    const failureBlock = buildObservationBlock(registry, appObservers, controls, egress);
    report = {
      status: 'failed',
      stage: currentStage,
      ...(currentScenario ? {scenario: currentScenario} : {}),
      errorClass: ['TimeoutError', 'TypeError', 'Error', 'AbortError'].includes(error?.name) ? error.name : 'OtherError',
      scenarios: Array.isArray(report) ? report : [],
      contextCount: contexts.length,
      controlContextCount: CONTROL_PLAN.length,
      screenshotsCaptured: capturedScreenshots.count,
      // On failure the closed-schema evidence is still the point, validated the
      // same way: any schema violation collapses it to `unclassified`.
      ...(registry ? {
        workerObservation: observation.validateNetworkBlock(failureBlock) ? observation.UNCLASSIFIED_NETWORK_BLOCK : failureBlock
      } : {})
    };
  } finally {
    currentStage = 'cleanup';
    try {
      const discoveryStopped = await registry?.stop();
      if(discoveryStopped && (discoveryStopped.detachFailures > 0 || discoveryStopped.discoveryDisabled === false)) {
        cleanupIssues.push('worker_discovery_cleanup');
      }
    } catch {
      cleanupIssues.push('worker_discovery_cleanup');
    }
    for(const observer of observers) {
      try {
        await observer.stop();
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await Promise.all(contexts.map((context) => context.close()));
    } catch {
      cleanupFailed = true;
    }
    try {
      await browser?.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      if(runtime?.screenshotDirectory) fs.rmSync(runtime.screenshotDirectory, {recursive: true, force: true});
    } catch {
      cleanupFailed = true;
    }
    if(cleanupIssues.length > 0) cleanupFailed = true;
    emitReport(report, cleanupFailed);
  }
}

// Emitted from the cleanup block, so the synthetic-only path that returns
// early and the scenario path that runs to completion report identically.
function emitReport(report, cleanupFailed) {
  if(cleanupFailed) {
    process.stdout.write(`${JSON.stringify({status: 'failed', stage: 'cleanup'})}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if(report.status !== 'passed') process.exitCode = 1;
}

let runtime;
module.exports = {createNetworkObserver, createWorkerDiscovery, getSingleExactMessageFailure, matchesPrivateArtifactManifest};
if(require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({status: 'failed', stage: currentStage, errorClass: 'OtherError'})}\n`);
    process.exitCode = 1;
  });
}
