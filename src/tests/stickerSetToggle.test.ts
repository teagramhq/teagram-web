import {describe, expect, it, vi} from 'vitest';
import {AppStickersManager} from '@appManagers/appStickersManager';
import {getStickerSetInputByShortName} from '@appManagers/utils/stickers/getStickerSetInput';

const makeManager = () => {
  const set: any = {_: 'stickerSet', id: '77', access_hash: '5', short_name: 'twemoji_custom_emojis', count: 1};
  const cache: Record<string, any> = {};
  const manager: any = Object.create(AppStickersManager.prototype);
  // The sticker popup loads a pack by short name, so only that key is cached.
  cache[JSON.stringify(getStickerSetInputByShortName(set.short_name))] = {_: 'messages.stickerSet', set, documents: []};
  manager.storage = {
    getFromCache: (key: string) => cache[key],
    delete: vi.fn()
  };
  manager.apiManager = {invokeApi: vi.fn(async() => ({_: 'messages.stickerSetInstallResultSuccess'}))};
  manager.rootScope = {dispatchEvent: vi.fn()};
  manager.saveStickerSetLocal = vi.fn();
  return {manager, set};
};

describe('toggling a sticker set opened by short name', () => {
  it('installs it and announces the installed set', async() => {
    const {manager, set} = makeManager();

    const toggled = await AppStickersManager.prototype.toggleStickerSet.call(manager, {...set});

    expect(toggled).toBe(true);
    expect(manager.apiManager.invokeApi).toHaveBeenCalledWith('messages.installStickerSet', expect.objectContaining({archived: false}));
    expect(manager.rootScope.dispatchEvent).toHaveBeenCalledWith('stickers_installed', expect.objectContaining({id: '77'}));
    expect(set.installed_date).toBeTruthy();
  });
});
