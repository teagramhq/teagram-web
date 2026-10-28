import {beforeEach, describe, expect, it, vi} from 'vitest';

const {invokeVoid} = vi.hoisted(() => ({invokeVoid: vi.fn()}));

vi.mock('@lib/serviceWorker/index.service', () => {
  const log = Object.assign(vi.fn(), {warn: vi.fn()});
  return {log, serviceMessagePort: {invokeVoid}};
});

import {SHARE_TOKEN_PARAM} from '@config/shareToken';
import onShareFetch, {checkWindowClientForDeferredShare, claimDeferredShare} from '@lib/serviceWorker/share';

function shareFetch(fields: Record<string, string>) {
  const formData = new FormData();
  for(const key in fields) formData.append(key, fields[key]);
  let response: Promise<Response>;
  const event = {
    request: {url: 'https://web.teagram.io/share/', formData: () => Promise.resolve(formData)},
    resultingClientId: 'landing-client',
    respondWith: (promise: Promise<Response>) => response = promise
  } as unknown as FetchEvent;
  onShareFetch(event, '');
  return response!;
}

async function shareToken(response: Response) {
  return new URL(response.headers.get('location')!).searchParams.get(SHARE_TOKEN_PARAM);
}

const windowClient = (id: string) => ({id} as WindowClient);

describe('service worker share target', () => {
  beforeEach(() => {
    invokeVoid.mockClear();
  });

  it('releases a share to the window that claims its token after a reload', async() => {
    const token = await shareToken(await shareFetch({title: 'Title', text: 'Text', url: 'https://example.test/'}));
    expect(token).toMatch(/^[0-9a-f-]{36}$/);

    const reloaded = windowClient('reloaded-client');
    claimDeferredShare(reloaded.id, token);
    checkWindowClientForDeferredShare(reloaded);

    expect(invokeVoid).toHaveBeenCalledOnce();
    expect(invokeVoid).toHaveBeenCalledWith('share', expect.objectContaining({title: 'Title', text: 'Text', url: 'https://example.test/'}), reloaded);
  });

  it('does not release a share to windows without its token', async() => {
    const token = await shareToken(await shareFetch({title: 'Title'}));
    const other = windowClient('other-client');
    checkWindowClientForDeferredShare(windowClient('landing-client'));
    claimDeferredShare(other.id, 'not-the-token');
    checkWindowClientForDeferredShare(other);
    expect(invokeVoid).not.toHaveBeenCalled();

    const owner = windowClient('owner-client');
    claimDeferredShare(owner.id, token);
    claimDeferredShare(other.id, token);
    checkWindowClientForDeferredShare(other);
    checkWindowClientForDeferredShare(owner);
    expect(invokeVoid).toHaveBeenCalledOnce();
    expect(invokeVoid.mock.calls[0][2]).toBe(owner);
  });
});
