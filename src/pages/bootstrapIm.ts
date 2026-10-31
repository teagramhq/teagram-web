import blurActiveElement from '@helpers/dom/blurActiveElement';
import loadFonts from '@helpers/dom/loadFonts';
import {doubleRaf} from '@helpers/schedulers';
import isNativeVoiceRecorderSupported from '@helpers/voiceRecorder/isNativeSupported';
import rootScope from '@lib/rootScope';

import {disposeActiveAuthFlow} from '@/pages/mountAuthFlow';

let bootstrapped = false;

type AppDialogsManagerModule = typeof import('@lib/appDialogsManager');

/**
 * Procedural replacement for the legacy `pageIm` `Page` instance.
 *
 * Marks the user as signed-in, shows the `#page-chats` container, kicks off
 * `appDialogsManager`, and tears down any active `<AuthCardsHost>`.
 *
 * Idempotent — calling it twice (e.g. once from inside the auth flow on success,
 * once from `src/index.ts` on a directly-signed-in boot) is a no-op the second
 * time.
 */
export async function bootstrapIm(appDialogsManagerImport?: Promise<AppDialogsManagerModule>): Promise<void> {
  if(bootstrapped) return;
  bootstrapped = true;

  const appDialogsManagerModuleImport = appDialogsManagerImport || import('@lib/appDialogsManager');
  // Skip the opus-recorder fallback chunk entirely on browsers that have the
  // WebCodecs-based native path. Saves ~80 KB of WASM-shipping JS on every
  // sign-in for ~94% of users (May 2026 baseline).
  const recorderImport: Promise<{default: unknown} | null> = isNativeVoiceRecorderSupported() ?
    Promise.resolve(null) :
    import('@vendor/recorder.min.js' as any);
  const videoFramePolyfillImport = 'requestVideoFrameCallback' in HTMLVideoElement.prototype ?
    Promise.resolve() :
    import('@helpers/dom/requestVideoFrameCallbackPolyfill');
  void loadFonts();

  void rootScope.managers.appStateManager.pushToState('authState', {_: 'authStateSignedIn'}).catch((err) => {
    console.error('Failed to persist signed-in app state', err);
  });

  const pageChatsEl = document.getElementById('page-chats');
  if(pageChatsEl) pageChatsEl.style.display = '';

  blurActiveElement();

  const [{default: appDialogsManager}, recorder] = await Promise.all([
    appDialogsManagerModuleImport,
    recorderImport,
    videoFramePolyfillImport
  ]);

  if(recorder) {
    (window as any).Recorder = recorder.default;
  }
  appDialogsManager.start();
  // start() toggles body.is-left-column-shown synchronously
  // (appImManager.selectTab(CHATLIST)). The .main-column transform/opacity
  // transition in _chats.scss is gated by :not(.has-auth-pages) so the bar
  // doesn't slide in from its off-screen handheld state. The two class
  // changes (add is-left-column-shown, remove has-auth-pages) would
  // otherwise batch into a single style commit and the gate would have no
  // effect — yield a frame so the committed state still has has-auth-pages
  // and the transform/opacity jump is instant.
  await doubleRaf();
  document.body.classList.remove('has-auth-pages');

  // Tear down the auth UI 1s after IM appears — same delay the legacy
  // `pageIm.onFirstMount` used so the cross-fade looks right.
  setTimeout(() => {
    disposeActiveAuthFlow();
  }, 1000);
}

export default bootstrapIm;
