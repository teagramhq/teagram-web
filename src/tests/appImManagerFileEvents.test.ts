import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadAlongsideFilesFromEvent} from '@helpers/files/getFilesFromEvent';

class TestDragEvent extends Event {}

function makeFileEvent() {
  const file = new File(['image'], 'photo.png', {type: 'image/png'});
  const types = {contains: vi.fn((type: string) => type === 'Files')};
  const item = {
    kind: 'file',
    type: 'image/png',
    webkitGetAsEntry: () => file,
    getAsFile: () => file
  } as unknown as DataTransferItem;
  const dataTransfer = {types, items: [item], files: [file]} as unknown as DataTransfer;
  const detachedDataTransfer = {
    types: {contains: () => false},
    items: [],
    files: []
  } as unknown as DataTransfer;
  const event = new TestDragEvent('drop', {cancelable: true}) as unknown as DragEvent;
  let attached = true;
  Object.defineProperty(event, 'dataTransfer', {
    get: () => attached ? dataTransfer : detachedDataTransfer
  });

  return {
    event,
    file,
    types,
    detach: () => {
      attached = false;
    }
  };
}

function makeTextDragEvent() {
  const dataTransfer = {
    types: {contains: () => false},
    items: [{kind: 'string', type: 'text/plain'}],
    files: []
  } as unknown as DataTransfer;
  const event = new TestDragEvent('dragover', {cancelable: true}) as unknown as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {value: dataTransfer});
  return event;
}

function makeTextPasteEvent() {
  const clipboardData = {
    types: ['text/plain'],
    items: [{kind: 'string', type: 'text/plain'}],
    files: []
  } as unknown as DataTransfer;
  const event = new Event('paste', {cancelable: true}) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {value: clipboardData});
  return event;
}

describe('file data captured from dispatched events', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('snapshots drag types and starts reading them before loading a chunk', async() => {
    vi.stubGlobal('DragEvent', TestDragEvent);
    const {event, types, detach} = makeFileEvent();
    const loaded = vi.fn(() => {
      expect(types.contains).toHaveBeenCalledWith('Files');
      detach();
      return Promise.resolve('drag chunks');
    });

    const result = loadAlongsideFilesFromEvent(event, loaded, {onlyTypes: true});

    expect(result.isFiles).toBe(true);
    expect(loaded).not.toHaveBeenCalled();
    await expect(result.loaded).resolves.toBe('drag chunks');
    await expect(result.files).resolves.toEqual(['image/png']);
  });

  it('cancels a file drop before loading the popup and preserves its files', async() => {
    vi.stubGlobal('DragEvent', TestDragEvent);
    const {event, file, detach} = makeFileEvent();
    const order: string[] = [];
    const loaded = vi.fn(() => {
      order.push('popup');
      detach();
      return Promise.resolve('popup chunk');
    });

    const result = loadAlongsideFilesFromEvent(event, loaded, {
      beforeLoad: (isFiles) => {
        if(isFiles) {
          event.preventDefault();
          order.push('cancel');
        }
      }
    });

    expect(event.defaultPrevented).toBe(true);
    expect(order).toEqual(['cancel']);
    expect(loaded).not.toHaveBeenCalled();
    await expect(result.loaded).resolves.toBe('popup chunk');
    expect(order).toEqual(['cancel', 'popup']);
    await expect(result.files).resolves.toEqual([file]);
  });

  it('does not load drag and drop chunks for a non-file drag', async() => {
    vi.stubGlobal('DragEvent', TestDragEvent);
    const loaded = vi.fn(() => Promise.resolve('drag chunks'));
    const result = loadAlongsideFilesFromEvent(makeTextDragEvent(), loaded);

    expect(result.isFiles).toBe(false);
    expect(loaded).not.toHaveBeenCalled();
    await expect(result.loaded).resolves.toBeUndefined();
    await expect(result.files).resolves.toEqual([]);
    expect(loaded).not.toHaveBeenCalled();
  });

  it('does not load the media popup for a text paste', async() => {
    vi.stubGlobal('DragEvent', TestDragEvent);
    const loaded = vi.fn(() => Promise.resolve('media popup chunk'));
    const result = loadAlongsideFilesFromEvent(makeTextPasteEvent(), loaded);

    expect(loaded).not.toHaveBeenCalled();
    await expect(result.loaded).resolves.toBeUndefined();
    await expect(result.files).resolves.toEqual([]);
    expect(loaded).not.toHaveBeenCalled();
  });
});
