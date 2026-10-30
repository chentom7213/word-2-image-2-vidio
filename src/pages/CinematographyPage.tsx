import { CINE_SECTIONS } from '../lib/cinematography-library';
import { useI18n } from '../lib/i18n';
import { seedGradient } from '../lib/utils';

export function CinematographyPage() {
  const { locale, t } = useI18n();
  return (
    <main className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-8">
        <div>
          <h1 className="text-2xl font-semibold">{t('cine_title')}</h1>
          <p className="mt-1 text-sm text-stone-500">{t('cine_subtitle')}</p>
        </div>
        {CINE_SECTIONS.map((sec) => (
          <section key={sec.title}>
            <h2 className="mb-3 text-lg font-semibold">{t(sec.title)}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {sec.items.map((it) => (
                <div
                  key={it.name}
                  className="overflow-hidden rounded-xl border border-stone-200 bg-card dark:border-stone-800"
                >
                  <div
                    className="relative grid h-24 place-items-center"
                    style={{ background: seedGradient(t(sec.title) + t(it.name)) }}
                  >
                    <span className="absolute right-1.5 top-1.5 rounded bg-black/40 px-1 py-0.5 text-[10px] text-white">
                      {it.ratio}
                    </span>
                    <span className="text-lg font-semibold text-white drop-shadow">{t(it.name)}</span>
                  </div>
                  <p className="p-2 text-center text-xs text-stone-500">{it.desc[locale]}</p>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
