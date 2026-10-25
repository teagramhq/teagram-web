import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';

const mocks = vi.hoisted(() => ({
  activeHost: 'demo.teagram.io',
  autoGuest: true,
  isCurrentAccountGuest: vi.fn(),
  markAutoGuestAttempted: vi.fn()
}));

vi.mock('@components/sidebarLeft/pendingSuggestionItem', () => {
  const Suggestion = (props: any) => <div class={props.class}>{props.children}</div>;
  Suggestion.Title = (props: any) => <h2>{props.children}</h2>;
  Suggestion.Subtitle = (props: any) => <p>{props.children}</p>;
  return {PendingSuggestion: Suggestion};
});
vi.mock('@config/serverSelection', () => ({DEMO_SERVER_HOST: 'demo.teagram.io'}));
vi.mock('@config/serverContext', () => ({
  getActiveServerHost: () => mocks.activeHost,
  isAutoGuestEnabled: () => mocks.autoGuest
}));
vi.mock('@lib/langPack', () => ({
  i18n: (key: string) => key === 'Teagram.Demo.Banner.Title' ? 'Demo server: you\'re a guest.' :
    'Everything is wiped every week. Use your own server at'
}));
vi.mock('@lib/guestAccountLifecycle', () => ({isCurrentAccountGuest: mocks.isCurrentAccountGuest}));
vi.mock('@lib/autoGuest', () => ({markAutoGuestAttempted: mocks.markAutoGuestAttempted}));

import DemoGuestBanner from '@components/sidebarLeft/demoGuestBanner';

describe('demo guest banner', () => {
  let dispose: VoidFunction;

  beforeEach(() => {
    mocks.activeHost = 'demo.teagram.io';
    mocks.autoGuest = true;
    mocks.isCurrentAccountGuest.mockReset().mockResolvedValue(true);
    mocks.markAutoGuestAttempted.mockReset();
    document.body.replaceChildren();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.replaceChildren();
  });

  it('shows the exact demo notice only for a verified guest account', async() => {
    dispose = render(() => <DemoGuestBanner/>, document.body);

    await vi.waitFor(() => expect(document.body.textContent).toContain('Demo server: you\'re a guest.'));
    expect(document.body.textContent).toContain('Everything is wiped every week. Use your own server at web.teagram.io');
    expect(document.querySelector('a')).toMatchObject({
      href: 'https://web.teagram.io/',
      target: '_blank'
    });
    expect(mocks.markAutoGuestAttempted).toHaveBeenCalledOnce();
  });

  it.each([
    ['auto guest mode is disabled', false, 'demo.teagram.io', true],
    ['the active server is not the demo host', true, 'custom.example.test', true],
    ['the account has no saved guest credentials', true, 'demo.teagram.io', false]
  ])('keeps the notice hidden when %s', async(_description, autoGuest, host, isGuest) => {
    mocks.autoGuest = autoGuest;
    mocks.activeHost = host;
    mocks.isCurrentAccountGuest.mockResolvedValue(isGuest);

    dispose = render(() => <DemoGuestBanner/>, document.body);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.body.textContent).not.toContain('Demo server: you\'re a guest.');
    expect(mocks.markAutoGuestAttempted).not.toHaveBeenCalled();
  });
});
