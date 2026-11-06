import {expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({loaded: false, open: vi.fn(async() => 'opened')}));
vi.mock('@components/popups/myQrCode', () => {
  state.loaded = true;
  return {default: state.open};
});

it('loads the QR popup only on demand and forwards its arguments and result', async() => {
  const {default: showMyQrCodePopup} = await import('@components/popups/lazyMyQrCode');
  expect(state.loaded).toBe(false);
  const options = {url: 'https://example.test/profile'};
  await expect(showMyQrCodePopup(123 as PeerId, options)).resolves.toBe('opened');
  expect(state.open).toHaveBeenCalledWith(123, options);
});
