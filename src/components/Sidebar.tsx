import { NavLink } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { NAV_ITEMS } from '../data/nav';
import { cn } from '../lib/utils';
import { useI18n } from '../lib/i18n';

const navKeyByPath: Record<string, Parameters<ReturnType<typeof useI18n>['t']>[0]> = {
  '/canvas': 'nav_canvas',
  '/image': 'nav_image',
  '/video': 'nav_video',
  '/clip': 'nav_clip',
  '/scriptboard': 'nav_scriptboard',
  '/onestep': 'nav_onestep',
  '/douyin': 'nav_douyin',
  '/douyin-parse': 'nav_douyin_parse',
  '/lapan': 'nav_lapan',
  '/director': 'nav_director',
  '/script-ai': 'nav_script_ai',
  '/prompts': 'nav_prompts',
  '/cinematography': 'nav_cinematography',
  '/assets': 'nav_assets',
  '/team': 'nav_team',
  '/billing': 'nav_billing',
  '/admin': 'nav_admin',
  '/overseas-drama': 'nav_overseas_drama',
  '/creator-plan': 'nav_creator_plan',
};

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { pathFor, t } = useI18n();
  return (
    <aside className="hidden w-52 shrink-0 flex-col border-r border-white/10 bg-black/60 backdrop-blur-xl md:flex">
      <NavLink
        to={pathFor('/')}
        onClick={onNavigate}
        className="flex h-14 shrink-0 items-center gap-2 border-b border-white/10 px-4"
      >
        <BrandLogo />
      </NavLink>
      <nav className="hide-scrollbar flex-1 overflow-y-auto px-2 pb-4 pt-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.path}
              to={pathFor(item.path)}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm leading-6 transition',
                  isActive ? 'bg-white/10 font-medium text-white' : 'text-stone-400 hover:bg-white/5 hover:text-white',
                )
              }
            >
              <Icon className="size-[18px] shrink-0" strokeWidth={1.8} />
              <span className="truncate">{t(navKeyByPath[item.path])}</span>
            </NavLink>
          );
        })}
        <a
          href="#"
          className="mt-3 flex items-center gap-2.5 rounded-lg border border-dashed border-white/15 px-3 py-2.5 text-sm leading-6 text-stone-400 transition hover:bg-white/5 hover:text-white"
        >
          <ArrowUpRight className="size-[18px] shrink-0" strokeWidth={1.8} />
          <span className="truncate">{t('academy')}</span>
        </a>
      </nav>
    </aside>
  );
}
