import { cn } from '../../lib/utils';

export function Segmented({
  value,
  options,
  onChange,
  className,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex gap-1 rounded-full border border-stone-300 p-1 dark:border-stone-700', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 rounded-full px-3 py-1 text-xs font-medium transition',
            value === o.value
              ? 'bg-stone-900 text-white dark:bg-white dark:text-stone-900'
              : 'text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-white',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
