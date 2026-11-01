export default function cachePromiseWithRetry<T>(
  get: () => Promise<T> | undefined,
  set: (promise: Promise<T> | undefined) => void,
  load: () => Promise<T>
): Promise<T> {
  const current = get();
  if(current) {
    return current;
  }

  const promise = load().catch((error) => {
    if(get() === promise) {
      set(undefined);
    }

    throw error;
  });
  set(promise);

  return promise;
}
