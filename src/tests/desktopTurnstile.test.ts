import {afterEach, describe, expect, it, vi} from 'vitest';

import type {TurnstileRenderOptions} from '@lib/turnstile';
import {mountDesktopTurnstilePage} from '@/pages/desktopTurnstile';

type TurnstileCallbacks = TurnstileRenderOptions;

type FakeTurnstile = {
  render: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function preparePage(fragment: string) {
  window.history.replaceState(null, '', '/#' + fragment);

  const root = document.createElement('main');
  root.id = 'turnstile-page';

  const message = document.createElement('p');
  message.id = 'turnstile-message';
  message.setAttribute('role', 'status');
  root.append(message);

  const widget = document.createElement('div');
  widget.id = 'turnstile-widget';
  root.append(widget);
  document.body.replaceChildren(root);

  return {message, widget};
}

function installBridge(postEvent = vi.fn()) {
  Object.defineProperty(window, 'TelegramWebviewProxy', {
    configurable: true,
    value: {postEvent}
  });

  return postEvent;
}

function installTurnstile(): {api: FakeTurnstile, getCallbacks: () => TurnstileCallbacks | undefined} {
  let callbacks: TurnstileCallbacks | undefined;
  const api: FakeTurnstile = {
    render: vi.fn((_container: HTMLElement, options: TurnstileCallbacks) => {
      callbacks = options;
      return 'widget-1';
    }),
    reset: vi.fn(),
    remove: vi.fn()
  };

  Object.defineProperty(window, 'turnstile', {configurable: true, value: api});
  return {api, getCallbacks: () => callbacks};
}

afterEach(() => {
  document.body.replaceChildren();
  document.querySelectorAll('script[src^="https://challenges.cloudflare.com/"]').forEach((script) => script.remove());
  window.history.replaceState(null, '', '/');
  delete (window as any).TelegramWebviewProxy;
  delete (window as any).turnstile;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('desktop Turnstile entry', () => {
  it('rejects markup in the sitekey without rendering or reflecting it', () => {
    const {message} = preparePage('sitekey=%3Csvg%20onload%3Dalert(1)%3E&action=signin');
    const postEvent = installBridge();

    mountDesktopTurnstilePage();

    expect(message.textContent).toBe('The security check failed. Try again.');
    expect(document.querySelector('svg')).toBeNull();
    expect(document.querySelector('script[src^="https://challenges.cloudflare.com/"]')).toBeNull();
    expect(postEvent).toHaveBeenCalledOnce();
    expect(postEvent).toHaveBeenCalledWith('turnstile_error', '{"code":"bad_params"}');
  });

  it('renders a 256-character sitekey', () => {
    const sitekey = 'a'.repeat(256);
    const postEvent = installBridge();
    const {api} = installTurnstile();
    preparePage('sitekey=' + sitekey + '&action=signin');

    mountDesktopTurnstilePage();

    expect(api.render).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({sitekey}));
    expect(postEvent).not.toHaveBeenCalled();
  });

  it('rejects a 257-character sitekey', () => {
    const {message} = preparePage('sitekey=' + 'a'.repeat(257) + '&action=signin');
    const postEvent = installBridge();
    const {api} = installTurnstile();

    mountDesktopTurnstilePage();

    expect(message.textContent).toBe('The security check failed. Try again.');
    expect(api.render).not.toHaveBeenCalled();
    expect(postEvent).toHaveBeenCalledOnce();
    expect(postEvent).toHaveBeenCalledWith('turnstile_error', '{"code":"bad_params"}');
  });

  it('does not load the widget or use another message channel without the bridge', () => {
    const {message} = preparePage('sitekey=valid_key-1&action=signin');
    const {api} = installTurnstile();
    const postMessage = vi.spyOn(window, 'postMessage');

    mountDesktopTurnstilePage();

    expect(message.textContent).toBe('Open this security check from Teagram Desktop.');
    expect(api.render).not.toHaveBeenCalled();
    expect(document.querySelector('script[src^="https://challenges.cloudflare.com/"]')).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('loads Turnstile only for the bridge and posts one token with the parsed action', async() => {
    const {message, widget} = preparePage('sitekey=valid_key-1&action=signup');
    const postEvent = installBridge();

    mountDesktopTurnstilePage();

    const script = document.querySelector<HTMLScriptElement>('script[src^="https://challenges.cloudflare.com/"]');
    expect(script?.getAttribute('src')).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    expect(message.textContent).toBe('Loading security check…');

    const {api, getCallbacks} = installTurnstile();
    script?.onload?.(new Event('load'));
    await Promise.resolve();

    const callbacks = getCallbacks();
    expect(api.render).toHaveBeenCalledOnce();
    expect(api.render).toHaveBeenCalledWith(widget, expect.objectContaining({
      sitekey: 'valid_key-1',
      action: 'signup',
      'response-field': false
    }));
    expect(message.textContent).toBe('');

    callbacks?.callback('secret-turnstile-token');
    callbacks?.callback('secret-turnstile-token');

    expect(postEvent).toHaveBeenCalledOnce();
    expect(postEvent).toHaveBeenCalledWith('turnstile_token', '{"token":"secret-turnstile-token","action":"signup"}');
    expect(document.body.textContent).not.toContain('secret-turnstile-token');
    expect(window.location.hash).not.toContain('secret-turnstile-token');
    expect(widget.childNodes).toHaveLength(0);
  });

  it('reports when the Turnstile script fails to load', async() => {
    const {message} = preparePage('sitekey=valid_key-1&action=signin');
    const postEvent = installBridge();

    mountDesktopTurnstilePage();
    const script = document.querySelector<HTMLScriptElement>('script[src^="https://challenges.cloudflare.com/"]');
    script?.onerror?.(new Event('error'));
    await Promise.resolve();

    expect(message.textContent).toBe('The security check couldn’t load. Try again.');
    expect(postEvent).toHaveBeenCalledOnce();
    expect(postEvent).toHaveBeenCalledWith('turnstile_error', '{"code":"widget_error"}');
  });

  it('reports when the Turnstile script takes more than 15 seconds to load', async() => {
    vi.useFakeTimers();
    const {message} = preparePage('sitekey=valid_key-1&action=signin');
    const postEvent = installBridge();

    mountDesktopTurnstilePage();
    await vi.advanceTimersByTimeAsync(15000);
    await Promise.resolve();

    expect(message.textContent).toBe('The security check couldn’t load. Try again.');
    expect(postEvent).toHaveBeenCalledOnce();
    expect(postEvent).toHaveBeenCalledWith('turnstile_error', '{"code":"widget_error"}');
  });

  it('forwards the Cloudflare widget error code and resets the widget', () => {
    const {message} = preparePage('sitekey=valid_key-1&action=signin');
    const postEvent = installBridge();
    const {api, getCallbacks} = installTurnstile();

    mountDesktopTurnstilePage();
    const errorCallback = getCallbacks()?.['error-callback'];
    errorCallback?.(110200);

    expect(message.textContent).toBe('The security check failed. Try again.');
    expect(postEvent).toHaveBeenCalledWith('turnstile_error', '{"code":"widget_error","cloudflare_code":"110200"}');
    expect(api.reset).toHaveBeenCalledWith('widget-1');
    expect(JSON.stringify(postEvent.mock.calls)).not.toContain('secret-turnstile-token');
  });

  it('omits non-code Cloudflare error callback data', () => {
    preparePage('sitekey=valid_key-1&action=signin');
    const postEvent = installBridge();
    const {getCallbacks} = installTurnstile();

    mountDesktopTurnstilePage();
    const errorCallback = getCallbacks()?.['error-callback'];
    errorCallback?.('600010\nsecret-turnstile-token');

    expect(postEvent).toHaveBeenCalledWith('turnstile_error', '{"code":"widget_error"}');
  });

  it('posts a fixed expiry code and resets the widget', () => {
    preparePage('sitekey=valid_key-1&action=signin');
    const postEvent = installBridge();
    const {api, getCallbacks} = installTurnstile();

    mountDesktopTurnstilePage();
    getCallbacks()?.['expired-callback']();

    expect(postEvent).toHaveBeenCalledWith('turnstile_error', '{"code":"expired"}');
    expect(api.reset).toHaveBeenCalledWith('widget-1');
  });

  it('rejects actions other than signin and signup', () => {
    const {message} = preparePage('sitekey=valid_key-1&action=signin%20%26%20signup');
    const postEvent = installBridge();

    mountDesktopTurnstilePage();

    expect(message.textContent).toBe('The security check failed. Try again.');
    expect(document.querySelector('script[src^="https://challenges.cloudflare.com/"]')).toBeNull();
    expect(postEvent).toHaveBeenCalledWith('turnstile_error', '{"code":"bad_params"}');
  });
});
