import {beforeEach, describe, expect, it, vi} from 'vitest';

const wrapRichText = vi.hoisted(() => vi.fn(() => document.createDocumentFragment()));
const rootScopeMock = vi.hoisted(() => ({premium: false, myId: 1 as PeerId}));

vi.mock('@lib/richTextProcessor/wrapRichText', () => ({default: wrapRichText}));
vi.mock('@lib/rootScope', () => ({default: rootScopeMock}));

import wrapDraftText from '@lib/richTextProcessor/wrapDraftText';

describe('wrapDraftText', () => {
  beforeEach(() => {
    wrapRichText.mockClear();
    rootScopeMock.premium = false;
  });

  it('keeps custom emoji entities for an account without Premium', () => {
    const entities = [{_: 'messageEntityCustomEmoji' as const, offset: 0, length: 2, document_id: '5'}];

    wrapDraftText('👍', {entities, wrappingForPeerId: 2 as PeerId});

    expect((wrapRichText.mock.calls[0] as any[])[1].entities).toEqual(entities);
  });
});
