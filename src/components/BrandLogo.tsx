import { Sparkles } from 'lucide-react';
import { cn } from '../lib/utils';

export function BrandLogo({ collapsed = false, className }: { collapsed?: boolean; className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg brand-gradient shadow-[0_2px_10px_rgba(123,74,255,0.5)]">
        <Sparkles className="size-4 text-white" />
      </span>
      {!collapsed && <span className="text-lg font-bold tracking-tight text-gradient">星绘AI</span>}
    </span>
  );
}
