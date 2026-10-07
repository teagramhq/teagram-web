import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';

const config = readFileSync('playwright.qr-fixture.config.ts', 'utf8');

describe('QR fixture Vite environment', () => {
  test.each([
    'VITE_MTPROTO_AUTO',
    'VITE_MTPROTO_HAS_HTTP',
    'VITE_MTPROTO_HTTP',
    'VITE_MTPROTO_HTTP_UPLOAD',
    'VITE_MTPROTO_SW',
    'VITE_MTPROTO_WORKER'
  ])('%s uses an empty value for falsey behavior', (flag) => {
    expect(config).toContain(`${flag}= `);
  });
});
