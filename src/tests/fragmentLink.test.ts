import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';

import {
  createFragmentLinkURL,
  decodeFragmentLink,
  dispatchDefaultServerFragmentLink,
  encodeFragmentLink,
  FragmentLinkError,
  type FragmentLink
} from '@/lib/fragmentLink';

type VectorInput = {
  type: number,
  host?: string,
  username?: string,
  channel_id?: string,
  message_id?: string,
  join_hash_hex?: string,
  secret_hex?: string,
  short_name?: string
};

type Vector = {
  name: string,
  input: VectorInput,
  code: string,
  rule?: string
};

const vectors = JSON.parse(readFileSync(resolve(process.cwd(), 'src/tests/fixtures/fragment-link-v1-vectors.json'), 'utf8')) as {
  valid: Vector[],
  invalid: Vector[]
};

function bytesFromHex(value: string) {
  return new Uint8Array((value.match(/.{2}/g) || []).map((part) => parseInt(part, 16)));
}

function linkFromInput(input: VectorInput): FragmentLink {
  const host = input.host ? {host: input.host} : {};
  switch(input.type) {
    case 1:
      return {type: 1, ...host, username: input.username!};
    case 2:
      return {type: 2, ...host, username: input.username!, messageId: BigInt(input.message_id!)};
    case 3:
      return {type: 3, ...host, channelId: BigInt(input.channel_id!), messageId: BigInt(input.message_id!)};
    case 4:
      return {type: 4, ...host, hash: bytesFromHex(input.join_hash_hex!)};
    case 5:
      return {type: 5, ...host, secret: bytesFromHex(input.secret_hex!)};
    case 6:
      return {type: 6, ...host, shortName: input.short_name!};
    case 7:
      return {type: 7, ...host, shortName: input.short_name!};
    default:
      throw new Error(`Unknown test vector type ${input.type}`);
  }
}

describe('v1 fragment link codec', () => {
  it.each(vectors.valid)('decodes $name and reproduces its canonical code', (vector) => {
    const link = linkFromInput(vector.input);

    expect(decodeFragmentLink(vector.code)).toEqual(link);
    expect(encodeFragmentLink(link)).toBe(vector.code);
  });

  it.each(vectors.invalid)('rejects $name by its declared rule', (vector) => {
    let error: unknown;
    try {
      decodeFragmentLink(vector.code);
    } catch(caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(FragmentLinkError);
    expect((error as FragmentLinkError).kind).toBe(vector.rule);
  });

  it('reports a missing header for an empty v1 fragment', () => {
    expect(() => decodeFragmentLink('#~')).toThrowError(expect.objectContaining({kind: 'missing_field'}));
  });

  it('builds public share URLs with the canonical web fragment', () => {
    expect(createFragmentLinkURL({type: 1, username: 'alice'})).toBe('https://web.teagram.io/#~QQHDpNc');
    expect(createFragmentLinkURL({type: 2, username: 'alice', messageId: BigInt(1)}))
      .toBe('https://web.teagram.io/#~QgQBw6TXAQ');
    expect(createFragmentLinkURL({type: 3, channelId: BigInt(123456789), messageId: BigInt(42)}))
      .toBe('https://web.teagram.io/#~QwQHW80VKg');
  });

  it('does not dispatch invalid or hosted links to a network-capable handler', () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const dispatch = vi.fn(() => { void fetch('/should-not-run'); });

    try {
      expect(dispatchDefaultServerFragmentLink('#~*', dispatch)).toBe(true);
      expect(dispatchDefaultServerFragmentLink('#~YQsL89lf9Nd0cL6ssQHDpNc', dispatch)).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not dispatch default-host links from a custom server runtime', () => {
    const dispatch = vi.fn();
    vi.stubGlobal('__TEAGRAM_ACTIVE_SERVER_ID__', `custom-${'a'.repeat(64)}`);

    try {
      expect(dispatchDefaultServerFragmentLink('#~QQHDpNc', dispatch)).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('builds hosted links for a custom server without making them dispatchable here', () => {
    const customServerId = `custom-${'a'.repeat(64)}`;
    const dispatch = vi.fn();
    vi.stubGlobal('__TEAGRAM_ACTIVE_SERVER_ID__', customServerId);
    vi.stubGlobal('__TEAGRAM_ACTIVE_SERVER_HOST__', 'chat.example.org');

    try {
      const url = createFragmentLinkURL({type: 1, username: 'alice'});
      expect(url).toBe('https://web.teagram.io/#~YQsL89lf9Nd0cL6ssQHDpNc');
      expect(dispatchDefaultServerFragmentLink(new URL(url).hash, dispatch)).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
