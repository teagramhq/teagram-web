import {toastNew} from '@components/toast';

type SendFileResult = {promise?: PromiseLike<unknown>};

export default function handleMediaSendFailure(sendPromise: PromiseLike<SendFileResult | void>) {
  return Promise.resolve(sendPromise).then((result) => {
    if(result && typeof result === 'object') {
      return result.promise;
    }
  }).catch((error: ApiError) => {
    if(error?.type !== 'UPLOAD_CANCELED') {
      toastNew({langPackKey: 'Error.AnError'});
    }
  });
}
