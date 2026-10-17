import type {LangPackDifference, LangPackString} from '@layer';
import I18n, {checkLangPackForUpdates} from '@lib/langPack';
import type {LangPackKey} from '@lib/langPack';
import rootScope from '@lib/rootScope';

describe('checkLangPackForUpdates', () => {
  it('keeps cached language strings when the server rejects the unsupported pack', async() => {
    const storedLangPack = {
      _: 'langPackDifference',
      lang_code: 'en',
      from_version: 1,
      version: 1,
      strings: []
    } as LangPackDifference;
    const error = {type: 'LANG_PACK_INVALID'};
    const getDifference = vi.fn().mockRejectedValue(error);
    const previousManagers = rootScope.managers;
    const key = 'Greeting' as LangPackKey;
    const previousString = I18n.strings.get(key);
    const cachedString: LangPackString = {_: 'langPackString', key: 'Greeting', value: 'Cached greeting'};
    I18n.strings.set(key, cachedString);
    rootScope.managers = {appLangPackManager: {getDifference}} as any;

    const getCacheLangPack = vi.spyOn(I18n, 'getCacheLangPack').mockResolvedValue(storedLangPack);
    const saveLangPack = vi.spyOn(I18n, 'saveLangPack');
    const dispatchEvent = vi.spyOn(rootScope, 'dispatchEvent').mockImplementation((() => {}) as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requestedLanguage = I18n.getLastRequestedLangCode();

    try {
      await expect(checkLangPackForUpdates()).resolves.toBeUndefined();

      expect(getCacheLangPack).toHaveBeenCalledOnce();
      expect(getDifference).toHaveBeenCalledOnce();
      expect(getDifference).toHaveBeenCalledWith('en', 1);
      expect(saveLangPack).not.toHaveBeenCalled();
      expect(I18n.strings.get(key)).toBe(cachedString);
      expect(I18n.getLastRequestedLangCode()).toBe(requestedLanguage);
      expect(dispatchEvent).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('language pack update'), error);
    } finally {
      rootScope.managers = previousManagers;
      if(previousString) {
        I18n.strings.set(key, previousString);
      } else {
        I18n.strings.delete(key);
      }
      vi.restoreAllMocks();
    }
  });
});
