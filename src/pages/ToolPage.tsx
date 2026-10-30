import { useRef, useState } from 'react';
import { Sparkles, Wand2, Upload } from 'lucide-react';
import { Button, Tag } from '../components/ui/Button';
import { GenerativeCanvas } from '../components/ResultPlayer';
import { seedGradient } from '../lib/utils';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { TOOL_ACTION_KEY, TOOL_TITLE_KEY, type ToolConfig, type ToolPath } from '../data/tools';
import { TOOL_LONG_EN } from '../data/tools.en';

export function ToolPage({ config }: { config: ToolConfig }) {
  const { locale, t } = useI18n();
  const { user } = useAuth();
  const path = config.path as ToolPath;
  const title = t(TOOL_TITLE_KEY[path]);
  const action = t(TOOL_ACTION_KEY[path]);
  const long = locale === 'en' ? TOOL_LONG_EN[path] : null;
  const subtitle = long?.subtitle ?? config.subtitle;
  const placeholder = long?.placeholder ?? config.placeholder;
  const tips = long?.tips ?? config.tips;
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const userId = user?.id ?? 'guest';
  const [seenUserId, setSeenUserId] = useState(userId);
  const requestEpoch = useRef(0);

  if (userId !== seenUserId) {
    setSeenUserId(userId);
    setValue('');
    setResults([]);
    setLoading(false);
    // eslint-disable-next-line react-hooks/refs
    requestEpoch.current += 1;
  }

  const run = () => {
    if (!value.trim() && config.inputType !== 'file') return;
    const requestId = ++requestEpoch.current;
    setLoading(true);
    setResults([]);
    setTimeout(() => {
      if (requestEpoch.current !== requestId) return;
      setResults([`${title}-${Date.now()}-1`, `${title}-${Date.now()}-2`, `${title}-${Date.now()}-3`]);
      setLoading(false);
    }, 1500);
  };

  return (
    <main className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-stone-500">{subtitle}</p>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800">
            <div className="mb-2 flex flex-wrap gap-2">
              {tips?.map((tip) => (
                <Tag key={tip}>{tip}</Tag>
              ))}
            </div>
            {config.inputType === 'file' ? (
              <label className="flex h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 text-sm text-stone-500 dark:border-stone-700">
                <Upload className="size-6" />
                {t('tool_upload')}
                <input type="file" hidden aria-label={t('tool_upload')} />
              </label>
            ) : (
              <textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={placeholder}
                aria-label={placeholder}
                className="h-40 w-full resize-none rounded-lg border border-stone-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-stone-400 dark:border-stone-800 dark:focus:border-stone-600"
              />
            )}
            <Button
              variant="brand"
              size="lg"
              className="mt-4"
              disabled={loading || (!value.trim() && config.inputType !== 'file')}
              onClick={run}
            >
              {loading ? <Sparkles className="size-4 animate-pulse" /> : <Wand2 className="size-4" />}
              {loading ? t('tool_processing') : action}
            </Button>
          </div>

          <div className="rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800">
            <h2 className="mb-3 text-lg font-semibold">{t('tool_results')}</h2>
            {loading ? (
              <div className="grid grid-cols-2 gap-3">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="aspect-video animate-pulse rounded-lg bg-white/5" />
                ))}
              </div>
            ) : results.length === 0 ? (
              <div className="flex min-h-[240px] items-center justify-center rounded-lg border border-dashed border-stone-300 text-sm text-stone-500 dark:border-stone-700">
                {t('tool_empty', { action })}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {results.map((r, i) => (
                  <div key={r} className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
                    <div className="aspect-video">
                      <GenerativeCanvas seed={r} width={16} height={9} playing={i === 0} />
                    </div>
                    <div className="p-2 text-[11px] text-stone-500">
                      {t('tool_result_item', { title, index: i + 1 })}
                    </div>
                  </div>
                ))}
                <div className="col-span-2 h-2 rounded-full" style={{ background: seedGradient(value || 'x') }} />
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
