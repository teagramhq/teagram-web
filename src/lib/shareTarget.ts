import apiManagerProxy from '@lib/apiManagerProxy';

export async function processShareTarget(share: ShareData, process: () => Promise<unknown>) {
  try {
    await process();
    if(apiManagerProxy.share === share) apiManagerProxy.share = undefined;
  } catch(error) {
    console.error('Failed to process Web Share Target payload', error);
  }
}
