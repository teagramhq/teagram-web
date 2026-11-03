import apiManagerProxy from '@lib/apiManagerProxy';
import {toastNew} from '@components/toast';

export async function processShareTarget(share: ShareData, process: () => Promise<unknown>, onFailure?: (error: unknown) => void) {
  try {
    await process();
    if(apiManagerProxy.share === share) apiManagerProxy.share = undefined;
  } catch(error) {
    if(!apiManagerProxy.share) apiManagerProxy.share = share;
    console.error('Failed to process Web Share Target payload', error);
    toastNew({langPackKey: 'Error.AnError'});
    onFailure?.(error);
  }
}

export function processShareTargetForPicker(share: ShareData, process: () => Promise<unknown>) {
  return processShareTarget(share, process, (error) => {
    throw error;
  });
}
