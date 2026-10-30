import { query, queryOne } from '../db/pool.js';
import { readFallbackModelId } from './model-routing.js';

export type ModelRow = {
  id: string;
  provider: string;
  display_name: string;
  kind: 'image' | 'video';
  price_unit: 'per_second' | 'per_call' | 'per_image';
  price_amount: number;
  max_duration: number | null;
  resolutions: string[] | null;
  capabilities: {
    refs?: string[];
    durations?: number[];
    tag?: string | null;
    priceLabel?: string;
    fallbackModelId?: string;
  } | null;
  provider_model: string;
  enabled: number;
  sort_weight: number;
};

export type ModelDto = {
  id: string;
  name: string;
  kind: 'image' | 'video';
  priceLabel: string;
  /** Numeric pricing — single source of truth for the client-side estimate. */
  priceAmount: number;
  priceUnit: 'per_second' | 'per_call' | 'per_image';
  tag: string | null;
  refs: string[];
  durations: number[];
  provider: string;
  /** Vendor model id (`model_registry.provider_model`). Empty falls back to `id`. */
  providerModel: string;
  maxDuration: number | null;
};

/** Registry row plus the fields automatic routing and circuit failover read. */
export type StoredModel = ModelDto & {
  sortWeight: number;
  enabled: boolean;
  fallbackModelId: string | null;
};

export function toModelDto(m: ModelRow): ModelDto {
  const caps = parseCaps(m.capabilities);
  return {
    id: m.id,
    name: m.display_name,
    kind: m.kind,
    priceLabel: caps.priceLabel ?? `${m.price_amount}积分`,
    priceAmount: Number(m.price_amount),
    priceUnit: m.price_unit,
    tag: caps.tag ?? null,
    refs: caps.refs ?? [],
    durations: caps.durations ?? [],
    provider: m.provider,
    providerModel: m.provider_model,
    maxDuration: m.max_duration === null ? null : Number(m.max_duration),
  };
}

export function toStoredModel(row: ModelRow): StoredModel {
  const weight = Number(row.sort_weight);
  return {
    ...toModelDto(row),
    sortWeight: Number.isFinite(weight) ? weight : 0,
    enabled: Number(row.enabled) === 1,
    fallbackModelId: readFallbackModelId(row.capabilities),
  };
}

type Caps = { refs?: string[]; durations?: number[]; tag?: string | null; priceLabel?: string };

/** mysql2 returns JSON columns already parsed, but string tolerance is cheap. */
function parseCaps(raw: ModelRow['capabilities']): Caps {
  if (!raw) return {};
  if (typeof raw === 'string') return safeJson<Caps>(raw) ?? {};
  return raw as Caps;
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function listModels(kind?: 'image' | 'video'): Promise<ModelDto[]> {
  const rows = kind
    ? await query<ModelRow>(
        'SELECT * FROM model_registry WHERE enabled = 1 AND kind = ? ORDER BY sort_weight ASC, id ASC',
        [kind],
      )
    : await query<ModelRow>(
        'SELECT * FROM model_registry WHERE enabled = 1 ORDER BY sort_weight ASC, id ASC',
      );
  return rows.map(toModelDto);
}

/** Enabled models of one kind, including sort weight and the configured standby. */
export async function listRoutedModels(kind: 'image' | 'video'): Promise<StoredModel[]> {
  const rows = await query<ModelRow>(
    'SELECT * FROM model_registry WHERE enabled = 1 AND kind = ? ORDER BY sort_weight ASC, id ASC',
    [kind],
  );
  return rows.map(toStoredModel);
}

export async function getModel(id: string): Promise<StoredModel | null> {
  const row = await queryOne<ModelRow>('SELECT * FROM model_registry WHERE id = ? LIMIT 1', [id]);
  return row ? toStoredModel(row) : null;
}

export type CostInput = { model: ModelDto; duration: number; count: number };

/** Authoritative price computation — the client never decides what to charge. */
export function estimateCost({ model, duration, count }: CostInput): number {
  switch (model.priceUnit) {
    case 'per_second':
      return model.priceAmount * Math.max(1, duration);
    case 'per_image':
      return model.priceAmount * Math.max(1, count);
    case 'per_call':
    default:
      return model.priceAmount;
  }
}

const REF_KIND_ORDER = ['image', 'video', 'audio'] as const;
type RefKind = (typeof REF_KIND_ORDER)[number];

const UNSUPPORTED_REF_KIND: Record<RefKind, string> = {
  image: '该模型不支持参考图',
  video: '该模型不支持参考视频',
  audio: '该模型不支持参考音频',
};

const REF_KIND_LIMIT: Record<RefKind, { max: number; message: string }> = {
  image: { max: 9, message: '参考图最多 9 张' },
  video: { max: 3, message: '参考视频最多 3 个' },
  audio: { max: 3, message: '参考音频最多 3 个' },
};

/** Rejects requests the selected model cannot serve (duration/count/ref caps). */
export function validateAgainstModel(
  model: ModelDto,
  req: { duration: number; count: number; refCount: number; refKinds?: readonly RefKind[] },
): string | null {
  if (model.kind === 'video') {
    if (req.duration <= 0) return '时长必须大于 0 秒';
    if (model.maxDuration !== null && req.duration > model.maxDuration) {
      return `该模型最长支持 ${model.maxDuration} 秒`;
    }
  }
  if (req.count < 1 || req.count > 8) return '生成数量需在 1~8 之间';
  if (req.refKinds) {
    for (const kind of REF_KIND_ORDER) {
      if (req.refKinds.includes(kind) && !model.refs.includes(kind)) return UNSUPPORTED_REF_KIND[kind];
    }
    for (const kind of REF_KIND_ORDER) {
      const count = req.refKinds.filter((item) => item === kind).length;
      if (count > REF_KIND_LIMIT[kind].max) return REF_KIND_LIMIT[kind].message;
    }
  } else if (req.refCount > 0 && model.refs.length === 0) {
    return '该模型不支持参考素材';
  }
  return null;
}

/** Re-checks a stored task against the model selected for a retry. */
export function retryModelProblem(
  model: ModelDto,
  task: { type: 'image' | 'video'; duration: number; count: number; refKinds?: readonly RefKind[] },
): string | null {
  if (model.kind !== task.type) return '模型类型与任务类型不匹配';
  return validateAgainstModel(model, {
    duration: task.duration,
    count: task.count,
    refCount: task.refKinds ? task.refKinds.length : 0,
    refKinds: task.refKinds,
  });
}
