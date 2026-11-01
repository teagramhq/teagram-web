import {expect, test, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  showChatPreviewPopup: vi.fn()
}));

vi.mock('@components/popups/chatPreview', () => ({
  default: mocks.showChatPreviewPopup
}));

import {openChatPreviewFromDialogRow} from '@components/popups/chatPreviewAnchor';

test('cancels shift-click before loading the preview popup', async() => {
  const column = document.createElement('div');
  column.className = 'sidebar-left';
  const row = document.createElement('div');
  column.append(row);
  document.body.append(column);

  row.getBoundingClientRect = () => ({
    left: 10,
    right: 110,
    top: 20,
    bottom: 60,
    width: 100,
    height: 40
  } as DOMRect);
  column.getBoundingClientRect = () => ({
    left: 0,
    right: 200,
    top: 0,
    bottom: 600,
    width: 200,
    height: 600
  } as DOMRect);

  const event = new MouseEvent('mousedown', {bubbles: true, cancelable: true});
  const opening = openChatPreviewFromDialogRow(event, row, {peerId: 42 as PeerId});

  expect(event.defaultPrevented).toBe(true);
  expect(event.cancelBubble).toBe(true);

  await opening;
  expect(mocks.showChatPreviewPopup).toHaveBeenCalledWith({
    peerId: 42,
    anchor: {
      x: 200,
      y: 40,
      left: 10,
      right: 200,
      top: 20,
      bottom: 60
    }
  });

  column.remove();
});
