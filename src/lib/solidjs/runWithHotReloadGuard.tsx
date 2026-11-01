import {createRoot} from 'solid-js';
import type {Component, ParentProps} from 'solid-js';

/**
 * If your function creates and returns computations (e.g. signals, effects, etc.), make sure it is wrapped in a `createRoot` call.
 */
export function runWithHotReloadGuard<T>(fn: () => T, HotReloadGuardProvider: Component<ParentProps>): T {
  let result: T;

  const dispose = createRoot((dispose) => {
    (
      <HotReloadGuardProvider>
        {void (result = fn())}
      </HotReloadGuardProvider>
    );

    return dispose;
  });

  dispose();

  return result;
}
