import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {assertNoQrFixtureArtifactContent} from './qr-fixture-artifact.mjs';

const artifactDirectories = [];

afterEach(() => {
  artifactDirectories.splice(0).forEach((directory) => fs.rmSync(directory, {recursive: true, force: true}));
});

describe('QR fixture artifact guard', () => {
  it.each([
    'TWEB_QR_FIXTURE_DEV_ONLY_SENTINEL_6D9B42E1',
    'src/qrFixtureApp.tsx',
    'src/qrFixtureEntry.ts',
    'window.qrFixture'
  ])('rejects an artifact containing %s', (marker) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-qr-fixture-artifact-'));
    artifactDirectories.push(directory);
    fs.writeFileSync(path.join(directory, 'index.js'), `const leaked = '${marker}';`);

    expect(() => assertNoQrFixtureArtifactContent(directory)).toThrow('QR fixture content detected');
  });
});
