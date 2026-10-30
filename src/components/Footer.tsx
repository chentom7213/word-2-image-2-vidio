import { useI18n } from '../lib/i18n';

export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="hidden flex-shrink-0 border-t border-stone-100 py-2 text-center dark:border-stone-800 md:block">
      <span className="text-xs text-stone-400 dark:text-stone-500">
        <a href="#" className="hover:text-stone-600 dark:hover:text-stone-300">
          {t('footer_terms')}
        </a>{' '}
        ·{' '}
        <a href="#" className="hover:text-stone-600 dark:hover:text-stone-300">
          {t('footer_privacy')}
        </a>{' '}
        ·{' '}
        <a href="#" className="hover:text-stone-600 dark:hover:text-stone-300">
          {t('footer_icp')}
        </a>
      </span>
    </footer>
  );
}
