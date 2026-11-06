import {afterEach, describe, expect, it} from 'vitest';
import {render} from 'solid-js/web';
import MediaHeader from '@components/mediaHeader';

describe('media header styles', () => {
  let dispose: VoidFunction | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.replaceChildren();
  });

  it('uses classes from the startup stylesheet for the header pieces', () => {
    dispose = render(() => (
      <MediaHeader marginBottom>
        <MediaHeader.Sticker element={<span/>} size={120}/>
        <MediaHeader.Title>Title</MediaHeader.Title>
        <MediaHeader.Subtitle secondary>Subtitle</MediaHeader.Subtitle>
      </MediaHeader>
    ), document.body);

    expect(document.querySelector('.media-header__margin-bottom')).toBeTruthy();
    expect(document.querySelector('.media-header__sticker')).toBeTruthy();
    expect(document.querySelector('.media-header__title')?.textContent).toBe('Title');
    expect(document.querySelector('.media-header__subtitle.secondary')?.textContent).toBe('Subtitle');
  });
});
