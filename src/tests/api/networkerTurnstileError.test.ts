import {describe, expect, it} from 'vitest';

import MTPNetworker from '@lib/mtproto/networker';

describe('MTProto auth error parsing', () => {
  it.each([
    'RECAPTCHA_CHECK_signin__1x00000000000000000000AA',
    'RECAPTCHA_CHECK_signup__1x00000000000000000000AA'
  ])('preserves Turnstile error type %s', (errorMessage) => {
    const networker = Object.create(MTPNetworker.prototype) as MTPNetworker;
    const error = (networker as any).processError({error_code: 403, error_message: errorMessage});

    expect(error.type).toBe(errorMessage);
    expect(error.code).toBe(403);
  });
});
