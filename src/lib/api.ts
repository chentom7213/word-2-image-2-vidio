import { assetFilenameTooLongMessage } from './asset-filename';
import type { Asset, CanvasDocument, CanvasNode, CanvasViewport, Generation, ModelOption } from './types';

/** Backend base URL. Override with VITE_API_BASE if the API runs elsewhere. */
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') || '';

const TOKEN_KEY = 'infinite-canvas:auth_token';
const ACTIVE_ORG_KEY = 'infinite-canvas:active_org_id';

/** The active workspace is sent on authenticated API calls.  It is only a UX
 * preference: the server still validates membership for every request. */
export function getActiveOrgId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_ORG_KEY);
  } catch {
    return null;
  }
}

export function setActiveOrgId(orgId: string | null) {
  try {
    if (orgId) localStorage.setItem(ACTIVE_ORG_KEY, orgId);
    else localStorage.removeItem(ACTIVE_ORG_KEY);
  } catch {
    /* ignore unavailable storage */
  }
  window.dispatchEvent(new Event('benchu:workspace-change'));
}

/** Drop the stored workspace without notifying listeners. Used while another component is rendering. */
export function clearActiveOrgStorage() {
  try {
    localStorage.removeItem(ACTIVE_ORG_KEY);
  } catch {
    /* ignore unavailable storage */
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiClientError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = 'ERROR') {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

type RequestOpts = {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  body?: unknown;
  auth?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Internal: set once a 401-triggered refresh replay has been attempted. */
  _retried?: boolean;
};

export async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = opts;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';

  const token = auth ? getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  const activeOrgId = auth ? getActiveOrgId() : null;
  if (activeOrgId && !headers['X-Org-Id']) headers['X-Org-Id'] = activeOrgId;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      // The refresh cookie must travel with the request; credentials are
      // required because the API may live on a different origin in prod.
      credentials: 'include',
      signal: opts.signal,
      body: isForm ? (body as FormData) : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiClientError('无法连接服务器，请确认后端已启动', 0, 'NETWORK');
  }

  // Access token expired → try one transparent refresh, then replay the request.
  if (res.status === 401 && auth && token && !opts._retried) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return request<T>(path, { ...opts, _retried: true } as RequestOpts);
    }
  }

  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const message = data?.message || data?.error || `请求失败 (${res.status})`;
    throw new ApiClientError(message, res.status, data?.error || 'ERROR');
  }
  return data as T;
}

/** Single-flight refresh so a burst of 401s produces one token exchange. */
let refreshInflight: Promise<boolean> | null = null;
let refreshController: AbortController | null = null;
const sessionWrites = new Set<AbortController>();

/** Drops in-flight refresh, password, and account-close responses before a new login. */
export function cancelStaleSessionResponses() {
  refreshController?.abort();
  for (const controller of sessionWrites) controller.abort();
  sessionWrites.clear();
}

function trackSessionWrite(): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  sessionWrites.add(controller);
  return { signal: controller.signal, done: () => sessionWrites.delete(controller) };
}

export function tryRefresh(): Promise<boolean> {
  if (refreshInflight) return refreshInflight;
  const startedToken = getToken();
  const controller = new AbortController();
  refreshController = controller;
  refreshInflight = (async () => {
    try {
      const headers: Record<string, string> = {};
      if (startedToken) headers.Authorization = `Bearer ${startedToken}`;
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers,
        signal: controller.signal,
      });
      if (getToken() !== startedToken) return false;
      if (!res.ok) {
        setToken(null);
        return false;
      }
      const data = (await res.json()) as { token?: string };
      if (getToken() !== startedToken) return false;
      if (!data.token) {
        setToken(null);
        return false;
      }
      setToken(data.token);
      return true;
    } catch {
      return false;
    } finally {
      if (refreshController === controller) refreshController = null;
      refreshInflight = null;
    }
  })();
  return refreshInflight;
}

/** Turn a relative `/media/...` or `/uploads/...` URL into an absolute one. */
export function assetUrl(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return url;
  return `${API_BASE}${url}`;
}

// ---- DTOs -------------------------------------------------------------

export type ApiUser = {
  id: string;
  email: string;
  displayName: string | null;
  credits: number;
  createdAt: string;
  /** False only for an enterprise account that has not chosen a local password. */
  passwordSet?: boolean;
};

type RefDto = { id: string; kind: Asset['kind']; name: string; url: string; size: number };

type OutputDto = {
  id: string;
  kind: 'image' | 'video' | 'poster' | 'sprite' | 'audio' | 'thumbnail';
  url: string | null;
  mime: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  bytes: number | null;
  watermarked: boolean;
};

export type GenerationDto = {
  id: string;
  mine?: boolean;
  visibility?: 'private' | 'org';
  type: 'image' | 'video';
  prompt: string;
  modelId: string;
  modelName: string;
  resolution: string | null;
  width: number;
  height: number;
  duration: number;
  count: number;
  status: Generation['status'];
  progress: number;
  seed: string;
  resultUrl: string | null;
  posterUrl?: string | null;
  outputs?: OutputDto[];
  credits: number;
  error: string | null;
  errorCode?: string | null;
  refunded?: boolean;
  createdAt: number;
  finishedAt?: number | null;
  refImages?: RefDto[];
  refVideos?: RefDto[];
  refAudios?: RefDto[];
};

function toRefAsset(r: RefDto): Asset {
  return { id: r.id, kind: r.kind, name: r.name, url: assetUrl(r.url), size: Number(r.size) };
}

/** Normalize every generation payload, including SSE frames, at one boundary. */
export function toGeneration(d: GenerationDto): Generation {
  const outputs = (d.outputs ?? [])
    .filter((o) => o.url)
    .map((o) => ({
      id: o.id,
      kind: o.kind,
      url: assetUrl(o.url!),
      mime: o.mime,
      width: o.width,
      height: o.height,
      duration: o.duration,
      bytes: o.bytes,
      watermarked: o.watermarked,
    }));

  return {
    id: d.id,
    mine: d.mine !== false,
    visibility: d.visibility ?? 'private',
    type: d.type,
    prompt: d.prompt,
    modelId: d.modelId,
    modelName: d.modelName,
    resolution: d.resolution ?? '',
    width: Number(d.width),
    height: Number(d.height),
    duration: Number(d.duration),
    count: Number(d.count) || 1,
    status: d.status,
    progress: Number(d.progress),
    seed: d.seed,
    credits: Number(d.credits),
    error: d.error ?? undefined,
    errorCode: d.errorCode ?? null,
    refunded: Boolean(d.refunded),
    createdAt: Number(d.createdAt),
    finishedAt: d.finishedAt ?? null,
    outputs,
    posterUrl: d.posterUrl ? assetUrl(d.posterUrl) : null,
    refImages: (d.refImages ?? []).map(toRefAsset),
    refVideos: (d.refVideos ?? []).map(toRefAsset),
    refAudios: (d.refAudios ?? []).map(toRefAsset),
  };
}

type AssetDto = {
  id: string;
  kind: Asset['kind'];
  name: string;
  url: string;
  size: number;
  mime?: string | null;
  createdAt?: number;
};

function toAsset(a: AssetDto): Asset {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    url: assetUrl(a.url),
    size: Number(a.size),
    createdAt: Number(a.createdAt) || undefined,
  };
}

// ---- Auth -------------------------------------------------------------

export const authApi = {
  login: (email: string, password: string, signal?: AbortSignal) =>
    request<{ token: string; user: ApiUser }>('/api/auth/login', {
      method: 'POST',
      auth: false,
      signal,
      body: { email, password },
    }),
  register: (email: string, password: string, signal?: AbortSignal) =>
    request<{ token: string; user: ApiUser }>('/api/auth/register', {
      method: 'POST',
      auth: false,
      signal,
      body: { email, password },
    }),
  me: () => request<{ user: ApiUser }>('/api/auth/me'),
  /** Exchange the httpOnly refresh cookie for a new access token. */
  refresh: () =>
    request<{ token: string; user: ApiUser }>('/api/auth/refresh', {
      method: 'POST',
      auth: false,
    }),
  logout: (token: string | null, signal?: AbortSignal) =>
    request<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST',
      auth: false,
      signal,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }),
  logoutAll: () => request<{ ok: boolean }>('/api/auth/logout-all', { method: 'POST' }),
  sessions: () =>
    request<{
      count: number;
      items: Array<{ id: string; createdAt: string; ip: string | null; userAgent: string | null; current: boolean }>;
    }>('/api/auth/sessions'),
  revokeSession: (id: string) => request<{ ok: boolean }>(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  changePassword: async (newPassword: string, currentPassword?: string) => {
    const tracked = trackSessionWrite();
    try {
      return await request<{ ok: boolean }>('/api/auth/password', {
        method: 'POST',
        signal: tracked.signal,
        body: currentPassword ? { currentPassword, newPassword } : { newPassword },
      });
    } finally {
      tracked.done();
    }
  },
  closeAccount: async (password: string) => {
    const tracked = trackSessionWrite();
    try {
      return await request<{ ok: boolean }>('/api/account/close', {
        method: 'POST',
        signal: tracked.signal,
        body: { password },
      });
    } finally {
      tracked.done();
    }
  },
  oidcConfig: () => request<{ enabled: boolean }>('/api/auth/oidc/config', { auth: false }),
};

// ---- Models -----------------------------------------------------------

export const modelApi = {
  list: async (kind?: 'image' | 'video'): Promise<ModelOption[]> => {
    const qs = kind ? `?kind=${kind}` : '';
    const { items } = await request<{ items: ModelOption[] }>(`/api/models${qs}`, { auth: false });
    return items;
  },
};

// ---- Generations ------------------------------------------------------

export type CreateGenerationInput = {
  type: 'image' | 'video';
  prompt: string;
  modelId: string;
  modelName: string;
  resolution?: string;
  width: number;
  height: number;
  duration: number;
  count?: number;
  credits?: number;
  seed?: string;
  refAssetIds?: string[];
  /** `org` is read-only to members of the selected X-Org-Id workspace. */
  visibility?: 'private' | 'org';
};

export const generationApi = {
  list: async (options?: { type?: 'image' | 'video'; limit?: number; before?: string; beforeId?: string }) => {
    const params = new URLSearchParams();
    if (options?.type) params.set('type', options.type);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.before && options.beforeId) {
      params.set('before', options.before);
      params.set('beforeId', options.beforeId);
    }
    const query = params.toString();
    const qs = query ? `?${query}` : '';
    const { items, nextCursor } = await request<{
      items: GenerationDto[];
      nextCursor?: { createdAt: string; id: string } | null;
    }>(`/api/generations${qs}`);
    return { items: items.map(toGeneration), nextCursor: nextCursor ?? null };
  },
  create: async (input: CreateGenerationInput, idempotencyKey?: string) => {
    const { item } = await request<{ item: GenerationDto }>('/api/generations', {
      method: 'POST',
      body: input,
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    });
    return toGeneration(item);
  },
  /** SSE stream URL for a task. The session cookie authenticates the
   *  connection, so no token ever appears in a URL. */
  streamUrl: (id: string) => {
    const activeOrgId = getActiveOrgId();
    const query = activeOrgId ? `?orgId=${encodeURIComponent(activeOrgId)}` : '';
    return `${API_BASE}/api/generations/${id}/stream${query}`;
  },
  retry: async (id: string) => {
    const { item } = await request<{ item: GenerationDto }>(`/api/generations/${id}/retry`, {
      method: 'POST',
    });
    return toGeneration(item);
  },
  cancel: async (id: string) => {
    const res = await request<{ item: GenerationDto; cancelled: boolean }>(`/api/generations/${id}/cancel`, {
      method: 'POST',
    });
    return { item: toGeneration(res.item), cancelled: res.cancelled };
  },
  remove: (id: string) =>
    request<{ ok: boolean; reason?: string }>(`/api/generations/${id}`, { method: 'DELETE' }),
  bulkRemove: (ids: string[]) =>
    request<{ ok: boolean; deleted: number; deletedIds?: string[] }>('/api/generations/bulk-delete', {
      method: 'POST',
      body: { ids },
    }),
};

// ---- Assets -----------------------------------------------------------

export const MAX_ASSET_UPLOAD_BYTES = 50 * 1024 * 1024;
export const DIRECT_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;

export function resolveUploadUrl(uploadUrl: string): string {
  if (/^https?:\/\//i.test(uploadUrl)) return uploadUrl;
  if (!uploadUrl.startsWith('/')) throw new ApiClientError('上传地址无效', 500, 'INVALID_UPLOAD_URL');
  return `${API_BASE}${uploadUrl}`;
}

async function uploadMultipart(file: File) {
  const form = new FormData();
  form.append('file', file);
  const { item } = await request<{ item: AssetDto }>('/api/assets', { method: 'POST', body: form });
  return toAsset(item);
}

async function uploadDirect(file: File) {
  if (file.size > MAX_ASSET_UPLOAD_BYTES) {
    throw new ApiClientError('文件超过 50MB 限制', 413, 'FILE_TOO_LARGE');
  }
  const filenameMessage = assetFilenameTooLongMessage(file.name);
  if (filenameMessage) throw new ApiClientError(filenameMessage, 400, 'FILENAME_TOO_LONG');
  const mime = file.type || 'application/octet-stream';
  const sign = await request<{
    uploadUrl: string;
    objectKey: string;
    headers: Record<string, string>;
    kind: string;
    method: 'PUT';
    confirmToken: string;
  }>('/api/assets/sign', {
    method: 'POST',
    body: { filename: file.name, mime, size: file.size },
  });
  const headers = { ...sign.headers };
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = mime;
  }
  const put = await fetch(resolveUploadUrl(sign.uploadUrl), {
    method: sign.method,
    headers,
    body: file,
  });
  if (!put.ok) throw new ApiClientError('直传失败', put.status, 'DIRECT_UPLOAD_FAILED');
  const { item } = await request<{ item: AssetDto }>('/api/assets/confirm', {
    method: 'POST',
    body: { confirmToken: sign.confirmToken },
  });
  return toAsset(item);
}

type UploadCapabilities = {
  maxBytes: number;
  directSupported: boolean;
  directRecommended: boolean;
  thresholdBytes: number;
};

let uploadCapabilitiesPromise: Promise<UploadCapabilities | null> | null = null;

function uploadCapabilities() {
  uploadCapabilitiesPromise ??= request<UploadCapabilities>('/api/assets/upload-capabilities').catch(() => null);
  return uploadCapabilitiesPromise;
}

export const assetApi = {
  list: async (kind?: 'image' | 'video' | 'audio') => {
    const page = await assetApi.listPage(kind ? { kind } : undefined);
    return page.items;
  },
  listPage: async (options?: {
    kind?: 'image' | 'video' | 'audio';
    limit?: number;
    before?: string;
    beforeId?: string;
  }) => {
    const params = new URLSearchParams();
    if (options?.kind) params.set('kind', options.kind);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.before && options.beforeId) {
      params.set('before', options.before);
      params.set('beforeId', options.beforeId);
    }
    const query = params.toString();
    const { items, nextCursor } = await request<{
      items: AssetDto[];
      nextCursor?: { createdAt: string; id: string } | null;
    }>(`/api/assets${query ? `?${query}` : ''}`);
    return { items: items.map(toAsset), nextCursor: nextCursor ?? null };
  },
  upload: async (file: File) => {
    if (file.size > MAX_ASSET_UPLOAD_BYTES) {
      throw new ApiClientError('文件超过 50MB 限制', 413, 'FILE_TOO_LARGE');
    }
    const filenameMessage = assetFilenameTooLongMessage(file.name);
    if (filenameMessage) throw new ApiClientError(filenameMessage, 400, 'FILENAME_TOO_LONG');
    if (file.size < DIRECT_UPLOAD_THRESHOLD_BYTES) return uploadMultipart(file);
    const capabilities = await uploadCapabilities();
    if (capabilities?.directSupported && capabilities.directRecommended && file.size >= capabilities.thresholdBytes) {
      return uploadDirect(file);
    }
    return uploadMultipart(file);
  },
  /** Direct-to-store upload: sign, PUT to the object store, then confirm. */
  uploadDirect,
  remove: (id: string) => request<{ ok: boolean }>(`/api/assets/${id}`, { method: 'DELETE' }),
};

// ---- Canvas -----------------------------------------------------------

export const canvasApi = {
  current: async () => {
    const { item } = await request<{ item: CanvasDocument | null }>('/api/canvas');
    return item;
  },
  save: async (input: { version: number; nodes: CanvasNode[]; viewport: CanvasViewport }) => {
    const { item } = await request<{ item: CanvasDocument }>('/api/canvas', {
      method: 'PUT',
      body: input,
    });
    return item;
  },
};

// ---- Organizations & API Keys -----------------------------------------

export type OrgRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type Organization = {
  id: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  credits: number;
  role: OrgRole;
};

export type OrgMember = {
  userId: string;
  email: string;
  displayName: string | null;
  role: OrgRole;
  createdAt: string;
};

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  rateLimit: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export const orgApi = {
  list: async () => {
    const { items } = await request<{ items: Organization[] }>('/api/orgs');
    return items;
  },
  create: (name: string) => request<{ id: string }>('/api/orgs', { method: 'POST', body: { name } }),
  members: async (orgId: string) => {
    const { items } = await request<{ items: OrgMember[] }>(`/api/orgs/${orgId}/members`, {
      headers: { 'X-Org-Id': orgId },
    });
    return items;
  },
  invite: (orgId: string, email: string, role: Exclude<OrgRole, 'owner'>) =>
    request<{ userId: string }>(`/api/orgs/${orgId}/members`, {
      method: 'POST',
      body: { email, role },
      headers: { 'X-Org-Id': orgId },
    }),
  setRole: (orgId: string, userId: string, role: Exclude<OrgRole, 'owner'>) =>
    request<{ ok: boolean }>(`/api/orgs/${orgId}/members/${userId}`, {
      method: 'PATCH',
      body: { role },
      headers: { 'X-Org-Id': orgId },
    }),
  removeMember: (orgId: string, userId: string) =>
    request<{ ok: boolean }>(`/api/orgs/${orgId}/members/${userId}`, {
      method: 'DELETE',
      headers: { 'X-Org-Id': orgId },
    }),
};

export const apiKeyApi = {
  list: async (orgId: string) => {
    const { items } = await request<{ items: ApiKey[] }>('/api/api-keys', {
      headers: { 'X-Org-Id': orgId },
    });
    return items;
  },
  create: (orgId: string, input: { name: string; scopes: string[]; rateLimit?: number }) =>
    request<{ id: string; key: string; prefix: string }>('/api/api-keys', {
      method: 'POST',
      body: input,
      headers: { 'X-Org-Id': orgId },
    }),
  revoke: (orgId: string, id: string) =>
    request<{ ok: boolean }>(`/api/api-keys/${id}`, {
      method: 'DELETE',
      headers: { 'X-Org-Id': orgId },
    }),
};

// ---- Billing ----------------------------------------------------------
export type PlanDto = {
  id: string;
  name: string;
  priceCents: number;
  monthlyCredits: number | null;
  maxConcurrent: number;
  maxDuration: number;
  rpm: number;
  features: Record<string, unknown>;
  sortWeight: number;
};

export type CreditPackDto = {
  id: string;
  name: string;
  credits: number;
  priceCents: number;
  bonus: number;
  sortWeight: number;
};

export type OrderDto = {
  id: string;
  kind: 'plan' | 'credits';
  skuId: string;
  skuName: string;
  amountCents: number;
  credits: number;
  status: 'pending' | 'paid' | 'failed' | 'refunded' | 'expired';
  provider: string | null;
  paidAt: number | null;
  expiresAt: number;
  createdAt: number;
};

export type SubscriptionDto = {
  plan: PlanDto;
  activeTasks: number;
  concurrencyLeft: number;
  planId: string;
  planExpiresAt: number | null;
};

export const billingApi = {
  catalogue: () =>
    request<{
      plans: PlanDto[];
      packs: CreditPackDto[];
      gateway: { provider: string; configured: boolean; mock: boolean };
    }>('/api/billing/catalogue', { auth: false }),
  subscription: () => request<SubscriptionDto>('/api/billing/subscription'),
  orders: () => request<{ items: OrderDto[] }>('/api/billing/orders').then((r) => r.items),
  checkout: (kind: 'plan' | 'credits', skuId: string, idempotencyKey: string) =>
    request<{ item: OrderDto; payUrl: string | null; idempotent?: boolean }>('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: { kind, skuId },
    }),
  /** Dev-only: simulates the gateway's "paid" webhook for the mock provider. */
  mockPay: (orderId: string) =>
    request<{ ok: boolean; outcome: string }>('/api/billing/mock/pay', {
      method: 'POST',
      body: { orderId },
    }),
};

// ---- Admin / operations -----------------------------------------------
export type AdminStats = {
  window: string;
  tasks: {
    total: number;
    queued: number;
    running: number;
    done: number;
    failed: number;
    successRate: number | null;
    creditsCharged: number;
    creditsRefunded: number;
  };
  credits: { granted: number; spent: number; activeUsers: number };
  topErrors: { code: string; count: number }[];
  topModels: { modelId: string; calls: number; credits: number }[];
};

export type AuditEntry = {
  id: number;
  userId: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  ua: string | null;
  meta: unknown;
  createdAt: string;
};

export type AdminModel = {
  id: string;
  provider: string;
  displayName: string;
  kind: 'image' | 'video';
  priceUnit: 'per_second' | 'per_call' | 'per_image';
  priceAmount: number;
  maxDuration: number | null;
  providerModel: string;
  enabled: boolean;
  sortWeight: number;
};

export type AdminOrder = OrderDto & { userId: string };

export const adminApi = {
  stats: () => request<AdminStats>('/api/admin/stats'),
  reconcile: () =>
    request<{
      ok: boolean;
      balanceDrift: { userId: string; email: string; credits: number; ledgerTotal: number }[];
      doubleCharged: { taskId: string; rows: number }[];
      unrefundedFailures: { taskId: string; cost: number; code: string | null; createdAt: string }[];
    }>('/api/admin/reconcile'),
  billingReconcile: () =>
    request<{
      ok: boolean;
      counts?: { creditMismatch: number; paidWithoutWebhook: number };
      creditMismatch: { orderId: string; skuId: string; ordered: number; credited: number }[];
      paidWithoutWebhook: { orderId: string; skuId: string }[];
    }>('/api/admin/billing/reconcile'),
  audit: (params: { limit?: number; action?: string; target?: string; before?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.action) qs.set('action', params.action);
    if (params.target) qs.set('target', params.target);
    if (params.before) qs.set('before', params.before);
    return request<{ items: AuditEntry[]; nextCursor: string | null }>(
      `/api/admin/audit${qs.toString() ? `?${qs}` : ''}`,
    );
  },
  models: async () => {
    const { items } = await request<{ items: AdminModel[] }>('/api/admin/models');
    return items;
  },
  updateModel: (
    id: string,
    patch: Partial<
      Pick<
        AdminModel,
        'displayName' | 'priceAmount' | 'priceUnit' | 'maxDuration' | 'enabled' | 'sortWeight' | 'providerModel'
      >
    >,
  ) =>
    request<{ item: Partial<AdminModel> }>(`/api/admin/models/${id}`, {
      method: 'PATCH',
      body: patch,
    }),
  orders: (
    params: {
      limit?: number;
      status?: OrderDto['status'];
      before?: string;
      beforeId?: string;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.status) qs.set('status', params.status);
    if (params.before) qs.set('before', params.before);
    if (params.beforeId) qs.set('beforeId', params.beforeId);
    const query = qs.toString();
    return request<{
      items: AdminOrder[];
      totals: { paidCount: number; revenueCents: number; creditsSold: number };
      nextCursor?: { createdAt: string; id: string } | null;
    }>(`/api/admin/orders${query ? `?${query}` : ''}`).then((page) => ({
      items: page.items,
      totals: page.totals,
      nextCursor: page.nextCursor ?? null,
    }));
  },
};

// ---- Credits ----------------------------------------------------------
export type CreditTx = {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  refId: string | null;
  createdAt: number;
};

export const creditApi = {
  balance: () => request<{ credits: number }>('/api/credits/balance'),
  transactions: async () => {
    const { items } = await request<{ items: CreditTx[] }>('/api/credits/transactions');
    return items;
  },
  summary: () => request<{ balance: number; gained: number; spent: number; refunded: number }>('/api/credits/summary'),
};
