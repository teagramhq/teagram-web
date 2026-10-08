import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';
import '@helpers/peerIdPolyfill';
import ListenerSetter from '@helpers/listenerSetter';
import {simulateClickEvent} from '@helpers/dom/clickEvent';

const mocks = vi.hoisted(() => ({
  tab: undefined as any,
  editPeer: undefined as any,
  fields: {} as Record<string, any>,
  usernameField: undefined as any,
  toastNew: vi.fn(),
  personalChannelPicker: undefined as any,
  globalUpdateUsername: vi.fn()
}));

vi.hoisted(() => {
  class TestIntersectionObserver {
    constructor(_callback: IntersectionObserverCallback) {}
    public observe() {}
    public unobserve() {}
    public disconnect() {}
  }
  Object.assign(globalThis, {IntersectionObserver: TestIntersectionObserver});
  Object.assign(globalThis.window, {IntersectionObserver: TestIntersectionObserver});
});

vi.mock('@components/solidJsTabs/superTabProvider', () => ({
  useSuperTab: () => [mocks.tab]
}));

vi.mock('@components/solidJsTabs/promiseCollector', () => ({
  usePromiseCollector: () => ({collect: vi.fn()})
}));

vi.mock('@lib/solidjs/hotReloadGuard', () => ({
  useHotReloadGuard: () => ({appSidebarLeft: {}})
}));

vi.mock('@components/solidJsTabs/tabs', () => ({
  AppChatAutomationTab: class AppChatAutomationTab {},
  AppEditProfileTab: class AppEditProfileTab {}
}));

vi.mock('@components/inputFieldTsx', () => {
  class TestInputField {
    public container = document.createElement('div');
    public input = document.createElement('input');
    public originalValue = '';

    constructor(public options: any) {
      this.input.name = options.name;
      this.container.append(this.input);
      mocks.fields[options.name] = this;
    }

    public get value() {
      return this.input.value;
    }

    public setOriginalValue(value = '') {
      this.originalValue = value;
      this.input.value = value;
    }

    public isValid() {
      return !this.input.classList.contains('error');
    }

    public isChanged() {
      return this.value !== this.originalValue;
    }

    public isValidToChange() {
      return this.isValid() && this.isChanged();
    }
  }

  return {
    InputFieldTsx: (props: any) => {
      const field = new TestInputField(props);
      props.instanceRef?.(field);
      return field.container;
    }
  };
});

vi.mock('@components/editPeer', () => ({
  default: class EditPeer {
    public nextBtn = document.createElement('button');
    public uploadAvatar: any;
    public avatarEdit = {container: document.createElement('div')};
    public avatarElem = {node: document.createElement('div')};
    public isChanged = vi.fn(() => false);
    public handleChange = vi.fn();
    public originalHandleChange = this.handleChange;

    constructor() {
      mocks.editPeer = this;
    }
  }
}));

vi.mock('@components/section', () => ({
  default: (props: any) => <section>{props.children}</section>
}));

vi.mock('@components/rowTsx', () => {
  const Basic = (props: any) => (
    <div class="row" onClick={props.clickable}>{props.children}{props.titleRight}</div>
  );
  return {
    default: Object.assign(Basic, {
      Icon: () => <span />,
      Title: Basic
    })
  };
});

vi.mock('@components/usernamesSection', () => ({
  default: () => <div />
}));

vi.mock('@lib/customEmoji/renderer', () => ({
  CustomEmojiRendererElement: class CustomEmojiRendererElement {
    public static create() {
      return {add: vi.fn(), forceRender: vi.fn()};
    }
  }
}));

vi.mock('@components/usernameInputField', async(importOriginal) => {
  const original = await importOriginal<typeof import('@components/usernameInputField')>();
  const InputField = original.UsernameInputField;
  return {
    ...original,
    UsernameInputField: class TestUsernameInputField extends InputField {
      constructor(...args: ConstructorParameters<typeof InputField>) {
        super(...args);
        mocks.usernameField = this;
      }
    }
  };
});

vi.mock('@components/popups/birthday', () => ({
  default: vi.fn(),
  saveMyBirthday: vi.fn()
}));

vi.mock('@components/popups/pickUser', () => ({
  default: (options: any) => {
    mocks.personalChannelPicker = options;
  }
}));

vi.mock('@components/popups/indexTsx', () => ({
  default: {FooterButton: () => <button />}
}));

vi.mock('@components/wrappers/peerTitle', () => ({
  default: vi.fn().mockResolvedValue('Channel')
}));

vi.mock('@components/toast', () => ({
  toastNew: mocks.toastNew
}));

vi.mock('@components/sidebarLeft/tabs/purchaseUsernameCaption', () => ({
  purchaseUsernameCaption: () => ({setUsername: vi.fn(), element: document.createElement('span')})
}));

vi.mock('@stores/avatarUpload', () => ({
  trackAvatarUpload: vi.fn()
}));

vi.mock('@lib/langPack', () => ({
  i18n: (key: string) => key,
  _i18n: (element: HTMLElement, key: string) => {
    element.textContent = key;
    return element;
  }
}));

vi.mock('@lib/rootScope', () => ({
  default: {
    myId: 100,
    managers: {appUsersManager: {updateUsername: mocks.globalUpdateUsername}},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }
}));

import EditProfileTab from '@components/sidebarLeft/tabs/editProfile';

type Deferred<T> = {
  promise: Promise<T>,
  resolve: (value: T) => void,
  reject: (error: unknown) => void
};

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>['resolve'];
  let reject: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve: resolve!, reject: reject!};
}

let dispose: (() => void) | undefined;

function makeTab(options: {
  updateProfile?: () => Promise<unknown>,
  updateUsername?: (username: string) => Promise<unknown>,
  checkUsername?: (username: string) => Promise<boolean>,
  updatePersonalChannel?: (channelId?: number) => Promise<unknown>,
  uploadProfilePhoto?: (photo: any) => Promise<unknown>,
  getAdminedPersonalChannels?: () => Promise<number[]>,
  personalChannelId?: number
} = {}) {
  const content = document.createElement('div');
  const appUsersManager = {
    updateUsername: vi.fn(options.updateUsername || (() => Promise.resolve(undefined))),
    checkUsername: vi.fn(options.checkUsername || (() => Promise.resolve(true)))
  };
  const appProfileManager = {
    updateProfile: vi.fn(options.updateProfile || (() => Promise.resolve(undefined))),
    updatePersonalChannel: vi.fn(options.updatePersonalChannel || (() => Promise.resolve(undefined))),
    uploadProfilePhoto: vi.fn(options.uploadProfilePhoto || (() => Promise.resolve(undefined))),
    getAdminedPersonalChannels: vi.fn(options.getAdminedPersonalChannels || (() => Promise.resolve([20])))
  };

  mocks.tab = {
    payload: {
      bioMaxLength: 70,
      user: {
        _: 'user',
        pFlags: {},
        id: 100,
        access_hash: 'hash',
        first_name: 'Ada',
        last_name: 'Lovelace',
        username: 'operator',
        status: {_: 'userStatusEmpty'}
      },
      userFull: {
        _: 'userFull',
        about: 'mathematician',
        personal_channel_id: options.personalChannelId,
        personal_channel_message: undefined,
        birthday: undefined
      },
      connectedBot: undefined
    },
    container: content,
    content,
    listenerSetter: new ListenerSetter(),
    middlewareHelper: {get: vi.fn()},
    managers: {
      appUsersManager,
      appProfileManager,
      appBusinessManager: {getConnectedBot: vi.fn().mockResolvedValue(undefined)}
    },
    close: vi.fn()
  };
  return {tab: mocks.tab, content, appUsersManager, appProfileManager};
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await Promise.resolve();
}

async function mountEditor(options: Parameters<typeof makeTab>[0] = {}) {
  const {tab, content, appUsersManager, appProfileManager} = makeTab(options);
  document.body.append(content);
  dispose = render(() => <EditProfileTab />, content);
  await flushPromises();
  return {
    tab,
    content,
    button: content.querySelector<HTMLButtonElement>('button'),
    appUsersManager,
    appProfileManager
  };
}

function enter(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText'}));
}

async function selectPersonalChannel(content: HTMLElement, id = 20) {
  const channelRow = [...content.querySelectorAll<HTMLElement>('.row')]
    .find((element) => element.textContent?.includes('EditProfile.PersonalChannel.Label'));
  channelRow?.click();
  await flushPromises();
  mocks.personalChannelPicker.onSelect([{peerId: {toChatId: () => id}}]);
  await flushPromises();
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.fields = {};
  mocks.usernameField = undefined;
  mocks.personalChannelPicker = undefined;
  mocks.editPeer = undefined;
  mocks.globalUpdateUsername.mockReset();
  mocks.toastNew.mockReset();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  mocks.tab?.listenerSetter.removeAll();
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('profile save outcomes', () => {
  it('keeps a refused cleared username visible and preserves the persisted original', async() => {
    const {tab, button} = await mountEditor({
      updateUsername: () => Promise.reject({type: 'USERNAME_IMMUTABLE'})
    });
    const firstName = mocks.fields['first-name'];
    const lastName = mocks.fields['last-name'];
    const bio = mocks.fields.bio;
    const username = mocks.usernameField;
    enter(firstName.input, 'Grace');
    enter(lastName.input, 'Hopper');
    enter(bio.input, 'compiler pioneer');
    enter(username.input, '');

    simulateClickEvent(button);
    await flushPromises();

    expect(tab.managers.appUsersManager.updateUsername).toHaveBeenCalledWith('');
    expect(tab.close).not.toHaveBeenCalled();
    expect(username.input.classList.contains('error')).toBe(true);
    expect(username.label.textContent).toBe('EditProfile.Username.Immutable');
    expect(username.originalValue).toBe('operator');
    expect(firstName.originalValue).toBe('Grace');
    expect(firstName.isChanged()).toBe(false);
    expect(lastName.originalValue).toBe('Hopper');
    expect(lastName.isChanged()).toBe(false);
    expect(bio.originalValue).toBe('compiler pioneer');
    expect(bio.isChanged()).toBe(false);
    expect(button.disabled).toBe(false);
  });

  it('does not let a late availability result erase a refused save error', async() => {
    const usernameWrite = deferred<void>();
    const availability = deferred<boolean>();
    const {tab, button, appUsersManager} = await mountEditor({
      updateUsername: () => usernameWrite.promise,
      checkUsername: () => availability.promise
    });
    const username = mocks.usernameField;
    enter(username.input, 'newhandle');
    simulateClickEvent(button);
    await flushPromises();
    expect(appUsersManager.updateUsername).toHaveBeenCalledWith('newhandle');
    await vi.advanceTimersByTimeAsync(150);
    expect(appUsersManager.checkUsername).toHaveBeenCalledWith('newhandle');

    usernameWrite.reject({type: 'USERNAME_IMMUTABLE'});
    await flushPromises();
    expect(tab.close).not.toHaveBeenCalled();
    expect(username.label.textContent).toBe('EditProfile.Username.Immutable');

    availability.resolve(true);
    await flushPromises();

    expect(username.input.classList.contains('error')).toBe(true);
    expect(username.input.classList.contains('valid')).toBe(false);
    expect(username.label.textContent).toBe('EditProfile.Username.Immutable');

    enter(username.input, 'anotherhandle');
    expect(username.input.classList.contains('error')).toBe(false);
    expect(username.hasSaveError()).toBe(false);
  });

  it.each([
    ['USERNAME_OCCUPIED', 'EditProfile.Username.Taken'],
    ['USERNAME_INVALID', 'EditProfile.Username.Invalid'],
    ['USERNAME_NOT_MODIFIED', 'Error.AnError'],
    ['FLOOD_WAIT_5', 'Error.AnError'],
    ['<img src=x onerror=alert(1)>', 'Error.AnError']
  ])('maps username refusal %s to a fixed localized message', async(type, langKey) => {
    const {button} = await mountEditor({
      updateUsername: () => Promise.reject({type, description: 'private server detail'})
    });
    const username = mocks.usernameField;
    enter(username.input, 'newhandle');
    simulateClickEvent(button);
    await flushPromises();

    expect(username.label.textContent).toBe(langKey);
    expect(document.body.innerHTML).not.toContain(type);
    expect(document.body.innerHTML).not.toContain('private server detail');
    expect(mocks.toastNew).not.toHaveBeenCalled();
  });

  it('waits for every submitted write before closing or enabling the button', async() => {
    const usernameWrite = deferred<void>();
    const {tab, button} = await mountEditor({updateUsername: () => usernameWrite.promise});
    enter(mocks.usernameField.input, 'newhandle');

    simulateClickEvent(button);
    await flushPromises();

    expect(tab.close).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);

    usernameWrite.resolve(undefined);
    await flushPromises();

    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(mocks.usernameField.originalValue).toBe('newhandle');
  });

  it('keeps edits made during a pending save available after the submitted writes settle', async() => {
    const usernameWrite = deferred<void>();
    const {tab, button} = await mountEditor({updateUsername: () => usernameWrite.promise});
    enter(mocks.usernameField.input, 'newhandle');
    simulateClickEvent(button);
    await flushPromises();

    enter(mocks.fields['first-name'].input, 'Grace');
    expect(button.disabled).toBe(true);

    usernameWrite.resolve(undefined);
    await flushPromises();

    expect(tab.close).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(mocks.fields['first-name'].value).toBe('Grace');
    expect(mocks.fields['first-name'].originalValue).toBe('Ada');
    expect(mocks.usernameField.originalValue).toBe('newhandle');
  });

  it('closes once after a successful name-only save', async() => {
    const {tab, button} = await mountEditor();
    enter(mocks.fields['first-name'].input, 'Grace');

    simulateClickEvent(button);
    await flushPromises();

    expect(tab.close).toHaveBeenCalledTimes(1);
  });

  it('closes once after a successful photo-only save', async() => {
    const {tab, button, appProfileManager} = await mountEditor();
    const file = {_: 'inputFile', id: 'photo'};
    mocks.editPeer.uploadAvatar = {
      file: () => Promise.resolve(file),
      videoStartTs: 0
    };

    simulateClickEvent(button);
    await flushPromises();

    expect(appProfileManager.uploadProfilePhoto).toHaveBeenCalledWith({
      file,
      video: undefined,
      videoStartTs: 0
    });
    expect(tab.close).toHaveBeenCalledTimes(1);
  });

  it('keeps profile fields changed and reports profile failure when username succeeds', async() => {
    const {tab, button} = await mountEditor({
      updateProfile: () => Promise.reject(new Error('private profile detail'))
    });
    const firstName = mocks.fields['first-name'];
    const lastName = mocks.fields['last-name'];
    const bio = mocks.fields.bio;
    const username = mocks.usernameField;
    enter(firstName.input, 'Grace');
    enter(lastName.input, 'Hopper');
    enter(bio.input, 'compiler pioneer');
    enter(username.input, 'newhandle');

    simulateClickEvent(button);
    await flushPromises();

    expect(tab.close).not.toHaveBeenCalled();
    expect(firstName.value).toBe('Grace');
    expect(firstName.originalValue).toBe('Ada');
    expect(firstName.isChanged()).toBe(true);
    expect(lastName.value).toBe('Hopper');
    expect(lastName.originalValue).toBe('Lovelace');
    expect(lastName.isChanged()).toBe(true);
    expect(bio.value).toBe('compiler pioneer');
    expect(bio.originalValue).toBe('mathematician');
    expect(bio.isChanged()).toBe(true);
    expect(username.originalValue).toBe('newhandle');
    expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Error.AnError'});
  });

  it('records personal channel success while keeping a refused username pending', async() => {
    const {tab, content, button, appProfileManager} = await mountEditor({
      updateUsername: () => Promise.reject({type: 'USERNAME_IMMUTABLE'}),
      updatePersonalChannel: () => Promise.resolve(undefined)
    });
    await selectPersonalChannel(content);
    enter(mocks.usernameField.input, 'newhandle');

    simulateClickEvent(button);
    await flushPromises();

    expect(tab.close).not.toHaveBeenCalled();
    expect(appProfileManager.updatePersonalChannel).toHaveBeenCalledTimes(1);
    expect(appProfileManager.updatePersonalChannel).toHaveBeenCalledWith(20);
    expect(mocks.usernameField.originalValue).toBe('operator');
    expect(mocks.toastNew).not.toHaveBeenCalled();

    simulateClickEvent(button);
    await flushPromises();

    expect(appProfileManager.updatePersonalChannel).toHaveBeenCalledTimes(1);
    expect(tab.close).not.toHaveBeenCalled();
  });

  it('reports a personal channel failure without closing', async() => {
    const {tab, content, button} = await mountEditor({
      updatePersonalChannel: () => Promise.reject(new Error('private channel detail'))
    });
    await selectPersonalChannel(content);

    simulateClickEvent(button);
    await flushPromises();

    expect(tab.close).not.toHaveBeenCalled();
    expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Error.AnError'});
    expect(document.body.innerHTML).not.toContain('private channel detail');
  });

  it('reports a photo failure without closing', async() => {
    const {tab, button} = await mountEditor({
      uploadProfilePhoto: () => Promise.reject(new Error('private photo detail'))
    });
    mocks.editPeer.uploadAvatar = {
      file: () => Promise.resolve({_: 'inputFile', id: 'photo'}),
      videoStartTs: 0
    };

    simulateClickEvent(button);
    await flushPromises();

    expect(tab.close).not.toHaveBeenCalled();
    expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Error.AnError'});
    expect(document.body.innerHTML).not.toContain('private photo detail');
  });

  it('waits for every photo upload to settle after one upload part fails', async() => {
    const fileUpload = deferred<any>();
    const videoUpload = deferred<any>();
    const {tab, button} = await mountEditor();
    mocks.editPeer.uploadAvatar = {
      file: () => fileUpload.promise,
      video: () => videoUpload.promise,
      videoStartTs: 10
    };

    simulateClickEvent(button);
    await flushPromises();
    expect(button.disabled).toBe(true);

    fileUpload.reject(new Error('private file upload detail'));
    await flushPromises();
    expect(button.disabled).toBe(true);
    expect(tab.close).not.toHaveBeenCalled();

    videoUpload.resolve({_: 'inputFile', id: 'video'});
    await flushPromises();

    expect(button.disabled).toBe(false);
    expect(tab.close).not.toHaveBeenCalled();
    expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Error.AnError'});
  });

  it('does not apply save or availability results after cleanup', async() => {
    const usernameWrite = deferred<void>();
    const availability = deferred<boolean>();
    const {tab, button, appUsersManager} = await mountEditor({
      updateUsername: () => usernameWrite.promise,
      checkUsername: () => availability.promise
    });
    const username = mocks.usernameField;
    const updateFromOtherAccount = mocks.globalUpdateUsername;
    enter(username.input, 'newhandle');
    await vi.advanceTimersByTimeAsync(150);
    simulateClickEvent(button);
    await flushPromises();
    const labelBeforeCleanup = username.label.textContent;
    const inputClassBeforeCleanup = username.input.className;
    const handleChangeCallsBeforeCleanup = mocks.editPeer.originalHandleChange.mock.calls.length;

    dispose?.();
    dispose = undefined;
    tab.listenerSetter.removeAll();
    usernameWrite.reject({type: 'USERNAME_IMMUTABLE'});
    availability.resolve(true);
    await flushPromises();

    expect(tab.close).not.toHaveBeenCalled();
    expect(username.label.textContent).toBe(labelBeforeCleanup);
    expect(username.input.className).toBe(inputClassBeforeCleanup);
    expect(mocks.editPeer.originalHandleChange).toHaveBeenCalledTimes(handleChangeCallsBeforeCleanup);
    expect(appUsersManager.updateUsername).toHaveBeenCalledWith('newhandle');
    expect(updateFromOtherAccount).not.toHaveBeenCalled();
  });
});
