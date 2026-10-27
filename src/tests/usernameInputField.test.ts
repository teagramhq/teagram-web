import {afterEach, describe, expect, it, vi} from 'vitest';
import ListenerSetter from '@helpers/listenerSetter';
import {UsernameInputField} from '@components/usernameInputField';

vi.mock('@lib/langPack', () => ({
  i18n: (key: string) => key,
  _i18n: (element: HTMLElement, key: string) => {
    element.textContent = key;
    return element;
  }
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

vi.mock('@lib/customEmoji/renderer', () => ({
  CustomEmojiRendererElement: class CustomEmojiRendererElement {
    public static create() {
      return {add: vi.fn(), forceRender: vi.fn()};
    }
  }
}));

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return {promise, resolve: resolve!};
}

function createField(appConfig: Promise<Partial<MTAppConfig>>, checkUsername: ReturnType<typeof vi.fn>) {
  const listenerSetter = new ListenerSetter();
  const field = new UsernameInputField({
    label: 'EditProfile.Username.Label',
    name: 'username',
    plainText: true,
    listenerSetter,
    availableText: 'EditProfile.Username.Available',
    invalidText: 'EditProfile.Username.Invalid',
    takenText: 'EditProfile.Username.Taken'
  }, {
    apiManager: {getAppConfig: () => appConfig},
    appUsersManager: {checkUsername}
  } as any);

  field.setOriginalValue('original', true);
  return {field, listenerSetter};
}

describe('UsernameInputField', () => {
  afterEach(() => vi.useRealTimers());

  it('applies configured rules when appConfig arrives before the username check', async() => {
    vi.useFakeTimers();
    const appConfig = deferred<Partial<MTAppConfig>>();
    const checkUsername = vi.fn().mockResolvedValue(true);
    const {field, listenerSetter} = createField(appConfig.promise, checkUsername);
    (field.input as HTMLInputElement).value = 'a';
    field.input.dispatchEvent(new Event('input', {bubbles: true}));

    appConfig.resolve({username_min_length: 2});
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);

    expect(field.input.classList.contains('error')).toBe(true);
    expect(field.label.textContent).toBe('EditProfile.Username.Invalid');
    expect(checkUsername).not.toHaveBeenCalled();
    listenerSetter.removeAll();
  });

  it('allows missing local rules and shows the server username error inline', async() => {
    vi.useFakeTimers();
    const checkUsername = vi.fn().mockRejectedValue({type: 'USERNAME_INVALID'});
    const {field, listenerSetter} = createField(Promise.resolve({}), checkUsername);
    (field.input as HTMLInputElement).value = 'a';
    field.input.dispatchEvent(new Event('input', {bubbles: true}));

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();

    expect(checkUsername).toHaveBeenCalledWith('a');
    expect(field.input.classList.contains('error')).toBe(true);
    expect(field.label.textContent).toBe('EditProfile.Username.Invalid');
    listenerSetter.removeAll();
  });
});
