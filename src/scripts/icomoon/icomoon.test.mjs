import {afterEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {strToU8, zipSync} from 'fflate';
import pipeline from './icomoon.js';
import unzip from './icomoon-zip.js';

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'icomoon-zip-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for(const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe('icomoon pipeline', () => {
  it('propagates generation failures', async() => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(pipeline({icons: ['icon.svg']})).rejects.toThrow('Please config a valid selection file path.');
    } finally {
      errorLog.mockRestore();
    }
  });

  it('extracts a valid archive into the output directory', () => {
    const directory = temporaryDirectory();
    const archivePath = join(directory, 'icons.zip');
    const outputDir = join(directory, 'output');
    writeFileSync(archivePath, zipSync({'fonts/icomoon.woff2': strToU8('font data')}));

    unzip(archivePath, outputDir);

    expect(readFileSync(join(outputDir, 'fonts/icomoon.woff2'), 'utf8')).toBe('font data');
  });

  it('rejects an archive entry that traverses outside the output directory', () => {
    const directory = temporaryDirectory();
    const archivePath = join(directory, 'icons.zip');
    const outputDir = join(directory, 'output');
    const outsidePath = join(directory, 'escaped.txt');
    writeFileSync(archivePath, zipSync({'../escaped.txt': strToU8('outside')}));

    expect(() => unzip(archivePath, outputDir)).toThrow('Refusing to unzip ../escaped.txt');
    expect(existsSync(outsidePath)).toBe(false);
  });
});
