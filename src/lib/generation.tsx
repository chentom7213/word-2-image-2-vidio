import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import type { Asset, Generation } from './types';
import { ApiClientError, generationApi, getActiveOrgId, getToken, toGeneration, type GenerationDto } from './api';
import { useAuth } from './auth';
import { generationFingerprint, releaseSubmitKey, takeSubmitKey, type PendingSubmit } from './submit-key';
import { shouldOpenTaskStream, streamCooldownRemaining } from './stream-retry';
import { uid } from './utils';
import { appendGenerationPage, HISTORY_PAGE_SIZE, mergeGenerationPage, type HistoryCursor } from './history-page';
import { deleteRefusalMessage, mergeGenerationsAfterDelete, ownsGeneration } from './delete-result';
import { unuploadedReferenceMessage } from './reference-request';
import { referenceByteMessage } from './reference-bytes';
import { promptTooLongMessage } from './prompt-length';
import { frameDimensionMessage } from './frame-dimension';
import { historyScope } from './history-scope';

type CreateInput = {
  type?: 'image' | 'video';
  prompt: string;
  modelId: string;
  modelName: string;
  resolution: string;
  width: number;
  height: number;
  duration: number;
  count?: number;
  credits: number;
  refImages: Asset[];
  refVideos: Asset[];
  refAudios: Asset[];
  visibility?: 'private' | 'org';
};

type GenCtx = {
  generations: Generation[];
  loading: boolean;
  selectedId: string | null;
  select: (id: string | null) => void;
  create: (input: CreateInput) => Promise<string>;
  remove: (ids: string[]) => Promise<void>;
  clear: () => Promise<void>;
  retry: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
};

const Ctx = createContext<GenCtx | null>(null);

/** Terminal states never need another poll or SSE channel. */
const isTerminal = (g: Generation) => g.status === 'done' || g.status === 'failed';

export function GenerationProvider({ children }: { children: ReactNode }) {
  const { user, logout, refreshUser } = useAuth();
  const location = useLocation();
  const historyType = historyScope(location.pathname);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const streams = useRef<Record<string, EventSource>>({});
  const streamCooldownUntil = useRef<Record<string, number>>({});
  const [streamTick, setStreamTick] = useState(0);
  const pendingSubmit = useRef<PendingSubmit | null>(null);
  const inflightSubmit = useRef<{ fingerprint: string; promise: Promise<string>; userId: string } | null>(null);
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const queryClient = useQueryClient();
  const workspaceId = getActiveOrgId();
  const workspaceScopeId = workspaceId ?? 'personal';
  const userScopeId = user?.id ?? 'guest';
  const seenSubmitUserId = useRef(userScopeId);
  if (seenSubmitUserId.current !== userScopeId) {
    // Before the next submit reads the previous account's key. An effect would run too late.
    // eslint-disable-next-line react-hooks/refs
    seenSubmitUserId.current = userScopeId;
    // eslint-disable-next-line react-hooks/refs
    pendingSubmit.current = null;
    if (inflightSubmit.current && inflightSubmit.current.userId !== userScopeId) {
      // eslint-disable-next-line react-hooks/refs
      inflightSubmit.current = null;
    }
  }
  const workspaceScopeRef = useRef({ id: workspaceScopeId, version: workspaceVersion, userId: userScopeId });
  // Current before an in-flight request resumes. An effect would run too late.
  // eslint-disable-next-line react-hooks/refs
  workspaceScopeRef.current = { id: workspaceScopeId, version: workspaceVersion, userId: userScopeId };
  const queryKey = useMemo(
    () => ['generations', user?.id ?? 'guest', workspaceScopeId, workspaceVersion, historyType] as const,
    [user?.id, workspaceScopeId, workspaceVersion, historyType],
  );
  const { data, isLoading, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!historyType) return { items: [], nextCursor: null };
      const page = await generationApi.list({ limit: HISTORY_PAGE_SIZE, type: historyType });
      const previous = queryClient.getQueryData<{ items: Generation[]; nextCursor: HistoryCursor | null }>(queryKey);
      const items = mergeGenerationPage(previous?.items ?? [], page.items, HISTORY_PAGE_SIZE);
      const keptOlder = items.length > page.items.length;
      return {
        items,
        nextCursor: page.items.length < HISTORY_PAGE_SIZE ? null : keptOlder ? (previous?.nextCursor ?? null) : page.nextCursor,
      };
    },
    enabled: Boolean(user) && historyType !== null,
    staleTime: 4_000,
    refetchInterval: user && historyType ? 8_000 : false,
  });
  const generations = useMemo(() => (user ? (data?.items ?? []) : []), [data, user]);
  const loading = Boolean(user) && isLoading;

  type HistoryRequest = { key: typeof queryKey; workspaceId: string; version: number; userId: string };
  const patchGenerations = useCallback(
    (key: typeof queryKey, updater: Generation[] | ((previous: Generation[]) => Generation[])) => {
      queryClient.setQueryData<{ items: Generation[]; nextCursor: HistoryCursor | null }>(
        key,
        (previous = { items: [], nextCursor: null }) => ({
          ...previous,
          items: typeof updater === 'function' ? updater(previous.items) : updater,
        }),
      );
    },
    [queryClient],
  );
  const writeGenerations = useCallback(
    (request: HistoryRequest, updater: Generation[] | ((previous: Generation[]) => Generation[])) => {
      patchGenerations(request.key, updater);
      return (
        workspaceScopeRef.current.id === request.workspaceId &&
        workspaceScopeRef.current.version === request.version &&
        workspaceScopeRef.current.userId === request.userId
      );
    },
    [patchGenerations],
  );

  const refresh = useCallback(async () => {
    const startedUserId = workspaceScopeRef.current.userId;
    const startedToken = getToken();
    if (startedUserId === 'guest') return;
    const result = await refetch();
    if (workspaceScopeRef.current.userId !== startedUserId) return;
    const currentToken = getToken();
    if (currentToken && currentToken !== startedToken) return;
    if (result.error instanceof ApiClientError && result.error.status === 401) logout();
  }, [logout, refetch]);

  // Subscribe to a single task's progress via SSE. Auto-closes on terminal state.
  const subscribe = useCallback(
    (id: string) => {
      if (streams.current[id]) return;
      const url = generationApi.streamUrl(id);
      if (!getToken()) return;
      const requestKey = queryKey;

      // `withCredentials` lets the httpOnly refresh cookie authenticate the
      // stream, so the JWT never has to travel in the URL.
      const es = new EventSource(url, { withCredentials: true });
      streams.current[id] = es;
      const close = () => {
        es.close();
        delete streams.current[id];
      };

      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data) as { item?: GenerationDto; done?: boolean };
          if (data.item) {
            const item = toGeneration(data.item);
            patchGenerations(requestKey, (prev) => prev.map((g) => (g.id === id ? item : g)));
          }
          if (data.done) {
            close();
            void refreshUser();
          }
        } catch {
          /* ignore malformed frame */
        }
      };
      es.onerror = () => {
        // Drop the socket and let the 8s list poll carry this task. Reopening
        // immediately turns a dead stream into a reconnect loop.
        close();
        streamCooldownUntil.current[id] = Date.now() + 8_000;
        void refresh();
      };
    },
    [patchGenerations, queryKey, refresh, refreshUser],
  );

  // Account changes are keyed by id. A profile refresh replaces the user
  // object but keeps the id, so the open progress stream and history cache
  // stay. A different id, including logout, drops the selection and sockets.
  // The generations cache is removed only when nobody is signed in. In-flight
  // HTTP requests are left to finish.
  const userId = user?.id ?? null;
  useEffect(() => {
    setSelectedId(null);
    Object.values(streams.current).forEach((es) => es.close());
    streams.current = {};
    streamCooldownUntil.current = {};
    if (!userId) queryClient.removeQueries({ queryKey: ['generations'] });
  }, [queryClient, userId]);

  // A workspace switch changes the server-side visibility scope.  Clear old
  // selections/streams before reloading so private history never lingers in UI.
  useEffect(() => {
    const onWorkspaceChange = () => {
      Object.values(streams.current).forEach((es) => es.close());
      streams.current = {};
      streamCooldownUntil.current = {};
      setSelectedId(null);
      setWorkspaceVersion((version) => version + 1);
    };
    window.addEventListener('benchu:workspace-change', onWorkspaceChange);
    return () => window.removeEventListener('benchu:workspace-change', onWorkspaceChange);
  }, []);

  // Drop the other studio's progress sockets when the history kind changes.
  // Selection stays, so switching pages does not forget the open task.
  useEffect(() => {
    for (const id of Object.keys(streams.current)) {
      streams.current[id].close();
      delete streams.current[id];
    }
    for (const id of Object.keys(streamCooldownUntil.current)) {
      delete streamCooldownUntil.current[id];
    }
  }, [historyType]);

  // Whenever the list changes, ensure every in-flight task has an SSE channel.
  // A task that just lost its stream waits out the cooldown and rides the poll.
  useEffect(() => {
    if (!user || !historyType) return;
    const now = Date.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const g of generations) {
      const terminal = isTerminal(g);
      if (terminal) delete streamCooldownUntil.current[g.id];
      if (terminal && streams.current[g.id]) {
        streams.current[g.id].close();
        delete streams.current[g.id];
      }
      const cooldownUntil = streamCooldownUntil.current[g.id] ?? 0;
      if (
        shouldOpenTaskStream({
          terminal,
          open: Boolean(streams.current[g.id]),
          cooldownUntil,
          now,
        })
      ) {
        subscribe(g.id);
      }
      const remaining = streamCooldownRemaining(cooldownUntil, now);
      if (!terminal && remaining > 0) earliest = Math.min(earliest, remaining);
    }
    if (earliest === Number.POSITIVE_INFINITY) return;
    const timer = window.setTimeout(() => setStreamTick((value) => value + 1), earliest);
    return () => window.clearTimeout(timer);
  }, [generations, historyType, user, subscribe, streamTick]);

  useEffect(() => {
    const store = streams.current;
    return () => {
      Object.values(store).forEach((es) => es.close());
    };
  }, []);

  const create = useCallback(
    async (input: CreateInput) => {
      const allRefs = [...input.refImages, ...input.refVideos, ...input.refAudios];
      const unuploaded = unuploadedReferenceMessage(allRefs);
      if (unuploaded) throw new Error(unuploaded);
      const tooLarge = referenceByteMessage(allRefs);
      if (tooLarge) throw new Error(tooLarge);
      const tooLong = promptTooLongMessage(input.prompt);
      if (tooLong) throw new Error(tooLong);
      const badDimension = frameDimensionMessage(input.width, input.height);
      if (badDimension) throw new Error(badDimension);
      const refAssetIds = allRefs
        .filter((a) => a.id && !a.url.startsWith('blob:') && !a.url.startsWith('data:'))
        .map((a) => a.id);
      const fingerprint = generationFingerprint({
        type: input.type,
        prompt: input.prompt || '未命名生成',
        modelId: input.modelId,
        resolution: input.resolution,
        width: input.width,
        height: input.height,
        duration: input.duration,
        count: input.count,
        visibility: input.visibility,
        refIds: refAssetIds,
      });
      if (
        inflightSubmit.current?.fingerprint === fingerprint &&
        inflightSubmit.current.userId === userScopeId
      ) {
        return inflightSubmit.current.promise;
      }
      const taken = takeSubmitKey(pendingSubmit.current, fingerprint, `gen-${uid()}`);
      pendingSubmit.current = taken.pending;
      const idempotencyKey = taken.key;
      const request: HistoryRequest = {
        key: queryKey,
        workspaceId: workspaceScopeId,
        version: workspaceVersion,
        userId: userScopeId,
      };
      const promise = (async () => {
        const item = await generationApi.create(
          {
            type: input.type ?? 'video',
            prompt: input.prompt || '未命名生成',
            modelId: input.modelId,
            modelName: input.modelName,
            resolution: input.resolution,
            width: input.width,
            height: input.height,
            duration: input.duration,
            count: input.count ?? 1,
            credits: input.credits,
            refAssetIds,
            visibility: input.visibility ?? 'private',
          },
          idempotencyKey,
        );
        pendingSubmit.current = releaseSubmitKey(pendingSubmit.current, fingerprint, idempotencyKey);
        const stillCurrent = writeGenerations(request, (prev) => [item, ...prev.filter((g) => g.id !== item.id)]);
        if (stillCurrent) setSelectedId(item.id);
        void refreshUser();
        return item.id;
      })();
      inflightSubmit.current = { fingerprint, promise, userId: userScopeId };
      try {
        return await promise;
      } finally {
        if (inflightSubmit.current?.promise === promise) inflightSubmit.current = null;
      }
    },
    [queryKey, refreshUser, userScopeId, workspaceScopeId, workspaceVersion, writeGenerations],
  );

  const remove = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const request: HistoryRequest = {
        key: queryKey,
        workspaceId: workspaceScopeId,
        version: workspaceVersion,
        userId: userScopeId,
      };
      const target = generations.filter((g) => ids.includes(g.id));
      const blocked = deleteRefusalMessage(target.filter((g) => !isTerminal(g)));
      if (blocked) throw new Error(blocked);
      const snapshot = generations;
      const previousSelectedId = selectedId;
      writeGenerations(request, (prev) => prev.filter((g) => !ids.includes(g.id)));
      if (previousSelectedId && ids.includes(previousSelectedId)) setSelectedId(null);
      let result: { ok: boolean; deletedIds?: string[] };
      try {
        if (ids.length === 1) result = await generationApi.remove(ids[0]);
        else result = await generationApi.bulkRemove(ids);
      } catch (err) {
        const stillCurrent = writeGenerations(request, (current) =>
          mergeGenerationsAfterDelete(snapshot, current, ids, { ok: false }),
        );
        if (stillCurrent) setSelectedId(previousSelectedId);
        throw err;
      }
      let next = snapshot;
      const stillCurrent = writeGenerations(request, (current) => {
        next = mergeGenerationsAfterDelete(snapshot, current, ids, result);
        return next;
      });
      if (stillCurrent && previousSelectedId && next.some((item) => item.id === previousSelectedId)) {
        setSelectedId(previousSelectedId);
      }
      const refusal = deleteRefusalMessage(next.filter((item) => ids.includes(item.id)));
      if (refusal) throw new Error(refusal);
    },
    [generations, queryKey, selectedId, userScopeId, workspaceScopeId, workspaceVersion, writeGenerations],
  );

  const clear = useCallback(async () => {
    const request: HistoryRequest = {
      key: queryKey,
      workspaceId: workspaceScopeId,
      version: workspaceVersion,
      userId: userScopeId,
    };
    const removable = generations.filter((g) => isTerminal(g) && ownsGeneration(g)).map((g) => g.id);
    if (removable.length === 0) return;
    const snapshot = generations;
    const previousSelectedId = selectedId;
    writeGenerations(request, (prev) => prev.filter((g) => !removable.includes(g.id)));
    setSelectedId(null);
    let result: { ok: boolean; deletedIds?: string[] };
    try {
      result = await generationApi.bulkRemove(removable);
    } catch (err) {
      const stillCurrent = writeGenerations(request, (current) =>
        mergeGenerationsAfterDelete(snapshot, current, removable, { ok: false }),
      );
      if (stillCurrent) setSelectedId(previousSelectedId);
      throw err;
    }
    let next = snapshot;
    const stillCurrent = writeGenerations(request, (current) => {
      next = mergeGenerationsAfterDelete(snapshot, current, removable, result);
      return next;
    });
    if (stillCurrent && previousSelectedId && next.some((item) => item.id === previousSelectedId)) {
      setSelectedId(previousSelectedId);
    }
    const refusal = deleteRefusalMessage(next.filter((item) => removable.includes(item.id)));
    if (refusal) throw new Error(refusal);
  }, [generations, queryKey, selectedId, userScopeId, workspaceScopeId, workspaceVersion, writeGenerations]);

  const retry = useCallback(
    async (id: string) => {
      const request: HistoryRequest = {
        key: queryKey,
        workspaceId: workspaceScopeId,
        version: workspaceVersion,
        userId: userScopeId,
      };
      try {
        const item = await generationApi.retry(id);
        const stillCurrent = writeGenerations(request, (prev) => prev.map((g) => (g.id === id ? item : g)));
        if (stillCurrent) subscribe(id);
        void refreshUser();
      } catch (err) {
        let message = '重试失败';
        if (err instanceof ApiClientError) message = err.message;
        else if (err instanceof Error) message = err.message;
        writeGenerations(request, (prev) => prev.map((g) => (g.id === id ? { ...g, error: message } : g)));
      }
    },
    [queryKey, refreshUser, subscribe, userScopeId, workspaceScopeId, workspaceVersion, writeGenerations],
  );

  const loadingMore = useRef(false);
  const earlierLoad = useRef(0);
  // Retire an in-flight earlier page when the history query key changes.
  const earlierScope = JSON.stringify(queryKey);
  const earlierScopeSeen = useRef(earlierScope);
  if (earlierScopeSeen.current !== earlierScope) {
    earlierScopeSeen.current = earlierScope;
    loadingMore.current = false;
    earlierLoad.current += 1;
  }
  const loadMore = useCallback(async () => {
    if (!user || !historyType || loadingMore.current) return;
    const current = queryClient.getQueryData<{ items: Generation[]; nextCursor: HistoryCursor | null }>(queryKey);
    const cursor = current?.nextCursor;
    if (!cursor) return;
    loadingMore.current = true;
    const requestId = ++earlierLoad.current;
    const requestKey = queryKey;
    const requestType = historyType;
    try {
      const page = await generationApi.list({
        limit: HISTORY_PAGE_SIZE,
        type: requestType,
        before: cursor.createdAt,
        beforeId: cursor.id,
      });
      if (requestId !== earlierLoad.current) return;
      queryClient.setQueryData<{ items: Generation[]; nextCursor: HistoryCursor | null }>(requestKey, (previous) => ({
        items: appendGenerationPage(previous?.items ?? [], page.items),
        nextCursor: page.nextCursor,
      }));
    } catch (err) {
      if (requestId !== earlierLoad.current) return;
      throw err;
    } finally {
      if (requestId === earlierLoad.current) loadingMore.current = false;
    }
  }, [historyType, queryClient, queryKey, user]);

  const cancel = useCallback(
    async (id: string) => {
      const request: HistoryRequest = {
        key: queryKey,
        workspaceId: workspaceScopeId,
        version: workspaceVersion,
        userId: userScopeId,
      };
      const { item } = await generationApi.cancel(id);
      writeGenerations(request, (prev) => prev.map((g) => (g.id === id ? item : g)));
      void refreshUser();
    },
    [queryKey, refreshUser, userScopeId, workspaceScopeId, workspaceVersion, writeGenerations],
  );

  return (
    <Ctx.Provider
      value={{
        generations,
        loading,
        selectedId,
        select: setSelectedId,
        create,
        remove,
        clear,
        retry,
        cancel,
        refresh,
        loadMore,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useGenerations() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useGenerations must be used within GenerationProvider');
  return ctx;
}
