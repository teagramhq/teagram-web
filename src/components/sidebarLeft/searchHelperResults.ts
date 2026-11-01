import flatten from '@helpers/array/flatten';

export function updateSearchHelperResults<T>(
  arrays: T[][],
  middleware: () => boolean,
  helper: HTMLElement,
  appendToHelper: (items: T[]) => void
) {
  if(!middleware()) return;

  helper.replaceChildren();
  appendToHelper(flatten(arrays));
}
