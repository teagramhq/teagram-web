'use strict';

// Passive shared-worker observation for the confined real-client runner.
//
// Nothing in this file talks to a browser. It classifies CDP payloads that were
// already received and keeps only bounded integers, fixed enums and allowlisted
// logical chunk names. Target URLs, blob identifiers, target and session ids,
// console arguments, exception details, stack frames and worker source text are
// dropped on receipt: they never enter this state, so they cannot reach
// durable output.
//
// Shared-worker creation and absence are reported per browser context with
// complete coverage. Worker-internal module installation and evaluation are
// best-effort: those categories carry an explicit `unvalidated` validation
// state because the accepted harness owns no blob module probe able to confirm
// them (MAIN-1483 precheck).

const PRIVATE_CSP_ORIGIN = 'https://telegramd.test';

const LIMITS = Object.freeze({
  attachedTargets: 16,
  countedEventsPerContext: 512,
  cdpMessageBytes: 256 * 1024,
  commandTimeoutMs: 5000
});

const BROWSER_CDP_METHODS = Object.freeze([
  'Target.setDiscoverTargets',
  'Target.attachToTarget',
  'Target.detachFromTarget',
  'Target.sendMessageToTarget'
]);
// Target.getTargetInfo is the page identity mapping the precheck permits, and
// Target.sendMessageToTarget is only the transport for nested worker commands,
// which are themselves gated by WORKER_CDP_METHODS.
const PAGE_CDP_METHODS = Object.freeze([
  'Network.enable',
  'Audits.enable',
  'Log.enable',
  'Target.setAutoAttach',
  'Target.getTargetInfo',
  'Target.sendMessageToTarget'
]);
const WORKER_CDP_METHODS = Object.freeze([
  'Network.enable',
  'Audits.enable',
  'Log.enable',
  'Runtime.enable',
  'Runtime.runIfWaitingForDebugger'
]);

const SOURCE_FETCH_STATES = Object.freeze(['not_requested', 'ok', 'http_4xx', 'http_5xx', 'failed']);
const SHARED_WORKER_STATES = Object.freeze(['created', 'absent', 'unknown']);
const MTPROTO_STATES = Object.freeze(['mtproto_candidate', 'ambiguous', 'absent', 'unknown']);
const WORKER_FAILURE_STATES = Object.freeze([
  'script_load_failed',
  'module_resolve_failed',
  'module_fetch_failed',
  'evaluation_exception',
  'csp_blocked',
  'destroyed_before_attach',
  'no_failure_observed',
  'unknown'
]);
const VALIDATION_STATES = Object.freeze(['validated', 'unvalidated']);

// Categories the accepted harness cannot prove. They are reported and marked
// `unvalidated`, and never establish a causal verdict or success on their own.
const UNVALIDATED_FAILURE_STATES = Object.freeze(['module_resolve_failed', 'module_fetch_failed', 'evaluation_exception']);

// The most specific installation failure wins. `destroyed_before_attach` and
// `no_failure_observed` stay last: a lifecycle end is never read as success.
const FAILURE_PRECEDENCE = Object.freeze([
  'csp_blocked',
  'script_load_failed',
  'module_resolve_failed',
  'module_fetch_failed',
  'evaluation_exception',
  'destroyed_before_attach',
  'unknown'
]);

// The artifact's own worker chunks, addressed by name with the hash stripped.
const WORKER_CHUNK_PATTERNS = Object.freeze([
  {label: 'mtproto_worker', pattern: /^\/index\.worker-[0-9a-zA-Z_-]{8}\.js$/},
  {label: 'crypto_worker', pattern: /^\/crypto\.worker-[0-9a-zA-Z_-]{8}\.js$/},
  {label: 'lottie_worker', pattern: /^\/tlottie\.worker-[0-9a-zA-Z_-]{8}\.js$/},
  {label: 'spoiler_worker', pattern: /^\/spoilerRenderer\.worker-[0-9a-zA-Z_-]{8}\.js$/},
  {label: 'webp_worker', pattern: /^\/webp\.worker-[0-9a-zA-Z_-]{8}\.js$/},
  {label: 'tinyld_worker', pattern: /^\/tinyld\.worker-[0-9a-zA-Z_-]{8}\.js$/},
  {label: 'compositor_worker', pattern: /^\/compositor\.worker-[0-9a-zA-Z_-]{8}\.js$/},
  {label: 'service_worker', pattern: /^\/sw-[0-9a-zA-Z_-]{8}\.js$/},
  {label: 'probe_shared_worker', pattern: /^\/_fixture_probe\/shared-worker\.js$/},
  {label: 'probe_missing_script', pattern: /^\/_fixture_probe\/missing\.js$/}
]);

const ORIGIN_CLASSES = Object.freeze(['blob_same_origin', 'other_same_origin', 'cross_origin']);
const WORKER_SOURCE_LABELS = Object.freeze([...new Set([...WORKER_CHUNK_PATTERNS.map((entry) => entry.label), ...ORIGIN_CLASSES])]);

const UNCLASSIFIED_NETWORK_BLOCK = Object.freeze({classification: 'unclassified'});

function allowCdpMethod(scope, method) {
  const allowlist = scope === 'browser' ? BROWSER_CDP_METHODS : scope === 'page' ? PAGE_CDP_METHODS : WORKER_CDP_METHODS;
  return typeof method === 'string' && allowlist.includes(method);
}

function labelForPathname(pathname) {
  const match = WORKER_CHUNK_PATTERNS.find((entry) => entry.pattern.test(pathname));
  return match ? match.label : null;
}

// A worker source becomes a logical name, never a URL: the hash and the query
// are stripped and anything unrecognised collapses to one of three origin classes.
function classifyWorkerSource(url, origin = PRIVATE_CSP_ORIGIN) {
  if(typeof url !== 'string' || !url) return {label: 'cross_origin', originClass: 'cross_origin', isBlob: false};
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {label: 'cross_origin', originClass: 'cross_origin', isBlob: false};
  }
  if(parsed.protocol === 'blob:') {
    let inner;
    try {
      inner = new URL(parsed.pathname);
    } catch {
      return {label: 'cross_origin', originClass: 'cross_origin', isBlob: true};
    }
    if(inner.origin === origin) return {label: 'blob_same_origin', originClass: 'blob_same_origin', isBlob: true};
    return {label: 'cross_origin', originClass: 'cross_origin', isBlob: true};
  }
  if(parsed.origin === origin) {
    const label = labelForPathname(parsed.pathname);
    return {label: label || 'other_same_origin', originClass: 'other_same_origin', isBlob: false};
  }
  return {label: 'cross_origin', originClass: 'cross_origin', isBlob: false};
}

// Fixed patterns for the categories the accepted harness can name at all. The
// matched text is consumed and dropped: only the category survives.
const WORKER_LOG_PATTERNS = Object.freeze([
  {state: 'script_load_failed', source: 'worker', pattern: /^Failed to fetch a worker script\.$/},
  {state: 'module_resolve_failed', source: null, pattern: /^Failed to resolve module specifier\b/},
  {state: 'module_fetch_failed', source: null, pattern: /^Failed to fetch( a module script)?$/},
  {state: 'csp_blocked', source: null, pattern: /\bContent Security Policy\b[^\n]*\b(blocked|disallowed)\b/i}
]);

// The page reports `Failed to fetch a worker script.` both for a real script URL
// that cannot be loaded and for a module the worker imports. The entry's own url
// separates them: a blob document means the script text was inline, so the
// fetch that failed was a module import.
function classifyWorkerLogEntry(entry, isBlobWorker) {
  if(!entry || typeof entry !== 'object' || typeof entry.text !== 'string') return null;
  for(const candidate of WORKER_LOG_PATTERNS) {
    if(candidate.source && entry.source !== candidate.source) continue;
    if(!candidate.pattern.test(entry.text)) continue;
    if(candidate.state === 'script_load_failed') {
      if(isBlobWorker) return 'module_fetch_failed';
      let entryUrl;
      try {
        entryUrl = new URL(entry.url);
      } catch {
        entryUrl = null;
      }
      if(entryUrl && entryUrl.protocol === 'blob:') return 'module_fetch_failed';
      return 'script_load_failed';
    }
    return candidate.state;
  }
  return null;
}

function isWorkerScriptType(type) {
  return type === 'Script' || type === 'Worker' || type === 'SharedWorker' || type === 'ServiceWorker';
}

function statusCategory(status) {
  if(status >= 500) return 'http_5xx';
  if(status >= 400) return 'http_4xx';
  return 'ok';
}

function createTargetRecord(source, targetId) {
  return {
    targetId,
    label: source.label,
    originClass: source.originClass,
    isBlob: source.isBlob,
    attached: false,
    setupComplete: false,
    destroyed: false,
    destroyedBeforeSetup: false,
    crashed: false,
    failures: new Set()
  };
}

// One observer per browser context: the two app contexts and each synthetic
// control context. `control` contexts are never counted as app evidence.
function createContextObserver(name, options = {}) {
  const control = options.control === true;
  const targets = new Map();
  const pageTargetIds = new Set();
  const sharedWorkerTargetIds = new Set();
  const blobSharedWorkerTargetIds = new Set();
  const scriptSharedWorkerTargetIds = new Set();
  const serviceWorkerTargetIds = new Set();
  const dedicatedWorkerTargetIds = new Set();
  const workerSourceLabels = new Set();

  const state = {
    countedEvents: 0,
    attachedTargets: 0,
    observerErrors: 0,
    foreignTargets: 0,
    overflow: false,
    discoveryActive: false,
    pageCoverageComplete: false,
    windowElapsed: false,
    attachFailures: 0,
    detachBeforeSetup: 0,
    mtprotoSourceRequested: false,
    mtprotoSourceFetch: 'not_requested',
    mtprotoSourceChunk: 'none',
    failures: new Set()
  };

  function recordOverflow() {
    if(!state.overflow) state.observerErrors++;
    state.overflow = true;
  }

  // Counts stay bounded integers: the overflow flag is the signal, never a
  // counter that runs past the schema bound.
  function countEvent() {
    if(state.countedEvents >= LIMITS.countedEventsPerContext) {
      state.countedEvents = LIMITS.countedEventsPerContext;
      recordOverflow();
      return;
    }
    state.countedEvents++;
  }

  function recordObserverError() {
    state.observerErrors++;
  }

  function addFailure(category) {
    if(typeof category === 'string' && WORKER_FAILURE_STATES.includes(category)) state.failures.add(category);
  }

  function classifySharedTarget(targetInfo) {
    const source = classifyWorkerSource(targetInfo.url);
    const existing = targets.get(targetInfo.targetId);
    if(existing) {
      // The first notification can carry an empty URL; a later
      // targetInfoChanged names the same target by its real source.
      if(source.label !== 'cross_origin' && existing.label === 'cross_origin') {
        existing.label = source.label;
        existing.originClass = source.originClass;
        existing.isBlob = source.isBlob;
        if(source.isBlob) {
          scriptSharedWorkerTargetIds.delete(targetInfo.targetId);
          blobSharedWorkerTargetIds.add(targetInfo.targetId);
        }
      }
      return existing;
    }
    const record = createTargetRecord(source, targetInfo.targetId);
    targets.set(targetInfo.targetId, record);
    workerSourceLabels.add(record.label);
    if(record.isBlob) blobSharedWorkerTargetIds.add(targetInfo.targetId);
    else scriptSharedWorkerTargetIds.add(targetInfo.targetId);
    return record;
  }

  function registerTarget(targetInfo) {
    countEvent();
    if(!targetInfo || typeof targetInfo.targetId !== 'string') return null;
    if(targetInfo.type === 'page') {
      pageTargetIds.add(targetInfo.targetId);
      return null;
    }
    if(targetInfo.type === 'service_worker') {
      serviceWorkerTargetIds.add(targetInfo.targetId);
      return null;
    }
    if(targetInfo.type === 'worker') {
      dedicatedWorkerTargetIds.add(targetInfo.targetId);
      return null;
    }
    if(targetInfo.type !== 'shared_worker') return null;
    sharedWorkerTargetIds.add(targetInfo.targetId);
    return classifySharedTarget(targetInfo);
  }

  function noteAttached(targetId = null) {
    countEvent();
    if(state.attachedTargets >= LIMITS.attachedTargets) {
      recordOverflow();
      return false;
    }
    state.attachedTargets++;
    const record = targetId ? targets.get(targetId) : null;
    if(record) record.attached = true;
    return true;
  }

  function noteSetupComplete(targetId) {
    const record = targets.get(targetId);
    if(record) record.setupComplete = true;
  }

  function noteDestroyed(targetId) {
    countEvent();
    const record = targets.get(targetId);
    if(!record) return;
    record.destroyed = true;
    if(!record.setupComplete) {
      record.destroyedBeforeSetup = true;
      record.failures.add('destroyed_before_attach');
      addFailure('destroyed_before_attach');
    }
  }

  function noteAttachFailure() {
    state.attachFailures++;
    state.observerErrors++;
  }

  function noteDetachBeforeSetup() {
    state.detachBeforeSetup++;
    state.observerErrors++;
  }

  // Synthetic controls only: drive the real overflow and attach-failure
  // branches with injected inputs, then read the resulting classification.
  function noteInjectedControlFault(kind) {
    if(kind === 'overflow') {
      state.countedEvents = LIMITS.countedEventsPerContext;
      countEvent();
      return;
    }
    noteAttachFailure();
  }

  function noteWorkerEvent(targetId, method, params) {
    countEvent();
    const record = targets.get(targetId);
    if(!record) return;
    if(method === 'Log.entryAdded') {
      const category = classifyWorkerLogEntry(params?.entry, record.isBlob);
      if(category) {
        record.failures.add(category);
        addFailure(category);
      }
      return;
    }
    if(method === 'Runtime.exceptionThrown') {
      record.failures.add('evaluation_exception');
      addFailure('evaluation_exception');
      return;
    }
    if(method === 'Network.loadingFailed') {
      if(isWorkerScriptType(params?.type)) {
        record.failures.add('module_fetch_failed');
        addFailure('module_fetch_failed');
      }
      return;
    }
    if(method === 'Network.responseReceived') {
      const status = params?.response?.status;
      if(isWorkerScriptType(params?.type) && typeof status === 'number' && status >= 400) {
        record.failures.add('script_load_failed');
        addFailure('script_load_failed');
      }
      return;
    }
    if(method === 'Audits.issueAdded') {
      const details = params?.issue?.details?.contentSecurityPolicyIssueDetails;
      if(details && /worker/i.test(String(details.blockedType || ''))) {
        record.failures.add('csp_blocked');
        addFailure('csp_blocked');
      }
      return;
    }
    if(method === 'Inspector.targetCrashed') {
      record.crashed = true;
      return;
    }
    // Network.dataReceived, Network.loadingFinished, Inspector.workerScriptLoaded,
    // Runtime.executionContextCreated and Runtime.consoleAPICalled carry
    // URLs, origins and console argument objects. Classified as non-diagnostic
    // and dropped: nothing from them is stored.
  }

  // Page-session coverage. The page session is enabled before navigation, so
  // the source fetch of the allowlisted MTProto chunk is observed completely.
  function notePageEvent(method, params) {
    countEvent();
    if(method === 'Network.requestWillBeSent') {
      const source = classifyWorkerSource(params?.request?.url);
      if(source.label === 'mtproto_worker') {
        state.mtprotoSourceRequested = true;
        state.mtprotoSourceChunk = 'mtproto_worker';
      }
      if(isWorkerScriptType(params?.type) && source.label !== 'cross_origin') workerSourceLabels.add(source.label);
      return;
    }
    if(method === 'Network.responseReceived') {
      const source = classifyWorkerSource(params?.response?.url);
      const status = params?.response?.status;
      if(typeof status !== 'number') return;
      if(source.label === 'mtproto_worker') {
        state.mtprotoSourceRequested = true;
        state.mtprotoSourceChunk = 'mtproto_worker';
        state.mtprotoSourceFetch = statusCategory(status);
        return;
      }
      if(isWorkerScriptType(params?.type)) noteScriptResponseStatus(source.label, status);
      return;
    }
    if(method === 'Network.loadingFailed') {
      const source = classifyWorkerSource(params?.request?.url);
      if(source.label === 'mtproto_worker') {
        state.mtprotoSourceRequested = true;
        state.mtprotoSourceChunk = 'mtproto_worker';
        state.mtprotoSourceFetch = 'failed';
        return;
      }
      if(isWorkerScriptType(params?.type)) noteScriptLoadFailure(source.label);
      return;
    }
    if(method === 'Log.entryAdded') {
      const category = classifyWorkerLogEntry(params?.entry, false);
      if(category) addFailure(category);
      return;
    }
    if(method === 'Audits.issueAdded') {
      const details = params?.issue?.details?.contentSecurityPolicyIssueDetails;
      if(details && /worker/i.test(String(details.blockedType || ''))) addFailure('csp_blocked');
    }
  }

  function noteScriptResponseStatus(label, status) {
    if(status < 400) return;
    noteScriptLoadFailure(label);
  }

  function noteScriptLoadFailure(label) {
    const match = [...targets.values()].find((record) => !record.isBlob && record.label === label);
    if(!match || match.failures.has('script_load_failed')) return;
    match.failures.add('script_load_failed');
    addFailure('script_load_failed');
  }

  function coverageComplete() {
    return state.discoveryActive &&
      state.pageCoverageComplete &&
      state.windowElapsed &&
      !state.overflow &&
      state.observerErrors === 0 &&
      state.foreignTargets === 0 &&
      pageTargetIds.size === 1;
  }

  function classifySharedWorker() {
    if(!coverageComplete()) return 'unknown';
    return sharedWorkerTargetIds.size >= 1 ? 'created' : 'absent';
  }

  function classifyMtproto() {
    if(!coverageComplete()) return 'unknown';
    if(blobSharedWorkerTargetIds.size >= 2) return 'ambiguous';
    if(blobSharedWorkerTargetIds.size === 1 && state.mtprotoSourceRequested) return 'mtproto_candidate';
    if(blobSharedWorkerTargetIds.size === 0 && state.mtprotoSourceRequested) return 'absent';
    return 'unknown';
  }

  function classifyFailure() {
    for(const category of FAILURE_PRECEDENCE) {
      if(state.failures.has(category)) return category;
    }
    if(targets.size > 0) return [...targets.values()].some((record) => record.crashed) ? 'unknown' : 'no_failure_observed';
    return sharedWorkerTargetIds.size > 0 ? 'unknown' : 'no_failure_observed';
  }

  function summary() {
    const workerFailure = classifyFailure();
    return {
      pageTargets: pageTargetIds.size,
      sharedWorkerTargets: sharedWorkerTargetIds.size,
      blobSharedWorkerTargets: blobSharedWorkerTargetIds.size,
      scriptSharedWorkerTargets: scriptSharedWorkerTargetIds.size,
      serviceWorkerTargets: serviceWorkerTargetIds.size,
      dedicatedWorkerTargets: dedicatedWorkerTargetIds.size,
      workerSourceChunks: [...workerSourceLabels].sort(),
      mtprotoSourceChunk: state.mtprotoSourceChunk,
      mtprotoSourceFetch: state.mtprotoSourceFetch,
      sharedWorkerState: classifySharedWorker(),
      mtprotoWorker: classifyMtproto(),
      workerFailure,
      workerFailureValidation: UNVALIDATED_FAILURE_STATES.includes(workerFailure) ? 'unvalidated' : 'validated',
      observerOverflow: state.overflow ? 1 : 0,
      countedEvents: state.countedEvents,
      attachedTargets: state.attachedTargets,
      observerErrors: state.observerErrors,
      coverageComplete: coverageComplete() ? 1 : 0,
      discoveryActive: state.discoveryActive ? 1 : 0,
      pageCoverageComplete: state.pageCoverageComplete ? 1 : 0
    };
  }

  return {
    name,
    control,
    targets,
    state,
    pageTargetIds,
    sharedWorkerTargetIds,
    blobSharedWorkerTargetIds,
    serviceWorkerTargetIds,
    dedicatedWorkerTargetIds,
    workerSourceLabels,
    registerTarget,
    noteAttached,
    noteSetupComplete,
    noteDestroyed,
    noteAttachFailure,
    noteDetachBeforeSetup,
    noteInjectedControlFault,
    noteWorkerEvent,
    notePageEvent,
    noteEvent: countEvent,
    recordOverflow,
    recordObserverError,
    eventCount: () => state.countedEvents,
    coverageComplete,
    classifySharedWorker,
    classifyMtproto,
    classifyFailure,
    summary
  };
}

// Durable schema. Fixed keys, and every value is a bounded integer, a fixed
// enum, a 0/1 flag, or an array of allowlisted logical chunk names.
const FLAG_VALUES = Object.freeze([0, 1]);
const CONTEXT_SCHEMA = Object.freeze({
  pageTargets: {kind: 'count', max: 8},
  sharedWorkerTargets: {kind: 'count', max: LIMITS.attachedTargets},
  blobSharedWorkerTargets: {kind: 'count', max: LIMITS.attachedTargets},
  scriptSharedWorkerTargets: {kind: 'count', max: LIMITS.attachedTargets},
  serviceWorkerTargets: {kind: 'count', max: LIMITS.attachedTargets},
  dedicatedWorkerTargets: {kind: 'count', max: LIMITS.attachedTargets},
  workerSourceChunks: {kind: 'labels', values: WORKER_SOURCE_LABELS},
  mtprotoSourceChunk: {kind: 'enum', values: Object.freeze(['none', 'mtproto_worker'])},
  mtprotoSourceFetch: {kind: 'enum', values: SOURCE_FETCH_STATES},
  sharedWorkerState: {kind: 'enum', values: SHARED_WORKER_STATES},
  mtprotoWorker: {kind: 'enum', values: MTPROTO_STATES},
  workerFailure: {kind: 'enum', values: WORKER_FAILURE_STATES},
  workerFailureValidation: {kind: 'enum', values: VALIDATION_STATES},
  observerOverflow: {kind: 'flag'},
  countedEvents: {kind: 'count', max: LIMITS.countedEventsPerContext},
  attachedTargets: {kind: 'count', max: LIMITS.attachedTargets},
  observerErrors: {kind: 'count', max: 4096},
  coverageComplete: {kind: 'flag'},
  discoveryActive: {kind: 'flag'},
  pageCoverageComplete: {kind: 'flag'}
});
const CONTEXT_KEYS = Object.freeze(Object.keys(CONTEXT_SCHEMA));

const CONTROL_SCHEMA = Object.freeze({...CONTEXT_SCHEMA, expected: {kind: 'enum', values: Object.freeze(['pass', 'fail'])}});
const CONTROL_KEYS = Object.freeze(Object.keys(CONTROL_SCHEMA));

const NETWORK_KEYS = Object.freeze([
  'unexpectedAttempts',
  'observerErrors',
  'foreignTargets',
  'contextlessTargets',
  'appContextlessTargets',
  'discoveryActive',
  'attachedTargets',
  'observerOverflow',
  'countedEvents',
  'contexts',
  'controls'
]);

function isCount(value, max) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function validateContextBlock(block, schema, keys) {
  if(!block || typeof block !== 'object' || Array.isArray(block)) return 'context_block_shape';
  if(JSON.stringify(Object.keys(block).sort()) !== JSON.stringify([...keys].sort())) return 'context_block_keys';
  for(const key of keys) {
    const rule = schema[key];
    const value = block[key];
    if(rule.kind === 'count' && !isCount(value, rule.max)) return `context_${key}`;
    if(rule.kind === 'flag' && !FLAG_VALUES.includes(value)) return `context_${key}`;
    if(rule.kind === 'enum' && !rule.values.includes(value)) return `context_${key}`;
    if(rule.kind === 'labels') {
      if(!Array.isArray(value)) return `context_${key}`;
      const seen = new Set();
      for(const label of value) {
        if(!rule.values.includes(label) || seen.has(label)) return `context_${key}`;
        seen.add(label);
      }
    }
  }
  return null;
}

// The emit-time validator. Any value outside the closed schema makes the whole
// network block `unclassified` and the run fails.
function validateNetworkBlock(block) {
  if(!block || typeof block !== 'object' || Array.isArray(block)) return 'network_block_shape';
  if(JSON.stringify(Object.keys(block).sort()) !== JSON.stringify([...NETWORK_KEYS].sort())) return 'network_block_keys';
  if(!isCount(block.unexpectedAttempts, 1_000_000)) return 'network_unexpectedAttempts';
  if(!isCount(block.observerErrors, 4096)) return 'network_observerErrors';
  if(!isCount(block.foreignTargets, 1_000_000)) return 'network_foreignTargets';
  if(!isCount(block.contextlessTargets, 1_000_000)) return 'network_contextlessTargets';
  if(!isCount(block.appContextlessTargets, 1_000_000)) return 'network_appContextlessTargets';
  if(!FLAG_VALUES.includes(block.discoveryActive)) return 'network_discoveryActive';
  if(!isCount(block.attachedTargets, 4096)) return 'network_attachedTargets';
  if(!FLAG_VALUES.includes(block.observerOverflow)) return 'network_observerOverflow';
  if(!isCount(block.countedEvents, 1_000_000)) return 'network_countedEvents';
  if(!block.contexts || typeof block.contexts !== 'object' || Array.isArray(block.contexts)) return 'network_contexts_shape';
  if(!block.controls || typeof block.controls !== 'object' || Array.isArray(block.controls)) return 'network_controls_shape';
  for(const [name, context] of Object.entries(block.contexts)) {
    if(!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) return 'network_context_name';
    const failure = validateContextBlock(context, CONTEXT_SCHEMA, CONTEXT_KEYS);
    if(failure) return `${name}:${failure}`;
  }
  for(const [name, control] of Object.entries(block.controls)) {
    if(/^[a-z][a-z0-9_-]{0,31}$/.test(name) === false) return 'network_control_name';
    const failure = validateContextBlock(control, CONTROL_SCHEMA, CONTROL_KEYS);
    if(failure) return `${name}:${failure}`;
  }
  return null;
}

const CONTROL_EXPECTATIONS = Object.freeze({
  c1_shared_worker_created: (block) => block.sharedWorkerState === 'created' && block.workerFailure === 'no_failure_observed',
  c2_missing_module_script: (block) => block.workerFailure === 'script_load_failed' || block.workerFailure === 'destroyed_before_attach',
  c3_no_construction: (block) => block.sharedWorkerState === 'absent',
  c4_attach_failure: (block) => block.sharedWorkerState === 'unknown' && block.observerErrors > 0,
  c4_overflow: (block) => block.sharedWorkerState === 'unknown' && block.observerOverflow === 1
});

function evaluateControl(name, block) {
  const expectation = CONTROL_EXPECTATIONS[name];
  if(!expectation) return 'fail';
  try {
    return expectation(block) ? 'pass' : 'fail';
  } catch {
    return 'fail';
  }
}

module.exports = {
  BROWSER_CDP_METHODS,
  CONTEXT_KEYS,
  CONTEXT_SCHEMA,
  CONTROL_EXPECTATIONS,
  CONTROL_KEYS,
  CONTROL_SCHEMA,
  LIMITS,
  MTPROTO_STATES,
  NETWORK_KEYS,
  ORIGIN_CLASSES,
  PAGE_CDP_METHODS,
  PRIVATE_CSP_ORIGIN,
  SHARED_WORKER_STATES,
  SOURCE_FETCH_STATES,
  UNCLASSIFIED_NETWORK_BLOCK,
  VALIDATION_STATES,
  WORKER_CDP_METHODS,
  WORKER_CHUNK_PATTERNS,
  WORKER_FAILURE_STATES,
  WORKER_SOURCE_LABELS,
  allowCdpMethod,
  classifyWorkerLogEntry,
  classifyWorkerSource,
  createContextObserver,
  evaluateControl,
  isWorkerScriptType,
  labelForPathname,
  validateContextBlock,
  validateNetworkBlock
};
