import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

/** Deterministic pseudo-random gradient stops derived from a seed string. */
export function seedGradient(seed: string, index = 0) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i) + index * 7) >>> 0;
  const a = h % 360;
  const b = (a + 40 + ((h >> 8) % 120)) % 360;
  const c = (a + 180 + ((h >> 4) % 60)) % 360;
  return `linear-gradient(135deg, hsl(${a} 70% 55%), hsl(${b} 65% 45%) 50%, hsl(${c} 60% 35%))`;
}
