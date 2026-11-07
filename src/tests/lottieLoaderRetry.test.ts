import {expect, it, vi} from 'vitest';

vi.mock('@environment/webAssemblyBaselineSupport', () => ({default: true}));
vi.mock('@environment/webpSupport', () => ({default: false}));
vi.mock('@components/animationIntersector', () => ({default: {}}));
vi.mock('@lib/apiManagerProxy', () => ({default: {}}));

import {LottieLoader} from '@lib/lottie/lottieLoader';

it('retries worker registration after a failed load', async() => {
  const loader = Object.create(LottieLoader.prototype) as LottieLoader;
  const registerLottieWorkers = vi.fn()
  .mockRejectedValueOnce(new Error('transient worker startup failure'))
  .mockResolvedValue(undefined);
  (loader as any).registerLottieWorkers = registerLottieWorkers;

  await expect(loader.loadLottieWorkers()).rejects.toThrow('transient worker startup failure');
  await expect(loader.loadLottieWorkers()).resolves.toBeUndefined();
  expect(registerLottieWorkers).toHaveBeenCalledTimes(2);
});
