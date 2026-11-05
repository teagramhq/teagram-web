import type {ChatUpdateOptions} from '@lib/rootScope';

export default function shouldReconcileEmptyChannelDialog(options?: ChatUpdateOptions) {
  return !options?.skipEmptyChannelDialogReconciliation;
}
