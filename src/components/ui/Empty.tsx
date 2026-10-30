import { Inbox } from 'lucide-react';
import { cn } from '../../lib/utils';

export function Empty({
  description,
  icon,
  className,
}: {
  description?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 text-center', className)}>
      <div className="grid size-12 place-items-center rounded-full bg-white/5 text-stone-500">
        {icon ?? <Inbox className="size-6" />}
      </div>
      <div className="text-sm text-stone-500">{description}</div>
    </div>
  );
}
