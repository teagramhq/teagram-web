import {expect, test, vi} from 'vitest';
import createAppImManagerKeydownHandler from '@lib/appImManagerKeydown';

test('ignores Ctrl+ArrowUp before chat initialization', async() => {
  const getFirstMessageToEdit = vi.fn();
  const manager = {
    chat: undefined,
    isShiftLockShortcut: false,
    managers: {
      appMessagesManager: {getFirstMessageToEdit}
    },
    setPeer: vi.fn()
  } as unknown as Parameters<typeof createAppImManagerKeydownHandler>[0];
  const onKeyDown = createAppImManagerKeydownHandler(
    manager,
    {filterId: 0, contextMenu: undefined},
    () => false
  );
  vi.spyOn(document, 'getSelection').mockReturnValue({isCollapsed: true} as Selection);

  const event = {
    key: 'ArrowUp',
    code: 'ArrowUp',
    isTrusted: true,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: document.body
  } as unknown as KeyboardEvent;

  await expect(onKeyDown(event)).resolves.toBeUndefined();
  expect(getFirstMessageToEdit).not.toHaveBeenCalled();
});
