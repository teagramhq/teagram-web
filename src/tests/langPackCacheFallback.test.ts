import type {LangPackDifference, LangPackString} from '@layer';
import lang from '@/lang';
import commonStateStorage from '@lib/commonStateStorage';
import I18n, {handleUpdateLangPack} from '@lib/langPack';
import rootScope from '@lib/rootScope';

describe('cached language pack fallbacks', () => {
  it('adds local fallback strings without replacing cached translations', async() => {
    const cachedTranslation: LangPackString = {
      _: 'langPackString',
      key: 'Teagram.Server.IdentityTitle',
      value: 'Cached identity title'
    };
    const cachedPack: LangPackDifference = {
      _: 'langPackDifference',
      lang_code: 'en',
      from_version: 1,
      version: 1,
      strings: [cachedTranslation]
    };
    const previousStrings = new Map(I18n.strings);
    const getCachedPack = vi.spyOn(commonStateStorage, 'get').mockResolvedValue(cachedPack as any);
    const dispatchEvent = vi.spyOn(rootScope, 'dispatchEvent').mockImplementation((() => {}) as any);
    const dispatchEventSingle = vi.spyOn(rootScope, 'dispatchEventSingle').mockImplementation((() => {}) as any);

    try {
      await I18n.getCacheLangPackAndApply();

      expect(I18n.format('Teagram.Server.IdentityTitle', true)).toBe('Cached identity title');
      const fallbackKeys = [
        'Teagram.Server.ConfirmTitle',
        'Teagram.Server.ConfirmNote',
        'Teagram.Server.PinnedFingerprint',
        'Teagram.Server.PresentedFingerprint',
        'Teagram.Server.IdentityBlocked',
        'Teagram.Server.IdentityCancel',
        'Teagram.Server.IdentityContinue',
        'Teagram.Server.DeleteTitle',
        'Teagram.Server.DeleteConfirm'
      ] as const;
      fallbackKeys.forEach((key) => expect(I18n.format(key, true)).toBe(lang[key]));
    } finally {
      I18n.strings.clear();
      previousStrings.forEach((value, key) => I18n.strings.set(key, value));
      getCachedPack.mockRestore();
      dispatchEvent.mockRestore();
      dispatchEventSingle.mockRestore();
    }
  });

  it('keeps local fallback strings when applying an update to an older cache', async() => {
    const cachedPack: LangPackDifference = {
      _: 'langPackDifference',
      lang_code: 'en',
      from_version: 1,
      version: 1,
      strings: [{
        _: 'langPackString',
        key: 'Teagram.Server.IdentityTitle',
        value: 'Cached identity title'
      }]
    };
    const difference: LangPackDifference = {
      _: 'langPackDifference',
      lang_code: 'en',
      from_version: 1,
      version: 2,
      strings: []
    };
    const previousStrings = new Map(I18n.strings);
    const getCachedPack = vi.spyOn(commonStateStorage, 'get').mockResolvedValue(cachedPack as any);
    const saveUpdatedPack = vi.spyOn(commonStateStorage, 'set').mockResolvedValue(undefined as any);
    const dispatchEvent = vi.spyOn(rootScope, 'dispatchEvent').mockImplementation((() => {}) as any);
    const dispatchEventSingle = vi.spyOn(rootScope, 'dispatchEventSingle').mockImplementation((() => {}) as any);

    try {
      await I18n.loadLocalLangPackAndApply();
      await handleUpdateLangPack({difference});

      expect(I18n.format('Teagram.Server.IdentityTitle', true)).toBe('Cached identity title');
      expect(I18n.format('Teagram.Server.PinnedFingerprint', true)).toBe(lang['Teagram.Server.PinnedFingerprint']);
    } finally {
      I18n.strings.clear();
      previousStrings.forEach((value, key) => I18n.strings.set(key, value));
      getCachedPack.mockRestore();
      saveUpdatedPack.mockRestore();
      dispatchEvent.mockRestore();
      dispatchEventSingle.mockRestore();
    }
  });
});
