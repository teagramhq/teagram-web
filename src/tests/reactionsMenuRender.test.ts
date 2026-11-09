import {describe, expect, it, vi} from 'vitest';
import {onReactionAnimationRendered} from '@components/chat/reactionsMenuRender';

describe('reaction animation render cancellation', () => {
  it('does not start a reaction animation when sticker rendering was cancelled', () => {
    const onRendered = vi.fn();

    expect(onReactionAnimationRendered(undefined, onRendered)).toBeUndefined();
    expect(onRendered).not.toHaveBeenCalled();
  });

  it('passes a loaded animation to its consumer', () => {
    const player = {};
    const onRendered = vi.fn((value: typeof player) => value);

    expect(onReactionAnimationRendered(player, onRendered)).toBe(player);
    expect(onRendered).toHaveBeenCalledWith(player);
  });
});
