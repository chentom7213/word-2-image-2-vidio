import { useEffect, useRef, useState } from 'react';
import { Building2, Coins, LogIn, LogOut, Menu, Moon, PanelRight, Sun, Sparkles, User, Receipt } from 'lucide-react';
import { useTheme } from '../lib/theme';
import { useAuth } from '../lib/auth';
import { LoginModal } from './LoginModal';
import { AccountModal } from './AccountModal';
import { cn } from '../lib/utils';
import { clearActiveOrgStorage, getActiveOrgId, orgApi, setActiveOrgId, type Organization } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { maskEmail } from '../lib/mask-email';
import { useLocation, useNavigate } from 'react-router-dom';

export function TopBar({
  onOpenMobileNav,
  agentOpen,
  onToggleAgent,
}: {
  onOpenMobileNav: () => void;
  agentOpen: boolean;
  onToggleAgent: () => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const { locale, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, credits, openLogin, logout, refreshUser } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [activeOrgId, setActiveOrgIdState] = useState<string | null>(() => getActiveOrgId());
  const menuRef = useRef<HTMLDivElement>(null);
  const userId = user?.id ?? 'guest';
  const [seenUserId, setSeenUserId] = useState(userId);
  if (userId !== seenUserId) {
    const previousUserId = seenUserId;
    setSeenUserId(userId);
    setOrgs([]);
    if (previousUserId !== 'guest') {
      setActiveOrgIdState(null);
      clearActiveOrgStorage();
    }
  }

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Keep the balance fresh when the user returns to the tab.
  useEffect(() => {
    if (!user) return;
    const onFocus = () => void refreshUser();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [user, refreshUser]);

  useEffect(() => {
    if (!user) {
      setOrgs([]);
      setActiveOrgIdState(null);
      setActiveOrgId(null);
      return;
    }
    let disposed = false;
    void orgApi
      .list()
      .then((items) => {
        if (disposed) return;
        setOrgs(items);
        const stored = getActiveOrgId();
        const next = items.some((org) => org.id === stored) ? stored : (items[0]?.id ?? null);
        setActiveOrgIdState(next);
        if (next !== stored) setActiveOrgId(next);
      })
      .catch(() => {
        if (!disposed) setOrgs([]);
      });
    return () => {
      disposed = true;
    };
  }, [user]);

  return (
    <>
      <header className="sticky top-0 z-20 h-14 shrink-0 border-b border-white/10 bg-black/60 backdrop-blur-xl">
        <div className="flex h-full items-center justify-between gap-3 px-4 sm:px-6">
          <button
            onClick={onOpenMobileNav}
            aria-label={t('nav_open_menu')}
            className="inline-flex size-8 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 md:hidden dark:text-stone-300 dark:hover:text-white"
          >
            <Menu className="size-5" />
          </button>

          <div className="flex h-9 min-w-0 items-center justify-end gap-2 whitespace-nowrap sm:gap-4">
            <label className="hidden items-center sm:inline-flex">
              <span className="sr-only">{t('language')}</span>
              <select
                aria-label={t('language')}
                value={locale}
                onChange={(event) =>
                  navigate(`/${event.target.value}${location.pathname.replace(/^\/(zh|en)(?=\/|$)/, '') || '/video'}`)
                }
                className="h-8 rounded-md border border-stone-700 bg-stone-900 px-2 text-xs text-stone-200 outline-none focus-visible:ring-2 focus-visible:ring-[#7b4aff]"
              >
                <option value="zh">{t('locale_zh')}</option>
                <option value="en">{t('locale_en')}</option>
              </select>
            </label>
            <button
              onClick={onToggleAgent}
              aria-label={agentOpen ? t('agent_panel_close') : t('agent_panel_open')}
              title={agentOpen ? t('agent_panel_close') : t('agent_panel_open')}
              className={cn(
                'grid size-8 place-items-center rounded-full text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white',
                agentOpen && 'bg-white/10 text-white',
              )}
            >
              <PanelRight className="size-[18px]" strokeWidth={1.7} />
            </button>

            <div className="inline-flex shrink-0 items-center gap-2 sm:gap-3">
              {user ? (
                <>
                  {orgs.length > 0 && (
                    <label className="hidden min-w-0 items-center gap-1.5 sm:inline-flex">
                      <Building2 className="size-3.5 shrink-0 text-stone-500 dark:text-stone-400" aria-hidden="true" />
                      <span className="sr-only">{t('workspace_current')}</span>
                      <select
                        value={activeOrgId ?? ''}
                        onChange={(event) => {
                          const next = event.target.value || null;
                          setActiveOrgIdState(next);
                          setActiveOrgId(next);
                        }}
                        aria-label={t('workspace_switch')}
                        className="h-8 max-w-36 rounded-md border border-stone-300 bg-white px-2 text-xs text-stone-700 outline-none transition hover:border-stone-400 focus-visible:ring-2 focus-visible:ring-[#7b4aff] focus-visible:ring-offset-2 active:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:border-stone-600 dark:active:bg-stone-800 dark:focus-visible:ring-offset-stone-950"
                      >
                        {orgs.map((org) => (
                          <option key={org.id} value={org.id}>
                            {org.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    onClick={() => setAccountOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#f5c451]/40 bg-[#241a3a] px-3 py-1.5 text-sm font-semibold text-[#ffd76e] transition hover:opacity-90"
                    title={t('credits_view')}
                    aria-label={`${t('credits_view')} ${credits.toLocaleString()}`}
                  >
                    <Coins className="size-3.5" />
                    {credits.toLocaleString()}
                  </button>
                  <div ref={menuRef} className="relative">
                    <button
                      onClick={() => setMenuOpen((o) => !o)}
                      className="inline-flex items-center gap-1.5 rounded-full brand-gradient px-3 py-1.5 text-sm font-semibold text-white shadow-[0_2px_12px_rgba(123,74,255,0.4)] transition hover:opacity-90"
                    >
                      <User className="size-4" />
                      <span className="max-w-[120px] truncate">{user.displayName || maskEmail(user.email)}</span>
                    </button>
                    {menuOpen && (
                      <div className="absolute right-0 top-full z-20 mt-2 w-56 overflow-hidden rounded-lg border border-stone-700 bg-stone-900 shadow-xl animate-fade-in">
                        <div className="border-b border-stone-800 px-3 py-2">
                          <p className="text-xs text-stone-400">{t('signed_in')}</p>
                          <p className="truncate text-sm text-stone-200">{maskEmail(user.email)}</p>
                        </div>
                        <div className="flex items-center justify-between border-b border-stone-800 px-3 py-2 text-xs">
                          <span className="inline-flex items-center gap-1.5 text-stone-400">
                            <Coins className="size-3.5" /> {t('credits_remaining')}
                          </span>
                          <span className="font-semibold text-[#ffd76e]">{credits.toLocaleString()}</span>
                        </div>
                        <button
                          onClick={() => {
                            setMenuOpen(false);
                            setAccountOpen(true);
                          }}
                          className="flex w-full items-center gap-2 border-b border-stone-800 px-3 py-2 text-left text-sm text-stone-300 transition hover:bg-white/5"
                        >
                          <Receipt className="size-4" />
                          {t('credits_history')}
                        </button>
                        <button
                          onClick={() => {
                            logout();
                            setMenuOpen(false);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-stone-300 transition hover:bg-white/5"
                        >
                          <LogOut className="size-4" />
                          {t('logout')}
                        </button>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <button
                  onClick={openLogin}
                  className="inline-flex items-center gap-1.5 rounded-full brand-gradient px-4 py-1.5 text-sm font-semibold text-white shadow-[0_2px_12px_rgba(123,74,255,0.4)] transition hover:opacity-90"
                >
                  <LogIn className="size-4" />
                  {t('login')}
                </button>
              )}

              <button
                onClick={toggleTheme}
                className="inline-flex size-7 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white"
              >
                {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
                <span className="sr-only">{theme === 'dark' ? t('theme_to_light') : t('theme_to_dark')}</span>
              </button>

              <button
                className="group shrink-0 transition hover:opacity-90"
                title={t('invite_title')}
                aria-label={t('invite_aria')}
              >
                <span className="relative inline-flex h-7 items-center gap-1.5 overflow-hidden rounded-full border border-[#f5c451]/40 bg-gradient-to-r from-[#3a2450] via-[#241a3a] to-[#1a1428] px-2.5 sm:h-9">
                  <span className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(155,107,255,0.45),transparent_60%)]" />
                  <Sparkles className="relative size-3.5 text-[#ffd76e]" />
                  <span className="relative flex flex-col items-start leading-none">
                    <span className="bg-gradient-to-r from-[#ffe7a3] to-[#ffb64d] bg-clip-text text-[13px] font-extrabold text-transparent">
                      {t('invite_title')}
                    </span>
                    <span className="mt-0.5 text-[8px] tracking-wide text-[#ffd98a]/80">{t('invite_hint')}</span>
                  </span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </header>
      <LoginModal />
      <AccountModal open={accountOpen} onClose={() => setAccountOpen(false)} />
    </>
  );
}
