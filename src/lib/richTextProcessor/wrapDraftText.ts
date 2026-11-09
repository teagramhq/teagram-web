import type {AnimationItemGroup} from '@components/animationIntersector';
import wrapRichText from '@lib/richTextProcessor/wrapRichText';

export default function wrapDraftText(text: string, options: Partial<{
  wrappingForPeerId: PeerId,
  animationGroup?: AnimationItemGroup
}> & Parameters<typeof wrapRichText>[1] = {}) {
  if(!text) {
    return wrapRichText('');
  }

  const fragment = wrapRichText(text, {
    ...options,
    noLinks: true,
    wrappingDraft: true,
    passEntities: {
      messageEntityTextUrl: true,
      messageEntityMentionName: true
    }
  });

  return fragment;
}
