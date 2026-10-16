import {readFileSync} from 'fs';
import {resolve} from 'path';

type WebManifest = {
  name: string,
  short_name: string,
  description: string,
  id: string,
  start_url: string,
  scope: string
};

const EXPECTED_MANIFEST_ID = 'https://web.telegram.org/k/';
const EXPECTED_DESCRIPTION = 'Self-hosted messaging that speaks the Telegram protocol.';

const manifests = [
  'site.webmanifest',
  'site_apple.webmanifest'
].map((fileName) => ({
  fileName,
  manifest: JSON.parse(readFileSync(resolve(__dirname, '../../public', fileName), 'utf8')) as WebManifest
}));

describe('PWA web manifests', () => {
  test.each(manifests)('$fileName identifies Teagram and stays in its own scope', ({manifest}) => {
    expect(manifest.name).toBe('Teagram Web');
    expect(manifest.short_name).toBe('Teagram');
    expect(manifest.description).toBe(EXPECTED_DESCRIPTION);
    expect(manifest.id).toBe('/k/');
    expect(new URL(manifest.id, 'https://web.telegram.org/').href).toBe(EXPECTED_MANIFEST_ID);
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest).not.toHaveProperty('scope_extensions');
    expect(JSON.stringify(manifest)).not.toMatch(/https?:\/\/(?:t\.me|telegram\.me)/);
  });
});
