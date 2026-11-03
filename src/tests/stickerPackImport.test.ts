import {zipSync} from 'fflate';
import {describe, expect, it} from 'vitest';
import {readStickerPackZip, validateStickerPackFiles} from '@helpers/stickerPackImport';
import {createStickerSetShareLink, parseStickerSetShareLink} from '@helpers/stickerSetLink';

const makeFile = (name: string, size: number) => new File([new Uint8Array(size)], name);

describe('sticker pack import files', () => {
  it('accepts supported files within their format limits and reports the rest', () => {
    const result = validateStickerPackFiles([
      makeFile('cat.WEBP', 512 * 1024),
      makeFile('loop.tgs', 64 * 1024 + 1),
      makeFile('clip.webm', 256 * 1024),
      makeFile('photo.png', 8)
    ], 'stickers');

    expect(result.files.map((file) => file.name)).toEqual(['cat.WEBP', 'clip.webm']);
    expect(result.rejected).toEqual([
      {name: 'loop.tgs', reason: 'too_large'},
      {name: 'photo.png', reason: 'unsupported_format'}
    ]);
  });

  it('keeps no more than the set type allows and reports excess files', () => {
    const stickers = validateStickerPackFiles(
      Array.from({length: 121}, (_, index) => makeFile(`sticker-${index}.webp`, 1)),
      'stickers'
    );
    const emoji = validateStickerPackFiles(
      Array.from({length: 201}, (_, index) => makeFile(`emoji-${index}.webp`, 1)),
      'emoji'
    );

    expect(stickers.files).toHaveLength(120);
    expect(stickers.rejected).toHaveLength(1);
    expect(stickers.rejected[0]).toEqual({name: 'sticker-120.webp', reason: 'too_many'});
    expect(emoji.files).toHaveLength(200);
    expect(emoji.rejected).toHaveLength(1);
    expect(emoji.rejected[0]).toEqual({name: 'emoji-200.webp', reason: 'too_many'});
  });

  it('uses only an archive entry basename when creating an upload file', async() => {
    const archive = zipSync({'../animals/cat.webp': Uint8Array.from([1, 2, 3])});
    const result = await readStickerPackZip(new File([archive], 'pack.zip'));

    expect(result.error).toBeUndefined();
    expect(result.files.map((file) => file.name)).toEqual(['cat.webp']);
    expect(result.rejected).toEqual([]);
  });

  it('stops reading a zip after its 201st entry', async() => {
    const entries = Object.fromEntries(
      Array.from({length: 202}, (_, index) => [`${index}.webp`, Uint8Array.from([1])])
    );
    const archive = zipSync(entries, {level: 0});
    const result = await readStickerPackZip(new File([archive], 'too-many.zip'));

    expect(result.error).toBe('too_many_entries');
    expect(result.files).toHaveLength(0);
  });

  it('blocks an archive with an entry larger than the server limit', async() => {
    const archive = zipSync({'too-large.txt': new Uint8Array(512 * 1024 + 1)}, {level: 0});
    const result = await readStickerPackZip(new File([archive], 'too-large.zip'));

    expect(result.error).toBe('entry_too_large');
    expect(result.files).toHaveLength(0);
  });
});

describe('sticker set share links', () => {
  it('builds and parses a link using the server prefix and set type', () => {
    const stickers = createStickerSetShareLink('https://teagram.test/links/', 'cats_a', false);
    const emoji = createStickerSetShareLink('https://teagram.test/links/', 'faces_2', true);

    expect(stickers).toBe('https://teagram.test/links/addstickers/cats_a');
    expect(emoji).toBe('https://teagram.test/links/addemoji/faces_2');
    expect(parseStickerSetShareLink(stickers, 'https://teagram.test/links/')).toEqual({shortName: 'cats_a', isEmoji: false});
    expect(parseStickerSetShareLink(emoji, 'https://teagram.test/links/')).toEqual({shortName: 'faces_2', isEmoji: true});
  });

  it('rejects links outside the exact server prefix and names outside the allowed pattern', () => {
    expect(parseStickerSetShareLink('https://other.test/addstickers/cats_a', 'https://teagram.test/')).toBeUndefined();
    expect(parseStickerSetShareLink('https://teagram.test/addstickers/cats%2Fa', 'https://teagram.test/')).toBeUndefined();
    expect(parseStickerSetShareLink('https://teagram.test/addstickers/cats_a/extra', 'https://teagram.test/')).toBeUndefined();
    expect(parseStickerSetShareLink('https://teagram.test/addstickers/cats_a?start=1', 'https://teagram.test/')).toBeUndefined();
  });
});
