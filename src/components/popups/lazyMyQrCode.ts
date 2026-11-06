import type showMyQrCodePopup from '@components/popups/myQrCode';

const showLazyMyQrCodePopup: typeof showMyQrCodePopup = (...args) => {
  return import('@components/popups/myQrCode').then(({default: show}) => show(...args));
};

export default showLazyMyQrCodePopup;
