import {
  FragmentLinkError,
  MAX_ID,
  TEXT_ALPHABET,
  VERSION,
  encodeBase64URL,
  encodeFragmentLink,
  fail,
  normalizeHost,
  toHex,
  type FragmentLink
} from '@lib/fragmentLink';

const MAX_USERNAME_BYTES = 22;
const MAX_SHORT_NAME_BYTES = 43;
const MAX_SHORT_NAME_LENGTH = 64;

function fromBytes(value: Uint8Array) {
  let number = BigInt(0);
  for(const byte of value) number = (number << BigInt(8)) | BigInt(byte);
  return number;
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

function decodeUsername(value: Uint8Array) {
  if(value.length > MAX_USERNAME_BYTES) fail('invalid_username', 'username');
  const username = decodeText(value, 'username');
  if(!/^[a-z][a-z0-9_]{1,31}$/.test(username)) fail('invalid_username', 'username');
  return username;
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

export function dispatchDefaultServerFragmentLink(fragment: string, dispatch: (link: FragmentLink) => void, isDefaultServer: boolean) {
  if(!fragment.startsWith('#~')) return false;

  let link: FragmentLink;
  try {
    link = decodeFragmentLink(fragment);
  } catch(error) {
    if(error instanceof FragmentLinkError) return true;
    throw error;
  }

  if(link.host || !isDefaultServer) return true;
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

export function decodeV1InviteSecret(fragment: string) {
  const link = decodeFragmentLink(fragment);
  if(link.type === 5 && !link.host) return toHex(link.secret);
}
