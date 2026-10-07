const renderRefusal = (message: string) => {
  const element = document.createElement('div');
  element.dataset.qrFixtureError = '';
  element.textContent = message;
  document.body.append(element);
};

if(import.meta.env.DEV) {
  void (async() => {
    const {getQrFixtureMountRefusal, isQrFixtureOutcome, parseQrFixtureSearchParams, QR_FIXTURE_REFUSAL_MESSAGE} =
      await import('./qrFixtureSecurity');
    let localStorageKeys: string[] | undefined;
    let sessionStorageKeys: string[] | undefined;

    try {
      const readKeys = (storage: Storage) => Array.from({length: storage.length}, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null);
      localStorageKeys = readKeys(window.localStorage);
      sessionStorageKeys = readKeys(window.sessionStorage);
    } catch{
      // Unavailable storage cannot establish that this browser is unauthenticated.
    }

    const refusal = getQrFixtureMountRefusal(
      !!import.meta.env.VITE_PREVIEW,
      localStorageKeys,
      sessionStorageKeys
    );
    const outcome = parseQrFixtureSearchParams(new URL(location.href).searchParams);

    if(refusal || !outcome) {
      renderRefusal(refusal || QR_FIXTURE_REFUSAL_MESSAGE);
    } else {
      const {mountQrFixtureApp} = await import('./qrFixtureApp');
      await mountQrFixtureApp(outcome, isQrFixtureOutcome);
    }
  })();
} else {
  renderRefusal('Synthetic QR fixture is available only in development');
}
