import I18n from '@lib/langPack';

const SERVER_LANG_PACK_PREFIX = 'Teagram.Server.';

export async function ensureServerLangPackFallbacks() {
  const cachedPack = await I18n.getCacheLangPack(true);
  if(!cachedPack) return;

  const cachedKeys = new Set(cachedPack.strings.map(({key}) => key));
  const localPack = await I18n.loadLocalLangPack();
  const fallbackStrings = localPack.strings.filter(({key}) => key.startsWith(SERVER_LANG_PACK_PREFIX) && !cachedKeys.has(key));
  if(!fallbackStrings.length) return;

  await I18n.saveLangPack({
    ...cachedPack,
    strings: [...fallbackStrings, ...cachedPack.strings]
  }, true);
}
