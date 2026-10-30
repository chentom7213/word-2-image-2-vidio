/** True or false only when features.watermark is a boolean; otherwise null. */
export function planWatermarkState(features: { watermark?: unknown } | null | undefined): boolean | null {
  if (features == null || typeof features !== 'object') return null;
  return typeof features.watermark === 'boolean' ? features.watermark : null;
}
