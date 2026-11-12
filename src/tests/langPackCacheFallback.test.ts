import type {LangPackDifference, LangPackString} from '@layer';
import I18n from '@lib/langPack';
import {ensureServerLangPackFallbacks} from '@components/popups/serverLangPackFallback';

describe('server confirmation language fallbacks', () => {
  it('applies only missing local server strings while preserving cached translations', async() => {
    const cachedTranslation: LangPackString = {
      _: 'langPackString',
      key: 'Teagram.Server.IdentityTitle',
      value: 'Cached identity title'
    };
    const otherCachedString: LangPackString = {
      _: 'langPackString',
      key: 'Other.Key',
      value: 'Cached value'
    };
    const localFallback: LangPackString = {
      _: 'langPackString',
      key: 'Teagram.Server.PinnedFingerprint',
      value: 'Pinned fingerprint'
    };
    const localTranslation: LangPackString = {
      _: 'langPackString',
      key: 'Teagram.Server.IdentityTitle',
      value: 'Local identity title'
    };
    const cachedRawKey: LangPackString = {
      _: 'langPackString',
      key: 'Teagram.Server.IdentityBlocked',
      value: 'Teagram.Server.IdentityBlocked'
    };
    const localBlockedWarning: LangPackString = {
      _: 'langPackString',
      key: 'Teagram.Server.IdentityBlocked',
      value: 'The connection is blocked.'
    };
    const localOtherString: LangPackString = {
      _: 'langPackString',
      key: 'Other.LocalKey',
      value: 'Local value'
    };
    const cachedPack: LangPackDifference = {
      _: 'langPackDifference',
      lang_code: 'en',
      from_version: 1,
      version: 1,
      strings: [cachedTranslation, cachedRawKey, otherCachedString]
    };
    const localPack: LangPackDifference = {
      _: 'langPackDifference',
      lang_code: 'en',
      from_version: 0,
      version: 1,
      strings: [localFallback, localTranslation, localBlockedWarning, localOtherString]
    };
    const getCachedPack = vi.spyOn(I18n, 'getCacheLangPack').mockResolvedValue(cachedPack);
    const loadLocalPack = vi.spyOn(I18n, 'loadLocalLangPack').mockResolvedValue(localPack);
    const savePack = vi.spyOn(I18n, 'saveLangPack').mockResolvedValue(cachedPack);
    const activeKeys = ['Teagram.Server.PinnedFingerprint', 'Teagram.Server.IdentityTitle', 'Teagram.Server.IdentityBlocked'];
    const previousActiveStrings = new Map(activeKeys.map((key) => [key, I18n.strings.get(key as any)]));

    try {
      await ensureServerLangPackFallbacks();

      expect(getCachedPack).toHaveBeenCalledWith(true);
      expect(savePack).toHaveBeenCalledWith({
        ...cachedPack,
        strings: [localFallback, localBlockedWarning, cachedTranslation, otherCachedString]
      }, true);
    } finally {
      getCachedPack.mockRestore();
      loadLocalPack.mockRestore();
      savePack.mockRestore();
      for(const [key, string] of previousActiveStrings) {
        if(string) I18n.strings.set(key as any, string);
        else I18n.strings.delete(key as any);
      }
    }
  });

  it('repairs active server strings when a stale language apply races a merged cache', async() => {
    const cachedFallback: LangPackString = {
      _: 'langPackString',
      key: 'Teagram.Server.PinnedFingerprint',
      value: 'Cached pinned fingerprint'
    };
    const localFallback: LangPackString = {
      _: 'langPackString',
      key: 'Teagram.Server.PinnedFingerprint',
      value: 'Pinned fingerprint'
    };
    const activeRawKey: LangPackString = {
      _: 'langPackString',
      key: 'Teagram.Server.PinnedFingerprint',
      value: 'Teagram.Server.PinnedFingerprint'
    };
    const cachedPack: LangPackDifference = {
      _: 'langPackDifference',
      lang_code: 'en',
      from_version: 1,
      version: 1,
      strings: [cachedFallback]
    };
    const localPack: LangPackDifference = {
      _: 'langPackDifference',
      from_version: 0,
      lang_code: 'en',
      version: 1,
      strings: [localFallback]
    };
    const key = 'Teagram.Server.PinnedFingerprint';
    const previousActiveString = I18n.strings.get(key);
    I18n.strings.set(key, activeRawKey);
    const getCachedPack = vi.spyOn(I18n, 'getCacheLangPack').mockResolvedValue(cachedPack);
    const loadLocalPack = vi.spyOn(I18n, 'loadLocalLangPack').mockResolvedValue(localPack);
    const savePack = vi.spyOn(I18n, 'saveLangPack').mockResolvedValue(cachedPack);

    try {
      await ensureServerLangPackFallbacks();

      expect(I18n.strings.get(key)).toEqual(cachedFallback);
      expect(savePack).not.toHaveBeenCalled();
    } finally {
      getCachedPack.mockRestore();
      loadLocalPack.mockRestore();
      savePack.mockRestore();
      if(previousActiveString) I18n.strings.set(key, previousActiveString);
      else I18n.strings.delete(key);
    }
  });

  it('applies local server strings when there is no cached language pack', async() => {
    const key = 'Teagram.Server.PinnedFingerprint';
    const localFallback: LangPackString = {
      _: 'langPackString',
      key,
      value: 'Pinned fingerprint'
    };
    const localPack: LangPackDifference = {
      _: 'langPackDifference',
      from_version: 0,
      lang_code: 'en',
      version: 1,
      strings: [localFallback]
    };
    const previousActiveString = I18n.strings.get(key as any);
    I18n.strings.delete(key as any);
    const getCachedPack = vi.spyOn(I18n, 'getCacheLangPack').mockResolvedValue(undefined);
    const loadLocalPack = vi.spyOn(I18n, 'loadLocalLangPack').mockResolvedValue(localPack);
    const savePack = vi.spyOn(I18n, 'saveLangPack');

    try {
      await ensureServerLangPackFallbacks();

      expect(loadLocalPack).toHaveBeenCalled();
      expect(savePack).not.toHaveBeenCalled();
      expect(I18n.strings.get(key as any)).toEqual(localFallback);
    } finally {
      getCachedPack.mockRestore();
      loadLocalPack.mockRestore();
      savePack.mockRestore();
      if(previousActiveString) I18n.strings.set(key as any, previousActiveString);
      else I18n.strings.delete(key as any);
    }
  });
});
