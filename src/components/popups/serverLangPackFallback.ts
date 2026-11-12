import I18n from '@lib/langPack';
import rootScope from '@lib/rootScope';
import type {LangPackString} from '@layer';
import type {LangPackKey} from '@lib/langPack';

const SERVER_LANG_PACK_PREFIX = 'Teagram.Server.';

function needsLocalFallback(string: LangPackString | undefined, key: string) {
  return !string || (string._ === 'langPackString' && (!string.value || string.value === key));
}

export async function ensureServerLangPackFallbacks() {
  const cachedPack = await I18n.getCacheLangPack(true);
  const localPack = await I18n.loadLocalLangPack();
  const cachedStrings = new Map(cachedPack?.strings.map((string) => [string.key, string]));
  const localServerStrings = localPack.strings.filter(({key}) => key.startsWith(SERVER_LANG_PACK_PREFIX));
  const localStrings = new Map(localServerStrings.map((string) => [string.key, string]));

  for(const {key} of localServerStrings) {
    const cachedString = cachedStrings.get(key);
    const activeString = I18n.strings.get(key as LangPackKey);
    if(needsLocalFallback(activeString, key)) {
      I18n.strings.set(key as LangPackKey, needsLocalFallback(cachedString, key) ? localStrings.get(key)! : cachedString!);
    }
  }

  if(!cachedPack) return;
  const fallbackStrings = localServerStrings.filter(({key}) => needsLocalFallback(cachedStrings.get(key), key));
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
