import startMainStartupTasks from '@lib/mainStartupTasks';
import deferred from './helpers/deferred';

describe('main startup tasks', () => {
  test('starts the chat bundle import with state loading', async() => {
    const started: string[] = [];
    const bootstrapIm = deferred<{bootstrapIm: () => void}>();
    const states = deferred<string>();

    const tasks = startMainStartupTasks({
      bootstrapIm: () => {
        started.push('bootstrapIm');
        return bootstrapIm.promise;
      },
      states: () => {
        started.push('states');
        return states.promise;
      }
    });

    expect(started).toEqual(['bootstrapIm', 'states']);

    const module = {bootstrapIm: () => {}};
    bootstrapIm.resolve(module);
    await expect(tasks.bootstrapIm).resolves.toBe(module);

    states.resolve('loaded');
    await expect(tasks.states).resolves.toBe('loaded');
  });
});
