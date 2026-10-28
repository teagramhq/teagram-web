import {SHARE_TOKEN_PARAM} from '@config/shareToken';
import {log, serviceMessagePort} from '@lib/serviceWorker/index.service';

// Keyed by client id once claimed, and by a one-time token until then: the landing
// page may reload before it proves its server, and a reload gets a new client id.
const deferred: {[id: string]: ShareData[]} = {};
const unclaimed: {[token: string]: ShareData[]} = Object.create(null);

function parseFormData(formData: FormData): ShareData {
  return {
    files: formData.getAll('files') as File[],
    title: formData.get('title') as string,
    text: formData.get('text') as string,
    url: formData.get('url') as string
  };
}

async function processShareEvent(formData: FormData, token: string) {
  try {
    log('share data', formData);
    const data = parseFormData(formData);
    (unclaimed[token] ??= []).push(data);
  } catch(err) {
    log.warn('something wrong with the data', err);
  }
};

export function claimDeferredShare(clientId: string, token: unknown) {
  if(typeof token !== 'string' || !unclaimed[token]) {
    return;
  }

  (deferred[clientId] ??= []).push(...unclaimed[token]);
  delete unclaimed[token];
}

export function checkWindowClientForDeferredShare(windowClient: WindowClient) {
  const arr = deferred[windowClient.id];
  if(!arr) {
    return;
  }

  delete deferred[windowClient.id];

  log('releasing share events to client:', windowClient.id, 'length:', arr.length);
  arr.forEach((data) => {
    serviceMessagePort.invokeVoid('share', data, windowClient);
  });
}

export default function onShareFetch(event: FetchEvent, params: string) {
  const token = crypto.randomUUID();
  const promise = event.request.formData()
  .then((formData) => {
    processShareEvent(formData, token)
    const url = new URL('../', event.request.url);
    url.searchParams.set(SHARE_TOKEN_PARAM, token);
    return Response.redirect(url.href);
  });

  event.respondWith(promise);
}
