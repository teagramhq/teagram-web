const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const observation = require('./observation.cjs');

const REQUIRED_SCENARIOS = ['sign-in', 'message', 'group'];
const PRIVATE_CSP_ORIGIN = observation.PRIVATE_CSP_ORIGIN;
const PRIVATE_CSP_WSS = 'wss://teagramd.test/apiws';
const PROBE_PATH = '/_fixture_probe/';
const MESSAGE = 'browser-ci-hello';
const GROUP_MESSAGE = 'browser-ci-group-hello';
const PASSWORD_FIELD_SELECTOR = '#auth-pages input[name="notsearch_password"]';
const PASSWORD_FIELD_TIMEOUT_MS = 30_000;
// The height mirror next to the composer shares its class and editability.
const COMPOSER_INPUT_SELECTOR = '.input-message-input:not(.input-field-input-fake)[contenteditable="true"]';
const COMPOSER_SELECTOR = `#column-center ${COMPOSER_INPUT_SELECTOR}`;
const CENTER_COLUMN_CAPTURE_TIMEOUT_MS = 5_000;
const GROUP_NAME_FORM_SELECTOR = '.new-group-container';
// The group name is an InputField: a contenteditable div, not an <input>.
const GROUP_NAME_FIELD_SELECTOR = '.input-field-input:not(.input-field-input-fake)[contenteditable="true"]';
const GROUP_NAME_STEP_TIMEOUT_MS = 15_000;
// A basic group's peer id is negative, a user's positive.
const GROUP_CHAT_SELECTOR = '.topbar .avatar[data-peer-id^="-"]';
const GROUP_CREATED_STEP_TIMEOUT_MS = 30_000;
const CHANNEL_MEMBERSHIP_STEP_TIMEOUT_MS = 45_000;
const GROUP_MESSAGE_STABLE_WINDOW_MS = 600;
const GROUP_MESSAGE_SAMPLE_INTERVAL_MS = 100;
const GROUP_MESSAGE_SETTLE_TIMEOUT_MS = 10_000;
const RPC_ERROR_TYPE_LIMIT = 16;
const RPC_ERROR_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const APP_CONTEXTS = observation.GATE_CONTEXTS;
const NETWORK_RESOURCE_TYPES = observation.GATE_RESOURCE_TYPES;
const NETWORK_OBSERVER_ERROR_KINDS = new Set(observation.GATE_OBSERVER_ERROR_KINDS);
const PAGE_ERROR_CONSTRUCTORS = new Set(observation.GATE_PAGE_ERROR_CONSTRUCTORS);
const PAGE_ERROR_BLOB_ASSET_LIMIT = 512;
const PAGE_ERROR_DIAGNOSTIC_LIMITS = observation.GATE_PAGE_ERROR_DIAGNOSTIC_LIMITS;
const PAGE_ERROR_DIAGNOSTIC_SCENARIOS = new Set([...REQUIRED_SCENARIOS, 'channel']);
const PAGE_ERROR_EVENT_CAPTURE_KEY = '__teagramPageErrorEvents';
const pageErrorDiagnosticCounts = new WeakMap();
const pageErrorConsoleEvents = new WeakMap();
const pageErrorProtocolEvents = new WeakMap();
const PAGE_ERROR_BLOB_ASSET_HINTS = Object.freeze([
  {pattern: /\bTLottieWasm\.createAnimation\b/, workerLabel: 'lottie_worker'}
]);
// Bottom-bar buttons that replace the composer, keyed by their English label.
// Only the key is reported; the label never leaves the page.
const CONTROL_BAR_LABELS = Object.freeze({
  'START': 'start',
  'Unblock': 'unblock',
  'JOIN': 'join',
  'Mute': 'mute',
  'Unmute': 'unmute',
  'Open Chat': 'open_chat'
});
const PASSWORD_FAILURE_STAGES = new Set([
  'password_field_absent',
  'password_field_not_unique',
  'password_field_hidden',
  'password_field_unmasked',
  'password_card_not_reached'
]);
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
// The chat that the scenario last selected and the page it waits on, kept so a
// failing chat stage can describe the centre column it gave up on.
let centerColumnTrace = createCenterColumnTrace();

// The page whose new-group name form the scenario last waited on, and how
// that step's wait ended.
let groupNameFormTrace = {page: undefined, stepWait: 'none'};

// The page, group name and stages of the group chat steps that ran last, and
// how that step's wait ended. The name is only compared inside the page.
let groupCreatedTrace = {page: undefined, groupName: undefined, stages: [], stepWait: 'none'};
let groupMemberTrace = createGroupMemberTrace();
let groupMessageTrace = createGroupMessageTrace();
let channelMembershipTrace = {page: undefined, channelName: undefined, peerId: undefined, stepWait: 'none'};

function createGroupMemberTrace() {
  return {page: undefined, groupPeerId: undefined, stages: [], stepWait: 'none', errorsAtStep: undefined, membersTab: createMembersTabTrace()};
}

function createMembersTabTrace() {
  return {
    panelActiveBefore: null,
    panelActiveAfter: null,
    target: null,
    paired: null,
    actionabilityReason: 'none',
    interceptedBy: null
  };
}

function createGroupMessageTrace() {
  return {page: undefined, stage: undefined, errorsAtStep: undefined, samples: [], result: 'pending'};
}

function createCenterColumnTrace() {
  return {page: undefined, selectedPeerId: undefined, errorsAtSelection: undefined, composerWait: 'none'};
}

function failStage(stage) {
  currentStage = stage;
  throw new Error(stage);
}

async function waitForActiveChannel(page, channelName, timeoutMs = 30_000) {
  const channelHeader = page.locator('#column-center .chat.active .topbar .chat-info').filter({hasText: channelName});
  await channelHeader.waitFor({state: 'visible', timeout: timeoutMs})
  .catch(() => failStage('alice_channel_active_channel'));
  const channelPeerId = await page.locator('#column-center .chat.active .topbar .avatar[data-peer-id]').getAttribute('data-peer-id');
  if(!/^-?[0-9]{1,20}$/.test(channelPeerId || '')) failStage('alice_channel_peer_identity');
  return channelPeerId;
}

async function waitForChannelInviteCompletion(page, addMembers, channelName, timeoutMs = 30_000, popupTimeoutMs = 3_000) {
  currentStage = 'alice_channel_add_members_close';
  await addMembers.waitFor({state: 'hidden', timeout: timeoutMs})
  .catch(() => failStage('alice_channel_add_members_close'));

  const invitePopup = page.locator('.popup-add-members');
  const popupVisible = await invitePopup.waitFor({state: 'visible', timeout: popupTimeoutMs})
  .then(() => true, () => false);
  if(popupVisible) {
    currentStage = 'alice_channel_invite_confirm';
    await invitePopup.getByRole('button', {name: 'Add', exact: true}).click({timeout: 15_000})
    .catch(() => failStage('alice_channel_invite_confirm'));
    currentStage = 'alice_channel_invite_popup_close';
    await invitePopup.waitFor({state: 'hidden', timeout: 30_000})
    .catch(() => failStage('alice_channel_invite_popup_close'));
  }

  currentStage = 'alice_channel_active_channel';
  return waitForActiveChannel(page, channelName);
}

function matchesPrivateArtifactManifest(manifest, expected) {
  const fields = ['artifactDigest', 'endpoint', 'fingerprint', 'mode', 'sourceCommit'];
  return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest) &&
    JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(fields) &&
    manifest.mode === 'private' && manifest.endpoint === expected.wssEndpoint &&
    manifest.fingerprint === expected.fingerprint && manifest.sourceCommit === expected.webRevision &&
    manifest.artifactDigest === expected.manifestArtifactDigest;
}

function getSingleExactMessageFailure(messages, expected) {
  if(messages.length !== 1) return 'count';
  if(messages[0] !== expected) return 'content';
  return null;
}

// A tweb `.message` also holds the bubble's time, delivery status and
// reactions, so the message's own text is what is left outside them. Emoji
// drawn as custom emoji or images keep their characters in
// `data-sticker-emoji` and `alt`, so they are put back as text first.
async function getSingleExactMessageTextFailure(messages, expected) {
  const texts = await messages.evaluateAll((elements) => elements.map((element) => {
    const text = element.cloneNode(true);
    text.querySelectorAll('.time, .reactions').forEach((chrome) => chrome.remove());
    text.querySelectorAll('[data-sticker-emoji]').forEach((emoji) => emoji.replaceWith(emoji.dataset.stickerEmoji));
    text.querySelectorAll('img[alt]').forEach((emoji) => emoji.replaceWith(emoji.alt));
    return text.textContent;
  }));
  return getSingleExactMessageFailure(texts, expected);
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
  const authProgress = config?.authProgressOneSubmission === true;
  if(!/^[0-9a-f]{32}$/.test(config?.runId || '') ||
      config.endpoint !== PRIVATE_CSP_ORIGIN || config.wssEndpoint !== PRIVATE_CSP_WSS ||
      !/^[0-9a-f]{16}$/.test(config.fingerprint || '') ||
      !/^[0-9a-f]{64}$/.test(config.publicKeySHA256 || '') ||
      (config.observationOnly === true
        ? config.artifactDigest !== null || config.manifestArtifactDigest !== null
        : !/^sha256:[0-9a-f]{64}$/.test(config.artifactDigest || '') ||
          typeof config.manifestArtifactDigest !== 'string' ||
          !/^sha256:[0-9a-f]{64}$/.test(config.manifestArtifactDigest)) ||
      !/^[0-9a-f]{40}$/.test(config.webRevision || '') ||
      !/^[A-Za-z0-9+/]{43}=$/.test(config.leafSPKI || '') ||
      Buffer.from(config.leafSPKI, 'base64').byteLength !== 32 ||
      Buffer.from(config.leafSPKI, 'base64').toString('base64') !== config.leafSPKI ||
      !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(config.frontIp || '') ||
      config.screenshotDirectory !== `/tmp/real-client-${config.runId}` ||
      (config.observationOnly !== undefined && config.observationOnly !== true) ||
      (config.authProgressOneSubmission !== undefined && !authProgress) ||
      (config.pageErrorDiagnostics !== undefined && typeof config.pageErrorDiagnostics !== 'boolean') ||
      (config.observationOnly === true && config.pageErrorDiagnostics === true) ||
      (authProgress && config.observationOnly === true) ||
      !Array.isArray(config.accounts) || config.accounts.length !== (authProgress ? 1 : 2)) {
    failStage('runtime_input_validation');
  }

  const expectedNames = authProgress
    ? [`u${config.runId.slice(0, 30)}a`]
    : [`u${config.runId.slice(0, 30)}a`, `u${config.runId.slice(0, 30)}b`];
  config.accounts.forEach((account, index) => {
    if(account?.username !== expectedNames[index] || !/^[0-9a-f]{64}$/.test(account.password || '')) {
      failStage('runtime_credential_validation');
    }
  });
}

// Every CDP send is gated by session scope. A method outside the accepted scope
// fails the run, and the nested worker channel carried by
// Target.sendMessageToTarget is gated by the worker scope as well.
function createGatedSender(scope, session, observer, getTargetId) {
  return function send(method, params = {}) {
    if(!observation.allowCdpMethod(scope, method)) {
      observer?.recordObserverError(getTargetId?.());
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
  const ATTRIBUTED_TYPES = ['page', 'iframe', 'shared_worker', 'service_worker', 'worker'];
  const targetDiagnostics = new Map();
  let targetDetailsOverflow = false;
  const contextObservers = new Map();
  const networkSinks = new Map();
  const targetOwners = new Map();
  const targetSessions = new Map();
  const sessionTargets = new Map();
  const attachedSessions = new Set();
  const attachingTargets = new Set();
  const pendingAttachments = new Map();
  const retiredObservers = new WeakSet();
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
  let stopping = false;

  function ownerOf(targetId) {
    return targetOwners.get(targetId);
  }

  function recordTargetDiagnostic(targetInfo, observer) {
    const targetId = targetInfo?.targetId;
    if(typeof targetId !== 'string') return null;
    let record = targetDiagnostics.get(targetId);
    if(!record) {
      if(targetDiagnostics.size >= observation.COVERAGE_TARGET_DETAILS_LIMIT) {
        targetDetailsOverflow = true;
        return null;
      }
      record = {targetId, type: 'other', owningContext: null, scriptAsset: 'unknown', observerOverflow: false};
      targetDiagnostics.set(targetId, record);
    }
    if(typeof targetInfo.type === 'string') record.type = targetInfo.type;
    if(observer) record.owningContext = observer.control ? 'control' : observer.name;
    return record;
  }

  function coverageTargets() {
    const targets = [];
    for(const record of targetDiagnostics.values()) {
      const causes = [];
      if(unattributedTargets.has(record.targetId)) causes.push('foreign');
      if(contextlessTargets.has(record.targetId)) causes.push('contextless');
      const observer = ownerOf(record.targetId);
      if(record.type === 'page' && observer && !observer.control && observer.pageTargetIds.size > 1) causes.push('multiple_pages');
      if(record.observerOverflow && record.owningContext !== 'control') causes.push('observer_overflow');
      if(observer && !observer.control && observer.state.observerErrorTargetIds.has(record.targetId)) causes.push('observer_error');
      if(causes.length > 0) {
        const resolvedAsset = networkSinks.get(observer)?.workerAsset?.(record.targetId);
        targets.push({
          type: record.type,
          owningContext: ['alice', 'bob', 'control'].includes(record.owningContext) ? record.owningContext : null,
          scriptAsset: typeof resolvedAsset === 'string' && observation.SCRIPT_ASSET_PATTERN.test(resolvedAsset)
            ? resolvedAsset
            : record.scriptAsset,
          causes
        });
      }
    }
    return targets;
  }

  function sendNested(sessionId, method, params = {}) {
    const observer = ownerOf(sessionTargets.get(sessionId));
    if(!observation.allowCdpMethod('worker', method)) {
      observer?.recordObserverError(sessionTargets.get(sessionId));
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
      observer.recordObserverError(targetId);
    }).finally(() => setupPromises.delete(setup));
    setupPromises.add(setup);
  }

  function attachTarget(observer, targetInfo, sessionId) {
    const targetId = targetInfo.targetId;
    const existingSessionId = targetSessions.get(targetId);
    if(existingSessionId) {
      if(existingSessionId !== sessionId) {
        send('Target.detachFromTarget', {sessionId}).catch(() => {
          orphanDetachFailures++;
        });
      }
      return;
    }
    targetSessions.set(targetId, sessionId);
    sessionTargets.set(sessionId, targetId);
    attachedSessions.add(sessionId);
    attachingTargets.delete(targetId);
    networkSinks.get(observer)?.claimTarget(targetId, 'shared_worker', sessionId);
    setupObserver(observer, targetId);
  }

  function attachSharedWorker(observer, targetInfo) {
    const targetId = targetInfo.targetId;
    if(stopping || retiredObservers.has(observer) || targetSessions.has(targetId) || attachingTargets.has(targetId)) return;
    attachingTargets.add(targetId);
    if(!observer.noteAttached(targetId)) {
      const diagnostic = targetDiagnostics.get(targetId);
      if(observer.state.overflow && diagnostic) diagnostic.observerOverflow = true;
      attachingTargets.delete(targetId);
      return;
    }
    let attachment;
    attachment = send('Target.attachToTarget', {targetId, flatten: false})
    .then((result) => {
      const sessionId = result?.sessionId;
      if(typeof sessionId !== 'string') throw new Error('target_attach_failed');
      if(targetSessions.has(targetId)) return;
      if(retiredObservers.has(observer) || ownerOf(targetId) !== observer || !attachingTargets.has(targetId)) {
        return send('Target.detachFromTarget', {sessionId}).catch(() => {
          orphanDetachFailures++;
        });
      }
      attachTarget(observer, targetInfo, sessionId);
    })
    .catch(() => {
      attachingTargets.delete(targetId);
      if(!targetSessions.has(targetId)) observer.noteAttachFailure(targetId);
    })
    .finally(() => pendingAttachments.delete(targetId));
    pendingAttachments.set(targetId, attachment);
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
    if(stopping) return;
    const targetId = targetInfo?.targetId;
    const currentOwner = typeof targetId === 'string' ? ownerOf(targetId) : null;
    const observer = currentOwner || attribute(targetInfo);
    const diagnostic = recordTargetDiagnostic(targetInfo, observer);
    if(!observer || retiredObservers.has(observer)) return;
    const observerWasOverflowed = observer.state.overflow;
    observer.registerTarget(targetInfo);
    if(!observerWasOverflowed && observer.state.overflow && diagnostic) diagnostic.observerOverflow = true;
    if(observer.state.overflow) return;
    const scriptAsset = networkSinks.get(observer)?.observeTarget?.(targetInfo);
    if(typeof scriptAsset === 'string' && observation.SCRIPT_ASSET_PATTERN.test(scriptAsset) && diagnostic) {
      diagnostic.scriptAsset = scriptAsset;
    }
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
    const retired = retiredObservers.has(observer);
    if(typeof event.message !== 'string' || Buffer.byteLength(event.message, 'utf8') > observation.LIMITS.cdpMessageBytes) {
      if(!retired) observer.recordObserverError(targetId);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(event.message);
    } catch {
      if(!retired) observer.recordObserverError(targetId);
      return;
    }
    if(!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      if(!retired) observer.recordObserverError(targetId);
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
    if(retired || observer.state.overflow) return;
    if(typeof payload.method !== 'string') {
      observer.recordObserverError(targetId);
      return;
    }
    const wasOverflowed = observer.state.overflow;
    observer.noteWorkerEvent(targetId, payload.method, payload.params, event.sessionId);
    if(!wasOverflowed && observer.state.overflow) {
      const diagnostic = targetDiagnostics.get(targetId);
      if(diagnostic && diagnostic.owningContext !== 'control') diagnostic.observerOverflow = true;
    }
    if(observer.state.overflow) return;
    const sink = networkSinks.get(observer);
    if(!sink) {
      observer.recordObserverError(targetId);
      return;
    }
    sink.recordWorkerEvent(targetId, 'shared_worker', event.sessionId, payload.method, payload.params);
  }

  async function waitForSetup() {
    while(pendingAttachments.size > 0 || setupPromises.size > 0) {
      await Promise.all([...pendingAttachments.values(), ...setupPromises]);
    }
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
    get targetDetailsOverflow() {
      return targetDetailsOverflow;
    },
    get ownedTargetCount() {
      return targetOwners.size;
    },
    coverageTargets,
    noteTargetOverflow(targetId) {
      const diagnostic = targetDiagnostics.get(targetId);
      if(diagnostic) diagnostic.observerOverflow = true;
    },
    async launch(browser) {
      session = await withCommandTimeout(() => browser.newBrowserCDPSession());
      send = createGatedSender('browser', session, null);
      session.on('Target.targetCreated', ({targetInfo}) => onTargetInfo(targetInfo));
      session.on('Target.targetInfoChanged', ({targetInfo}) => onTargetInfo(targetInfo));
      session.on('Target.attachedToTarget', ({sessionId, targetInfo}) => {
        const observer = ownerOf(targetInfo.targetId);
        if(targetSessions.has(targetInfo.targetId)) {
          if(targetSessions.get(targetInfo.targetId) !== sessionId) {
            send('Target.detachFromTarget', {sessionId}).catch(() => {
              orphanDetachFailures++;
            });
          }
          return;
        }
        if(!observer || retiredObservers.has(observer) || (stopping && !attachingTargets.has(targetInfo.targetId))) {
          send('Target.detachFromTarget', {sessionId}).catch(() => {
            orphanDetachFailures++;
          });
          return;
        }
        attachTarget(observer, targetInfo, sessionId);
      });
      session.on('Target.receivedMessageFromTarget', (event) => onReceivedMessage(event));
      session.on('Target.detachedFromTarget', ({sessionId}) => {
        const targetId = sessionTargets.get(sessionId);
        attachedSessions.delete(sessionId);
        sessionTargets.delete(sessionId);
        if(!targetId) return;
        targetSessions.delete(targetId);
        const observer = ownerOf(targetId);
        if(observer && !observer.targets.get(targetId)?.setupComplete) observer.noteDetachBeforeSetup(targetId);
      });
      session.on('Target.targetDestroyed', ({targetId}) => {
        contextlessTargets.delete(targetId);
        appContextlessTargets.delete(targetId);
        const observer = ownerOf(targetId);
        if(observer) {
          const observerWasOverflowed = observer.state.overflow;
          observer.noteDestroyed(targetId);
          if(!observerWasOverflowed && observer.state.overflow) {
            const diagnostic = targetDiagnostics.get(targetId);
            if(diagnostic) diagnostic.observerOverflow = true;
          }
        }
      });
      await send('Target.setDiscoverTargets', {discover: true});
      discoveryActive = true;
    },
    registerContext(browserContextId, observer, networkSink) {
      if(!browserContextId) {
        observer.recordObserverError();
        return;
      }
      contextObservers.set(browserContextId, observer);
      if(networkSink) networkSinks.set(observer, networkSink);
      else networkSinks.delete(observer);
      if(observer.control !== true) appContextCount++;
      observer.state.discoveryActive = discoveryActive;
      const pending = pendingByContext.get(browserContextId) || [];
      pendingByContext.delete(browserContextId);
      for(const targetInfo of pending) {
        const diagnostic = recordTargetDiagnostic(targetInfo, observer);
        const observerWasOverflowed = observer.state.overflow;
        observer.registerTarget(targetInfo);
        if(!observerWasOverflowed && observer.state.overflow && diagnostic) diagnostic.observerOverflow = true;
        unattributedTargets.delete(targetInfo.targetId);
        if(observer.state.overflow) continue;
        const scriptAsset = networkSink?.observeTarget?.(targetInfo);
        if(typeof scriptAsset === 'string' && observation.SCRIPT_ASSET_PATTERN.test(scriptAsset) && diagnostic) {
          diagnostic.scriptAsset = scriptAsset;
        }
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
          observer.recordObserverError(INJECTED_TARGET_ID);
        }
      })
      .catch(() => observer.noteAttachFailure());
    },
    async waitForSetup() {
      await waitForSetup();
    },
    async releaseContext(observer) {
      retiredObservers.add(observer);
      networkSinks.get(observer)?.release();
      networkSinks.delete(observer);
      await waitForSetup();
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
          observer.recordObserverError(targetId);
        }
      }
      return {detachFailures};
    },
    // Detach and discovery-disable failures are counted and returned: the
    // cleanup stage must go nonzero on them, never resolve silently.
    async stop() {
      if(!session) return {detachFailures: 0, discoveryDisabled: true};
      stopping = true;
      let detachFailures = 0;
      let discoveryDisabled = true;
      try {
        await send('Target.setDiscoverTargets', {discover: false});
      } catch {
        discoveryDisabled = false;
      }
      await waitForSetup();
      detachFailures += orphanDetachFailures;
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
      networkSinks.clear();
      session.removeAllListeners();
      return {detachFailures, discoveryDisabled};
    }
  };
}

function createNetworkObserver(page, contextName, contextObserver, pageErrorAssetResolver, onPageException) {
  const events = [];
  const gateEvents = [];
  const eventKeys = new Set();
  const targets = new Map();
  const observedWorkerTargets = {shared_worker: new Set(), service_worker: new Set()};
  const workerSessions = new Map();
  const pendingCommands = new Map();
  const setupPromises = new Set();
  const pendingReleases = new Set();
  const errors = [];
  // Reaching the release limit closes the disposable app context, which
  // releases any targets already paused by auto-attach.
  const maxPendingReleases = observation.LIMITS.attachedTargets;
  let nextCommandId = 0;
  let cdp;
  const pageScriptUrls = new Map();
  const pageScriptExecutionContexts = new Map();
  let pageTargetId;
  let targetRegistry;
  let send;
  let autoAttachDisablePromise;
  let overflowContextClosePromise;
  let overflowContextCloseError;
  let overflowContextClosed = false;
  let released = false;

  function closeContextOnOverflow() {
    if(!overflowContextClosePromise) {
      overflowContextClosePromise = withCommandTimeout(() => page.context().close()).then(() => {
        overflowContextClosed = true;
      }, (error) => {
        overflowContextCloseError = error;
      });
    }
    return overflowContextClosePromise;
  }

  function disableAutoAttach() {
    if(!send || autoAttachDisablePromise) return autoAttachDisablePromise;
    autoAttachDisablePromise = send('Target.setAutoAttach', {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: false
    }).catch(() => closeContextOnOverflow());
    return autoAttachDisablePromise;
  }

  function observerClosed() {
    const closed = contextObserver?.state.overflow === true;
    if(closed) disableAutoAttach();
    return closed || released;
  }

  function notePageEvent(method, params) {
    const wasOverflowed = contextObserver?.state.overflow === true;
    contextObserver?.notePageEvent(method, params, pageTargetId);
    if(!wasOverflowed && contextObserver?.state.overflow) targetRegistry?.noteTargetOverflow?.(pageTargetId);
    observerClosed();
  }

  // Coalesce fixed error classes, charging failures only when their message
  // has not already consumed the context event budget.
  function recordError(category, eventCounted = false, targetId) {
    if(observerClosed()) return;
    if(errors.length < 8 && !errors.includes(category)) errors.push(category);
    if(contextObserver) {
      const wasOverflowed = contextObserver.state.overflow;
      if(eventCounted || contextObserver.noteEvent()) contextObserver.recordObserverError(targetId);
      if(!wasOverflowed && contextObserver.state.overflow) targetRegistry?.noteTargetOverflow?.(targetId);
    }
    observerClosed();
  }

  function releaseRejectedTarget(sessionId) {
    disableAutoAttach();
    if(overflowContextClosePromise) return;
    if(pendingReleases.size >= maxPendingReleases) {
      closeContextOnOverflow();
      return;
    }
    // Cleanup stays separate from setup so a target flood cannot hold
    // waitForSetup open while these bounded releases settle.
    let release;
    release = send('Target.detachFromTarget', {sessionId})
    .catch(() => closeContextOnOverflow())
    .finally(() => pendingReleases.delete(release));
    pendingReleases.add(release);
  }

  function parseNetworkUrl(url) {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }

  function record(targetId, source, kind, url, eventName, resourceType = 'Other') {
    if(observerClosed()) return;
    const parsed = parseNetworkUrl(url);
    if(!parsed) {
      recordError('invalid_worker_cdp_message', true, targetId);
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
    if(key) eventKeys.add(key);
    events.push({
      source,
      kind,
      allowed,
      allowedWebSocket: kind === 'websocket' && url === PRIVATE_CSP_WSS,
      event: eventName
    });
    if(!allowed) gateEvents.push({
      source,
      scheme: parsed.protocol.slice(0, -1),
      host: parsed.host,
      resourceType: NETWORK_RESOURCE_TYPES.includes(resourceType) ? resourceType : 'Other'
    });
  }

  function sendTargetCommand(sessionId, method, params = {}) {
    if(!observation.allowCdpMethod('worker', method)) {
      recordError('cdp_method_not_allowed', false, targets.get(sessionId)?.targetId);
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
      targetRegistry?.noteTargetOverflow(targetInfo.targetId);
      releaseRejectedTarget(sessionId);
      return;
    }
    pageErrorAssetResolver?.observeWorkerTarget(targetInfo);
    targets.set(sessionId, targetInfo);
    claimTarget(targetInfo.targetId, targetInfo.type, sessionId);
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
      recordError('worker_target_setup', false, targetInfo.targetId);
    }).finally(() => setupPromises.delete(setup));
    setupPromises.add(setup);
  }

  function recordCspIssue(source, targetId, issue) {
    if(observerClosed()) return;
    const details = issue?.details?.contentSecurityPolicyIssueDetails;
    if(!details || details.isReportOnly || typeof details.blockedURL !== 'string') return;
    const parsed = parseNetworkUrl(details.blockedURL);
    if(!parsed) return;
    const protocol = parsed.protocol;
    if(!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) return;
    record(targetId, source, ['ws:', 'wss:'].includes(protocol) ? 'websocket' : 'fetch', details.blockedURL, 'Audits.issueAdded');
  }

  function recordLogViolation(source, targetId, entry) {
    if(observerClosed()) return;
    if(!['violation', 'security'].includes(entry?.source)) return;
    const match = /'((?:https?|wss?):\/\/[^']+)'/.exec(entry.text || '');
    if(!match) return;
    const parsed = parseNetworkUrl(match[1]);
    if(!parsed) return;
    const protocol = parsed.protocol;
    if(!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) return;
    record(targetId, source, ['ws:', 'wss:'].includes(protocol) ? 'websocket' : 'fetch', match[1], 'Log.entryAdded');
  }

  // Both attachment paths share one bounded target/session claim. Fetches have
  // no URL dedup key, so only the first session may supply network attempts.
  function claimTarget(targetId, source, sessionId) {
    if(observerClosed() || workerSessions.has(targetId)) return;
    workerSessions.set(targetId, sessionId);
    if(source === 'shared_worker' || source === 'service_worker') observedWorkerTargets[source].add(targetId);
  }

  // The caller has already charged and observed this message. This classifier
  // never re-enters worker observation or the independent per-socket 101 path.
  function recordWorkerEvent(targetId, source, sessionId, method, params) {
    if(observerClosed() || workerSessions.get(targetId) !== sessionId) return;
    if(!['Network.requestWillBeSent', 'Network.webSocketCreated', 'Audits.issueAdded', 'Log.entryAdded'].includes(method)) return;
    if(!params || typeof params !== 'object' || Array.isArray(params)) {
      recordError('invalid_worker_cdp_message', true, targetId);
      return;
    }
    if(method === 'Network.requestWillBeSent') {
      if((params.type !== undefined && typeof params.type !== 'string') || !params.request || typeof params.request !== 'object' ||
          Array.isArray(params.request) || typeof params.request.url !== 'string') {
        recordError('invalid_worker_cdp_message', true, targetId);
        return;
      }
      pageErrorAssetResolver?.observeRequest(params.request.url, params.initiator, params.type, targetId, source);
      record(targetId, source, params.type === 'WebSocket' ? 'websocket' : 'fetch', params.request.url, method, params.type);
    } else if(method === 'Network.webSocketCreated') {
      if(typeof params.url !== 'string') {
        recordError('invalid_worker_cdp_message', true, targetId);
        return;
      }
      record(targetId, source, 'websocket', params.url, method, 'WebSocket');
    } else if(method === 'Audits.issueAdded') {
      const issue = params.issue;
      const details = issue?.details?.contentSecurityPolicyIssueDetails;
      if(!issue || typeof issue !== 'object' || Array.isArray(issue) || !issue.details ||
          typeof issue.details !== 'object' || Array.isArray(issue.details) ||
          (details !== undefined && (!details || typeof details !== 'object' || Array.isArray(details) ||
            (details.blockedURL !== undefined && typeof details.blockedURL !== 'string') ||
            (details.isReportOnly !== undefined && typeof details.isReportOnly !== 'boolean')))) {
        recordError('invalid_worker_cdp_message', true, targetId);
        return;
      }
      recordCspIssue(source, targetId, issue);
    } else if(method === 'Log.entryAdded') {
      const entry = params.entry;
      if(!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.source !== 'string' || typeof entry.text !== 'string') {
        recordError('invalid_worker_cdp_message', true, targetId);
        return;
      }
      recordLogViolation(source, targetId, entry);
    }
  }

  function dispatchTargetMessage(sessionId, message) {
    const targetId = targets.get(sessionId)?.targetId;
    if(contextObserver?.state.overflow) {
      observerClosed();
      return;
    }
    if(typeof message !== 'string' || Buffer.byteLength(message, 'utf8') > observation.LIMITS.cdpMessageBytes) {
      recordError('cdp_message_overflow', false, targetId);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      recordError('invalid_worker_cdp_message', false, targetId);
      return;
    }
    if(!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      recordError('invalid_worker_cdp_message', false, targetId);
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
    if(observerClosed()) return;
    if(payload.method === 'Target.attachedToTarget') {
      if(!payload.params || typeof payload.params !== 'object' || Array.isArray(payload.params) ||
          typeof payload.params.sessionId !== 'string' || !payload.params.targetInfo || typeof payload.params.targetInfo !== 'object') {
        recordError('invalid_worker_cdp_message', false, targetId);
        return;
      }
      addTarget(payload.params.sessionId, payload.params.targetInfo);
      return;
    }

    const targetInfo = targets.get(sessionId);
    if(!targetInfo) return;
    const wasOverflowed = contextObserver?.state.overflow === true;
    contextObserver?.noteWorkerEvent(targetInfo.targetId, payload.method, payload.params, sessionId);
    if(!wasOverflowed && contextObserver?.state.overflow) targetRegistry?.noteTargetOverflow?.(targetInfo.targetId);
    if(observerClosed()) return;
    if(typeof payload.method !== 'string') {
      recordError('invalid_worker_cdp_message', true, targetInfo.targetId);
      return;
    }
    recordWorkerEvent(targetInfo.targetId, targetInfo.type, sessionId, payload.method, payload.params);
  }

  async function start(registry) {
    cdp = await withCommandTimeout(() => page.context().newCDPSession(page));
    send = createGatedSender('page', cdp, contextObserver, () => pageTargetId);
    // Page-session identity mapping only: the browser context this page lives
    // in is what attributes every browser-level shared worker to it.
    const info = await send('Target.getTargetInfo');
    pageTargetId = info?.targetInfo?.targetId;
    registry?.registerContext(info?.targetInfo?.browserContextId, contextObserver, {
      claimTarget,
      recordWorkerEvent,
      observeTarget: (targetInfo) => {
        pageErrorAssetResolver?.observeWorkerTarget(targetInfo);
        return pageErrorAssetResolver?.workerAsset(targetInfo?.targetId);
      },
      workerAsset: (targetId) => pageErrorAssetResolver?.workerAsset(targetId),
      release: () => { released = true; }
    });
    if(typeof onPageException === 'function') {
      cdp.on('Debugger.scriptParsed', (event) => {
        if(typeof event?.scriptId === 'string' && event.scriptId.length <= 128 &&
            typeof event.url === 'string' && event.url && event.url.length <= 8192 && pageScriptUrls.size < 4096) {
          pageScriptUrls.set(event.scriptId, event.url);
          if(Number.isSafeInteger(event.executionContextId)) pageScriptExecutionContexts.set(event.scriptId, event.executionContextId);
        }
      });
      cdp.on('Runtime.exceptionThrown', (event) => {
        try {
          onPageException(event?.exceptionDetails, 'runtime');
        } catch {
          // Page exception diagnostics must not interfere with browser observation.
        }
      });
      cdp.on('Debugger.paused', (event) => {
        try {
          if(event?.reason === 'exception' || event?.reason === 'promiseRejection') {
            const scriptUrls = {};
            for(const frame of (Array.isArray(event.callFrames) ? event.callFrames : []).slice(0, PAGE_ERROR_DIAGNOSTIC_LIMITS.count)) {
              const scriptId = frame?.location?.scriptId;
              const url = typeof frame?.url === 'string' && frame.url ? frame.url : pageScriptUrls.get(scriptId);
              if(typeof scriptId === 'string' && typeof url === 'string' && url) scriptUrls[scriptId] = url;
            }
            const firstScriptId = event.callFrames?.[0]?.location?.scriptId;
            const executionContextId = pageScriptExecutionContexts.get(firstScriptId);
            onPageException({...event, executionContextId, scriptUrls}, 'debugger');
          }
        } catch {
          // Page exception diagnostics must not interfere with browser observation.
        }
        send('Debugger.resume').catch(() => {});
      });
      await send('Runtime.enable');
      await send('Debugger.enable');
      await send('Debugger.setPauseOnExceptions', {state: 'uncaught'});
    }
    cdp.on('Network.requestWillBeSent', (event) => {
      if(observerClosed()) return;
      const kind = event.type === 'WebSocket' ? 'websocket' : 'fetch';
      notePageEvent('Network.requestWillBeSent', event);
      if(observerClosed()) return;
      pageErrorAssetResolver?.observeRequest(event.request.url, event.initiator, event.type, pageTargetId);
      record(pageTargetId, 'page', kind, event.request.url, 'Network.requestWillBeSent', event.type);
    });
    cdp.on('Network.responseReceived', (event) => {
      if(observerClosed()) return;
      notePageEvent('Network.responseReceived', event);
    });
    cdp.on('Network.loadingFailed', (event) => {
      if(observerClosed()) return;
      notePageEvent('Network.loadingFailed', event);
    });
    cdp.on('Network.webSocketCreated', (event) => {
      if(observerClosed()) return;
      notePageEvent('Network.webSocketCreated', event);
      if(observerClosed()) return;
      record(pageTargetId, 'page', 'websocket', event.url, 'Network.webSocketCreated', 'WebSocket');
    });
    if(contextObserver?.observeWebSocket101) {
      cdp.on('Network.webSocketHandshakeResponseReceived', (event) => {
        if(observerClosed()) return;
        notePageEvent('Network.webSocketHandshakeResponseReceived', event);
      });
    }
    cdp.on('Audits.issueAdded', (event) => {
      if(observerClosed()) return;
      const issue = event.issue;
      notePageEvent('Audits.issueAdded', {issue});
      if(observerClosed()) return;
      recordCspIssue('page', pageTargetId, issue);
    });
    cdp.on('Log.entryAdded', (event) => {
      if(observerClosed()) return;
      const entry = event.entry;
      notePageEvent('Log.entryAdded', {entry});
      if(observerClosed()) return;
      recordLogViolation('page', pageTargetId, entry);
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

  async function waitForOverflowCleanup() {
    if(autoAttachDisablePromise) await autoAttachDisablePromise;
    await Promise.all([...pendingReleases]);
    if(overflowContextClosePromise) await overflowContextClosePromise;
    if(overflowContextCloseError) throw overflowContextCloseError;
  }

  return {
    events,
    gateEvents,
    errors,
    async start(registry) {
      targetRegistry = registry;
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
        await waitForOverflowCleanup();
        if(cdp && !overflowContextClosed) await withCommandTimeout(() => cdp.detach());
      } catch(error) {
        contextObserver?.recordObserverError(pageTargetId);
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

async function waitForUsernameField(page, name) {
  currentStage = `${name}_username_field`;
  const username = page.getByRole('textbox', {name: 'Username', exact: true});
  if(await username.count() > 1) failStage(`${name}_username_field_not_unique`);
  await username.waitFor({state: 'visible', timeout: 30_000}).catch(async() => {
    if(await username.count() > 1) failStage(`${name}_username_field_not_unique`);
    failStage(`${name}_username_field`);
  });
  if(await username.count() !== 1) failStage(`${name}_username_field_not_unique`);
  return username;
}

function passwordReadinessProbe({usernameField, deadline, classifyOnly = false}) {
  const fields = document.querySelectorAll('#auth-pages input[name="notsearch_password"]');
  const count = fields.length;
  if(count > 1) return {ready: false, reason: 'password_field_not_unique', count};

  const isVisible = (element) => {
    if(!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const usernameVisible = isVisible(usernameField);
  let passwordFieldReady = false;
  if(count === 1) {
    const field = fields[0];
    const className = field.getAttribute('class') || '';
    const stealthy = className.split(/\s+/).includes('stealthy');
    const visible = isVisible(field);
    const type = field.getAttribute('type');
    if(visible && !stealthy && type === 'password' && !usernameVisible) {
      if(!classifyOnly && Date.now() < deadline) return {ready: true, count: 1};
      passwordFieldReady = true;
    }
    if(visible && !stealthy && type !== 'password' && !usernameVisible) {
      return {ready: false, reason: 'password_field_unmasked', count: 1};
    }
  }

  if(Date.now() < deadline) return false;
  if(usernameVisible) return {ready: false, reason: 'password_card_not_reached', count};
  if(count === 0) return {ready: false, reason: 'password_field_absent', count: 0};
  if(passwordFieldReady) return {ready: false, reason: 'password_card_not_reached', count: 1};
  return {ready: false, reason: 'password_field_hidden', count: 1};
}

function failPasswordStage(name, reason, count, passwordEvidence) {
  const safeReason = PASSWORD_FAILURE_STAGES.has(reason) ? reason : 'password_field_absent';
  const stage = `${name}_${safeReason}`;
  passwordEvidence.push({stage, count: Number.isInteger(count) && count >= 0 ? count : 0});
  failStage(stage);
}

async function waitForPasswordField(page, usernameField, name, passwordEvidence = [], timeoutMs = PASSWORD_FIELD_TIMEOUT_MS) {
  currentStage = `${name}_password_form`;
  const boundedTimeoutMs = Math.max(1, Math.min(timeoutMs, PASSWORD_FIELD_TIMEOUT_MS));
  const deadline = Date.now() + Math.max(1, boundedTimeoutMs - 250);
  const password = page.locator(PASSWORD_FIELD_SELECTOR);
  let readinessHandle;
  let state;
  try {
    readinessHandle = await page.waitForFunction(
      passwordReadinessProbe,
      {usernameField, deadline},
      {timeout: boundedTimeoutMs}
    );
    state = await readinessHandle.jsonValue();
  } catch(error) {
    if(error?.name !== 'TimeoutError') throw error;
    state = await page.evaluate(passwordReadinessProbe, {usernameField, deadline: 0, classifyOnly: true});
  } finally {
    await readinessHandle?.dispose();
  }

  if(!state?.ready) failPasswordStage(name, state?.reason, state?.count, passwordEvidence);
  return password;
}

async function submitPassword(password, usernameField, value, name, passwordEvidence = []) {
  currentStage = `${name}_password_form`;
  const count = await password.count();
  if(count === 0) failPasswordStage(name, 'password_field_absent', count, passwordEvidence);
  if(count !== 1) failPasswordStage(name, 'password_field_not_unique', count, passwordEvidence);

  let selected;
  try {
    selected = await password.elementHandle({timeout: 1000});
  } catch(error) {
    if(error?.name !== 'TimeoutError') throw error;
    const changedCount = await password.count();
    if(changedCount === 0) failPasswordStage(name, 'password_field_absent', changedCount, passwordEvidence);
    if(changedCount !== 1) failPasswordStage(name, 'password_field_not_unique', changedCount, passwordEvidence);
    failPasswordStage(name, 'password_field_hidden', changedCount, passwordEvidence);
  }
  if(!selected) failPasswordStage(name, 'password_field_hidden', count, passwordEvidence);

  const visible = await selected.isVisible();
  const className = await selected.getAttribute('class') || '';
  if(!visible || className.split(/\s+/).includes('stealthy')) {
    failPasswordStage(name, 'password_field_hidden', count, passwordEvidence);
  }
  if(await usernameField.isVisible()) {
    failPasswordStage(name, 'password_card_not_reached', count, passwordEvidence);
  }

  const finalCount = await password.count();
  if(finalCount === 0) failPasswordStage(name, 'password_field_absent', finalCount, passwordEvidence);
  if(finalCount !== 1) failPasswordStage(name, 'password_field_not_unique', finalCount, passwordEvidence);
  if(await selected.getAttribute('type') !== 'password') {
    failPasswordStage(name, 'password_field_unmasked', finalCount, passwordEvidence);
  }

  await selected.fill(value);
  await selected.press('Enter');
  await selected.dispose();
  passwordEvidence.push({stage: `${name}_password_field_ready`, count: finalCount});
}

async function prepareUsernameEntry(page, name, expected) {
  currentStage = `${name}_sign_in_form`;
  const response = await page.goto(PRIVATE_CSP_ORIGIN, {waitUntil: 'domcontentloaded', timeout: 30_000});
  if(response?.status() !== 200) failStage(`${name}_artifact_load`);

  const manifest = await page.evaluate(async() => {
    const response = await fetch('/mtproto-target.json', {cache: 'no-store'});
    if(!response.ok) throw new Error('manifest_not_ready');
    return response.json();
  }).catch(() => failStage(`${name}_manifest_load`));
  if(!matchesPrivateArtifactManifest(manifest, expected)) {
    failStage(`${name}_manifest_mismatch`);
  }

  return waitForUsernameField(page, name);
}

async function signIn(page, account, name, screenshotDirectory, capturedScreenshots, passwordEvidence) {
  const username = await prepareUsernameEntry(page, name, runtime);
  await captureState(page, screenshotDirectory, `${name}-sign-in`, capturedScreenshots);
  if(await username.count() !== 1) failStage(`${name}_username_field_not_unique`);
  const usernameField = await username.elementHandle();
  if(!usernameField) failStage(`${name}_username_field`);
  await username.fill(account.username);
  await username.press('Enter');

  currentStage = `${name}_password_form`;
  const password = await waitForPasswordField(page, usernameField, name, passwordEvidence);
  await captureState(page, screenshotDirectory, `${name}-password`, capturedScreenshots);
  await submitPassword(password, usernameField, account.password, name, passwordEvidence);
  await usernameField.dispose();

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

async function submitUsernameOnceAndWaitForPassword(page, account, expected, name, passwordEvidence, actionCounts, timeoutMs = PASSWORD_FIELD_TIMEOUT_MS, webSocket101Observer) {
  const username = await prepareUsernameEntry(page, name, expected);
  if(await username.count() !== 1) failStage(`${name}_username_field_not_unique`);
  const usernameField = await username.elementHandle();
  if(!usernameField) failStage(`${name}_username_field`);

  try {
    await username.fill(account.username);
    actionCounts.usernameSubmissions++;
    webSocket101Observer?.beginUsernameSubmission();
    await username.press('Enter');
    webSocket101Observer?.completeUsernameSubmission();
    await waitForPasswordField(page, usernameField, name, passwordEvidence, timeoutMs);
    passwordEvidence.push({stage: `${name}_password_field_ready`, count: 1});
    currentStage = `${name}_password_field_ready`;
  } finally {
    await usernameField.dispose();
  }
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
  centerColumnTrace = {
    ...createCenterColumnTrace(),
    page,
    selectedPeerId: peerId,
    errorsAtSelection: {...clientErrorCounts.get(page), rpc: await readRpcErrorCounts(page)}
  };
  await selectedRow.click();
  return peerId;
}

async function openComposer(page, stage, chat = page.locator('#column-center'), timeoutMs = 30_000) {
  if(centerColumnTrace.page !== page) centerColumnTrace = {...createCenterColumnTrace(), page};
  const input = chat.locator(COMPOSER_INPUT_SELECTOR);
  await input.waitFor({state: 'visible', timeout: timeoutMs}).catch((error) => {
    centerColumnTrace.composerWait = classifyLocatorError(error);
    failStage(`${stage}_composer`);
  });
  return input;
}

// Each step of the new-group name form fails under its own stage, so a
// failure names the step and the form summary describes what it waited on.
async function nameNewGroup(page, groupName, screenshotDirectory, capturedScreenshots, timeoutMs = GROUP_NAME_STEP_TIMEOUT_MS) {
  groupNameFormTrace = {page, stepWait: 'none'};
  const step = (stage) => (error) => {
    groupNameFormTrace.stepWait = classifyLocatorError(error);
    failStage(stage);
  };
  currentStage = 'alice_group_name_form';
  const groupForm = page.locator(GROUP_NAME_FORM_SELECTOR);
  await groupForm.waitFor({state: 'visible', timeout: timeoutMs}).catch(step('alice_group_name_form'));
  currentStage = 'alice_group_name_screenshot';
  await captureState(page, screenshotDirectory, 'alice-group-name', capturedScreenshots).catch(step('alice_group_name_screenshot'));
  currentStage = 'alice_group_name_fill';
  await groupForm.locator(GROUP_NAME_FIELD_SELECTOR).fill(groupName, {timeout: timeoutMs}).catch(step('alice_group_name_fill'));
  currentStage = 'alice_group_name_confirm';
  // The corner button stays translated out of view until the name's input
  // event marks it visible.
  await groupForm.locator('.btn-corner.is-visible').click({timeout: timeoutMs}).catch(step('alice_group_name_confirm'));
}

const ALICE_GROUP_CREATED_STAGES = {
  chat: 'alice_group_created_chat',
  composer: 'alice_group_created',
  header: 'alice_group_created_header',
  title: 'alice_group_created_title',
  screenshot: 'alice_group_created_screenshot'
};
const BOB_GROUP_CHAT_STAGES = {
  open: 'bob_group_open',
  chat: 'bob_group_chat',
  composer: 'bob_group_chat',
  header: 'bob_group_header',
  title: 'bob_group_title',
  screenshot: 'bob_group_screenshot'
};
const BOB_GROUP_MEMBER_STAGES = [
  'bob_group_member_profile',
  'bob_group_member_tab',
  'bob_group_member_list',
  'bob_group_member_count',
  'bob_group_member_identity',
  'bob_group_member_screenshot'
];

// The group chat steps wait on the active centre-column chat only once it is
// a group: the chat the scenario opened before, still active while the group's
// chat loads, never satisfies them. Each step fails under its own stage, and a
// failure in any of them adds the group created summary.
async function waitForGroupChat(page, groupName, stages, screenshotName, screenshotDirectory, capturedScreenshots, timeoutMs, groupRow) {
  const stageNames = Object.entries(stages).map(([key, stage]) => key === 'composer' ? `${stage}_composer` : stage);
  groupCreatedTrace = {page, groupName, stages: stageNames, stepWait: 'none'};
  const step = (stage) => (error) => {
    groupCreatedTrace.stepWait = classifyLocatorError(error);
    failStage(stage);
  };
  if(groupRow) {
    currentStage = stages.open;
    await groupRow.click({timeout: timeoutMs}).catch(step(stages.open));
  }
  const activeGroup = resolveActiveGroupChat(page, groupName);
  currentStage = stages.chat;
  const groupChat = activeGroup.chat;
  await groupChat.waitFor({state: 'visible', timeout: timeoutMs}).catch(step(stages.chat));
  currentStage = `${stages.composer}_composer`;
  await openComposer(page, stages.composer, groupChat, timeoutMs).catch((error) => {
    groupCreatedTrace.stepWait = centerColumnTrace.composerWait;
    throw error;
  });
  currentStage = stages.header;
  const header = activeGroup.header;
  await header.waitFor({state: 'visible', timeout: timeoutMs}).catch(step(stages.header));
  currentStage = stages.title;
  await activeGroup.title.waitFor({state: 'visible', timeout: timeoutMs}).catch(step(stages.title));
  currentStage = stages.screenshot;
  await captureState(page, screenshotDirectory, screenshotName, capturedScreenshots).catch(step(stages.screenshot));
  return header;
}

function waitForGroupCreated(page, groupName, screenshotDirectory, capturedScreenshots, timeoutMs = GROUP_CREATED_STEP_TIMEOUT_MS) {
  return waitForGroupChat(page, groupName, ALICE_GROUP_CREATED_STAGES, 'alice-group-created', screenshotDirectory, capturedScreenshots, timeoutMs);
}

// From the click on the group's chat-list row to its title in Bob's header.
function openBobGroupChat(page, groupRow, groupName, screenshotDirectory, capturedScreenshots, timeoutMs = GROUP_CREATED_STEP_TIMEOUT_MS) {
  return waitForGroupChat(page, groupName, BOB_GROUP_CHAT_STAGES, 'bob-group-chat', screenshotDirectory, capturedScreenshots, timeoutMs, groupRow);
}

function classifyLocatorError(error) {
  if(error?.name === 'TimeoutError') return 'timeout';
  if(typeof error?.message === 'string' && error.message.includes('strict mode violation')) return 'strict_mode_violation';
  return 'other';
}

// Counts only: neither an exception message nor console text is read.
const clientErrorCounts = new WeakMap();
async function countClientErrors(page) {
  const counts = {pageErrors: 0, consoleErrors: 0};
  clientErrorCounts.set(page, counts);
  page.on('pageerror', () => counts.pageErrors++);
  page.on('console', (message) => {
    if(message.type() === 'error') counts.consoleErrors++;
  });
  await page.addInitScript(installRpcErrorCounter, {limit: RPC_ERROR_TYPE_LIMIT, pattern: RPC_ERROR_TYPE_PATTERN.source});
}

// Runs in the page before the app. Handled RPC failures reach the page as
// `result`/`ack` tasks with an `error` on the worker's MessagePort; a passive
// listener counts them and keeps only an error type that matches the fixed
// pattern, up to `limit` types. Messages, results and arguments are not read.
function installRpcErrorCounter({limit, pattern}) {
  const typePattern = new RegExp(pattern);
  const byType = new Map();
  let total = 0;
  const listened = new WeakSet();
  const record = (data) => {
    const tasks = data?.type === 'batch' && Array.isArray(data.payload) ? data.payload : [data];
    for(const task of tasks) {
      if((task?.type !== 'result' && task?.type !== 'ack') || !task.payload || !('error' in task.payload)) continue;
      total = Math.min(total + 1, 1_000_000);
      const type = task.payload.error?.type;
      if(typeof type === 'string' && typePattern.test(type) && (byType.has(type) || byType.size < limit)) {
        byType.set(type, Math.min((byType.get(type) || 0) + 1, 1_000_000));
      }
    }
  };
  const addEventListener = MessagePort.prototype.addEventListener;
  MessagePort.prototype.addEventListener = function(type, ...rest) {
    if(type === 'message' && !listened.has(this)) {
      listened.add(this);
      addEventListener.call(this, 'message', (event) => {
        try {
          record(event.data);
        } catch {}
      });
    }
    return addEventListener.call(this, type, ...rest);
  };
  Object.defineProperty(window, '__realClientRpcErrors', {
    value: () => ({total, byType: Object.fromEntries(byType)})
  });
}

// Bounded so an unresponsive page cannot hold up the scenario or its report.
async function withDeadline(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('center_column_capture_timeout')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readRpcErrorCounts(page) {
  const counts = await withDeadline(page.evaluate(() => window.__realClientRpcErrors?.()), CENTER_COLUMN_CAPTURE_TIMEOUT_MS).catch(() => undefined);
  return sanitizeRpcErrorCounts(counts);
}

function sanitizeRpcErrorCounts(counts) {
  if(!counts || !Number.isSafeInteger(counts.total) || !counts.byType || typeof counts.byType !== 'object') return undefined;
  const byType = Object.entries(counts.byType)
  .filter(([type, count]) => RPC_ERROR_TYPE_PATTERN.test(type) && Number.isSafeInteger(count) && count > 0)
  .slice(0, RPC_ERROR_TYPE_LIMIT);
  return {total: counts.total, byType: Object.fromEntries(byType)};
}

function rpcErrorsSince(before, after) {
  if(!before || !after) return {rpcErrorsSinceSelection: null, rpcErrorTypesSinceSelection: null};
  const types = Object.entries(after.byType)
  .map(([type, count]) => [type, count - (before.byType[type] || 0)])
  .filter(([, count]) => count > 0);
  return {
    rpcErrorsSinceSelection: Math.max(after.total - before.total, 0),
    rpcErrorTypesSinceSelection: Object.fromEntries(types)
  };
}

// Runs in the page. Reads fixed selectors, classes and the composer's
// editability; a bottom-bar label is only compared against the fixed table.
function centerColumnProbe({composerSelector, controlBarLabels}) {
  const center = document.getElementById('column-center');
  const isVisible = (element) => {
    if(!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const chats = center ? Array.from(center.querySelectorAll('.chat')) : [];
  const active = chats.filter((chat) => chat.classList.contains('active'));
  const chat = active.length === 1 ? active[0] : undefined;
  const peerId = chat?.querySelector('.topbar .avatar[data-peer-id]')?.getAttribute('data-peer-id') || '';
  const inputs = chat ? Array.from(chat.querySelectorAll('.input-message-input:not(.input-field-input-fake)')) : [];
  const chatInput = chat?.querySelector('.chat-input');
  const buttons = chat ? Array.from(chat.querySelectorAll('.chat-input-control-button')).filter(isVisible) : [];
  let controlBar = 'none';
  if(buttons.length > 1) {
    controlBar = 'multiple';
  } else if(buttons.length === 1) {
    const label = (buttons[0].textContent || '').trim();
    controlBar = buttons[0].querySelector('.chat-input-frozen-text') ? 'frozen' :
      Object.prototype.hasOwnProperty.call(controlBarLabels, label) ? controlBarLabels[label] : 'other';
  }
  return {
    chatCount: chats.length,
    activeChatCount: active.length,
    activePeerId: /^-?[0-9]{1,20}$/.test(peerId) ? peerId : null,
    composerMatches: center ? center.querySelectorAll(composerSelector).length : 0,
    composerInputs: inputs.length,
    composerFakeInputs: chat ? chat.querySelectorAll('.input-field-input-fake').length : 0,
    composerVisible: inputs.filter(isVisible).length,
    composerEditable: inputs.filter((input) => input.isContentEditable).length,
    chatInput: !chatInput ? 'absent' : chatInput.classList.contains('is-hidden') || !isVisible(chatInput) ? 'hidden' : 'visible',
    controlBar
  };
}

// Written only when a message or group stage fails: what the centre column
// showed, how the composer wait ended, and the client errors since selection.
async function captureCenterColumnState(trace = centerColumnTrace, timeoutMs = CENTER_COLUMN_CAPTURE_TIMEOUT_MS) {
  if(!trace.page) return 'unavailable';
  try {
    // One deadline covers both page reads.
    const [probe, rpc] = await withDeadline(Promise.all([
      trace.page.evaluate(centerColumnProbe, {composerSelector: COMPOSER_SELECTOR, controlBarLabels: CONTROL_BAR_LABELS}),
      trace.page.evaluate(() => window.__realClientRpcErrors?.()).catch(() => undefined)
    ]), timeoutMs);
    const counts = clientErrorCounts.get(trace.page);
    const since = (key) => counts && trace.errorsAtSelection ? counts[key] - trace.errorsAtSelection[key] : null;
    return {
      ...probe,
      selectedPeerId: /^-?[0-9]{1,20}$/.test(trace.selectedPeerId || '') ? trace.selectedPeerId : null,
      composerWait: trace.composerWait,
      pageErrorsSinceSelection: since('pageErrors'),
      consoleErrorsSinceSelection: since('consoleErrors'),
      ...rpcErrorsSince(trace.errorsAtSelection?.rpc, sanitizeRpcErrorCounts(rpc))
    };
  } catch {
    return 'unavailable';
  }
}

// Runs in the page. Counts and booleans only: the name field's content is
// reduced to whether it holds anything.
function groupNameFormProbe({formSelector, nameFieldSelector}) {
  const isVisible = (element) => {
    if(!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const forms = Array.from(document.querySelectorAll(formSelector));
  const form = forms.length === 1 ? forms[0] : undefined;
  const nameFields = form ? Array.from(form.querySelectorAll(nameFieldSelector)) : [];
  const confirms = form ? Array.from(form.querySelectorAll('.btn-corner')) : [];
  const confirm = confirms.length === 1 ? confirms[0] : undefined;
  return {
    formCount: forms.length,
    formVisible: isVisible(form),
    visibleInputs: form ? Array.from(form.querySelectorAll('input')).filter(isVisible).length : 0,
    visibleEditables: form ? Array.from(form.querySelectorAll('[contenteditable="true"]')).filter(isVisible).length : 0,
    nameFieldMatches: nameFields.length,
    nameFieldVisible: nameFields.filter(isVisible).length,
    nameHasValue: nameFields.length === 1 && (nameFields[0].textContent || '').trim().length > 0,
    confirmCount: confirms.length,
    confirmShown: !!confirm && confirm.classList.contains('is-visible') && isVisible(confirm),
    confirmEnabled: !!confirm && !confirm.hasAttribute('disabled')
  };
}

// Written only when a group-name step fails, next to the centre-column summary.
async function captureGroupNameFormState(trace = groupNameFormTrace, timeoutMs = CENTER_COLUMN_CAPTURE_TIMEOUT_MS) {
  if(!trace.page) return 'unavailable';
  try {
    const probe = await withDeadline(trace.page.evaluate(groupNameFormProbe, {
      formSelector: GROUP_NAME_FORM_SELECTOR,
      nameFieldSelector: GROUP_NAME_FIELD_SELECTOR
    }), timeoutMs);
    return {...probe, stepWait: trace.stepWait};
  } catch {
    return 'unavailable';
  }
}

// Runs in the page. Counts and booleans only: the group name is compared
// against the active chat's header here and never returned. Inactive chats
// stay rendered and are hidden by opacity, so only the active one counts.
function groupCreatedProbe({groupName}) {
  const isVisible = (element) => {
    if(!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const center = document.getElementById('column-center');
  const chats = center ? Array.from(center.querySelectorAll('.chat')) : [];
  const active = chats.filter((chat) => chat.classList.contains('active'));
  const chat = active.length === 1 ? active[0] : undefined;
  const peerId = chat?.querySelector('.topbar .avatar[data-peer-id]')?.getAttribute('data-peer-id') || '';
  const headers = chat ? Array.from(chat.querySelectorAll('.topbar .chat-info')) : [];
  return {
    activeChat: !/^-?[0-9]{1,20}$/.test(peerId) ? 'none' : peerId.startsWith('-') ? 'group' : 'user',
    chatCount: chats.length,
    groupHeaderVisible: !!groupName && headers.some((header) => isVisible(header) && (header.textContent || '').includes(groupName))
  };
}

// Written only when a group-created step fails, next to the centre-column summary.
async function captureGroupCreatedState(trace = groupCreatedTrace, timeoutMs = CENTER_COLUMN_CAPTURE_TIMEOUT_MS) {
  if(!trace.page) return 'unavailable';
  try {
    const probe = await withDeadline(trace.page.evaluate(groupCreatedProbe, {groupName: trace.groupName}), timeoutMs);
    return {...probe, stepWait: trace.stepWait};
  } catch {
    return 'unavailable';
  }
}

function channelMembershipProbe({channelName, peerId}) {
  const rows = Array.from(document.querySelectorAll('#chatlist-container .chatlist-chat'));
  const peerRows = rows.filter((row) => row.getAttribute('data-peer-id') === peerId);
  const titleRows = rows.filter((row) => (row.textContent || '').includes(channelName));
  const activeChats = Array.from(document.querySelectorAll('#column-center .chat.active'));
  const activePeerId = activeChats.length === 1 ?
    activeChats[0].querySelector('.topbar .avatar[data-peer-id]')?.getAttribute('data-peer-id') :
    undefined;

  return {
    chatListRowCount: rows.length,
    peerRowCount: peerRows.length,
    titleRowCount: titleRows.length,
    peerRowHasTitle: peerRows.some((row) => (row.textContent || '').includes(channelName)),
    activePeerMatches: activePeerId === peerId
  };
}

async function captureChannelMembershipState(trace = channelMembershipTrace, timeoutMs = CENTER_COLUMN_CAPTURE_TIMEOUT_MS) {
  if(!trace.page) return 'unavailable';
  try {
    const probe = await withDeadline(trace.page.evaluate(channelMembershipProbe, {
      channelName: trace.channelName,
      peerId: trace.peerId
    }), timeoutMs);
    return {...probe, stepWait: trace.stepWait};
  } catch {
    return 'unavailable';
  }
}

// Reads only the active right-column panel. Member peer ids stay in the page
// interaction and are never included in diagnostic state.
function groupMemberProbe({groupPeerId}) {
  const isVisible = (element) => {
    if(!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const column = document.getElementById('column-right');
  const panels = document.body.classList.contains('is-right-column-shown') && column
    ? Array.from(column.querySelectorAll('.sidebar-slider > .sidebar-slider-item.active')).filter(isVisible)
    : [];
  const panel = panels.length === 1 ? panels[0] : undefined;
  const profile = panel?.querySelector('.profile-content');
  const activeProfileAvatars = profile ? Array.from(profile.querySelectorAll('.profile-avatars-avatars > .profile-avatars-avatar.active > .avatar[data-peer-id]')) : [];
  const profileMatchesActiveGroup = activeProfileAvatars.some((avatar) => avatar.getAttribute('data-peer-id') === groupPeerId && isVisible(avatar));
  const mediaTabs = panel?.querySelector('.search-super-tabs-container');
  const mediaPanels = mediaTabs ? Array.from(mediaTabs.children) : [];
  const membersPanel = mediaPanels.find((mediaPanel) => mediaPanel.classList.contains('search-super-container-members'));
  const membersPanelIndex = membersPanel ? mediaPanels.indexOf(membersPanel) : -1;
  const menuTabs = panel?.querySelectorAll('.search-super-tabs .menu-horizontal-div-item');
  const membersTabExists = Boolean(membersPanel && membersPanelIndex >= 0 && menuTabs?.[membersPanelIndex]);
  const membersList = membersPanel?.querySelector('.chatlist');
  const membersPanelActive = Boolean(membersPanel?.classList.contains('active') && isVisible(membersPanel));
  const activeMediaPanel = mediaPanels.find((mediaPanel) => mediaPanel.classList.contains('active') && isVisible(mediaPanel));

  let activePanel = 'none';
  if(panels.length > 1) {
    activePanel = 'other';
  } else if(panel) {
    if(membersPanelActive) {
      activePanel = 'members';
    } else if(profile) {
      activePanel = !activeMediaPanel ? 'profile' : activeMediaPanel.classList.contains('search-super-container-media') ? 'media' : 'other';
    } else if(panel.querySelector('.edit-peer-container')) {
      activePanel = 'edit';
    } else {
      activePanel = 'other';
    }
  }

  return {
    activePanel,
    profileMatchesActiveGroup,
    membersTabExists,
    membersListExists: Boolean(membersList),
    memberRowCount: membersPanelActive ? membersPanel.querySelectorAll('.chatlist-chat[data-peer-id]').length : 0
  };
}

async function captureGroupMemberState(trace = groupMemberTrace, timeoutMs = CENTER_COLUMN_CAPTURE_TIMEOUT_MS) {
  if(!trace.page) return 'unavailable';
  try {
    const [probe, rpc] = await withDeadline(Promise.all([
      trace.page.evaluate(groupMemberProbe, {groupPeerId: trace.groupPeerId}),
      trace.page.evaluate(() => window.__realClientRpcErrors?.()).catch(() => undefined)
    ]), timeoutMs);
    const counts = clientErrorCounts.get(trace.page);
    const since = (key) => counts && trace.errorsAtStep ? Math.max(counts[key] - trace.errorsAtStep[key], 0) : null;
    const rpcCounts = sanitizeRpcErrorCounts(rpc);
    const rpcErrorsSinceStep = trace.errorsAtStep?.rpc && rpcCounts
      ? Math.max(rpcCounts.total - trace.errorsAtStep.rpc.total, 0)
      : null;
    return {
      ...probe,
      membersTab: trace.membersTab,
      pageErrorsSinceStep: since('pageErrors'),
      consoleErrorsSinceStep: since('consoleErrors'),
      rpcErrorsSinceStep,
      stepWait: trace.stepWait
    };
  } catch {
    return 'unavailable';
  }
}

function failGroupMessageStep(stage, error) {
  groupCreatedTrace.stepWait = error ? classifyLocatorError(error) : 'other';
  failStage(stage);
}

async function startGroupMessageTrace(page, stage) {
  const counts = clientErrorCounts.get(page);
  groupMessageTrace = {
    ...createGroupMessageTrace(),
    page,
    stage,
    errorsAtStep: counts ? {...counts, rpc: await readRpcErrorCounts(page)} : undefined
  };
}

function groupMessageSampleResult(sample) {
  if(sample.count === 0) return 'disappeared';
  if(sample.bubbles.some((bubble) => !bubble.messageId)) return 'missing_message_id';
  if(sample.bubbles.some((bubble) => bubble.sendState === 'failed')) return 'failed_bubble';
  if(sample.distinctServerIds) return 'multiple_ids';
  if(sample.count === 1) return sample.bubbles[0].sendState === 'pending' ? 'pending' : 'sent';
  if(sample.count === 2 && new Set(sample.bubbles.map((bubble) => bubble.sendState)).size === 2 &&
      sample.bubbles.some((bubble) => bubble.sendState === 'pending') &&
      sample.bubbles.some((bubble) => bubble.sendState === 'sent')) {
    return 'transient_pair';
  }
  return 'duplicate_bubbles';
}

async function waitForGroupMessageCount(page, chat, groupTitle, message, stage, timeoutMs = GROUP_CREATED_STEP_TIMEOUT_MS) {
  currentStage = stage;
  if(groupMessageTrace.page !== page || groupMessageTrace.stage !== stage) {
    await startGroupMessageTrace(page, stage);
  }

  const deadline = Date.now() + Math.min(timeoutMs, GROUP_MESSAGE_SETTLE_TIMEOUT_MS);
  let stableSince;
  let lastResult = 'pending';
  while(Date.now() <= deadline) {
    let sample;
    try {
      const [chatCount, titleCount] = await Promise.all([chat.count(), groupTitle.count()]);
      sample = chatCount !== 1 || titleCount !== 1 ? {count: 0, bubbles: [], distinctIds: false, distinctServerIds: false} : await message.evaluateAll((elements) => {
        const bubbles = elements.map((element) => {
          const bubble = element.closest('.bubble');
          const id = bubble?.getAttribute('data-mid') || '';
          const sendState = bubble?.classList.contains('is-error') ? 'failed' :
            bubble?.classList.contains('is-sending') ? 'pending' : 'sent';
          return {
            messageId: /^-?[0-9]{1,20}(\.[0-9]{1,4})?$/.test(id) ? id : null,
            sendState
          };
        });
        // Pending bubbles can retain a temporary negative id beside their sent server-id copy.
        const serverIds = bubbles.filter((bubble) => bubble.sendState === 'sent').map((bubble) => bubble.messageId).filter(Boolean);
        return {
          count: bubbles.length,
          bubbles,
          distinctIds: new Set(bubbles.map((bubble) => bubble.messageId).filter(Boolean)).size > 1,
          distinctServerIds: new Set(serverIds).size > 1
        };
      });
    } catch(error) {
      groupMessageTrace.result = 'read_error';
      failGroupMessageStep(stage, error);
    }
    groupMessageTrace.samples.push(sample);
    lastResult = groupMessageSampleResult(sample);
    if(['disappeared', 'missing_message_id', 'failed_bubble', 'multiple_ids', 'duplicate_bubbles'].includes(lastResult)) {
      groupMessageTrace.result = lastResult;
      failGroupMessageStep(stage);
    }
    if(lastResult === 'sent') {
      if(stableSince === undefined) stableSince = Date.now();
      else if(Date.now() - stableSince >= GROUP_MESSAGE_STABLE_WINDOW_MS) {
        groupMessageTrace.result = 'settled';
        return;
      }
    } else {
      stableSince = undefined;
    }

    const remaining = deadline - Date.now();
    if(remaining <= 0) break;
    try {
      await page.waitForTimeout(Math.min(GROUP_MESSAGE_SAMPLE_INTERVAL_MS, remaining));
    } catch(error) {
      groupMessageTrace.result = 'read_error';
      failGroupMessageStep(stage, error);
    }
  }

  groupMessageTrace.result = lastResult === 'pending' || lastResult === 'transient_pair' ? 'settle_timeout' : 'stability_timeout';
  failGroupMessageStep(stage);
}

async function captureGroupMessageState(trace = groupMessageTrace) {
  if(!trace.page) return 'unavailable';
  try {
    const rpc = await readRpcErrorCounts(trace.page);
    const counts = clientErrorCounts.get(trace.page);
    const since = (key) => counts && trace.errorsAtStep ? Math.max(counts[key] - trace.errorsAtStep[key], 0) : null;
    const rpcErrorsSinceStep = trace.errorsAtStep?.rpc && rpc ? Math.max(rpc.total - trace.errorsAtStep.rpc.total, 0) : null;
    return {
      samples: trace.samples,
      distinctIds: trace.samples.some((sample) => sample.distinctIds),
      distinctServerIds: trace.samples.some((sample) => sample.distinctServerIds),
      pageErrorsSinceStep: since('pageErrors'),
      consoleErrorsSinceStep: since('consoleErrors'),
      rpcErrorsSinceStep,
      result: trace.result
    };
  } catch{
    return 'unavailable';
  }
}

function resolveActiveGroupChat(page, groupName) {
  const activeChats = page.locator('#column-center .chat.active');
  const chat = activeChats.filter({has: page.locator(GROUP_CHAT_SELECTOR)});
  const header = chat.locator('.topbar .chat-info');
  return {activeChats, chat, header, title: header.filter({hasText: groupName})};
}

async function sendText(page, text, stage, chat, timeoutMs = 30_000, groupTitle) {
  currentStage = stage;
  const input = chat ? await openComposer(page, stage, chat, timeoutMs) : await openComposer(page, stage);
  if(chat) {
    currentStage = `${stage}_fill`;
    await input.fill(text, {timeout: timeoutMs}).catch((error) => failGroupMessageStep(`${stage}_fill`, error));
    currentStage = `${stage}_send`;
    await input.press('Enter', {timeout: timeoutMs}).catch((error) => failGroupMessageStep(`${stage}_send`, error));
  } else {
    await input.fill(text);
    await input.press('Enter');
  }
  const message = (chat ? chat.locator('.bubble .message') : page.locator('#column-center .bubble .message')).filter({hasText: text});
  currentStage = chat ? `${stage}_visible_message` : stage;
  await message.first().waitFor({state: 'visible', timeout: chat ? timeoutMs : 30_000}).catch((error) => {
    if(chat) failGroupMessageStep(`${stage}_visible_message`, error);
    failStage(`${stage}_visible_message`);
  });
  if(chat) {
    await waitForGroupMessageCount(page, chat, groupTitle, message, `${stage}_message_count`, timeoutMs);
  } else {
    await page.waitForTimeout(600);
    currentStage = stage;
    const count = await message.count();
    if(count !== 1) failStage(`${stage}_message_count`);
  }
}

async function sendGroupText(page, text, groupName, stage, timeoutMs = 30_000) {
  const messageStages = [
    `${stage}_chat`,
    `${stage}_composer`,
    `${stage}_fill`,
    `${stage}_send`,
    `${stage}_visible_message`,
    `${stage}_message_count`
  ];
  groupCreatedTrace = {page, groupName, stages: messageStages, stepWait: 'none'};
  centerColumnTrace = {...createCenterColumnTrace(), page};
  const activeGroup = resolveActiveGroupChat(page, groupName);

  const failChat = (error) => {
    groupCreatedTrace.stepWait = classifyLocatorError(error);
    failStage(`${stage}_chat`);
  };
  currentStage = `${stage}_chat`;
  const activeChats = activeGroup.activeChats;
  await activeChats.first().waitFor({state: 'visible', timeout: timeoutMs}).catch(failChat);
  if(await activeChats.count() !== 1) failGroupMessageStep(`${stage}_chat`);

  const activeGroupChat = activeGroup.chat;
  await activeGroupChat.first().waitFor({state: 'visible', timeout: timeoutMs}).catch(failChat);
  if(await activeGroupChat.count() !== 1) failGroupMessageStep(`${stage}_chat`);

  const groupHeader = activeGroup.title;
  await groupHeader.first().waitFor({state: 'visible', timeout: timeoutMs}).catch(failChat);
  if(await groupHeader.count() !== 1) failGroupMessageStep(`${stage}_chat`);

  const peerId = await activeGroupChat.locator('.topbar .avatar[data-peer-id]').getAttribute('data-peer-id');
  if(!/^-?[0-9]{1,20}$/.test(peerId || '') || !peerId.startsWith('-')) failGroupMessageStep(`${stage}_chat`);
  centerColumnTrace.selectedPeerId = peerId;
  centerColumnTrace.errorsAtSelection = {
    ...clientErrorCounts.get(page),
    rpc: await readRpcErrorCounts(page)
  };
  await startGroupMessageTrace(page, `${stage}_message_count`);

  try {
    await sendText(page, text, stage, activeGroupChat, timeoutMs, activeGroup.title);
  } catch(error) {
    if(groupCreatedTrace.stepWait === 'none') {
      groupCreatedTrace.stepWait = centerColumnTrace.composerWait === 'none'
        ? classifyLocatorError(error)
        : centerColumnTrace.composerWait;
    }
    throw error;
  }
  currentStage = stage;
}

function failGroupMemberStep(stage, error) {
  groupMemberTrace.stepWait = error ? classifyLocatorError(error) : 'other';
  failStage(stage);
}

function safeActionabilityElement(markup) {
  const openingTag = typeof markup === 'string' ? markup.match(/^<([a-z][a-z0-9-]*)\b([^>]*)>/i) : undefined;
  const tag = openingTag?.[1]?.toLowerCase();
  if(!tag) return null;
  const className = openingTag[2].match(/\bclass=(['"])(.*?)\1/i)?.[2] || '';
  const classes = className.split(/\s+/).filter((name) => /^[A-Za-z0-9_-]{1,80}$/.test(name)).slice(0, 16);
  return {tag, classes};
}

function readMembersTabActionability(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const plainMessage = message.replace(/\u001b\[[0-9;]*m/g, '');
  const interception = plainMessage.match(/(?:^|\n)[ \t]*(?:-[ \t]*)?(<[a-z][^>]*>(?:.*?<\/[a-z][^>]*>)?)(?: from <[a-z][^>]*>(?:.*?<\/[a-z][^>]*>)? subtree)? intercepts pointer events/im);
  if(interception) {
    return {reason: 'intercepted', interceptedBy: safeActionabilityElement(interception[1])};
  }
  if(/element is not stable/i.test(message)) return {reason: 'not_stable', interceptedBy: null};
  if(/element is not visible/i.test(message)) return {reason: 'not_visible', interceptedBy: null};
  if(/element is not enabled/i.test(message)) return {reason: 'not_enabled', interceptedBy: null};
  if(/element was detached|not attached to the DOM/i.test(message)) return {reason: 'not_attached', interceptedBy: null};
  if(/outside of the viewport/i.test(message)) return {reason: 'outside_viewport', interceptedBy: null};
  if(error?.name === 'TimeoutError') return {reason: 'timeout', interceptedBy: null};
  return {reason: 'other', interceptedBy: null};
}

async function readMembersPanelActive(membersPanel) {
  return membersPanel.evaluate((panel) => {
    const style = window.getComputedStyle(panel);
    return panel.classList.contains('active') && style.display !== 'none' && style.visibility !== 'hidden' && panel.getClientRects().length > 0;
  });
}

async function waitForMembers(page, memberRows, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    try {
      if(await memberRows.count() >= 2) return;
    } catch(error) {
      failGroupMemberStep('bob_group_member_count', error);
    }
    await page.waitForTimeout(100);
  }
  failGroupMemberStep('bob_group_member_count');
}

async function openBobGroupMembers(page, groupHeader, groupName, selectedBobPeerId, screenshotDirectory, capturedScreenshots, timeoutMs = 20_000) {
  groupMemberTrace = {
    ...createGroupMemberTrace(),
    page,
    stages: BOB_GROUP_MEMBER_STAGES
  };
  const errorCounts = clientErrorCounts.get(page);
  groupMemberTrace.errorsAtStep = errorCounts ? {
    ...errorCounts,
    rpc: await readRpcErrorCounts(page)
  } : undefined;

  currentStage = 'bob_group_member_profile';
  const activeGroup = resolveActiveGroupChat(page, groupName);
  try {
    if(await activeGroup.activeChats.count() !== 1 || await activeGroup.chat.count() !== 1 || await activeGroup.header.count() !== 1 ||
        await activeGroup.title.count() !== 1 || await groupHeader.count() !== 1) {
      failGroupMemberStep('bob_group_member_profile');
    }
    groupMemberTrace.groupPeerId = await activeGroup.chat.locator('.topbar .avatar[data-peer-id]').getAttribute('data-peer-id');
    if(await groupHeader.locator('.avatar[data-peer-id]').getAttribute('data-peer-id') !== groupMemberTrace.groupPeerId) {
      failGroupMemberStep('bob_group_member_profile');
    }
  } catch(error) {
    if(error?.message === 'bob_group_member_profile') throw error;
    failGroupMemberStep('bob_group_member_profile', error);
  }
  if(!/^-?[0-9]{1,20}$/.test(groupMemberTrace.groupPeerId || '') || !groupMemberTrace.groupPeerId.startsWith('-')) {
    failGroupMemberStep('bob_group_member_profile');
  }

  await groupHeader.click({timeout: timeoutMs}).catch((error) => failGroupMemberStep('bob_group_member_profile', error));
  const activeRightPanel = page.locator('body.is-right-column-shown #column-right .sidebar-slider > .sidebar-slider-item.active');
  const activeGroupProfileAvatar = activeRightPanel.locator(`.profile-content .profile-avatars-avatars > .profile-avatars-avatar.active > .avatar[data-peer-id="${groupMemberTrace.groupPeerId}"]`);
  await activeGroupProfileAvatar.waitFor({state: 'visible', timeout: timeoutMs}).catch((error) => failGroupMemberStep('bob_group_member_profile', error));

  currentStage = 'bob_group_member_tab';
  const membersPanel = activeRightPanel.locator('.search-super-tabs-container > .search-super-container-members');
  const membersPanelCount = await membersPanel.count();
  if(membersPanelCount !== 1) {
    groupMemberTrace.membersTab.panelActiveBefore = membersPanelCount === 0 ? false : null;
    groupMemberTrace.membersTab.panelActiveAfter = groupMemberTrace.membersTab.panelActiveBefore;
    groupMemberTrace.membersTab.paired = false;
    failGroupMemberStep('bob_group_member_tab');
  }

  try {
    groupMemberTrace.membersTab.panelActiveBefore = await readMembersPanelActive(membersPanel);
  } catch(error) {
    failGroupMemberStep('bob_group_member_tab', error);
  }

  if(groupMemberTrace.membersTab.panelActiveBefore) {
    groupMemberTrace.membersTab.panelActiveAfter = true;
  } else {
    let membersPanelIndex;
    let mediaPanelCount;
    let membersTabCount;
    const membersTabs = activeRightPanel.locator('.search-super-tabs > .menu-horizontal-div-item');
    try {
      membersPanelIndex = await membersPanel.evaluate((panel) => Array.prototype.indexOf.call(panel.parentElement.children, panel));
      mediaPanelCount = await activeRightPanel.locator('.search-super-tabs-container > .search-super-tab-container').count();
      membersTabCount = await membersTabs.count();
    } catch(error) {
      failGroupMemberStep('bob_group_member_tab', error);
    }
    const membersTab = membersTabs.nth(membersPanelIndex);
    const tabExists = membersPanelIndex >= 0 && membersPanelIndex < membersTabCount;
    if(tabExists) {
      try {
        const target = await membersTab.evaluate((tab, index) => ({
          index,
          tag: tab.tagName.toLowerCase(),
          classes: Array.from(tab.classList).filter((name) => /^[A-Za-z0-9_-]{1,80}$/.test(name)).slice(0, 16)
        }), membersPanelIndex);
        groupMemberTrace.membersTab.target = target;
      } catch(error) {
        failGroupMemberStep('bob_group_member_tab', error);
      }
    }
    groupMemberTrace.membersTab.paired = tabExists && membersPanelIndex < mediaPanelCount && mediaPanelCount === membersTabCount;
    const membersTabVisible = groupMemberTrace.membersTab.paired && await membersTab.isVisible();
    if(!groupMemberTrace.membersTab.paired || !membersTabVisible) {
      if(groupMemberTrace.membersTab.paired) groupMemberTrace.membersTab.actionabilityReason = 'not_visible';
      groupMemberTrace.membersTab.panelActiveAfter = await readMembersPanelActive(membersPanel).catch(() => null);
      failGroupMemberStep('bob_group_member_tab');
    }

    try {
      await membersTab.click({timeout: timeoutMs});
    } catch(error) {
      const actionability = readMembersTabActionability(error);
      groupMemberTrace.membersTab.actionabilityReason = actionability.reason;
      groupMemberTrace.membersTab.interceptedBy = actionability.interceptedBy;
      groupMemberTrace.membersTab.panelActiveAfter = await readMembersPanelActive(membersPanel).catch(() => null);
      failGroupMemberStep('bob_group_member_tab', error);
    }

    const activeMembersPanel = activeRightPanel.locator('.search-super-tabs-container > .search-super-container-members.active');
    await activeMembersPanel.waitFor({state: 'visible', timeout: timeoutMs}).catch(async(error) => {
      groupMemberTrace.membersTab.panelActiveAfter = await readMembersPanelActive(membersPanel).catch(() => null);
      failGroupMemberStep('bob_group_member_tab', error);
    });
    groupMemberTrace.membersTab.panelActiveAfter = true;
  }

  currentStage = 'bob_group_member_list';
  const activeMembersPanel = activeRightPanel.locator('.search-super-tabs-container > .search-super-container-members.active');
  await activeMembersPanel.waitFor({state: 'visible', timeout: timeoutMs}).catch((error) => failGroupMemberStep('bob_group_member_list', error));
  const memberList = activeMembersPanel.locator('.chatlist');
  await memberList.waitFor({state: 'visible', timeout: timeoutMs}).catch((error) => failGroupMemberStep('bob_group_member_list', error));
  const memberRows = memberList.locator('.chatlist-chat[data-peer-id]');

  currentStage = 'bob_group_member_count';
  await waitForMembers(page, memberRows, timeoutMs);

  currentStage = 'bob_group_member_identity';
  let memberPeerIds;
  try {
    memberPeerIds = await memberRows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-peer-id')));
  } catch(error) {
    failGroupMemberStep('bob_group_member_identity', error);
  }
  if(memberPeerIds.length !== 2 || !memberPeerIds.every((peerId) => /^[0-9]{1,20}$/.test(peerId || '')) ||
      !/^[0-9]{1,20}$/.test(selectedBobPeerId || '') || !memberPeerIds.includes(selectedBobPeerId)) {
    failGroupMemberStep('bob_group_member_identity');
  }

  currentStage = 'bob_group_member_screenshot';
  await captureState(page, screenshotDirectory, 'bob-group-members', capturedScreenshots)
  .catch((error) => failGroupMemberStep('bob_group_member_screenshot', error));
}

// The accepted fixture's synthetic controls, run before any app context exists.
// Each control owns its own browser context, so its targets never enter app
// counts, and any mismatch stops the run before the app scenarios start.
async function runObserverControls(browser, registry, cleanupIssues, webSocket101Phase) {
  const controls = {};
  const failedControls = [];
  const webSocket101Observers = [];
  const observeWebSocket101 = Boolean(webSocket101Phase);
  for(const plan of CONTROL_PLAN) {
    const context = await browser.newContext({viewport: {width: 1280, height: 900}});
    const observer = observation.createContextObserver(plan.name, {control: true, observeWebSocket101, webSocket101Phase});
    if(observeWebSocket101) webSocket101Observers.push(observer);
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
      await Promise.all([networkObserver.waitForSetup(), registry.waitForSetup()]);
      observer.state.windowElapsed = true;
      const block = observer.summary();
      controls[plan.name] = {...block, expected: observation.evaluateControl(plan.name, block)};
      if(controls[plan.name].expected === 'fail') failedControls.push(plan.name);
    } catch {
      await Promise.all([networkObserver?.waitForSetup(), registry.waitForSetup()]);
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
  return {
    controls,
    failedControls,
    ...(observeWebSocket101 ? {websocket101ByContextPhase: mergeWebSocket101ByContextPhase(
      webSocket101Observers.map((observer) => observer.webSocket101ByContextPhase())
    )} : {})
  };
}

function summarizeEgress(observers) {
  const summaries = observers.map((observer) => observer.summary());
  return {
    unexpectedAttempts: summaries.reduce((sum, summary) => sum + summary.unexpectedAttempts, 0),
    observerErrors: summaries.reduce((sum, summary) => sum + summary.observerErrors, 0)
  };
}

function pageErrorConstructorName(error) {
  let name;
  try {
    name = error?.name;
  } catch {
    name = undefined;
  }
  if(PAGE_ERROR_CONSTRUCTORS.has(name)) return name;
  try {
    name = error?.constructor?.name;
  } catch {
    return 'Error';
  }
  return PAGE_ERROR_CONSTRUCTORS.has(name) ? name : 'Error';
}

function pageErrorScriptAsset(stack, blobAssets = new Map(), resolveBlobAsset) {
  if(typeof stack !== 'string') return 'unknown';
  for(const line of stack.split('\n').slice(1)) {
    const match = /(?:\(|\s)(https?:\/\/[^\s)]+|blob:[^\s)]+)/.exec(line);
    if(!match) continue;
    const candidate = match[1].replace(/:\d+(?::\d+)?$/, '');
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if(!['http:', 'https:', 'blob:'].includes(parsed.protocol)) continue;
    if(parsed.protocol === 'blob:') {
      const mappedAsset = blobAssets.get(parsed.href);
      if(typeof mappedAsset === 'string' && observation.SCRIPT_ASSET_PATTERN.test(mappedAsset)) return mappedAsset;
      if(parsed.origin === PRIVATE_CSP_ORIGIN && typeof resolveBlobAsset === 'function') {
        const resolvedAsset = resolveBlobAsset(stack);
        if(typeof resolvedAsset === 'string' && observation.SCRIPT_ASSET_PATTERN.test(resolvedAsset)) {
          blobAssets.set(parsed.href, resolvedAsset);
          return resolvedAsset;
        }
      }
      continue;
    }
    const asset = path.posix.basename(parsed.pathname);
    if(observation.SCRIPT_ASSET_PATTERN.test(asset)) return asset;
  }
  return 'unknown';
}

function createPageErrorAssetResolver() {
  const blobAssets = new Map();
  const workerAssetCandidates = [];
  const directWorkerAssets = new Map();
  const workerBlobUrls = new Map();
  function pageErrorWorkerAsset(stack) {
    const hint = PAGE_ERROR_BLOB_ASSET_HINTS.find(({pattern}) => pattern.test(stack));
    const matchingCandidates = workerAssetCandidates.filter((candidate) =>
      hint ? candidate.workerLabel === hint.workerLabel : Date.now() - candidate.observedAt <= 30_000
    );
    // A specific stack hint narrows lifetime evidence; otherwise require a fresh fetch.
    const assets = new Set(matchingCandidates.map((candidate) => candidate.asset));
    return assets.size === 1 ? assets.values().next().value : undefined;
  }
  function takeWorkerAssetCandidate(sourceTargetId) {
    const sourceCandidates = typeof sourceTargetId === 'string'
      ? workerAssetCandidates.filter((candidate) => candidate.sourceTargetId === sourceTargetId)
      : [];
    const sourceCorrelated = sourceCandidates.length > 0;
    const candidates = sourceCorrelated ? sourceCandidates : workerAssetCandidates.filter((candidate) =>
      !candidate.consumed && Date.now() - candidate.observedAt <= 30_000
    );
    const assets = new Set(candidates.map((candidate) => candidate.asset));
    if(assets.size !== 1) return;
    const source = candidates[0];
    if(!sourceCorrelated) source.consumed = true;
    return source;
  }
  function workerAsset(targetId) {
    const directAsset = directWorkerAssets.get(targetId)?.asset;
    if(directAsset) return directAsset;
    const blobUrl = workerBlobUrls.get(targetId);
    return blobUrl ? blobAssets.get(blobUrl) : undefined;
  }
  return {
    observeRequest(url, _initiator, requestType, sourceTargetId, sourceType = 'page') {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if(parsed.protocol !== 'blob:') {
        const workerLabel = observation.labelForPathname(parsed.pathname);
        const asset = path.posix.basename(parsed.pathname);
        if(parsed.origin === PRIVATE_CSP_ORIGIN && workerLabel && workerLabel !== 'service_worker' && !workerLabel.startsWith('probe_')) {
          if(sourceType !== 'page' && typeof sourceTargetId === 'string' && observation.SCRIPT_ASSET_PATTERN.test(asset)) {
            if(directWorkerAssets.size >= PAGE_ERROR_BLOB_ASSET_LIMIT && !directWorkerAssets.has(sourceTargetId)) {
              directWorkerAssets.delete(directWorkerAssets.keys().next().value);
            }
            directWorkerAssets.set(sourceTargetId, {asset, observedAt: Date.now()});
            const targetBlobUrl = workerBlobUrls.get(sourceTargetId);
            if(targetBlobUrl) blobAssets.set(targetBlobUrl, asset);
          }
          if(requestType === 'Fetch' && typeof sourceTargetId === 'string' && observation.SCRIPT_ASSET_PATTERN.test(asset)) {
            if(workerAssetCandidates.length >= PAGE_ERROR_BLOB_ASSET_LIMIT) workerAssetCandidates.shift();
            workerAssetCandidates.push({sourceTargetId, asset, workerLabel, observedAt: Date.now(), consumed: false});
          }
        }
        return;
      }
      if(parsed.origin !== PRIVATE_CSP_ORIGIN || blobAssets.has(parsed.href)) return;
      const directWorkerAsset = sourceType !== 'page' && directWorkerAssets.get(sourceTargetId)?.asset;
      const fetchedWorkerAsset = !directWorkerAsset && requestType === 'Script' ? takeWorkerAssetCandidate(sourceTargetId)?.asset : undefined;
      // Initiator frames identify the loader, not the script stored in the blob.
      const asset = directWorkerAsset || fetchedWorkerAsset;
      if(!asset || blobAssets.size >= PAGE_ERROR_BLOB_ASSET_LIMIT) return;
      blobAssets.set(parsed.href, asset);
    },
    observeWorkerTarget(targetInfo) {
      const targetType = targetInfo?.type;
      const sourceTargetId = targetInfo?.parentId || targetInfo?.openerId;
      if(!['shared_worker', 'worker'].includes(targetType) || typeof targetInfo?.url !== 'string') return;
      let parsed;
      try {
        parsed = new URL(targetInfo.url);
      } catch {
        return;
      }
      if(['http:', 'https:'].includes(parsed.protocol) && parsed.origin === PRIVATE_CSP_ORIGIN &&
          observation.labelForPathname(parsed.pathname) && observation.SCRIPT_ASSET_PATTERN.test(path.posix.basename(parsed.pathname)) &&
          typeof targetInfo.targetId === 'string') {
        if(directWorkerAssets.size >= PAGE_ERROR_BLOB_ASSET_LIMIT && !directWorkerAssets.has(targetInfo.targetId)) {
          directWorkerAssets.delete(directWorkerAssets.keys().next().value);
        }
        directWorkerAssets.set(targetInfo.targetId, {asset: path.posix.basename(parsed.pathname), observedAt: Date.now()});
        return;
      }
      if(parsed.protocol === 'blob:' && parsed.origin === PRIVATE_CSP_ORIGIN) {
        if(typeof targetInfo.targetId === 'string') {
          if(workerBlobUrls.size >= PAGE_ERROR_BLOB_ASSET_LIMIT && !workerBlobUrls.has(targetInfo.targetId)) {
            workerBlobUrls.delete(workerBlobUrls.keys().next().value);
          }
          workerBlobUrls.set(targetInfo.targetId, parsed.href);
        }
        if(blobAssets.has(parsed.href)) return;
        const directSource = sourceTargetId && directWorkerAssets.get(sourceTargetId);
        const source = directSource || takeWorkerAssetCandidate(sourceTargetId);
        if(source && blobAssets.size < PAGE_ERROR_BLOB_ASSET_LIMIT) blobAssets.set(parsed.href, source.asset);
      }
    },
    scriptAsset(stack) {
      return pageErrorScriptAsset(stack, blobAssets, pageErrorWorkerAsset);
    },
    workerAsset,
    clear() {
      blobAssets.clear();
      workerAssetCandidates.length = 0;
      directWorkerAssets.clear();
      workerBlobUrls.clear();
    }
  };
}

function pageErrorDiagnosticOptions(page) {
  if(runtime?.pageErrorDiagnostics !== true) return;
  let pageUrl = 'unknown';
  try {
    pageUrl = page.url();
  } catch {
    // An unavailable URL is reported as unknown by the diagnostic sanitizer.
  }
  return {captureDetails: true, pageUrl, scenario: currentScenario, stage: currentStage, redactValues: pageErrorRedactValues()};
}

function pageErrorRedactValues() {
  const redactValues = [];
  for(const account of runtime?.accounts || []) {
    if(typeof account?.username === 'string') redactValues.push(account.username);
    if(typeof account?.password === 'string') redactValues.push(account.password);
  }
  return redactValues;
}

function createPageErrorExceptionEvent(exceptionDetails, pageUrl, redactValues = []) {
  if(!exceptionDetails || typeof exceptionDetails !== 'object' || Array.isArray(exceptionDetails)) return;
  const exceptionFrames = Array.isArray(exceptionDetails.callFrames)
    ? exceptionDetails.callFrames
    : exceptionDetails.stackTrace?.callFrames;
  const rawFrames = Array.isArray(exceptionFrames)
    ? exceptionFrames.slice(0, PAGE_ERROR_DIAGNOSTIC_LIMITS.count)
    : [];
  const frames = rawFrames.map((frame) => {
    if(!frame || typeof frame !== 'object') return;
    const scriptId = frame.location?.scriptId;
    const mappedUrl = typeof scriptId === 'string' ? exceptionDetails.scriptUrls?.[scriptId] : undefined;
    const url = typeof frame.url === 'string' && frame.url ? frame.url : mappedUrl;
    if(typeof url !== 'string' || !url) return;
    return {
      url: sanitizePageErrorDiagnosticText(url, PAGE_ERROR_DIAGNOSTIC_LIMITS.pageUrlLength, redactValues),
      functionName: sanitizePageErrorDiagnosticText(frame.functionName || '', 128, redactValues),
      lineNumber: Number.isSafeInteger(frame.lineNumber) && frame.lineNumber >= 0
        ? frame.lineNumber + 1
        : Number.isSafeInteger(frame.location?.lineNumber) && frame.location.lineNumber >= 0 ? frame.location.lineNumber + 1 : 0,
      columnNumber: Number.isSafeInteger(frame.columnNumber) && frame.columnNumber >= 0
        ? frame.columnNumber + 1
        : Number.isSafeInteger(frame.location?.columnNumber) && frame.location.columnNumber >= 0 ? frame.location.columnNumber + 1 : 0
    };
  }).filter(Boolean);
  const firstFrame = frames[0];
  const exception = exceptionDetails.exception || exceptionDetails.data;
  const exceptionDescription = typeof exception?.description === 'string'
    ? exception.description.split('\n', 1)[0]
    : '';
  const message = sanitizePageErrorDiagnosticText(exceptionDescription || exceptionDetails.text || '', PAGE_ERROR_DIAGNOSTIC_LIMITS.messageLength, redactValues);
  const fallbackUrl = typeof exceptionDetails.url === 'string' ? exceptionDetails.url : firstFrame?.url || '';
  const filename = firstFrame?.url || sanitizePageErrorDiagnosticText(fallbackUrl, PAGE_ERROR_DIAGNOSTIC_LIMITS.pageUrlLength, redactValues);
  const lineNumber = firstFrame?.lineNumber || (Number.isSafeInteger(exceptionDetails.lineNumber) && exceptionDetails.lineNumber >= 0 ? exceptionDetails.lineNumber + 1 : 0);
  const columnNumber = firstFrame?.columnNumber || (Number.isSafeInteger(exceptionDetails.columnNumber) && exceptionDetails.columnNumber >= 0 ? exceptionDetails.columnNumber + 1 : 0);
  const stackFrames = frames.map((frame) => {
    const location = `${frame.url}${frame.lineNumber ? `:${frame.lineNumber}` : ''}${frame.columnNumber ? `:${frame.columnNumber}` : ''}`;
    return `    at ${frame.functionName ? `${frame.functionName} (${location})` : location}`;
  });
  const stack = sanitizePageErrorDiagnosticText([message || 'Error', ...stackFrames].join('\n'), PAGE_ERROR_DIAGNOSTIC_LIMITS.stackLength, redactValues);
  return {
    message,
    stack,
    filename,
    lineNumber,
    columnNumber,
    pageUrl: sanitizePageErrorPageUrl(pageUrl)
  };
}

function recordPageErrorProtocolEvent(page, exceptionDetails, captureSource) {
  let events = pageErrorProtocolEvents.get(page);
  if(!Array.isArray(events)) {
    events = [];
    pageErrorProtocolEvents.set(page, events);
  }
  if(events.length >= PAGE_ERROR_DIAGNOSTIC_LIMITS.count) return;
  let pageUrl = 'unknown';
  try {
    pageUrl = page.url();
  } catch {
    // An unavailable URL is reported as unknown by the diagnostic sanitizer.
  }
  const event = createPageErrorExceptionEvent(exceptionDetails, pageUrl, pageErrorRedactValues());
  if(!event) return;
  const isRuntimeException = captureSource === 'runtime';
  const firstFrame = (Array.isArray(exceptionDetails?.callFrames)
    ? exceptionDetails.callFrames
    : exceptionDetails?.stackTrace?.callFrames)?.[0];
  const location = isRuntimeException
    ? {
      scriptId: firstFrame?.scriptId || exceptionDetails.scriptId,
      lineNumber: Number.isSafeInteger(firstFrame?.lineNumber) ? firstFrame.lineNumber : exceptionDetails.lineNumber,
      columnNumber: Number.isSafeInteger(firstFrame?.columnNumber) ? firstFrame.columnNumber : exceptionDetails.columnNumber
    }
    : firstFrame?.location || {};
  const exception = exceptionDetails?.exception || exceptionDetails?.data;
  const previewProperties = Array.isArray(exception?.preview?.properties) ? exception.preview.properties : [];
  const errorTypePreview = previewProperties.find((property) => property?.name === 'type' && property?.type === 'string')?.value;
  const errorCodePreview = previewProperties.find((property) => property?.name === 'code' && property?.type === 'number')?.value;
  const errorCode = typeof errorCodePreview === 'string' && errorCodePreview.trim() !== ''
    ? Number(errorCodePreview)
    : errorCodePreview;
  events.push({
    ...event,
    captureSequence: events.length,
    captureSource: ['runtime', 'debugger'].includes(captureSource) ? captureSource : 'unknown',
    exceptionId: Number.isSafeInteger(exceptionDetails?.exceptionId) ? exceptionDetails.exceptionId : undefined,
    executionContextId: Number.isSafeInteger(exceptionDetails?.executionContextId) ? exceptionDetails.executionContextId : undefined,
    exceptionObjectId: typeof exception?.objectId === 'string' ? exception.objectId : undefined,
    exceptionLocation: typeof location?.scriptId === 'string' && Number.isSafeInteger(location.lineNumber) && Number.isSafeInteger(location.columnNumber)
      ? {scriptId: location.scriptId, lineNumber: location.lineNumber, columnNumber: location.columnNumber}
      : undefined,
    errorType: sanitizePageErrorRpcErrorType(errorTypePreview),
    errorCode: sanitizePageErrorRpcErrorCode(errorCode)
  });
}

async function installPageErrorEventCapture(page) {
  if(runtime?.pageErrorDiagnostics !== true) return;
  const consoleEvents = [];
  pageErrorProtocolEvents.set(page, []);
  pageErrorConsoleEvents.set(page, consoleEvents);
  page.on('console', (message) => {
    try {
      if(message.type() !== 'error' || consoleEvents.length >= PAGE_ERROR_DIAGNOSTIC_LIMITS.count) return;
      const location = message.location();
      let pageUrl = 'unknown';
      try {
        pageUrl = sanitizePageErrorPageUrl(page.url());
      } catch {
        // An unavailable URL is reported as unknown by the diagnostic sanitizer.
      }
      consoleEvents.push({
        message: sanitizePageErrorDiagnosticText(message.text(), PAGE_ERROR_DIAGNOSTIC_LIMITS.messageLength, pageErrorRedactValues()),
        stack: '',
        filename: sanitizePageErrorDiagnosticText(location?.url || '', PAGE_ERROR_DIAGNOSTIC_LIMITS.pageUrlLength, pageErrorRedactValues()),
        lineNumber: Number.isSafeInteger(location?.lineNumber) ? location.lineNumber : 0,
        columnNumber: Number.isSafeInteger(location?.columnNumber) ? location.columnNumber : 0,
        pageUrl
      });
    } catch {
      // Console diagnostics must not interfere with the browser scenario.
    }
  });
  await page.addInitScript(() => {
    const events = [];
    Object.defineProperty(window, '__teagramPageErrorEvents', {value: events});
    const record = (event) => {
      if(events.length >= 16) return;
      const thrown = event?.error || event?.reason;
      events.push({
        message: typeof event?.message === 'string'
          ? event.message
          : typeof thrown?.message === 'string' ? thrown.message
            : thrown && typeof thrown === 'object' ? 'Object'
              : typeof thrown === 'string' ? thrown : '',
        stack: typeof thrown?.stack === 'string' ? thrown.stack : '',
        filename: typeof event?.filename === 'string' ? event.filename : '',
        lineNumber: Number.isSafeInteger(event?.lineno) ? event.lineno : 0,
        columnNumber: Number.isSafeInteger(event?.colno) ? event.colno : 0,
        pageUrl: window.location.href,
        errorType: typeof thrown?.type === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(thrown.type) ? thrown.type : undefined,
        errorCode: Number.isSafeInteger(thrown?.code) && thrown.code >= 0 && thrown.code <= 999_999 ? thrown.code : undefined
      });
    };
    window.addEventListener('error', record);
    window.addEventListener('unhandledrejection', record);
  });
}

async function enrichPageErrorDetails(pageErrors, contextName, page, pageErrorAssetResolver, redactValues = [], consoleEvents = pageErrorConsoleEvents.get(page) || []) {
  const entries = pageErrors?.[contextName]?.filter((error) => error?.diagnostic) || [];
  if(entries.length === 0) return;
  let windowEvents = [];
  try {
    windowEvents = await page.evaluate((captureKey) => window[captureKey] || [], PAGE_ERROR_EVENT_CAPTURE_KEY);
  } catch {
    // A navigated or closing page can make its in-page diagnostics unavailable.
  }
  for(const entry of entries) {
    const diagnostic = entry.diagnostic;
    const diagnosticMessage = normalizePageErrorMessage(diagnostic.message, redactValues);
    if(!diagnosticMessage) continue;
    const matchingEntries = entries.filter((candidate) =>
      normalizePageErrorMessage(candidate?.diagnostic?.message, redactValues) === diagnosticMessage
    );
    if(matchingEntries.length !== 1) continue;
    const event = correlatePageErrorDiagnosticEvents(diagnostic, {
      windowEvents: Array.isArray(windowEvents) ? windowEvents : [],
      protocolEvents: pageErrorProtocolEvents.get(page) || [],
      consoleEvents: Array.isArray(consoleEvents) ? consoleEvents : []
    }, redactValues);
    if(!event) continue;
    const eventMessage = sanitizePageErrorDiagnosticText(event.message, PAGE_ERROR_DIAGNOSTIC_LIMITS.messageLength, redactValues);
    const eventStack = sanitizePageErrorDiagnosticText(event.stack, PAGE_ERROR_DIAGNOSTIC_LIMITS.stackLength, redactValues);
    const eventPageUrl = sanitizePageErrorPageUrl(event.pageUrl);
    const fallbackStack = typeof event.filename === 'string' && event.filename
      ? `${diagnostic.message || eventMessage || 'Error'}\n    at ${event.filename}:${event.lineNumber || 0}:${event.columnNumber || 0}`
      : '';
    const stack = eventStack || sanitizePageErrorDiagnosticText(fallbackStack, PAGE_ERROR_DIAGNOSTIC_LIMITS.stackLength, redactValues);
    if(!diagnostic.message && eventMessage) diagnostic.message = eventMessage;
    if(stack) diagnostic.stack = stack;
    if(eventPageUrl !== 'unknown') diagnostic.pageUrl = eventPageUrl;
    const rpcErrorType = sanitizePageErrorRpcErrorType(event.errorType);
    const rpcErrorCode = sanitizePageErrorRpcErrorCode(event.errorCode);
    if(rpcErrorType) diagnostic.rpcErrorType = rpcErrorType;
    if(rpcErrorCode !== undefined) diagnostic.rpcErrorCode = rpcErrorCode;
    if(entry.scriptAsset === 'unknown' && stack) {
      const scriptAsset = pageErrorAssetResolver?.scriptAsset(stack) || pageErrorScriptAsset(stack);
      if(scriptAsset !== 'unknown') entry.scriptAsset = scriptAsset;
    }
  }
}

function correlatePageErrorDiagnosticEvents(diagnostic, {windowEvents = [], protocolEvents = [], consoleEvents = []} = {}, redactValues = []) {
  const diagnosticMessage = normalizePageErrorMessage(diagnostic?.message, redactValues);
  if(!diagnosticMessage) return;
  const matchesMessage = (event) => normalizePageErrorMessage(event?.message, redactValues) === diagnosticMessage;
  const matchingProtocolEvents = protocolEvents.filter(matchesMessage);
  const runtimeGroups = [];
  const debuggerEvents = [];
  const otherProtocolEvents = [];

  for(const event of matchingProtocolEvents) {
    if(event.captureSource === 'debugger') {
      debuggerEvents.push(event);
      continue;
    }
    if(event.captureSource !== 'runtime') {
      otherProtocolEvents.push(event);
      continue;
    }
    const existing = Number.isSafeInteger(event.exceptionId)
      ? runtimeGroups.find((group) => group.exceptionId === event.exceptionId && group.executionContextId === event.executionContextId)
      : undefined;
    if(existing) existing.events.push(event);
    else runtimeGroups.push({
      exceptionId: event.exceptionId,
      executionContextId: event.executionContextId,
      events: [event]
    });
  }

  const protocolGroups = [...runtimeGroups];
  for(const event of debuggerEvents) {
    const matchingById = Number.isSafeInteger(event.exceptionId)
      ? protocolGroups.filter((group) => group.exceptionId === event.exceptionId && group.executionContextId === event.executionContextId)
      : [];
    const locationKey = pageErrorExceptionLocationKey(event);
    const matchingByLocation = locationKey
      ? protocolGroups.filter((group) => group.events.some((candidate) => pageErrorExceptionLocationKey(candidate) === locationKey))
      : [];
    const matchingByObjectId = typeof event.exceptionObjectId === 'string'
      ? protocolGroups.filter((group) => group.events.some((candidate) => candidate.exceptionObjectId === event.exceptionObjectId))
      : [];
    const matchingAdjacentRuntime = Number.isSafeInteger(event.executionContextId) && Number.isSafeInteger(event.captureSequence)
      ? protocolGroups.filter((group) => group.executionContextId === event.executionContextId &&
        group.events.some((candidate) => candidate.captureSource === 'runtime' && Number.isSafeInteger(candidate.captureSequence) &&
          Math.abs(candidate.captureSequence - event.captureSequence) === 1))
      : [];
    // Chromium can report a synthetic Runtime location for an uncaught rejection.
    // Adjacent same-context pause/exception observations still identify one throw;
    // a second Runtime group keeps the overall result ambiguous.
    const matches = matchingById.length > 0 ? matchingById : matchingByObjectId.length > 0 ? matchingByObjectId :
      matchingByLocation.length > 0 ? matchingByLocation : matchingAdjacentRuntime;
    if(matches.length === 1) {
      matches[0].events.push(event);
      continue;
    }
    protocolGroups.push({exceptionId: undefined, executionContextId: undefined, events: [event]});
  }
  for(const event of otherProtocolEvents) protocolGroups.push({exceptionId: undefined, executionContextId: undefined, events: [event]});

  if(protocolGroups.length > 0) {
    if(protocolGroups.length !== 1) return;
    const groupEvents = [...protocolGroups[0].events];
    const matchingWindowEvents = windowEvents.filter(matchesMessage);
    if(matchingWindowEvents.length === 1 && canCorrelatePageErrorSupplement(groupEvents, matchingWindowEvents[0])) {
      groupEvents.push({...matchingWindowEvents[0], captureSource: 'window'});
    }
    return mergePageErrorObservationGroup(groupEvents);
  }

  const fallbackEvents = [...windowEvents, ...consoleEvents].filter(matchesMessage);
  if(fallbackEvents.length !== 1) return;
  return fallbackEvents[0];
}

function canCorrelatePageErrorSupplement(groupEvents, supplement) {
  const supplementLocation = pageErrorDiagnosticLocationKey(supplement);
  if(supplementLocation && groupEvents.some((event) => pageErrorDiagnosticLocationKey(event) === supplementLocation)) return true;
  const supplementType = sanitizePageErrorRpcErrorType(supplement?.errorType);
  const supplementCode = sanitizePageErrorRpcErrorCode(supplement?.errorCode);
  if(!supplementType && supplementCode === undefined) return false;
  const groupTypes = [...new Set(groupEvents.map((event) => sanitizePageErrorRpcErrorType(event.errorType)).filter(Boolean))];
  const groupCodes = [...new Set(groupEvents.map((event) => sanitizePageErrorRpcErrorCode(event.errorCode)).filter((value) => value !== undefined))];
  return (!supplementType || groupTypes.length === 1 && groupTypes[0] === supplementType) &&
    (supplementCode === undefined || groupCodes.length === 1 && groupCodes[0] === supplementCode);
}

function pageErrorDiagnosticLocationKey(event) {
  const filename = typeof event?.filename === 'string' ? sanitizePageErrorStackUrl(event.filename) : '';
  if(!filename || filename === '[redacted-url]' || !Number.isSafeInteger(event?.lineNumber) || event.lineNumber <= 0 ||
      !Number.isSafeInteger(event?.columnNumber) || event.columnNumber <= 0) return;
  return `${filename}:${event.lineNumber}:${event.columnNumber}`;
}

function pageErrorExceptionLocationKey(event) {
  const location = event?.exceptionLocation;
  if(typeof location?.scriptId !== 'string' || !Number.isSafeInteger(location.lineNumber) || !Number.isSafeInteger(location.columnNumber)) return;
  return `${location.scriptId}:${location.lineNumber}:${location.columnNumber}`;
}

function mergePageErrorObservationGroup(events) {
  const ranked = [...events].sort((first, second) => pageErrorObservationScore(second) - pageErrorObservationScore(first));
  const merged = {...ranked[0]};
  const errorTypes = [...new Set(events.map((event) => sanitizePageErrorRpcErrorType(event.errorType)).filter(Boolean))];
  const errorCodes = [...new Set(events.map((event) => sanitizePageErrorRpcErrorCode(event.errorCode)).filter((value) => value !== undefined))];
  if(errorTypes.length === 1) merged.errorType = errorTypes[0];
  else delete merged.errorType;
  if(errorCodes.length === 1) merged.errorCode = errorCodes[0];
  else delete merged.errorCode;
  return merged;
}

function pageErrorObservationScore(event) {
  const stackLength = typeof event?.stack === 'string' ? event.stack.length : 0;
  const hasLocation = pageErrorExceptionLocationKey(event) || (typeof event?.filename === 'string' && event.filename);
  return stackLength + (hasLocation ? 256 : 0);
}

function normalizePageErrorMessage(value, redactValues) {
  return sanitizePageErrorDiagnosticText(value, PAGE_ERROR_DIAGNOSTIC_LIMITS.messageLength, redactValues)
  .replace(/^Uncaught(?:\s+\(in promise\))?\s*/i, '')
  .trim();
}

async function enrichPageErrorReport(pageErrors, pages, pageErrorAssetResolvers, networkObservers = {}, redactValues = []) {
  await Promise.all(APP_CONTEXTS.map(async(contextName) => {
    const page = pages?.[contextName];
    if(!page) return;
    try {
      await enrichPageErrorDetails(pageErrors, contextName, page, pageErrorAssetResolvers?.[contextName], redactValues);
    } catch {
      // Diagnostics are best-effort and must not replace the scenario result.
    }
  }));
  return summarizeBrowserGateBreakdown({networkObservers, pageErrors});
}

function sanitizePageErrorRpcErrorType(value) {
  return typeof value === 'string' && RPC_ERROR_TYPE_PATTERN.test(value) ? value : undefined;
}

function sanitizePageErrorRpcErrorCode(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 999_999 ? value : undefined;
}

function readPageErrorText(error, key) {
  try {
    const value = error?.[key];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function sanitizePageErrorStackUrl(value) {
  const lineSuffix = /:\d+(?::\d+)?$/.exec(value)?.[0] || '';
  const urlText = lineSuffix ? value.slice(0, -lineSuffix.length) : value;
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    return `[redacted-url]${lineSuffix}`;
  }
  if(parsed.protocol === 'blob:') {
    return `${parsed.origin === PRIVATE_CSP_ORIGIN ? `${PRIVATE_CSP_ORIGIN}/<blob>` : 'blob:<external>'}${lineSuffix}`;
  }
  if(!['http:', 'https:'].includes(parsed.protocol)) return `[redacted-url]${lineSuffix}`;
  const location = parsed.origin === PRIVATE_CSP_ORIGIN
    ? `${parsed.origin}${parsed.pathname}`
    : path.posix.basename(parsed.pathname) || '[external-script]';
  return `${location}${lineSuffix}`;
}

function sanitizePageErrorDiagnosticText(value, limit, redactValues = []) {
  if(typeof value !== 'string') return '';
  let sanitized = value;
  for(const secret of redactValues) {
    if(typeof secret === 'string' && secret.length > 0) sanitized = sanitized.split(secret).join('[redacted]');
  }
  sanitized = sanitized
  .replace(/(?:https?:\/\/|blob:https?:\/\/)[^\s)]+/g, sanitizePageErrorStackUrl)
  .replace(/\b(password|passwd|token|secret|authorization|api[_ -]?key)\b(\s*[:=]\s*)[^,;\r\n]+/gi, '$1$2[redacted]');
  return sanitized.slice(0, limit);
}

function sanitizePageErrorPageUrl(value) {
  if(typeof value !== 'string') return 'unknown';
  try {
    const parsed = new URL(value);
    if(!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== PRIVATE_CSP_ORIGIN) return 'unknown';
    return `${parsed.origin}${parsed.pathname}`.slice(0, PAGE_ERROR_DIAGNOSTIC_LIMITS.pageUrlLength);
  } catch {
    return 'unknown';
  }
}

function sanitizePageErrorScenario(value) {
  return PAGE_ERROR_DIAGNOSTIC_SCENARIOS.has(value) ? value : 'unknown';
}

function sanitizePageErrorStage(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'unknown';
}

function createPageErrorDiagnostic(error, options = {}) {
  return {
    message: sanitizePageErrorDiagnosticText(readPageErrorText(error, 'message'), PAGE_ERROR_DIAGNOSTIC_LIMITS.messageLength, options.redactValues),
    stack: sanitizePageErrorDiagnosticText(readPageErrorText(error, 'stack'), PAGE_ERROR_DIAGNOSTIC_LIMITS.stackLength, options.redactValues),
    pageUrl: sanitizePageErrorPageUrl(options.pageUrl),
    scenario: sanitizePageErrorScenario(options.scenario),
    stage: sanitizePageErrorStage(options.stage)
  };
}

function recordPageError(pageErrors, contextName, error, pageErrorAssetResolver, diagnosticOptions) {
  if(!APP_CONTEXTS.includes(contextName) || !Array.isArray(pageErrors?.[contextName])) return;
  const scriptAsset = pageErrorAssetResolver?.scriptAsset(error?.stack) || pageErrorScriptAsset(error?.stack);
  const entry = {constructorName: pageErrorConstructorName(error), scriptAsset};
  const events = pageErrors[contextName];
  const diagnosticCount = pageErrorDiagnosticCounts.get(events) || 0;
  if(scriptAsset === 'unknown' && diagnosticOptions?.captureDetails === true &&
      diagnosticCount < PAGE_ERROR_DIAGNOSTIC_LIMITS.count) {
    entry.diagnostic = createPageErrorDiagnostic(error, diagnosticOptions);
    pageErrorDiagnosticCounts.set(events, diagnosticCount + 1);
  }
  events.push(entry);
}

function sanitizePageError(error) {
  const constructorName = PAGE_ERROR_CONSTRUCTORS.has(error?.constructorName) ? error.constructorName : 'Error';
  const scriptAsset = typeof error?.scriptAsset === 'string' && observation.SCRIPT_ASSET_PATTERN.test(error.scriptAsset)
    ? error.scriptAsset
    : 'unknown';
  const sanitized = {constructorName, scriptAsset};
  const diagnostic = error?.diagnostic;
  if(diagnostic && typeof diagnostic === 'object') {
    sanitized.diagnostic = {
      message: sanitizePageErrorDiagnosticText(diagnostic.message, PAGE_ERROR_DIAGNOSTIC_LIMITS.messageLength),
      stack: sanitizePageErrorDiagnosticText(diagnostic.stack, PAGE_ERROR_DIAGNOSTIC_LIMITS.stackLength),
      pageUrl: sanitizePageErrorPageUrl(diagnostic.pageUrl),
      scenario: sanitizePageErrorScenario(diagnostic.scenario),
      stage: sanitizePageErrorStage(diagnostic.stage),
      ...(sanitizePageErrorRpcErrorType(diagnostic.rpcErrorType)
        ? {rpcErrorType: sanitizePageErrorRpcErrorType(diagnostic.rpcErrorType)}
        : {}),
      ...(sanitizePageErrorRpcErrorCode(diagnostic.rpcErrorCode) !== undefined
        ? {rpcErrorCode: sanitizePageErrorRpcErrorCode(diagnostic.rpcErrorCode)}
        : {})
    };
  }
  return sanitized;
}

function summarizeBrowserGateBreakdown({networkObservers = {}, pageErrors = {}} = {}) {
  const unexpectedEgressAttempts = {};
  const observerErrors = {};
  const sanitizedPageErrors = {};
  const pageErrorOverflow = {};
  for(const contextName of APP_CONTEXTS) {
    const events = networkObservers[contextName]?.gateEvents || [];
    unexpectedEgressAttempts[contextName] = events.slice(0, 512).map((event) => {
      const source = event.source === 'worker' ? 'dedicated_worker' : event.source;
      const scheme = observation.GATE_SCHEMES.includes(event.scheme) ? event.scheme : 'unknown';
      let host = 'unknown';
      try {
        const parsed = new URL(`${scheme}://${event.host}`);
        if(parsed.host === event.host && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash) {
          host = parsed.host.slice(0, 255);
        }
      } catch {
        // Keep malformed observer data out of the failure report.
      }
      return {
        source: observation.GATE_EGRESS_SOURCES.includes(source) ? source : 'dedicated_worker',
        scheme,
        host,
        resourceType: NETWORK_RESOURCE_TYPES.includes(event.resourceType) ? event.resourceType : 'Other'
      };
    });
    const errorCounts = new Map();
    for(const kind of (networkObservers[contextName]?.errors || []).slice(0, 8)) {
      const normalized = NETWORK_OBSERVER_ERROR_KINDS.has(kind) ? kind : 'unknown';
      errorCounts.set(normalized, (errorCounts.get(normalized) || 0) + 1);
    }
    observerErrors[contextName] = Object.fromEntries([...errorCounts.entries()].sort(([left], [right]) => left.localeCompare(right)));
    const contextPageErrors = pageErrors[contextName] || [];
    sanitizedPageErrors[contextName] = contextPageErrors.slice(0, 512).map(sanitizePageError);
    const overflowCounts = new Map();
    for(const error of contextPageErrors.slice(512)) {
      const sanitized = sanitizePageError(error);
      const key = `${sanitized.constructorName}\0${sanitized.scriptAsset}`;
      overflowCounts.set(key, Math.min(1_000_000, (overflowCounts.get(key) || 0) + 1));
    }
    pageErrorOverflow[contextName] = [...overflowCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => {
        const separator = key.indexOf('\0');
        return {
          constructorName: key.slice(0, separator),
          scriptAsset: key.slice(separator + 1),
          count
        };
      });
  }
  const counters = {
    unexpectedEgressAttempts: Object.values(unexpectedEgressAttempts).reduce((sum, attempts) => sum + attempts.length, 0),
    observerErrors: Object.values(observerErrors).reduce((sum, errors) => sum + Object.values(errors).reduce((count, total) => count + total, 0), 0),
    pageErrors: Math.min(1_000_000, APP_CONTEXTS.reduce((sum, contextName) => sum + (pageErrors[contextName]?.length || 0), 0))
  };
  return {counters, unexpectedEgressAttempts, observerErrors, pageErrors: sanitizedPageErrors, pageErrorOverflow};
}

function mergeWebSocket101ByContextPhase(grids) {
  const merged = observation.createWebSocket101Grid();
  for(const grid of grids) {
    if(!grid) continue;
    for(const context of observation.WEBSOCKET_101_CONTEXTS) {
      for(const phase of observation.WEBSOCKET_101_PHASES) merged[context][phase] += grid[context][phase];
    }
  }
  return merged;
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

function buildWorkerCoverageFailureBreakdown(registry, appObservers) {
  const contexts = Object.fromEntries(Object.keys(appObservers).filter((name) => APP_CONTEXTS.includes(name)).map((name) => {
    const observer = appObservers[name];
    const summary = observer.summary();
    return [name, {
      discoveryActive: summary.discoveryActive,
      pageCoverageComplete: summary.pageCoverageComplete,
      windowElapsed: observer.state.windowElapsed ? 1 : 0,
      observerOverflow: summary.observerOverflow,
      observerErrors: summary.observerErrors,
      foreignTargets: observer.state.foreignTargets,
      countedEvents: summary.countedEvents,
      attachedTargets: summary.attachedTargets,
      pageTargets: summary.pageTargets,
      coverageComplete: summary.coverageComplete
    }];
  }));
  return observation.buildWorkerCoverageBreakdown({
    registry: {
      discoveryActive: registry.discoveryActive ? 1 : 0,
      foreignTargets: registry.foreignTargets,
      contextlessTargets: registry.contextlessTargets,
      appContextlessTargets: registry.appContextlessTargets,
      targetDetailsOverflow: registry.targetDetailsOverflow ? 1 : 0
    },
    contexts,
    targets: registry.coverageTargets()
  });
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

function buildAuthProgressReport(status, stage, contexts, controlCount, passwordEvidence, registry, appObservers, appNetworkObservers, controls, egress, controlWebSocket101ByContextPhase, gateBreakdown) {
  const networkContexts = Object.fromEntries(Object.entries(appNetworkObservers).map(([name, observer]) => {
    const summary = observer.summary();
    return [name, {
      workerTargets: summary.workerTargets,
      allowedWebSockets: summary.allowedWebSockets,
      attemptsBySource: summary.attemptsBySource,
      unexpectedAttemptsBySource: summary.unexpectedAttemptsBySource,
      allowedWebSocketsBySource: summary.allowedWebSocketsBySource
    }];
  }));
  const observationBlock = registry
    ? buildObservationBlock(registry, appObservers, controls, egress)
    : null;
  return {
    status,
    mode: 'auth_progress_one_submission',
    stage,
    usernameSubmissions: contexts.usernameSubmissions,
    passwordFills: 0,
    passwordSubmissions: 0,
    bobContextCount: 0,
    laterScenarioCount: 0,
    contextCount: contexts.contextCount,
    controlContextCount: controlCount,
    screenshotsCaptured: 0,
    passwordEvidence,
    network: {
      unexpectedAttempts: egress.unexpectedAttempts,
      observerErrors: egress.observerErrors,
      contexts: networkContexts,
      websocket_101_by_context_phase: mergeWebSocket101ByContextPhase([
        controlWebSocket101ByContextPhase,
        ...Object.values(appObservers).map((observer) => observer.webSocket101ByContextPhase())
      ])
    },
    ...(gateBreakdown ? {gateBreakdown} : {}),
    ...(status === 'failed' && stage === 'browser_worker_observation_incomplete' && registry
      ? {workerCoverageBreakdown: buildWorkerCoverageFailureBreakdown(registry, appObservers)}
      : {}),
    workerObservation: observationBlock && !observation.validateNetworkBlock(observationBlock)
      ? observationBlock
      : observationBlock ? observation.UNCLASSIFIED_NETWORK_BLOCK : null
  };
}

async function cleanupBrowserRun({registry, observers, contexts, browser, screenshotDirectory, cleanupIssues}) {
  let cleanupFailed = false;
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
    if(screenshotDirectory) fs.rmSync(screenshotDirectory, {recursive: true, force: true});
  } catch {
    cleanupFailed = true;
  }
  if(cleanupIssues.length > 0) cleanupFailed = true;
  return cleanupFailed;
}

async function runAuthProgressOneSubmission({browser, runtimeConfig, registry, controls, cleanupIssues = [], dependencies = {}, webSocket101Phase, controlWebSocket101ByContextPhase}) {
  const contexts = [];
  const observers = [];
  const appObservers = {};
  const appNetworkObservers = {};
  const actionCounts = {usernameSubmissions: 0};
  const passwordEvidence = [];
  const pageErrors = {alice: [], bob: []};
  const pageErrorAssets = {alice: createPageErrorAssetResolver()};
  const pageErrorPages = {};
  const createContextObserver = dependencies.createContextObserver || observation.createContextObserver;
  const createAppNetworkObserver = dependencies.createNetworkObserver || createNetworkObserver;
  const submitUsername = dependencies.submitUsernameOnceAndWaitForPassword || submitUsernameOnceAndWaitForPassword;
  let report;
  let cleanupFailed = false;
  let gateBreakdown;

  try {
    currentStage = 'alice_context';
    const alice = {context: await browser.newContext({viewport: {width: 1280, height: 900}})};
    contexts.push(alice.context);
    alice.page = await alice.context.newPage();
    pageErrorPages.alice = alice.page;
    await installPageErrorEventCapture(alice.page);
    alice.observer = createContextObserver('alice', {observeWebSocket101: true, webSocket101Phase});
    appObservers.alice = alice.observer;
    alice.networkObserver = createAppNetworkObserver(
      alice.page,
      'alice',
      alice.observer,
      pageErrorAssets.alice,
      runtimeConfig.pageErrorDiagnostics === true ? (details, source) => recordPageErrorProtocolEvent(alice.page, details, source) : undefined
    );
    appNetworkObservers.alice = alice.networkObserver;
    observers.push(alice.networkObserver);
    await alice.networkObserver.start(registry);

    alice.page.on('pageerror', (error) => recordPageError(pageErrors, 'alice', error, pageErrorAssets.alice, pageErrorDiagnosticOptions(alice.page)));
    await submitUsername(
      alice.page,
      runtimeConfig.accounts[0],
      runtimeConfig,
      'alice',
      passwordEvidence,
      actionCounts,
      PASSWORD_FIELD_TIMEOUT_MS,
      alice.observer
    );
    currentStage = 'browser_worker_observation';
    await Promise.all(observers.map((observer) => observer.waitForSetup()));
    await registry.waitForSetup();
    alice.observer.state.windowElapsed = true;
    const egress = summarizeEgress(observers);
    const workerBlock = buildObservationBlock(registry, appObservers, controls, egress);
    const network = alice.networkObserver.summary();
    gateBreakdown = runtimeConfig.pageErrorDiagnostics === true
      ? await enrichPageErrorReport(pageErrors, pageErrorPages, pageErrorAssets, appNetworkObservers, pageErrorRedactValues())
      : summarizeBrowserGateBreakdown({networkObservers: appNetworkObservers, pageErrors});
    if(egress.unexpectedAttempts !== 0 || egress.observerErrors !== 0 || pageErrors.alice.length + pageErrors.bob.length !== 0) {
      failStage('browser_egress_or_page_errors');
    }
    if(registry.foreignTargets !== 0 || registry.appContextlessTargets !== 0 || workerBlock.discoveryActive !== 1 ||
        workerBlock.observerOverflow !== 0 || workerBlock.contexts.alice.pageTargets !== 1 ||
        workerBlock.contexts.alice.coverageComplete !== 1 || workerBlock.contexts.alice.observerErrors !== 0) {
      failStage('browser_worker_observation_incomplete');
    }
    if(network.workerTargets.service_worker < 1 || network.allowedWebSockets < 1) {
      failStage('browser_worker_or_websocket_evidence');
    }
    if(observation.validateNetworkBlock(workerBlock)) failStage('worker_observation_unclassified');
    currentStage = 'alice_password_field_ready';
    report = buildAuthProgressReport(
      'passed',
      currentStage,
      {usernameSubmissions: actionCounts.usernameSubmissions, contextCount: contexts.length},
      Object.keys(controls).length,
      passwordEvidence,
      registry,
      appObservers,
      appNetworkObservers,
      controls,
      egress,
      controlWebSocket101ByContextPhase,
      undefined
    );
  } catch(error) {
    await Promise.all(observers.map((observer) => observer.waitForSetup().catch(() => {})));
    await registry?.waitForSetup().catch(() => {});
    for(const observer of Object.values(appObservers)) observer.state.windowElapsed = true;
    const egress = summarizeEgress(observers);
    if(runtimeConfig.pageErrorDiagnostics === true) {
      gateBreakdown = await enrichPageErrorReport(pageErrors, pageErrorPages, pageErrorAssets, appNetworkObservers, pageErrorRedactValues());
    }
    const includeGateBreakdown = currentStage === 'browser_egress_or_page_errors' ||
      (runtimeConfig.pageErrorDiagnostics === true && pageErrors.alice.length + pageErrors.bob.length > 0);
    report = buildAuthProgressReport(
      'failed',
      currentStage,
      {usernameSubmissions: actionCounts.usernameSubmissions, contextCount: contexts.length},
      Object.keys(controls).length,
      passwordEvidence,
      registry,
      appObservers,
      appNetworkObservers,
      controls,
      egress,
      controlWebSocket101ByContextPhase,
      includeGateBreakdown ? gateBreakdown || summarizeBrowserGateBreakdown({networkObservers: appNetworkObservers, pageErrors}) : undefined
    );
  } finally {
    currentStage = 'cleanup';
    cleanupFailed = await cleanupBrowserRun({
      registry,
      observers,
      contexts,
      browser,
      screenshotDirectory: runtimeConfig.screenshotDirectory,
      cleanupIssues
    });
    Object.values(pageErrorAssets).forEach((resolver) => resolver.clear());
  }

  return {report, cleanupFailed};
}

async function main(dependencies = {}) {
  let report;
  let browser;
  const contexts = [];
  const observers = [];
  const appObservers = {};
  const appNetworkObservers = {};
  const capturedScreenshots = {count: 0};
  const actionCounts = {usernameSubmissions: 0};
  const passwordEvidence = [];
  const pageErrors = {alice: [], bob: []};
  const pageErrorAssets = Object.fromEntries(APP_CONTEXTS.map((name) => [name, createPageErrorAssetResolver()]));
  const pageErrorPages = {};
  const cleanupIssues = [];
  let cleanupFailed = false;
  let authProgressCleanupHandled = false;
  let registry;
  let controls = {};
  let webSocket101Phase;
  let controlWebSocket101ByContextPhase;
  let gateBreakdown;
  centerColumnTrace = createCenterColumnTrace();
  groupNameFormTrace = {page: undefined, stepWait: 'none'};
  groupCreatedTrace = {page: undefined, groupName: undefined, stages: [], stepWait: 'none'};
  groupMemberTrace = createGroupMemberTrace();
  groupMessageTrace = createGroupMessageTrace();
  try {
    runtime = Object.prototype.hasOwnProperty.call(dependencies, 'runtimeConfig')
      ? dependencies.runtimeConfig
      : await (dependencies.readRuntimeInput || readRuntimeInput)();
    (dependencies.validateRuntimeInput || validateRuntimeInput)(runtime);
    fs.mkdirSync(runtime.screenshotDirectory, {mode: 0o700});

    currentStage = 'browser_launch';
    browser = await (dependencies.launchBrowser || ((options) => chromium.launch(options)))({
      headless: true,
      chromiumSandbox: true,
      args: [
        `--host-resolver-rules=MAP teagramd.test ${runtime.frontIp},MAP * ~NOTFOUND`,
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
    registry = (dependencies.createWorkerDiscovery || createWorkerDiscovery)();
    await registry.launch(browser);

    currentStage = 'observer_controls';
    webSocket101Phase = runtime.authProgressOneSubmission === true ? observation.createWebSocket101Phase() : undefined;
    const controlRun = await (dependencies.runObserverControls || runObserverControls)(browser, registry, cleanupIssues, webSocket101Phase);
    controls = controlRun.controls;
    controlWebSocket101ByContextPhase = controlRun.websocket101ByContextPhase;
    if(controlRun.failedControls.length > 0) failStage('observer_control_mismatch');

    // The synthetic-only mode proves the observer capability against the
    // fixture's own probe controls: no app context, no artifact.
    if(runtime.observationOnly === true) {
      report = buildObserverOnlyReport(registry, controls);
      return;
    }

    const accounts = runtime.accounts;
    if(runtime.authProgressOneSubmission === true) {
      authProgressCleanupHandled = true;
      const result = await runAuthProgressOneSubmission({
        browser,
        runtimeConfig: runtime,
        registry,
        controls,
        cleanupIssues,
        dependencies: dependencies.authProgressDependencies,
        webSocket101Phase,
        controlWebSocket101ByContextPhase
      });
      report = result.report;
      cleanupFailed = result.cleanupFailed;
      return;
    }

    currentStage = 'alice_context';
    const alice = {context: await browser.newContext({viewport: {width: 1280, height: 900}})};
    contexts.push(alice.context);
    alice.page = await alice.context.newPage();
    pageErrorPages.alice = alice.page;
    await installPageErrorEventCapture(alice.page);
    alice.observer = observation.createContextObserver('alice');
    appObservers.alice = alice.observer;
    alice.networkObserver = createNetworkObserver(
      alice.page,
      'alice',
      alice.observer,
      pageErrorAssets.alice,
      runtime.pageErrorDiagnostics === true ? (details, source) => recordPageErrorProtocolEvent(alice.page, details, source) : undefined
    );
    appNetworkObservers.alice = alice.networkObserver;
    observers.push(alice.networkObserver);
    await alice.networkObserver.start(registry);

    alice.page.on('pageerror', (error) => recordPageError(pageErrors, 'alice', error, pageErrorAssets.alice, pageErrorDiagnosticOptions(alice.page)));
    await countClientErrors(alice.page);

    currentStage = 'bob_context';
    const bob = {context: await browser.newContext({viewport: {width: 1280, height: 900}})};
    contexts.push(bob.context);
    bob.page = await bob.context.newPage();
    pageErrorPages.bob = bob.page;
    await installPageErrorEventCapture(bob.page);
    bob.observer = observation.createContextObserver('bob');
    appObservers.bob = bob.observer;
    bob.networkObserver = createNetworkObserver(
      bob.page,
      'bob',
      bob.observer,
      pageErrorAssets.bob,
      runtime.pageErrorDiagnostics === true ? (details, source) => recordPageErrorProtocolEvent(bob.page, details, source) : undefined
    );
    appNetworkObservers.bob = bob.networkObserver;
    observers.push(bob.networkObserver);
    await bob.networkObserver.start(registry);

    bob.page.on('pageerror', (error) => recordPageError(pageErrors, 'bob', error, pageErrorAssets.bob, pageErrorDiagnosticOptions(bob.page)));
    await countClientErrors(bob.page);

    currentScenario = 'sign-in';
    await signIn(alice.page, accounts[0], 'alice', runtime.screenshotDirectory, capturedScreenshots, passwordEvidence);
    await signIn(bob.page, accounts[1], 'bob', runtime.screenshotDirectory, capturedScreenshots, passwordEvidence);
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
    const directMessageFailure = await getSingleExactMessageTextFailure(bobDirectMessages, MESSAGE);
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
    await nameNewGroup(alice.page, groupName, runtime.screenshotDirectory, capturedScreenshots);
    await waitForGroupCreated(alice.page, groupName, runtime.screenshotDirectory, capturedScreenshots);

    currentStage = 'bob_group_membership';
    const bobGroupRow = bob.page.locator('#chatlist-container .chatlist-chat').filter({hasText: groupName});
    await bobGroupRow.waitFor({state: 'visible', timeout: 45_000}).catch(() => failStage('bob_group_chatlist_entry'));
    const bobGroupHeader = await openBobGroupChat(bob.page, bobGroupRow, groupName, runtime.screenshotDirectory, capturedScreenshots);

    await sendGroupText(alice.page, GROUP_MESSAGE, groupName, 'alice_group_message');
    await captureState(alice.page, runtime.screenshotDirectory, 'alice-group-message', capturedScreenshots);

    currentStage = 'bob_group_message';
    const bobActiveGroup = resolveActiveGroupChat(bob.page, groupName);
    const bobGroupMessage = bobActiveGroup.chat.locator('.bubble .message').filter({hasText: GROUP_MESSAGE});
    await startGroupMessageTrace(bob.page, 'bob_group_message_count');
    await bobGroupMessage.first().waitFor({state: 'visible', timeout: 30_000}).catch(() => failStage('bob_group_message_visible'));
    await waitForGroupMessageCount(bob.page, bobActiveGroup.chat, bobActiveGroup.title, bobGroupMessage, 'bob_group_message_count');
    currentStage = 'bob_group_message';
    await captureState(bob.page, runtime.screenshotDirectory, 'bob-group-message', capturedScreenshots);

    await openBobGroupMembers(bob.page, bobGroupHeader, groupName, selectedBobPeerId, runtime.screenshotDirectory, capturedScreenshots);
    report.push({name: 'group', status: 'passed'});

    if(runtime.scenarios?.includes('channel')) {
      currentScenario = 'channel';
      const channelName = `browser-ci-channel-${runtime.runId.slice(0, 8)}`;

      currentStage = 'alice_new_channel_menu';
      await alice.page.locator('#new-menu').click().catch(() => failStage('alice_new_channel_menu'));
      await alice.page.getByText('New Channel', {exact: true}).click().catch(() => failStage('alice_new_channel_menu'));

      currentStage = 'alice_channel_form';
      const channelForm = alice.page.locator('.new-channel-container');
      await channelForm.waitFor({state: 'visible', timeout: 15_000}).catch(() => failStage('alice_channel_form'));

      currentStage = 'alice_channel_name';
      await channelForm.locator('.input-field-input').first().fill(channelName, {timeout: 15_000})
      .catch(() => failStage('alice_channel_name'));

      currentStage = 'alice_channel_create';
      await channelForm.locator('.btn-corner.is-visible').click({timeout: 15_000})
      .catch(() => failStage('alice_channel_create'));

      currentStage = 'alice_add_bob_to_channel';
      const addMembers = alice.page.locator('.add-members-container');
      await addMembers.waitFor({state: 'visible', timeout: 30_000}).catch(() => failStage('alice_add_bob_to_channel'));
      await selectUniquePeer(
        alice.page,
        '.add-members-container .input-search-input',
        '.add-members-container .row[data-peer-id]',
        accounts[1].username,
        'alice_add_bob_to_channel'
      );

      currentStage = 'alice_channel_invite_button';
      await addMembers.locator('.btn-corner.is-visible').click({timeout: 30_000})
      .catch(() => failStage('alice_channel_invite_button'));
      const channelPeerId = await waitForChannelInviteCompletion(alice.page, addMembers, channelName);

      currentStage = 'bob_channel_reload';
      await bob.page.reload({waitUntil: 'domcontentloaded'}).catch(() => failStage('bob_channel_reload'));
      await bob.page.locator('#chatlist-container').waitFor({state: 'visible', timeout: CHANNEL_MEMBERSHIP_STEP_TIMEOUT_MS})
      .catch(() => failStage('bob_channel_reload'));

      channelMembershipTrace = {page: bob.page, channelName, peerId: channelPeerId, stepWait: 'none'};
      currentStage = 'bob_channel_membership';
      const bobChannelRow = bob.page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${channelPeerId}"]`);
      await bobChannelRow.waitFor({state: 'visible', timeout: CHANNEL_MEMBERSHIP_STEP_TIMEOUT_MS}).catch((error) => {
        channelMembershipTrace.stepWait = classifyLocatorError(error);
        failStage('bob_channel_membership');
      });
      const channelMembership = await captureChannelMembershipState();
      if(channelMembership === 'unavailable' || channelMembership.peerRowCount !== 1 || !channelMembership.peerRowHasTitle) {
        failStage('bob_channel_membership');
      }
      report.push({name: 'channel', status: 'passed'});
    }

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
    gateBreakdown = runtime.pageErrorDiagnostics === true
      ? await enrichPageErrorReport(pageErrors, pageErrorPages, pageErrorAssets, appNetworkObservers, pageErrorRedactValues())
      : summarizeBrowserGateBreakdown({networkObservers: appNetworkObservers, pageErrors});
    if(egress.unexpectedAttempts !== 0 || egress.observerErrors !== 0 || pageErrors.alice.length + pageErrors.bob.length !== 0) {
      failStage('browser_egress_or_page_errors');
    }
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
      passwordEvidence,
      ...(runtime.scenarios?.includes('channel') ? {channelMembership: await captureChannelMembershipState()} : {}),
      network: {unexpectedAttempts: egress.unexpectedAttempts, observerErrors: egress.observerErrors, contexts: networkContexts},
      workerObservation: observationBlock
    };
  } catch(error) {
    if(runtime?.authProgressOneSubmission === true) {
      await Promise.all(observers.map((observer) => observer.waitForSetup().catch(() => {})));
      await registry?.waitForSetup().catch(() => {});
      for(const observer of Object.values(appObservers)) observer.state.windowElapsed = true;
      const egress = summarizeEgress(observers);
      report = buildAuthProgressReport(
        'failed',
        currentStage,
        {usernameSubmissions: actionCounts.usernameSubmissions, contextCount: contexts.length},
        Object.keys(controls).length,
        passwordEvidence,
        registry,
        appObservers,
        appNetworkObservers,
        controls,
        egress,
        controlWebSocket101ByContextPhase
      );
    } else {
      await Promise.all(observers.map((observer) => observer.waitForSetup()));
      await registry?.waitForSetup();
      const egress = summarizeEgress(observers);
      if(runtime?.pageErrorDiagnostics === true) {
        gateBreakdown = await enrichPageErrorReport(pageErrors, pageErrorPages, pageErrorAssets, appNetworkObservers, pageErrorRedactValues());
      }
      const includeGateBreakdown = currentStage === 'browser_egress_or_page_errors' ||
        (runtime?.pageErrorDiagnostics === true && pageErrors.alice.length + pageErrors.bob.length > 0);
      // The bounded sign-in window has ended by the time a sign-in stage fails,
      // so the failure report states what the observer established, not a blank.
      for(const observer of Object.values(appObservers)) observer.state.windowElapsed = true;
      const failureBlock = buildObservationBlock(registry, appObservers, controls, egress);
      const centerColumn = ['message', 'group'].includes(currentScenario) ? await captureCenterColumnState() : undefined;
      const groupNameForm = currentStage.startsWith('alice_group_name_') ? await captureGroupNameFormState() : undefined;
      const groupCreated = groupCreatedTrace.stages?.includes(currentStage) ? await captureGroupCreatedState() : undefined;
      const groupMember = groupMemberTrace.stages?.includes(currentStage) ? await captureGroupMemberState() : undefined;
      const groupMessage = groupMessageTrace.stage === currentStage ? await captureGroupMessageState() : undefined;
      const channelMembership = currentStage === 'bob_channel_membership' ? await captureChannelMembershipState() : undefined;
      report = {
        status: 'failed',
        stage: currentStage,
        ...(currentScenario ? {scenario: currentScenario} : {}),
        errorClass: ['TimeoutError', 'TypeError', 'Error', 'AbortError'].includes(error?.name) ? error.name : 'OtherError',
        scenarios: Array.isArray(report) ? report : [],
        contextCount: contexts.length,
        controlContextCount: CONTROL_PLAN.length,
        screenshotsCaptured: capturedScreenshots.count,
        passwordEvidence,
        ...(centerColumn ? {centerColumn} : {}),
        ...(groupNameForm ? {groupNameForm} : {}),
        ...(groupCreated ? {groupCreated} : {}),
        ...(groupMember ? {groupMember} : {}),
        ...(groupMessage ? {groupMessage} : {}),
        ...(channelMembership ? {channelMembership} : {}),
        ...(currentStage === 'browser_worker_observation_incomplete' && registry
          ? {workerCoverageBreakdown: buildWorkerCoverageFailureBreakdown(registry, appObservers)}
          : {}),
        ...(includeGateBreakdown
          ? {gateBreakdown: gateBreakdown || summarizeBrowserGateBreakdown({networkObservers: appNetworkObservers, pageErrors})}
          : {}),
        // On failure the closed-schema evidence is still the point, validated the
        // same way: any schema violation collapses it to `unclassified`.
        ...(registry ? {
          workerObservation: observation.validateNetworkBlock(failureBlock) ? observation.UNCLASSIFIED_NETWORK_BLOCK : failureBlock
        } : {})
      };
    }
  } finally {
    if(!authProgressCleanupHandled) {
      currentStage = 'cleanup';
      cleanupFailed = await cleanupBrowserRun({
        registry,
        observers,
        contexts,
        browser,
        screenshotDirectory: runtime?.screenshotDirectory,
        cleanupIssues
      });
    }
    Object.values(pageErrorAssets).forEach((resolver) => resolver.clear());
    if(runtime?.authProgressOneSubmission === true) {
      (dependencies.emitAuthProgressReport || emitAuthProgressReport)(report, cleanupFailed);
    } else {
      (dependencies.emitReport || emitReport)(report, cleanupFailed);
    }
  }
}

// Emitted from the cleanup block, so the synthetic-only path that returns
// early and the scenario path that runs to completion report identically.
function emitReport(report, cleanupFailed) {
  if(cleanupFailed) {
    process.stdout.write(`${JSON.stringify({
      status: 'failed',
      stage: 'cleanup',
      ...(report?.gateBreakdown ? {gateBreakdown: report.gateBreakdown} : {})
    })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if(report.status !== 'passed') process.exitCode = 1;
}

function emitAuthProgressReport(report, cleanupFailed) {
  const finalReport = cleanupFailed
    ? {...report, status: 'failed', stage: 'cleanup'}
    : report;
  process.stdout.write(`${JSON.stringify(finalReport)}\n`);
  if(finalReport.status !== 'passed') process.exitCode = 1;
}

let runtime;
module.exports = {captureCenterColumnState, captureChannelMembershipState, captureGroupCreatedState, captureGroupMemberState, captureGroupMessageState, captureGroupNameFormState, countClientErrors, createNetworkObserver, createPageErrorAssetResolver, createPageErrorExceptionEvent, createWorkerDiscovery, emitAuthProgressReport, enrichPageErrorDetails, enrichPageErrorReport, getSingleExactMessageFailure, getSingleExactMessageTextFailure, installPageErrorEventCapture, main, matchesPrivateArtifactManifest, nameNewGroup, openBobGroupChat, openBobGroupMembers, openComposer, prepareUsernameEntry, recordPageError, recordPageErrorProtocolEvent, resolveActiveGroupChat, sendGroupText, submitUsernameOnceAndWaitForPassword, summarizeBrowserGateBreakdown, validateRuntimeInput, waitForChannelInviteCompletion, waitForGroupCreated, waitForGroupMessageCount, waitForPasswordField, submitPassword};
if(require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({status: 'failed', stage: currentStage, errorClass: 'OtherError'})}\n`);
    process.exitCode = 1;
  });
}
