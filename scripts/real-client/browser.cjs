const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const REQUIRED_SCENARIOS = ['sign-in', 'message', 'group'];
const PRIVATE_CSP_ORIGIN = 'https://telegramd.test';
const PRIVATE_CSP_WSS = 'wss://telegramd.test/apiws';
const MESSAGE = 'browser-ci-hello';
const GROUP_MESSAGE = 'browser-ci-group-hello';

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
      !/^sha256:[0-9a-f]{64}$/.test(config.artifactDigest || '') ||
      !/^[0-9a-f]{40}$/.test(config.webRevision || '') ||
      !/^[A-Za-z0-9+/]{43}=$/.test(config.leafSPKI || '') ||
      Buffer.from(config.leafSPKI, 'base64').byteLength !== 32 ||
      Buffer.from(config.leafSPKI, 'base64').toString('base64') !== config.leafSPKI ||
      !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(config.frontIp || '') ||
      config.screenshotDirectory !== `/tmp/real-client-${config.runId}` ||
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

function createNetworkObserver(page, contextName) {
  const events = [];
  const eventKeys = new Set();
  const targets = new Map();
  const observedWorkerTargets = {shared_worker: new Set(), service_worker: new Set()};
  const pendingCommands = new Map();
  const setupPromises = new Set();
  const errors = [];
  let nextCommandId = 0;
  let cdp;

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
    const id = ++nextCommandId;
    const key = `${sessionId}:${id}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(key);
        reject(new Error(`cdp_timeout:${method}`));
      }, 5000);
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
      cdp.send('Target.sendMessageToTarget', {
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
      await sendTargetCommand(sessionId, 'Runtime.runIfWaitingForDebugger');
    })().catch(() => {
      errors.push('worker_target_setup');
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
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      errors.push('invalid_worker_cdp_message');
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
  }

  async function start() {
    cdp = await page.context().newCDPSession(page);
    cdp.on('Network.requestWillBeSent', (event) => {
      const kind = event.type === 'WebSocket' ? 'websocket' : 'fetch';
      record('page', 'page', kind, event.request.url, 'Network.requestWillBeSent');
    });
    cdp.on('Network.webSocketCreated', (event) => record('page', 'page', 'websocket', event.url, 'Network.webSocketCreated'));
    cdp.on('Audits.issueAdded', ({issue}) => recordCspIssue('page', 'page', issue));
    cdp.on('Log.entryAdded', ({entry}) => recordLogViolation('page', 'page', entry));
    cdp.on('Target.attachedToTarget', ({sessionId, targetInfo}) => addTarget(sessionId, targetInfo));
    cdp.on('Target.receivedMessageFromTarget', ({sessionId, message}) => dispatchTargetMessage(sessionId, message));
    cdp.on('Target.detachedFromTarget', ({sessionId}) => targets.delete(sessionId));
    await cdp.send('Network.enable');
    await cdp.send('Audits.enable');
    await cdp.send('Log.enable');
    await cdp.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true, flatten: false});
  }

  async function waitForSetup() {
    while(setupPromises.size > 0) {
      await Promise.all([...setupPromises]);
    }
  }

  return {
    events,
    errors,
    async start() {
      await start();
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
    stop() {
      cdp?.removeAllListeners();
    }
  };
}

async function waitForWorkerTargets(page, observer) {
  const deadline = Date.now() + 25_000;
  while(Date.now() < deadline) {
    await observer.waitForSetup();
    const summary = observer.summary();
    if(summary.workerTargets.shared_worker > 0 && summary.workerTargets.service_worker > 0) return;
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

async function main() {
  let report;
  let browser;
  const contexts = [];
  const observers = [];
  const capturedScreenshots = {count: 0};
  let cleanupFailed = false;
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

    const accounts = runtime.accounts;
    const alice = {context: await browser.newContext({viewport: {width: 1280, height: 900}})};
    contexts.push(alice.context);
    alice.page = await alice.context.newPage();
    alice.observer = createNetworkObserver(alice.page, 'alice');
    observers.push(alice.observer);
    await alice.observer.start();

    const bob = {context: await browser.newContext({viewport: {width: 1280, height: 900}})};
    contexts.push(bob.context);
    bob.page = await bob.context.newPage();
    bob.observer = createNetworkObserver(bob.page, 'bob');
    observers.push(bob.observer);
    await bob.observer.start();

    const pageErrors = [];
    for(const page of [alice.page, bob.page]) {
      page.on('pageerror', () => pageErrors.push('pageerror'));
    }

    currentScenario = 'sign-in';
    await signIn(alice.page, accounts[0], 'alice', runtime.screenshotDirectory, capturedScreenshots);
    await signIn(bob.page, accounts[1], 'bob', runtime.screenshotDirectory, capturedScreenshots);
    await waitForWorkerTargets(alice.page, alice.observer);
    await waitForWorkerTargets(bob.page, bob.observer);
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
    const bobDirectMessage = bob.page.locator('#column-center .bubble .message').filter({hasText: MESSAGE});
    await bobDirectMessage.first().waitFor({state: 'visible', timeout: 30_000}).catch(() => failStage('bob_direct_message_visible'));
    await bob.page.waitForTimeout(600);
    if(await bobDirectMessage.count() !== 1) failStage('bob_direct_message_count');
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
    const networkContexts = Object.fromEntries([['alice', alice.observer], ['bob', bob.observer]].map(([name, observer]) => {
      const summary = observer.summary();
      return [name, {
        workerTargets: summary.workerTargets,
        allowedWebSockets: summary.allowedWebSockets,
        attemptsBySource: summary.attemptsBySource,
        unexpectedAttemptsBySource: summary.unexpectedAttemptsBySource,
        allowedWebSocketsBySource: summary.allowedWebSocketsBySource
      }];
    }));
    const unexpectedAttempts = observers.reduce((sum, observer) => sum + observer.summary().unexpectedAttempts, 0);
    const observerErrors = observers.reduce((sum, observer) => sum + observer.summary().observerErrors, 0);
    if(unexpectedAttempts !== 0 || observerErrors !== 0 || pageErrors.length !== 0) failStage('browser_egress_or_page_errors');
    if(['alice', 'bob'].some((name) => networkContexts[name].workerTargets.shared_worker < 1 ||
        networkContexts[name].workerTargets.service_worker < 1 || networkContexts[name].allowedWebSockets < 1)) {
      failStage('browser_worker_or_websocket_evidence');
    }

    report = {
      status: 'passed',
      scenarios: report,
      contextCount: contexts.length,
      screenshotsCaptured: capturedScreenshots.count,
      network: {unexpectedAttempts, observerErrors, contexts: networkContexts}
    };
  } catch(error) {
    report = {
      status: 'failed',
      stage: currentStage,
      ...(currentScenario ? {scenario: currentScenario} : {}),
      errorClass: ['TimeoutError', 'TypeError', 'Error', 'AbortError'].includes(error?.name) ? error.name : 'OtherError',
      scenarios: Array.isArray(report) ? report : [],
      contextCount: contexts.length,
      screenshotsCaptured: capturedScreenshots.count
    };
  } finally {
    currentStage = 'cleanup';
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
    for(const observer of observers) observer.stop();
  }

  if(cleanupFailed) {
    process.stdout.write(`${JSON.stringify({status: 'failed', stage: 'cleanup'})}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if(report.status !== 'passed') process.exitCode = 1;
}

async function waitForMembers(page, memberRows) {
  const deadline = Date.now() + 20_000;
  while(Date.now() < deadline) {
    if(await memberRows.count() >= 2) return;
    await page.waitForTimeout(100);
  }
  failStage('bob_group_member_count');
}

let runtime;
module.exports = {matchesPrivateArtifactManifest};
if(require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({status: 'failed', stage: currentStage, errorClass: 'OtherError'})}\n`);
    process.exitCode = 1;
  });
}
