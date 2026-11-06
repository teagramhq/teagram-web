import {recordPromise} from '@helpers/recordPromise';

test('logs a rejected promise with its description and returns the rejection to its caller', async() => {
  const failure = new Error('peer setup failed');
  const log = {warn: vi.fn(), error: vi.fn()};
  const promise = Promise.reject(failure);

  await expect(recordPromise(promise, 'peer setup', log as any)).rejects.toBe(failure);

  expect(log.error).toHaveBeenCalledWith(expect.anything(), 'error', 'peer setup', failure);
});
