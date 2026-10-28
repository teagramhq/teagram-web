import './serverPicker.scss';
import {fetchTeagramDeploymentConfig} from '@config/deploymentConfig';
import {takeShareTokenFromUrl} from '@config/shareToken';
import {
  ACTIVE_SERVER_ID_KEY,
  DEFAULT_SERVER_HOST,
  SERVER_CHOICE_KEY,
  SERVER_TARGET_KEY,
  DiscoveredServer,
  cleanServerHost,
  fetchServerDiscovery,
  forgetServer,
  formatServerKeyId,
  formatSPKIFingerprint,
  getSavedServerTarget,
  getServerConnectSources,
  getServerPin,
  getServerPinState,
  isServerSelectionOrigin,
  normalizeServerHost,
  setServerSelectionAction,
  storeSavedServerTarget,
  websocketConnectionFailureMessage,
  writeServerPin
} from '@config/serverSelection';
import type {ServerSelectionAction, ServerSelectionState} from '@config/serverSelection';
import type {MtprotoTarget} from '@config/mtprotoTarget';
import type {FormatterArguments, LangPackKey} from '@lib/langPack';
import {i18n} from '@lib/langPack';

import styles from '@/pages/authFlow.module.scss';

declare const __MTPROTO_TARGET__: MtprotoTarget | undefined;

const SERVER_READY_KEY = 'teagram.server-ready.v1';
const SERVER_CHANGE_KEY = 'teagram.server-change.v1';
const runtime = window as any;
const buildTarget = typeof __MTPROTO_TARGET__ === 'undefined' ? undefined : __MTPROTO_TARGET__;
const pageHost = location.hostname.toLowerCase().replace(/\.+$/, '');

function setActiveContext(id: string, host: string, target: MtprotoTarget, discovered?: DiscoveredServer, autoGuest = false) {
  runtime.__TEAGRAM_ACTIVE_SERVER_ID__ = id;
  runtime.__TEAGRAM_ACTIVE_SERVER_HOST__ = host;
  runtime.__TEAGRAM_ACTIVE_MTPROTO_TARGET__ = target;
  runtime.__TEAGRAM_ACTIVE_GUEST_SIGN_UP__ = discovered?.guestSignUpEnabled === true;
  runtime.__TEAGRAM_ACTIVE_TURNSTILE_SITE_KEY__ = discovered?.turnstileSiteKey;
  runtime.__TEAGRAM_ACTIVE_DEMO_WIPE_GENERATION__ = discovered?.wipeGeneration;
  runtime.__TEAGRAM_AUTO_GUEST__ = autoGuest === true;
}

function setConnectPolicy(host: string, target?: MtprotoTarget, enforceInCurrentDocument = false) {
  const sources = getServerConnectSources(host, target);
  setConnectPolicyContent([...sources].join(' '), enforceInCurrentDocument);
}

function setServerSelectionPolicy() {
  setConnectPolicyContent('\'self\' https: wss:');
}

function setConnectPolicyContent(sources: string, enforceInCurrentDocument = false) {
  const content = `connect-src ${sources};`;
  let policy = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"][data-server-policy]');
  if(!policy) {
    policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.dataset.serverPolicy = 'true';
  }
  policy.content = content;
  if(!policy.isConnected) document.head.append(policy);
  if(enforceInCurrentDocument) {
    let enforcementPolicy = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"][data-server-policy-enforcement]');
    if(!enforcementPolicy) {
      enforcementPolicy = document.createElement('meta');
      enforcementPolicy.httpEquiv = 'Content-Security-Policy';
      enforcementPolicy.dataset.serverPolicyEnforcement = 'true';
    }
    enforcementPolicy.content = content;
    if(!enforcementPolicy.isConnected) document.head.append(enforcementPolicy);
  }
}

function createButton(label: string, onClick: () => void | Promise<void>, secondary = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if(secondary) button.classList.add('server-picker__secondary');
  button.addEventListener('click', () => { void onClick(); });
  return button;
}

function showPanel(title: string, description?: string) {
  document.querySelector('.server-picker')?.remove();
  const shell = document.createElement('main');
  shell.className = 'server-picker';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-modal', 'true');
  const card = document.createElement('section');
  card.className = 'server-picker__card';
  const heading = document.createElement('h1');
  heading.textContent = title;
  card.append(heading);
  if(description) {
    const body = document.createElement('p');
    body.textContent = description;
    card.append(body);
  }
  shell.append(card);
  document.body.append(shell);
  return {shell, card};
}

function addError(card: HTMLElement, message: string) {
  const error = document.createElement('p');
  error.className = 'server-picker__error';
  error.setAttribute('role', 'alert');
  error.textContent = message;
  card.append(error);
}

function serverDiscoveryErrorMessage(host: string, error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /not a Teagram server/i.test(message) ? message :
    `Could not reach ${host}. Check that it is online and publishes Teagram discovery.`;
}

async function unregisterServiceWorkers(serverId?: string): Promise<void> {
  if(!('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map(async(registration) => {
    const worker = registration.active || registration.waiting || registration.installing;
    if(serverId && worker) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const channel = new MessageChannel();
        function finish() {
          if(settled) return;
          settled = true;
          clearTimeout(timeout);
          channel.port1.close();
          resolve();
        }
        const timeout = setTimeout(finish, 3000);
        channel.port1.onmessage = finish;
        try {
          worker.postMessage({type: 'teagram:close-server-databases', serverId}, [channel.port2]);
        } catch{
          finish();
        }
      });
    }
    await registration.unregister();
  }));
}

async function activateServer(
  host: string,
  id: string,
  target: MtprotoTarget,
  rememberChoice: string,
  probeConnection = false,
  discovered?: DiscoveredServer,
  autoGuest = false
) {
  if(probeConnection && target.mode === 'private') {
    const connected = await probeWebSocket(target.endpoint);
    if(!connected) {
      const {card} = showPanel('Could not connect to this server');
      addError(card, websocketConnectionFailureMessage(host));
      card.append(createButton('Back', () => showServerPicker(), true));
      return;
    }
  }

  const previousId = localStorage.getItem(ACTIVE_SERVER_ID_KEY) || 'default';
  try {
    localStorage.setItem(SERVER_CHOICE_KEY, rememberChoice);
    localStorage.setItem(ACTIVE_SERVER_ID_KEY, id);
  } catch{
    const {card} = showPanel('Browser storage is unavailable');
    addError(card, 'Allow browser storage to choose and remember a server.');
    return;
  }

  if(previousId !== id) {
    await unregisterServiceWorkers();
    location.reload();
    return;
  }

  setActiveContext(id, host, target, discovered, autoGuest);
  setConnectPolicy(host, target);
  document.querySelector('.server-picker')?.remove();
  await import('./index');
}

function probeWebSocket(endpoint: string, signal = new AbortController().signal) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let socket: WebSocket;
    const finish = (connected: boolean) => {
      if(settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if(socket) {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onError);
        if(socket.readyState < WebSocket.CLOSING) socket.close();
      }
      resolve(connected);
    };
    const onOpen = () => finish(true);
    const onError = () => finish(false);
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), 8000);
    if(signal.aborted) {
      finish(false);
      return;
    }
    signal.addEventListener('abort', onAbort, {once: true});
    try {
      socket = new WebSocket(endpoint, 'binary');
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onError);
    } catch{
      finish(false);
    }
  });
}

async function showServerPicker(initialError?: string) {
  let savedChoice = '';
  try {
    savedChoice = localStorage.getItem(SERVER_CHOICE_KEY) || '';
  } catch{}

  const {card} = showPanel(
    'Choose your server',
    'The server operator can read all non-secret chats. Choose a server you trust. Your account and stored data stay with the server you select.'
  );
  if(initialError) addError(card, initialError);
  const form = document.createElement('form');
  const label = document.createElement('label');
  label.textContent = 'Server host';
  const input = document.createElement('input');
  input.autocomplete = 'off';
  input.inputMode = 'url';
  input.spellcheck = false;
  input.value = savedChoice;
  input.placeholder = 'your.server.host';
  label.append(input);
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Continue';
  form.append(label, submit);
  card.append(form);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit.disabled = true;
    void chooseHost(input.value).finally(() => { submit.disabled = false; });
  });

  async function chooseHost(value: string) {
    let host: string;
    try {
      host = normalizeServerHost(value);
    } catch(error) {
      addError(card, error instanceof Error ? error.message : 'Enter a valid server host');
      return;
    }

    if(host === DEFAULT_SERVER_HOST) {
      if(!buildTarget) {
        addError(card, 'The default server target is not available in this build.');
        return;
      }
      await activateServer(DEFAULT_SERVER_HOST, 'default', buildTarget, DEFAULT_SERVER_HOST);
      return;
    }

    let discovered: DiscoveredServer;
    try {
      discovered = await fetchServerDiscovery(host);
    } catch(error) {
      addError(card, serverDiscoveryErrorMessage(host, error));
      return;
    }

    const pin = getServerPin(host);
    const pinState = getServerPinState(discovered, pin);
    if(pinState === 'mismatch') {
      showServerIdentityChanged(discovered, pin!);
      return;
    }

    if(pinState === 'match') {
      await activateServer(host, discovered.id, discovered.target, host, true, discovered);
      return;
    }

    showFirstUseConfirmation(discovered);
  }
}

function discoveryErrorKey(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const status = /Server discovery failed \((\d+)\)/.exec(message);
  if(status) return Number(status[1]) >= 500 ? 'Teagram.Server.Unreachable' : 'Teagram.Server.Unsupported';
  if(/not a Teagram server/i.test(message)) return 'Teagram.Server.Unsupported';
  return 'Teagram.Server.Unreachable';
}

function localizedHost(host: string) {
  const strong = document.createElement('strong');
  strong.textContent = host;
  return strong;
}

function fingerprintBlock(labelKey: LangPackKey, fingerprint: string) {
  const block = document.createElement('div');
  const label = document.createElement('p');
  label.className = styles.serverSelectionFingerprintLabel;
  label.append(i18n(labelKey));
  const value = document.createElement('p');
  value.className = styles.serverSelectionFingerprint;
  value.dir = 'ltr';
  const groups = formatServerKeyId(fingerprint).split('-');
  for(let index = 0; index < groups.length; index += 4) {
    const line = document.createElement('span');
    line.className = styles.serverSelectionFingerprintGroup;
    line.textContent = groups.slice(index, index + 4).join('-') + (index + 4 < groups.length ? '-' : '');
    value.append(line);
    if(index + 4 < groups.length) value.append(document.createElement('wbr'));
  }
  block.append(label, value);
  return block;
}

function popupContent(...children: Node[]) {
  const content = document.createElement('div');
  content.className = styles.serverSelectionPopupContent;
  content.append(...children);
  return content;
}

function popupParagraph(key: LangPackKey, args?: FormatterArguments) {
  const paragraph = document.createElement('p');
  paragraph.className = styles.serverSelectionPopupParagraph;
  paragraph.append(i18n(key, args));
  return paragraph;
}

function selectionError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if(/without a port/i.test(code)) return 'Teagram.Server.AddressPort';
  if(/not allowed/i.test(code)) return 'Teagram.Server.AddressNotAllowed';
  if(/valid server host/i.test(code)) return 'Teagram.Server.AddressInvalid';
  return 'Teagram.Server.SaveFailed';
}

function createServerSelectionAction(initial: ServerSelectionState, initialActiveHost?: string): ServerSelectionAction {
  let current = initial;
  let sequence = 0;
  const activeHost = initialActiveHost;
  let blockedServer: DiscoveredServer | undefined;
  let blockedPin: ReturnType<typeof getServerPin>;
  let focusReturnTarget: HTMLElement | undefined;
  const listeners = new Set<(state: ServerSelectionState) => void>();

  const publish = (state: ServerSelectionState) => {
    current = state;
    listeners.forEach((listener) => listener(current));
  };

  const setFailure = (errorKey: string, host: string, retryable = false) => {
    publish({phase: 'selecting', host, changing: current.changing, errorKey, retryable});
  };

  const isCurrentRun = (run: number, signal: AbortSignal) => !signal.aborted && run === sequence;

  function restoreActiveServer() {
    const host = activeHost || current.host;
    try {
      sessionStorage.removeItem(SERVER_READY_KEY);
      sessionStorage.removeItem(SERVER_CHANGE_KEY);
    } catch(error) {
      console.error('Could not clear server change state', error);
    }
    const target = host === DEFAULT_SERVER_HOST ? buildTarget : getSavedServerTarget(host)?.target;
    if(target) setConnectPolicy(host, target, true);
    publish({phase: 'connected', host, changing: false});
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="Change server"]')?.focus());
  }

  async function showFirstUseConfirmation(discovered: DiscoveredServer, target: HTMLElement | undefined) {
    const extraContent = popupContent(
      fingerprintBlock('Teagram.Server.Fingerprint', discovered.spkiFingerprint),
      popupParagraph('Teagram.Server.ConfirmNote')
    );
    const {SimpleConfirmationPopup} = await import('@components/popups/simpleConfirmation');
    await SimpleConfirmationPopup.show({
      titleLangKey: 'Teagram.Server.ConfirmTitle',
      descriptionLangKey: 'Teagram.Server.ConfirmText',
      descriptionArgs: [localizedHost(discovered.host)],
      button: {langKey: 'Teagram.Server.Confirm'},
      cancelLangKey: 'Cancel',
      focusTrap: true,
      disableTextEnterConfirm: true,
      scrollable: true,
      extraContent,
      focusReturnTarget: target
    });
    try {
      await writeServerPin(discovered);
    } catch(error) {
      console.error('Could not safely pin server fingerprint', error);
      throw new Error(typeof navigator !== 'undefined' && !navigator.locks ? 'Teagram.Server.PinUnavailable' : 'Teagram.Server.SaveFailed');
    }
  }

  async function showIdentityConfirmation(discovered: DiscoveredServer, pin: NonNullable<ReturnType<typeof getServerPin>>) {
    const extraContent = popupContent(
      fingerprintBlock('Teagram.Server.PinnedFingerprint', pin.key_fingerprint),
      fingerprintBlock('Teagram.Server.PresentedFingerprint', discovered.spkiFingerprint),
      popupParagraph('Teagram.Server.IdentityBlocked'),
      popupParagraph('Teagram.Server.IdentityCancel')
    );
    const {SimpleConfirmationPopup} = await import('@components/popups/simpleConfirmation');
    try {
      await SimpleConfirmationPopup.show({
        titleLangKey: 'Teagram.Server.IdentityTitle',
        descriptionLangKey: 'Teagram.Server.IdentityChanged',
        descriptionArgs: [localizedHost(discovered.host)],
        button: {langKey: 'Teagram.Server.IdentityContinue'},
        cancelLangKey: 'Cancel',
        focusTrap: true,
        disableTextEnterConfirm: true,
        scrollable: true,
        verticalButtons: true,
        extraContent,
        focusReturnTarget
      });
    } catch{
      setFailure('Teagram.Server.KeyMismatch', discovered.host);
      return;
    }

    try {
      await SimpleConfirmationPopup.show({
        titleLangKey: 'Teagram.Server.DeleteTitle',
        descriptionLangKey: 'Teagram.Server.DeleteText',
        descriptionArgs: [localizedHost(discovered.host)],
        button: {langKey: 'Teagram.Server.DeleteConfirm', isDanger: true},
        cancelLangKey: 'Cancel',
        focusTrap: true,
        disableTextEnterConfirm: true,
        scrollable: true,
        verticalButtons: true,
        focusReturnTarget
      });
    } catch{
      setFailure('Teagram.Server.KeyMismatch', discovered.host);
      return;
    }

    const run = ++sequence;
    publish({phase: 'checking', host: discovered.host, changing: current.changing, locked: true});
    try {
      await unregisterServiceWorkers(discovered.id);
      await forgetServer(discovered.host);
      blockedServer = undefined;
      blockedPin = undefined;
      await selectHost(discovered.host, new AbortController().signal, run, false);
    } catch(error) {
      console.error('Could not delete saved server data', error);
      if(run === sequence) setFailure('Teagram.Server.DeleteFailed', discovered.host);
    }
  }

  async function saveAndReload(host: string, signal: AbortSignal, run: number, server?: DiscoveredServer) {
    if(!isCurrentRun(run, signal)) return;
    const id = server?.id || 'default';
    let previousId = 'default';
    try {
      previousId = localStorage.getItem(ACTIVE_SERVER_ID_KEY) || 'default';
    } catch(error) {
      console.error('Could not read the active server', error);
      setFailure('Teagram.Server.SaveFailed', host);
      return;
    }
    if(previousId !== id) {
      try {
        await unregisterServiceWorkers();
      } catch(error) {
        if(!isCurrentRun(run, signal)) return;
        console.error('Could not close the previous server session', error);
        setFailure('Teagram.Server.SaveFailed', host);
        return;
      }
      if(!isCurrentRun(run, signal)) return;
    }

    if(!isCurrentRun(run, signal)) return;
    try {
      localStorage.setItem(SERVER_CHOICE_KEY, host);
      localStorage.setItem(ACTIVE_SERVER_ID_KEY, id);
      if(server) storeSavedServerTarget(server);
      else localStorage.removeItem(SERVER_TARGET_KEY);
      sessionStorage.setItem(SERVER_READY_KEY, host);
    } catch(error) {
      if(!isCurrentRun(run, signal)) return;
      console.error('Could not save server choice', error);
      setFailure('Teagram.Server.SaveFailed', host);
      return;
    }
    if(!isCurrentRun(run, signal)) return;
    location.reload();
  }

  async function selectHost(hostInput: string, signal: AbortSignal, run: number, changing: boolean) {
    const cleaned = cleanServerHost(hostInput);
    let host: string;
    try {
      host = normalizeServerHost(cleaned);
    } catch(error) {
      if(run === sequence) setFailure(selectionError(error), cleaned, false);
      return;
    }

    if(changing && activeHost === host) {
      restoreActiveServer();
      return;
    }

    publish({phase: 'checking', host, changing, locked: !!current.locked && !changing});
    if(host === DEFAULT_SERVER_HOST) {
      if(!buildTarget) {
        if(run === sequence) setFailure('Teagram.Server.Unsupported', host);
        return;
      }
      await saveAndReload(host, signal, run);
      return;
    }

    let discovered: DiscoveredServer;
    try {
      discovered = await fetchServerDiscovery(host, fetch, signal);
    } catch(error) {
      if(signal.aborted || run !== sequence) return;
      console.error('Server discovery failed', error);
      setFailure(discoveryErrorKey(error), host, discoveryErrorKey(error) === 'Teagram.Server.Unreachable');
      return;
    }
    if(signal.aborted || run !== sequence) return;

    const pin = getServerPin(host);
    const pinState = getServerPinState(discovered, pin);
    if(pinState === 'mismatch') {
      blockedServer = discovered;
      blockedPin = pin;
      publish({phase: 'checking', host, changing, locked: true});
      await showIdentityConfirmation(discovered, pin);
      return;
    }

    if(pinState === 'first-use') {
      if(typeof navigator === 'undefined' || !navigator.locks) {
        setFailure('Teagram.Server.PinUnavailable', host);
        return;
      }
      try {
        await showFirstUseConfirmation(discovered, focusReturnTarget);
      } catch(error) {
        if(run !== sequence) return;
        if(error === undefined) {
          publish({phase: 'selecting', host, changing});
          return;
        }
        console.error('Could not confirm server fingerprint', error);
        setFailure(error instanceof Error && error.message === 'Teagram.Server.PinUnavailable' ?
          'Teagram.Server.PinUnavailable' : 'Teagram.Server.SaveFailed', host);
        return;
      }
    }

    if(signal.aborted || run !== sequence) return;
    if(discovered.target.mode !== 'private') {
      setFailure('Teagram.Server.Unsupported', host);
      return;
    }
    publish({phase: 'connecting', host, changing, locked: true});
    const connected = await probeWebSocket(discovered.target.endpoint, signal);
    if(!isCurrentRun(run, signal)) return;
    if(!connected) {
      setFailure('Teagram.Server.WebSocketFailed', host, true);
      return;
    }
    await saveAndReload(host, signal, run, discovered);
  }

  const action: ServerSelectionAction = {
    getState: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setHost(host) {
      sequence++;
      publish({
        phase: current.changing ? 'selecting' : current.phase === 'connected' ? 'connected' : 'selecting',
        host,
        changing: current.changing,
        retryable: false
      });
    },
    async select(host, signal, returnTarget) {
      sequence++;
      focusReturnTarget = returnTarget || document.querySelector<HTMLElement>('#server-address') || undefined;
      await selectHost(host, signal, sequence, !!current.changing);
    },
    change() {
      if(current.phase !== 'connected') return;
      const host = activeHost || current.host;
      try {
        sessionStorage.setItem(SERVER_READY_KEY, host);
        sessionStorage.setItem(SERVER_CHANGE_KEY, host);
      } catch(error) {
        console.error('Could not prepare server change', error);
        publish({...current, errorKey: 'Teagram.Server.SaveFailed'});
        return;
      }
      location.reload();
    },
    cancelChange() {
      if(!current.changing) return;
      sequence++;
      restoreActiveServer();
    },
    continueBlocked() {
      if(blockedServer && blockedPin) void showIdentityConfirmation(blockedServer, blockedPin);
    }
  };

  return action;
}

function showServerIdentityChanged(
  discovered: DiscoveredServer,
  pin: NonNullable<ReturnType<typeof getServerPin>>,
  {allowForget = true, allowChooseAnother = true}: {allowForget?: boolean, allowChooseAnother?: boolean} = {}
) {
  const mismatch = showPanel('Server identity changed', 'This server no longer matches the identity you pinned. Teagram will not connect with the changed key.');
  const hostLine = document.createElement('p');
  hostLine.textContent = `Server: ${discovered.host}`;
  const oldFingerprint = document.createElement('p');
  oldFingerprint.className = 'server-picker__fingerprint';
  oldFingerprint.textContent = `Pinned SPKI SHA-256: ${formatSPKIFingerprint(pin.key_fingerprint)}`;
  const newFingerprint = document.createElement('p');
  newFingerprint.className = 'server-picker__fingerprint';
  newFingerprint.textContent = `Current SPKI SHA-256: ${formatSPKIFingerprint(discovered.spkiFingerprint)}`;
  mismatch.card.append(hostLine, oldFingerprint, newFingerprint);
  if(allowChooseAnother) {
    mismatch.card.append(createButton('Choose another server', async() => {
      try {
        localStorage.removeItem(SERVER_CHOICE_KEY);
        await showServerPicker();
      } catch{
        addError(mismatch.card, 'Browser storage is unavailable');
      }
    }));
  }
  if(allowForget) {
    mismatch.card.append(createButton('Forget this server', async() => {
      try {
        await unregisterServiceWorkers(discovered.id);
        await forgetServer(discovered.host);
        location.reload();
      } catch(error) {
        addError(mismatch.card, error instanceof Error ? error.message : 'Could not remove this server data');
      }
    }, true));
  }
}

async function bootConfiguredServer(config: {server: string, autoGuest: boolean}) {
  setConnectPolicy(config.server);
  const discovered = await fetchServerDiscovery(config.server);
  const pin = getServerPin(config.server);
  const pinState = getServerPinState(discovered, pin);
  if(pinState === 'mismatch') {
    showServerIdentityChanged(discovered, pin!, {allowForget: false, allowChooseAnother: false});
    return;
  }

  if(!pin) await writeServerPin(discovered);
  await activateServer(config.server, discovered.id, discovered.target, config.server, true, discovered, config.autoGuest);
}

function showFirstUseConfirmation(discovered: DiscoveredServer) {
  const {card} = showPanel(
    'Confirm this server',
    'The operator of this server can read all non-secret chats. Continue only if you trust this operator.'
  );
  const host = document.createElement('p');
  host.textContent = `Server: ${discovered.host}`;
  const fingerprint = document.createElement('p');
  fingerprint.className = 'server-picker__fingerprint';
  fingerprint.textContent = `SPKI SHA-256: ${formatSPKIFingerprint(discovered.spkiFingerprint)}`;
  card.append(host, fingerprint);
  card.append(createButton('Confirm and use this server', async() => {
    try {
      await writeServerPin(discovered);
      await activateServer(discovered.host, discovered.id, discovered.target, discovered.host, true, discovered);
    } catch(error) {
      addError(card, error instanceof Error ? error.message : 'Could not save this server pin');
    }
  }));
  card.append(createButton('Back', () => showServerPicker(), true));
}

async function startSelectionApp(action: ServerSelectionAction) {
  setServerSelectionAction(action);
  setServerSelectionPolicy();
  if(buildTarget) setActiveContext('server-selection', pageHost, buildTarget);
  await import('./index');
}

async function boot() {
  takeShareTokenFromUrl();
  const config = await fetchTeagramDeploymentConfig();
  if(config) {
    await bootConfiguredServer(config);
    return;
  }

  if(isServerSelectionOrigin(pageHost)) {
    let savedChoice = '';
    let readyChoice = '';
    let changeChoice = '';
    try {
      savedChoice = localStorage.getItem(SERVER_CHOICE_KEY) || '';
      readyChoice = sessionStorage.getItem(SERVER_READY_KEY) || '';
      changeChoice = sessionStorage.getItem(SERVER_CHANGE_KEY) || '';
    } catch{}

    if(savedChoice && readyChoice === savedChoice) {
      let host: string;
      try {
        host = normalizeServerHost(savedChoice);
      } catch{
        host = '';
      }
      const discovered = host && host !== DEFAULT_SERVER_HOST ? getSavedServerTarget(host) : undefined;
      const target = host === DEFAULT_SERVER_HOST ? buildTarget : discovered?.target;
      if(host && target) {
        const changing = changeChoice === savedChoice;
        try {
          sessionStorage.removeItem(SERVER_CHANGE_KEY);
          if(!changing) sessionStorage.removeItem(SERVER_READY_KEY);
        } catch{}
        const action = createServerSelectionAction(changing ?
          {phase: 'selecting', host, changing: true} : {phase: 'connected', host}, host);
        setActiveContext(localStorage.getItem(ACTIVE_SERVER_ID_KEY) || discovered?.id || 'default', host, target, discovered);
        if(changing) setServerSelectionPolicy();
        else setConnectPolicy(host, target);
        setServerSelectionAction(action);
        void import('./index');
        return;
      }
    }

    if(changeChoice) {
      try { sessionStorage.removeItem(SERVER_CHANGE_KEY); } catch{}
    }

    const initialState: ServerSelectionState = savedChoice ?
      {phase: 'checking', host: savedChoice, locked: true} :
      {phase: 'selecting', host: ''};
    const action = createServerSelectionAction(initialState);
    await startSelectionApp(action);
    if(savedChoice) {
      const controller = new AbortController();
      void action.select(savedChoice, controller.signal);
    }
    return;
  }

  if(!buildTarget) {
    setServerSelectionAction(undefined);
    await import('./index');
    return;
  }
  const endpointHost = buildTarget.mode === 'private' ? new URL(buildTarget.endpoint).hostname : pageHost;
  setActiveContext('default', endpointHost, buildTarget);
  setConnectPolicy(endpointHost, buildTarget);
  await import('./index');
}

void boot().catch((error) => {
  console.error('Could not start Teagram Web', error);
  setServerSelectionAction(undefined);
  void import('./index');
});
