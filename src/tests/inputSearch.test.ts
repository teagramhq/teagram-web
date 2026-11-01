import {expect, test, vi} from 'vitest';

vi.mock('@components/inputField', () => ({
  default: class {
    container = document.createElement('div');
    input = document.createElement('input');

    get value() {
      return this.input.value;
    }

    set value(value: string) {
      this.input.value = value;
    }

    isEmpty() {
      return !this.input.value;
    }
  }
}));

vi.mock('@components/buttonIcon', () => ({default: () => document.createElement('button')}));
vi.mock('@components/icon', () => ({default: () => document.createElement('span')}));
vi.mock('@components/connectionStatus', () => ({default: class {static ANIMATION_DURATION = 0}}));
vi.mock('@components/preloader', () => ({default: class {}}));
vi.mock('@components/singleTransition', () => ({default: vi.fn()}));
vi.mock('@helpers/dom/clickEvent', () => ({attachClickEvent: vi.fn()}));
vi.mock('@helpers/string/classNames', () => ({default: vi.fn()}));
vi.mock('@lib/langPack', () => ({i18n: () => document.createElement('span')}));
vi.mock('@helpers/listenerSetter', () => ({
  default: class {
    add(element: HTMLElement) {
      return (event: string, listener: EventListener) => element.addEventListener(event, listener);
    }

    removeAll() {}
  }
}));

import InputSearch from '@components/inputSearch';

test('processes text entered before its async search handler is attached', async() => {
  const inputSearch = new InputSearch({debounceTime: 0});
  const onChange = vi.fn();

  inputSearch.input.value = 'typed while loading';
  inputSearch.input.dispatchEvent(new Event('input', {bubbles: true}));
  inputSearch.setOnChange(onChange);

  await vi.waitFor(() => {
    expect(onChange).toHaveBeenCalledWith('typed while loading');
  });

  inputSearch.remove();
});
