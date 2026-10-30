import { useState, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { Footer } from './Footer';
import { AgentPanel } from './AgentPanel';
import { SupportFab } from './SupportFab';
import { useI18n } from '../lib/i18n';

function MobileNavDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] md:hidden">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative h-full w-60 animate-fade-in">
        <Sidebar onNavigate={onClose} />
        <button
          onClick={onClose}
          aria-label={t('nav_close')}
          className="absolute right-3 top-4 grid size-8 place-items-center rounded-md text-white/70 hover:bg-white/10"
        >
          <X className="size-5" />
        </button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children?: ReactNode }) {
  const [mobileNav, setMobileNav] = useState(false);
  const [agentOpen, setAgentOpen] = useState(true);
  const location = useLocation();

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <Sidebar />
      <MobileNavDrawer open={mobileNav} onClose={() => setMobileNav(false)} />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          onOpenMobileNav={() => setMobileNav(true)}
          agentOpen={agentOpen}
          onToggleAgent={() => setAgentOpen((o) => !o)}
        />
        <div className="min-h-0 flex-1 overflow-hidden">
          <div
            key={location.pathname}
            className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 animate-fade-in dark:bg-stone-950 dark:text-stone-100"
          >
            {children ?? <Outlet />}
          </div>
        </div>
        <Footer />
      </div>

      <div className="relative z-[70] hidden h-full shrink-0 md:flex">
        {agentOpen && <AgentPanel onClose={() => setAgentOpen(false)} />}
      </div>

      <SupportFab />
    </div>
  );
}
