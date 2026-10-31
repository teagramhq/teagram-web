import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {JSX} from 'solid-js';
import {render} from 'solid-js/web';
import InviteFriends from '@components/sidebarLeft/tabs/inviteFriends';

const mocks = vi.hoisted(() => ({
  tab: undefined as any,
  appConfig: {user_invites_enabled: true, registration_mode: 'invite'} as any,
  listUserInvites: vi.fn(),
  createUserInvite: vi.fn(),
  createPopup: vi.fn()
}));

vi.mock('@helpers/color', () => ({
  hexToRgb: vi.fn(),
  hslaToString: vi.fn(),
  mixColors: vi.fn(),
  rgbaToHsla: vi.fn()
}));

vi.mock('@helpers/date', () => ({formatDate: vi.fn(() => ({textContent: ''}))}));
vi.mock('@helpers/dom/customProperties', () => ({default: {getProperty: vi.fn()}}));
vi.mock('@helpers/clipboard', () => ({copyTextToClipboard: vi.fn()}));
vi.mock('@helpers/solid/createListenerSetter', () => ({default: vi.fn()}));
vi.mock('@components/wrappers/wrapDuration', () => ({wrapLeftDuration: vi.fn()}));
vi.mock('@components/call/callLogo', () => ({default: () => <span />}));
vi.mock('@components/confirmationPopup', () => ({default: vi.fn()}));
vi.mock('@components/toast', () => ({toastNew: vi.fn()}));
vi.mock('@components/sidebarLeft/tabs/inviteLink', () => ({
  InviteLink: class InviteLink {
    container = document.createElement('div');
    copyLink = (): void => undefined;
    constructor(_options: any) {}
  }
}));
vi.mock('@components/popups/indexTsx', () => {
  const PopupElement: any = (props: {children?: JSX.Element}) => <div>{props.children}</div>;
  PopupElement.POPUPS = [];
  PopupElement.Header = (props: {children?: JSX.Element}) => <div>{props.children}</div>;
  PopupElement.Body = (props: {children?: JSX.Element}) => <div>{props.children}</div>;
  PopupElement.CloseButton = () => <button />;
  return {
    default: PopupElement,
    createPopup: mocks.createPopup,
    usePopupContext: vi.fn()
  };
});
vi.mock('@components/mediaHeader', () => {
  const MediaHeader: any = (props: {children?: JSX.Element}) => <div>{props.children}</div>;
  MediaHeader.Title = (props: {children?: JSX.Element}) => <div>{props.children}</div>;
  MediaHeader.Subtitle = (props: {children?: JSX.Element}) => <div>{props.children}</div>;
  return {default: MediaHeader};
});
vi.mock('@components/buttonTsx', () => ({
  default: (props: {text: string, disabled?: boolean, onClick?: () => void, ref?: (element: HTMLElement) => void}) => {
    const element = (
      <button disabled={props.disabled} onClick={props.onClick}>{props.text}</button>
    ) as HTMLButtonElement;
    props.ref?.(element);
    return element;
  }
}));
vi.mock('@components/section', () => ({
  default: (props: {children?: JSX.Element, caption?: JSX.Element}) => <section>{props.caption}{props.children}</section>
}));
vi.mock('@components/putPreloader', () => ({PreloaderTsx: () => <span />}));
vi.mock('@components/usernameRow', () => ({default: () => <div />}));
vi.mock('@lib/langPack', () => ({i18n: vi.fn((key: string) => document.createTextNode(key))}));
vi.mock('@lib/rootScope', () => ({
  default: {
    managers: {
      appAccountManager: {
        listUserInvites: mocks.listUserInvites,
        createUserInvite: mocks.createUserInvite
      }
    }
  }
}));
vi.mock('@helpers/tsNow', () => ({default: () => 1_000}));
vi.mock('@stores/appState', () => ({useAppConfig: () => mocks.appConfig}));
vi.mock('@components/solidJsTabs/superTabProvider', () => ({useSuperTab: () => [mocks.tab]}));
vi.mock('@config/serverContext', () => ({getActiveServerHost: () => 'web.teagram.io'}));

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => resolve = resolvePromise);
  return {promise, resolve: (value: T) => resolve(value)};
}

let dispose: () => void;

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  mocks.tab = {close: vi.fn(() => dispose())};
  dispose = render(() => <InviteFriends />, container);
  return container;
}

beforeEach(() => {
  mocks.appConfig = {user_invites_enabled: true, registration_mode: 'invite'};
  mocks.listUserInvites.mockResolvedValue({invites: [], quota: 1, weekly_count: 0});
  mocks.createUserInvite.mockReset();
  mocks.createPopup.mockReset();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('Invite friends tab', () => {
  it('shows the created link when the tab closes during invite creation', async() => {
    const createRequest = deferred<{id: number, link: string, expires_at: number}>();
    mocks.createUserInvite.mockReturnValue(createRequest.promise);
    const container = mount();

    await vi.waitFor(() => expect(container.querySelector('button').disabled).toBe(false));
    container.querySelector('button').click();
    expect(mocks.createUserInvite).toHaveBeenCalledOnce();

    mocks.tab.close();
    createRequest.resolve({id: 7, link: 'https://web.teagram.io/+invite#secret', expires_at: 2_000});

    await vi.waitFor(() => expect(mocks.createPopup).toHaveBeenCalledOnce());
    expect(mocks.listUserInvites).toHaveBeenCalledOnce();
  });
});
