import type { AssetKind } from './types';

/** Guests always see every reference slot. Signed-in users only see kinds the model lists. */
export function referenceKindVisible(
  signedIn: boolean,
  refs: readonly string[] | null | undefined,
  kind: AssetKind,
): boolean {
  if (!signedIn) return true;
  return refs?.includes(kind) ?? false;
}
