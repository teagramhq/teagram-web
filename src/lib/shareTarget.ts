import apiManagerProxy from '@lib/apiManagerProxy';

export async function processShareTarget(share: ShareData, process: () => Promise<unknown>, onFailure?: (error: unknown) => void) {
  try {
    await process();
    if(apiManagerProxy.share === share) apiManagerProxy.share = undefined;
  } catch(error) {
    if(!apiManagerProxy.share) apiManagerProxy.share = share;
    console.error('Failed to process Web Share Target payload', error);
    onFailure?.(error);
  }
}
