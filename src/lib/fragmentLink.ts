import {normalizeServerHost} from '@config/serverSelection';
import {getActiveServerHost, getRuntimeServerId} from '@config/serverContext';

const VERSION = 1;
const DEFAULT_LINK_HOST = 'server.teagram.io';
const TEXT_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz-._:';
const MAX_ID = (BigInt(1) << BigInt(63)) - BigInt(1);
const MAX_USERNAME_BYTES = 22;
const MAX_SHORT_NAME_BYTES = 43;
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

function fail(kind: FragmentLinkErrorKind, field: string): never {
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

function fromBytes(value: Uint8Array) {
  let number = BigInt(0);
  for(const byte of value) number = (number << BigInt(8)) | BigInt(byte);
  return number;
}

function encodeBase64URL(value: Uint8Array) {
  let binary = '';
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64URL(value: string) {
  if(value.includes('=')) fail('non_canonical', 'base64url');
  if(!value || !/^[A-Za-z0-9_-]+$/.test(value)) fail('invalid_code', 'base64url');

  let binary: string;
  try {
    const standard = value.replace(/-/g, '+').replace(/_/g, '/');
    binary = atob(standard + '='.repeat((4 - standard.length % 4) % 4));
  } catch{
    return fail('invalid_code', 'base64url');
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if(encodeBase64URL(bytes) !== value) fail('non_canonical', 'base64url');
  return bytes;
}

function normalizeHost(value: string) {
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

function decodeText(value: Uint8Array, field: string) {
  if(!value.length) fail('empty_field', field);
  if(value[0] === 0) fail('non_canonical', field);

  let number = fromBytes(value);
  const characters: string[] = [];
  while(number > BigInt(0)) {
    number -= BigInt(1);
    const digit = Number(number % BigInt(40));
    characters.push(TEXT_ALPHABET[digit]);
    number /= BigInt(40);
  }
  return characters.reverse().join('');
}

function encodeUsername(username: string) {
  const value = asciiFold(username);
  if(!/^[a-z][a-z0-9_]{1,31}$/.test(value)) fail('invalid_username', 'username');
  return encodeText(value, 'username');
}

function decodeUsername(value: Uint8Array) {
  if(value.length > MAX_USERNAME_BYTES) fail('invalid_username', 'username');
  const username = decodeText(value, 'username');
  if(!/^[a-z][a-z0-9_]{1,31}$/.test(username)) fail('invalid_username', 'username');
  return username;
}

function encodeID(value: bigint, field: string) {
  if(value < BigInt(1) || value > MAX_ID) fail('invalid_id', field);
  return toBytes(value);
}

function decodeID(value: Uint8Array, field: string) {
  if(!value.length) fail('empty_field', field);
  const number = fromBytes(value);
  if(number === BigInt(0)) fail('invalid_id', field);
  if(value[0] === 0) fail('non_canonical', field);
  if(value.length > 8) fail('invalid_id', field);

  if(number > MAX_ID) fail('invalid_id', field);
  return number;
}

function encodeShortName(shortName: string) {
  if(shortName.length > MAX_SHORT_NAME_LENGTH) fail('invalid_text', 'short_name');
  return encodeText(shortName, 'short_name');
}

function decodeShortName(value: Uint8Array) {
  if(value.length > MAX_SHORT_NAME_BYTES) fail('invalid_text', 'short_name');
  const shortName = decodeText(value, 'short_name');
  if(shortName.length > MAX_SHORT_NAME_LENGTH) fail('invalid_text', 'short_name');
  return shortName;
}

function dataFieldCount(type: FragmentLink['type']) {
  return type === 2 || type === 3 ? 2 : 1;
}

function splitFields(data: Uint8Array, count: number) {
  const fields: Uint8Array[] = [];
  let offset = 0;

  for(let index = 0; index < count - 1; index++) {
    if(offset >= data.length) fail('missing_field', `field_${index}`);
    const length = data[offset++];
    if(length === 0) fail('empty_field', `field_${index}`);
    if(length > data.length - offset) fail('length_out_of_range', `field_${index}`);
    fields.push(data.slice(offset, offset + length));
    offset += length;
  }

  if(offset >= data.length) fail('missing_field', `field_${count - 1}`);
  fields.push(data.slice(offset));
  return fields;
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

export function createFragmentLinkURL(link: FragmentLink) {
  const serverId = getRuntimeServerId();
  const host = serverId === 'default' ? undefined : getActiveServerHost();
  if(serverId !== 'default' && !host) throw new Error('Active server host is unavailable');
  const target = {...link, host} as FragmentLink;
  return `https://web.teagram.io/${encodeFragmentLink(target)}`;
}

export function dispatchDefaultServerFragmentLink(fragment: string, dispatch: (link: FragmentLink) => void) {
  if(!fragment.startsWith('#~')) return false;

  let link: FragmentLink;
  try {
    link = decodeFragmentLink(fragment);
  } catch(error) {
    if(error instanceof FragmentLinkError) return true;
    throw error;
  }

  if(link.host || getRuntimeServerId() !== 'default') return true;
  dispatch(link);
  return true;
}

export function decodeFragmentLink(fragment: string): FragmentLink {
  if(typeof(fragment) !== 'string' || !fragment.startsWith('#~')) fail('invalid_code', 'fragment');
  if(fragment.length === 2) fail('missing_field', 'header');

  const bytes = decodeBase64URL(fragment.slice(2));
  if(!bytes.length) fail('missing_field', 'header');

  const header = bytes[0];
  if((header >> 6) !== VERSION) fail('unsupported_version', 'version');
  const type = header & 0x1f;
  if(type < 1 || type > 7) fail('unsupported_type', 'type');

  const hasHost = (header & 0x20) !== 0;
  const fields = splitFields(bytes.slice(1), dataFieldCount(type as FragmentLink['type']) + (hasHost ? 1 : 0));
  let fieldIndex = 0;
  let host: string | undefined;
  if(hasHost) {
    host = normalizeHost(decodeText(fields[fieldIndex++], 'host'));
  }

  let link: FragmentLink;
  switch(type) {
    case 1:
      link = {type: 1, ...(host === undefined ? {} : {host}), username: decodeUsername(fields[fieldIndex])};
      break;
    case 2:
      link = {
        type: 2,
        ...(host === undefined ? {} : {host}),
        username: decodeUsername(fields[fieldIndex]),
        messageId: decodeID(fields[fieldIndex + 1], 'message_id')
      };
      break;
    case 3:
      link = {
        type: 3,
        ...(host === undefined ? {} : {host}),
        channelId: decodeID(fields[fieldIndex], 'channel_id'),
        messageId: decodeID(fields[fieldIndex + 1], 'message_id')
      };
      break;
    case 4:
      link = {type: 4, ...(host === undefined ? {} : {host}), hash: fields[fieldIndex]};
      break;
    case 5:
      if(fields[fieldIndex].length !== 32) fail('invalid_secret', 'secret');
      link = {type: 5, ...(host === undefined ? {} : {host}), secret: fields[fieldIndex]};
      break;
    case 6:
      link = {type: 6, ...(host === undefined ? {} : {host}), shortName: decodeShortName(fields[fieldIndex])};
      break;
    case 7:
      link = {type: 7, ...(host === undefined ? {} : {host}), shortName: decodeShortName(fields[fieldIndex])};
      break;
    default:
      return fail('unsupported_type', 'type');
  }

  if(link.type === 4 && link.hash.length === 0) fail('empty_field', 'hash');
  if(encodeFragmentLink(link) !== fragment) fail('non_canonical', 'fragment');
  return link;
}

export function toHex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(value: string) {
  if(value.length % 2 || !/^[\da-f]*$/i.test(value)) fail('invalid_code', 'hex');
  return new Uint8Array((value.match(/.{2}/g) || []).map((part) => parseInt(part, 16)));
}
