import flatten from '@helpers/array/flatten';

export function resolveSearchHelperResults<T>(
  arrays: (T[] | undefined)[],
  middleware: () => boolean
): T[] | undefined {
  if(!middleware()) return;

  return flatten(arrays.filter((array): array is T[] => array !== undefined));
}
