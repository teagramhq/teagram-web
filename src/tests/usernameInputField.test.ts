import {afterEach, describe, expect, it, vi} from 'vitest';
import {createSignal} from 'solid-js';
import {render} from 'solid-js/web';
import ListenerSetter from '@helpers/listenerSetter';
import InputField from '@components/inputField';
import {InputFieldTsx} from '@components/inputFieldTsx';
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

describe('InputField configured length limits', () => {
  it('updates max and minimum length validation after construction', () => {
    const field = new InputField({label: 'EditProfile.Username.Label', plainText: true});
    const input = field.input as HTMLInputElement;
    input.value = 'abcd';
    input.dispatchEvent(new Event('input', {bubbles: true}));

    field.setLengthLimits(4, 2);
    expect(input.classList.contains('error')).toBe(false);

    field.setLengthLimits(20, 5);
    expect(input.classList.contains('error')).toBe(true);

    input.value = 'abcde';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    expect(input.classList.contains('error')).toBe(false);
    expect(field.label.textContent).toBe('EditProfile.Username.Label');
  });

  it('reacts to limit changes passed through InputFieldTsx', () => {
    const [maxLength, setMaxLength] = createSignal<number>();
    const container = document.createElement('div');
    let field: InputField;
    const dispose = render(() => InputFieldTsx({
      label: 'EditProfile.Username.Label',
      plainText: true,
      instanceRef: (value) => { field = value; },
      get maxLength() {
        return maxLength();
      }
    }), container);
    field.value = '12345';

    setMaxLength(4);
    expect(field.input.classList.contains('error')).toBe(true);
    setMaxLength(5);
    expect(field.input.classList.contains('error')).toBe(false);
    dispose();
  });
});
