import { cn } from '../lib/utils';

/** Pill-shaped option chip used for resolution / count / aspect selectors. */
export const chip = (active: boolean, extra?: string) =>
  cn(
    'cursor-pointer border text-sm transition hover:opacity-80',
    active
      ? 'border-stone-900 bg-stone-900/[0.06] font-medium text-stone-900 dark:border-stone-100 dark:bg-white/10 dark:text-stone-50'
      : 'border-stone-300 text-stone-600 dark:border-stone-700 dark:text-stone-300',
    extra,
  );

/** Bordered field wrapper (inputs with W / H / p prefixes). */
export const field = 'border-stone-300 dark:border-stone-700';

export const helpText = 'text-stone-500 dark:text-stone-400';
