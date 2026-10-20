import type {MtprotoTarget} from '@config/mtprotoTarget';
import {validatePrivateEndpoint, validateMtprotoTarget} from '@config/mtprotoTarget';

export const SERVER_CHOICE_KEY = 'teagram.server-choice.v1';
export const SERVER_PINS_KEY = 'teagram.server-pins.v1';
export const ACTIVE_SERVER_ID_KEY = 'teagram.active-server-id.v1';
const SERVER_PINS_LOCK = 'teagram.server-pins.v1';
export const DEFAULT_SERVER_HOST = 'web.teagram.io';
export const DEMO_SERVER_HOST = 'demo.teagram.io';
export const DISCOVERY_MAX_BYTES = 16 * 1024;
export const DISCOVERY_TIMEOUT_MS = 8000;

export function shouldPromptForServerSelection(host: string) {
  return host.toLowerCase().replace(/\.+$/, '') === DEFAULT_SERVER_HOST;
}

export function getServerConnectSources(host: string, target?: MtprotoTarget) {
  const httpsOrigin = new URL(`https://${host}`);
  const websocketOrigin = new URL(httpsOrigin);
  websocketOrigin.protocol = 'wss:';

  const sources = new Set(['\u0027self\u0027', httpsOrigin.origin, websocketOrigin.origin]);
  if(target?.mode === 'private') sources.add(new URL(target.endpoint).origin);
  return [...sources];
}

export type ServerPin = {
  host: string,
  endpoint: string,
  dc_id: number,
  key_fingerprint: string
};

export type DiscoveredServer = {
  host: string,
  id: string,
  target: MtprotoTarget,
  pin: ServerPin,
  spkiFingerprint: string
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeBase64(value: string) {
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('not a Teagram server: invalid RSA key encoding');
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for(let index = 0; index < binary.length; ++index) bytes[index] = binary.charCodeAt(index);
  if(btoa(String.fromCharCode(...bytes)) !== value) {
    throw new Error('not a Teagram server: non-canonical RSA key encoding');
  }
  return bytes;
}

function toHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return decodeBase64(padded);
}

function serializeTlBytes(value: Uint8Array) {
  const headerLength = value.length < 254 ? 1 : 4;
  const output = new Uint8Array(headerLength + value.length + (4 - (headerLength + value.length) % 4) % 4);
  if(headerLength === 1) {
    output[0] = value.length;
  } else {
    output[0] = 254;
    output[1] = value.length & 0xff;
    output[2] = value.length >> 8 & 0xff;
    output[3] = value.length >> 16 & 0xff;
  }
  output.set(value, headerLength);
  return output;
}

async function sha256(bytes: Uint8Array) {
  const input = new Uint8Array(bytes.length);
  input.set(bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input.buffer));
}

async function sha1(bytes: Uint8Array) {
  const input = new Uint8Array(bytes.length);
  input.set(bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-1', input.buffer));
}

export function normalizeServerHost(input: string) {
  const value = input.trim();
  if(!value || /[\/?#@\\\s]/.test(value) || value.includes(':')) {
    throw new Error('Enter a host name without a scheme, path, port, query, or fragment');
  }

  let url: URL;
  try {
    url = new URL('https://' + value);
  } catch{
    throw new Error('Enter a valid server host');
  }

  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if(!host || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    host.length > 253 || host === 'telegram.org' || host.endsWith('.telegram.org') ||
    host.split('.').some((label) => !label || label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('This server host is not allowed');
  }
  return host;
}

export async function validateDiscoveryDocument(hostInput: string, value: unknown): Promise<DiscoveredServer> {
  const host = normalizeServerHost(hostInput);
  if(!record(value) || value.version !== 1 || !record(value.mtproto) || !record(value.websocket)) {
    throw new Error('not a Teagram server: unsupported discovery document');
  }

  const {endpoint, dc_id, rsa_spki} = value.mtproto;
  const websocketEndpoint = value.websocket.endpoint;
  if(typeof dc_id !== 'number' || !Number.isInteger(dc_id) || dc_id <= 0 || dc_id > 0x7fffffff ||
    typeof rsa_spki !== 'string' || typeof endpoint !== 'string' || typeof websocketEndpoint !== 'string') {
    throw new Error('not a Teagram server: incomplete discovery document');
  }

  let socketUrl: URL;
  try {
    socketUrl = new URL(validatePrivateEndpoint(websocketEndpoint));
  } catch{
    throw new Error('not a Teagram server: invalid WebSocket endpoint');
  }
  if(socketUrl.hostname.toLowerCase() !== host) {
    throw new Error('not a Teagram server: WebSocket endpoint host does not match the entered host');
  }

  const der = decodeBase64(rsa_spki);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('spki', der, {name: 'RSA-OAEP', hash: 'SHA-256'}, true, ['encrypt']);
  } catch{
    throw new Error('not a Teagram server: invalid RSA public key');
  }
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if(jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    throw new Error('not a Teagram server: discovery key is not RSA');
  }
  const modulus = fromBase64Url(jwk.n);
  const exponent = fromBase64Url(jwk.e);
  if(modulus.length !== 256 || exponent.length !== 3 || toHex(exponent) !== '010001') {
    throw new Error('not a Teagram server: key must be RSA-2048 with exponent 65537');
  }

  const pemBody = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)?.join('\n') || '';
  const publicKey = `-----BEGIN PUBLIC KEY-----\n${pemBody}\n-----END PUBLIC KEY-----\n`;
  const publicKeyHex = {modulus: toHex(modulus), exponent: toHex(exponent)};
  const tlModulus = serializeTlBytes(modulus);
  const tlExponent = serializeTlBytes(exponent);
  const tlBytes = new Uint8Array(tlModulus.length + tlExponent.length);
  tlBytes.set(tlModulus);
  tlBytes.set(tlExponent, tlModulus.length);
  const mtprotoFingerprintBytes = await sha1(tlBytes);
  let mtprotoFingerprint = '';
  for(let index = mtprotoFingerprintBytes.length - 1; index >= mtprotoFingerprintBytes.length - 8; index--) {
    mtprotoFingerprint += toHex(mtprotoFingerprintBytes.slice(index, index + 1));
  }

  const spkiFingerprint = toHex(await sha256(der));
  const target = validateMtprotoTarget({
    mode: 'private',
    endpoint: websocketEndpoint,
    fingerprint: mtprotoFingerprint,
    publicKey,
    publicKeyHex,
    routeLock: {
      mode: 'private',
      endpoint: websocketEndpoint,
      transport: 'websocket',
      dcIds: [1, 2, 3, 4, 5],
      connectionTypes: ['client', 'upload', 'download']
    }
  });
  const id = 'custom-' + toHex(await sha256(new TextEncoder().encode(host)));
  const pin = {host, endpoint: websocketEndpoint, dc_id, key_fingerprint: spkiFingerprint};
  return {host, id, target, pin, spkiFingerprint};
}

export async function fetchServerDiscovery(hostInput: string, fetcher: typeof fetch = fetch): Promise<DiscoveredServer> {
  const host = normalizeServerHost(hostInput);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetcher(`https://${host}/.well-known/telegramd/client`, {
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
      headers: {accept: 'application/json'}
    });
    if(!response.ok) throw new Error(`Server discovery failed (${response.status})`);
    const declaredLength = Number(response.headers.get('content-length'));
    if(Number.isFinite(declaredLength) && declaredLength > DISCOVERY_MAX_BYTES) {
      throw new Error('not a Teagram server: discovery document is too large');
    }

    const reader = response.body?.getReader();
    if(!reader) throw new Error('not a Teagram server: empty discovery document');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while(true) {
      const {done, value} = await reader.read();
      if(done) break;
      size += value.byteLength;
      if(size > DISCOVERY_MAX_BYTES) {
        await reader.cancel();
        throw new Error('not a Teagram server: discovery document is too large');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for(const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    } catch{
      throw new Error('not a Teagram server: invalid discovery document');
    }
    return await validateDiscoveryDocument(host, document);
  } finally {
    clearTimeout(timer);
  }
}

export function formatSPKIFingerprint(fingerprint: string) {
  return fingerprint.match(/.{1,4}/g)?.join(':').toUpperCase() || fingerprint.toUpperCase();
}

export function websocketConnectionFailureMessage(host: string) {
  return `${host} is unreachable or does not allow https://web.teagram.io. Add that exact origin to TG_WEBSOCKET_ALLOWED_ORIGINS.`;
}

export function readServerPins(): Record<string, ServerPin> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SERVER_PINS_KEY) || '{}');
    return record(parsed) ? parsed as Record<string, ServerPin> : {};
  } catch{
    return {};
  }
}

function updateServerPins(update: (pins: Record<string, ServerPin>) => void) {
  if(typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.reject(new Error('This browser cannot safely confirm this server'));
  }

  return navigator.locks.request(SERVER_PINS_LOCK, () => {
    const pins = readServerPins();
    update(pins);
    localStorage.setItem(SERVER_PINS_KEY, JSON.stringify(pins));
  });
}

export function getServerPin(host: string) {
  return readServerPins()[host];
}

export function pinMatches(discovered: DiscoveredServer, pin: ServerPin) {
  return pin.host === discovered.pin.host && pin.endpoint === discovered.pin.endpoint &&
    pin.dc_id === discovered.pin.dc_id && pin.key_fingerprint === discovered.pin.key_fingerprint;
}

export function getServerPinState(discovered: DiscoveredServer, pin?: ServerPin) {
  if(!pin) return 'first-use' as const;
  return pinMatches(discovered, pin) ? 'match' as const : 'mismatch' as const;
}

export function writeServerPin(discovered: DiscoveredServer) {
  if(discovered.pin.host !== discovered.host) {
    return Promise.reject(new Error('The server identity does not match the confirmed host'));
  }

  return updateServerPins((pins) => {
    const current = pins[discovered.host];
    if(current && !pinMatches(discovered, current)) {
      throw new Error('This server identity changed. Forget this server before confirming it again.');
    }
    if(!current) pins[discovered.host] = discovered.pin;
  });
}

export async function forgetServer(hostInput: string) {
  if(typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('This browser cannot safely update server pins');
  }
  const host = normalizeServerHost(hostInput);
  const id = 'custom-' + toHex(await sha256(new TextEncoder().encode(host)));
  for(const key of Object.keys(localStorage)) {
    if(key.startsWith(`teagram-${id}:`)) localStorage.removeItem(key);
  }
  for(const key of Object.keys(sessionStorage)) {
    if(key.startsWith(`teagram-${id}:`)) sessionStorage.removeItem(key);
  }
  const knownDatabases = [
    `tweb-${id}`,
    `tweb-${id}-common`,
    ...[1, 2, 3, 4].map((account) => `tweb-${id}-account-${account}`),
    `telegram-${id}`
  ];
  const databases = indexedDB.databases ? await indexedDB.databases() : [];
  const databaseNames = new Set([
    ...knownDatabases,
    ...databases.map((database) => database.name).filter((name): name is string =>
      !!name && (name.startsWith(`tweb-${id}-`) || name === `tweb-${id}` || name === `telegram-${id}`))
  ]);
  await Promise.all([...databaseNames].map((name) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error(`Could not remove server database ${name}`));
    request.onblocked = () => reject(new Error('Close other tabs using this server before forgetting it'));
  })));
  if(typeof caches !== 'undefined') {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.filter((name) => name.startsWith(`teagram-${id}-`)).map((name) => caches.delete(name)));
  }

  await updateServerPins((pins) => { delete pins[host]; });
  if(localStorage.getItem(SERVER_CHOICE_KEY) === host) localStorage.removeItem(SERVER_CHOICE_KEY);
  if(localStorage.getItem(ACTIVE_SERVER_ID_KEY) === id) localStorage.removeItem(ACTIVE_SERVER_ID_KEY);
}
