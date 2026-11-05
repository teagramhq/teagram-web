import {readdirSync, readFileSync} from 'node:fs';
import {extname, relative, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const SOURCE_EXTENSIONS = new Set(['.css', '.html', '.js', '.mjs', '.scss', '.svg', '.ts', '.tsx']);
const quoteCharacters = [String.fromCharCode(39), String.fromCharCode(34), String.fromCharCode(96)].join('');
const unrootedAssetUrl = new RegExp(`[${quoteCharacters}]assets${String.fromCharCode(47)}`);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if(entry.isDirectory()) return sourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

describe('root-relative asset URLs', () => {
  it('does not leave relative assets URLs that break on deep links', () => {
    const sourceRoot = resolve(process.cwd(), 'src');
    const offenders = sourceFiles(sourceRoot).flatMap((path) => {
      return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line, index) => (
        unrootedAssetUrl.test(line) ? [`${relative(sourceRoot, path)}:${index + 1}`] : []
      ));
    });

    expect(offenders).toEqual([]);
  });
});
