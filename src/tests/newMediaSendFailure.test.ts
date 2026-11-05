import {afterEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  toastNew: vi.fn()
}));

vi.mock('@components/toast', () => ({
  toastNew: mocks.toastNew
}));

import handleMediaSendFailure from '@components/popups/mediaSendError';

afterEach(() => {
  vi.clearAllMocks();
});

describe('media send failures', () => {
  it('shows the existing error toast when a media upload is rejected', async() => {
    const uploadError = new Error('upload rejected');
    await handleMediaSendFailure(Promise.resolve({
      promise: Promise.reject(uploadError)
    }));

    expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Error.AnError'});
  });

  it('shows the existing error toast when a grouped media send is rejected', async() => {
    await handleMediaSendFailure(Promise.reject(new Error('send rejected')));

    expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Error.AnError'});
  });

  it('does not show an error toast when the user cancels an upload', async() => {
    await handleMediaSendFailure(Promise.resolve({
      promise: Promise.reject({type: 'UPLOAD_CANCELED'} as ApiError)
    }));

    expect(mocks.toastNew).not.toHaveBeenCalled();
  });
});
