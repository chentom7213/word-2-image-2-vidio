import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useI18n } from '../../lib/i18n';

export type Option = { value: string; label: string; hint?: string; icon?: React.ReactNode };

export function Select({
  value,
  onChange,
  options,
  placeholder,
  className,
  size = 'md',
  renderValue,
}: {
  value: string | null;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  className?: string;
  size?: 'sm' | 'md';
  renderValue?: (opt: Option | undefined) => React.ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={ref} className={cn('relative w-full', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-md border border-stone-300 bg-transparent text-left text-stone-700 outline-none transition hover:border-stone-400 dark:border-stone-700 dark:text-stone-200 dark:hover:border-stone-600',
          size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm',
          open && 'ring-2 ring-ring/40',
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate', !current && 'text-muted-foreground')}>
          {renderValue ? renderValue(current) : current ? current.label : placeholder}
        </span>
        <ChevronDown className={cn('size-4 shrink-0 opacity-60 transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="thin-scrollbar absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl animate-fade-in">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-accent',
                opt.value === value && 'bg-accent/70',
              )}
            >
              {opt.icon}
              <span className="min-w-0 flex-1 truncate">{opt.label}</span>
              {opt.hint && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{opt.hint}</span>}
            </button>
          ))}
          {options.length === 0 && <div className="px-2 py-3 text-center text-xs text-muted-foreground">{t('select_empty')}</div>}
        </div>
      )}
    </div>
  );
}
