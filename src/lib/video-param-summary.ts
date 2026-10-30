function finitePositive(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Size token for the narrow video-studio summary.
 * A non-empty aspect label is returned as-is. Positive width and height become `width×height`.
 * Anything else, including 0×0, returns null so the caller can use its adaptive label.
 */
export function videoParamSizeSummary(
  aspectLabel: string | null | undefined,
  width: number,
  height: number,
): string | null {
  const label = typeof aspectLabel === 'string' ? aspectLabel.trim() : '';
  if (label) return label;
  if (!finitePositive(width) || !finitePositive(height)) return null;
  return `${width}×${height}`;
}
