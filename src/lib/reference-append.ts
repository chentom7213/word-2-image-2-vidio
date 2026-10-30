import type { Asset } from './types';

/** Copy `current`, then append new ids until `max`. Never mutates either input. */
export function appendReferenceAssets(current: readonly Asset[], incoming: readonly Asset[], max: number): Asset[] {
  const next = current.slice();
  if (incoming.length === 0 || next.length >= max) return next;

  const seen = new Set<string>();
  for (const asset of next) seen.add(asset.id);

  for (const asset of incoming) {
    if (next.length >= max) break;
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    next.push(asset);
  }
  return next;
}
