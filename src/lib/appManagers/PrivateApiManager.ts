import type {DcId, InvokeApiOptions} from '@types';
import type MTPNetworker from '@lib/mtproto/networker';

import {AUTH_METHODS_WITH_RAW_ERRORS, getAuthMethod} from './authLogRedaction';
import {ApiManager as BaseApiManager} from './apiManager';

const privateNetworkers = new WeakSet<object>();

function securePrivateNetworker(networker: MTPNetworker): MTPNetworker {
  if(privateNetworkers.has(networker)) return networker;
  privateNetworkers.add(networker);

  const privateNetworker = networker as unknown as {wrapApiCall: MTPNetworker['wrapApiCall']};
  const wrapApiCall = privateNetworker.wrapApiCall;
  privateNetworker.wrapApiCall = function(method, params, options) {
    const request = Reflect.apply(wrapApiCall, networker, [method, params, options]);
    const authMethod = getAuthMethod(method, params);
    if(!AUTH_METHODS_WITH_RAW_ERRORS.has(authMethod)) return request;

    return request.catch((error: ApiError) => {
      if(error?.type === 'UNKNOWN' || error?.type === 'MTPROTO_CLUSTER_INVALID') {
        throw {...error, type: 'NETWORK_BAD_RESPONSE'};
      }

      throw error;
    });
  };

  return networker;
}

export class ApiManager extends BaseApiManager {
  public override getNetworker(dcId: DcId, options: InvokeApiOptions = {}): Promise<MTPNetworker> {
    return super.getNetworker(dcId, options).then(securePrivateNetworker);
  }
}
