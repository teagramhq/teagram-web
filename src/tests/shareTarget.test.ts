import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({share: undefined as unknown as ShareData}));
vi.mock('@lib/apiManagerProxy', () => ({default: mocks}));

import {processShareTarget} from '@lib/shareTarget';

describe('Web Share Target payload handling', () => {
  beforeEach(() => {
    mocks.share = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves and logs the payload when lazy processing rejects', async() => {
    const share = {title: 'Draft', text: 'Keep this draft', url: 'https://example.com'} as ShareData;
    const error = new Error('chunk load failed');
    mocks.share = share;
    const process = vi.fn().mockRejectedValue(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    await processShareTarget(share, process);

    expect(process).toHaveBeenCalledOnce();
    expect(mocks.share).toBe(share);
    expect(log).toHaveBeenCalledWith('Failed to process Web Share Target payload', error);
  });

  it('restores the payload and rethrows deferred file processing errors', async() => {
    const share = {files: [new File(['file'], 'image.png')]} as ShareData;
    const error = new Error('new media chunk failed');
    const process = vi.fn().mockRejectedValue(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(processShareTarget(share, process, (failure) => {
      throw failure;
    })).rejects.toBe(error);

    expect(mocks.share).toBe(share);
    expect(log).toHaveBeenCalledWith('Failed to process Web Share Target payload', error);
  });

  it('clears the payload after successful processing', async() => {
    const share = {title: 'Draft', text: 'Send this', url: 'https://example.com'} as ShareData;
    mocks.share = share;

    await processShareTarget(share, async() => {});

    expect(mocks.share).toBeUndefined();
  });
});
