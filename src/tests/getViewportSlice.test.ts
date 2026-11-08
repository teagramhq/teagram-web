import {expect, test, vi} from 'vitest';
import getViewportSlice from '@helpers/dom/getViewportSlice';

test('finds the viewport slice without measuring every offscreen bubble', () => {
  const elements = Array.from({length: 2_000}, (_, index) => {
    const element = {
      getBoundingClientRect: vi.fn(() => ({
        top: index * 20,
        right: 200,
        bottom: index * 20 + 18,
        left: 0
      } as DOMRect))
    } as unknown as HTMLElement;

    return element;
  });
  const overflowElement = {
    querySelectorAll: vi.fn(() => elements)
  } as unknown as HTMLElement;

  const slice = getViewportSlice({
    overflowElement,
    overflowRect: {top: 5_000, right: 500, bottom: 5_500, left: 0},
    selector: '.bubble',
    extraSize: 100,
    extraMinLength: 5
  });

  expect(slice.invisibleTop).toHaveLength(240);
  expect(slice.visible).toHaveLength(45);
  expect(slice.invisibleBottom).toHaveLength(1_715);
  expect(slice.visible[0].element).toBe(elements[240]);
  expect(slice.visible.slice(-1)[0]?.element).toBe(elements[284]);

  const measuredRects = elements.reduce((sum, element) => sum + vi.mocked(element.getBoundingClientRect).mock.calls.length, 0);
  expect(measuredRects).toBeLessThan(100);
});
