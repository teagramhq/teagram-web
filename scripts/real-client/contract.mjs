import {closeSync, constants, fstatSync, lstatSync, openSync, readFileSync} from 'node:fs';
import {createHash, createPublicKey} from 'node:crypto';
import {basename, dirname, isAbsolute} from 'node:path';

import observation from './observation.cjs';

export const REQUIRED_SCENARIOS = Object.freeze(['sign-in', 'first-message', 'message', 'group']);
export const OPTIONAL_SCENARIOS = Object.freeze(['channel', 'poll']);
const AVAILABLE_SCENARIOS = Object.freeze([...REQUIRED_SCENARIOS, ...OPTIONAL_SCENARIOS]);
export const POLL_NEGATIVE_CONTROL_SERVER_REVISION = '586403c1f4c92c09b006652278bdd02fd40ddf2d';
export const POLL_NEGATIVE_CONTROL_EVIDENCE = Object.freeze([
  Object.freeze({shape: 'description', stage: 'alice_poll_description_create', errorType: 'POLL_ANSWERS_INVALID'}),
  Object.freeze({shape: 'input_answer', stage: 'alice_poll_input_answer_create', errorType: 'POLL_ANSWERS_INVALID'})
]);
export const REQUIRED_CONTROLS = Object.freeze(Object.keys(observation.CONTROL_EXPECTATIONS));
const REQUIRED_OBSERVATION_CONTEXTS = Object.freeze(['alice', 'bob']);
const AUTH_PROGRESS_OBSERVATION_CONTEXTS = Object.freeze(['alice']);
const AUTH_PROGRESS_WEBSOCKET_101_CONTEXTS = Object.freeze(['alice', 'control', 'other']);
const AUTH_PROGRESS_WEBSOCKET_101_PHASES = Object.freeze(['pre_submit', 'post_submit', 'unknown']);
const GATE_CONTEXTS = observation.GATE_CONTEXTS;
const GATE_EGRESS_SOURCES = observation.GATE_EGRESS_SOURCES;
const GATE_SCHEMES = observation.GATE_SCHEMES;
const GATE_RESOURCE_TYPES = observation.GATE_RESOURCE_TYPES;
const GATE_OBSERVER_ERROR_KINDS = observation.GATE_OBSERVER_ERROR_KINDS;
const PAGE_ERROR_CONSTRUCTORS = observation.GATE_PAGE_ERROR_CONSTRUCTORS;
const PAGE_ERROR_DIAGNOSTIC_LIMITS = observation.GATE_PAGE_ERROR_DIAGNOSTIC_LIMITS;
const PRIVATE_CSP_ORIGIN = observation.PRIVATE_CSP_ORIGIN;
const SCRIPT_ASSET = observation.SCRIPT_ASSET_PATTERN;
const PAGE_ERROR_MESSAGE_LIMIT = 512;
const PAGE_ERROR_STACK_FRAME_LIMIT = 16;
const PAGE_ERROR_FUNCTION_NAME_LIMIT = 128;
const PAGE_ERROR_STACK_STATES = Object.freeze(['unavailable', 'non_string', 'no_frames', 'unclassified_frames', 'captured', 'partial', 'truncated']);
const PAGE_ERROR_SCENARIOS = Object.freeze(['sign-in', 'first-message', 'message', 'group', 'channel', 'poll', 'unknown']);
const CLEANUP_FAILURE_CODES = Object.freeze([
  'browser_close_cleanup', 'context_cleanup', 'observer_cleanup', 'observer_control_cleanup',
  'playwright_trace_cleanup', 'screenshot_cleanup', 'worker_discovery_cleanup'
]);
const WORKER_OVERFLOW_REASONS = Object.freeze(['none', 'event_limit', 'attached_target_limit', 'websocket_request_limit']);
const RPC_ERROR_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const PAGE_DIAGNOSTIC_LIMIT = 16;
const PAGE_DIAGNOSTIC_STEP_LIMIT = 128;
const PAGE_DIAGNOSTIC_FIELD_LIMIT = 256;
const PAGE_DIAGNOSTIC_VALUE_TYPES = Object.freeze(['undefined', 'null', 'boolean', 'number', 'string', 'object', 'function']);
const PAGE_DIAGNOSTIC_SOURCES = Object.freeze(['error_event', 'unhandled_rejection', 'unknown']);
const PAGE_DIAGNOSTIC_RPC_METHOD = /^[a-z][A-Za-z0-9_]{0,63}\.[a-z][A-Za-z0-9_]{0,63}$/;
const PAGE_DIAGNOSTIC_RPC_CONSTRUCTORS = Object.freeze([
  'inputPeerUser', 'inputPeerChannel', 'inputPeerChat', 'inputPeerSelf',
  'inputUser', 'inputUserSelf', 'inputChannel', 'peerUser', 'peerChannel', 'peerChat',
  'inputUserFromMessage', 'inputPeerUserFromMessage', 'inputPeerChannelFromMessage', 'inputChannelFromMessage'
]);
const PAGE_DIAGNOSTIC_RPC_ARGUMENT_LIMIT = 8;
const AUTH_PROGRESS_REPORT_STAGES = Object.freeze([
  'runtime_inputs',
  'runtime_input_validation',
  'runtime_credential_validation',
  'browser_launch',
  'browser_worker_discovery',
  'observer_controls',
  'observer_control_mismatch',
  'alice_context',
  'alice_sign_in_form',
  'alice_artifact_load',
  'alice_manifest_load',
  'alice_manifest_mismatch',
  'alice_username_field',
  'alice_username_field_not_unique',
  'alice_password_form',
  'alice_password_field_ready',
  'alice_password_field_absent',
  'alice_password_field_not_unique',
  'alice_password_field_hidden',
  'alice_password_field_unmasked',
  'alice_password_card_not_reached',
  'browser_worker_observation',
  'browser_egress_or_page_errors',
  'browser_worker_observation_incomplete',
  'browser_worker_or_websocket_evidence',
  'worker_observation_unclassified',
  'cleanup'
]);

const FULL_SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_ARTIFACT_AUDIT_CHECKS = Object.freeze([
  'manifestMode',
  'manifestEndpoint',
  'manifestFingerprint',
  'manifestSourceCommit',
  'artifactDigest',
  'privateCSP',
  'privateTargetInBundle',
  'safeFileTypesAndPermissions',
  'routeCollisions'
]);

export function parseRequiredScenarios(value) {
  if(typeof value !== 'string' || !value.trim()) {
    throw new Error('scenario selection is required');
  }

  const scenarios = value.split(',').map((scenario) => scenario.trim());
  if(scenarios.every((scenario) => !scenario)) {
    throw new Error('scenario selection is required');
  }
  if(scenarios.some((scenario) => !scenario)) {
    throw new Error('scenario selection contains an empty entry');
  }

  const seen = new Set();
  for(const scenario of scenarios) {
    if(!AVAILABLE_SCENARIOS.includes(scenario)) {
      throw new Error(`unknown scenario: ${scenario}`);
    }
    if(seen.has(scenario)) {
      throw new Error(`duplicate scenario: ${scenario}`);
    }
    seen.add(scenario);
  }

  const missing = REQUIRED_SCENARIOS.filter((scenario) => !seen.has(scenario));
  if(missing.length) {
    throw new Error(`required scenarios are missing: ${missing.join(',')}`);
  }

  return AVAILABLE_SCENARIOS.filter((scenario) => seen.has(scenario));
}

export function expectedScreenshotCount({pollCreationNegativeControl = false, scenarios = REQUIRED_SCENARIOS} = {}) {
  const hasScenarios = Array.isArray(scenarios);
  const hasPollScenario = hasScenarios && scenarios.includes('poll');
  if(pollCreationNegativeControl && !hasPollScenario) {
    throw new Error('negative control requires poll scenario');
  }
  const channelScreenshots = hasScenarios && scenarios.includes('channel') ? 10 : 0;
  const pollScreenshots = hasPollScenario ? (pollCreationNegativeControl ? 4 : 14) : 0;
  return 20 + channelScreenshots + pollScreenshots;
}

export function expectedBrowserContextCount() {
  return REQUIRED_OBSERVATION_CONTEXTS.length;
}

export function parseRealClientArgs(argv) {
  const argumentsList = argv[0] === '--' ? argv.slice(1) : argv;
  if(argumentsList.includes('--help') || argumentsList.includes('-h')) {
    return {help: true};
  }
  if(argumentsList.length === 0) {
    throw new Error('missing required options');
  }

  const names = new Map([
    ['--readiness-file', 'readinessFile'],
    ['--harness-revision', 'harnessRevision'],
    ['--server-revision', 'serverRevision'],
    ['--web-revision', 'webRevision'],
    ['--run-id', 'runId'],
    ['--scenarios', 'scenarioSelection'],
    ['--observer-controls-only', 'observerControlsOnly'],
    ['--auth-progress-one-submission', 'authProgressOneSubmission'],
    ['--page-error-diagnostics', 'pageErrorDiagnostics'],
    ['--poll-creation-negative-control', 'pollCreationNegativeControl']
  ]);
  const options = new Map();
  for(let index = 0; index < argumentsList.length; index++) {
    const name = argumentsList[index];
    if(!names.has(name)) {
      throw new Error(`unknown option: ${name}`);
    }
    if(options.has(name)) {
      throw new Error(`option was provided more than once: ${name}`);
    }
    if(name === '--observer-controls-only' || name === '--auth-progress-one-submission' ||
        name === '--page-error-diagnostics' || name === '--poll-creation-negative-control') {
      options.set(name, true);
      continue;
    }
    const value = argumentsList[index + 1];
    if(typeof value !== 'string' || !value || value.startsWith('--')) {
      if(name === '--scenarios') throw new Error('scenario selection is required');
      throw new Error(`option requires a value: ${name}`);
    }
    options.set(name, value);
    index++;
  }

  const controlsOnly = options.get('--observer-controls-only') === true;
  const authProgress = options.get('--auth-progress-one-submission') === true;
  const pageErrorDiagnostics = options.get('--page-error-diagnostics') === true;
  const pollCreationNegativeControl = options.get('--poll-creation-negative-control') === true;
  if(authProgress && (controlsOnly || options.has('--scenarios'))) {
    throw new Error('--auth-progress-one-submission cannot be combined with --scenarios or --observer-controls-only');
  }
  if(controlsOnly && pageErrorDiagnostics) {
    throw new Error('--page-error-diagnostics cannot be combined with --observer-controls-only');
  }
  if(pollCreationNegativeControl && (controlsOnly || authProgress)) {
    throw new Error('--poll-creation-negative-control cannot be combined with --observer-controls-only or --auth-progress-one-submission');
  }
  if(!controlsOnly && !authProgress && !options.has('--scenarios')) {
    throw new Error('scenario selection is required');
  }

  const optional = new Set(['--scenarios', '--observer-controls-only', '--auth-progress-one-submission', '--page-error-diagnostics', '--poll-creation-negative-control']);
  const missing = [...names.keys()].filter((name) => !optional.has(name) && !options.has(name));
  if(missing.length) {
    throw new Error(`missing required options: ${missing.join(',')}`);
  }

  const parsed = Object.fromEntries([...options.entries()].map(([name, value]) => [names.get(name), value]));
  if(!FULL_SHA.test(parsed.harnessRevision) || !FULL_SHA.test(parsed.serverRevision) || !FULL_SHA.test(parsed.webRevision)) {
    throw new Error('all revisions must be full lowercase 40-character SHAs');
  }
  if(!RUN_ID.test(parsed.runId)) {
    throw new Error('run ID must be 128 bits of lowercase hexadecimal');
  }
  if(controlsOnly) {
    parsed.scenarios = [...REQUIRED_SCENARIOS];
  } else if(!authProgress) {
    parsed.scenarios = parseRequiredScenarios(parsed.scenarioSelection);
  }
  if(pollCreationNegativeControl) {
    if(!parsed.scenarios.includes('poll')) {
      throw new Error('--poll-creation-negative-control requires poll scenario');
    }
    if(parsed.serverRevision !== POLL_NEGATIVE_CONTROL_SERVER_REVISION) {
      throw new Error('--poll-creation-negative-control requires the pinned negative-control server revision');
    }
    parsed.pollCreationNegativeControl = true;
  }
  delete parsed.scenarioSelection;
  return parsed;
}

export function parseFixtureReadiness(text, expected, options = {}) {
  const requireArtifact = options.requireArtifact !== false;
  if(!expected || !RUN_ID.test(expected.runId || '') ||
      !FULL_SHA.test(expected.harnessRevision || '') ||
      !FULL_SHA.test(expected.serverRevision || '') ||
      !FULL_SHA.test(expected.webRevision || '')) {
    throw new Error('full fixture revision pins and run ID are required');
  }

  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if(lines.length !== (requireArtifact ? 2 : 1)) {
    throw new Error(requireArtifact ? 'both fixture readiness events are required' : 'one fixture readiness event is required');
  }

  let serverReady;
  let artifactReady;
  try {
    serverReady = JSON.parse(lines[0]);
    if(requireArtifact) artifactReady = JSON.parse(lines[1]);
  } catch {
    throw new Error('fixture readiness contains invalid JSON');
  }

  assertEventPins(serverReady, 'server-ready', expected);
  if(requireArtifact) {
    assertEventPins(artifactReady, 'artifact-ready', expected);
  }
  if(serverReady.endpoint !== 'https://teagramd.test' ||
      serverReady.wssEndpoint !== 'wss://teagramd.test/apiws' ||
      serverReady.mode !== 'private' ||
      (requireArtifact && (artifactReady.endpoint !== serverReady.endpoint ||
        artifactReady.wssEndpoint !== serverReady.wssEndpoint ||
        artifactReady.fingerprint !== serverReady.fingerprint))) {
    throw new Error('fixture endpoint or private target does not match');
  }

  if(!/^[0-9a-f]{16}$/.test(serverReady.fingerprint || '') ||
      !SHA256.test(serverReady.publicKeySHA256 || '') ||
      (requireArtifact && (!SHA256.test(artifactReady.manifestSHA256 || '') ||
        !SHA256.test(artifactReady.indexSHA256 || '') ||
        !/^sha256:[0-9a-f]{64}$/.test(artifactReady.artifactDigest || '') ||
        typeof artifactReady.manifestArtifactDigest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(artifactReady.manifestArtifactDigest)))) {
    throw new Error('fixture artifact identity is invalid');
  }

  assertServerReadyEvidence(serverReady);
  if(requireArtifact) {
    assertArtifactReadyEvidence(artifactReady);
  }

  return {serverReady, artifactReady};
}

export function readSyntheticCredentials(credentials, runId, count = 2) {
  if(!RUN_ID.test(runId || '') || !Array.isArray(credentials) || credentials.length !== 2 || ![1, 2].includes(count)) {
    throw new Error('two fixture credentials and a full run ID are required');
  }

  return credentials.slice(0, count).map((credential, index) => {
    const suffix = index === 0 ? 'a' : 'b';
    const username = `u${runId.slice(0, 30)}${suffix}`;
    const filePath = credential?.passwordFile;
    if(credential?.username !== username || typeof filePath !== 'string' || !isAbsolute(filePath) ||
        basename(filePath) !== `${suffix}-password`) {
      throw new Error('fixture synthetic credential reference is invalid');
    }

    let directoryInfo;
    let fileDescriptor;
    let fileInfo;
    let content;
    try {
      directoryInfo = lstatSync(dirname(filePath));
      fileDescriptor = openSync(filePath, constants.O_RDONLY | constants.O_CLOEXEC | constants.O_NOFOLLOW);
      fileInfo = fstatSync(fileDescriptor);
      if(fileInfo.size > 65) throw new Error('synthetic password file is too large');
      content = readFileSync(fileDescriptor, 'utf8');
    } catch {
      throw new Error('fixture synthetic password file is unavailable');
    } finally {
      if(fileDescriptor !== undefined) closeSync(fileDescriptor);
    }

    if(!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
        (directoryInfo.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && directoryInfo.uid !== process.getuid()) ||
        !basename(dirname(filePath)).startsWith(`teagram-fixture-${runId}.`) ||
        !fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1 ||
        (typeof process.getuid === 'function' && fileInfo.uid !== process.getuid()) ||
        (fileInfo.mode & 0o777) !== 0o400 || !/^[0-9a-f]{64}\n?$/.test(content)) {
      throw new Error('synthetic password file is not protected');
    }

    return {username, password: content.endsWith('\n') ? content.slice(0, -1) : content};
  });
}

function assertEventPins(event, name, expected) {
  if(event?.event !== name || event.status !== 'ready' ||
      event.runId !== expected.runId ||
      event.harnessRevision !== expected.harnessRevision ||
      event.serverRevision !== expected.serverRevision ||
      event.webRevision !== expected.webRevision) {
    throw new Error(`${name} does not match the requested immutable inputs`);
  }
}

function assertServerReadyEvidence(ready) {
  const security = ready.security;
  const evidence = ready.evidence;
  const workers = evidence?.workerProbes;
  const observer = evidence?.observerControlledAttempts;
  const workerTypes = ['page', 'shared_worker', 'service_worker'];

  if(security?.registrationClosed !== true || security.loginCodeLogging !== false ||
      security.electionClosed !== true || security.administratorIsNull !== true ||
      security.ordinaryUsers !== 2 || security.usernameAccounts !== 2 ||
      security.passwordVerifiers !== 2 || security.initialAuthKeys !== 0 || security.initialMessages !== 0 || security.finalAuthKeys !== 2 ||
      evidence?.httpStatus !== 200 || evidence.wssUpgradeStatus !== 101 || evidence.allowedWssObserved !== 1 ||
      evidence.unexpectedAttempts !== 0 || evidence.unexpectedDetectionVerified !== true ||
      evidence.directTCP?.attempted !== 5 || evidence.directTCP.blocked !== 5 ||
      ready.evidenceClass !== 'production-teagramd' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(ready.leafSPKI || '') ||
      Buffer.from(ready.leafSPKI, 'base64').byteLength !== 32 ||
      typeof ready.mtprotoPublicKeyPEM !== 'string' ||
      !ready.mtprotoPublicKeyPEM.startsWith('-----BEGIN PUBLIC KEY-----\n') ||
      !ready.mtprotoPublicKeyPEM.endsWith('-----END PUBLIC KEY-----') ||
      createHash('sha256').update(ready.mtprotoPublicKeyPEM).digest('hex') !== ready.publicKeySHA256) {
    throw new Error('server-ready security evidence is incomplete');
  }

  let publicKey;
  try {
    publicKey = createPublicKey(ready.mtprotoPublicKeyPEM);
  } catch {
    throw new Error('server-ready MTProto public key is invalid');
  }
  if(publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails?.modulusLength !== 2048) {
    throw new Error('server-ready MTProto public key has an unexpected type');
  }

  for(const type of workerTypes) {
    if(workers?.[type]?.attempted !== 8 || workers[type].blocked !== 8 || observer?.[type] !== 8) {
      throw new Error('server-ready page and worker egress evidence is incomplete');
    }
  }

  const credentials = ready.credentials;
  const prefix = `u${ready.runId.slice(0, 30)}`;
  if(!Array.isArray(credentials) || credentials.length !== 2 ||
      credentials[0]?.username !== `${prefix}a` || credentials[1]?.username !== `${prefix}b` ||
      credentials.some((credential) => typeof credential?.passwordFile !== 'string' || !credential.passwordFile.startsWith('/'))) {
    throw new Error('server-ready synthetic credentials are invalid');
  }
}

function assertArtifactReadyEvidence(ready) {
  const checks = ready.auditChecks;
  const browser = ready.browser;
  if(!checks || JSON.stringify(Object.keys(checks).sort()) !== JSON.stringify([...REQUIRED_ARTIFACT_AUDIT_CHECKS].sort()) ||
      Object.values(checks).some((passed) => passed !== true) ||
      !/^sha256:[0-9a-f]{64}$/.test(ready.artifactDigest || '') ||
      browser?.status !== 'passed' || browser.entryResponseStatus !== 200 || browser.manifestResponseStatus !== 200 ||
      !Number.isSafeInteger(browser.artifactResponses) || browser.artifactResponses < 1 ||
      browser.artifactResponsesWithPrivateCSP !== browser.artifactResponses ||
      !Number.isSafeInteger(browser.workerTargets?.shared_worker) || browser.workerTargets.shared_worker < 1 ||
      !Number.isSafeInteger(browser.workerTargets?.service_worker) || browser.workerTargets.service_worker < 1 ||
      browser.unexpectedAttempts !== 0 || browser.observerErrors !== 0) {
    throw new Error('artifact-ready audit or browser evidence is incomplete');
  }
}

// The runner's worker observation block is a closed schema. Anything the
// report does not prove is a failure of the evidence, never a pass: an
// `unclassified` block, a missing control, an unknown coverage state, a foreign
// target, an overflow, or a context owning more than one page.
export function parseWorkerObservation(block) {
  return parseWorkerObservationForContexts(block, REQUIRED_OBSERVATION_CONTEXTS);
}

export function parseAuthProgressWorkerObservation(block) {
  if(!block || typeof block !== 'object' || Array.isArray(block) || block.classification === 'unclassified' ||
      observation.validateNetworkBlock(block)) {
    throw new Error('isolated browser worker observation does not match the closed schema');
  }
  if(block.discoveryActive !== 1 || block.foreignTargets !== 0 || block.appContextlessTargets !== 0 || block.observerOverflow !== 0) {
    throw new Error('isolated browser worker observation is incomplete');
  }
  const controls = Object.keys(block.controls).sort();
  if(JSON.stringify(controls) !== JSON.stringify([...REQUIRED_CONTROLS].sort()) ||
      REQUIRED_CONTROLS.some((name) => block.controls[name].expected !== 'pass')) {
    throw new Error('observer synthetic controls are incomplete');
  }
  const contexts = Object.keys(block.contexts).sort();
  if(JSON.stringify(contexts) !== JSON.stringify([...AUTH_PROGRESS_OBSERVATION_CONTEXTS].sort())) {
    throw new Error('worker observation app contexts are incomplete');
  }
  const alice = block.contexts.alice;
  if(alice.pageTargets !== 1 || alice.coverageComplete !== 1) {
    throw new Error('alice shared-worker observation coverage is incomplete');
  }
  return block;
}

function parseWorkerObservationForContexts(block, expectedContexts) {
  if(!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error('isolated browser worker observation is missing');
  }
  if(block.classification === 'unclassified') {
    throw new Error('isolated browser worker observation is unclassified');
  }
  if(observation.validateNetworkBlock(block)) {
    throw new Error('isolated browser worker observation does not match the closed schema');
  }
  if(block.discoveryActive !== 1) {
    throw new Error('browser-level shared-worker discovery was never active');
  }
  if(block.foreignTargets !== 0) {
    throw new Error('shared-worker targets were observed outside the runner contexts');
  }
  if(block.appContextlessTargets !== 0) {
    throw new Error('app shared-worker targets were never attributed to a browser context');
  }
  if(block.observerOverflow !== 0) {
    throw new Error('browser worker observer overflowed a resource bound');
  }
  const controls = Object.keys(block.controls).sort();
  if(JSON.stringify(controls) !== JSON.stringify([...REQUIRED_CONTROLS].sort())) {
    throw new Error('observer synthetic controls are incomplete');
  }
  for(const name of REQUIRED_CONTROLS) {
    if(block.controls[name].expected !== 'pass') {
      throw new Error(`observer synthetic control ${name} did not pass`);
    }
  }
  const contexts = Object.keys(block.contexts).sort();
  if(JSON.stringify(contexts) !== JSON.stringify([...expectedContexts].sort())) {
    throw new Error('worker observation app contexts are incomplete');
  }
  for(const name of expectedContexts) {
    const context = block.contexts[name];
    if(context.pageTargets !== 1) throw new Error(`${name} does not own exactly one page`);
    if(context.coverageComplete !== 1) throw new Error(`${name} shared-worker observation coverage is incomplete`);
    if(name === 'guest') continue;
    if(context.mtprotoSourceFetch === 'not_requested') throw new Error(`${name} never fetched the MTProto worker source`);
    if(context.mtprotoSourceChunk !== 'mtproto_worker') throw new Error(`${name} MTProto worker source is not an allowlisted chunk`);
    if(context.mtprotoWorker === 'unknown') throw new Error(`${name} MTProto shared-worker state is unknown`);
  }
  return block;
}

// The synthetic-only evidence: the fixture's own probe controls, with no app
// context in the block. Every control must pass and coverage must be complete.
export function parseObserverControls(block) {
  if(!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error('observer control evidence is missing');
  }
  if(block.classification === 'unclassified') {
    throw new Error('observer control evidence is unclassified');
  }
  if(observation.validateNetworkBlock(block)) {
    throw new Error('observer control evidence does not match the closed schema');
  }
  if(block.discoveryActive !== 1) throw new Error('browser-level shared-worker discovery was never active');
  if(block.foreignTargets !== 0) throw new Error('shared-worker targets were observed outside the runner contexts');
  if(block.appContextlessTargets !== 0) throw new Error('app shared-worker targets were never attributed to a browser context');
  if(Object.keys(block.contexts).length !== 0) throw new Error('observer control evidence carries app contexts');
  const controls = Object.keys(block.controls).sort();
  if(JSON.stringify(controls) !== JSON.stringify([...REQUIRED_CONTROLS].sort())) {
    throw new Error('observer synthetic controls are incomplete');
  }
  for(const name of REQUIRED_CONTROLS) {
    if(block.controls[name].expected !== 'pass') {
      throw new Error(`observer synthetic control ${name} did not pass`);
    }
  }
  return block;
}

export function parsePasswordEvidence(evidence) {
  if(!Array.isArray(evidence)) throw new Error('password evidence is invalid');

  const seenAccounts = new Set();
  return evidence.map((entry) => {
    if(!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['count', 'stage']) ||
        typeof entry.stage !== 'string' || !Number.isSafeInteger(entry.count) || entry.count < 0 || entry.count > 1_000_000) {
      throw new Error('password evidence is invalid');
    }

    const match = /^(alice|bob)_(password_field_ready|password_field_absent|password_field_not_unique|password_field_hidden|password_field_unmasked|password_card_not_reached)$/.exec(entry.stage);
    if(!match || seenAccounts.has(match[1])) throw new Error('password evidence is invalid');
    seenAccounts.add(match[1]);

    const category = match[2];
    if((category === 'password_field_absent' && entry.count !== 0) ||
        (category === 'password_field_not_unique' && entry.count < 2) ||
        (category === 'password_card_not_reached' && entry.count > 1) ||
        (!['password_field_absent', 'password_field_not_unique', 'password_card_not_reached'].includes(category) && entry.count !== 1)) {
      throw new Error('password evidence is invalid');
    }

    return {stage: entry.stage, count: entry.count};
  });
}

const CENTER_COLUMN_COUNT_KEYS = ['chatCount', 'activeChatCount', 'composerMatches', 'composerInputs', 'composerFakeInputs', 'composerVisible', 'composerEditable'];
const CENTER_COLUMN_ENUMS = Object.freeze({
  chatInput: ['absent', 'hidden', 'visible'],
  controlBar: ['none', 'multiple', 'frozen', 'start', 'unblock', 'join', 'mute', 'unmute', 'open_chat', 'other'],
  composerWait: ['none', 'timeout', 'strict_mode_violation', 'other']
});
const CENTER_COLUMN_PEER_KEYS = ['activePeerId', 'selectedPeerId'];
const CENTER_COLUMN_ERROR_KEYS = ['pageErrorsSinceSelection', 'consoleErrorsSinceSelection', 'rpcErrorsSinceSelection'];
const RPC_ERROR_TYPE_LIMIT = 16;

// Closed schema: fixed counts, enums and numeric peer ids. Anything else is
// reported as `unclassified` rather than passed through.
export function parseCenterColumnState(state) {
  if(state === 'unavailable') return state;
  const keys = [...CENTER_COLUMN_COUNT_KEYS, ...Object.keys(CENTER_COLUMN_ENUMS), ...CENTER_COLUMN_PEER_KEYS, ...CENTER_COLUMN_ERROR_KEYS, 'rpcErrorTypesSinceSelection'];
  const isCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
  const rpcTypes = state?.rpcErrorTypesSinceSelection;
  const isRpcTypes = rpcTypes === null || (!!rpcTypes && typeof rpcTypes === 'object' && !Array.isArray(rpcTypes) &&
    Object.keys(rpcTypes).length <= RPC_ERROR_TYPE_LIMIT &&
    Object.entries(rpcTypes).every(([type, count]) => /^[A-Z][A-Z0-9_]{1,63}$/.test(type) && isCount(count) && count > 0));
  if(!state || typeof state !== 'object' || Array.isArray(state) ||
      JSON.stringify(Object.keys(state).sort()) !== JSON.stringify([...keys].sort()) ||
      !CENTER_COLUMN_COUNT_KEYS.every((key) => isCount(state[key])) ||
      !Object.entries(CENTER_COLUMN_ENUMS).every(([key, values]) => values.includes(state[key])) ||
      !CENTER_COLUMN_PEER_KEYS.every((key) => state[key] === null || (typeof state[key] === 'string' && /^-?[0-9]{1,20}$/.test(state[key]))) ||
      !CENTER_COLUMN_ERROR_KEYS.every((key) => state[key] === null || isCount(state[key])) ||
      !isRpcTypes || (rpcTypes === null) !== (state.rpcErrorsSinceSelection === null)) {
    return 'unclassified';
  }
  return Object.fromEntries(keys.map((key) => [key, state[key]]));
}

const GROUP_NAME_FORM_COUNT_KEYS = ['formCount', 'visibleInputs', 'visibleEditables', 'nameFieldMatches', 'nameFieldVisible', 'confirmCount'];
const GROUP_NAME_FORM_FLAG_KEYS = ['formVisible', 'nameHasValue', 'confirmShown', 'confirmEnabled'];

// Closed schema like the centre column: fixed counts, booleans and the step
// wait's outcome, anything else is `unclassified`.
export function parseGroupNameFormState(state) {
  if(state === 'unavailable') return state;
  const keys = [...GROUP_NAME_FORM_COUNT_KEYS, ...GROUP_NAME_FORM_FLAG_KEYS, 'stepWait'];
  const isCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
  if(!state || typeof state !== 'object' || Array.isArray(state) ||
      JSON.stringify(Object.keys(state).sort()) !== JSON.stringify([...keys].sort()) ||
      !GROUP_NAME_FORM_COUNT_KEYS.every((key) => isCount(state[key])) ||
      !GROUP_NAME_FORM_FLAG_KEYS.every((key) => typeof state[key] === 'boolean') ||
      !CENTER_COLUMN_ENUMS.composerWait.includes(state.stepWait)) {
    return 'unclassified';
  }
  return Object.fromEntries(keys.map((key) => [key, state[key]]));
}

const GROUP_CREATED_ACTIVE_CHATS = ['group', 'user', 'none'];

// Closed schema: the active chat's kind, the chat count, whether a header
// carrying the group name is visible and the step wait's outcome.
export function parseGroupCreatedState(state) {
  if(state === 'unavailable') return state;
  const keys = ['activeChat', 'chatCount', 'groupHeaderVisible', 'stepWait'];
  if(!state || typeof state !== 'object' || Array.isArray(state) ||
      JSON.stringify(Object.keys(state).sort()) !== JSON.stringify([...keys].sort()) ||
      !GROUP_CREATED_ACTIVE_CHATS.includes(state.activeChat) ||
      !Number.isSafeInteger(state.chatCount) || state.chatCount < 0 || state.chatCount > 1_000_000 ||
      typeof state.groupHeaderVisible !== 'boolean' ||
      !CENTER_COLUMN_ENUMS.composerWait.includes(state.stepWait)) {
    return 'unclassified';
  }
  return Object.fromEntries(keys.map((key) => [key, state[key]]));
}

const GROUP_MEMBER_ACTIVE_PANELS = ['none', 'profile', 'media', 'members', 'edit', 'other'];
const GROUP_MEMBER_STEP_WAITS = ['none', 'timeout', 'strict_mode_violation', 'other'];
const GROUP_MEMBER_ERROR_KEYS = ['pageErrorsSinceStep', 'consoleErrorsSinceStep', 'rpcErrorsSinceStep'];
const GROUP_MEMBER_TAB_ACTIONABILITY_REASONS = ['none', 'intercepted', 'not_stable', 'not_visible', 'not_enabled', 'not_attached', 'outside_viewport', 'timeout', 'other'];

const GROUP_MESSAGE_SEND_STATES = ['pending', 'sent', 'failed'];
const GROUP_MESSAGE_RESULTS = [
  'pending',
  'transient_pair',
  'sent',
  'settled',
  'disappeared',
  'missing_message_id',
  'failed_bubble',
  'multiple_ids',
  'duplicate_bubbles',
  'settle_timeout',
  'stability_timeout',
  'read_error'
];

// Counts and numeric message ids only; the message text and any page error
// content stay out of the report.
export function parseGroupMessageState(state) {
  if(state === 'unavailable') return state;
  const keys = ['samples', 'distinctIds', 'distinctServerIds', 'pageErrorsSinceStep', 'consoleErrorsSinceStep', 'rpcErrorsSinceStep', 'result'];
  const isCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
  const isNullableCount = (value) => value === null || isCount(value);
  const isSample = (sample) => {
    if(!sample || typeof sample !== 'object' || Array.isArray(sample) ||
        JSON.stringify(Object.keys(sample).sort()) !== JSON.stringify(['count', 'bubbles', 'distinctIds', 'distinctServerIds'].sort()) ||
        !isCount(sample.count) || !Array.isArray(sample.bubbles) || sample.bubbles.length !== sample.count ||
        typeof sample.distinctIds !== 'boolean' || typeof sample.distinctServerIds !== 'boolean') return false;
    if(!sample.bubbles.every((bubble) => bubble && typeof bubble === 'object' && !Array.isArray(bubble) &&
        JSON.stringify(Object.keys(bubble).sort()) === JSON.stringify(['messageId', 'sendState'].sort()) &&
        (bubble.messageId === null || typeof bubble.messageId === 'string' && /^-?[0-9]{1,20}(\.[0-9]{1,4})?$/.test(bubble.messageId)) &&
        GROUP_MESSAGE_SEND_STATES.includes(bubble.sendState))) return false;
    const ids = sample.bubbles.map((bubble) => bubble.messageId).filter((id) => id !== null);
    const serverIds = sample.bubbles.filter((bubble) => bubble.sendState === 'sent').map((bubble) => bubble.messageId).filter((id) => id !== null);
    return sample.distinctIds === (new Set(ids).size > 1) && sample.distinctServerIds === (new Set(serverIds).size > 1);
  };
  if(!state || typeof state !== 'object' || Array.isArray(state) ||
      JSON.stringify(Object.keys(state).sort()) !== JSON.stringify([...keys].sort()) ||
      !Array.isArray(state.samples) || state.samples.length > 128 || !state.samples.every(isSample) ||
      typeof state.distinctIds !== 'boolean' || state.distinctIds !== state.samples.some((sample) => sample.distinctIds) ||
      typeof state.distinctServerIds !== 'boolean' || state.distinctServerIds !== state.samples.some((sample) => sample.distinctServerIds) ||
      !GROUP_MESSAGE_RESULTS.includes(state.result) ||
      !['pageErrorsSinceStep', 'consoleErrorsSinceStep', 'rpcErrorsSinceStep'].every((key) => isNullableCount(state[key]))) {
    return 'unclassified';
  }
  return Object.fromEntries(keys.map((key) => [key, state[key]]));
}

// Closed schema: identifies the active right-column panel and exposes counts
// only. Peer ids, titles, messages and exception text never enter the report.
export function parseGroupMemberState(state) {
  if(state === 'unavailable') return state;
  const keys = ['activePanel', 'profileMatchesActiveGroup', 'membersTabExists', 'membersListExists', 'memberRowCount', 'membersTab', ...GROUP_MEMBER_ERROR_KEYS, 'stepWait'];
  const isCount = (value) => value === null || Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
  const isDomElement = (value, expectedKeys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort()) &&
    typeof value.tag === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value.tag) &&
    Array.isArray(value.classes) && value.classes.length <= 16 && value.classes.every((name) => typeof name === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(name));
  const tab = state?.membersTab;
  const validMembersTab = tab !== null && typeof tab === 'object' && !Array.isArray(tab) &&
    JSON.stringify(Object.keys(tab).sort()) === JSON.stringify(['panelActiveBefore', 'panelActiveAfter', 'target', 'paired', 'actionabilityReason', 'interceptedBy'].sort()) &&
    (tab.panelActiveBefore === null || typeof tab.panelActiveBefore === 'boolean') &&
    (tab.panelActiveAfter === null || typeof tab.panelActiveAfter === 'boolean') &&
    (tab.target === null || isDomElement(tab.target, ['index', 'tag', 'classes']) && Number.isSafeInteger(tab.target.index) && tab.target.index >= 0 && tab.target.index <= 10_000) &&
    (tab.paired === null || typeof tab.paired === 'boolean') &&
    GROUP_MEMBER_TAB_ACTIONABILITY_REASONS.includes(tab.actionabilityReason) &&
    (tab.interceptedBy === null || isDomElement(tab.interceptedBy, ['tag', 'classes'])) &&
    (tab.actionabilityReason === 'intercepted' || tab.interceptedBy === null);
  if(!state || typeof state !== 'object' || Array.isArray(state) ||
      JSON.stringify(Object.keys(state).sort()) !== JSON.stringify([...keys].sort()) ||
      !GROUP_MEMBER_ACTIVE_PANELS.includes(state.activePanel) ||
      typeof state.profileMatchesActiveGroup !== 'boolean' ||
      typeof state.membersTabExists !== 'boolean' ||
      typeof state.membersListExists !== 'boolean' ||
      !Number.isSafeInteger(state.memberRowCount) || state.memberRowCount < 0 || state.memberRowCount > 1_000_000 ||
      !validMembersTab ||
      !GROUP_MEMBER_ERROR_KEYS.every((key) => isCount(state[key])) ||
      !GROUP_MEMBER_STEP_WAITS.includes(state.stepWait)) {
    return 'unclassified';
  }
  const membersTab = {
    panelActiveBefore: tab.panelActiveBefore,
    panelActiveAfter: tab.panelActiveAfter,
    target: tab.target === null ? null : {index: tab.target.index, tag: tab.target.tag, classes: [...tab.target.classes]},
    paired: tab.paired,
    actionabilityReason: tab.actionabilityReason,
    interceptedBy: tab.interceptedBy === null ? null : {tag: tab.interceptedBy.tag, classes: [...tab.interceptedBy.classes]}
  };
  return Object.fromEntries(keys.map((key) => [key, key === 'membersTab' ? membersTab : state[key]]));
}

const CHANNEL_MEMBERSHIP_PAGE_KEYS = [
  'channelRowCount',
  'channelTitleMatches',
  'activePeerId',
  'chatListRowCount',
  'pageErrorsSinceStep',
  'consoleErrorsSinceStep',
  'rpcErrorsSinceStep',
  'rpcErrorTypesSinceStep'
];
const CHANNEL_MEMBERSHIP_STEP_WAITS = ['none', 'timeout', 'strict_mode_violation', 'other'];
// Channel admission crosses two live clients. Keep only row counts, numeric
// peer ids and sanitized error counts/types when describing a failed wait.
export function parseChannelMembershipState(state) {
  if(state === 'unavailable') return state;
  const keys = ['channelPeerId', 'selectedBobPeerId', 'alice', 'bob', 'stepWait'];
  const isCount = (value) => value === null || Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
  const isPeerId = (value, allowNegative = true) => value === null || typeof value === 'string' &&
    (allowNegative ? /^-?[0-9]{1,20}$/ : /^[0-9]{1,20}$/).test(value);
  const isRpcTypes = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length <= 16 && Object.entries(value).every(([type, count]) =>
      /^[A-Z][A-Z0-9_]{1,63}$/.test(type) && Number.isSafeInteger(count) && count > 0 && count <= 1_000_000
    );
  const isClient = (client) => client !== null && typeof client === 'object' && !Array.isArray(client) &&
    JSON.stringify(Object.keys(client).sort()) === JSON.stringify([...CHANNEL_MEMBERSHIP_PAGE_KEYS].sort()) &&
    Number.isSafeInteger(client.channelRowCount) && client.channelRowCount >= 0 && client.channelRowCount <= 1_000_000 &&
    Number.isSafeInteger(client.channelTitleMatches) && client.channelTitleMatches >= 0 && client.channelTitleMatches <= 1_000_000 &&
    isPeerId(client.activePeerId) &&
    Number.isSafeInteger(client.chatListRowCount) && client.chatListRowCount >= 0 && client.chatListRowCount <= 1_000_000 &&
    isCount(client.pageErrorsSinceStep) && isCount(client.consoleErrorsSinceStep) && isCount(client.rpcErrorsSinceStep) &&
    isRpcTypes(client.rpcErrorTypesSinceStep);
  if(!state || typeof state !== 'object' || Array.isArray(state) ||
      JSON.stringify(Object.keys(state).sort()) !== JSON.stringify([...keys].sort()) ||
      typeof state.channelPeerId !== 'string' || !/^-?[0-9]{1,20}$/.test(state.channelPeerId) ||
      !state.channelPeerId.startsWith('-') ||
      typeof state.selectedBobPeerId !== 'string' || !/^[0-9]{1,20}$/.test(state.selectedBobPeerId) ||
      !isClient(state.alice) || !isClient(state.bob) ||
      !CHANNEL_MEMBERSHIP_STEP_WAITS.includes(state.stepWait)) {
    return 'unclassified';
  }
  return Object.fromEntries(keys.map((key) => [key, state[key]]));
}

function parseCleanupFailureCodes(value) {
  if(value === undefined) return [];
  if(!Array.isArray(value) || value.length > CLEANUP_FAILURE_CODES.length ||
      value.some((entry) => !CLEANUP_FAILURE_CODES.includes(entry)) || new Set(value).size !== value.length) {
    throw new Error('cleanup failure evidence is invalid');
  }
  return [...value].sort();
}

function parseWorkerOverflowReasons(value) {
  if(!(hasExactOwnKeys(value, ['alice']) || hasExactOwnKeys(value, ['alice', 'bob']) ||
      hasExactOwnKeys(value, ['alice', 'bob', 'guest'])) ||
      Object.values(value).some((reason) => !WORKER_OVERFLOW_REASONS.includes(reason))) {
    throw new Error('worker overflow reason evidence is invalid');
  }
  return value;
}

export function formatBrowserFailureMessage(report, controlsOnly = false) {
  const hasPasswordEvidence = report.passwordEvidence !== undefined;
  const failedPasswordEvidence = controlsOnly || !hasPasswordEvidence
    ? []
    : parsePasswordEvidence(report.passwordEvidence);
  const evidenceSummary = controlsOnly || !hasPasswordEvidence
    ? ''
    : `; password evidence ${JSON.stringify(failedPasswordEvidence)}`;
  const centerColumnSummary = controlsOnly || report.centerColumn === undefined
    ? ''
    : `; centre column ${JSON.stringify(parseCenterColumnState(report.centerColumn))}`;
  const groupNameFormSummary = controlsOnly || report.groupNameForm === undefined
    ? ''
    : `; group name form ${JSON.stringify(parseGroupNameFormState(report.groupNameForm))}`;
  const groupCreatedSummary = controlsOnly || report.groupCreated === undefined
    ? ''
    : `; group created ${JSON.stringify(parseGroupCreatedState(report.groupCreated))}`;
  const groupMemberSummary = controlsOnly || report.groupMember === undefined
    ? ''
    : `; group members ${JSON.stringify(parseGroupMemberState(report.groupMember))}`;
  const groupMessageSummary = controlsOnly || report.groupMessage === undefined
    ? ''
    : `; group message ${JSON.stringify(parseGroupMessageState(report.groupMessage))}`;
  const channelMembershipSummary = controlsOnly || report.channelMembership === undefined
    ? ''
    : `; channel membership ${JSON.stringify(parseChannelMembershipState(report.channelMembership))}`;
  if(report.stage === 'browser_egress_or_page_errors' && report.status === 'failed' && report.gateBreakdown === undefined) {
    throw new Error('browser egress/page error evidence is invalid');
  }
  const gateBreakdownSummary = report.gateBreakdown === undefined
    ? ''
    : `; browser egress/page errors ${JSON.stringify(parseBrowserGateBreakdown(report.gateBreakdown))}`;
  const cleanupFailures = parseCleanupFailureCodes(report.cleanupFailures);
  const cleanupSummary = cleanupFailures.length > 0
    ? `; cleanup failures ${JSON.stringify(cleanupFailures)}`
    : '';
  const workerOverflowSummary = report.workerOverflowReasons === undefined
    ? ''
    : `; worker overflow reasons ${JSON.stringify(parseWorkerOverflowReasons(report.workerOverflowReasons))}`;
  let workerCoverageSummary = '';
  if(report.stage === 'browser_worker_observation_incomplete' && report.status === 'failed') {
    try {
      workerCoverageSummary = `; worker coverage ${JSON.stringify(parseWorkerCoverageBreakdown(report.workerCoverageBreakdown))}`;
    } catch{
      throw new Error('worker coverage evidence is invalid');
    }
  }
  return `real client scenario failed at ${report.stage || 'unknown stage'}${evidenceSummary}${centerColumnSummary}${groupNameFormSummary}${groupCreatedSummary}${groupMemberSummary}${groupMessageSummary}${channelMembershipSummary}${gateBreakdownSummary}${workerCoverageSummary}${cleanupSummary}${workerOverflowSummary}`;
}

function parseWorkerCoverageBreakdown(value) {
  const registryKeys = ['discoveryInactive', 'foreignTargets', 'contextlessTargets', 'appContextlessTargets', 'targetDetailsOverflow'];
  const contextKeys = [
    'discoveryInactive',
    'pageCoverageIncomplete',
    'windowNotElapsed',
    'observerOverflow',
    'observerErrors',
    'foreignTargets',
    'countedEvents',
    'attachedTargets',
    'pageTargets',
    'multiplePageTargets',
    'coverageComplete'
  ];
  const targetTypes = ['page', 'iframe', 'service_worker', 'shared_worker', 'dedicated_worker', 'other'];
  const causes = ['multiple_pages', 'foreign', 'contextless', 'observer_overflow', 'observer_error'];
  const workerContexts = Object.keys(value?.contexts || {}).sort();
  if(!hasExactOwnKeys(value, ['registry', 'contexts', 'targets']) ||
      !hasExactOwnKeys(value.registry, registryKeys) ||
      !([
        ['alice'],
        ['alice', 'bob'],
        ['alice', 'bob', 'guest']
      ].some((contextNames) => JSON.stringify(workerContexts) === JSON.stringify(contextNames))) ||
      !Array.isArray(value.targets) || value.targets.length > 1024) {
    throw new Error('worker coverage evidence is invalid');
  }

  for(const key of ['discoveryInactive']) {
    if(![0, 1].includes(value.registry[key])) throw new Error('worker coverage evidence is invalid');
  }
  if(![0, 1].includes(value.registry.targetDetailsOverflow)) throw new Error('worker coverage evidence is invalid');
  for(const key of ['foreignTargets', 'contextlessTargets', 'appContextlessTargets']) {
    if(!Number.isSafeInteger(value.registry[key]) || value.registry[key] < 0 || value.registry[key] > 1_000_000) {
      throw new Error('worker coverage evidence is invalid');
    }
  }
  for(const context of Object.values(value.contexts)) {
    if(!hasExactOwnKeys(context, contextKeys) ||
        ['discoveryInactive', 'pageCoverageIncomplete', 'windowNotElapsed', 'observerOverflow', 'multiplePageTargets', 'coverageComplete']
          .some((key) => ![0, 1].includes(context[key])) ||
        ['observerErrors', 'foreignTargets', 'countedEvents', 'attachedTargets', 'pageTargets'].some((key) =>
          !Number.isSafeInteger(context[key]) || context[key] < 0 || context[key] > 1_000_000)) {
      throw new Error('worker coverage evidence is invalid');
    }
    if(context.countedEvents > observation.LIMITS.countedEventsPerContext || context.attachedTargets > observation.LIMITS.attachedTargets) {
      throw new Error('worker coverage evidence is invalid');
    }
  }
  for(const target of value.targets) {
    if(!hasExactOwnKeys(target, ['targetType', 'owningContext', 'scriptAsset', 'causes']) ||
        !targetTypes.includes(target.targetType) ||
        !(target.owningContext === null || ['alice', 'bob', 'guest', 'control'].includes(target.owningContext)) ||
        typeof target.scriptAsset !== 'string' || !SCRIPT_ASSET.test(target.scriptAsset) ||
        !Array.isArray(target.causes) || target.causes.length < 1 || target.causes.length > causes.length ||
        target.causes.some((cause) => !causes.includes(cause)) || new Set(target.causes).size !== target.causes.length) {
      throw new Error('worker coverage evidence is invalid');
    }
  }
  return value;
}

export function parseAuthProgressReport(report) {
  const keys = [
    'status',
    'mode',
    'stage',
    'usernameSubmissions',
    'passwordFills',
    'passwordSubmissions',
    'bobContextCount',
    'laterScenarioCount',
    'contextCount',
    'controlContextCount',
    'screenshotsCaptured',
    'passwordEvidence',
    'network',
    'workerObservation'
  ];
  const hasGateBreakdown = Object.hasOwn(report || {}, 'gateBreakdown');
  const hasWorkerCoverageBreakdown = Object.hasOwn(report || {}, 'workerCoverageBreakdown');
  const reportKeys = [
    ...keys,
    ...(hasGateBreakdown ? ['gateBreakdown'] : []),
    ...(hasWorkerCoverageBreakdown ? ['workerCoverageBreakdown'] : [])
  ];
  if(!report || typeof report !== 'object' || Array.isArray(report) ||
      JSON.stringify(Object.keys(report).sort()) !== JSON.stringify([...reportKeys].sort()) ||
      report.mode !== 'auth_progress_one_submission' ||
      !['passed', 'failed'].includes(report.status) ||
      (hasWorkerCoverageBreakdown && report.status !== 'failed') ||
      !AUTH_PROGRESS_REPORT_STAGES.includes(report.stage) ||
      !Number.isSafeInteger(report.usernameSubmissions) || report.usernameSubmissions < 0 || report.usernameSubmissions > 1 ||
      report.passwordFills !== 0 || report.passwordSubmissions !== 0 ||
      report.bobContextCount !== 0 || report.laterScenarioCount !== 0 ||
      !Number.isSafeInteger(report.contextCount) || report.contextCount < 0 || report.contextCount > 1 ||
      !Number.isSafeInteger(report.controlContextCount) || report.controlContextCount < 0 || report.controlContextCount > REQUIRED_CONTROLS.length ||
      report.screenshotsCaptured !== 0) {
    throw new Error('auth progress report is invalid');
  }

  let gateBreakdown;
  if(hasGateBreakdown || (report.status === 'failed' && report.stage === 'browser_egress_or_page_errors')) {
    try {
      gateBreakdown = parseBrowserGateBreakdown(report.gateBreakdown);
    } catch {
      throw new Error('auth progress report is invalid');
    }
  }

  let workerCoverageBreakdown;
  if(hasWorkerCoverageBreakdown) {
    try {
      workerCoverageBreakdown = parseWorkerCoverageBreakdown(report.workerCoverageBreakdown);
    } catch {
      throw new Error('auth progress report is invalid');
    }
  }

  let network;
  try {
    network = parseAuthProgressNetwork(report.network);
  } catch {
    throw new Error('auth progress report is invalid');
  }
  if(report.status === 'failed' && report.stage === 'browser_egress_or_page_errors' &&
      (gateBreakdown.counters.unexpectedEgressAttempts !== network.unexpectedAttempts ||
        gateBreakdown.counters.observerErrors !== network.observerErrors ||
        gateBreakdown.counters.unexpectedEgressAttempts + gateBreakdown.counters.observerErrors + gateBreakdown.counters.pageErrors === 0)) {
    throw new Error('auth progress report is invalid');
  }
  let workerObservation = report.workerObservation;
  if(report.status === 'passed') {
    try {
      workerObservation = parseAuthProgressWorkerObservation(workerObservation);
    } catch {
      throw new Error('auth progress report is invalid');
    }
  } else if(workerObservation !== null) {
    if(workerObservation?.classification === 'unclassified') {
      if(JSON.stringify(Object.keys(workerObservation).sort()) !== JSON.stringify(['classification'])) {
        throw new Error('auth progress report is invalid');
      }
    } else if(observation.validateNetworkBlock(workerObservation)) {
      throw new Error('auth progress report is invalid');
    }
  }

  let passwordEvidence;
  try {
    passwordEvidence = parsePasswordEvidence(report.passwordEvidence);
  } catch {
    throw new Error('auth progress report is invalid');
  }

  const isPasswordStage = report.stage.startsWith('alice_password_field_') || report.stage === 'alice_password_card_not_reached';
  if(passwordEvidence.length > 1 || passwordEvidence.some((entry) => !entry.stage.startsWith('alice_')) ||
      (report.contextCount === 0 && report.usernameSubmissions !== 0) ||
      (report.usernameSubmissions === 1 && report.contextCount !== 1) ||
      (report.contextCount === 1 && report.controlContextCount !== REQUIRED_CONTROLS.length) ||
      (isPasswordStage && (passwordEvidence.length !== 1 || passwordEvidence[0].stage !== report.stage || report.usernameSubmissions !== 1)) ||
      (passwordEvidence.length === 1 && report.usernameSubmissions !== 1)) {
    throw new Error('auth progress report is invalid');
  }

  if(report.status === 'passed' && (report.stage !== 'alice_password_field_ready' ||
      passwordEvidence.length !== 1 || passwordEvidence[0].stage !== 'alice_password_field_ready' || passwordEvidence[0].count !== 1 ||
      report.usernameSubmissions !== 1 || report.contextCount !== 1 || report.controlContextCount !== REQUIRED_CONTROLS.length ||
      !network.contexts.alice || network.unexpectedAttempts !== 0 || network.observerErrors !== 0 ||
      network.contexts.alice.allowedWebSockets < 1 || network.contexts.alice.workerTargets.service_worker < 1)) {
    throw new Error('auth progress report is invalid');
  }

  return {
    ...report,
    ...(hasGateBreakdown ? {gateBreakdown} : {}),
    ...(hasWorkerCoverageBreakdown ? {workerCoverageBreakdown} : {}),
    passwordEvidence,
    network,
    workerObservation
  };
}

export function parseBrowserGateBreakdown(value) {
  const keys = ['counters', 'unexpectedEgressAttempts', 'observerErrors', 'pageErrors', 'pageErrorOverflow'];
  const counterKeys = ['unexpectedEgressAttempts', 'observerErrors', 'pageErrors'];
  const hasStepDiagnostics = Object.hasOwn(value || {}, 'stepDiagnostics');
  if(!hasExactOwnKeys(value, [...keys, ...(hasStepDiagnostics ? ['stepDiagnostics'] : [])]) ||
      !hasExactOwnKeys(value.counters, counterKeys) ||
      counterKeys.some((key) => !Number.isSafeInteger(value.counters[key]) || value.counters[key] < 0 || value.counters[key] > 1_000_000) ||
      !hasExactOwnKeys(value.unexpectedEgressAttempts, GATE_CONTEXTS) ||
      !hasExactOwnKeys(value.observerErrors, GATE_CONTEXTS) ||
      !hasExactOwnKeys(value.pageErrors, GATE_CONTEXTS) ||
      !hasExactOwnKeys(value.pageErrorOverflow, GATE_CONTEXTS)) {
    throw new Error('browser egress/page error evidence is invalid');
  }

  let unexpectedAttemptCount = 0;
  let observerErrorCount = 0;
  let pageErrorCount = 0;
  for(const context of GATE_CONTEXTS) {
    const attempts = value.unexpectedEgressAttempts[context];
    if(!Array.isArray(attempts) || attempts.length > 512 || attempts.some((attempt) => {
      if(!hasExactOwnKeys(attempt, ['source', 'scheme', 'host', 'resourceType']) ||
          !GATE_EGRESS_SOURCES.includes(attempt.source) || !GATE_SCHEMES.includes(attempt.scheme) ||
          !GATE_RESOURCE_TYPES.includes(attempt.resourceType) || typeof attempt.host !== 'string' ||
          !attempt.host || attempt.host.length > 255 || /[\s/?#@\\]/.test(attempt.host)) return true;
      try {
        const parsed = new URL(`${attempt.scheme}://${attempt.host}`);
        return parsed.host !== attempt.host || Boolean(parsed.username || parsed.password || parsed.search || parsed.hash) || parsed.pathname !== '/';
      } catch {
        return true;
      }
    })) {
      throw new Error('browser egress/page error evidence is invalid');
    }
    unexpectedAttemptCount += attempts.length;

    const errors = value.observerErrors[context];
    if(!errors || typeof errors !== 'object' || Array.isArray(errors) ||
        Object.keys(errors).some((kind) => !GATE_OBSERVER_ERROR_KINDS.includes(kind)) ||
        Object.values(errors).some((count) => !Number.isSafeInteger(count) || count < 1 || count > 8)) {
      throw new Error('browser egress/page error evidence is invalid');
    }
    observerErrorCount += Object.values(errors).reduce((sum, count) => sum + count, 0);

    const pageErrors = value.pageErrors[context];
    if(!Array.isArray(pageErrors) || pageErrors.length > 512 || pageErrors.some((error) => !isClosedPageError(error))) {
      throw new Error('browser egress/page error evidence is invalid');
    }
    pageErrorCount += pageErrors.length;

    const overflow = value.pageErrorOverflow[context];
    if(!Array.isArray(overflow) || overflow.length > 1_000_000 || overflow.some((entry) =>
      !isClosedPageError(entry, true) ||
      !Number.isSafeInteger(entry.count) || entry.count < 1 || entry.count > 1_000_000
    ) || (overflow.length > 0 && pageErrors.length !== 512)) {
      throw new Error('browser egress/page error evidence is invalid');
    }
    pageErrorCount += overflow.reduce((sum, entry) => sum + entry.count, 0);
  }
  if(hasStepDiagnostics && !isSafeStepDiagnostics(value.stepDiagnostics)) {
    throw new Error('browser egress/page error evidence is invalid');
  }
  if(value.counters.unexpectedEgressAttempts !== unexpectedAttemptCount ||
      value.counters.observerErrors !== observerErrorCount ||
      value.counters.pageErrors !== Math.min(1_000_000, pageErrorCount)) {
    throw new Error('browser egress/page error evidence is invalid');
  }
  return value;
}

export function parsePassedBrowserGateBreakdown(report) {
  if(!report || typeof report !== 'object' || Array.isArray(report) || report.status !== 'passed') {
    throw new Error('passing browser report is invalid');
  }
  return parseBrowserGateBreakdown(report.gateBreakdown);
}

function isSafeStepDiagnostics(value) {
  if(!hasExactOwnKeys(value, GATE_CONTEXTS)) return false;
  return GATE_CONTEXTS.every((context) => Array.isArray(value[context]) &&
    value[context].length <= PAGE_DIAGNOSTIC_STEP_LIMIT && value[context].every((entry) =>
      hasExactOwnKeys(entry, [
        'scenarioStep', 'thrownValues', 'rpcFailures', 'consoleErrors',
        ...(Object.hasOwn(entry || {}, 'rpcFailuresTruncated') ? ['rpcFailuresTruncated'] : [])
      ]) &&
      (!Object.hasOwn(entry, 'rpcFailuresTruncated') || entry.rpcFailuresTruncated === true) &&
      isSafePageErrorScenarioStep(entry.scenarioStep) &&
      Array.isArray(entry.thrownValues) && entry.thrownValues.length <= PAGE_DIAGNOSTIC_LIMIT && entry.thrownValues.every((thrown) =>
        hasExactOwnKeys(thrown, ['source', 'valueType', 'type', 'code', 'description']) &&
        PAGE_DIAGNOSTIC_SOURCES.includes(thrown.source) && PAGE_DIAGNOSTIC_VALUE_TYPES.includes(thrown.valueType) &&
        isSafeDiagnosticFields({type: thrown.type, code: thrown.code, description: thrown.description})) &&
      Array.isArray(entry.rpcFailures) && entry.rpcFailures.length <= PAGE_DIAGNOSTIC_LIMIT && entry.rpcFailures.every(isSafeRpcDiagnosticFields) &&
      Array.isArray(entry.consoleErrors) && entry.consoleErrors.length <= PAGE_DIAGNOSTIC_LIMIT && entry.consoleErrors.every((error) =>
        hasExactOwnKeys(error, ['message']) && isSafeDiagnosticMessage(error.message))
    ));
}

function isSafeRpcDiagnosticFields(value) {
  return hasExactOwnKeys(value, ['type', 'code', 'description', 'method', 'peerArguments']) &&
    isSafeDiagnosticFields({type: value.type, code: value.code, description: value.description}) &&
    (value.method === 'unavailable' || typeof value.method === 'string' && PAGE_DIAGNOSTIC_RPC_METHOD.test(value.method)) &&
    Array.isArray(value.peerArguments) && value.peerArguments.length <= PAGE_DIAGNOSTIC_RPC_ARGUMENT_LIMIT && value.peerArguments.every((argument) =>
      hasExactOwnKeys(argument, ['argument', 'constructor', 'id']) &&
      typeof argument.argument === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(argument.argument) &&
      PAGE_DIAGNOSTIC_RPC_CONSTRUCTORS.includes(argument.constructor) &&
      (argument.id === 'unavailable' || typeof argument.id === 'string' && /^-?[0-9]{1,20}$/.test(argument.id))
    );
}

function isSafeDiagnosticFields(value) {
  const safeType = (type) => typeof type === 'string' && (type === 'unavailable' || /^[A-Z][A-Z0-9_]{1,63}$/.test(type));
  const safeCode = (code) => code === 'unavailable' ||
    (Number.isSafeInteger(code) && Math.abs(code) <= 1_000_000) ||
    (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code));
  return hasExactOwnKeys(value, ['type', 'code', 'description']) && safeType(value.type) && safeCode(value.code) &&
    isSafeDiagnosticMessage(value.description);
}

function isSafeDiagnosticMessage(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= PAGE_DIAGNOSTIC_FIELD_LIMIT && isSafePageErrorMessage(value);
}

function isClosedPageError(error, includeCount = false) {
  if(!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const hasDiagnostic = Object.hasOwn(error, 'diagnostic');
  return hasExactOwnKeys(error, [
    'constructorName', 'scriptAsset', 'message', 'stack', 'scenarioStep',
    ...(hasDiagnostic ? ['diagnostic'] : []),
    ...(includeCount ? ['count'] : [])
  ]) &&
    PAGE_ERROR_CONSTRUCTORS.includes(error.constructorName) &&
    typeof error.scriptAsset === 'string' && SCRIPT_ASSET.test(error.scriptAsset) &&
    error.message === '[redacted]' &&
    isSafePageErrorStack(error.stack) &&
    isSafePageErrorScenarioStep(error.scenarioStep) &&
    (!hasDiagnostic || isSafePageErrorDiagnostic(error.diagnostic));
}

function isSafePageErrorDiagnostic(diagnostic) {
  if(!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) return false;
  const hasRpcErrorType = Object.hasOwn(diagnostic, 'rpcErrorType');
  const hasRpcErrorCode = Object.hasOwn(diagnostic, 'rpcErrorCode');
  const hasRpcMethod = Object.hasOwn(diagnostic, 'rpcMethod');
  const keys = ['pageUrl', 'scenario', 'stage',
    ...(hasRpcErrorType ? ['rpcErrorType'] : []), ...(hasRpcErrorCode ? ['rpcErrorCode'] : []),
    ...(hasRpcMethod ? ['rpcMethod'] : [])];
  if(!hasExactOwnKeys(diagnostic, keys) ||
      !PAGE_ERROR_SCENARIOS.includes(diagnostic.scenario) ||
      typeof diagnostic.stage !== 'string' || !/^(?:unknown|[a-z][a-z0-9_]{0,63})$/.test(diagnostic.stage) ||
      (hasRpcErrorType && (typeof diagnostic.rpcErrorType !== 'string' || !RPC_ERROR_TYPE_PATTERN.test(diagnostic.rpcErrorType))) ||
      (hasRpcErrorCode && (!Number.isSafeInteger(diagnostic.rpcErrorCode) || diagnostic.rpcErrorCode < 0 || diagnostic.rpcErrorCode > 999_999)) ||
      (hasRpcMethod && (typeof diagnostic.rpcMethod !== 'string' || !PAGE_DIAGNOSTIC_RPC_METHOD.test(diagnostic.rpcMethod)))) return false;
  if(diagnostic.pageUrl === 'unknown') return true;
  if(typeof diagnostic.pageUrl !== 'string' || diagnostic.pageUrl.length > PAGE_ERROR_DIAGNOSTIC_LIMITS.pageUrlLength ||
      /[\s?#]/.test(diagnostic.pageUrl)) return false;
  try {
    const parsed = new URL(diagnostic.pageUrl);
    return parsed.origin === PRIVATE_CSP_ORIGIN && parsed.search === '' && parsed.hash === '' &&
      !parsed.username && !parsed.password && `${parsed.origin}${parsed.pathname}` === diagnostic.pageUrl;
  } catch {
    return false;
  }
}

function isSafePageErrorMessage(message) {
  return typeof message === 'string' && message.length > 0 && message.length <= PAGE_ERROR_MESSAGE_LIMIT &&
    !/[\u0000-\u001f\u007f]/.test(message) &&
    !/(?:https?:\/\/|wss?:\/\/|blob:|file:|data:)|\b(?:password|secret|passphrase|token|bearer|authorization|api[_-]?key|private[_-]?key)\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|[A-Za-z0-9+/=_-]{32,}/i.test(message);
}

function isSafePageErrorStack(stack) {
  if(!hasExactOwnKeys(stack, ['state', 'lineCount', 'frameCount', 'frames']) ||
      !PAGE_ERROR_STACK_STATES.includes(stack.state) ||
      !Number.isSafeInteger(stack.lineCount) || stack.lineCount < 0 || stack.lineCount > 1_000_000 ||
      !Number.isSafeInteger(stack.frameCount) || stack.frameCount < 0 || stack.frameCount > 1_000_000 ||
      !Array.isArray(stack.frames) || stack.frames.length > PAGE_ERROR_STACK_FRAME_LIMIT || stack.frames.length > stack.frameCount ||
      stack.frames.some((frame) => !isSafePageErrorStackFrame(frame))) return false;
  if(['unavailable', 'non_string'].includes(stack.state)) return stack.lineCount === 0 && stack.frameCount === 0 && stack.frames.length === 0;
  if(stack.state === 'no_frames') return stack.lineCount > 0 && stack.frameCount === 0 && stack.frames.length === 0;
  if(stack.state === 'unclassified_frames') return stack.lineCount > 1 && stack.frameCount > 0 && stack.frames.length === 0;
  if(stack.state === 'captured') return stack.lineCount > 1 && stack.frameCount > 0 && stack.frames.length === stack.frameCount;
  if(stack.state === 'partial') return stack.lineCount > 1 && stack.frameCount > stack.frames.length && stack.frames.length > 0;
  return stack.state === 'truncated' && stack.lineCount > 0 && stack.frameCount >= stack.frames.length;
}

function isSafePageErrorStackFrame(frame) {
  return hasExactOwnKeys(frame, ['functionName', 'scriptAsset', 'line', 'column']) &&
    typeof frame.functionName === 'string' && frame.functionName.length <= PAGE_ERROR_FUNCTION_NAME_LIMIT &&
    !/\b(?:password|secret|passphrase|token|bearer|authorization|api[_-]?key|private[_-]?key)\b/i.test(frame.functionName) &&
    !/^[A-Za-z0-9_-]{32,}$/.test(frame.functionName) &&
    /^(?:unknown|[A-Za-z_$][A-Za-z0-9_$]*(?:\.(?:[A-Za-z_$][A-Za-z0-9_$]*|<anonymous>))*)$/.test(frame.functionName) &&
    typeof frame.scriptAsset === 'string' && SCRIPT_ASSET.test(frame.scriptAsset) &&
    Number.isSafeInteger(frame.line) && frame.line >= 0 && frame.line <= 100_000_000 &&
    Number.isSafeInteger(frame.column) && frame.column >= 0 && frame.column <= 100_000_000;
}

function isSafePageErrorScenarioStep(value) {
  return hasExactOwnKeys(value, ['scenario', 'step']) && PAGE_ERROR_SCENARIOS.includes(value.scenario) &&
    typeof value.step === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value.step);
}

function parseAuthProgressNetwork(network) {
  const sources = ['page', 'shared_worker', 'service_worker', 'worker'];
  const keys = ['unexpectedAttempts', 'observerErrors', 'contexts', 'websocket_101_by_context_phase'];
  if(!network || typeof network !== 'object' || Array.isArray(network) ||
      JSON.stringify(Object.keys(network).sort()) !== JSON.stringify(keys.sort()) ||
      !Number.isSafeInteger(network.unexpectedAttempts) || network.unexpectedAttempts < 0 || network.unexpectedAttempts > 1_000_000 ||
      !Number.isSafeInteger(network.observerErrors) || network.observerErrors < 0 || network.observerErrors > 4096 ||
      !network.contexts || typeof network.contexts !== 'object' || Array.isArray(network.contexts) ||
      ![[], ['alice']].some((names) => JSON.stringify(Object.keys(network.contexts).sort()) === JSON.stringify(names))) {
    throw new Error('auth progress network evidence is invalid');
  }

  const websocket101 = network.websocket_101_by_context_phase;
  if(!hasExactOwnKeys(websocket101, AUTH_PROGRESS_WEBSOCKET_101_CONTEXTS)) {
    throw new Error('auth progress websocket upgrade evidence is invalid');
  }
  for(const context of AUTH_PROGRESS_WEBSOCKET_101_CONTEXTS) {
    const phases = websocket101[context];
    if(!hasExactOwnKeys(phases, AUTH_PROGRESS_WEBSOCKET_101_PHASES) ||
        AUTH_PROGRESS_WEBSOCKET_101_PHASES.some((phase) => {
          const count = phases[phase];
          return !Number.isInteger(count) || count < 0 || count > 2_147_483_647;
        })) {
      throw new Error('auth progress websocket upgrade evidence is invalid');
    }
  }

  let unexpectedAttempts = 0;
  for(const context of Object.values(network.contexts)) {
    const contextKeys = ['workerTargets', 'allowedWebSockets', 'attemptsBySource', 'unexpectedAttemptsBySource', 'allowedWebSocketsBySource'];
    if(!context || typeof context !== 'object' || Array.isArray(context) ||
        JSON.stringify(Object.keys(context).sort()) !== JSON.stringify(contextKeys.sort()) ||
        !Number.isSafeInteger(context.allowedWebSockets) || context.allowedWebSockets < 0 || context.allowedWebSockets > 1_000_000) {
      throw new Error('auth progress network evidence is invalid');
    }
    const sourceMaps = [
      [context.workerTargets, ['shared_worker', 'service_worker']],
      [context.attemptsBySource, sources],
      [context.unexpectedAttemptsBySource, sources],
      [context.allowedWebSocketsBySource, sources]
    ];
    for(const [sourceMap, sourceNames] of sourceMaps) {
      if(!sourceMap || typeof sourceMap !== 'object' || Array.isArray(sourceMap) ||
          JSON.stringify(Object.keys(sourceMap).sort()) !== JSON.stringify([...sourceNames].sort()) ||
          Object.values(sourceMap).some((count) => !Number.isSafeInteger(count) || count < 0 || count > 1_000_000)) {
        throw new Error('auth progress network evidence is invalid');
      }
    }
    for(const source of sources) {
      if(context.unexpectedAttemptsBySource[source] > context.attemptsBySource[source] ||
          context.allowedWebSocketsBySource[source] > context.attemptsBySource[source]) {
        throw new Error('auth progress network evidence is invalid');
      }
    }
    const contextUnexpectedAttempts = Object.values(context.unexpectedAttemptsBySource).reduce((sum, count) => sum + count, 0);
    const contextAllowedWebSockets = Object.values(context.allowedWebSocketsBySource).reduce((sum, count) => sum + count, 0);
    if(contextUnexpectedAttempts > 1_000_000 || contextAllowedWebSockets !== context.allowedWebSockets) {
      throw new Error('auth progress network evidence is invalid');
    }
    unexpectedAttempts += contextUnexpectedAttempts;
  }
  if(unexpectedAttempts !== network.unexpectedAttempts) {
    throw new Error('auth progress network evidence is invalid');
  }

  return network;
}

function hasExactOwnKeys(value, keys) {
  if(!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key));
}

export function assertAllScenariosPassed(results, expectedScenarios = REQUIRED_SCENARIOS) {
  if(!Array.isArray(results)) {
    throw new Error('scenario results are required');
  }
  if(!Array.isArray(expectedScenarios) || expectedScenarios.some((scenario) => !AVAILABLE_SCENARIOS.includes(scenario)) ||
      new Set(expectedScenarios).size !== expectedScenarios.length) {
    throw new Error('expected scenarios are invalid');
  }

  const byName = new Map();
  for(const result of results) {
    if(!result || typeof result.name !== 'string' || !AVAILABLE_SCENARIOS.includes(result.name)) {
      throw new Error('scenario result has an unknown name');
    }
    if(byName.has(result.name)) {
      throw new Error(`duplicate scenario result: ${result.name}`);
    }
    byName.set(result.name, result.status);
  }

  for(const scenario of expectedScenarios) {
    if(!byName.has(scenario)) {
      throw new Error(`${scenario} did not execute`);
    }
    const status = byName.get(scenario);
    if(status === 'skipped') {
      throw new Error(`${scenario} was skipped`);
    }
    if(status !== 'passed') {
      throw new Error(`${scenario} did not pass`);
    }
  }

  return [...expectedScenarios];
}
