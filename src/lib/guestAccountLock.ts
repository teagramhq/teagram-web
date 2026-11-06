export function createGuestAccountServerLock<T>(name: string, callback: () => Promise<T>) {
  if(typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.reject(Object.assign(new Error('This browser cannot safely serialize guest account creation'), {
      type: 'GUEST_LOCK_UNAVAILABLE'
    }));
  }
  return navigator.locks.request(name, callback);
}
