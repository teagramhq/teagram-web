import {normalizeServerHost} from '@config/serverHost';

export const VERSION = 1;
const DEFAULT_LINK_HOST = 'server.teagram.io';
export const TEXT_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz-._:';
export const MAX_ID = (BigInt(1) << BigInt(63)) - BigInt(1);
const MAX_SHORT_NAME_LENGTH = 64;

export type FragmentLink =
  | {type: 1, host?: string, username: string}
  | {type: 2, host?: string, username: string, messageId: bigint}
  | {type: 3, host?: string, channelId: bigint, messageId: bigint}
  | {type: 4, host?: string, hash: Uint8Array}
  | {type: 5, host?: string, secret: Uint8Array}
  | {type: 6, host?: string, shortName: string}
  | {type: 7, host?: string, shortName: string};

export type FragmentLinkErrorKind =
  | 'invalid_code'
  | 'unsupported_version'
  | 'unsupported_type'
  | 'missing_field'
  | 'empty_field'
  | 'length_out_of_range'
  | 'non_canonical'
  | 'invalid_text'
  | 'invalid_username'
  | 'invalid_host'
  | 'invalid_id'
  | 'invalid_secret'
  | 'unexpected_field';

export class FragmentLinkError extends Error {
  constructor(public readonly kind: FragmentLinkErrorKind, field: string) {
    super(`fragment link ${field}: ${kind}`);
    this.name = 'FragmentLinkError';
  }
}

export function fail(kind: FragmentLinkErrorKind, field: string): never {
  throw new FragmentLinkError(kind, field);
}

function asciiFold(value: string) {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

function toBytes(value: bigint) {
  const bytes: number[] = [];
  while(value > BigInt(0)) {
    bytes.unshift(Number(value & BigInt(255)));
    value >>= BigInt(8);
  }
  return new Uint8Array(bytes);
}

export function encodeBase64URL(value: Uint8Array) {
  let binary = '';
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function normalizeHost(value: string) {
  if(!value || value.trim() !== value || /[/?#@\\\s]/.test(value)) fail('invalid_host', 'host');
  if((value.match(/:/g) || []).length > 1) fail('invalid_host', 'host');

  const separator = value.lastIndexOf(':');
  const hostname = separator < 0 ? value : value.slice(0, separator);
  const port = separator < 0 ? '' : value.slice(separator + 1);
  if(separator >= 0 && (!hostname || !/^\d+$/.test(port))) fail('invalid_host', 'host');

  let normalizedHost: string;
  try {
    normalizedHost = normalizeServerHost(hostname);
  } catch{
    return fail('invalid_host', 'host');
  }

  if(!port) return normalizedHost;
  const portNumber = Number(port);
  if(!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) fail('invalid_host', 'host');
  return `${normalizedHost}:${portNumber}`;
}

function encodeText(value: string, field: string) {
  if(!value) fail('empty_field', field);

  let number = BigInt(0);
  const folded = asciiFold(value);
  for(const character of folded) {
    const code = character.charCodeAt(0);
    const digit = code < 128 ? TEXT_ALPHABET.indexOf(character) : -1;
    if(digit < 0) fail('invalid_text', field);
    number = number * BigInt(40) + BigInt(digit + 1);
  }
  return toBytes(number);
}

function encodeUsername(username: string) {
  const value = asciiFold(username);
  if(!/^[a-z][a-z0-9_]{1,31}$/.test(value)) fail('invalid_username', 'username');
  return encodeText(value, 'username');
}

function encodeID(value: bigint, field: string) {
  if(value < BigInt(1) || value > MAX_ID) fail('invalid_id', field);
  return toBytes(value);
}

function encodeShortName(shortName: string) {
  if(shortName.length > MAX_SHORT_NAME_LENGTH) fail('invalid_text', 'short_name');
  return encodeText(shortName, 'short_name');
}

function fieldsForLink(link: FragmentLink) {
  const fields: Uint8Array[] = [];
  let header = (VERSION << 6) | link.type;

  if(link.host !== undefined && link.host !== '') {
    const host = normalizeHost(link.host);
    if(host === DEFAULT_LINK_HOST) fail('non_canonical', 'host');
    fields.push(encodeText(host, 'host'));
    header |= 0x20;
  }

  switch(link.type) {
    case 1:
      fields.push(encodeUsername(link.username));
      break;
    case 2:
      fields.push(encodeUsername(link.username), encodeID(link.messageId, 'message_id'));
      break;
    case 3:
      fields.push(encodeID(link.channelId, 'channel_id'), encodeID(link.messageId, 'message_id'));
      break;
    case 4:
      if(!link.hash.length) fail('empty_field', 'hash');
      fields.push(link.hash);
      break;
    case 5:
      if(link.secret.length !== 32) fail('invalid_secret', 'secret');
      fields.push(link.secret);
      break;
    case 6:
    case 7:
      fields.push(encodeShortName(link.shortName));
      break;
  }

  const bytes: number[] = [header];
  fields.forEach((field, index) => {
    if(index < fields.length - 1) {
      if(!field.length) fail('empty_field', `field_${index}`);
      if(field.length > 255) fail('length_out_of_range', `field_${index}`);
      bytes.push(field.length);
    }
    for(const byte of field) bytes.push(byte);
  });
  return new Uint8Array(bytes);
}

export function encodeFragmentLink(link: FragmentLink) {
  return `#~${encodeBase64URL(fieldsForLink(link))}`;
}

export function encodeBase64Url(value: Uint8Array) {
  return encodeBase64URL(value);
}

// `host` is the active custom server's host; the default server has none.
export function createFragmentLinkURL(link: FragmentLink, host?: string) {
  const target = {...link, host} as FragmentLink;
  return `https://web.teagram.io/${encodeFragmentLink(target)}`;
}

export function toHex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(value: string) {
  if(value.length % 2 || !/^[\da-f]*$/i.test(value)) fail('invalid_code', 'hex');
  return new Uint8Array((value.match(/.{2}/g) || []).map((part) => parseInt(part, 16)));
}
