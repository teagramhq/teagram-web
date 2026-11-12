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
    }
  });

  it('does not save when there is no cached language pack', async() => {
    const getCachedPack = vi.spyOn(I18n, 'getCacheLangPack').mockResolvedValue(undefined);
    const loadLocalPack = vi.spyOn(I18n, 'loadLocalLangPack');
    const savePack = vi.spyOn(I18n, 'saveLangPack');

    try {
      await ensureServerLangPackFallbacks();

      expect(loadLocalPack).not.toHaveBeenCalled();
      expect(savePack).not.toHaveBeenCalled();
    } finally {
      getCachedPack.mockRestore();
      loadLocalPack.mockRestore();
      savePack.mockRestore();
    }
  });
});
