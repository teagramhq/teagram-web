import {expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({events: [] as string[]}));

vi.mock('@lib/solidjs/hotReloadGuard', () => ({useLockScreenHotReloadGuard: () => ({
  rootScope: {dispatchEvent: () => {}},
  apiManagerProxy: {
    invoke: async(type: string) => { state.events.push(type); },
    serviceMessagePort: {invoke: async() => {}}
  }
})}));
vi.mock('@lib/passcode/utils', () => ({createEncryptionArtifactsForPasscode: async() => ({
  verificationHash: new Uint8Array(), verificationSalt: new Uint8Array(), encryptionSalt: new Uint8Array(), encryptionKey: {}
})}));
vi.mock('@lib/commonStateStorage', () => ({default: {
  set: async() => { state.events.push('save-passcode'); },
  delete: async() => { state.events.push('delete-passcode'); }
}}));
vi.mock('@lib/files/cacheStorage', () => ({default: {
  temporarilyToggle: () => {}, clearEncryptableStorages: async() => {}, resetOpenEncryptableCacheStorages: () => {}
}}));
vi.mock('@stores/appSettings', () => ({useAppSettings: () => [undefined, async() => {}]}));
vi.mock('@lib/accounts/accountController', () => ({default: {updateStorageForLegacy: async() => {}}}));
vi.mock('@lib/passcode/keyStore', () => ({default: {save: () => {}}}));

import {usePasscodeActions} from '@lib/passcode/actions';
import {blockSnapshotReads} from '@lib/chatPageSnapshot';

it('clears snapshots before making a local passcode persistent', async() => {
  state.events.length = 0;
  await usePasscodeActions().enablePasscode('a passcode');
  expect(state.events.indexOf('preparePasscodeSnapshots')).toBeGreaterThanOrEqual(0);
  expect(state.events.indexOf('preparePasscodeSnapshots')).toBeLessThan(state.events.indexOf('save-passcode'));
});

it('does not resume snapshots until passcode metadata has been removed', async() => {
  state.events.length = 0;
  blockSnapshotReads();
  await usePasscodeActions().disablePasscode();
  expect(state.events.indexOf('delete-passcode')).toBeGreaterThanOrEqual(0);
  expect(state.events.indexOf('delete-passcode')).toBeLessThan(state.events.indexOf('resumePasscodeSnapshots'));
});
