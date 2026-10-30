import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Clapperboard,
  Image as ImageIcon,
  Loader2,
  Maximize,
  Plus,
  Save,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { GenerativeCanvas } from '../components/ResultPlayer';
import { ApiClientError, assetApi, canvasApi, getActiveOrgId } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CANVAS_ASSET_PAGE_LIMIT, loadCanvasKind, type CanvasAssetPage } from '../lib/canvas-assets';
import { canvasBoundsProblem, canvasDocumentProblem } from '../lib/canvas-limit';
import { useI18n } from '../lib/i18n';
import type { Asset, CanvasNode, CanvasViewport } from '../lib/types';
import { uid } from '../lib/utils';

const EMPTY_VIEWPORT: CanvasViewport = { zoom: 1, x: 0, y: 0 };

function assetIdsInDocument(nodes: readonly CanvasNode[] | undefined, kind: 'image' | 'video') {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes ?? []) {
    if (node.type !== kind || !node.assetId || seen.has(node.assetId)) continue;
    seen.add(node.assetId);
    ids.push(node.assetId);
  }
  ids.sort();
  return ids;
}

function loadCanvasAssets(kind: 'image' | 'video', neededIds: readonly string[]) {
  return loadCanvasKind(neededIds, (cursor) =>
    assetApi.listPage({
      kind,
      limit: CANVAS_ASSET_PAGE_LIMIT,
      before: cursor?.createdAt,
      beforeId: cursor?.id,
    }),
  );
}

function appendCanvasAssets(loaded: readonly Asset[], page: readonly Asset[]) {
  const seen = new Set(loaded.map((item) => item.id));
  const items = [...loaded];
  for (const item of page) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

function keepOlderCanvasPage(page: CanvasAssetPage<Asset>, previous: CanvasAssetPage<Asset> | undefined) {
  if (!previous) return page;
  const items = appendCanvasAssets(page.items, previous.items);
  return {
    items,
    nextCursor: items.length > page.items.length ? previous.nextCursor : page.nextCursor,
  };
}

function keepCanvasAssets(kind: 'image' | 'video', scope: readonly [string, string, number]) {
  return (
    previous: CanvasAssetPage<Asset> | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ) => {
    const key = previousQuery?.queryKey;
    if (!previous || !key) return undefined;
    if (key[1] !== scope[0] || key[2] !== scope[1] || key[3] !== scope[2] || key[4] !== kind) return undefined;
    return previous;
  };
}

export function CanvasPage() {
  const { user, openLogin } = useAuth();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [viewport, setViewport] = useState<CanvasViewport>(EMPTY_VIEWPORT);
  const [version, setVersion] = useState(0);
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [picker, setPicker] = useState<'image' | 'video' | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadingEarlierRef = useRef(false);
  const earlierLoad = useRef(0);
  const reloadRequest = useRef(0);
  const changeRevision = useRef(0);
  const drag = useRef<{ id: string | null; startX: number; startY: number; ox: number; oy: number }>({
    id: null,
    startX: 0,
    startY: 0,
    ox: 0,
    oy: 0,
  });
  const panning = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const workspaceId = getActiveOrgId();
  const workspaceScopeId = workspaceId ?? 'personal';
  const userScopeId = user?.id ?? 'guest';
  const workspaceScopeRef = useRef({ id: workspaceScopeId, version: workspaceVersion, userId: userScopeId });
  // Current before an in-flight reload resumes. An effect would run too late.
  // eslint-disable-next-line react-hooks/refs
  const userChanged = workspaceScopeRef.current.userId !== userScopeId;
  // eslint-disable-next-line react-hooks/refs
  workspaceScopeRef.current = { id: workspaceScopeId, version: workspaceVersion, userId: userScopeId };
  if (userChanged) {
    setLoaded(false);
    setNodes([]);
    setViewport(EMPTY_VIEWPORT);
    setDirty(false);
    setConflicted(false);
    setSaveError(null);
    setActive(null);
    setPicker(null);
    reloadRequest.current += 1;
    setReloading(false);
  }
  const canvasKey = ['canvas', user?.id ?? 'guest', workspaceId ?? 'personal', workspaceVersion] as const;

  const canvasQuery = useQuery({
    queryKey: canvasKey,
    queryFn: canvasApi.current,
    enabled: Boolean(user),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
  const assetScope = [user?.id ?? 'guest', workspaceId ?? 'personal', workspaceVersion] as const;
  const pickerSeen = useRef({ picker, scope: assetScope });
  if (
    pickerSeen.current.picker !== picker ||
    pickerSeen.current.scope[0] !== assetScope[0] ||
    pickerSeen.current.scope[1] !== assetScope[1] ||
    pickerSeen.current.scope[2] !== assetScope[2]
  ) {
    pickerSeen.current = { picker, scope: assetScope };
    loadingEarlierRef.current = false;
    earlierLoad.current += 1;
    if (loadingEarlier) setLoadingEarlier(false);
  }
  const imageAssetIds = useMemo(() => assetIdsInDocument(canvasQuery.data?.nodes, 'image'), [canvasQuery.data]);
  const videoAssetIds = useMemo(() => assetIdsInDocument(canvasQuery.data?.nodes, 'video'), [canvasQuery.data]);
  const imageAssetsKey = ['canvas-assets', assetScope[0], assetScope[1], assetScope[2], 'image', imageAssetIds] as const;
  const videoAssetsKey = ['canvas-assets', assetScope[0], assetScope[1], assetScope[2], 'video', videoAssetIds] as const;
  const imageAssetsQuery = useQuery({
    queryKey: imageAssetsKey,
    queryFn: async () =>
      keepOlderCanvasPage(
        await loadCanvasAssets('image', imageAssetIds),
        queryClient.getQueryData<CanvasAssetPage<Asset>>(imageAssetsKey),
      ),
    enabled: Boolean(user) && canvasQuery.isSuccess,
    placeholderData: keepCanvasAssets('image', assetScope),
    staleTime: 10_000,
  });
  const videoAssetsQuery = useQuery({
    queryKey: videoAssetsKey,
    queryFn: async () =>
      keepOlderCanvasPage(
        await loadCanvasAssets('video', videoAssetIds),
        queryClient.getQueryData<CanvasAssetPage<Asset>>(videoAssetsKey),
      ),
    enabled: Boolean(user) && canvasQuery.isSuccess,
    placeholderData: keepCanvasAssets('video', assetScope),
    staleTime: 10_000,
  });
  const imageAssets = useMemo(() => imageAssetsQuery.data?.items ?? [], [imageAssetsQuery.data]);
  const videoAssets = useMemo(() => videoAssetsQuery.data?.items ?? [], [videoAssetsQuery.data]);
  const assetById = useMemo(() => {
    const urls = new Map<string, Asset>();
    for (const asset of imageAssets) urls.set(asset.id, asset);
    for (const asset of videoAssets) urls.set(asset.id, asset);
    return urls;
  }, [imageAssets, videoAssets]);

  useEffect(() => {
    const onWorkspaceChange = () => {
      const nextVersion = workspaceScopeRef.current.version + 1;
      workspaceScopeRef.current = {
        id: getActiveOrgId() ?? 'personal',
        version: nextVersion,
        userId: workspaceScopeRef.current.userId,
      };
      setLoaded(false);
      setDirty(false);
      setConflicted(false);
      setSaveError(null);
      setActive(null);
      setPicker(null);
      reloadRequest.current += 1;
      setReloading(false);
      setWorkspaceVersion(nextVersion);
    };
    window.addEventListener('benchu:workspace-change', onWorkspaceChange);
    return () => window.removeEventListener('benchu:workspace-change', onWorkspaceChange);
  }, []);

  useEffect(() => {
    if (!user || !canvasQuery.isFetched || canvasQuery.isFetching || canvasQuery.isError || loaded) return;
    const document = canvasQuery.data;
    setNodes(document?.nodes ?? []);
    setViewport(document?.viewport ?? EMPTY_VIEWPORT);
    setVersion(document?.version ?? 0);
    changeRevision.current = 0;
    setDirty(false);
    setSaveError(null);
    setConflicted(false);
    setLoaded(true);
  }, [canvasQuery.data, canvasQuery.isError, canvasQuery.isFetched, canvasQuery.isFetching, loaded, user]);

  const saveMutation = useMutation({
    mutationFn: ({
      clientRevision: _clientRevision,
      userId: _userId,
      workspaceId: _workspaceId,
      workspaceVersion: _workspaceVersion,
      ...input
    }: {
      clientRevision: number;
      userId: string;
      workspaceId: string;
      workspaceVersion: number;
      version: number;
      nodes: CanvasNode[];
      viewport: CanvasViewport;
    }) => canvasApi.save(input),
    onSuccess: (document, variables) => {
      queryClient.setQueryData(
        ['canvas', variables.userId, variables.workspaceId, variables.workspaceVersion],
        document,
      );
      const rendered = workspaceScopeRef.current;
      if (
        variables.userId !== (rendered.userId || 'guest') ||
        variables.workspaceId !== rendered.id ||
        variables.workspaceVersion !== rendered.version
      ) return;
      setVersion(document.version);
      if (changeRevision.current === variables.clientRevision) setDirty(false);
      setSaveError(null);
    },
    onError: (error, variables) => {
      const rendered = workspaceScopeRef.current;
      if (
        variables.userId !== (rendered.userId || 'guest') ||
        variables.workspaceId !== rendered.id ||
        variables.workspaceVersion !== rendered.version
      ) return;
      if (error instanceof ApiClientError && error.status === 409) setConflicted(true);
      setSaveError(error instanceof Error ? error.message : t('canvas_save_failed'));
    },
  });

  useEffect(() => {
    if (!loaded || !dirty || conflicted || saveMutation.isPending) return;
    const problem = canvasDocumentProblem(nodes) ?? canvasBoundsProblem(nodes, viewport);
    if (problem) {
      setSaveError(problem);
      return;
    }
    const timer = window.setTimeout(() => {
      saveMutation.mutate({
        clientRevision: changeRevision.current,
        userId: userScopeId || 'guest',
        workspaceId: getActiveOrgId() ?? 'personal',
        workspaceVersion,
        version,
        nodes,
        viewport,
      });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [conflicted, dirty, loaded, nodes, saveMutation, userScopeId, version, viewport, workspaceVersion]);

  const markChanged = () => {
    changeRevision.current += 1;
    setDirty(true);
    setSaveError(null);
  };

  const addNode = (type: CanvasNode['type'], asset?: Asset) => {
    if (nodes.length >= 300) {
      setSaveError('画布最多 300 个节点');
      return;
    }
    const id = uid();
    const node: CanvasNode = {
      id,
      type,
      x: 180 + (nodes.length % 6) * 36,
      y: 150 + (nodes.length % 5) * 34,
      w: 260,
      h: type === 'text' ? 150 : type === 'video' ? 170 : 240,
      text: type === 'text' ? t('canvas_text_placeholder') : undefined,
      seed: asset ? undefined : `${type}-${id}`,
      assetId: asset?.id,
    };
    setNodes((current) => [...current, node]);
    setActive(id);
    setPicker(null);
    markChanged();
  };

  const openPicker = (kind: 'image' | 'video') => setPicker((current) => (current === kind ? null : kind));

  const loadEarlierAssets = async () => {
    if ((picker !== 'image' && picker !== 'video') || loadingEarlierRef.current) return;
    const kind = picker;
    const current = kind === 'image' ? imageAssetsQuery.data : videoAssetsQuery.data;
    if (!current || !current.nextCursor) return;
    const cursor = current.nextCursor;
    const queryKey = kind === 'image' ? imageAssetsKey : videoAssetsKey;
    loadingEarlierRef.current = true;
    const requestId = ++earlierLoad.current;
    setLoadingEarlier(true);
    try {
      const page = await assetApi.listPage({
        kind,
        limit: CANVAS_ASSET_PAGE_LIMIT,
        before: cursor.createdAt,
        beforeId: cursor.id,
      });
      if (requestId !== earlierLoad.current) return;
      queryClient.setQueryData<CanvasAssetPage<Asset>>(queryKey, (previous) => ({
        items: appendCanvasAssets(previous?.items ?? current.items, page.items),
        nextCursor: page.nextCursor,
      }));
    } catch {
      // Keep the assets already shown when an earlier page fails.
    } finally {
      if (requestId === earlierLoad.current) {
        loadingEarlierRef.current = false;
        setLoadingEarlier(false);
      }
    }
  };

  const onNodeDown = (event: React.MouseEvent, node: CanvasNode) => {
    event.stopPropagation();
    setActive(node.id);
    drag.current = {
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      ox: node.x,
      oy: node.y,
    };
  };

  const onCanvasMove = (event: React.MouseEvent) => {
    if (drag.current.id) {
      const currentDrag = drag.current;
      setNodes((current) =>
        current.map((node) =>
          node.id === currentDrag.id
            ? {
                ...node,
                x: currentDrag.ox + (event.clientX - currentDrag.startX) / viewport.zoom,
                y: currentDrag.oy + (event.clientY - currentDrag.startY) / viewport.zoom,
              }
            : node,
        ),
      );
      markChanged();
    } else if (panning.current) {
      const currentPan = panning.current;
      setViewport((current) => ({
        ...current,
        x: currentPan.px + (event.clientX - currentPan.x),
        y: currentPan.py + (event.clientY - currentPan.y),
      }));
      markChanged();
    }
  };

  const endDrag = () => {
    drag.current.id = null;
    panning.current = null;
  };

  const saveNow = () => {
    if (!dirty || saveMutation.isPending || conflicted) return;
    const problem = canvasDocumentProblem(nodes) ?? canvasBoundsProblem(nodes, viewport);
    if (problem) {
      setSaveError(problem);
      return;
    }
    saveMutation.mutate({
      clientRevision: changeRevision.current,
      userId: userScopeId || 'guest',
      workspaceId: getActiveOrgId() ?? 'personal',
      workspaceVersion,
      version,
      nodes,
      viewport,
    });
  };

  const reloadFromServer = async () => {
    const requestId = ++reloadRequest.current;
    const startedUserId = workspaceScopeRef.current.userId;
    const startedWorkspaceId = workspaceScopeRef.current.id;
    const startedWorkspaceVersion = workspaceScopeRef.current.version;
    setReloading(true);
    try {
      const result = await canvasQuery.refetch();
      const scope = workspaceScopeRef.current;
      if (
        scope.userId !== startedUserId ||
        scope.id !== startedWorkspaceId ||
        scope.version !== startedWorkspaceVersion
      ) {
        return;
      }
      if (result.error) {
        setSaveError(result.error instanceof Error ? result.error.message : t('canvas_load_failed'));
        return;
      }
      const document = result.data ?? null;
      setNodes(document?.nodes ?? []);
      setViewport(document?.viewport ?? EMPTY_VIEWPORT);
      setVersion(document?.version ?? 0);
      changeRevision.current = 0;
      setDirty(false);
      setSaveError(null);
      setConflicted(false);
      setActive(null);
    } finally {
      if (requestId === reloadRequest.current) setReloading(false);
    }
  };

  if (!user) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-6">
        <div className="text-center">
          <ImageIcon className="mx-auto mb-3 size-10 text-muted-foreground" />
          <p className="mb-3 text-sm text-muted-foreground">{t('canvas_login_prompt')}</p>
          <Button variant="brand" onClick={openLogin}>
            {t('login')}
          </Button>
        </div>
      </main>
    );
  }

  if (!loaded && canvasQuery.isLoading) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-6">
        <Loader2 role="status" aria-label={t('canvas_loading')} className="size-6 animate-spin" />
      </main>
    );
  }

  if (canvasQuery.isError) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-6">
        <div className="text-center">
          <AlertTriangle className="mx-auto mb-3 size-8 text-red-400" />
          <p role="alert" className="mb-3 text-sm text-red-400">
            {canvasQuery.error instanceof Error ? canvasQuery.error.message : t('canvas_load_failed')}
          </p>
          <Button onClick={() => void canvasQuery.refetch()}>{t('canvas_retry')}</Button>
        </div>
      </main>
    );
  }

  const pickerAssets = picker === 'image' ? imageAssets : picker === 'video' ? videoAssets : [];
  const pickerCursor =
    picker === 'image'
      ? imageAssetsQuery.data?.nextCursor
      : picker === 'video'
        ? videoAssetsQuery.data?.nextCursor
        : null;
  const pickerLoading =
    picker === 'image' ? imageAssetsQuery.isLoading : picker === 'video' ? videoAssetsQuery.isLoading : false;
  const status = conflicted
    ? t('canvas_conflict')
    : saveMutation.isPending
      ? t('canvas_saving')
      : saveError
        ? saveError
        : dirty
          ? t('canvas_unsaved')
          : t('canvas_saved');

  return (
    <main className="relative min-h-0 flex-1 overflow-hidden bg-stone-100 dark:bg-[#0b0b0d]">
      <div
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        data-testid="canvas-surface"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(120,120,130,0.18) 1px, transparent 1px)',
          backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        }}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          panning.current = { x: event.clientX, y: event.clientY, px: viewport.x, py: viewport.y };
          setActive(null);
        }}
        onMouseMove={onCanvasMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          setViewport((current) => ({
            ...current,
            zoom: Math.min(2, Math.max(0.4, current.zoom - event.deltaY * 0.001)),
          }));
          markChanged();
        }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
        >
          {nodes.map((node) => {
            const asset = node.assetId ? assetById.get(node.assetId) : undefined;
            return (
              <div
                key={node.id}
                data-node-id={node.id}
                onMouseDown={(event) => onNodeDown(event, node)}
                style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
                className={`absolute overflow-hidden rounded-xl border bg-card shadow-lg transition-shadow ${
                  active === node.id ? 'border-[#9b6bff] ring-2 ring-[#9b6bff]/30' : 'border-stone-700/60'
                }`}
              >
                {node.type === 'text' ? (
                  <textarea
                    aria-label={t('canvas_text_node')}
                    value={node.text ?? ''}
                    onMouseDown={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      const text = event.target.value;
                      setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, text } : item)));
                      markChanged();
                    }}
                    className="size-full resize-none bg-transparent p-3 text-sm leading-6 text-foreground outline-none"
                  />
                ) : asset ? (
                  <div className="relative size-full bg-black">
                    {node.type === 'image' ? (
                      <img src={asset.url} alt={asset.name} className="size-full object-cover" draggable={false} />
                    ) : (
                      <video
                        src={asset.url}
                        aria-label={asset.name}
                        className="size-full object-cover"
                        controls
                        muted
                        playsInline
                        onMouseDown={(event) => event.stopPropagation()}
                      />
                    )}
                    <span className="absolute left-2 top-2 max-w-[80%] truncate rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                      {asset.name}
                    </span>
                  </div>
                ) : node.assetId ? (
                  <div className="grid size-full place-items-center bg-black/50 px-3 text-center text-xs text-stone-300">
                    {t('canvas_source_missing')}
                  </div>
                ) : (
                  <div className="relative size-full">
                    <GenerativeCanvas seed={node.seed ?? node.id} width={node.w} height={node.h} playing />
                    <span className="absolute left-2 top-2 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
                      {node.type === 'video' ? t('canvas_video_node') : t('canvas_image_node')}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2">
        <div className="flex items-center gap-1 rounded-full border border-stone-200 bg-card/90 p-1 shadow-lg backdrop-blur dark:border-stone-800">
          <button
            onClick={() => addNode('text')}
            className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition hover:bg-white/10"
          >
            <Type className="size-3.5" /> {t('canvas_text')}
          </button>
          <button
            onClick={() => openPicker('image')}
            aria-expanded={picker === 'image'}
            className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition hover:bg-white/10"
          >
            <ImageIcon className="size-3.5" /> {t('canvas_image')}
          </button>
          <button
            onClick={() => openPicker('video')}
            aria-expanded={picker === 'video'}
            className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition hover:bg-white/10"
          >
            <Clapperboard className="size-3.5" /> {t('canvas_video')}
          </button>
          <span className="mx-1 h-4 w-px bg-border" />
          <button
            onClick={() => addNode('image')}
            className="grid size-7 place-items-center rounded-full transition hover:bg-white/10"
            title={t('canvas_add_placeholder')}
            aria-label={t('canvas_add_placeholder')}
          >
            <Plus className="size-4" />
          </button>
        </div>

        {picker && (
          <section
            aria-label={t('canvas_asset_picker')}
            className="mt-2 max-h-72 w-72 overflow-y-auto rounded-xl border border-border bg-card p-2 shadow-xl"
          >
            {pickerLoading ? (
              <p className="p-3 text-center text-xs text-muted-foreground">{t('canvas_loading_assets')}</p>
            ) : pickerAssets.length === 0 ? (
              <p className="p-3 text-center text-xs text-muted-foreground">{t('canvas_no_assets')}</p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {pickerAssets.map((asset) => (
                  <button
                    key={asset.id}
                    onClick={() => addNode(picker, asset)}
                    aria-label={t('canvas_add_asset', { name: asset.name })}
                    className="overflow-hidden rounded-lg border border-border text-left hover:border-[#9b6bff]"
                  >
                    {asset.kind === 'image' ? (
                      <img src={asset.url} alt="" className="aspect-square w-full object-cover" />
                    ) : (
                      <video src={asset.url} className="aspect-square w-full object-cover" muted />
                    )}
                    <span className="block truncate px-1 py-1 text-[10px]">{asset.name}</span>
                  </button>
                ))}
              </div>
            )}
            {pickerCursor && (
              <div className="mt-2 text-center">
                <Button type="button" size="sm" onClick={() => void loadEarlierAssets()} disabled={loadingEarlier}>
                  {t('admin_audit_hint')}
                </Button>
              </div>
            )}
          </section>
        )}
      </div>

      <div className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-lg border border-border bg-card/90 px-2 py-1 shadow backdrop-blur">
        <span
          role={saveError || conflicted ? 'alert' : 'status'}
          className={`flex items-center gap-1 text-xs ${saveError || conflicted ? 'text-red-400' : 'text-muted-foreground'}`}
        >
          {conflicted || saveError ? (
            <AlertTriangle className="size-3.5" />
          ) : saveMutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
          {status}
        </span>
        {conflicted && (
          <button
            type="button"
            onClick={() => void reloadFromServer()}
            disabled={reloading}
            className="rounded px-2 py-1 text-xs text-red-400 hover:bg-white/10 disabled:opacity-40"
          >
            {t('canvas_retry')}
          </button>
        )}
        <button
          onClick={saveNow}
          disabled={!dirty || saveMutation.isPending || conflicted}
          title={t('canvas_save_now')}
          aria-label={t('canvas_save_now')}
          className="grid size-7 place-items-center rounded hover:bg-white/10 disabled:opacity-40"
        >
          <Save className="size-3.5" />
        </button>
      </div>

      <div className="absolute bottom-4 left-4 z-10 flex items-center gap-1 rounded-lg border border-stone-200 bg-card/90 p-1 shadow backdrop-blur dark:border-stone-800">
        <button
          aria-label={t('canvas_zoom_out')}
          onClick={() => {
            setViewport((current) => ({ ...current, zoom: Math.max(0.4, current.zoom - 0.1) }));
            markChanged();
          }}
          className="grid size-7 place-items-center rounded transition hover:bg-white/10"
        >
          <ZoomOut className="size-4" />
        </button>
        <span className="w-12 text-center text-xs tabular-nums">{Math.round(viewport.zoom * 100)}%</span>
        <button
          aria-label={t('canvas_zoom_in')}
          onClick={() => {
            setViewport((current) => ({ ...current, zoom: Math.min(2, current.zoom + 0.1) }));
            markChanged();
          }}
          className="grid size-7 place-items-center rounded transition hover:bg-white/10"
        >
          <ZoomIn className="size-4" />
        </button>
        <button
          aria-label={t('canvas_reset_view')}
          onClick={() => {
            setViewport(EMPTY_VIEWPORT);
            markChanged();
          }}
          className="grid size-7 place-items-center rounded transition hover:bg-white/10"
        >
          <Maximize className="size-4" />
        </button>
      </div>

      {active && (
        <button
          onClick={() => {
            setNodes((current) => current.filter((node) => node.id !== active));
            setActive(null);
            markChanged();
          }}
          className="absolute bottom-4 right-4 z-10 inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-card/90 px-3 py-1.5 text-xs text-red-400 shadow backdrop-blur"
        >
          <Trash2 className="size-3.5" /> {t('canvas_delete_node')}
        </button>
      )}
    </main>
  );
}
