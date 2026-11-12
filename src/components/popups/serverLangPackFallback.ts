import I18n from '@lib/langPack';
import rootScope from '@lib/rootScope';

const SERVER_LANG_PACK_PREFIX = 'Teagram.Server.';

export async function ensureServerLangPackFallbacks() {
  const cachedPack = await I18n.getCacheLangPack(true);
  if(!cachedPack) return;

  const cachedStrings = new Map(cachedPack.strings.map((string) => [string.key, string]));
  const localPack = await I18n.loadLocalLangPack();
  const fallbackStrings = localPack.strings.filter(({key}) => {
    if(!key.startsWith(SERVER_LANG_PACK_PREFIX)) return false;
    const cachedString = cachedStrings.get(key);
    return !cachedString || (cachedString._ === 'langPackString' && (!cachedString.value || cachedString.value === key));
  });
  if(!fallbackStrings.length) return;

  const fallbackKeys = new Set(fallbackStrings.map(({key}) => key));
  await I18n.saveLangPack({
    ...cachedPack,
    strings: [...fallbackStrings, ...cachedPack.strings.filter(({key}) => !fallbackKeys.has(key))]
  }, true);
}

rootScope.addEventListener('language_apply', () => {
  ensureServerLangPackFallbacks().catch((error) => {
    console.error('Could not restore server confirmation language fallbacks', error);
  });
});
