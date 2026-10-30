import { useState } from 'react';
import { Search, Copy, Check } from 'lucide-react';
import { Tag } from '../components/ui/Button';
import { PROMPT_CATEGORIES, PROMPT_ENTRIES, type PromptCategory } from '../lib/prompt-library';
import { useI18n } from '../lib/i18n';
import { seedGradient } from '../lib/utils';

export function PromptsPage() {
  const { locale, t } = useI18n();
  const [cat, setCat] = useState<PromptCategory>('prompts_cat_all');
  const [q, setQ] = useState('');
  const [copied, setCopied] = useState<number | null>(null);

  const list = PROMPT_ENTRIES.filter((p) => {
    const text = p.text[locale];
    return (cat === 'prompts_cat_all' || p.cat === cat) && text.includes(q);
  });

  const copy = (i: number, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(i);
    setTimeout(() => setCopied(null), 1200);
  };

  return (
    <main className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{t('prompts_title')}</h1>
            <p className="mt-1 text-sm text-stone-500">{t('prompts_subtitle')}</p>
          </div>
          <div className="flex h-9 w-64 items-center gap-2 rounded-lg border border-stone-300 px-3 dark:border-stone-700">
            <Search className="size-4 text-stone-500" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('prompts_search')}
              aria-label={t('prompts_search')}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </div>
        </div>

        <div className="mb-5 flex flex-wrap gap-2">
          {PROMPT_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className={`rounded-full border px-3 py-1 text-sm transition ${
                cat === c
                  ? 'border-[#9b6bff] bg-[#9b6bff]/15 text-[#b79bff]'
                  : 'border-stone-300 text-stone-500 dark:border-stone-700'
              }`}
            >
              {t(c)}
            </button>
          ))}
        </div>

        {list.length === 0 ? (
          <p className="py-16 text-center text-sm text-stone-500">{t('prompts_empty')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((p, i) => {
              const text = p.text[locale];
              return (
                <div
                  key={p.text.zh}
                  className="group overflow-hidden rounded-xl border border-stone-200 bg-card dark:border-stone-800"
                >
                  <div className="h-28" style={{ background: seedGradient(p.text.zh + t(p.cat)) }} />
                  <div className="p-3">
                    <Tag className="mb-2">{t(p.cat)}</Tag>
                    <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">{text}</p>
                    <button
                      type="button"
                      onClick={() => copy(i, text)}
                      className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[#9b6bff]"
                    >
                      {copied === i ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      {copied === i ? t('prompts_copied') : t('prompts_copy')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
