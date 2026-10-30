import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Aperture, Sparkles, BookOpen, FolderOpen, Wand2, RotateCw, AlertTriangle } from 'lucide-react';
import { Button, Tag } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { Empty } from '../components/ui/Empty';
import { Switch } from '../components/ui/Switch';
import { Modal } from '../components/ui/Modal';
import { ReferenceUploader } from '../components/ReferenceUploader';
import { ImageResults } from '../components/ResultPlayer';
import { useModels, estimateCredits } from '../lib/useModels';
import { useGenerations } from '../lib/generation';
import { ownsGeneration } from '../lib/delete-result';
import { useAuth } from '../lib/auth';
import { assetApi, getActiveOrgId } from '../lib/api';
import { referenceKindVisible } from '../lib/reference-kind';
import { referenceCountMax } from '../lib/reference-limit';
import { displayFrame } from '../lib/display-frame';
import type { Asset } from '../lib/types';
import { appendGenerationPage, type HistoryCursor } from '../lib/history-page';
import { useI18n } from '../lib/i18n';
import { PROMPT_ENTRIES } from '../lib/prompt-library';
import { cn } from '../lib/utils';
import { optimizedPrompt } from '../lib/optimize-prompt';
import { chip } from '../lib/styles';

const ASSET_PAGE_LIMIT = 200;

const RATIOS = [
  { id: '1:1', w: 1024, h: 1024 },
  { id: '3:4', w: 896, h: 1152 },
  { id: '4:3', w: 1152, h: 896 },
  { id: '9:16', w: 768, h: 1344 },
  { id: '16:9', w: 1344, h: 768 },
];

export function ImageStudio() {
  const { generations, loading: generationsLoading, create, remove, retry, cancel, loadMore } = useGenerations();
  const { user, openLogin } = useAuth();
  const { t } = useI18n();

  const [prompt, setPrompt] = useState('');
  const { models, loading: modelsLoading } = useModels('image');
  const [modelId, setModelId] = useState('nano-banana');
  const [ratio, setRatio] = useState('3:4');
  const [count, setCount] = useState(4);
  const [refs, setRefs] = useState<Asset[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [shareWithWorkspace, setShareWithWorkspace] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetCursor, setAssetCursor] = useState<HistoryCursor | null>(null);
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const userId = user?.id ?? 'guest';
  const [seenUserId, setSeenUserId] = useState(userId);
  const assetLoad = useRef(0);
  const loadingEarlierAssetsRef = useRef(false);
  const workspaceVersionRef = useRef(workspaceVersion);
  workspaceVersionRef.current = workspaceVersion;
  if (userId !== seenUserId) {
    setSeenUserId(userId);
    setPrompt('');
    setRefs([]);
    setGenError(null);
    setShareWithWorkspace(false);
    setSubmitting(false);
    setAssets([]);
    setAssetCursor(null);
    assetLoad.current += 1;
    loadingEarlierAssetsRef.current = false;
    workspaceVersionRef.current += 1;
    setWorkspaceVersion(workspaceVersionRef.current);
  }

  const model = models.find((m) => m.id === modelId) ?? models[0];
  const showRefImage = referenceKindVisible(Boolean(user), model?.refs, 'image');
  const canGenerate = prompt.trim().length > 0 && !submitting;
  const activeRatio = RATIOS.find((r) => r.id === ratio)!;

  useEffect(() => {
    if (!model || modelsLoading) return;
    if (!models.some((m) => m.id === modelId)) setModelId(models[0]?.id ?? 'nano-banana');
  }, [models, modelId, modelsLoading, model]);

  useEffect(() => {
    if (!user || showRefImage) return;
    setRefs((current) => (current.length === 0 ? current : []));
  }, [user, showRefImage]);

  useEffect(() => {
    const onWorkspaceChange = () => {
      setGenError(null);
      setSubmitting(false);
      setWorkspaceVersion((version) => {
        const next = version + 1;
        workspaceVersionRef.current = next;
        return next;
      });
    };
    window.addEventListener('benchu:workspace-change', onWorkspaceChange);
    return () => window.removeEventListener('benchu:workspace-change', onWorkspaceChange);
  }, []);

  useEffect(() => {
    if (workspaceVersion === 0) return;
    setRefs((current) => {
      const next = current.filter((item) => item.url.startsWith('blob:') || item.url.startsWith('data:'));
      return next.length === current.length ? current : next;
    });
  }, [workspaceVersion]);

  useEffect(() => {
    if (!assetsOpen || !user) return;
    const workspaceId = getActiveOrgId();
    const loadId = ++assetLoad.current;
    loadingEarlierAssetsRef.current = false;
    setAssets([]);
    setAssetCursor(null);
    assetApi
      .listPage({ kind: 'image', limit: ASSET_PAGE_LIMIT })
      .then((page) => {
        if (loadId !== assetLoad.current || workspaceId !== getActiveOrgId()) return;
        setAssets(page.items);
        setAssetCursor(page.nextCursor);
      })
      .catch(() => {
        if (loadId !== assetLoad.current || workspaceId !== getActiveOrgId()) return;
        setAssets([]);
        setAssetCursor(null);
      });
    return () => {
      assetLoad.current += 1;
    };
  }, [assetsOpen, user, workspaceVersion]);

  const loadEarlierAssets = async () => {
    const cursor = assetCursor;
    if (!cursor || loadingEarlierAssetsRef.current) return;
    loadingEarlierAssetsRef.current = true;
    const loadId = assetLoad.current;
    try {
      const page = await assetApi.listPage({
        kind: 'image',
        limit: ASSET_PAGE_LIMIT,
        before: cursor.createdAt,
        beforeId: cursor.id,
      });
      if (loadId !== assetLoad.current) return;
      setAssets((current) => appendGenerationPage(current, page.items));
      setAssetCursor(page.nextCursor);
    } catch {
      // Keep the images already shown and the current cursor when an earlier page fails.
    } finally {
      if (loadId === assetLoad.current) loadingEarlierAssetsRef.current = false;
    }
  };

  const imageGens = generations.filter((g) => g.type === 'image');
  const counts = { image: imageGens.length };

  const credits = useMemo(() => (model ? estimateCredits(model, 1, count) : 0), [model, count]);

  const reportGenError = (err: unknown, startedVersion: number) => {
    if (workspaceVersionRef.current !== startedVersion) return;
    setGenError(err instanceof Error ? err.message : t('studio_generate_failed'));
  };

  const generate = async () => {
    if (!canGenerate) return;
    if (!user) {
      openLogin();
      return;
    }
    if (!model) return;
    const startedVersion = workspaceVersionRef.current;
    setGenError(null);
    setSubmitting(true);
    try {
      await create({
        type: 'image',
        prompt: prompt.trim(),
        modelId: model.id,
        modelName: model.name,
        resolution: ratio,
        width: activeRatio.w,
        height: activeRatio.h,
        duration: 0,
        count,
        credits,
        refImages: showRefImage ? refs : [],
        refVideos: [],
        refAudios: [],
        visibility: shareWithWorkspace ? 'org' : 'private',
      });
    } catch (err) {
      reportGenError(err, startedVersion);
    } finally {
      if (workspaceVersionRef.current === startedVersion) setSubmitting(false);
    }
  };

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
      <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
        <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t('image_title')}</h1>

        <div className="mt-6 space-y-5">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-base font-semibold">{t('studio_prompt')}</span>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setPrompt(optimizedPrompt(prompt, t('image_optimize_suffix')))}>
                  <Wand2 className="size-3.5" />
                  {t('image_optimize')}
                </Button>
                <Button size="sm" onClick={() => setLibraryOpen(true)}>
                  <BookOpen className="size-3.5" />
                  {t('studio_prompt_library')}
                </Button>
                <Button size="sm" onClick={() => setAssetsOpen(true)}>
                  <FolderOpen className="size-3.5" />
                  {t('studio_my_assets')}
                </Button>
              </div>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('image_prompt_placeholder')}
              aria-label={t('image_prompt_label')}
              className="h-[172px] w-full resize-none rounded-lg border border-stone-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-stone-400 dark:border-stone-800 dark:focus:border-stone-600"
            />
          </div>

          {showRefImage && (
            <ReferenceUploader
              kind="image"
              title={t('studio_ref_image')}
              items={refs}
              onChange={setRefs}
              max={referenceCountMax('image')}
              emptyText={t('studio_ref_image_empty')}
              showClipboard
            />
          )}

          <div className="flex items-center justify-between gap-4 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900/50">
            <div>
              <p className="text-sm font-medium text-stone-800 dark:text-stone-100">{t('studio_share')}</p>
              <p className="mt-1 text-xs leading-4 text-stone-500 dark:text-stone-400">{t('image_share_hint')}</p>
            </div>
            <Switch checked={shareWithWorkspace} onChange={setShareWithWorkspace} ariaLabel={t('image_share_aria')} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="col-span-2 block">
              <span className="mb-2 block text-base font-semibold">{t('studio_model')}</span>
              {modelsLoading ? (
                <div
                  role="status"
                  aria-label={t('image_loading_models')}
                  className="h-10 animate-pulse rounded-lg bg-stone-200 dark:bg-stone-800"
                />
              ) : (
                <Select
                  value={model?.id ?? modelId}
                  onChange={setModelId}
                  options={models.map((m) => ({ value: m.id, label: m.name, hint: m.priceLabel }))}
                />
              )}
            </label>
            <div className="col-span-2 space-y-4">
              <div className="space-y-2.5">
                <div className="text-xs font-medium">{t('image_ratio')}</div>
                <div className="grid grid-cols-5 gap-2">
                  {RATIOS.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => setRatio(r.id)}
                      className={chip(
                        ratio === r.id,
                        'flex h-14 flex-col items-center justify-center gap-1 rounded-lg text-xs',
                      )}
                    >
                      <span
                        className="rounded-[2px] border-2 border-current/70"
                        style={{
                          width: `${Math.round((r.w / r.h) * 14)}px`,
                          height: `${Math.round((r.h / r.w) * 14)}px`,
                        }}
                      />
                      {r.id}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2.5">
                <div className="text-xs font-medium">{t('image_count')}</div>
                <div className="grid grid-cols-3 gap-2.5">
                  {[1, 2, 4].map((n) => (
                    <button key={n} onClick={() => setCount(n)} className={chip(count === n, 'h-9 rounded-full')}>
                      {t('image_sheets', { count: n })}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-auto pt-6">
          <div className="mb-2 flex items-center justify-between px-1 text-xs text-muted-foreground">
            <span>{t('studio_ref_count', { count: showRefImage ? refs.length : 0 })}</span>
            <span>{t('studio_estimated_credits', { credits })}</span>
          </div>
          {genError && <p className="mb-2 px-1 text-xs text-red-400">{genError}</p>}
          <Button
            size="lg"
            disabled={!canGenerate}
            onClick={generate}
            className={cn(
              'h-10 font-normal',
              canGenerate
                ? 'bg-stone-900 text-white hover:bg-stone-800 dark:bg-white dark:text-stone-900 dark:hover:bg-white/90'
                : 'bg-stone-900/[0.08] text-stone-400 dark:bg-white/8 dark:text-white/25',
            )}
          >
            {submitting ? <Sparkles className="size-4 animate-pulse" /> : <Sparkles className="size-4" />}
            {submitting ? t('studio_submitting') : t('studio_generate')}
          </Button>
        </div>
      </div>

      <div className="flex h-[70vh] flex-col overflow-hidden rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:h-full lg:min-h-0">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold">{t('studio_results')}</h2>
          {counts.image > 0 && <Tag>{t('image_groups', { count: counts.image })}</Tag>}
        </div>

        {generationsLoading ? (
          <div role="status" aria-label={t('image_loading_history')} className="space-y-4 animate-pulse">
            <div className="h-64 rounded-lg bg-stone-200 dark:bg-stone-800" />
            <div className="h-24 rounded-lg bg-stone-100 dark:bg-stone-900" />
          </div>
        ) : imageGens.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 dark:border-stone-700">
            <Empty
              icon={<Aperture className="size-6" />}
              description={user ? t('image_empty') : t('image_login_empty')}
            />
          </div>
        ) : (
          <Virtuoso
            data={imageGens}
            className="min-h-0 flex-1"
            endReached={() => void loadMore()}
            itemContent={(_index, gen) => (
              <div className="space-y-2 pb-5">
                <div className="flex items-center justify-between gap-2 text-xs text-stone-500">
                  <span className="min-w-0 truncate">{gen.prompt}</span>
                  <span className="shrink-0">
                    {gen.status === 'failed'
                      ? t('studio_failed')
                      : gen.status === 'done'
                        ? t('image_sheets', { count: gen.count })
                        : `${Math.round(gen.progress)}%`}
                  </span>
                </div>

                {gen.status === 'failed' ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/25 bg-red-500/5 px-4 py-3">
                    <span className="flex items-center gap-2 text-sm text-red-400">
                      <AlertTriangle className="size-4" />
                      {gen.error || t('image_failed_retry')}
                    </span>
                    {ownsGeneration(gen) && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="brand" onClick={() => void retry(gen.id)}>
                          <RotateCw className="size-3.5" /> {t('studio_retry')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => {
                            const startedVersion = workspaceVersionRef.current;
                            setGenError(null);
                            void remove([gen.id]).catch((err: unknown) => reportGenError(err, startedVersion));
                          }}
                        >
                          {t('studio_delete')}
                        </Button>
                      </div>
                    )}
                  </div>
                ) : gen.status === 'done' ? (
                  <ImageResults gen={gen} columns={2} />
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      {Array.from({ length: gen.count }).map((_, i) => {
                        const frame = displayFrame('image', gen.width, gen.height);
                        return (
                          <div
                            key={i}
                            className="relative animate-pulse rounded-xl bg-white/5"
                            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
                          >
                            <span className="absolute inset-0 grid place-items-center text-xs text-white/60">
                              {Math.round(gen.progress)}%
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    {ownsGeneration(gen) && (
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          onClick={() => {
                            const startedVersion = workspaceVersionRef.current;
                            setGenError(null);
                            void cancel(gen.id).catch((err: unknown) => reportGenError(err, startedVersion));
                          }}
                        >
                          {t('result_cancel')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          />
        )}
      </div>

      <Modal open={libraryOpen} onClose={() => setLibraryOpen(false)} title={t('studio_prompt_library')}>
        <ImagePromptLibrary
          onPick={(text) => {
            setPrompt(text);
            setLibraryOpen(false);
          }}
        />
      </Modal>

      <Modal
        open={assetsOpen}
        onClose={() => {
          setAssetCursor(null);
          setAssetsOpen(false);
        }}
        title={t('studio_my_assets')}
      >
        {!user ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('video_assets_login')}</div>
        ) : assets.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('video_assets_empty')}</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              {assets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => {
                    if (!showRefImage) return;
                    setRefs((prev) =>
                      prev.length >= referenceCountMax('image') || prev.some((item) => item.id === asset.id)
                        ? prev
                        : [...prev, asset],
                    );
                    setAssetsOpen(false);
                  }}
                  className="group relative aspect-square overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800"
                >
                  <img src={asset.url} alt={asset.name} className="size-full object-cover" />
                </button>
              ))}
            </div>
            {assetCursor && (
              <div className="mt-4 text-center">
                <Button type="button" size="sm" onClick={() => void loadEarlierAssets()}>
                  {t('admin_audit_hint')}
                </Button>
              </div>
            )}
          </>
        )}
      </Modal>
    </main>
  );
}

function ImagePromptLibrary({ onPick }: { onPick: (prompt: string) => void }) {
  const { locale, t } = useI18n();
  return (
    <div className="space-y-3">
      {PROMPT_ENTRIES.map((entry, index) => {
        const text = entry.text[locale];
        return (
          <button
            key={`${entry.cat}-${index}`}
            type="button"
            onClick={() => onPick(text)}
            className="block w-full rounded-lg border border-stone-200 p-3 text-left transition hover:border-[#9b6bff]/60 dark:border-stone-800"
          >
            <Tag className="mb-1">{t(entry.cat)}</Tag>
            <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">{text}</p>
          </button>
        );
      })}
    </div>
  );
}
