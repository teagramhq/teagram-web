import {toastNew} from '@components/toast';

export default function handleMediaSendFailure(sendPromise: PromiseLike<unknown>) {
  return Promise.resolve(sendPromise).catch((error: ApiError) => {
    if(error?.type !== 'UPLOAD_CANCELED') {
      toastNew({langPackKey: 'Error.AnError'});
    }
  });
}
