import { Headphones } from 'lucide-react';

export function SupportFab() {
  return (
    <button className="fixed bottom-6 right-6 z-[60] inline-flex h-11 items-center gap-2 rounded-full brand-gradient px-4 text-sm font-medium text-white shadow-[0_6px_20px_rgba(123,74,255,0.45)] transition hover:scale-105 hover:opacity-95">
      <Headphones className="size-[18px]" />
      客服
    </button>
  );
}
