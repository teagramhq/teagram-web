import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const telegramLogoHashes: Record<string, string> = {
  'logo.svg': '99af9dbb97466c5aee7f24d195945670173a53674c6b0c54145b85cfa4de2f9a',
  'logo_512.png': 'fca7b065e3ec334e6079df22d6d9ff995de72ffa8f22624fefcd0f80b30f9168',
  'logo_filled.svg': 'f85f2b6f6742602656fecf24cc7db86c688d80d156603812043da8b1dc6f9ac6',
  'logo_filled_rounded.png': '8ab1180b4a61c62cff09a758560a0de4dcbc0e1f5ba9964b38d06b8c7d8dbc56',
  'logo_padded.svg': 'eeb79b0ae5da35d3433de6edeec3a0e3cce9c24f517dbad26ed97e852666c8f4',
  'logo_plain.svg': '9965ccf211b32e0b65422e36104457981488eda7846a159e8194bead08efebd7'
};

const telegramPlanePathPrefix = 'M80,0 C124.18278,0 160,35.81722';

describe('Teagram logo assets', () => {
  it.each(['index.html', 'public/index.html'])('removes the Telegram logo sprite from %s', (path) => {
    const html = readFileSync(path, 'utf8');

    expect(html).not.toContain('id="logo"');
    expect(html).not.toContain(telegramPlanePathPrefix);
  });

  it.each(Object.entries(telegramLogoHashes))('does not restore the Telegram original for %s', (filename, originalHash) => {
    const image = readFileSync(`public/assets/img/${filename}`);
    const hash = createHash('sha256').update(image).digest('hex');

    expect(hash).not.toBe(originalHash);
  });

  it.each(['logo_512.png', 'logo_filled_rounded.png'])('preserves the 512px dimensions of %s', (filename) => {
    const image = readFileSync(`public/assets/img/${filename}`);

    expect(image.readUInt32BE(16)).toBe(512);
    expect(image.readUInt32BE(20)).toBe(512);
  });

  it.each(['logo.svg', 'logo_filled.svg'])('keeps the primary SVG tile filling its viewBox in %s', (filename) => {
    const svg = readFileSync(`public/assets/img/${filename}`, 'utf8');

    expect(svg).toContain('width="160" height="160"');
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('<rect width="1024" height="1024" rx="228" fill="url(#bg)"/>');
  });
});
