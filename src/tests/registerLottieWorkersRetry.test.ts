import {expect, it, vi} from 'vitest';

const registerWorker = vi.hoisted(() => vi.fn());

vi.mock('@helpers/appWindow', () => ({
  bindActiveWindowListener: vi.fn(),
  getAppWindow: vi.fn()
}));
vi.mock('@lib/apiManagerProxy', () => ({
  default: {
    attachWorkerToPort: vi.fn(),
    invoke: vi.fn(),
    invokeVoid: vi.fn()
  }
}));
vi.mock('@lib/lottie/lottieMessagePort', () => ({default: {}}));
vi.mock('@lib/lottie/shouldRenderOffscreen', () => ({default: false}));
vi.mock('@lib/lottie/registerThreadedWorker', () => ({default: registerWorker}));

import {registerLottieWorkers} from '@lib/lottie/registerLottieWorkers';

it('retries failed registration and shares the retry in flight', async() => {
  let resolveRetry: () => void = () => {};
  registerWorker
  .mockRejectedValueOnce(new Error('transient worker startup failure'))
  .mockImplementationOnce(() => new Promise<void>((resolve) => {
    resolveRetry = resolve;
  }));

  await expect(registerLottieWorkers()).rejects.toThrow('transient worker startup failure');

  const retry = registerLottieWorkers();
  const concurrentRetry = registerLottieWorkers();
  expect(registerWorker).toHaveBeenCalledTimes(2);

  resolveRetry();
  await expect(Promise.all([retry, concurrentRetry])).resolves.toEqual([undefined, undefined]);
  expect(registerWorker).toHaveBeenCalledTimes(2);
});
