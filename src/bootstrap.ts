import './serverPicker.scss';
import {
  ACTIVE_SERVER_ID_KEY,
  DEFAULT_SERVER_HOST,
  DEMO_SERVER_HOST,
  SERVER_CHOICE_KEY,
  DiscoveredServer,
  fetchServerDiscovery,
  formatSPKIFingerprint,
  forgetServer,
  getServerPin,
  getServerPinState,
  normalizeServerHost,
  websocketConnectionFailureMessage,
  writeServerPin
} from '@config/serverSelection';
import type {MtprotoTarget} from '@config/mtprotoTarget';

declare const __MTPROTO_TARGET__: MtprotoTarget | undefined;

const runtime = window as any;
const buildTarget = typeof __MTPROTO_TARGET__ === 'undefined' ? undefined : __MTPROTO_TARGET__;
const pageHost = location.hostname.toLowerCase().replace(/\.+$/, '');
const tailnetHost = 'teagram.tailaa4918.ts.net';

function setActiveContext(id: string, host: string, target: MtprotoTarget) {
  runtime.__TEAGRAM_ACTIVE_SERVER_ID__ = id;
  runtime.__TEAGRAM_ACTIVE_SERVER_HOST__ = host;
  runtime.__TEAGRAM_ACTIVE_MTPROTO_TARGET__ = target;
}

function setConnectPolicy(host: string, target?: MtprotoTarget) {
  const sources = new Set([`'self'`, `https://${host}`, `wss://${host}:*`]);
  if(target?.mode === 'private') {
    const endpoint = new URL(target.endpoint);
    sources.add(endpoint.origin);
  }
  let policy = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"][data-server-policy]');
  if(!policy) {
    policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.dataset.serverPolicy = 'true';
    document.head.append(policy);
  }
  policy.content = `connect-src ${[...sources].join(' ')};`;
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

async function unregisterServiceWorkers(serverId?: string): Promise<void> {
  if(!('serviceWorker' in navigator)) return Promise.resolve();
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
  probeConnection = false
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

  setActiveContext(id, host, target);
  setConnectPolicy(host, target);
  document.querySelector('.server-picker')?.remove();
  await import('./index');
}

function probeWebSocket(endpoint: string) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let socket: WebSocket;
    const finish = (connected: boolean) => {
      if(settled) return;
      settled = true;
      clearTimeout(timer);
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
    const timer = setTimeout(() => finish(false), 8000);
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

async function showServerPicker() {
  let savedChoice = DEMO_SERVER_HOST;
  try {
    savedChoice = localStorage.getItem(SERVER_CHOICE_KEY) || DEMO_SERVER_HOST;
  } catch{}

  const {card} = showPanel(
    'Choose your server',
    'The server operator can read all non-secret chats. Choose a server you trust. Your account and stored data stay with the server you select.'
  );
  const form = document.createElement('form');
  const label = document.createElement('label');
  label.textContent = 'Server host';
  const input = document.createElement('input');
  input.autocomplete = 'off';
  input.inputMode = 'url';
  input.spellcheck = false;
  input.value = savedChoice;
  input.placeholder = DEMO_SERVER_HOST;
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

    setConnectPolicy(host);
    let discovered: DiscoveredServer;
    try {
      discovered = await fetchServerDiscovery(host);
    } catch(error) {
      const message = error instanceof Error ? error.message : '';
      addError(card, /not a Teagram server/i.test(message) ? message :
        `Could not reach ${host}. Check that it is online and publishes Teagram discovery.`);
      return;
    }

    const pin = getServerPin(host);
    const pinState = getServerPinState(discovered, pin);
    if(pinState === 'mismatch') {
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
      mismatch.card.append(createButton('Forget this server', async() => {
        try {
          await unregisterServiceWorkers(discovered.id);
          await forgetServer(host);
          location.reload();
        } catch(error) {
          addError(mismatch.card, error instanceof Error ? error.message : 'Could not remove this server data');
        }
      }));
      return;
    }

    if(pinState === 'match') {
      await activateServer(host, discovered.id, discovered.target, host, true);
      return;
    }

    showFirstUseConfirmation(discovered);
  }
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
      await activateServer(discovered.host, discovered.id, discovered.target, discovered.host, true);
    } catch(error) {
      addError(card, error instanceof Error ? error.message : 'Could not save this server pin');
    }
  }));
  card.append(createButton('Back', () => showServerPicker(), true));
}

async function boot() {
  if(pageHost === 'web.teagram.io') {
    await showServerPicker();
    return;
  }

  if(pageHost === tailnetHost) {
    if(!buildTarget) throw new Error('The tailnet server target is missing from this build');
    await activateServer(tailnetHost, 'default', buildTarget, DEFAULT_SERVER_HOST);
    return;
  }

  if(!buildTarget) {
    await import('./index');
    return;
  }
  const endpointHost = buildTarget.mode === 'private' ? new URL(buildTarget.endpoint).hostname : pageHost;
  await activateServer(endpointHost, 'default', buildTarget, DEFAULT_SERVER_HOST);
}

void boot().catch((error) => {
  const {card} = showPanel('Could not start Teagram Web');
  addError(card, error instanceof Error ? error.message : 'The selected server could not be started.');
});
