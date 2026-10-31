import DialogsStorage, {FilterType} from '@lib/storages/dialogs';
import {FOLDER_ID_ALL} from '@appManagers/constants';

function createStorage(getTopMessages: (...args: unknown[]) => Promise<unknown>) {
  const storage = new DialogsStorage();
  storage.clear(true);
  Object.assign(storage as any, {
    appPeersManager: {isBotforum: () => false},
    filtersStorage: {getFilter: (): undefined => undefined},
    appMessagesManager: {getTopMessages}
  });
  (storage as any).cachedListReconciled = true;

  const dialog = {
    _: 'dialog',
    peerId: 42 as PeerId,
    folder_id: FOLDER_ID_ALL,
    top_message: 1,
    pFlags: {}
  } as any;
  storage.getFolder(FOLDER_ID_ALL, FilterType.Folder).dialogs.push(dialog);

  return {storage, dialog};
}

describe('dialogs cache-first loading', () => {
  it('returns a cached first page while its refresh request is still pending', () => {
    const getTopMessages = vi.fn((): Promise<unknown> => new Promise(() => {}));
    const {storage, dialog} = createStorage(getTopMessages);

    const result = storage.getDialogs({
      filterId: FOLDER_ID_ALL,
      filterType: FilterType.Folder,
      limit: 20,
      cacheFirst: true
    });

    expect(result).toMatchObject({dialogs: [dialog], isEnd: false});
    expect(getTopMessages).toHaveBeenCalledTimes(1);
  });

  it('keeps non-chat-list callers waiting for an incomplete first page', () => {
    const getTopMessages = vi.fn((): Promise<unknown> => new Promise(() => {}));
    const {storage} = createStorage(getTopMessages);

    const result = storage.getDialogs({
      filterId: FOLDER_ID_ALL,
      filterType: FilterType.Folder,
      limit: 20
    });

    expect(result).toBeInstanceOf(Promise);
  });

  it('shares a pending refresh across cache-first callers', () => {
    const getTopMessages = vi.fn((): Promise<unknown> => new Promise(() => {}));
    const {storage} = createStorage(getTopMessages);
    const options = {
      filterId: FOLDER_ID_ALL,
      filterType: FilterType.Folder,
      limit: 20,
      cacheFirst: true
    };

    storage.getDialogs(options);
    storage.getDialogs(options);

    expect(getTopMessages).toHaveBeenCalledTimes(1);
  });

  it('updates the cached folder count when its refresh completes', async() => {
    const getTopMessages = vi.fn(() => Promise.resolve({count: 25}));
    const {storage} = createStorage(getTopMessages);
    const folder = storage.getFolder(FOLDER_ID_ALL, FilterType.Folder);

    storage.getDialogs({
      filterId: FOLDER_ID_ALL,
      filterType: FilterType.Folder,
      limit: 20,
      cacheFirst: true
    });

    await vi.waitFor(() => expect(folder.count).toBe(25));
  });
});
