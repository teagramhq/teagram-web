export function onReactionAnimationRendered<T, TResult>(
  player: T | undefined,
  onRendered: (player: T) => TResult
): TResult | undefined {
  if(player === undefined) return;
  return onRendered(player);
}
