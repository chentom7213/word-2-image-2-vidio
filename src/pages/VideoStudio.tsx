import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Virtuoso } from 'react-virtuoso';
import {
  Clapperboard,
  Sparkles,
  BookOpen,
  FolderOpen,
  History,
  SlidersHorizontal,
  Plus,
  CheckSquare,
  Trash2,
  Settings2,
  Wand2,
} from 'lucide-react';
import { Button, Tag } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { Slider } from '../components/ui/Slider';
import { Switch } from '../components/ui/Switch';
import { Empty } from '../components/ui/Empty';
import { Modal } from '../components/ui/Modal';
import { ReferenceUploader } from '../components/ReferenceUploader';
import {
  ResultPlayer,
  ProgressOverlay,
  FailedResult,
  SeedPoster,
  captureFrameFromUrl,
} from '../components/ResultPlayer';
import { useGenerations } from '../lib/generation';
import { ownsGeneration } from '../lib/delete-result';
import { useAuth } from '../lib/auth';
import { assetApi, billingApi, getActiveOrgId } from '../lib/api';
import { type HistoryCursor } from '../lib/history-page';
import { sliderDurationMax } from '../lib/plan-duration';
import { referenceKindVisible } from '../lib/reference-kind';
import { referenceCountMax } from '../lib/reference-limit';
import { appendReferenceAssets } from '../lib/reference-append';
import { referenceStill } from '../lib/reference-still';
import { useModels, estimateCredits } from '../lib/useModels';
import { RESOLUTIONS, ASPECT_PRESETS } from '../data/models';
import type { Asset, Generation } from '../lib/types';
import { useI18n, type MessageKey } from '../lib/i18n';
import { cn } from '../lib/utils';
import { chip, field } from '../lib/styles';
import { optimizedPrompt } from '../lib/optimize-prompt';
import { promptWithSkill } from '../lib/prompt-skill';
import { frameSize } from '../lib/frame-size';
import { videoParamSizeSummary } from '../lib/video-param-summary';

const ASPECT_LABEL = {
  landscape: 'video_aspect_landscape',
  portrait: 'video_aspect_portrait',
  square: 'video_aspect_square',
  wide: 'video_aspect_wide',
  tall: 'video_aspect_tall',
} as const satisfies Record<(typeof ASPECT_PRESETS)[number]['id'], MessageKey>;

const RESOLUTION_SHORT_SIDE: Record<string, number> = {
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
};

function aspectForFrame(aspect: string | null, width: number, height: number) {
  const preset = aspect ? ASPECT_PRESETS.find((item) => item.id === aspect) : undefined;
  if (preset) return { aspectWidth: preset.w, aspectHeight: preset.h };
  if (width > 0 && height > 0) return { aspectWidth: width, aspectHeight: height };
  return { aspectWidth: 1280, aspectHeight: 720 };
}

const IMAGE_ASSET_PAGE_LIMIT = 200;

const MODEL_ICON = () => (
  <span className="grid size-5 shrink-0 place-items-center rounded bg-brand-gradient text-[10px] font-bold text-white">
    <Sparkles className="size-3" />
  </span>
);

/** Prefer a stored thumbnail, then the poster, then the first still. */
function thumbFor(g: { posterUrl: string | null; outputs: { kind: string; url: string }[]; status: string }) {
  if (g.status !== 'done') return g.posterUrl ?? null;
  const thumbnail = g.outputs.find((o) => o.kind === 'thumbnail');
  if (thumbnail) return thumbnail.url;
  const poster = g.outputs.find((o) => o.kind === 'poster');
  if (poster) return poster.url;
  const image = g.outputs.find((o) => o.kind === 'image');
  return image?.url ?? g.posterUrl ?? null;
}

function GenerationHistoryRow({
  gen,
  active,
  checked = false,
  onSelect,
  onToggle,
  compact = false,
}: {
  gen: Generation;
  active: boolean;
  checked?: boolean;
  onSelect: () => void;
  onToggle?: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        'group relative rounded-lg border transition',
        active
          ? 'border-[#9b6bff]/70 bg-[#9b6bff]/10'
          : 'border-stone-200 hover:border-stone-300 dark:border-stone-800 dark:hover:border-stone-700',
      )}
    >
      <button
        onClick={onSelect}
        className="flex w-full items-start gap-2.5 rounded-lg p-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9b6bff]"
      >
        <span className="relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-md">
          <SeedPoster seed={gen.seed} className="absolute inset-0" />
          {thumbFor(gen) && (
            <img src={thumbFor(gen)!} alt="" className="absolute inset-0 size-full object-cover" loading="lazy" />
          )}
          {gen.status === 'failed' ? (
            <span className="absolute inset-0 grid place-items-center bg-red-600/60 text-[10px] font-semibold text-white">
              {t('studio_failed')}
            </span>
          ) : gen.status !== 'done' ? (
            <span className="absolute inset-0 grid place-items-center bg-black/40 text-[10px] font-semibold text-white">
              {Math.round(gen.progress)}%
            </span>
          ) : (
            <span className="absolute inset-0 grid place-items-center bg-black/25">
              <Clapperboard className="size-3.5 text-white/90" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-xs leading-5 text-stone-700 dark:text-stone-200">{gen.prompt}</span>
          <span className="mt-1 flex items-center gap-1 text-[10px] text-stone-500">
            <Clapperboard className="size-2.5" /> {gen.modelName} · {gen.duration}s
          </span>
        </span>
      </button>
      {!compact && onToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={checked}
          aria-label={t(checked ? 'video_deselect_record' : 'video_select_record', { prompt: gen.prompt })}
          className={cn(
            'absolute left-2 top-2 z-10 grid size-4 place-items-center rounded border text-[10px] transition',
            checked
              ? 'border-[#9b6bff] bg-[#9b6bff] text-white'
              : 'border-white/40 bg-black/40 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          {checked && '✓'}
        </button>
      )}
    </div>
  );
}

export function VideoStudio() {
  const {
    generations,
    loading: generationsLoading,
    selectedId,
    select,
    create,
    remove,
    clear,
    retry,
    loadMore,
  } = useGenerations();
  const { user, openLogin } = useAuth();
  const subscriptionQuery = useQuery({
    queryKey: ['billing', 'subscription', user?.id ?? 'guest'],
    queryFn: billingApi.subscription,
    enabled: Boolean(user),
  });
  const { locale, t } = useI18n();
  const { models, loading: modelsLoading } = useModels('video');
  const dateLocale = locale === 'zh' ? 'zh-CN' : 'en';

  const [prompt, setPrompt] = useState('');
  const [skill, setSkill] = useState('none');
  const [refImages, setRefImages] = useState<Asset[]>([]);
  const [refVideos, setRefVideos] = useState<Asset[]>([]);
  const [refAudios, setRefAudios] = useState<Asset[]>([]);
  const [genError, setGenError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetCursor, setAssetCursor] = useState<HistoryCursor | null>(null);
  const assetCursorRef = useRef<HistoryCursor | null>(null);
  const assetRequestRef = useRef(0);
  const loadingEarlierAssetsRef = useRef(false);
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const appliedWorkspaceVersion = useRef(workspaceVersion);
  const workspaceVersionRef = useRef(workspaceVersion);
  workspaceVersionRef.current = workspaceVersion;
  const workspaceId = getActiveOrgId();

  const [modelId, setModelId] = useState('seedance-2');
  const [resolution, setResolution] = useState('720p');
  const [customRes, setCustomRes] = useState('');
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(720);
  const [aspect, setAspect] = useState<string | null>('landscape');
  const [duration, setDuration] = useState(6);
  const resolutionLabel = customRes ? `${customRes}p` : resolution;
  const aspectKey =
    aspect && ASPECT_LABEL[aspect as keyof typeof ASPECT_LABEL]
      ? ASPECT_LABEL[aspect as keyof typeof ASPECT_LABEL]
      : null;
  const sizeSummary = videoParamSizeSummary(aspectKey, width, height);
  const narrowSizeLabel = aspectKey ? t(aspectKey) : (sizeSummary ?? t('studio_adaptive'));
  const customFrame = useRef<{ aspectWidth: number; aspectHeight: number } | null>(null);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [shareWithWorkspace, setShareWithWorkspace] = useState(false);
  const [seenUserId, setSeenUserId] = useState(user?.id || 'guest');
  const userId = user?.id || 'guest';
  // Drop the previous account's draft only after the signed-in user actually changes.
  if (userId !== seenUserId) {
    setSeenUserId(userId);
    setPrompt('');
    setRefImages([]);
    setRefVideos([]);
    setRefAudios([]);
    setGenError(null);
    setShareWithWorkspace(false);
    setSelection([]);
    setSubmitting(false);
    setAssets([]);
    setAssetCursor(null);
    assetCursorRef.current = null;
    assetRequestRef.current += 1;
    loadingEarlierAssetsRef.current = false;
    const nextVersion = workspaceVersionRef.current + 1;
    workspaceVersionRef.current = nextVersion;
    setWorkspaceVersion(nextVersion);
  }

  const model = models.find((m) => m.id === modelId) ?? models[0];
  const showRefImage = referenceKindVisible(Boolean(user), model?.refs, 'image');
  const showRefVideo = referenceKindVisible(Boolean(user), model?.refs, 'video');
  const showRefAudio = referenceKindVisible(Boolean(user), model?.refs, 'audio');
  const loggedIn = Boolean(user);
  const planKnown = loggedIn && subscriptionQuery.data != null;
  const pendingCeiling = useRef<number | null>(null);
  if (!loggedIn || planKnown) pendingCeiling.current = null;
  else if (pendingCeiling.current == null) pendingCeiling.current = duration;
  const durationMax = sliderDurationMax({
    loggedIn,
    planKnown,
    modelMax: model?.maxDuration,
    planMax: subscriptionQuery.data?.plan.maxDuration,
    currentDuration: pendingCeiling.current ?? duration,
  });
  const videoGens = generations.filter((g) => g.type === 'video');
  const selected = videoGens.find((g) => g.id === selectedId) ?? null;
  const canGenerate =
    prompt.trim().length > 0 && !submitting && (!loggedIn || (planKnown && duration <= durationMax));

  // Keep the chosen model valid once the server catalogue arrives.
  useEffect(() => {
    if (!model || modelsLoading) return;
    if (!models.some((m) => m.id === modelId)) setModelId(models[0]?.id ?? 'seedance-2');
  }, [models, modelId, modelsLoading, model]);

  // Guests can still be clamped to the public cap. Signed-in users wait until the plan arrives,
  // so a 6s choice is not permanently shrunk while the subscription request is pending or failed.
  useEffect(() => {
    if (loggedIn && !planKnown) return;
    if (duration > durationMax) setDuration(durationMax);
  }, [duration, durationMax, loggedIn, planKnown]);

  // Drop references the signed-in model cannot accept, so submit does not send them.
  useEffect(() => {
    if (!user) return;
    if (!showRefImage) setRefImages((current) => (current.length === 0 ? current : []));
    if (!showRefVideo) setRefVideos((current) => (current.length === 0 ? current : []));
    if (!showRefAudio) setRefAudios((current) => (current.length === 0 ? current : []));
  }, [user, showRefImage, showRefVideo, showRefAudio]);

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

  // Drop references that belong to the previous workspace. Unsaved local previews stay.
  useEffect(() => {
    if (appliedWorkspaceVersion.current === workspaceVersion) return;
    appliedWorkspaceVersion.current = workspaceVersion;
    const keepLocalPreview = (items: Asset[]) => {
      const next = items.filter((item) => item.url.startsWith('blob:') || item.url.startsWith('data:'));
      return next.length === items.length ? items : next;
    };
    setRefImages(keepLocalPreview);
    setRefVideos(keepLocalPreview);
    setRefAudios(keepLocalPreview);
  }, [workspaceVersion]);

  // Load one page of image assets when the dialog opens or the workspace changes.
  useEffect(() => {
    if (!assetsOpen || !user) return;
    const requestId = ++assetRequestRef.current;
    let cancelled = false;
    loadingEarlierAssetsRef.current = false;
    setAssets([]);
    assetCursorRef.current = null;
    setAssetCursor(null);
    assetApi
      .listPage({ kind: 'image', limit: IMAGE_ASSET_PAGE_LIMIT })
      .then((page) => {
        if (cancelled || requestId !== assetRequestRef.current) return;
        setAssets(page.items);
        assetCursorRef.current = page.nextCursor;
        setAssetCursor(page.nextCursor);
      })
      .catch(() => {
        if (cancelled || requestId !== assetRequestRef.current) return;
        setAssets([]);
        assetCursorRef.current = null;
        setAssetCursor(null);
      });
    return () => {
      cancelled = true;
      assetRequestRef.current += 1;
    };
  }, [assetsOpen, user, workspaceId, workspaceVersion]);

  const loadEarlierAssets = async () => {
    const cursor = assetCursorRef.current;
    if (!cursor || loadingEarlierAssetsRef.current) return;
    loadingEarlierAssetsRef.current = true;
    const requestId = assetRequestRef.current;
    try {
      const page = await assetApi.listPage({
        kind: 'image',
        limit: IMAGE_ASSET_PAGE_LIMIT,
        before: cursor.createdAt,
        beforeId: cursor.id,
      });
      if (requestId !== assetRequestRef.current) return;
      setAssets((current) => {
        const seen = new Set(current.map((item) => item.id));
        const added: Asset[] = [];
        for (const item of page.items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          added.push(item);
        }
        return added.length === 0 ? current : [...current, ...added];
      });
      assetCursorRef.current = page.nextCursor;
      setAssetCursor(page.nextCursor);
    } catch {
      // Keep the images already shown when a later page fails.
    } finally {
      if (requestId === assetRequestRef.current) loadingEarlierAssetsRef.current = false;
    }
  };

  const credits = useMemo(() => (model ? estimateCredits(model, duration, 1) : 0), [model, duration]);

  const applyAspect = (id: string, w: number, h: number) => {
    setAspect(id);
    setWidth(w);
    setHeight(h);
  };

  const setSize = (w: number, h: number) => {
    setWidth(w);
    setHeight(h);
    const match = ASPECT_PRESETS.find((p) => p.w === w && p.h === h);
    setAspect(match ? match.id : null);
  };

  const applyShortSide = (shortSide: number) => {
    const { aspectWidth, aspectHeight } = aspectForFrame(aspect, width, height);
    const sized = frameSize(aspectWidth, aspectHeight, shortSide);
    if (sized === null) return;
    setWidth(sized.width);
    setHeight(sized.height);
  };

  const chooseResolution = (value: string) => {
    customFrame.current = null;
    setResolution(value);
    setCustomRes('');
    const shortSide = RESOLUTION_SHORT_SIDE[value];
    if (shortSide) applyShortSide(shortSide);
  };

  const changeCustomResolution = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 4);
    const clearing = customRes !== '' && digits === '';
    if (customRes === '' && digits !== '') customFrame.current = aspectForFrame(aspect, width, height);
    setCustomRes(digits);
    if (clearing) {
      customFrame.current = null;
      const shortSide = RESOLUTION_SHORT_SIDE[resolution];
      if (shortSide) applyShortSide(shortSide);
      return;
    }
    if (!digits) return;
    const shortSide = Number(digits);
    const base = customFrame.current ?? aspectForFrame(aspect, width, height);
    const sized = frameSize(base.aspectWidth, base.aspectHeight, shortSide);
    if (sized) {
      setWidth(sized.width);
      setHeight(sized.height);
    }
  };

  const generate = async () => {
    if (!canGenerate || !model) return;
    if (!user) {
      openLogin();
      return;
    }
    const startedVersion = workspaceVersionRef.current;
    setGenError(null);
    setSubmitting(true);
    try {
      await create({
        type: 'video',
        prompt: promptWithSkill(prompt, skill, locale),
        modelId,
        modelName: model.name,
        resolution: resolutionLabel,
        width,
        height,
        duration,
        credits,
        refImages: showRefImage ? refImages : [],
        refVideos: showRefVideo ? refVideos : [],
        refAudios: showRefAudio ? refAudios : [],
        visibility: shareWithWorkspace ? 'org' : 'private',
      });
    } catch (err) {
      if (workspaceVersionRef.current === startedVersion) {
        setGenError(err instanceof Error ? err.message : t('studio_generate_failed'));
      }
    } finally {
      if (workspaceVersionRef.current === startedVersion) setSubmitting(false);
    }
  };

  /** Download the generated artifact, upload it as an asset, then attach as a reference. */
  const importResultAsRef = async (gen: (typeof generations)[number]) => {
    if (!user) {
      openLogin();
      return;
    }
    if (!showRefImage || refImages.length >= referenceCountMax('image')) return;
    const startedVersion = workspaceVersionRef.current;
    const startedOrgId = getActiveOrgId() || 'personal';
    const still = referenceStill(gen);
    if (!still) {
      if (workspaceVersionRef.current === startedVersion) setGenError(t('video_no_output'));
      return;
    }
    try {
      const file = await captureFrameFromUrl(still.url, `${gen.modelName}-${gen.id}.png`, still.mime);
      if (!file) {
        if (workspaceVersionRef.current === startedVersion) setGenError(t('video_download_output_failed'));
        return;
      }
      const asset = await assetApi.upload(file);
      if (workspaceVersionRef.current !== startedVersion || (getActiveOrgId() || 'personal') !== startedOrgId) return;
      setRefImages((prev) => appendReferenceAssets(prev, [asset], referenceCountMax('image')));
    } catch (err) {
      if (workspaceVersionRef.current !== startedVersion) return;
      setGenError(err instanceof Error ? err.message : t('video_use_ref_failed'));
    }
  };

  const resetForm = () => {
    setPrompt('');
    setRefImages([]);
    setRefVideos([]);
    setRefAudios([]);
    select(null);
  };

  const toggleSelect = (id: string) => setSelection((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const reportGenError = (startedVersion: number) => (err: unknown) => {
    if (workspaceVersionRef.current !== startedVersion) return;
    setGenError(err instanceof Error ? err.message : t('studio_generate_failed'));
  };

  const modelOptions = models.map((m) => ({
    value: m.id,
    label: m.name,
    hint: m.priceLabel,
    icon: MODEL_ICON(),
  }));

  const durationPlanNotice =
    loggedIn && subscriptionQuery.isError && subscriptionQuery.data == null ? (
      <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-red-400">
        <span>{t('billing_load_failed')}</span>
        <button
          type="button"
          onClick={() => void subscriptionQuery.refetch()}
          className="font-medium underline underline-offset-2"
        >
          {t('studio_retry')}
        </button>
      </div>
    ) : null;

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
      {/* 生成记录 */}
      <aside className="hidden min-h-0 flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:flex">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{t('studio_history')}</h2>
          <Tag>{videoGens.length}</Tag>
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={resetForm}>
            <Plus className="size-3.5" />
            {t('studio_new')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const ownIds = videoGens.filter((gen) => ownsGeneration(gen)).map((gen) => gen.id);
              setSelection((current) =>
                ownIds.length > 0 && ownIds.every((id) => current.includes(id)) ? [] : ownIds,
              );
            }}
          >
            <CheckSquare className="size-3.5" />
            {t('studio_select_all')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={selection.length === 0}
            onClick={() => {
              const startedVersion = workspaceVersionRef.current;
              setGenError(null);
              void remove(selection).catch(reportGenError(startedVersion));
              setSelection([]);
            }}
          >
            <Trash2 className="size-3.5" />
            {t('studio_delete')}
          </Button>
        </div>

        {generationsLoading ? (
          <div role="status" aria-label={t('video_loading_history')} className="space-y-3 animate-pulse">
            <div className="h-20 rounded-lg bg-stone-200 dark:bg-stone-800" />
            <div className="h-20 rounded-lg bg-stone-100 dark:bg-stone-900" />
            <div className="h-20 rounded-lg bg-stone-100 dark:bg-stone-900" />
          </div>
        ) : videoGens.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">
            {t('studio_empty_history')}
          </div>
        ) : (
          <Virtuoso
            data={videoGens}
            className="min-h-0 flex-1"
            endReached={() => void loadMore()}
            itemContent={(_index, gen) => (
              <div className="pb-2.5">
                <GenerationHistoryRow
                  gen={gen}
                  active={gen.id === selectedId}
                  checked={ownsGeneration(gen) && selection.includes(gen.id)}
                  onSelect={() => select(gen.id)}
                  onToggle={ownsGeneration(gen) ? () => toggleSelect(gen.id) : undefined}
                />
              </div>
            )}
          />
        )}
        {videoGens.length > 0 && (
          <button
            onClick={() => {
              if (!confirm(t('video_confirm_clear'))) return;
              const startedVersion = workspaceVersionRef.current;
              setGenError(null);
              void clear().catch(reportGenError(startedVersion));
            }}
            className="mt-4 w-full text-center text-xs text-stone-500 hover:text-red-400"
          >
            {t('video_clear_all')}
          </button>
        )}
      </aside>

      {/* 工作区 */}
      <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
        {/* 参数表单 */}
        <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t('video_title')}</h1>
            <div className="flex shrink-0 gap-2 lg:hidden">
              <Button size="sm" onClick={() => setRecordsOpen(true)}>
                <History className="size-3.5" />
                {t('video_records')}
              </Button>
              <Button size="sm" onClick={() => setParamsOpen(true)}>
                <SlidersHorizontal className="size-3.5" />
                {t('video_params')}
              </Button>
            </div>
          </div>

          <div className="mt-6 space-y-5">
            {/* 提示词 */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-base font-semibold">{t('studio_prompt')}</span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setPrompt(optimizedPrompt(prompt, t('video_optimize_suffix')));
                    }}
                  >
                    <Wand2 className="size-3.5" />
                    {t('video_optimize')}
                  </Button>
                  <Button size="sm" onClick={() => setLibraryOpen(true)}>
                    <BookOpen className="size-3.5" />
                    {t('video_view_library')}
                  </Button>
                  <Button size="sm" onClick={() => setAssetsOpen(true)}>
                    <FolderOpen className="size-3.5" />
                    {t('video_view_assets')}
                  </Button>
                </div>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t('video_prompt_placeholder')}
                aria-label={t('video_prompt_label')}
                className="h-[172px] w-full resize-none rounded-lg border border-stone-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-stone-400 dark:border-stone-800 dark:focus:border-stone-600"
              />
              <div className="mt-2">
                <Select
                  size="sm"
                  value={skill === 'none' ? null : skill}
                  onChange={(v) => setSkill(v)}
                  placeholder={t('video_skill_placeholder')}
                  options={[
                    { value: 'cinematic', label: t('video_style_cinematic') },
                    { value: 'anime', label: t('video_style_anime') },
                    { value: 'product', label: t('video_style_product') },
                    { value: 'vlog', label: t('video_style_vlog') },
                    { value: 'retro', label: t('video_style_retro') },
                  ]}
                />
              </div>
            </div>

            {/* 参考图 */}
            {showRefImage && (
              <ReferenceUploader
                kind="image"
                title={t('studio_ref_image')}
                items={refImages}
                onChange={setRefImages}
                max={referenceCountMax('image')}
                emptyText={t('studio_ref_image_empty')}
                showClipboard
              />
            )}
            {/* 参考视频 */}
            {showRefVideo && (
              <ReferenceUploader
                kind="video"
                title={t('studio_ref_video')}
                items={refVideos}
                onChange={setRefVideos}
                max={referenceCountMax('video')}
                emptyText={t('studio_ref_video_empty')}
              />
            )}
            {/* 参考音频 */}
            {showRefAudio && (
              <ReferenceUploader
                kind="audio"
                title={t('studio_ref_audio')}
                items={refAudios}
                onChange={setRefAudios}
                max={referenceCountMax('audio')}
                emptyText={t('studio_ref_audio_empty')}
              />
            )}

            <div className="flex items-center justify-between gap-4 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900/50">
              <div>
                <p className="text-sm font-medium text-stone-800 dark:text-stone-100">{t('studio_share')}</p>
                <p className="mt-1 text-xs leading-4 text-stone-500 dark:text-stone-400">{t('video_share_hint')}</p>
              </div>
              <Switch
                checked={shareWithWorkspace}
                onChange={setShareWithWorkspace}
                ariaLabel={t('video_share_aria')}
              />
            </div>

            {/* 移动端参数摘要 */}
            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
              <span className="truncate text-stone-500 dark:text-stone-400">
                {[
                  model.name,
                  resolutionLabel,
                  narrowSizeLabel,
                  `${duration} s`,
                ]
                  .filter((part) => part !== '')
                  .join(' · ')}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setParamsOpen(true)}>
                <Settings2 className="size-3.5" />
                {t('video_adjust')}
              </Button>
            </div>

            {/* 桌面端参数 */}
            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
              <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t('studio_model')}</span>
                {modelsLoading ? (
                  <div
                    role="status"
                    aria-label={t('video_loading_models')}
                    className="h-10 animate-pulse rounded-lg bg-stone-200 dark:bg-stone-800"
                  />
                ) : (
                  <Select
                    value={modelId}
                    onChange={setModelId}
                    options={modelOptions}
                    renderValue={(opt) => (
                      <span className="flex items-center gap-2">
                        {MODEL_ICON()}
                        <span className="truncate">{opt?.label}</span>
                      </span>
                    )}
                  />
                )}
              </label>

              <div className="col-span-2 space-y-4">
                <div className="space-y-2.5">
                  <div className="text-xs font-medium">{t('video_resolution')}</div>
                  <div className="grid grid-cols-3 gap-2.5">
                    {RESOLUTIONS.map((r) => (
                      <button
                        key={r}
                        onClick={() => chooseResolution(r)}
                        className={chip(resolution === r && !customRes, 'h-9 rounded-full px-2')}
                      >
                        {r}
                      </button>
                    ))}
                    <label
                      className={cn(
                        'flex h-9 overflow-hidden rounded-full border text-sm',
                        customRes ? 'border-stone-900 dark:border-stone-100' : field,
                      )}
                    >
                      <input
                        value={customRes}
                        onChange={(e) => changeCustomResolution(e.target.value)}
                        placeholder={t('studio_custom')}
                        className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none"
                      />
                      <span className="grid w-7 place-items-center pr-1 text-muted-foreground">p</span>
                    </label>
                  </div>
                </div>

                <div className="space-y-2.5">
                  <div className="text-xs font-medium">{t('video_size')}</div>
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                    <label className={cn('flex h-9 overflow-hidden rounded-xl border text-sm', field)}>
                      <span className="grid w-9 place-items-center text-muted-foreground">W</span>
                      <input
                        type="number"
                        value={width}
                        onChange={(e) => setSize(Number(e.target.value) || 0, height)}
                        className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                      />
                    </label>
                    <span className="text-lg opacity-45">↔</span>
                    <label className={cn('flex h-9 overflow-hidden rounded-xl border text-sm', field)}>
                      <span className="grid w-9 place-items-center text-muted-foreground">H</span>
                      <input
                        type="number"
                        value={height}
                        onChange={(e) => setSize(width, Number(e.target.value) || 0)}
                        className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-3 gap-2.5">
                    {ASPECT_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => applyAspect(p.id, p.w, p.h)}
                        className={chip(
                          aspect === p.id,
                          'flex h-[78px] flex-col items-center justify-center gap-1 rounded-xl',
                        )}
                      >
                        <span
                          className={cn(
                            'rounded-[3px] border-2',
                            aspect === p.id ? 'border-current' : 'border-current/60',
                          )}
                          style={{
                            width: `${Math.round((p.w / p.h) * 20)}px`,
                            height: `${Math.round((p.h / p.w) * 20)}px`,
                          }}
                        />
                        <span>{t(ASPECT_LABEL[p.id])}</span>
                        <span className="text-[11px] leading-none opacity-55">
                          {p.w}x{p.h}
                        </span>
                      </button>
                    ))}
                    <button
                      onClick={() => {
                        setAspect(null);
                        setWidth(0);
                        setHeight(0);
                        setResolution('');
                        setCustomRes('');
                      }}
                      className={chip(
                        aspect === null && width === 0,
                        'flex h-[78px] flex-col items-center justify-center gap-1 rounded-xl',
                      )}
                    >
                      <span className="text-base font-medium">auto</span>
                      <span className="text-[11px] leading-none opacity-55">{t('studio_adaptive')}</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-2.5">
                  <div className="text-xs font-medium">{t('video_duration')}</div>
                  <div className="flex items-center gap-3">
                    <Slider
                      value={duration}
                      min={2}
                      max={durationMax}
                      step={1}
                      onChange={setDuration}
                      className="flex-1"
                      ariaLabel={t('video_duration_label')}
                    />
                    <span className="shrink-0 text-sm font-medium">{duration} s</span>
                  </div>
                  {durationPlanNotice}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-auto pt-6">
            <div className="mb-2 flex items-center justify-between px-1 text-xs text-muted-foreground">
              <span>
                {t('studio_ref_count', {
                  count:
                    (showRefImage ? refImages.length : 0) +
                    (showRefVideo ? refVideos.length : 0) +
                    (showRefAudio ? refAudios.length : 0),
                })}
              </span>
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
              <Sparkles className={cn('size-4', submitting && 'animate-pulse')} />
              {submitting ? t('studio_submitting') : t('studio_generate')}
            </Button>
          </div>
        </div>

        {/* 生成结果 */}
        <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">{t('studio_results')}</h2>
            {selected && (
              <span className="text-xs text-muted-foreground">
                {new Date(selected.createdAt).toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>

          {generationsLoading ? (
            <div
              role="status"
              aria-label={t('video_loading_result')}
              className="min-h-[320px] animate-pulse rounded-lg bg-stone-200 dark:bg-stone-800 lg:min-h-[560px]"
            />
          ) : !selected ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
              <Empty icon={<Clapperboard className="size-6" />} description={t('video_empty_result')} />
            </div>
          ) : selected.status === 'failed' ? (
            <FailedResult
              gen={selected}
              onRetry={() => void retry(selected.id)}
              onDelete={() => {
                const startedVersion = workspaceVersionRef.current;
                setGenError(null);
                void remove([selected.id]).catch(reportGenError(startedVersion));
              }}
            />
          ) : selected.status === 'done' ? (
            <ResultPlayer
              gen={selected}
              onRedraw={generate}
              onUseAsRef={() => void importResultAsRef(selected)}
              onDelete={() => {
                const startedVersion = workspaceVersionRef.current;
                setGenError(null);
                void remove([selected.id]).catch(reportGenError(startedVersion));
              }}
            />
          ) : (
            <ProgressOverlay gen={selected} />
          )}
        </div>
      </section>

      {/* 提示词库 */}
      <Modal open={libraryOpen} onClose={() => setLibraryOpen(false)} title={t('studio_prompt_library')}>
        <PromptLibrary
          onPick={(p) => {
            setPrompt(p);
            setLibraryOpen(false);
          }}
        />
      </Modal>

      {/* 我的素材 */}
      <Modal open={assetsOpen} onClose={() => setAssetsOpen(false)} title={t('studio_my_assets')}>
        {assets.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {user ? t('video_assets_empty') : t('video_assets_login')}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {assets.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  if (!showRefImage) return;
                  setRefImages((prev) =>
                    prev.length >= referenceCountMax('image') || prev.some((p) => p.id === a.id) ? prev : [...prev, a],
                  );
                  setAssetsOpen(false);
                }}
                className="group relative aspect-square overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800"
              >
                <img src={a.url} alt={a.name} className="size-full object-cover" />
              </button>
            ))}
          </div>
        )}
        {assets.length > 0 && assetCursor ? (
          <div className="mt-4 text-center">
            <Button size="sm" onClick={() => void loadEarlierAssets()}>
              {t('admin_audit_hint')}
            </Button>
          </div>
        ) : null}
        <p className="mt-3 text-center text-xs text-muted-foreground">{t('video_pick_asset')}</p>
      </Modal>

      {/* 记录（移动端） */}
      <Modal open={recordsOpen} onClose={() => setRecordsOpen(false)} title={t('studio_history')} side="right">
        {videoGens.length === 0 ? (
          <Empty description={t('studio_empty_history')} />
        ) : (
          <Virtuoso
            data={videoGens}
            className="h-[min(70vh,560px)]"
            endReached={() => void loadMore()}
            itemContent={(_index, gen) => (
              <div className="pb-2.5">
                <GenerationHistoryRow
                  gen={gen}
                  active={gen.id === selectedId}
                  compact
                  onSelect={() => {
                    select(gen.id);
                    setRecordsOpen(false);
                  }}
                />
              </div>
            )}
          />
        )}
      </Modal>

      {/* 参数（移动端） */}
      <Modal open={paramsOpen} onClose={() => setParamsOpen(false)} title={t('video_params_title')} side="right">
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold">{t('studio_model')}</span>
            <Select
              value={modelId}
              onChange={setModelId}
              options={modelOptions}
              renderValue={(opt) => (
                <span className="flex items-center gap-2">
                  {MODEL_ICON()}
                  <span className="truncate">{opt?.label}</span>
                </span>
              )}
            />
          </label>
          <div className="space-y-2.5">
            <div className="text-xs font-medium">{t('video_resolution')}</div>
            <div className="grid grid-cols-3 gap-2.5">
              {RESOLUTIONS.map((r) => (
                <button
                  key={r}
                  onClick={() => chooseResolution(r)}
                  className={chip(resolution === r && !customRes, 'h-9 rounded-full px-2')}
                >
                  {r}
                </button>
              ))}
              <label
                className={cn(
                  'flex h-9 overflow-hidden rounded-full border text-sm',
                  customRes ? 'border-stone-900 dark:border-stone-100' : field,
                )}
              >
                <input
                  value={customRes}
                  onChange={(e) => changeCustomResolution(e.target.value)}
                  placeholder={t('studio_custom')}
                  className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none"
                />
                <span className="grid w-7 place-items-center pr-1 text-muted-foreground">p</span>
              </label>
            </div>
          </div>
          <div className="space-y-2.5">
            <div className="text-xs font-medium">{t('video_size')}</div>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
              <label className={cn('flex h-9 overflow-hidden rounded-xl border text-sm', field)}>
                <span className="grid w-9 place-items-center text-muted-foreground">W</span>
                <input
                  type="number"
                  value={width}
                  onChange={(e) => setSize(Number(e.target.value) || 0, height)}
                  className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
              </label>
              <span className="text-lg opacity-45">↔</span>
              <label className={cn('flex h-9 overflow-hidden rounded-xl border text-sm', field)}>
                <span className="grid w-9 place-items-center text-muted-foreground">H</span>
                <input
                  type="number"
                  value={height}
                  onChange={(e) => setSize(width, Number(e.target.value) || 0)}
                  className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
              </label>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              {ASPECT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => applyAspect(p.id, p.w, p.h)}
                  className={chip(
                    aspect === p.id,
                    'flex h-[64px] flex-col items-center justify-center gap-0.5 rounded-xl',
                  )}
                >
                  <span>{t(ASPECT_LABEL[p.id])}</span>
                  <span className="text-[10px] opacity-55">
                    {p.w}x{p.h}
                  </span>
                </button>
              ))}
              <button
                onClick={() => {
                  setAspect(null);
                  setWidth(0);
                  setHeight(0);
                  setResolution('');
                  setCustomRes('');
                }}
                className={chip(
                  aspect === null && width === 0,
                  'flex h-[64px] flex-col items-center justify-center gap-0.5 rounded-xl',
                )}
              >
                <span className="text-base font-medium">auto</span>
                <span className="text-[10px] opacity-55">{t('studio_adaptive')}</span>
              </button>
            </div>
          </div>
          <div className="space-y-2.5">
            <div className="text-xs font-medium">{t('video_duration')}</div>
            <div className="flex items-center gap-3">
              <Slider
                value={duration}
                min={2}
                max={durationMax}
                onChange={setDuration}
                className="flex-1"
                ariaLabel={t('video_duration_label')}
              />
              <span className="text-sm font-medium">{duration} s</span>
            </div>
            {durationPlanNotice}
          </div>
        </div>
      </Modal>
    </main>
  );
}

const PROMPT_LIBRARY: { cat: MessageKey; key: MessageKey }[] = [
  { cat: 'video_style_cinematic', key: 'video_prompt_cinematic' },
  { cat: 'video_style_closeup', key: 'video_prompt_closeup' },
  { cat: 'video_style_product', key: 'video_prompt_product' },
  { cat: 'video_style_nature', key: 'video_prompt_nature' },
  { cat: 'video_style_scifi', key: 'video_prompt_scifi' },
  { cat: 'video_style_food', key: 'video_prompt_food' },
];

function PromptLibrary({ onPick }: { onPick: (p: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      {PROMPT_LIBRARY.map((p) => (
        <button
          key={p.key}
          onClick={() => onPick(t(p.key))}
          className="block w-full rounded-lg border border-stone-200 p-3 text-left transition hover:border-[#9b6bff]/60 dark:border-stone-800"
        >
          <Tag className="mb-1">{t(p.cat)}</Tag>
          <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">{t(p.key)}</p>
        </button>
      ))}
    </div>
  );
}
