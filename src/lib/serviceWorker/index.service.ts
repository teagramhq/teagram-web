import {logger, LogTypes} from '@lib/logger';
import {CACHE_ASSETS_NAME, requestCache} from '@lib/serviceWorker/cache';
import onStreamFetch, {toggleStreamInUse} from '@lib/serviceWorker/stream';
import {closeAllNotifications, fillPushObject, onPing, onShownNotification, resetPushAccounts} from '@lib/serviceWorker/push';
import CacheStorageController from '@lib/files/cacheStorage';
import {IS_SAFARI} from '@environment/userAgent';
import ServiceMessagePort from '@lib/serviceWorker/serviceMessagePort';
import {getLogEntries, setLogBufferEnabled} from '@lib/debug/logsBuffer';
import listenMessagePort from '@helpers/listenMessagePort';
import {getWindowClients} from '@helpers/context';
import {MessageSendPort} from '@lib/superMessagePort';
import handleDownload from '@lib/serviceWorker/download';
import onShareFetch, {checkWindowClientForDeferredShare} from '@lib/serviceWorker/share';
import {onRtmpFetch, onRtmpLeftCall} from '@lib/serviceWorker/rtmp';
import {onHlsQualityFileFetch} from '@lib/hls/onHlsQualityFileFetch';
import {get500ErrorResponse} from '@lib/serviceWorker/errors';
import {onHlsStreamFetch} from '@lib/hls/onHlsStreamFetch';
import {onHlsPlaylistFetch} from '@lib/hls/onHlsPlaylistFetch';
import {setEnvironment} from '@environment/utils';
import cryptoMessagePort from '@lib/crypto/cryptoMessagePort';
import EncryptionKeyStore from '@lib/passcode/keyStore';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';
import {onBackgroundsFetch} from '@lib/serviceWorker/backgrounds';
import {watchMtprotoOnDev} from '@lib/serviceWorker/watchMtprotoOnDev';
import {watchCacheStoragesLifetime} from './clearOldCache';
import {getActiveServerId} from '@config/serverContext';
import {IDB} from '@lib/files/idb';

// #if MTPROTO_SW
// import '../mtproto/mtproto.worker';
// #endif

export const log = logger('SW', LogTypes.Error | LogTypes.Debug | LogTypes.Log | LogTypes.Warn, true);
const ctx = self as any as ServiceWorkerGlobalScope;
const connectedServerIds = new Map<string, string>();
const pendingServerIds = new Map<string, string>();
let connectServerClient = (_source: WindowClient, _from: string) => {};

// #if !MTPROTO_SW
let _mtprotoMessagePort: MessagePort;
export const getMtprotoMessagePort = () => _mtprotoMessagePort;

let _cryptoMessagePort: MessagePort;

export const invokeVoidAll: ServiceMessagePort['invokeVoid'] = (...args) => {
  connectedWindows.forEach((windowClient) => {
    // @ts-ignore
    serviceMessagePort.invokeVoid(...args, windowClient);
  });
};

log('init');

ctx.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data;
  if(data?.type !== 'teagram:close-server-databases' || data.serverId !== getActiveServerId()) return;

  event.waitUntil(IDB.closeDatabasesForServer(data.serverId).then(() => {
    event.ports[0]?.postMessage({closed: true});
  }));
});

// setTimeout(async() => {
//   const salt = new Uint8Array([1, 2, 3]);
//   const passcode = 'ab';
//   log('hello from sw started encryption');

//   const wrappedPasscode = await crypto.subtle.importKey(
//     'raw', new TextEncoder().encode(passcode), {name: 'PBKDF2'}, false, ['deriveKey']
//   );

//   const key = await crypto.subtle.deriveKey(
//     {name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-256'},
//     wrappedPasscode, {name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']
//   );

//   const enc = await cryptoMessagePort.invokeCryptoNew({
//     method: 'aes-local-encrypt',
//     args: [{data: new Uint8Array([1, 2, 3]), key}]
//   });

//   log('hello from sw data:>>', enc);
// }, 1000);

const sendMessagePort = (source: MessageSendPort) => {
  const channel = new MessageChannel();
  serviceMessagePort.attachPort(_mtprotoMessagePort = channel.port1);
  serviceMessagePort.invokeVoid('port', undefined, source, [channel.port2]);

  const channel2 = new MessageChannel();
  cryptoMessagePort.attachPort(_cryptoMessagePort = channel2.port1);
  serviceMessagePort.invokeVoid('serviceCryptoPort', undefined, source, [channel2.port2]);
};

const sendMessagePortIfNeeded = (source: MessageSendPort) => {
  if(!connectedWindows.size && !_mtprotoMessagePort) {
    log('sending message port for mtproto');
    sendMessagePort(source);
  }
};

const connectedWindows: Map<string, WindowClient> = new Map();

const onWindowConnected = (source: WindowClient, from: string) => {
  const _log = log.bindPrefix('windowConnected');
  _log('new', source.id, 'from', from, 'before', connectedWindows.size);

  if(connectedServerIds.get(source.id) !== getActiveServerId()) {
    _log.warn('refusing client from another server', source.id);
    return;
  }

  if(source.frameType === 'none') {
    log.warn('maybe a bugged Safari starting window', source.id);
    return;
  }

  if(connectedWindows.has(source.id)) {
    _log('already connected', source.id);
    return;
  }

  _log('before', Array.from(connectedWindows));
  serviceMessagePort.invokeVoid('hello', {serverId: getActiveServerId()}, source);
  sendMessagePortIfNeeded(source);
  connectedWindows.set(source.id, source);
  _log('after', Array.from(connectedWindows));

  checkWindowClientForDeferredShare(source);
};
connectServerClient = (source, from) => onWindowConnected(source, from);

export const serviceMessagePort = new ServiceMessagePort<false>();

serviceMessagePort.addMultipleEventsListeners({
  environment: (environment) => {
    setEnvironment(environment);
  },

  getLogs: () => getLogEntries(),

  setLogBufferEnabled: (enabled) => setLogBufferEnabled(enabled),

  notificationsClear: closeAllNotifications,

  toggleStorages: ({enabled, clearWrite}) => {
    CacheStorageController.toggleStorage(enabled, clearWrite);
  },

  pushPing: (payload, source) => {
    onPing(payload, source);
  },

  hello: (payload, source) => {
    const client = source as any as WindowClient;
    if(payload?.serverId !== getActiveServerId() || connectedServerIds.get(client.id) !== payload.serverId) return;
    onWindowConnected(client, 'hello');
  },

  shownNotification: onShownNotification,
  leaveRtmpCall: onRtmpLeftCall,

  toggleStreamInUse,

  toggleCacheStorage: (enabled) => {
    CacheStorageController.temporarilyToggle(enabled);
  },

  resetEncryptableCacheStorages: () => {
    CacheStorageController.resetOpenEncryptableCacheStorages();
  },

  toggleUsingPasscode: (payload) => {
    DeferredIsUsingPasscode.resolveDeferred(payload.isUsingPasscode);

    // Make sure the promise is not resloved to null in case the encryption key is not provided and we have a passcode set
    if(payload.type === 'full') {
      EncryptionKeyStore.save(payload.encryptionKey);
    }
  },

  saveEncryptionKey: (payload) => {
    EncryptionKeyStore.save(payload);
  },

  fillPushObject,

  disableCacheStoragesByNames: (names) => {
    CacheStorageController.temporarilyToggleByNames(names, false);
  },

  enableCacheStoragesByNames: (names) => {
    CacheStorageController.temporarilyToggleByNames(names, true);
  },

  resetOpenCacheStoragesByNames: (names) => {
    CacheStorageController.resetOpenStoragesByNames(names);
  }
});

const {
  onDownloadFetch,
  onClosedWindows: onDownloadClosedWindows
} = handleDownload(serviceMessagePort);

(self as any).connectedWindows = connectedWindows;
listenMessagePort(serviceMessagePort, undefined, (source) => {
  log('something has disconnected', source);
  const isWindowClient = source instanceof WindowClient;
  if(!isWindowClient || !connectedWindows.has(source.id)) {
    log.warn('it is not a window');
    return;
  }

  connectedWindows.delete(source.id);
  connectedServerIds.delete(source.id);
  log('window disconnected, left', connectedWindows.size);
  if(!connectedWindows.size) {
    log.warn('no windows left');

    if(DeferredIsUsingPasscode.isUsingPasscodeUndeferred()) {
      resetPushAccounts();
    }

    EncryptionKeyStore.resetDeferred();
    DeferredIsUsingPasscode.resetDeferred();

    if(_mtprotoMessagePort) {
      serviceMessagePort.detachPort(_mtprotoMessagePort);
      _mtprotoMessagePort = undefined;
    }
    if(_cryptoMessagePort) {
      cryptoMessagePort.detachPort(_cryptoMessagePort);
      _cryptoMessagePort = undefined;
    }

    onDownloadClosedWindows();
  }
});
// #endif

const getClientServerId = (client: WindowClient) => new Promise<string>((resolve) => {
  const channel = new MessageChannel();
  let settled = false;
  const finish = (serverId?: string) => {
    if(settled) return;
    settled = true;
    clearTimeout(timer);
    channel.port1.close();
    resolve(serverId);
  };
  const timer = setTimeout(() => finish(), 5000);
  channel.port1.addEventListener('message', (event) => {
    const response = event.data;
    finish(response?.accepted === true && typeof response.serverId === 'string' ? response.serverId : undefined);
  }, {once: true});
  channel.port1.start();
  try {
    client.postMessage({type: 'teagram:server-handshake-request', serverId: getActiveServerId()}, [channel.port2]);
  } catch{
    finish();
  }
});

ctx.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data;
  const source = event.source as WindowClient | null;
  if(data?.type === 'teagram:server-handshake') {
    event.stopImmediatePropagation();
    const serverId = getActiveServerId();
    const accepted = !!source?.id && source.frameType !== 'none' && data.serverId === serverId;
    if(accepted) pendingServerIds.set(source.id, serverId);
    event.ports[0]?.postMessage({serverId, accepted});
    event.ports[0]?.close();
    return;
  }

  if(data?.type === 'teagram:server-handshake-ack') {
    event.stopImmediatePropagation();
    const serverId = getActiveServerId();
    const accepted = !!source?.id && source.frameType !== 'none' &&
      (pendingServerIds.get(source.id) === data.serverId || connectedServerIds.get(source.id) === data.serverId) &&
      data.serverId === serverId;
    if(accepted) {
      pendingServerIds.delete(source.id);
      connectedServerIds.set(source.id, serverId);
      connectServerClient(source, 'server handshake');
    }
    event.ports[0]?.postMessage({serverId, accepted});
    event.ports[0]?.close();
    return;
  }

  if(data?.type === 'teagram:close-server-databases') {
    if(data.serverId !== getActiveServerId()) event.stopImmediatePropagation();
    return;
  }

  if(!source?.id || connectedServerIds.get(source.id) !== getActiveServerId()) {
    event.stopImmediatePropagation();
  }
}, {capture: true});

// A restarted worker accepts only pages that prove they belong to its server.
async function startupCheck() {
  const windowClients = await getWindowClients();
  const length = windowClients.length;
  log(`got ${length} windows from the start`);
  await Promise.all(windowClients.map(async(windowClient) => {
    if(windowClient.frameType === 'none') {
      log.warn('skipping bugged Safari starting window', windowClient.id);
      return;
    }

    log('checking window', windowClient.id);
    try {
      const serverId = await getClientServerId(windowClient);
      if(serverId !== getActiveServerId()) return;

      connectedServerIds.set(windowClient.id, serverId);
      connectServerClient(windowClient, 'startup check');
    } catch(err) {
      log.error('failed to send hello to window', windowClient.id, err);
    }
  }));
}
void startupCheck();

watchCacheStoragesLifetime({
  onStorageError: async({storageName, error}) => {
    log(`Error clearing old cache in ${storageName}:`, error);
    log(`Clearing cache storage ${storageName}`);

    const [windowClient] = connectedWindows.values();
    if(!windowClient) return;

    await serviceMessagePort.invoke('clearCacheStoragesByNames', [storageName], undefined, windowClient);
  }
});

watchMtprotoOnDev({connectedWindows, onWindowConnected});

const onFetch = (event: FetchEvent): void => {
  if(!event.clientId || connectedServerIds.get(event.clientId) !== getActiveServerId()) return;

  // Web manifests must reach the network so installed PWA metadata can update.
  if(
    import.meta.env.PROD &&
    !IS_SAFARI &&
    event.request.url.indexOf(location.origin + '/') === 0 &&
    event.request.url.match(/\.(js|css|jpe?g|json|wasm|png|mp3|svg|tgs|ico|woff2?|ttf)(?:\?.*)?$/)
  ) {
    return event.respondWith(requestCache(event));
  }

  if(import.meta.env.DEV && event.request.url.match(/\.([jt]sx?|s?css)?($|\?)/)) {
    return;
  }

  try {
    // const [, url, scope, params] = /http[:s]+\/\/.*?(\/(.*?)(?:$|\/(.*)$))/.exec(event.request.url) || [];
    const [scope, _params] = event.request.url.split('/').slice(-2);
    const [params, search] = _params.split('?');

    // log.debug('[fetch]', event, event.request.url);

    switch(scope) {
      case 'stream': {
        onStreamFetch(event, params, search);
        break;
      }

      case 'd':
      case 'download': {
        onDownloadFetch(event, params);
        break;
      }

      case 'share': {
        onShareFetch(event, params);
        break;
      }

      case 'ping': {
        event.respondWith(new Response('pong'));
        break;
      }

      case 'rtmp': {
        onRtmpFetch(event, params, search);
        break;
      }

      case 'hls': {
        onHlsPlaylistFetch(event, params, search);
        break;
      }

      case 'hls_quality_file': {
        onHlsQualityFileFetch(event, params, search);
        break;
      }

      case 'hls_stream': {
        onHlsStreamFetch(event, params, search);
        break;
      }

      case 'backgrounds': {
        onBackgroundsFetch(event);
        break;
      }

      // default: {
      //   event.respondWith(fetch(event.request));
      //   break;
      // }
    }
  } catch(err) {
    log.error('fetch error', err);
    event.respondWith(get500ErrorResponse());
  }
};

const onChangeState = () => {
  ctx.onfetch = onFetch;
};

ctx.addEventListener('install', (event) => {
  log('installing');
  event.waitUntil(ctx.skipWaiting().then(() => log('skipped waiting'))); // Activate worker immediately
});

ctx.addEventListener('activate', (event) => {
  log('activating', ctx);
  event.waitUntil(ctx.caches.delete(CACHE_ASSETS_NAME).then(() => log('cleared assets cache')));
  event.waitUntil(ctx.clients.claim().then(() => log('claimed clients')));
});

// ctx.onerror = (error) => {
//   log.error('error:', error);
// };

// ctx.onunhandledrejection = (error) => {
//   log.error('onunhandledrejection:', error);
// };

ctx.onoffline = ctx.ononline = onChangeState;

onChangeState();
