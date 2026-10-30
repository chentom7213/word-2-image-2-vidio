import { useCallback, useRef } from 'react';
import { sliderPercent } from '../../lib/slider-percent';
import { cn } from '../../lib/utils';

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  className,
  ariaLabel,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  className?: string;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const setFromEvent = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const raw = min + ratio * (max - min);
      const snapped = Math.round(raw / step) * step;
      onChange(Math.min(max, Math.max(min, snapped)));
    },
    [min, max, step, onChange],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setFromEvent(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.buttons !== 1) return;
    setFromEvent(e.clientX);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - step;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + step;
    if (e.key === 'PageDown') next = value - step * 2;
    if (e.key === 'PageUp') next = value + step * 2;
    if (e.key === 'Home') next = min;
    if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    onChange(Math.min(max, Math.max(min, next)));
  };

  const percent = sliderPercent(value, min, max);

  return (
    <div
      ref={ref}
      className={cn('relative flex h-9 cursor-pointer touch-none items-center select-none', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value}`}
    >
      <div className="h-1 w-full rounded-full bg-stone-300 dark:bg-stone-700" />
      <div className="absolute left-0 h-1 rounded-full bg-stone-800 dark:bg-white" style={{ width: `${percent}%` }} />
      <div
        className="absolute size-3.5 -translate-x-1/2 rounded-full border-2 border-stone-800 bg-white shadow dark:border-white dark:bg-stone-900"
        style={{ left: `${percent}%` }}
      />
    </div>
  );
}
