import { signedUrl } from '../services/storage.js';
import type { OutputRow, TaskRow } from '../services/pipeline.js';
import { outputDtos } from '../services/pipeline.js';

/**
 * Assets store either an object key (current) or a legacy `/uploads/...` path.
 * Only object keys need signing; the legacy path is already servable as-is.
 */
export function resolveAssetUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('/') || /^https?:\/\//i.test(url)) return url;
  return signedUrl(url) ?? url;
}

export type RefAsset = { id: string; kind: string; name: string; url: string; size: number };
export type RefRow = {
  task_id: string;
  id: string;
  kind: 'image' | 'video' | 'audio';
  filename: string;
  url: string;
  size: number;
};

export type RefBucket = { images: RefAsset[]; videos: RefAsset[]; audios: RefAsset[] };

export function emptyRefs(): RefBucket {
  return { images: [], videos: [], audios: [] };
}

export function bucketRef(rows: RefRow[]): Map<string, RefBucket> {
  const map = new Map<string, RefBucket>();
  for (const r of rows) {
    let bucket = map.get(r.task_id);
    if (!bucket) {
      bucket = emptyRefs();
      map.set(r.task_id, bucket);
    }
    const asset: RefAsset = {
      id: r.id,
      kind: r.kind,
      name: r.filename,
      url: resolveAssetUrl(r.url),
      size: Number(r.size),
    };
    if (r.kind === 'image') bucket.images.push(asset);
    else if (r.kind === 'video') bucket.videos.push(asset);
    else bucket.audios.push(asset);
  }
  return map;
}

export function taskDto(
  t: TaskRow,
  opts: { refs?: RefBucket; outputs?: OutputRow[]; mine?: boolean } = {},
) {
  const refs = opts.refs ?? emptyRefs();
  const outputs = opts.outputs ? outputDtos(opts.outputs) : [];
  return {
    id: t.id,
    mine: opts.mine ?? true,
    visibility: t.visibility,
    type: t.type,
    prompt: t.prompt,
    modelId: t.model_id,
    modelName: t.model_name,
    resolution: t.resolution,
    width: Number(t.width),
    height: Number(t.height),
    duration: Number(t.duration),
    count: Number(t.count),
    status: t.status,
    progress: Number(t.progress),
    seed: t.seed,
    resultUrl: signedUrl(t.result_url) ?? (outputs[0]?.url ?? null),
    posterUrl: signedUrl(t.poster_url) ?? null,
    outputs,
    credits: Number(t.credits_cost),
    costActual: Number(t.cost_actual),
    error: t.error,
    errorCode: t.error_code,
    refunded: Boolean(t.refunded_at),
    attempts: Number(t.attempts),
    createdAt: toMillis(t.created_at),
    finishedAt: t.finished_at ? toMillis(t.finished_at) : null,
    refImages: refs.images,
    refVideos: refs.videos,
    refAudios: refs.audios,
  };
}

export type TaskDto = ReturnType<typeof taskDto>;

/** A MySQL DATETIME or a zone-less ISO string, read as UTC. An existing zone is kept. */
export function parseUtcMillis(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const withZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

/** MySQL DATETIME strings come back without a timezone; the pool uses UTC. */
export function toMillis(value: string | Date | null | undefined): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  return parseUtcMillis(value) ?? 0;
}
