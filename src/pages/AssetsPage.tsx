import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Filter, Upload, Image as ImageIcon, Film, Music, Trash2, LogIn, Play, X, Loader2 } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { useAuth } from '../lib/auth';
import { assetApi, getActiveOrgId } from '../lib/api';
import { appendGenerationPage, HISTORY_PAGE_SIZE, mergeGenerationPage, type HistoryCursor } from '../lib/history-page';
import type { Asset, AssetKind } from '../lib/types';
import { cn, formatBytes } from '../lib/utils';
import { useI18n, type MessageKey } from '../lib/i18n';

const TABS: { id: AssetKind; labelKey: MessageKey; icon: typeof ImageIcon }[] = [
  { id: 'image', labelKey: 'assets_images', icon: ImageIcon },
  { id: 'video', labelKey: 'assets_videos', icon: Film },
  { id: 'audio', labelKey: 'assets_audio', icon: Music },
];

/** Deterministic bar heights so an audio asset always renders the same "waveform". */
function waveform(seed: string, bars = 28) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Array.from({ length: bars }, (_, i) => {
    const n = Math.abs(Math.sin(h + i * 12.9898) * 43758.5453) % 1;
    return 0.18 + n * 0.82;
  });
}

function formatDuration(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Video card that captures its own first frame as a poster. */
function VideoThumb({ asset }: { asset: Asset }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [poster, setPoster] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);

  const grabPoster = () => {
    const v = videoRef.current;
    if (!v || poster) return;
    if (!v.videoWidth || !v.videoHeight) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      setPoster(canvas.toDataURL('image/jpeg', 0.72));
    } catch {
      /* CORS / decode issue — keep the placeholder */
    }
  };

  return (
    <>
      {poster ? (
        <img src={poster} alt={asset.name} className="size-full object-cover" />
      ) : (
        <div className="grid size-full place-items-center bg-gradient-to-br from-stone-700/60 to-stone-900">
          <Film className="size-7 text-white/40" />
        </div>
      )}
      <video
        ref={videoRef}
        src={`${asset.url}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        crossOrigin="anonymous"
        className="hidden"
        onLoadedData={grabPoster}
        onSeeked={() => {
          grabPoster();
          setDuration(videoRef.current?.duration ?? null);
        }}
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (!v) return;
          setDuration(v.duration);
          // Seek a hair into the clip so the first frame is actually decoded.
          try {
            v.currentTime = 0.1;
          } catch {
            /* ignore */
          }
        }}
      />
      <span className="pointer-events-none absolute inset-0 grid place-items-center">
        <span className="grid size-8 place-items-center rounded-full bg-black/50 text-white opacity-0 backdrop-blur transition group-hover:opacity-100">
          <Play className="size-4 translate-x-px" fill="white" />
        </span>
      </span>
      {formatDuration(duration ?? 0) && (
        <span className="pointer-events-none absolute bottom-8 right-2 rounded bg-black/70 px-1 text-[10px] tabular-nums text-white">
          {formatDuration(duration ?? 0)}
        </span>
      )}
    </>
  );
}

type AssetListPage = { items: Asset[]; nextCursor: HistoryCursor | null };

export function AssetsPage() {
  const { user, openLogin } = useAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState<AssetKind>('image');
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Asset | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  const previewDialogRef = useRef<HTMLDivElement>(null);
  const loadingEarlier = useRef(false);
  const earlierLoad = useRef(0);
  const actionScopeRef = useRef({
    userId: user?.id ?? 'guest',
    workspaceId: getActiveOrgId() ?? 'personal',
    workspaceVersion,
  });
  const queryClient = useQueryClient();
  const workspaceId = getActiveOrgId();
  const userScopeId = user?.id ?? 'guest';
  // Live scope for a late upload or delete error. An effect would run too late.
  // eslint-disable-next-line react-hooks/refs
  const userChanged = actionScopeRef.current.userId !== userScopeId;
  // eslint-disable-next-line react-hooks/refs
  actionScopeRef.current = {
    userId: userScopeId,
    workspaceId: workspaceId ?? 'personal',
    workspaceVersion,
  };
  if (userChanged) {
    setPreview(null);
    setActionError(null);
  }
  const assetQueryKey = (kind: AssetKind) =>
    ['assets', user?.id ?? 'guest', workspaceId ?? 'personal', workspaceVersion, kind] as const;
  const queryKey = assetQueryKey(tab);
  // Retire an in-flight earlier page when the tab or its query key changes.
  const earlierScope = JSON.stringify(queryKey);
  const earlierScopeSeen = useRef(earlierScope);
  if (earlierScopeSeen.current !== earlierScope) {
    earlierScopeSeen.current = earlierScope;
    loadingEarlier.current = false;
    earlierLoad.current += 1;
  }

  const assetsQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const page = await assetApi.listPage({ kind: tab, limit: HISTORY_PAGE_SIZE });
      const previous = queryClient.getQueryData<AssetListPage>(queryKey);
      const items = mergeGenerationPage(previous?.items ?? [], page.items, HISTORY_PAGE_SIZE);
      const keptOlder = items.length > page.items.length;
      return {
        items,
        nextCursor: page.items.length < HISTORY_PAGE_SIZE ? null : keptOlder ? (previous?.nextCursor ?? null) : page.nextCursor,
      };
    },
    enabled: Boolean(user),
    staleTime: 20_000,
  });
  const items = user ? (assetsQuery.data?.items ?? []) : [];
  const loadEarlier = async () => {
    const cursor = assetsQuery.data?.nextCursor;
    if (!cursor || loadingEarlier.current) return;
    loadingEarlier.current = true;
    const requestId = ++earlierLoad.current;
    try {
      const page = await assetApi.listPage({
        kind: tab,
        limit: HISTORY_PAGE_SIZE,
        before: cursor.createdAt,
        beforeId: cursor.id,
      });
      if (requestId !== earlierLoad.current) return;
      queryClient.setQueryData<AssetListPage>(queryKey, (previous) => ({
        items: appendGenerationPage(previous?.items ?? [], page.items),
        nextCursor: page.nextCursor,
      }));
    } finally {
      if (requestId === earlierLoad.current) loadingEarlier.current = false;
    }
  };
  const loading = assetsQuery.isLoading || assetsQuery.isFetching;
  const error =
    actionError ??
    (assetsQuery.error instanceof Error
      ? assetsQuery.error.message
      : assetsQuery.isError
        ? t('assets_load_failed')
        : null);

  useEffect(() => {
    const onWorkspaceChange = () => {
      setPreview(null);
      setActionError(null);
      setWorkspaceVersion((version) => {
        const next = version + 1;
        actionScopeRef.current = {
          userId: actionScopeRef.current.userId,
          workspaceId: getActiveOrgId() ?? 'personal',
          workspaceVersion: next,
        };
        return next;
      });
    };
    window.addEventListener('benchu:workspace-change', onWorkspaceChange);
    return () => window.removeEventListener('benchu:workspace-change', onWorkspaceChange);
  }, []);

  useEffect(() => {
    if (!preview) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => previewCloseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreview(null);
        return;
      }
      if (event.key !== 'Tab' || !previewDialogRef.current) return;
      const focusable = Array.from(
        previewDialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), video[controls], audio[controls], [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [preview]);

  const uploadMutation = useMutation({
    mutationFn: async (files: File[]) => {
      const uploaded: Asset[] = [];
      for (const file of files) uploaded.push(await assetApi.upload(file));
      return uploaded;
    },
    onMutate: () => {
      setActionError(null);
      return {
        userId: user?.id ?? 'guest',
        workspaceId: workspaceId ?? 'personal',
        workspaceVersion,
      };
    },
    onSuccess: (uploaded, _files, scope) => {
      const kinds = [...new Set(uploaded.map((item) => item.kind))];
      for (const itemKind of kinds) {
        void queryClient.invalidateQueries({
          queryKey: ['assets', scope.userId, scope.workspaceId, scope.workspaceVersion, itemKind],
        });
      }
      if (
        (user?.id ?? 'guest') === scope.userId &&
        (workspaceId ?? 'personal') === scope.workspaceId &&
        workspaceVersion === scope.workspaceVersion
      ) {
        setTab(kinds[0] ?? tab);
      }
    },
    onError: (err, _files, scope) => {
      if (
        scope &&
        actionScopeRef.current.userId === scope.userId &&
        actionScopeRef.current.workspaceId === scope.workspaceId &&
        actionScopeRef.current.workspaceVersion === scope.workspaceVersion
      ) {
        setActionError(err instanceof Error ? err.message : t('assets_upload_failed'));
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => assetApi.remove(id),
    onMutate: async (id) => {
      setActionError(null);
      const deleteQueryKey = queryKey;
      const startedScope = {
        userId: user?.id ?? 'guest',
        workspaceId: workspaceId ?? 'personal',
        workspaceVersion,
      };
      await queryClient.cancelQueries({ queryKey: deleteQueryKey });
      const previous = queryClient.getQueryData<AssetListPage>(deleteQueryKey) ?? {
        items: [],
        nextCursor: null,
      };
      queryClient.setQueryData<AssetListPage>(deleteQueryKey, {
        items: previous.items.filter((item) => item.id !== id),
        nextCursor: previous.nextCursor,
      });
      setPreview((item) => (item?.id === id ? null : item));
      return { previous, queryKey: deleteQueryKey, ...startedScope };
    },
    onError: (err, _id, context) => {
      if (context) queryClient.setQueryData(context.queryKey, context.previous);
      if (
        context &&
        actionScopeRef.current.userId === context.userId &&
        actionScopeRef.current.workspaceId === context.workspaceId &&
        actionScopeRef.current.workspaceVersion === context.workspaceVersion
      ) {
        setActionError(err instanceof Error ? err.message : t('assets_delete_failed'));
      }
    },
    onSettled: (_data, _error, _id, context) => {
      if (context) void queryClient.invalidateQueries({ queryKey: context.queryKey });
    },
  });

  const counts = {
    image: queryClient.getQueryData<AssetListPage>(assetQueryKey('image'))?.items.length ?? 0,
    video: queryClient.getQueryData<AssetListPage>(assetQueryKey('video'))?.items.length ?? 0,
    audio: queryClient.getQueryData<AssetListPage>(assetQueryKey('audio'))?.items.length ?? 0,
  };
  const shown = items.filter((a) => a.kind === tab);

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    await uploadMutation.mutateAsync(Array.from(files)).catch(() => {});
  };

  const onDelete = async (id: string) => {
    await deleteMutation.mutateAsync(id).catch(() => {});
  };

  if (!user) {
    return (
      <main className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-center gap-4 py-24 text-center">
          <ImageIcon className="size-10 text-stone-500" />
          <p className="text-stone-400">{t('assets_login_prompt')}</p>
          <Button variant="brand" onClick={openLogin}>
            <LogIn className="size-4" /> {t('login')}
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">{t('assets_title')}</h1>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void assetsQuery.refetch()} disabled={loading}>
              <Filter className="size-3.5" /> {loading ? t('assets_refreshing') : t('assets_refresh')}
            </Button>
            <Button
              size="sm"
              variant="brand"
              onClick={() => fileRef.current?.click()}
              disabled={uploadMutation.isPending}
            >
              {uploadMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              {uploadMutation.isPending ? t('assets_uploading') : t('assets_upload')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              aria-label={t('assets_choose_files')}
              accept="image/*,video/*,audio/*"
              multiple
              hidden
              onChange={(e) => {
                void onUpload(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        <div
          role="tablist"
          aria-label={t('assets_type')}
          className="mb-4 flex gap-1 border-b border-stone-200 dark:border-stone-800"
        >
          {TABS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                id={`asset-tab-${item.id}`}
                role="tab"
                aria-selected={tab === item.id}
                aria-controls={`asset-panel-${item.id}`}
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => {
                  const current = TABS.findIndex((tabItem) => tabItem.id === item.id);
                  const next =
                    event.key === 'ArrowRight'
                      ? (current + 1) % TABS.length
                      : event.key === 'ArrowLeft'
                        ? (current - 1 + TABS.length) % TABS.length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? TABS.length - 1
                            : -1;
                  if (next < 0) return;
                  event.preventDefault();
                  setTab(TABS[next].id);
                  document.getElementById(`asset-tab-${TABS[next].id}`)?.focus();
                }}
                className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition ${
                  tab === item.id ? 'border-[#9b6bff] font-medium text-foreground' : 'border-transparent text-stone-500'
                }`}
              >
                <Icon className="size-4" />
                {t(item.labelKey)}
                <span className="rounded bg-white/10 px-1.5 text-[10px]">{counts[item.id]}</span>
              </button>
            );
          })}
        </div>

        {error && (
          <p role="alert" className="mb-3 text-sm text-red-400">
            {error}
          </p>
        )}

        <div id={`asset-panel-${tab}`} role="tabpanel" aria-labelledby={`asset-tab-${tab}`}>
          {shown.length === 0 ? (
            <div className="flex min-h-[240px] items-center justify-center rounded-xl border border-dashed border-stone-300 text-sm text-stone-500 dark:border-stone-700">
              {loading ? t('assets_loading') : t('assets_empty')}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {shown.map((a) => (
                <div
                  key={a.id}
                  className="group relative aspect-square overflow-hidden rounded-xl border border-stone-200 bg-black/40 dark:border-stone-800"
                >
                  <button
                    type="button"
                    aria-label={`${t('assets_preview')} ${a.name}`}
                    onClick={() => setPreview(a)}
                    className="absolute inset-0 z-10 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[#9b6bff]"
                  />
                  {a.kind === 'image' ? (
                    <img
                      src={a.url}
                      alt={a.name}
                      loading="lazy"
                      decoding="async"
                      className="size-full object-cover transition duration-300 group-hover:scale-[1.03]"
                    />
                  ) : a.kind === 'video' ? (
                    <VideoThumb asset={a} />
                  ) : (
                    <div className="flex size-full flex-col justify-between bg-gradient-to-br from-emerald-900/50 to-teal-950/70 p-2">
                      <Music className="size-4 text-emerald-300/80" />
                      <div className="flex h-10 items-end gap-[2px]">
                        {waveform(a.id || a.name).map((v, i) => (
                          <span
                            key={i}
                            className="flex-1 rounded-sm bg-emerald-300/70"
                            style={{ height: `${Math.round(v * 100)}%` }}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/85 to-transparent p-2">
                    <span className="truncate text-[10px] text-white/85">{a.name}</span>
                    <span className="shrink-0 text-[9px] text-white/50">{formatBytes(a.size)}</span>
                  </div>

                  <button
                    type="button"
                    aria-label={`${t('assets_delete')} ${a.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDelete(a.id);
                    }}
                    className={cn(
                      'absolute right-2 top-2 z-20 grid size-7 place-items-center rounded-full bg-black/60 text-white opacity-100 transition hover:bg-red-500/80 focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100',
                    )}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {assetsQuery.data?.nextCursor && (
            <div className="mt-4 text-center">
              <Button size="sm" onClick={() => void loadEarlier()}>
                {t('admin_audit_hint')}
              </Button>
            </div>
          )}
        </div>
      </div>

      {preview && (
        <div
          ref={previewDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`${t('assets_preview')} ${preview.name}`}
          className="fixed inset-0 z-[120] grid place-items-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={() => setPreview(null)}
        >
          <button
            ref={previewCloseRef}
            aria-label={t('assets_close_preview')}
            onClick={() => setPreview(null)}
            className="absolute right-4 top-4 grid size-9 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <X className="size-5" />
          </button>
          <div
            className="max-h-[86vh] w-full max-w-3xl overflow-hidden rounded-xl bg-black"
            onClick={(e) => e.stopPropagation()}
          >
            {preview.kind === 'image' ? (
              <img src={preview.url} alt={preview.name} className="max-h-[86vh] w-full object-contain" />
            ) : preview.kind === 'video' ? (
              <video src={preview.url} controls autoPlay className="max-h-[86vh] w-full bg-black" />
            ) : (
              <div className="space-y-4 p-6">
                <div className="flex items-end gap-[3px]">
                  {waveform(preview.id || preview.name, 64).map((v, i) => (
                    <span
                      key={i}
                      className="flex-1 rounded-sm bg-emerald-300/70"
                      style={{ height: `${Math.round(v * 90) + 8}px` }}
                    />
                  ))}
                </div>
                <audio src={preview.url} controls autoPlay className="w-full" />
              </div>
            )}
            <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-2.5 text-xs text-white/70">
              <span className="truncate">{preview.name}</span>
              <span className="shrink-0">{formatBytes(preview.size)}</span>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
