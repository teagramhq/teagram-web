import {describe, expect, it} from 'vitest';
import createDocumentPreview from '@components/wrappers/documentPreview';

describe('document preview', () => {
  it('keeps a hostile server URL inside the image src attribute', () => {
    const source = 'https://files.example/preview" onerror="window.compromised=true';
    const image = createDocumentPreview(source);

    expect(image.tagName).toBe('IMG');
    expect(image.getAttribute('src')).toBe(source);
    expect(image.hasAttribute('onerror')).toBe(false);
    expect(image.childNodes).toHaveLength(0);
  });
});
